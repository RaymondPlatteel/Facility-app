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


// ---------- How accurate detection is ----------
// Points are judged by distance in pixels, with every photo scaled so its long side is STAT_PX, so photos of different
// sizes can be compared. The angle is judged in degrees: the measured angle against yours. "Raw" is Apple's detection
// as it is; "corrected" has the learned shift applied (measured on the photos it learned from, so it flatters it a little).
export const STAT_PX = 1000;
export const POINT_CLOSE_PX = 8;      // counted as spot on
export const POINT_FAR_PX = 60;       // counted as a wrong spot, such as the wrong body part
export const ANGLE_TARGET = 0.5;      // degrees: counted as spot on
export const ANGLE_FAR = 5;           // degrees: counted as a wrong spot

export interface PointSpread { median: number; vertical: number; horizontal: number; hits: number; farCount: number; count: number; }
export interface AngleSpread { median: number; p90: number; hits: number; farCount: number; count: number; }
export interface SplitStats {
  n: number;
  raw: Record<'hip' | 'left' | 'right', PointSpread> & { angle: AngleSpread };
  corrected: Record<'hip' | 'left' | 'right', PointSpread> & { angle: AngleSpread };
}

export function splitDegExact(p: SplitPoints, iw: number, ih: number): number {
  const a = Math.atan2((p.left.y - p.hip.y) * ih, (p.left.x - p.hip.x) * iw);
  const b = Math.atan2((p.right.y - p.hip.y) * ih, (p.right.x - p.hip.x) * iw);
  let d = Math.abs(a - b) * 180 / Math.PI;
  if (d > 180) d = 360 - d;
  return d;
}

function quantile(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0;
}

export function splitStats(rows: Array<{ detected: SplitPoints; truth: SplitPoints; iw: number; ih: number }>, model: SplitModel | null): SplitStats | null {
  if (!rows.length) return null;
  type Acc = Record<'hip' | 'left' | 'right', { dist: number[]; v: number[]; h: number[] }> & { angle: number[] };
  const acc = (): Acc => ({ hip: { dist: [], v: [], h: [] }, left: { dist: [], v: [], h: [] }, right: { dist: [], v: [], h: [] }, angle: [] });
  const raw = acc(), corrected = acc();
  for (const r of rows) {
    const t = r.truth, fixed = correctSplit(r.detected, model, r.iw, r.ih);
    const k = STAT_PX / Math.max(r.iw, r.ih);
    const truthDeg = splitDegExact(t, r.iw, r.ih);
    for (const [out, pts] of [[raw, r.detected], [corrected, fixed]] as Array<[Acc, SplitPoints]>) {
      for (const key of KEYS) {
        const dx = (pts[key].x - t[key].x) * r.iw * k, dy = (pts[key].y - t[key].y) * r.ih * k;
        out[key].dist.push(Math.hypot(dx, dy));
        out[key].v.push(-dy);   // positive: detection is above where you put it
        // positive: detection is further from the middle of the photo than your point, i.e. too far out
        out[key].h.push(key === 'hip' ? dx : dx * (t[key].x < t.hip.x ? -1 : 1));
      }
      out.angle.push(Math.abs(splitDegExact(pts, r.iw, r.ih) - truthDeg));
    }
  }
  const point = (a: Acc['hip']): PointSpread => ({
    median: quantile(a.dist, 0.5), vertical: quantile(a.v, 0.5), horizontal: quantile(a.h, 0.5),
    hits: a.dist.filter(x => x <= POINT_CLOSE_PX).length, farCount: a.dist.filter(x => x > POINT_FAR_PX).length, count: a.dist.length
  });
  const make = (a: Acc) => ({
    hip: point(a.hip), left: point(a.left), right: point(a.right),
    angle: { median: quantile(a.angle, 0.5), p90: quantile(a.angle, 0.9), hits: a.angle.filter(x => x <= ANGLE_TARGET).length, farCount: a.angle.filter(x => x > ANGLE_FAR).length, count: a.angle.length }
  });
  return { n: rows.length, raw: make(raw), corrected: make(corrected) };
}
