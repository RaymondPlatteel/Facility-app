import type { AiCheck, AiVerdict, VideoTest, WeightEstimate } from './ai-review.types';
import { BAR_LB, PlateReading, plateWeight } from './plates';
import { thr } from './thresholds';
import type { PoseFrame, Point, VideoReading } from './pose-video';

// The checks for each video test. Everything here is plain arithmetic on the landmarks MediaPipe finds in each frame,
// so the same code can later run on a server or on the phone itself. Thresholds are deliberately forgiving: when the
// video cannot settle a rule (a joint out of frame, a camera at the wrong angle) the check says "unclear" and the coach
// decides; a check only fails when the video shows the rule broken.

// MediaPipe's 33 landmarks, the ones used here.
const J = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28, lHeel: 29, rHeel: 30, lToe: 31, rToe: 32 };

export interface AthleteContext {
  heightIn: number | null;     // from the member record
  bodyWeightLb: number | null; // from the submission
  sex: 'male' | 'female';
  prevValue: number | null;    // the last verified result for this test, before this submission
  prevDate: string | null;
  refMax: number | null;       // the athlete's best verified result in this test, before this submission (the weight estimate's anchor)
  lifts: { deadlift: number; squat: number; bench: number };  // the athlete's current one-rep maxes, lb
}

export interface Claim { value: number; weight?: number | null; reps?: number | null }

export interface Analysis {
  checks: AiCheck[];
  features: Record<string, number>;
  estimates: Record<string, number | string>;
  weight?: WeightEstimate | null;
}

const VIS = 0.35;
const deg = (r: number) => (r * 180) / Math.PI;

function pt(f: PoseFrame, j: number): Point | null {
  const p = f.pts?.[j];
  return p && p.v >= VIS ? p : null;
}

// The side of the body nearer the camera (seen better), so a side-on video is read from the side it shows.
function bestSide(frames: PoseFrame[]): 'l' | 'r' {
  let l = 0, r = 0;
  for (const f of frames) {
    if (!f.pts) continue;
    for (const [a, b] of [[J.lSh, J.rSh], [J.lEl, J.rEl], [J.lWr, J.rWr], [J.lHip, J.rHip], [J.lKn, J.rKn], [J.lAn, J.rAn]]) {
      l += f.pts[a].v; r += f.pts[b].v;
    }
  }
  return l >= r ? 'l' : 'r';
}

function side(s: 'l' | 'r') {
  return s === 'l'
    ? { sh: J.lSh, el: J.lEl, wr: J.lWr, hip: J.lHip, kn: J.lKn, an: J.lAn, heel: J.lHeel, toe: J.lToe }
    : { sh: J.rSh, el: J.rEl, wr: J.rWr, hip: J.rHip, kn: J.rKn, an: J.rAn, heel: J.rHeel, toe: J.rToe };
}

function angle(a: Point | null, b: Point | null, c: Point | null): number | null {
  if (!a || !b || !c) return null;
  const v1 = Math.atan2(a.y - b.y, a.x - b.x), v2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(deg(v1 - v2));
  if (d > 180) d = 360 - d;
  return d;
}

function avgY(f: PoseFrame, a: number, b: number): number | null {
  const p = pt(f, a), q = pt(f, b);
  if (p && q) return (p.y + q.y) / 2;
  return p?.y ?? q?.y ?? null;
}

// Fills short gaps (a joint missed for a frame or two) and smooths over three frames.
function clean(raw: Array<number | null>, maxGap = 5): Array<number | null> {
  const s = [...raw];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== null) { i++; continue; }
    let j = i;
    while (j < s.length && s[j] === null) j++;
    const a = i - 1, b = j;
    if (a >= 0 && b < s.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) s[k] = (s[a] as number) + (((s[b] as number) - (s[a] as number)) * (k - a)) / (b - a);
    }
    i = j;
  }
  return s.map((v, k) => {
    if (v === null) return null;
    const w = [s[k - 1], v, s[k + 1]].filter((x): x is number => x !== null && x !== undefined);
    return w.reduce((p, c) => p + c, 0) / w.length;
  });
}

function pctile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

function median(xs: number[]): number { return pctile(xs, 50); }

// The athlete's height in pixels, from frames where they stand upright: nose to ankle is about 87% of stature.
function staturePx(frames: PoseFrame[], idx?: number[]): number | null {
  const use = idx ?? frames.map((_, i) => i);
  const hs: number[] = [];
  for (const i of use) {
    const f = frames[i];
    const nose = pt(f, J.nose), an = avgY(f, J.lAn, J.rAn);
    if (nose && an !== null && an > nose.y) hs.push((an - nose.y) / 0.87);
  }
  return hs.length ? median(hs) : null;
}

function check(id: string, label: string, result: AiCheck['result'], detail: string, critical = false): AiCheck {
  return { id, label, result, detail, ...(critical ? { critical } : {}) };
}

const fmt = (n: number, d = 0) => n.toFixed(d);

// ---------- the load and the bar speed ----------
// Bar speed against load. Close to a true max the bar moves slowly; well under one it moves fast. These are typical
// mean concentric velocities at a one-rep max and the fall in %1RM per 1 m/s faster, from the strength literature;
// they are rough, and the learned model refines how much to trust them.
const LOAD_VELOCITY: Partial<Record<VideoTest, { v1rm: number; slope: number }>> = {
  deadlift: { v1rm: 0.20, slope: 88 },
  squat: { v1rm: 0.30, slope: 80 },
  bench: { v1rm: 0.17, slope: 63 }
};
function pctOfMax(test: VideoTest, v: number): number {
  const lv = LOAD_VELOCITY[test]!;
  return Math.max(35, Math.min(100, 100 - (v - lv.v1rm) * lv.slope));
}

// ---------- reps from joint angles ----------
// A rep is read from the angle of the joint that drives the lift (hips for a deadlift, knees for a squat, elbows for a
// bench press, push-up or pull-up), not from where the hands or the bar are: angles do not depend on the camera's
// distance or zoom, and they still work when a rack or plate hides the hands.

// The joint angle in every frame, from the side seen better, falling back to the other side.
function angleSeries(frames: PoseFrame[], joints: (s: ReturnType<typeof side>) => [number, number, number]): Array<number | null> {
  const first = side(bestSide(frames)), other = side(bestSide(frames) === 'l' ? 'r' : 'l');
  return clean(frames.map(f => {
    const [a, b, c] = joints(first);
    const v = angle(pt(f, a), pt(f, b), pt(f, c));
    if (v !== null) return v;
    const [d, e, g] = joints(other);
    return angle(pt(f, d), pt(f, e), pt(f, g));
  }));
}

// Stretches where the joint is bent (at or under `flex`) and straight (at or over `ext`), in order. Between the two
// thresholds nothing changes, so a wobble cannot count as a rep.
interface Phase { kind: 'flex' | 'ext'; i: number; from: number; to: number }  // i: the most bent / most straight frame
function phases(s: Array<number | null>, flex: number, ext: number): Phase[] {
  const out: Phase[] = [];
  let cur: Phase | null = null;
  for (let i = 0; i < s.length; i++) {
    const v = s[i];
    if (v === null) continue;
    const k: 'flex' | 'ext' | null = v <= flex ? 'flex' : v >= ext ? 'ext' : null;
    if (!k) continue;
    if (cur && cur.kind === k) {
      cur.to = i;
      if ((k === 'flex' && v < (s[cur.i] as number)) || (k === 'ext' && v > (s[cur.i] as number))) cur.i = i;
    } else {
      if (cur) out.push(cur);
      cur = { kind: k, i, from: i, to: i };
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Reps as (bent, straight) pairs. A deadlift goes bent to straight; a pull-up straight (hanging) to bent (over the
// bar); a squat, bench press or push-up straight to bent and back, counted at the bent point.
function repsFrom(ph: Phase[], order: 'flex-ext' | 'ext-flex' | 'ext-flex-ext'): Array<{ flex: Phase; ext: Phase }> {
  const reps: Array<{ flex: Phase; ext: Phase }> = [];
  for (let k = 0; k < ph.length; k++) {
    const p = ph[k];
    if (order === 'flex-ext' && p.kind === 'flex' && ph[k + 1]?.kind === 'ext') reps.push({ flex: p, ext: ph[k + 1] });
    if (order === 'ext-flex' && p.kind === 'flex' && ph[k - 1]?.kind === 'ext') reps.push({ flex: p, ext: ph[k - 1] });
    if (order === 'ext-flex-ext' && p.kind === 'flex' && ph[k + 1]?.kind === 'ext') reps.push({ flex: p, ext: ph[k + 1] });
  }
  return reps;
}

function repsCheck(seen: number, claimed: number, critical: boolean): AiCheck {
  if (!seen && claimed > 0) return check('reps', 'Reps', 'unclear', 'No complete rep could be followed. The athlete may be out of frame or hidden.');
  if (seen >= claimed) return check('reps', 'Reps', 'pass', `${seen} seen, ${claimed} claimed.${seen > claimed ? ' More were seen than claimed, so the result may be understated.' : ''}`);
  if (claimed - seen <= Math.max(1, Math.round(claimed * 0.1))) return check('reps', 'Reps', 'unclear', `${seen} seen, ${claimed} claimed. Some may have been missed.`);
  return check('reps', 'Reps', 'fail', `${seen} seen, ${claimed} claimed.`, critical && seen < claimed * 0.75);
}

function share(n: number, of: number, label: string, id: string, passAt = 0.99, unclearAt = 0.5, detail = ''): AiCheck {
  const r = of ? n / of : 0;
  return check(id, label, !of ? 'unclear' : r >= passAt ? 'pass' : r >= unclearAt ? 'unclear' : 'fail', of ? `${n} of ${of} reps.${detail}` : 'Not clear enough to measure.');
}


// ---------- the weight check ----------
// The first check on a lift: what the video suggests the bar held, against what was claimed. Two routes, both worked out
// on this device from the video, with nothing sent anywhere:
//  1. The plates (plates.ts). The plates at the ends of the bar are found and measured against the lifter's own body: how
//     many there are on each end and how big they are (and, for bumper plates, what colour). The weight is the bar plus
//     twice the plates on one end. This is a reading, not a guess, so it can confirm a weight as well as doubt one, and it
//     says how sure it is, or that the plates could not be seen.
//  2. Bar speed. Close to a true max the bar moves slowly, so the first rep's speed says what share of the athlete's best
//     verified result the load was. It cannot tell a heavy bar from a slow, controlled pull, so it is kept as a secondary
//     check and as the baseline the plate reading is measured against.

function estimateFromSpeed(
  test: VideoTest, f: Record<string, number>, claim: Claim, ctx: AthleteContext
): WeightEstimate {
  const claimed = claim.weight && claim.weight > 0 ? claim.weight : null;
  const none = (basis: string): WeightEstimate => ({ claimed, estimate: null, low: null, high: null, ratio: null, method: 'none', basis, reference: ctx.refMax });
  if (test !== 'deadlift' && test !== 'squat' && test !== 'bench') return none('Not a loaded lift.');
  if (f['speedUnreliable'] || !(f['pctOfMax'] > 0) || !(f['vFirst'] > 0)) return none('The bar speed could not be measured reliably from this video (the angle, or part of the rep off camera).');

  // The share of a max the first rep's speed corresponds to.
  const pct = f['pctOfMax'];
  const bw = ctx.bodyWeightLb ?? 0;
  const typical = ctx.sex === 'female' ? { deadlift: 1.3, squat: 1.1, bench: 0.7 } : { deadlift: 1.7, squat: 1.45, bench: 1.1 };
  const ref = ctx.refMax && ctx.refMax > 0 ? ctx.refMax : bw > 0 ? bw * typical[test] : null;
  if (!ref) return none('There is no earlier verified result or body weight to anchor an estimate to.');

  const share = pct / 100;
  let spread = ctx.refMax ? thr(test, 'weightSpread') / 100 : 0.3;
  // A set is lighter than a single at the same first-rep speed, and the extra reps raise the question further.
  if ((f['repsClaimed'] ?? 1) > 1) spread += 0.04;
  if (!f['heightKnown']) spread += 0.05;
  const estimate = Math.round(share * ref);
  const low = Math.round(estimate * (1 - spread)), high = Math.round(estimate * (1 + spread));
  const basis = `The bar rose at ${(f['vFirst'] ?? 0).toFixed(2)} m/s, about ${Math.round(pct)}% of a max, against ${ctx.refMax ? `their best verified ${Math.round(ref)} lb` : `a typical ${Math.round(ref)} lb for their body weight (no verified result yet)`}.`;
  return { claimed, estimate, low, high, ratio: claimed ? claimed / estimate : null, method: 'speed', basis, reference: ctx.refMax };
}

export function estimateWeight(
  test: VideoTest, f: Record<string, number>, claim: Claim, ctx: AthleteContext, reading: PlateReading | null
): WeightEstimate {
  const speed = estimateFromSpeed(test, f, claim, ctx);
  const claimed = speed.claimed;
  const secondary = { estimate: speed.estimate, low: speed.low, high: speed.high, basis: speed.basis };
  if (test !== 'deadlift' && test !== 'squat' && test !== 'bench') return { ...speed, speed: null };
  const pw = reading ? plateWeight(reading) : null;
  if (!reading || !pw) {
    const why = reading?.note || 'The plates could not be read from this video.';
    return { claimed, estimate: null, low: null, high: null, ratio: null, method: 'none', basis: why, reference: ctx.refMax,
      confidence: reading?.confidence ?? 'none', plates: reading, speed: secondary };
  }
  const n = reading.perSide as number;
  let basis = `${reading.note} That is the ${BAR_LB} lb bar plus ${2 * n} \u00d7 ${reading.plateLabel}, ${pw.estimate} lb.`;
  if (speed.estimate) {
    const off = Math.abs(speed.estimate - pw.estimate) / pw.estimate;
    basis += off > 0.35 ? ` Bar speed suggests about ${speed.estimate} lb, which is well away from this; bar speed is only a rough guide.` : ` Bar speed (about ${speed.estimate} lb) does not contradict it.`;
  }
  return { claimed, estimate: pw.estimate, low: pw.low, high: pw.high, ratio: claimed ? claimed / pw.estimate : null, method: 'plates', basis,
    reference: ctx.refMax, confidence: reading.confidence, plates: reading, speed: secondary };
}

export function weightCheck(w: WeightEstimate): AiCheck {
  const claimTxt = w.claimed ? ` ${Math.round(w.claimed)} lb was claimed.` : '';
  const speedTxt = w.speed?.estimate ? ` Bar speed alone suggests about ${w.speed.estimate} lb, which cannot confirm a weight.` : '';
  if (w.estimate === null) {
    return check('weight', 'Weight on the bar', 'unclear', `The plates could not be read. ${w.basis}${claimTxt}${speedTxt} Check the plates yourself.`);
  }
  const range = `${w.low}\u2013${w.high} lb`;
  const conf = w.confidence === 'high' ? 'High' : w.confidence === 'medium' ? 'Medium' : 'Low';
  const text = `Read from the plates: about ${w.estimate} lb (${range}). ${conf} confidence. ${w.basis}`;
  if (!w.claimed) return check('weight', 'Weight on the bar', 'unclear', `${text} No weight was claimed to compare.`);
  const high = w.high as number, low = w.low as number;
  const over = w.claimed > high + Math.max(10, 0.05 * high);
  const under = w.claimed < low - Math.max(10, 0.05 * low);
  if (w.confidence === 'low') return check('weight', 'Weight on the bar', 'unclear', `${text}${claimTxt} The reading is not certain enough to confirm or doubt the claim.`);
  if (over) return check('weight', 'Weight on the bar', 'fail', `${text}${claimTxt} The claim is above what the plates show. Check the plates.`);
  if (under) return check('weight', 'Weight on the bar', 'unclear', `${text}${claimTxt} The claim is below what the plates show.`);
  return check('weight', 'Weight on the bar', 'pass', `${text}${claimTxt} The claim matches the plates.`);
}

// The bar's height over time, from the coloured plates (metres above the lowest point seen), or null when the plates
// were not visible enough to follow.
function barHeights(frames: PoseFrame[], mPerPx: number): Array<number | null> | null {
  const ys = frames.map(f => (f.bar && f.bar.n >= 6 ? f.bar.y : null));
  const have = ys.filter((v): v is number => v !== null);
  if (have.length < frames.length * 0.6 || have.length < 8) return null;
  const sm = clean(ys, 4);
  const low = pctile(have, 98);   // the lowest the plates get (the largest y)
  return sm.map(v => (v === null ? null : (low - v) * mPerPx));
}

// ---------- each test ----------

function liftAnalysis(test: 'deadlift' | 'squat' | 'bench', r: VideoReading, claim: Claim, ctx: AthleteContext): Analysis {
  const frames = r.frames;
  const S = side(bestSide(frames));
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const claimedReps = Math.max(1, Math.round(claim.reps ?? 1));

  // Is it the right exercise at all? A pull-up filmed as a deadlift, or a standing video for a bench press, passes
  // every later check by accident, so the posture is checked first.
  {
    const st0 = staturePx(frames) ?? 0;
    let seen = 0, handsUp = 0, upright = 0, torsoSeen = 0;
    for (const f of frames) {
      const nose = pt(f, J.nose), wr = avgY(f, J.lWr, J.rWr);
      if (nose && wr !== null) { seen++; if (wr < nose.y - 0.05 * st0) handsUp++; }
      const sh = pt(f, S.sh), hip = pt(f, S.hip);
      if (sh && hip) { torsoSeen++; if (Math.abs(sh.y - hip.y) > Math.abs(sh.x - hip.x)) upright++; }
    }
    const handsUpFrac = seen ? handsUp / seen : 0, uprightFrac = torsoSeen ? upright / torsoSeen : 0;
    features['handsUpFrac'] = handsUpFrac;
    features['uprightFrac'] = uprightFrac;
    if (test !== 'bench' && seen > 6) {
      checks.push(check('movement', `Looks like a ${test}`, handsUpFrac > thr('*', 'handsUp') / 100 ? 'fail' : 'pass',
        handsUpFrac > thr('*', 'handsUp') / 100 ? `The hands were above the head for ${fmt(handsUpFrac * 100)}% of the video. This looks like a pull-up or an overhead movement.` : 'The hands stayed below the head, as in this lift.', handsUpFrac > thr('*', 'handsUp') / 100));
    }
    if (test === 'bench' && torsoSeen > 6) {
      checks.push(check('movement', 'Looks like a bench press', uprightFrac > thr('*', 'upright') / 100 ? 'fail' : 'pass',
        uprightFrac > thr('*', 'upright') / 100 ? `The lifter was upright for ${fmt(uprightFrac * 100)}% of the video. A bench press is done lying down.` : 'The lifter was lying down.', uprightFrac > thr('*', 'upright') / 100));
    }
  }

  // The driving joint: hips for the deadlift, knees for the squat, elbows for the bench press.
  const drive = test === 'deadlift' ? angleSeries(frames, s => [s.sh, s.hip, s.kn])
    : test === 'squat' ? angleSeries(frames, s => [s.hip, s.kn, s.an])
    : angleSeries(frames, s => [s.sh, s.el, s.wr]);
  const knee = angleSeries(frames, s => [s.hip, s.kn, s.an]);
  const th = test === 'deadlift' ? { flex: 135, ext: 150 } : test === 'squat' ? { flex: 120, ext: 150 } : { flex: 110, ext: 140 };
  let reps = repsFrom(phases(drive, th.flex, th.ext), test === 'deadlift' ? 'flex-ext' : 'ext-flex-ext');
  // The bar itself, followed through the coloured plates. A rep only counts if the bar went up with the lifter: this
  // keeps a lifter who set the bar down and stood up again from being counted twice, and it measures the bar's own speed.
  const heightM0 = ctx.heightIn ? ctx.heightIn * 0.0254 : 1.75;
  const shinsA: number[] = [];
  for (const f of frames) { const k = pt(f, S.kn), a = pt(f, S.an); if (k && a) shinsA.push(Math.hypot(k.x - a.x, k.y - a.y)); }
  const mPerPxBar = shinsA.length ? (0.246 * heightM0) / pctile(shinsA, 75) : 0;
  const bar = mPerPxBar > 0 && test !== 'squat' ? barHeights(frames, mPerPxBar) : null;
  features['barTracked'] = bar ? 1 : 0;
  let allReps = reps;
  if (bar) {
    const minRise = test === 'bench' ? 0.15 : 0.2;
    const moved = (rep: { flex: Phase; ext: Phase }) => {
      let lo = Infinity, hi = -Infinity;
      for (let q = Math.max(0, rep.flex.i - 2); q <= Math.min(frames.length - 1, rep.ext.i + 2); q++) {
        const v = bar[q];
        if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      return hi - lo;
    };
    const kept = reps.filter(rep => moved(rep) >= minRise);
    features['repsBodyOnly'] = reps.length - kept.length;
    if (kept.length !== reps.length) estimates['Rises without the bar'] = reps.length - kept.length;
    reps = kept;
  }
  features['repsSeen'] = reps.length;
  features['repsClaimed'] = claimedReps;
  estimates['Reps seen'] = reps.length;
  checks.push(repsCheck(reps.length, claimedReps, true));
  void allReps;

  // The top and bottom of each rep against the rules.
  const st = staturePx(frames) ?? 1000;
  let locked = 0, deep = 0, good = 0;
  for (const rep of reps) {
    const top = drive[rep.ext.i] as number, bottom = drive[rep.flex.i] as number;
    let lockOk: boolean, depthOk: boolean;
    if (test === 'deadlift') {
      const k = Math.max(...[knee[rep.ext.i], knee[Math.min(knee.length - 1, rep.ext.i + 1)]].filter((x): x is number => x !== null), 0);
      lockOk = top >= thr('deadlift', 'lockout') && (k === 0 || k >= thr('deadlift', 'knee'));
      depthOk = bottom <= thr('deadlift', 'floor');   // hips well bent: the bar started from the floor
    } else if (test === 'squat') {
      lockOk = top >= thr('squat', 'lockout');
      const f = frames[rep.flex.i], hip = pt(f, S.hip), kn = pt(f, S.kn);
      depthOk = bottom <= thr('squat', 'depth') || (!!hip && !!kn && hip.y >= kn.y - 0.02 * st);   // hip crease below the top of the knee
    } else {
      lockOk = top >= thr('bench', 'lockout');
      depthOk = bottom <= thr('bench', 'depth');    // elbows bent to the chest
    }
    if (lockOk) locked++;
    if (depthOk) deep++;
    if (lockOk && depthOk) good++;
  }
  features['goodReps'] = good;
  features['judgedReps'] = reps.length;
  const topRule = test === 'bench' ? 'Arms locked out at the top' : test === 'squat' ? 'Standing fully upright at the top' : 'Hips and knees locked out at the top';
  const botRule = test === 'bench' ? 'Bar touches the chest' : test === 'squat' ? 'Hip crease below the knee' : 'Bar starts from the floor';
  if (reps.length) {
    checks.push(share(locked, reps.length, topRule, 'lockout'));
    if (test === 'deadlift' && deep < reps.length) {
      // A deadlift's start is often cut off when the recording begins late, so a missing floor start is a question.
      const worst = Math.max(...reps.map(rp => drive[rp.flex.i] as number));
      checks.push(check('depth', botRule, worst <= 145 ? 'unclear' : 'fail',
        worst <= 145 ? 'The start of the lift was not clearly seen with the bar on the floor.' : 'The hips never bent far enough for the bar to start on the floor.'));
    } else {
      checks.push(share(deep, reps.length, botRule, 'depth'));
    }
  }

  // Bench: the hips stay on the bench.
  if (test === 'bench') {
    const hips = clean(frames.map(f => pt(f, S.hip)?.y ?? null)).filter((v): v is number => v !== null);
    const arm = armPx(frames, S) ?? st * 0.33;
    if (hips.length > 6 && arm > 0) {
      const lift = (pctile(hips, 95) - pctile(hips, 5)) / arm;
      features['hipRise'] = lift;
      checks.push(check('bench-contact', 'Hips stay on the bench', lift <= thr('bench', 'hipRise') / 100 ? 'pass' : lift <= thr('bench', 'hipRise') / 100 * 1.7 ? 'unclear' : 'fail', `The hips moved ${fmt(lift * 100)}% of an arm's length.`));
    }
  }

  // Bar speed: how fast the body rises from the bottom of each rep to the top, in metres. Heights are measured
  // against the athlete's own body in the same frame (the shin for a deadlift or squat, the arm for a bench press),
  // so a handheld camera that drifts or zooms does not change the answer. The shoulders rise about as far as the bar
  // in a deadlift and a squat; in a bench press the hands carry the bar.
  const heightM = ctx.heightIn ? ctx.heightIn * 0.0254 : 1.75;
  features['heightKnown'] = ctx.heightIn ? 1 : 0;
  const shinM = 0.246 * heightM, armM = 0.332 * heightM;
  const shins: number[] = [];
  for (const f of frames) { const k = pt(f, S.kn), a = pt(f, S.an); if (k && a) shins.push(Math.hypot(k.x - a.x, k.y - a.y)); }
  const shinPx = shins.length ? pctile(shins, 75) : 0;
  const armLen = armPx(frames, S) ?? 0;
  const carrier = clean(frames.map(f => {
    if (test === 'bench') {
      const w = avgY(f, J.lWr, J.rWr), sh = avgY(f, J.lSh, J.rSh);
      return w !== null && sh !== null && armLen > 0 ? ((sh - w) / armLen) * armM : null;
    }
    // One shin length for the whole video: a shin seen at an angle looks shorter, which would make the height jump.
    const sh = avgY(f, J.lSh, J.rSh), an = avgY(f, J.lAn, J.rAn);
    return sh !== null && an !== null && shinPx > 0 ? ((an - sh) / shinPx) * shinM : null;
  }));
  const speeds: number[] = [];
  for (const rep of reps) {
    // With the plates tracked, the bar's own rise is used (from its lowest point before the top to its highest point in
    // the rep); otherwise the body's.
    const series = bar ?? carrier;
    const a0 = Math.max(0, rep.flex.i - 12), b0 = Math.min(frames.length - 1, rep.ext.i + 12);
    let top = -1, hi = -Infinity;
    for (let q = a0; q <= b0; q++) { const v = series[q]; if (v !== null && v > hi) { hi = v; top = q; } }
    if (top < 0) continue;
    let bot = a0, lo = Infinity;
    for (let q = a0; q <= top; q++) { const v = series[q]; if (v !== null && v < lo) { lo = v; bot = q; } }
    const span = hi - lo;
    // Only a rep seen from bottom to top: a recording that starts late shows only the end of the lift.
    if (span < (test === 'bench' ? 0.2 : 0.25)) continue;
    // From the last moment near the bottom to the first moment near the top.
    let j = bot, e = top;
    for (let q = bot; q <= top; q++) { const v = series[q]; if (v !== null && v <= lo + 0.08 * span) j = q; }
    for (let q = top; q >= bot; q--) { const v = series[q]; if (v !== null && v >= hi - 0.08 * span) e = q; }
    const dt = frames[e].t - frames[j].t, dh = (series[e] as number) - (series[j] as number);
    if (dt > 0.08 && dh > 0.08) speeds.push(dh / dt);
  }
  // Faster than any loaded lift can move means the measurement is off (a partial view, a bad scale): leave it out.
  const plausible = speeds.filter(v => v <= (test === 'bench' ? 1.3 : 1.5) && pctOfMax(test, v) > 40);
  if (speeds.length && plausible.length < speeds.length) {
    features['speedUnreliable'] = 1;
    if ((ctx.prevValue ? claim.value >= ctx.prevValue * 0.98 : false) && claimedReps <= 3) {
      checks.push(check('bar-speed', 'Bar speed fits a max effort', 'unclear', 'Bar speed could not be measured reliably from this video (the angle, or part of the rep off camera).'));
    }
  }
  if (plausible.length && plausible.length === speeds.length) {
    const first = speeds[0], slowest = Math.min(...speeds);
    const pct = pctOfMax(test, slowest);
    const loss = speeds.length > 1 ? Math.max(0, (first - speeds[speeds.length - 1]) / first) : 0;
    features['vFirst'] = first; features['vSlowest'] = slowest; features['velocityLoss'] = loss; features['pctOfMax'] = pct;
    estimates['Bar speed (slowest rep)'] = `${fmt(slowest, 2)} m/s`;
    estimates['Effort from bar speed'] = `about ${fmt(pct)}% of a max`;
    const w = claim.weight ?? 0;
    if (w > 0) {
      const oneRm = w / (pct / 100);
      features['velocityOneRmRatio'] = claim.value > 0 ? claim.value / oneRm : 0;
      estimates['1RM from bar speed'] = `${fmt(oneRm)} lb`;
    }
    // A new best should be close to a max, so the bar moves slowly. A fast bar on a new best suggests lighter plates
    // than claimed (or a camera scale that is off), so the plates get a closer look.
    const isBest = ctx.prevValue ? claim.value >= ctx.prevValue * 0.98 : false;
    features['claimIsBest'] = isBest ? 1 : 0;
    if (isBest && claimedReps <= 3) {
      // Measured from one camera, bar speed is a hint, not proof: it can raise a question but never fail a lift.
      checks.push(check('bar-speed', 'Bar speed fits a max effort', pct >= thr(test, 'speedPass') ? 'pass' : 'unclear',
        `The slowest rep rose at ${fmt(slowest, 2)} m/s, about ${fmt(pct)}% of a max. A new best is usually slow.${ctx.heightIn ? '' : ' Height unknown, so the scale is assumed.'}`));
    }
    if (claimedReps >= 4 && speeds.length >= 4) {
      checks.push(check('fatigue', 'Reps slow down as the set goes on', loss >= 0.12 ? 'pass' : 'unclear',
        `The bar slowed ${fmt(loss * 100)}% from the first rep to the last. A hard set usually slows by 15% or more.`));
    }
  }
  return { checks, features, estimates };
}

function armPx(frames: PoseFrame[], S: ReturnType<typeof side>): number | null {
  const xs: number[] = [];
  for (const f of frames) { const a = pt(f, S.sh), b = pt(f, S.el), c = pt(f, S.wr); if (a && b && c) xs.push(Math.hypot(a.x - b.x, a.y - b.y) + Math.hypot(b.x - c.x, b.y - c.y)); }
  return xs.length ? pctile(xs, 90) : null;
}

function bodyweightAnalysis(test: 'pushups' | 'pullups', r: VideoReading, claim: Claim): Analysis {
  const frames = r.frames;
  const S = side(bestSide(frames));
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const claimed = Math.max(0, Math.round(claim.value));
  const elbow = angleSeries(frames, s => [s.sh, s.el, s.wr]);
  const reps = test === 'pushups'
    ? repsFrom(phases(elbow, 110, 140), 'ext-flex-ext')
    : repsFrom(phases(elbow, 100, 140), 'ext-flex');
  features['repsSeen'] = reps.length;
  features['repsClaimed'] = claimed;
  estimates['Reps seen'] = reps.length;
  checks.push(repsCheck(reps.length, claimed, true));

  const st = staturePx(frames) ?? 800;
  let a = 0, b = 0, c = 0, good = 0;
  for (const rep of reps) {
    const bent = elbow[rep.flex.i] as number, straight = elbow[rep.ext.i] as number;
    if (test === 'pushups') {
      const f = frames[rep.flex.i];
      const line = angle(pt(f, S.sh), pt(f, S.hip), pt(f, S.an));
      const bendOk = bent <= thr('pushups', 'bend'), lockOk = straight >= thr('pushups', 'lockout'), lineOk = line === null || line >= thr('pushups', 'line');
      if (bendOk) a++; if (lockOk) b++; if (lineOk) c++;
      if (bendOk && lockOk && lineOk) good++;
    } else {
      const f = frames[rep.flex.i], nose = pt(f, J.nose), wr = avgY(f, J.lWr, J.rWr);
      const hangOk = straight >= thr('pullups', 'hang'), chinOk = nose && wr !== null ? nose.y <= wr + 0.03 * st : bent <= 70;
      if (hangOk) a++; if (chinOk) b++;
      if (hangOk && chinOk) good++;
    }
  }
  features['goodReps'] = good;
  features['judgedReps'] = reps.length;
  if (reps.length) estimates['Reps meeting the standard'] = `${good} of ${reps.length}`;
  if (reps.length) {
    if (test === 'pushups') {
      const ps = thr('pushups', 'passShare') / 100;
      checks.push(share(a, reps.length, 'Elbows bend to 90 degrees', 'bend', ps, 0.6));
      checks.push(share(b, reps.length, 'Arms lock out at the top', 'lockout', ps, 0.6));
      checks.push(share(c, reps.length, 'Body in a straight line', 'line', ps, 0.6));
    } else {
      const ps = thr('pullups', 'passShare') / 100;
      checks.push(share(a, reps.length, 'Full hang between reps', 'hang', ps, 0.6));
      checks.push(share(b, reps.length, 'Chin clears the bar', 'chin', ps, 0.6));
    }
  }

  // Pull-ups: no kipping or swinging.
  if (test === 'pullups') {
    const hx = clean(frames.map(f => pt(f, S.hip)?.x ?? null)).filter((v): v is number => v !== null);
    const torso: number[] = [];
    for (const f of frames) { const p = pt(f, S.sh), q = pt(f, S.hip); if (p && q) torso.push(Math.hypot(p.x - q.x, p.y - q.y)); }
    if (hx.length > 6 && torso.length) {
      const swing = (pctile(hx, 95) - pctile(hx, 5)) / median(torso);
      features['swing'] = swing;
      checks.push(check('kip', 'No kipping or swinging', swing <= thr('pullups', 'kip') / 100 ? 'pass' : swing <= thr('pullups', 'kip') / 100 * 1.7 ? 'unclear' : 'fail', `The hips swung ${fmt(swing * 100)}% of the torso length.`));
    }
  }

  // Continuous, no rest at the top or bottom: a gap between reps far longer than the usual one is a pause.
  if (reps.length >= 3) {
    const gaps: number[] = [];
    for (let k = 1; k < reps.length; k++) gaps.push(frames[reps[k].flex.i].t - frames[reps[k - 1].flex.i].t);
    const m = median(gaps), worst = Math.max(...gaps);
    features['pauseRatio'] = m > 0 ? worst / m : 0;
    checks.push(check('continuous', 'Continuous, no pauses', worst <= Math.max(2.2 * m, m + 1.2) ? 'pass' : worst <= 3.5 * m ? 'unclear' : 'fail',
      `The longest gap between reps was ${fmt(worst, 1)} s; the usual one ${fmt(m, 1)} s.`));
  }
  return { checks, features, estimates };
}

function longJumpAnalysis(r: VideoReading, claim: Claim, ctx: AthleteContext): Analysis {
  const frames = r.frames;
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const st = staturePx(frames.slice(0, Math.max(3, Math.floor(frames.length / 4))));
  const heightM = ctx.heightIn ? ctx.heightIn * 0.0254 : 1.75;
  const ank = clean(frames.map(f => avgY(f, J.lAn, J.rAn)));
  const vals = ank.filter((v): v is number => v !== null);
  if (!st || vals.length < 8) {
    checks.push(check('jump', 'Jump seen', 'unclear', 'The athlete was not clear enough to follow the jump.'));
    return { checks, features, estimates };
  }
  const ground = pctile(vals, 85);
  const air = ank.map(v => v !== null && v < ground - 0.06 * st);
  const takeoff = air.indexOf(true);
  let landing = -1;
  for (let i = takeoff + 1; takeoff >= 0 && i < air.length; i++) if (!air[i]) { landing = i; break; }
  features['flightFrames'] = takeoff >= 0 && landing > takeoff ? landing - takeoff : 0;
  if (takeoff < 0 || landing < 0) {
    checks.push(check('jump', 'Jump seen', 'unclear', 'No clear take-off and landing were found.'));
    return { checks, features, estimates };
  }
  checks.push(check('jump', 'Jump seen', 'pass', `In the air for about ${fmt(frames[landing].t - frames[takeoff].t, 2)} s.`));

  // Both feet together at take-off and landing.
  const together = (i: number) => {
    const f = frames[i], a = pt(f, J.lAn), b = pt(f, J.rAn);
    return a && b ? Math.abs(a.y - b.y) <= 0.05 * st : null;
  };
  const t0 = together(Math.max(0, takeoff - 1)), t1 = together(Math.min(frames.length - 1, landing + 1));
  checks.push(check('two-feet', 'Two-footed take-off and landing', t0 === null || t1 === null ? 'unclear' : t0 && t1 ? 'pass' : 'unclear',
    t0 === null || t1 === null ? 'The feet were not both visible.' : t0 && t1 ? 'Both feet left and landed together.' : 'The feet did not look level at take-off or landing.'));

  // Distance: the toes before take-off to the rear heel after landing, scaled by the athlete's height.
  const toeX = (i: number) => { const f = frames[i]; const xs = [pt(f, J.lToe)?.x, pt(f, J.rToe)?.x].filter((x): x is number => x !== undefined); return xs.length ? xs : null; };
  const heelX = (i: number) => { const f = frames[i]; const xs = [pt(f, J.lHeel)?.x, pt(f, J.rHeel)?.x].filter((x): x is number => x !== undefined); return xs.length ? xs : null; };
  const start = toeX(Math.max(0, takeoff - 1)), endIdx = Math.min(frames.length - 1, landing + 2), end = heelX(endIdx);
  if (start && end) {
    const dir = Math.sign(median(end) - median(start)) || 1;
    const line = dir > 0 ? Math.max(...start) : Math.min(...start);
    const rear = dir > 0 ? Math.min(...end) : Math.max(...end);
    const meters = Math.abs(rear - line) / (st / heightM);
    const claimedM = claim.value * 0.0254;
    const ratio = claimedM > 0 ? meters / claimedM : 0;
    features['jumpRatio'] = ratio;
    estimates['Distance measured'] = `${fmt(meters / 0.0254)} in`;
    checks.push(check('distance', 'Distance matches the claim', ratio >= thr('longjump', 'distance') / 100 ? 'pass' : ratio >= thr('longjump', 'distance') / 100 - 0.25 ? 'unclear' : 'fail',
      `Measured about ${fmt(meters / 0.0254)} in against ${fmt(claim.value)} in claimed${ctx.heightIn ? '' : ' (height unknown, scale assumed)'}. Camera angle can shorten it.`));
  } else {
    checks.push(check('distance', 'Distance matches the claim', 'unclear', 'The feet were not clear at take-off or landing.'));
  }
  return { checks, features, estimates };
}

function runAnalysis(test: 'sprint' | 'run400', r: VideoReading, claim: Claim): Analysis {
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const claimed = claim.value;
  const ratio = claimed > 0 ? r.duration / claimed : 0;
  features['durationRatio'] = ratio;
  estimates['Video length'] = `${fmt(r.duration, 1)} s`;
  const tol = thr(test, 'length');
  checks.push(check('length', 'Video covers the whole run', r.duration + tol >= claimed ? 'pass' : 'fail',
    `The video is ${fmt(r.duration, 1)} s long; ${fmt(claimed, test === 'sprint' ? 2 : 0)} s claimed.`, r.duration + tol < claimed));
  // Running: the feet keep moving apart and together.
  const S = r.frames;
  const spread: number[] = [];
  for (const f of S) { const a = pt(f, J.lAn), b = pt(f, J.rAn), n = pt(f, J.nose); if (a && b && n) spread.push(Math.abs(a.x - b.x) / Math.max(1, Math.abs(((a.y + b.y) / 2) - n.y))); }
  const moving = spread.length > 6 ? pctile(spread, 90) - pctile(spread, 10) : 0;
  features['stride'] = moving;
  checks.push(check('running', 'Running seen', moving >= 0.15 ? 'pass' : 'unclear', spread.length > 6 ? 'Stride measured from the feet.' : 'The runner was too small or far to follow.'));
  return { checks, features, estimates };
}

function holdAnalysis(test: 'pike' | 'backbend', r: VideoReading, claim: Claim): Analysis {
  const frames = r.frames;
  const S = side(bestSide(frames));
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const inPose = frames.map(f => {
    if (test === 'pike') {
      const hip = angle(pt(f, S.sh), pt(f, S.hip), pt(f, S.kn)), knee = angle(pt(f, S.hip), pt(f, S.kn), pt(f, S.an));
      return hip !== null && knee !== null && hip <= 100 && knee >= 150;
    }
    const hip = pt(f, S.hip), sh = pt(f, S.sh), kn = pt(f, S.kn);
    return !!(hip && sh && kn && hip.y < sh.y && hip.y < kn.y);
  });
  // The longest stretch in the position, forgiving a single missed frame.
  let best = 0, startT = -1, lastIn = -1;
  for (let i = 0; i < frames.length; i++) {
    if (inPose[i]) {
      if (startT < 0 || (lastIn >= 0 && i - lastIn > 2)) startT = frames[i].t;
      lastIn = i;
      best = Math.max(best, frames[i].t - startT);
    }
  }
  features['holdSeconds'] = best;
  estimates['Held for'] = `${fmt(best, 1)} s`;
  checks.push(check('hold', 'Held for 5 seconds', best >= thr(test, 'hold') ? 'pass' : best >= 2 ? 'unclear' : test === 'backbend' && claim.value <= 1 ? 'unclear' : 'fail',
    best > 0 ? `Held about ${fmt(best, 1)} s.` : 'The position was not recognised.'));

  if (test === 'pike') {
    // Straight knees, and the reach the claimed score needs: from the knee (0) to the ankle (1) and past it.
    const reach: number[] = [], elbowReach: number[] = [];
    frames.forEach((f, i) => {
      if (!inPose[i]) return;
      const kn = pt(f, S.kn), an = pt(f, S.an), wr = pt(f, S.wr), el = pt(f, S.el);
      if (kn && an && an.y > kn.y) {
        const leg = an.y - kn.y;
        if (wr) reach.push((wr.y - kn.y) / leg);
        if (el) elbowReach.push((el.y - kn.y) / leg);
      }
    });
    const rch = reach.length ? pctile(reach, 90) : null, erch = elbowReach.length ? pctile(elbowReach, 90) : null;
    if (rch !== null) { features['reach'] = rch; estimates['Hands reach'] = rch >= 1 ? 'past the ankles' : `${fmt(rch * 100)}% of the way to the ankles`; }
    const sc = claim.value;
    let need: { v: number | null; to: number; what: string };
    if (sc <= 2) need = { v: rch, to: 0.5, what: 'hands to the shins' };
    else if (sc <= 3.5) need = { v: rch, to: 0.9, what: 'hands to the toes' };
    else if (sc <= 5.5) need = { v: rch, to: 1.0, what: 'hands to the ground' };
    else if (sc <= 7.5) need = { v: erch, to: 0.55, what: 'forearms toward the ground' };
    else need = { v: erch, to: 0.85, what: 'elbows to the ground' };
    checks.push(check('reach', 'Reach matches the score', need.v === null ? 'unclear' : need.v >= need.to ? 'pass' : need.v >= need.to - 0.25 ? 'unclear' : 'fail',
      need.v === null ? 'The arms were not clear enough to measure.' : `Score ${sc} needs ${need.what}.`));
  } else if (claim.value >= 7) {
    // A head-to-toe backbend: the head reaches the feet.
    const d: number[] = [];
    frames.forEach((f, i) => {
      if (!inPose[i]) return;
      const n = pt(f, J.nose), an = pt(f, S.an), sh = pt(f, S.sh), hip = pt(f, S.hip);
      if (n && an && sh && hip) d.push(Math.hypot(n.x - an.x, n.y - an.y) / Math.hypot(sh.x - hip.x, sh.y - hip.y));
    });
    const closest = d.length ? Math.min(...d) : null;
    if (closest !== null) features['headToFoot'] = closest;
    checks.push(check('depth', 'Head reaches the feet', closest === null ? 'unclear' : closest <= 0.6 ? 'pass' : closest <= 1 ? 'unclear' : 'fail',
      closest === null ? 'The head and feet were not both visible.' : `Closest head to foot: ${fmt(closest * 100)}% of the torso length.`));
  }
  return { checks, features, estimates };
}

// ---------- every video ----------

function universal(test: VideoTest, r: VideoReading, claim: Claim, ctx: AthleteContext, duplicateOf: string | null, ownRepeat: boolean): Analysis {
  const checks: AiCheck[] = [];
  const features: Record<string, number> = {};
  const estimates: Record<string, number | string> = {};
  const seen = r.frames.filter(f => !!f.pts).length;
  const presence = r.frames.length ? seen / r.frames.length : 0;
  features['presence'] = presence;
  features['duration'] = r.duration;
  const runLike = test === 'sprint' || test === 'run400';
  checks.push(check('visible', 'Athlete visible', presence >= thr(test, 'visible') / 100 ? 'pass' : presence >= 0.25 ? 'unclear' : 'fail',
    `Found in ${fmt(presence * 100)}% of the frames.`));

  // Cuts: a frame that changes far more than its neighbours. A handheld camera following a runner moves a lot, so
  // there a cut only makes the video worth a closer look.
  if (r.diffs.length > 8) {
    const m = median(r.diffs);
    const cutIdx: number[] = [];
    r.diffs.forEach((d, i) => { if (i > 1 && i < r.diffs.length - 2 && d > Math.max(28, thr('*', 'cut') * m)) cutIdx.push(i); });
    // The athlete jumping across the frame between two samples points the same way.
    let jumps = 0;
    const st = staturePx(r.frames) ?? 0;
    for (let i = 1; i < r.frames.length && st; i++) {
      const a = r.frames[i - 1], b = r.frames[i];
      const pa = a.pts ? pt(a, J.lHip) ?? pt(a, J.rHip) : null, pb = b.pts ? pt(b, J.lHip) ?? pt(b, J.rHip) : null;
      if (pa && pb && Math.hypot(pa.x - pb.x, pa.y - pb.y) > 0.5 * st && b.t - a.t < 0.25) jumps++;
    }
    features['cuts'] = cutIdx.length;
    features['poseJumps'] = jumps;
    const cuts = cutIdx.length + (runLike ? 0 : jumps);
    checks.push(check('uncut', 'One continuous take', cuts === 0 ? 'pass' : runLike ? 'unclear' : cuts === 1 ? 'unclear' : 'fail',
      cuts === 0 ? 'No cuts found.' : `${cuts} possible cut${cuts === 1 ? '' : 's'}${cutIdx.length ? ` near ${cutIdx.slice(0, 3).map(i => fmt(r.frames[i + 1]?.t ?? 0, 1) + ' s').join(', ')}` : ''}.`));
  }

  // The same footage sent before.
  features['duplicate'] = duplicateOf ? 1 : 0;
  features['ownRepeat'] = ownRepeat ? 1 : 0;
  checks.push(check('original', 'Not a video sent before',
    duplicateOf ? 'fail' : ownRepeat ? 'unclear' : 'pass',
    duplicateOf ? `Matches a video already sent by ${duplicateOf}.` : ownRepeat ? 'The athlete sent this same video before.' : 'No match among earlier videos.', !!duplicateOf));

  // Progress against the athlete's own record: a far bigger jump than training usually gives deserves a closer look.
  const lowerBetter = test === 'sprint' || test === 'run400';
  if (ctx.prevValue && ctx.prevValue > 0 && claim.value > 0) {
    const gain = lowerBetter ? (ctx.prevValue - claim.value) / ctx.prevValue : (claim.value - ctx.prevValue) / ctx.prevValue;
    const days = ctx.prevDate ? Math.max(1, (Date.now() - Date.parse(ctx.prevDate)) / 86400000) : 60;
    const monthly: Record<VideoTest, number> = { deadlift: 0.06, squat: 0.06, bench: 0.05, longjump: 0.04, sprint: 0.025, run400: 0.04, pushups: 0.2, pullups: 0.2, pike: 0.15, backbend: 0.15 };
    const allowed = (0.04 + monthly[test] * Math.max(0.5, days / 30)) * (thr(test, 'progress') / 100);
    features['gain'] = gain;
    features['gainVsUsual'] = allowed > 0 ? gain / allowed : 0;
    estimates['Change from last verified'] = `${gain >= 0 ? '+' : ''}${fmt(gain * 100, 1)}% in ${fmt(days)} days`;
    checks.push(check('progress', 'Progress in line with training', gain <= allowed ? 'pass' : gain <= 2 * allowed ? 'unclear' : 'fail',
      `${gain >= 0 ? '+' : ''}${fmt(gain * 100, 1)}% since the last verified result ${fmt(days)} days ago; up to about ${fmt(allowed * 100)}% is usual.`));
  }

  // Lifts against body weight and against the athlete's other lifts: unusual ratios are worth a look, not a rejection.
  if ((test === 'deadlift' || test === 'squat' || test === 'bench') && claim.value > 0) {
    const bw = ctx.bodyWeightLb ?? 0;
    if (bw > 0) {
      const elite = ctx.sex === 'female' ? { deadlift: 2.6, squat: 2.3, bench: 1.45 } : { deadlift: 3.1, squat: 2.7, bench: 2.0 };
      const ratio = claim.value / bw;
      features['bwRatio'] = ratio / elite[test];
      checks.push(check('bodyweight', 'Strength for body weight', ratio <= elite[test] ? 'pass' : 'unclear',
        `${fmt(ratio, 2)} times body weight; ${fmt(elite[test], 1)} is elite.`));
    }
    const l = { ...ctx.lifts, [test]: claim.value };
    if (l.deadlift > 0 && l.squat > 0 && l.bench > 0) {
      const sq = l.squat / l.deadlift, bn = l.bench / l.deadlift;
      const odd = sq > 1.1 || sq < 0.55 || bn > 0.9 || bn < 0.35;
      features['liftBalance'] = odd ? 1 : 0;
      checks.push(check('balance', 'In line with the other lifts', odd ? 'unclear' : 'pass',
        `Squat ${fmt(sq * 100)}% and bench ${fmt(bn * 100)}% of the deadlift.`));
    }
  }
  return { checks, features, estimates };
}

// Runs every check for one video. On a lift the weight check comes first, with its own estimate; the other checks follow.
export function analyze(test: VideoTest, r: VideoReading, claim: Claim, ctx: AthleteContext, duplicateOf: string | null, ownRepeat = false): Analysis {
  const u = universal(test, r, claim, ctx, duplicateOf, ownRepeat);
  const t = test === 'deadlift' || test === 'squat' || test === 'bench' ? liftAnalysis(test, r, claim, ctx)
    : test === 'pushups' || test === 'pullups' ? bodyweightAnalysis(test, r, claim)
    : test === 'longjump' ? longJumpAnalysis(r, claim, ctx)
    : test === 'sprint' || test === 'run400' ? runAnalysis(test, r, claim)
    : holdAnalysis(test, r, claim);
  const features = { ...u.features, ...t.features };
  if (r.plates) { features['plateSat'] = r.plates.sat; features['plateBlobs'] = r.plates.blobs; features['plateRed'] = r.plates.red; features['plateBlue'] = r.plates.blue; features['plateYellow'] = r.plates.yellow; features['plateGreen'] = r.plates.green; }
  const estimates = { ...t.estimates, ...u.estimates };
  const lift = test === 'deadlift' || test === 'squat' || test === 'bench';
  let weight: WeightEstimate | null = null;
  const checks = [...t.checks, ...u.checks];
  if (lift) {
    const pr = r.plateRead;
    features['platesRead'] = pr?.readable ? 1 : 0;
    if (pr?.readable) { features['platePerSide'] = pr.perSide ?? 0; features['plateLb'] = pr.plateLb ?? 0; features['plateDiaMm'] = pr.diameterMm ?? 0; }
    weight = estimateWeight(test, features, claim, ctx, pr);
    checks.unshift(weightCheck(weight));
    const ordered: Record<string, number | string> = {};
    ordered['Weight from the plates'] = weight.estimate === null ? 'plates not read' : `about ${weight.estimate} lb (${weight.low}\u2013${weight.high}), ${weight.confidence} confidence`;
    if (weight.speed?.estimate) ordered['Weight from bar speed'] = `about ${weight.speed.estimate} lb (secondary)`;
    if (weight.claimed) ordered['Claimed weight'] = `${Math.round(weight.claimed)} lb`;
    for (const k of Object.keys(estimates)) if (!k.startsWith('1RM from')) ordered[k] = estimates[k];
    return { checks, features, estimates: ordered, weight };
  }
  return { checks, features, estimates, weight };
}

// The verdict from the checks alone: any critical failure makes it likely invalid; any failure or open question sends
// it to the coach as "needs review"; all clear is "likely valid".
export function ruleVerdict(checks: AiCheck[], presence: number): { verdict: AiVerdict; score: number; confidence: number } {
  const n = checks.length || 1;
  const pass = checks.filter(c => c.result === 'pass').length;
  const fail = checks.filter(c => c.result === 'fail').length;
  const unclear = checks.filter(c => c.result === 'unclear').length;
  const critical = checks.some(c => c.result === 'fail' && c.critical);
  const score = Math.max(0, Math.min(1, (pass + 0.5 * unclear) / n - (critical ? 0.4 : 0)));
  const verdict: AiVerdict = critical || fail >= 2 ? 'likely-invalid' : fail || unclear ? 'needs-review' : 'likely-valid';
  const confidence = Math.max(0.05, Math.min(1, presence * (1 - unclear / n)));
  return { verdict, score, confidence };
}

// The numbers the learned model reads, the same for every test.
export const LEARN_FEATURES = [
  'ruleScore', 'passFrac', 'failFrac', 'unclearFrac', 'criticalFail', 'presence', 'cuts', 'duplicate',
  'repsRatio', 'goodRepFrac', 'pctOfMax', 'velocityLoss', 'gainVsUsual', 'bwRatio', 'jumpRatio', 'durationRatio', 'holdSeconds'
] as const;

export function learnVector(f: Record<string, number>, checks: AiCheck[], ruleScore: number): number[] {
  const n = checks.length || 1;
  const extra: Record<string, number> = {
    ruleScore,
    passFrac: checks.filter(c => c.result === 'pass').length / n,
    failFrac: checks.filter(c => c.result === 'fail').length / n,
    unclearFrac: checks.filter(c => c.result === 'unclear').length / n,
    criticalFail: checks.some(c => c.result === 'fail' && c.critical) ? 1 : 0,
    repsRatio: f['repsClaimed'] ? Math.min(2, (f['repsSeen'] ?? 0) / f['repsClaimed']) : 1,
    goodRepFrac: f['judgedReps'] ? (f['goodReps'] ?? 0) / f['judgedReps'] : 1,
    pctOfMax: (f['pctOfMax'] ?? 85) / 100
  };
  return LEARN_FEATURES.map(k => {
    const v = extra[k] ?? f[k] ?? 0;
    return isFinite(v) ? v : 0;
  });
}
