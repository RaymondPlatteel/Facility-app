// Middle-split measurement shared with Project-000, which measures it and submits it (Project-000 has the same file,
// without the learning half at the bottom). Points are 0–1 fractions of the photo from its top-left, so they land on the same spot of the photo at
// any display size.

export type Pt = { x: number; y: number };
export interface SplitPoints { hip: Pt; left: Pt; right: Pt; }

// Saved on a pending submission as `split`.
export interface SplitMark {
  slot: number;                  // proof slot of the photo: videoUrls['v' + slot]
  iw: number; ih: number;        // photo size in pixels
  points: SplitPoints;           // where the athlete left the points
  deg: number;
  detected: SplitPoints | null;  // body pose detection before the learned correction, null when nothing was found
  // Set by the coach on review.
  coach?: SplitPoints;
  coachDeg?: number;
  applied?: number;              // the Middle Split score recorded: the coach's angle, or the earlier score if higher
}

// The learned correction to body pose detection, kept in splitPose/model and updated by every coach review. Each
// offset is the median of (coach point − detected point), in leg lengths, so it holds at any photo size.
export interface SplitModel { n: number; hip: Pt; left: Pt; right: Pt; }

const KEYS = ['hip', 'left', 'right'] as const;

export function splitDeg(p: SplitPoints, iw: number, ih: number): number {
  const a = Math.atan2((p.left.y - p.hip.y) * ih, (p.left.x - p.hip.x) * iw);
  const b = Math.atan2((p.right.y - p.hip.y) * ih, (p.right.x - p.hip.x) * iw);
  let d = Math.abs(a - b) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return Math.round(d);
}

// Average hip-to-foot length in pixels.
export function legLength(p: SplitPoints, iw: number, ih: number): number {
  const len = (f: Pt) => Math.hypot((f.x - p.hip.x) * iw, (f.y - p.hip.y) * ih);
  return (len(p.left) + len(p.right)) / 2;
}

// Detection moved by the learned offsets. Too few reviews and it is left as detected.
export function correctSplit(d: SplitPoints, m: SplitModel | null, iw: number, ih: number): SplitPoints {
  if (!m || m.n < 3) return d;
  const L = legLength(d, iw, ih);
  const out = {} as SplitPoints;
  for (const k of KEYS) {
    out[k] = {
      x: Math.min(1, Math.max(0, d[k].x + (m[k].x * L) / iw)),
      y: Math.min(1, Math.max(0, d[k].y + (m[k].y * L) / ih))
    };
  }
  return out;
}

// ── Learning ──
// Every review is a sample: how far the coach's points sit from the raw detection, in leg lengths. The model is the
// per-coordinate median of the latest MODEL_SAMPLES, so a few careless reviews do not drag it.
export const MODEL_SAMPLES = 200;
export type SplitSample = Record<'hip' | 'left' | 'right', Pt>;

export function splitSample(detected: SplitPoints, truth: SplitPoints, iw: number, ih: number): SplitSample {
  const L = legLength(detected, iw, ih) || 1;
  const out = {} as SplitSample;
  for (const k of KEYS) out[k] = { x: (truth[k].x - detected[k].x) * iw / L, y: (truth[k].y - detected[k].y) * ih / L };
  return out;
}

export function splitModel(samples: SplitSample[]): SplitModel {
  const median = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const out = { n: samples.length } as SplitModel;
  for (const k of KEYS) out[k] = { x: median(samples.map(s => s[k].x)), y: median(samples.map(s => s[k].y)) };
  return out;
}
