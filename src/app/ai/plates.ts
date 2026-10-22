// Reads the plates on the bar from the video frames, and turns what they show into a weight.
//
// Nothing here is a trained model and nothing leaves the device. It is geometry on the pixels around the bar, using the
// lifter's own body as the ruler (the pose model gives their height in pixels; the member's height gives it in metres):
//   - Seen from the front or back, the plates are edge-on: a stack of narrow vertical bands at each end of the bar. The
//     stack's height is the plate diameter, its colour says whether it is a coloured bumper plate, and the number of
//     bands (or the stack's thickness) is the number of plates on that side.
//   - Seen from the side, the nearest plate is a full circle. Its diameter gives the plate size and its colour the
//     bumper weight, but the plates behind it are hidden, so the count cannot be read.
// A standard plate is 450 mm across, so a 45 lb plate (or any 20 kg bumper) is recognised by its size and the smaller iron
// plates by theirs. Bumper plates are all 450 mm and are told apart by the IOC/IWF colours.
// The reading always says how sure it is, and says plainly when the plates could not be seen.

export type PlateColour = 'red' | 'blue' | 'yellow' | 'green' | 'white' | 'black';

export interface PlateReading {
  readable: boolean;                // whether a weight could be worked out
  frames: number;                   // frames examined
  reads: number;                    // plate stacks or discs found, across the frames and both ends of the bar
  view: 'front' | 'side' | 'angled' | 'unknown';
  perSide: number | null;           // plates on each end of the bar
  perSideLow: number | null;
  perSideHigh: number | null;
  plateLb: number | null;           // what each plate weighs
  plateLbLow: number | null;
  plateLbHigh: number | null;
  plateLabel: string | null;        // e.g. "45 lb", "20 kg red"
  diameterMm: number | null;
  colour: PlateColour | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  heightKnown: boolean;
  note: string;                     // in words: how it was read, or why it could not be
}

export const EMPTY_READING: PlateReading = {
  readable: false, frames: 0, reads: 0, view: 'unknown', perSide: null, perSideLow: null, perSideHigh: null, plateLb: null,
  plateLbLow: null, plateLbHigh: null, plateLabel: null, diameterMm: null, colour: null, confidence: 'none', heightKnown: false, note: ''
};

export const BAR_LB = 45;
export const KG = 2.20462;
const BUMPER_KG: Record<string, number> = { red: 25, blue: 20, yellow: 15, green: 10, white: 5 };

// ---------- one frame ----------

export interface Img { w: number; h: number; data: Uint8ClampedArray }   // RGBA, as a canvas gives it

export interface PlateSeen {
  kind: 'stack' | 'disc';
  diaM: number;
  count: number | null;       // plates on that end, from a stack
  edges: number;              // vertical edges found in the stack
  pitchM: number | null;      // thickness of one plate, when the gaps between plates could be seen
  thickM: number | null;      // thickness of the whole stack
  colour: PlateColour;
  score: number;              // 0 to 1: how clear it was
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[clamp(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1)];
}

function luma(img: Img): Float32Array {
  const L = new Float32Array(img.w * img.h);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  return L;
}

// The colour of a patch: the IOC bumper colours when strongly coloured, white when bright and grey, else black/iron.
function colourOf(img: Img, x0: number, y0: number, x1: number, y1: number): PlateColour {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = clamp(y0, 0, img.h - 1); y <= clamp(y1, 0, img.h - 1); y++) {
    for (let x = clamp(x0, 0, img.w - 1); x <= clamp(x1, 0, img.w - 1); x++) {
      const i = (y * img.w + x) * 4;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
  }
  if (!n) return 'black';
  r /= 255 * n; g /= 255 * n; b /= 255 * n;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (mx > 0.78 && d < 0.12) return 'white';
  if (mx < 0.3 || d / (mx || 1) < 0.45) return 'black';
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 20 || h >= 340) return 'red';
  if (h >= 38 && h < 75) return 'yellow';
  if (h >= 90 && h < 170) return 'green';
  if (h >= 190 && h < 265) return 'blue';
  return 'black';
}

// Plates seen edge-on at one end of the bar. `ax, ay` is where the bar is in the image, `sgn` which end.
function stackAt(img: Img, L: Float32Array, ppm: number, ax: number, ay: number, sgn: -1 | 1): PlateSeen | null {
  const { w, h } = img;
  const m = (v: number) => Math.max(1, Math.round(v * ppm));
  const xa = ax + sgn * m(0.5), xb = ax + sgn * m(1.25);
  const lo = clamp(Math.min(xa, xb), 2, w - 3), hi = clamp(Math.max(xa, xb), 2, w - 3);
  if (hi - lo < m(0.12)) return null;
  const d = Math.max(1, Math.round(0.005 * ppm));
  const rowsLo = clamp(ay - m(0.08), 0, h - 1), rowsHi = clamp(ay + m(0.08), 0, h - 1);
  if (rowsHi - rowsLo < m(0.06)) return null;

  // A vertical edge shows as a horizontal change that is the same all the way up the segment: take the 40th percentile
  // down the column, so one object crossing the bar does not make an edge.
  const v: number[] = [];
  for (let x = lo; x <= hi; x++) {
    const col: number[] = [];
    for (let y = rowsLo; y <= rowsHi; y++) col.push(Math.abs(L[y * w + clamp(x + d, 0, w - 1)] - L[y * w + clamp(x - d, 0, w - 1)]));
    v.push(pct(col, 40));
  }
  const sm = v.map((_, i) => ((v[Math.max(0, i - 1)] + 2 * v[i] + v[Math.min(v.length - 1, i + 1)]) / 4));
  const T = Math.max(7, 2.2 * median(sm));
  let peaks: Array<{ x: number; s: number }> = [];
  for (let i = 1; i < sm.length - 1; i++) if (sm[i] >= T && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) peaks.push({ x: lo + i, s: sm[i] });
  const merged: typeof peaks = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (last && p.x - last.x < m(0.012)) { if (p.s > last.s) merged[merged.length - 1] = p; } else merged.push(p);
  }
  peaks = merged.sort((a, b) => (a.x - ax) * sgn - (b.x - ax) * sgn);   // innermost first
  if (peaks.length < 2) return null;

  // Chains of edges close enough to be one stack (when no gap between plates shows, its two ends may be all there is). The strongest chain is the stack.
  const chains: Array<typeof peaks> = [];
  let cur: typeof peaks = [];
  for (const p of peaks) {
    if (cur.length && Math.abs(p.x - cur[cur.length - 1].x) > m(0.2)) { chains.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) chains.push(cur);
  const best = chains.filter(c => c.length >= 2).sort((a, b) => b.reduce((s, p) => s + p.s, 0) - a.reduce((s, p) => s + p.s, 0))[0];
  if (!best) return null;
  const x0 = Math.min(best[0].x, best[best.length - 1].x), x1 = Math.max(best[0].x, best[best.length - 1].x);

  // The stack's height: a horizontal edge above and below it, the same distance from the bar. That is the plate's diameter.
  const hy0 = clamp(ay - m(0.32), 1, h - 2), hy1 = clamp(ay + m(0.32), 1, h - 2);
  const prof: number[] = [];
  for (let y = hy0; y <= hy1; y++) {
    let s = 0, n = 0;
    for (let x = x0 + 1; x < x1; x += 1) { s += Math.abs(L[clamp(y + d, 0, h - 1) * w + x] - L[clamp(y - d, 0, h - 1) * w + x]); n++; }
    prof.push(n ? s / n : 0);
  }
  const hs = prof.map((_, i) => (prof[Math.max(0, i - 1)] + 2 * prof[i] + prof[Math.min(prof.length - 1, i + 1)]) / 4);
  const hT = Math.max(5, 1.8 * median(hs));
  let bestPair: { top: number; bot: number; s: number } | null = null;
  for (let i = 0; i < hs.length; i++) {
    if (hs[i] < hT) continue;
    for (let j = i + m(0.15); j < hs.length; j++) {
      const dia = (j - i) / ppm;
      if (dia > 0.5) break;
      if (hs[j] < hT) continue;
      const centre = hy0 + (i + j) / 2;
      if (Math.abs(centre - ay) > m(0.09)) continue;
      const s = hs[i] + hs[j];
      if (!bestPair || s > bestPair.s) bestPair = { top: hy0 + i, bot: hy0 + j, s };
    }
  }
  if (!bestPair) return null;
  const diaM = (bestPair.bot - bestPair.top) / ppm;

  const colour = colourOf(img, x0 + Math.round((x1 - x0) * 0.1), Math.round(ay) - m(0.05), x1 - Math.round((x1 - x0) * 0.1), Math.round(ay) + m(0.05));
  const thick = (x1 - x0) / ppm;
  const rel = best.map(p => Math.abs(p.x - best[0].x) / ppm);
  const { count, pitch } = countStack(rel, thick, colour);
  // The strength of the edges against the noise, and the height edges against theirs.
  const score = clamp(0.25 + 0.15 * Math.min(4, best.length) + 0.2 * Math.min(1, (bestPair.s / 2 / hT - 1) / 2), 0, 1);
  return { kind: 'stack', diaM, count, edges: best.length, pitchM: pitch, thickM: thick, colour, score };
}

// How many plates make a stack this thick with edges where these were found. A plate is about 3 to 4 cm of iron or 5 to 7 cm
// of bumper, and the gap between two plates does not always show, so every count from one to eight is tried: its plates would be
// `thick / count` apart, edges should fall on those lines, and a plate thickness near the usual one is more likely.
function countStack(rel: number[], thick: number, colour: PlateColour): { count: number; pitch: number } {
  const prior = colour !== 'black' && colour !== 'white' ? 0.06 : 0.036;
  let best = { count: 1, pitch: thick, score: -Infinity };
  for (let n = 1; n <= 8; n++) {
    const p = thick / n;
    if (p < 0.02 || p > 0.09) continue;
    let matched = 0;
    for (let j = 0; j <= n; j++) if (rel.some(r => Math.abs(r - j * p) <= 0.3 * p)) matched++;
    const extras = rel.filter(r => Math.min(...Array.from({ length: n + 1 }, (_, j) => Math.abs(r - j * p))) > 0.3 * p).length;
    const score = matched / (n + 1) - 0.5 * extras / rel.length - 0.15 * Math.pow(Math.log(p / prior), 2) / (2 * 0.3 * 0.3);
    if (score > best.score) best = { count: n, pitch: p, score };
  }
  return best;
}

// The nearest plate seen face-on: the biggest circle that has an edge around most of its rim, near the bar.
function discAt(img: Img, L: Float32Array, ppm: number, ax: number, ay: number, head: { x: number; y: number } | null): PlateSeen | null {
  const { w, h } = img;
  const m = (v: number) => Math.max(1, Math.round(v * ppm));
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = L[i + 1] - L[i - 1], b = L[i + w] - L[i - w];
      gx[i] = a; gy[i] = b;
      if ((x + y) % 5 === 0) mag.push(Math.abs(a) + Math.abs(b));
    }
  }
  const Tg = Math.max(14, pct(mag, 80));
  const N = 72, cos = new Float32Array(N), sin = new Float32Array(N);
  for (let k = 0; k < N; k++) { cos[k] = Math.cos((k / N) * 2 * Math.PI); sin[k] = Math.sin((k / N) * 2 * Math.PI); }
  let best: { cx: number; cy: number; r: number; cov: number } | null = null;
  const step = m(0.02);
  for (let r = m(0.1); r <= m(0.245); r += Math.max(1, m(0.01))) {
    for (let cy = ay - m(0.25); cy <= ay + m(0.25); cy += step) {
      for (let cx = ax - m(0.35); cx <= ax + m(0.35); cx += step) {
        if (cx - r < 2 || cy - r < 2 || cx + r > w - 3 || cy + r > h - 3) continue;
        if (head && Math.hypot(cx - head.x, cy - head.y) < m(0.16)) continue;
        let hit = 0;
        for (let k = 0; k < N; k++) {
          const x = Math.round(cx + r * cos[k]), y = Math.round(cy + r * sin[k]);
          const i = y * w + x;
          if (Math.abs(gx[i] * cos[k] + gy[i] * sin[k]) >= Tg) hit++;
        }
        const cov = hit / N + 0.1 * (r / m(0.245));
        if (!best || cov > best.cov) best = { cx, cy, r, cov };
      }
    }
  }
  if (!best || best.cov < 0.7) return null;
  const rr = Math.round(best.r * 0.7);
  const colour = colourOf(img, Math.round(best.cx - rr), Math.round(best.cy - rr), Math.round(best.cx + rr), Math.round(best.cy + rr));
  return { kind: 'disc', diaM: (2 * best.r) / ppm, count: null, edges: 0, pitchM: null, thickM: null, colour, score: clamp((best.cov - 0.6) * 2.5, 0.2, 1) };
}

// Every plate stack or disc found in one frame. `ax, ay` is the bar's place in the image, `ppm` the pixels in a metre there.
export function readFrame(img: Img, ppm: number, ax: number, ay: number, head: { x: number; y: number } | null): PlateSeen[] {
  const L = luma(img);
  const out: PlateSeen[] = [];
  for (const sgn of [-1, 1] as const) {
    const s = stackAt(img, L, ppm, ax, ay, sgn);
    if (s && s.diaM >= 0.15 && s.diaM <= 0.5) out.push(s);
  }
  if (!out.length) {
    const d = discAt(img, L, ppm, ax, ay, head);
    if (d) out.push(d);
  }
  return out;
}

// ---------- from the frames to a weight ----------

// What one plate weighs, by its size and colour. Returns the weight and the label, with a lower and upper figure when the
// size is close to the line between two plates or a black bumper could be 20 or 25 kg.
export function plateClass(diaM: number, colour: PlateColour, pitchM: number | null): { lb: number; low: number; high: number; label: string } {
  if (colour !== 'black' && diaM >= 0.37) {
    if (colour === 'white') return { lb: 5 * KG, low: 5 * KG, high: 5 * KG, label: '5 kg white' };
    const kg = BUMPER_KG[colour];
    return { lb: kg * KG, low: kg * KG, high: kg * KG, label: `${kg} kg ${colour}` };
  }
  const classes = [{ lb: 45, min: 0.415 }, { lb: 35, min: 0.355 }, { lb: 25, min: 0.29 }, { lb: 10, min: 0.22 }, { lb: 5, min: 0 }];
  const i = classes.findIndex(c => diaM >= c.min);
  const c = classes[i];
  const nearUp = i > 0 && diaM - c.min < 0.012;   // just over the line from the next size down: it could be the larger plate
  const lowLb = c.lb, highLb = nearUp ? classes[i - 1].lb : c.lb;
  // A thick black plate of full size is a bumper: 20 kg (44 lb) or 25 kg (55 lb), not a 45 lb iron plate.
  if (c.lb === 45 && pitchM !== null && pitchM > 0.048) return { lb: 45, low: 44, high: 55, label: '45 lb or 20–25 kg (thick)' };
  return { lb: c.lb, low: lowLb, high: highLb, label: `${c.lb} lb` };
}

export interface FrameReads { seen: PlateSeen[] }

// Combines the reads from the frames into one reading.
export function combine(frames: FrameReads[], view: PlateReading['view'], heightKnown: boolean): PlateReading {
  const all: PlateSeen[] = [];
  for (const f of frames) all.push(...f.seen);
  const base: PlateReading = { ...EMPTY_READING, frames: frames.length, reads: all.length, view, heightKnown };
  if (frames.length < 2) return { ...base, note: 'Too little of the video showed the bar to look for plates.' };
  if (all.length < 2) return { ...base, note: 'No plates could be found next to the bar. The ends of the bar may be out of frame, hidden, or too dark to see.' };

  const dia = median(all.map(s => s.diaM));
  const colours = all.map(s => s.colour);
  const colour = (['red', 'blue', 'yellow', 'green', 'white', 'black'] as const).map(c => ({ c, n: colours.filter(x => x === c).length })).sort((a, b) => b.n - a.n)[0].c;
  const stacks = all.filter(s => s.kind === 'stack' && s.count !== null);
  const pitches = stacks.map(s => s.pitchM).filter((p): p is number => p !== null);
  const cls = plateClass(dia, colour, pitches.length ? median(pitches) : null);

  const common = { ...base, diameterMm: Math.round(dia * 1000), colour, plateLb: cls.lb, plateLbLow: cls.low, plateLbHigh: cls.high, plateLabel: cls.label };
  if (stacks.length < 2) {
    return { ...common, perSide: null, confidence: 'low',
      note: `The nearest plate looks like a ${cls.label} plate (${Math.round(dia * 1000)} mm across), but only its face was visible, so the number of plates could not be counted. Film from the front or back of the bar to count them.` };
  }
  const counts = stacks.map(s => s.count as number);
  const med = Math.round(median(counts));
  const within1 = counts.filter(c => Math.abs(c - med) <= 1).length / counts.length;
  const exact = counts.filter(c => c === med).length / counts.length;
  const score = median(stacks.map(s => s.score));
  const lowN = Math.max(1, Math.min(med, Math.round(pct(counts, 20)))), highN = Math.max(med, Math.round(pct(counts, 80)));
  let confidence: PlateReading['confidence'] = 'low';
  if (stacks.length >= 6 && exact >= 0.7 && score >= 0.55 && heightKnown) confidence = 'high';
  else if (stacks.length >= 3 && within1 >= 0.7 && score >= 0.4) confidence = 'medium';
  if (within1 < 0.5) confidence = 'low';
  const widen = confidence === 'high' ? 0 : 1;
  return {
    ...common, readable: true, perSide: med, perSideLow: Math.max(1, Math.min(lowN, med - widen)), perSideHigh: Math.max(highN, med + widen), confidence,
    note: `${med} ${cls.label} plate${med === 1 ? '' : 's'} on each end of the bar, read ${stacks.length} times in ${frames.length} frames${view === 'front' ? ' from the front or back' : view === 'angled' ? ' from an angle' : ''}${heightKnown ? '' : '; the athlete’s height is not on record, so the plate size is less certain'}. Assumes every plate on the bar is the same size.`
  };
}

// The bar plus both ends, in lb, with the range the reading allows.
export function plateWeight(r: PlateReading): { estimate: number; low: number; high: number } | null {
  if (!r.readable || r.perSide === null || r.plateLb === null) return null;
  const lo = BAR_LB + 2 * (r.perSideLow ?? r.perSide) * (r.plateLbLow ?? r.plateLb);
  const hi = BAR_LB + 2 * (r.perSideHigh ?? r.perSide) * (r.plateLbHigh ?? r.plateLb);
  return { estimate: Math.round(BAR_LB + 2 * r.perSide * r.plateLb), low: Math.round(lo), high: Math.round(hi) };
}

// ---------- reading a video ----------

interface PoseLike { t: number; pts: Array<{ x: number; y: number; v: number }> | null }

// Picks frames where the bar is still and in view, reads each, and combines. `seek` moves the video to a time.
export async function readPlatesFromVideo(
  video: HTMLVideoElement, frames: PoseLike[], test: string, heightM: number | null,
  seek: (t: number) => Promise<void>
): Promise<PlateReading> {
  const vis = (f: PoseLike, j: number) => (f.pts && f.pts[j] && f.pts[j].v >= 0.35 ? f.pts[j] : null);
  const shins: number[] = [], shoulders: number[] = [];
  for (const f of frames) {
    for (const [k, a] of [[25, 27], [26, 28]]) { const p = vis(f, k), q = vis(f, a); if (p && q) shins.push(Math.hypot(p.x - q.x, p.y - q.y)); }
    const l = vis(f, 11), r = vis(f, 12);
    if (l && r) shoulders.push(Math.hypot(l.x - r.x, l.y - r.y));
  }
  if (shins.length < 5) return { ...EMPTY_READING, note: 'The athlete’s legs were not in view, so the size of the plates could not be measured.' };
  const heightKnown = !!heightM;
  const shinPx = pct(shins, 75);
  const ppmVideo = shinPx / (0.246 * (heightM ?? 1.75));
  const ratio = shoulders.length ? median(shoulders) / shinPx : 0;
  const viewKind: PlateReading['view'] = !shoulders.length ? 'unknown' : ratio > 0.65 ? 'front' : ratio < 0.4 ? 'side' : 'angled';

  // Where the bar is: at the hands, or across the shoulders in a squat.
  const anchor = (f: PoseLike): { x: number; y: number } | null => {
    if (test === 'squat') { const l = vis(f, 11), r = vis(f, 12); return l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 - 0.03 * ppmVideo } : null; }
    const l = vis(f, 15), r = vis(f, 16);
    return l && r ? { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 } : null;
  };
  const cand: Array<{ i: number; move: number }> = [];
  for (let i = 1; i < frames.length - 1; i++) {
    const a = anchor(frames[i]), p = anchor(frames[i - 1]), n = anchor(frames[i + 1]);
    if (a && p && n) cand.push({ i, move: Math.hypot(a.x - p.x, a.y - p.y) + Math.hypot(n.x - a.x, n.y - a.y) });
  }
  if (cand.length < 4) return { ...EMPTY_READING, view: viewKind, heightKnown, note: 'The hands and the bar were not in view for long enough to look for plates.' };
  cand.sort((a, b) => a.move - b.move);
  const picked: number[] = [];
  const gap = Math.max(2, Math.round(frames.length * 0.05));
  for (const c of cand) {
    if (picked.every(p => Math.abs(p - c.i) >= gap)) picked.push(c.i);
    if (picked.length >= 8) break;
  }

  // A canvas that holds the region around the bar at up to 240 pixels to the metre.
  const ppm = Math.min(ppmVideo, 240), k = ppm / ppmVideo;
  const halfW = 1.3 * ppmVideo, halfH = 0.45 * ppmVideo;
  const cw = Math.max(32, Math.round(2 * halfW * k)), ch = Math.max(32, Math.round(2 * halfH * k));
  const can = document.createElement('canvas'); can.width = cw; can.height = ch;
  const ctx = can.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { ...EMPTY_READING, note: 'The video could not be read.' };
  const reads: FrameReads[] = [];
  for (const i of picked) {
    const f = frames[i], a = anchor(f)!;
    await seek(f.t);
    // The source window, clipped to the video; what falls outside stays black and is not an edge worth anything.
    const sx = a.x - halfW, sy = a.y - halfH;
    ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, cw, ch);
    const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy), cx1 = Math.min(video.videoWidth, sx + 2 * halfW), cy1 = Math.min(video.videoHeight, sy + 2 * halfH);
    if (cx1 - cx0 < 0.5 * ppmVideo || cy1 - cy0 < 0.3 * ppmVideo) continue;
    ctx.drawImage(video, cx0, cy0, cx1 - cx0, cy1 - cy0, (cx0 - sx) * k, (cy0 - sy) * k, (cx1 - cx0) * k, (cy1 - cy0) * k);
    const data = ctx.getImageData(0, 0, cw, ch);
    const nose = vis(f, 0);
    const seen = readFrame({ w: cw, h: ch, data: data.data }, ppm, halfW * k, halfH * k, nose ? { x: (nose.x - sx) * k, y: (nose.y - sy) * k } : null);
    reads.push({ seen });
  }
  return combine(reads, viewKind, heightKnown);
}
