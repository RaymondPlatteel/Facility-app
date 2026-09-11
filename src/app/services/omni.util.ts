// Shared Omni Method assessment math + "is this exercise a tracked benchmark"
// detection. Kept framework-free so the program creator, live session, and the
// assessments page can all reuse the exact same scoring as the original OMPAR tool.
// `import type` avoids a runtime circular dependency: firebase.service.ts (below)
// imports runtime helpers back out of this file.
import type { AssessmentInputs, OmniRank, Sex } from './firebase.service';

// The four strength benchmarks an in-session lift can set a PR on. `key` matches
// the AssessmentInputs field (the estimated 1RM); `<key>Weight`/`<key>Reps` hold
// the entry that produced it. Matching is fuzzy on the exercise name, with
// excludes so close variants (RDL, split squat, incline bench…) don't false-fire.
export interface AssessmentLift {
  key: 'deadlift' | 'squat' | 'bench' | 'pullup1rm';
  label: string;
  bodyweightBased?: boolean;  // pull-up 1RM = Brzycki(bodyweight + added load, reps)
  includes: string[];
  excludes: string[];
}

export const ASSESSMENT_LIFTS: AssessmentLift[] = [
  { key: 'deadlift', label: 'Deadlift', includes: ['deadlift'], excludes: ['romanian', 'rdl', 'stiff', 'single leg', 'single-leg', 'deficit', 'snatch grip'] },
  { key: 'squat', label: 'Squat', includes: ['squat'], excludes: ['split', 'bulgarian', 'goblet', 'front', 'pistol', 'jump', 'wall', 'hack', 'box', 'overhead', 'zercher', 'sissy'] },
  { key: 'bench', label: 'Bench', includes: ['bench'], excludes: ['incline', 'decline', 'dumbbell', 'db ', 'single arm', 'single-arm'] },
  { key: 'pullup1rm', label: 'Pull-up', bodyweightBased: true, includes: ['pull-up', 'pullup', 'pull up', 'chin-up', 'chinup', 'chin up'], excludes: [] }
];

// Returns the matching benchmark lift for an exercise name, or null.
export function matchAssessmentLift(name: string): AssessmentLift | null {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  for (const lift of ASSESSMENT_LIFTS) {
    if (lift.excludes.some(x => n.includes(x))) continue;
    if (lift.includes.some(inc => n.includes(inc))) return lift;
  }
  return null;
}

// ---------- Scoring (ported verbatim from the OMPAR assessment) ----------
export function brzycki(weight: number, reps: number): number {
  if (!weight || reps < 1) return weight || 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// ---------- Per-test overrides ("modify assessment") ----------
// A coach can swap out any one of the 13 tracked tests for a custom one on
// a per-client basis (see ClientProfile.assessmentCustomizable and the
// Assessments page). The raw result still gets typed into that same test's
// existing input — only its name and "world record" reference change, so
// the swap can't touch anything about how a raw value is entered or which
// category it counts toward.
//
// Every test but sprint is "higher is better" (more weight/reps/distance
// wins); sprint is the one time-based, lower-is-better test. An override
// always scores as a straight ratio against the custom world record in
// that same direction — deliberately NOT trying to replicate the sqrt
// curves calcPower/calcCardio use for their time-ish sub-tests, since
// those exist to smooth out extreme values near a world record and a
// coach typing a custom name+record for, say, a made-up strength variant
// has no equivalent curve to reproduce. In practice this only matters for
// the tests a coach would actually plausibly swap (the strength lifts,
// which already scored via a plain ratio to begin with) — everything else
// keeps its original, un-overridden formula unless a coach overrides it.
export type TestKey = keyof AssessmentInputs;

export interface TestOverride {
  name: string;        // custom test name, e.g. "Trap Bar Deadlift"
  worldRecord: number; // replaces that slot's built-in reference value
}

export type TestOverrides = Partial<Record<TestKey, TestOverride>>;

const LOWER_IS_BETTER: ReadonlySet<TestKey> = new Set<TestKey>(['sprint']);

function overrideScore(raw: number, worldRecord: number, key: TestKey): number {
  if (!worldRecord) return 0;
  const pct = LOWER_IS_BETTER.has(key) ? (worldRecord / (raw || Infinity)) * 100 : (raw / worldRecord) * 100;
  return isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}

// Runs a slot's normal (un-overridden) scoring unless `overrides` has an
// entry for it, in which case that entry's world record drives a plain
// ratio score instead. `fallback` is the slot's usual formula contribution
// (e.g. `dl / 939 * 100`) — passed as a thunk so it's only evaluated when
// actually needed.
function slotScore(raw: number, key: TestKey, overrides: TestOverrides | undefined, fallback: () => number): number {
  const ov = overrides?.[key];
  return ov ? overrideScore(raw, ov.worldRecord, key) : fallback();
}

export function calcStrength(dl: number, sq: number, bn: number, pu: number, overrides?: TestOverrides): number {
  const dlScore = slotScore(dl, 'deadlift', overrides, () => dl / 939 * 100);
  const sqScore = slotScore(sq, 'squat', overrides, () => sq / 800 * 100);
  const bnScore = slotScore(bn, 'bench', overrides, () => bn / 600 * 100);
  const puScore = slotScore(pu, 'pullup1rm', overrides, () => pu / 500 * 100);
  return (dlScore + sqScore + bnScore + puScore) / 4;
}
export function calcPower(lj: number, sp: number, overrides?: TestOverrides): number {
  const ljScore = slotScore(lj, 'longjump', overrides, () => lj / 147 * 100);
  const spScore = slotScore(sp, 'sprint', overrides, () => (Math.sqrt((sp - 9.58) / 0.125) * -1 + 10) * 10);
  return (ljScore + spScore) / 2;
}
export function calcEndurance(pu: number, pulls: number, overrides?: TestOverrides): number {
  const puScore = slotScore(pu, 'pushups', overrides, () => (pu / 150) * 100);
  const pullsScore = slotScore(pulls, 'pullups', overrides, () => (pulls / 49) * 100);
  return (puScore + pullsScore) / 2;
}
export function calcCardio(r30: number, s2: number, overrides?: TestOverrides): number {
  const rs = slotScore(r30, 'run30', overrides, () => r30 < 4.02336
    ? (Math.sqrt((11.265408 - r30) / 0.11265408) * -1 + 10) * 10
    : r30 / 11.265408 * 100);
  const s2Score = slotScore(s2, 'speed2', overrides, () => (Math.sqrt((0.804672 - s2) / 0.00804672) * -1 + 10) * 10);
  return (rs + s2Score) / 2;
}
export function calcFlex(pike: number, bb: number, str: number, overrides?: TestOverrides): number {
  // Pike/backbend are entered on a 0-10 scale (see FIELD_LIMITS); clamp
  // here too so a stray out-of-range value (an old 0-100 entry, a typo)
  // can't inflate the score past what a perfect 10 would give.
  const pikeScore = slotScore(pike, 'pike', overrides, () => Math.max(0, Math.min(10, pike)) * 10);
  const bbScore = slotScore(bb, 'backbend', overrides, () => Math.max(0, Math.min(10, bb)) * 10);
  const strScore = slotScore(str, 'straddle', overrides, () => str < 80 ? 0 : str > 180 ? 100 : str - 80);
  return (pikeScore + bbScore + strScore) / 3;
}

export interface OmniTotals {
  H: number; K: number; N: number; Q: number; U: number;
  raw: number; exact: number; lvl: number; xpPct: number;
}

export function computeOmni(i: AssessmentInputs, overrides?: TestOverrides): OmniTotals {
  const H = calcStrength(num(i.deadlift), num(i.squat), num(i.bench), num(i.pullup1rm), overrides);
  const K = calcPower(num(i.longjump), num(i.sprint), overrides);
  const N = calcEndurance(num(i.pushups), num(i.pullups), overrides);
  const Q = calcCardio(num(i.run30), num(i.speed2), overrides);
  const U = calcFlex(num(i.pike), num(i.backbend), num(i.straddle), overrides);
  const raw = H + K + N + Q + U;
  const exact = Math.pow(raw / 1000, 2) * 1000;
  const lvl = isFinite(exact) ? Math.floor(exact) : 0;
  const xpPct = isFinite(exact) ? (exact - lvl) * 100 : 0;
  return { H, K, N, Q, U, raw, exact, lvl, xpPct };
}

// Rank thresholds are sex-specific.
//
// The scoring formula itself is unchanged — a level means the same thing
// for everyone. What differs is where the rank floors sit on that scale,
// which is why this is a threshold table rather than a second formula.
//
// Order matters: highest floor first, so the first match wins.
export const RANK_THRESHOLDS: Record<Sex, Array<{ floor: number; rank: OmniRank }>> = {
  male: [
    { floor: 100, rank: 'S-RANK' },
    { floor: 80, rank: 'A-RANK' },
    { floor: 60, rank: 'B-RANK' },
    { floor: 40, rank: 'C-RANK' },
    { floor: 20, rank: 'D-RANK' },
    { floor: 0, rank: 'UNRANKED' }
  ],
  female: [
    { floor: 80, rank: 'S-RANK' },
    { floor: 60, rank: 'A-RANK' },
    { floor: 45, rank: 'B-RANK' },
    { floor: 30, rank: 'C-RANK' },
    { floor: 15, rank: 'D-RANK' },
    { floor: 0, rank: 'UNRANKED' }
  ]
};

// Defaults to male everywhere it is optional. Nothing in the existing data
// carries a sex, and back-filling every document would be a migration whose
// only effect is to write the value this default already produces — so an
// absent field simply means male, and only the records that are actually
// female ever need touching.
export function getOmniRank(level: number, sex: Sex = 'male'): OmniRank {
  if (!(typeof level === 'number' && isFinite(level))) return 'UNRANKED';
  const table = RANK_THRESHOLDS[sex] ?? RANK_THRESHOLDS['male'];
  return (table.find(t => level >= t.floor) ?? table[table.length - 1]).rank;
}

// The floor of the band `level` sits in, and the floor of the next band up.
// Shared by the colour ramp so a colour boundary can never drift away from
// the rank boundary it is meant to mark.
export function rankBandBounds(level: number, sex: Sex = 'male'): { floor: number; ceil: number } {
  const table = RANK_THRESHOLDS[sex] ?? RANK_THRESHOLDS['male'];
  const ascending = [...table].sort((a, b) => a.floor - b.floor);
  const idx = Math.max(0, ascending.findIndex(t => level < t.floor) - 1);
  const at = level >= ascending[ascending.length - 1].floor ? ascending.length - 1 : idx;
  const floor = ascending[at].floor;
  const next = ascending[at + 1];
  // Top band has no next floor; treat it as a single point so the ramp
  // resolves to its end colour rather than dividing by zero.
  return { floor, ceil: next ? next.floor - 1 : floor };
}

// Splits 'D-RANK' into a big glyph ('D') + tiny caption ('RANK') for the
// rank badge display. UNRANKED has no letter to show, so an em dash stands
// in as the glyph instead of leaving it blank.
export function rankLetter(rank: OmniRank): string {
  return rank === 'UNRANKED' ? '—' : rank.split('-')[0];
}

export function rankLabel(rank: OmniRank): string {
  return rank === 'UNRANKED' ? 'UNRANKED' : 'RANK';
}

// Level → color, mirrored from the assessments page's own rank-band ramp
// (kept in sync by hand rather than imported from there, since that file's
// version is a private method tied to its own panel-scoped color-mixing
// state). One distinct hue per rank tier — grey/green/sky-blue/purple/
// amber-red/white — rather than a continuous sweep, so a rank-up always
// reads as an unmistakable color jump; shading only blends *within* a band.
// Level 99 lands exactly on blood red, the last color before S-RANK's white.
// Keyed by RANK, not by level range. The floors now come from
// RANK_THRESHOLDS above, because they differ by sex — a colour boundary
// that drifted away from the rank boundary it marks would be worse than no
// colour at all.
const RANK_SHADES: Record<OmniRank, { light: string; dark: string }> = {
  'UNRANKED': { light: '#737373', dark: '#404040' },  // neutral grey (no blue tint)
  'D-RANK':   { light: '#4ade80', dark: '#15803d' },  // green
  'C-RANK':   { light: '#38bdf8', dark: '#0369a1' },  // sky blue
  'B-RANK':   { light: '#c084fc', dark: '#6b21a8' },  // purple
  'A-RANK':   { light: '#d9695f', dark: '#c1121f' },  // washed red heating to blood red
  'S-RANK':   { light: '#ffffff', dark: '#ffffff' }   // pure white
};

// Toggle to flip the within-band direction for every rank at once. true
// (current): climbs light -> dark as level rises within a rank — a deeper,
// more saturated shade the closer you are to the next rank-up. Mirrors how
// A-RANK always worked (amber -> blood red). false: the previous dark ->
// light climb. Kept as a single flag specifically so this is a one-line
// revert if the darker-as-you-climb look doesn't stick. Must match the same
// flag in assessments.page.ts so both screens agree on a given level's color.
const DARKEN_AS_LEVEL_CLIMBS = true;

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const mix = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return '#' + [mix(0), mix(1), mix(2)].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function levelColor(level: number, sex: Sex = 'male'): string {
  const lvl = Math.max(0, Math.min(100, level));
  const shade = RANK_SHADES[getOmniRank(lvl, sex)];
  const { floor, ceil } = rankBandBounds(lvl, sex);
  const span = ceil - floor;
  const t = span > 0 ? (lvl - floor) / span : 1;
  const [start, end] = DARKEN_AS_LEVEL_CLIMBS ? [shade.light, shade.dark] : [shade.dark, shade.light];
  return lerpHex(start, end, t);
}

// Card background per rank — deliberately NOT derived from levelColor()
// above. Mixing the bright badge/graph color straight into a card's
// background blows the lightness way past "dark" (a vivid mid-blue or
// mid-green card, not a moody dark one) and it wanders per-level as a bonus
// bug. These are hand-picked instead: same hue family as the rank, held at
// a constant low lightness across the whole rank rather than shifting with
// level — the vibrant badge/graph/border already carries the "climbing
// within a rank" feeling, so the backdrop can stay calm. Mirrored from
// Project-000's level-color.util.ts so both apps land on the same anchors.
interface RankBgAnchor { floor: number; ceil: number; bg: string; }

const RANK_BG: Record<OmniRank, string> = {
  'UNRANKED': '#070809',  // neutral, barely tinted
  'D-RANK':   '#030c07',  // dark green
  'C-RANK':   '#03090c',  // dark blue
  'B-RANK':   '#08030c',  // dark purple
  'A-RANK':   '#0c0304',  // dark blood red
  'S-RANK':   '#0a0a0a'   // neutral dark
};

export function levelBgColor(level: number, sex: Sex = 'male'): string {
  return RANK_BG[getOmniRank(Math.max(0, Math.min(100, level)), sex)];
}

// Per-test display metadata for the "highest level impact" recommendations
// and the recent-activity headline — shared so both features describe tests
// the same way (label/unit/decimals for display, step/min/max for the
// opportunity search).
export const ASSESSMENT_META = [
  { key: 'deadlift', label: 'Deadlift', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'squat', label: 'Squat', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'bench', label: 'Bench', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'pullup1rm', label: 'Pull-up 1RM', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'longjump', label: 'Long Jump', unit: 'in', step: 3, min: 0, max: 300, decimals: 0 },
  { key: 'sprint', label: '100m Sprint', unit: 'sec', step: 0.1, min: 0, max: 60, decimals: 2 },
  { key: 'pushups', label: 'Pushups', unit: 'reps', step: 5, min: 0, max: 1000, decimals: 0 },
  { key: 'pullups', label: 'Pull-ups', unit: 'reps', step: 3, min: 0, max: 1000, decimals: 0 },
  { key: 'run30', label: '30 Min Run', unit: 'km', step: 0.32, min: 0, max: 50, decimals: 2 },
  { key: 'speed2', label: '2 Min Speed', unit: 'km', step: 0.016, min: 0, max: 0.805, decimals: 3 },
  { key: 'pike', label: 'Pike', unit: '', step: 1, min: 0, max: 10, decimals: 0 },
  { key: 'backbend', label: 'Backbend', unit: '', step: 1, min: 0, max: 10, decimals: 0 },
  { key: 'straddle', label: 'Straddle', unit: 'deg', step: 10, min: 0, max: 180, decimals: 0 }
] as const;

export interface AssessmentChange {
  text: string;         // "100m Sprint 13.86 → 13.50 sec (+12.5%)"
  pct: number | null;   // null when `fallback` was used (no prior, or nothing scorable changed)
}

// Compares two assessments' raw inputs and describes whichever single test
// moved the OMNI score the most, e.g. "100m Sprint 13.86 → 13.50 sec
// (+2.5%)" — the trial-substitution technique already used by the "highest
// level impact" panel, run against the actual old→new step instead of a
// hypothetical one, so direction (lower-is-better tests included) always
// comes out right. Falls back to `fallback` when there's no prior assessment
// to diff against or nothing scorable changed (e.g. only bodyWeight/height).
export function describeAssessmentChange(
  prev: AssessmentInputs | null, curr: AssessmentInputs, fallback = 'New Assessment'
): AssessmentChange {
  if (!prev) return { text: fallback, pct: null };

  const currTotals = computeOmni(curr);
  let best: { label: string; unit: string; decimals: number; oldVal: number; newVal: number; gain: number; pct: number } | null = null;

  for (const meta of ASSESSMENT_META) {
    const oldVal = num(prev[meta.key]);
    const newVal = num(curr[meta.key]);
    if (Math.abs(newVal - oldVal) < 1e-9) continue;

    const trial = { ...curr, [meta.key]: oldVal };
    const trialExact = computeOmni(trial).exact;
    const gain = currTotals.exact - trialExact;
    const base = Math.abs(trialExact) > 1e-9 ? trialExact : currTotals.exact;
    const pct = base !== 0 ? (gain / Math.abs(base)) * 100 : 0;

    if (!best || Math.abs(gain) > Math.abs(best.gain)) {
      best = { label: meta.label, unit: meta.unit, decimals: meta.decimals, oldVal, newVal, gain, pct };
    }
  }

  if (!best) return { text: fallback, pct: null };
  const unitSuffix = best.unit ? ` ${best.unit}` : '';
  const sign = best.pct > 0 ? '+' : best.pct < 0 ? '' : '±';
  const text = `${best.label} ${best.oldVal.toFixed(best.decimals)} → ${best.newVal.toFixed(best.decimals)}${unitSuffix} (${sign}${best.pct.toFixed(1)}%)`;
  return { text, pct: best.pct };
}

// Shared green/red/neutral convention for any "did this improve" delta.
export function deltaColor(diff: number): string {
  return diff > 0 ? '#2dd36f' : diff < 0 ? '#ff5a6a' : '#4a6378';
}

export function blankAssessmentInputs(): AssessmentInputs {
  return {
    bodyWeight: 0, height: 0,
    deadlift: 0, deadliftWeight: 0, deadliftReps: 1,
    squat: 0, squatWeight: 0, squatReps: 1,
    bench: 0, benchWeight: 0, benchReps: 1,
    pullup1rm: 0, pullup1rmWeight: 0, pullup1rmReps: 1,
    longjump: 0, sprint: 0, pushups: 0, pullups: 0,
    run30: 0, speed2: 0, pike: 0, backbend: 0, straddle: 0
  };
}

// ---------------------------------------------------------------------
// Cardio distance <-> speed conversions. The two timed-distance tests
// (30 Min Run, 2 Min Speed) are stored and scored as raw km — see
// calcCardio — but a coach thinks in mph (or pace), not "how many
// kilometers did they cover in exactly 2 minutes." These let the UI show
// whichever unit is picked while the canonical stored value stays km.
export type SpeedUnit = 'mph' | 'km' | 'minkm';

const KM_TO_MILES = 0.621371;

// mph = km covered in the window, scaled up to a full hour, converted to
// miles. windowMinutes is 30 for the 30-minute run, 2 for the 2-minute
// speed test.
function kmToMph(km: number, windowMinutes: number): number {
  return km * (60 / windowMinutes) * KM_TO_MILES;
}
function mphToKm(mph: number, windowMinutes: number): number {
  return mph / (60 / windowMinutes) / KM_TO_MILES;
}
// Pace: minutes per km, extrapolated from how much of a km they covered
// in the window (e.g. covered 0.5km in 2 minutes -> 4 min/km pace).
function kmToMinPerKm(km: number, windowMinutes: number): number {
  return km > 0 ? windowMinutes / km : 0;
}
function minPerKmToKm(pace: number, windowMinutes: number): number {
  return pace > 0 ? windowMinutes / pace : 0;
}

// Canonical km -> whatever unit is currently displayed.
export function kmToSpeedDisplay(km: number, unit: SpeedUnit, windowMinutes: number): number {
  if (!isFinite(km) || km < 0) return 0;
  switch (unit) {
    case 'mph': return kmToMph(km, windowMinutes);
    case 'minkm': return kmToMinPerKm(km, windowMinutes);
    default: return km;
  }
}

// Whatever's typed in the display field -> canonical km, for storage/scoring.
export function speedDisplayToKm(value: number, unit: SpeedUnit, windowMinutes: number): number {
  if (!isFinite(value) || value < 0) return 0;
  switch (unit) {
    case 'mph': return mphToKm(value, windowMinutes);
    case 'minkm': return minPerKmToKm(value, windowMinutes);
    default: return value;
  }
}
