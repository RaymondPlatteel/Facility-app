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

const NOT_A_LIFT = ['adduction', 'abduction', 'jump', 'hop', 'sprint', 'rotation', 'raise', 'bridge'];

// Returns the matching benchmark lift for an exercise name, or null.
export function matchAssessmentLift(name: string): AssessmentLift | null {
  const n = (name || '').trim().toLowerCase();
  if (!n) return null;
  // movements that merely share a word with a lift ("Bench Adduction", "Bench Jump") are never that lift
  if (NOT_A_LIFT.some(x => n.includes(x))) return null;
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
// existing input — only its name and formula constants change, so the swap
// can't touch anything about how a raw value is entered or which category
// it counts toward.
//
// An override always keeps the SAME formula *shape* as the slot it's
// replacing — a ratio-type slot (the four strength lifts, long jump) stays
// a ratio; a curve-type slot (sprint, 30 Min Run, 2 Min Speed — the
// time-based tests, all lower-raw-is-better) stays the same sqrt decay
// curve calcPower/calcCardio use. What the coach can edit is every real
// constant in that formula — not just the "world record," but (for
// curve-type slots) the spread constant that controls how fast the score
// falls off past the record too. Everything else (flexibility, the plain
// clamp/range tests) keeps its original, un-overridden formula unless a
// coach overrides it — a straight ratio is the fallback there since none
// of those are expected to actually get swapped.
export type TestKey = keyof AssessmentInputs;

export interface TestOverride {
  name: string;         // custom test name, e.g. "Trap Bar Deadlift"
  worldRecord: number;  // replaces that slot's built-in reference value
  // Curve-type slots only (isCurveTest(key) === true) — replaces the
  // built-in spread constant (the sqrt's denominator). Ignored for
  // ratio-type slots.
  spread?: number;
}

export type TestOverrides = Partial<Record<TestKey, TestOverride>>;

const LOWER_IS_BETTER: ReadonlySet<TestKey> = new Set<TestKey>(['sprint']);

// Exposed so the Assessments page can show the coach the exact formula
// (and a live preview score) while they're picking new constants for a
// replacement test — same direction check the scoring itself uses.
export function isLowerIsBetterTest(key: TestKey): boolean {
  return LOWER_IS_BETTER.has(key);
}

// The three time-based tests, each scored by the same sqrt decay curve:
//   score = (10 − √((raw − record) / spread)) × 10
// `record` and `spread` here are the slot's real, current built-in
// constants — the override sheet pre-fills a coach's edit with these
// exact numbers rather than starting blank. (30 Min Run's built-in
// formula has a second, legacy linear-ratio branch for slow times; an
// override always uses the curve branch only, since a coach replacing
// this test is supplying their own real numbers regardless.)
export const CURVE_TEST_DEFAULTS: Partial<Record<TestKey, { record: number; spread: number }>> = {
  sprint: { record: 10, spread: 0.125 },
  run30: { record: 11.265408, spread: 0.11265408 },
  speed2: { record: 0.804672, spread: 0.00804672 },
};

export function isCurveTest(key: TestKey): boolean {
  return key in CURVE_TEST_DEFAULTS;
}

// Pull-up 1RM's record. Was 500 lb until the test moved to chin over the
// bar (stricter technique), which costs everyone roughly 10 lb. 484 keeps
// the 999 group's scores where they were across the switch — Abram
// 309 -> 299, Roy 302 -> 292, Raymond 299 -> 289 each move by under a
// tenth of a point.
export const PULLUP_1RM_RECORD = 484;

// Ratio-type slots' real, current built-in "world record" constants —
// same pre-fill purpose as CURVE_TEST_DEFAULTS above.
export const RATIO_TEST_DEFAULTS: Partial<Record<TestKey, number>> = {
  deadlift: 939, squat: 800, bench: 600, pullup1rm: PULLUP_1RM_RECORD, longjump: 147,
};

export function overrideScore(raw: number, worldRecord: number, key: TestKey, spread?: number): number {
  if (!worldRecord) return 0;
  if (isCurveTest(key)) {
    const sp = spread || CURVE_TEST_DEFAULTS[key]!.spread;
    if (!sp) return 0;
    const x = (raw - worldRecord) / sp;
    if (x < 0) return 100; // better than the record — clamp instead of the sqrt going complex
    const pct = (Math.sqrt(x) * -1 + 10) * 10;
    return isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
  }
  const pct = LOWER_IS_BETTER.has(key) ? (worldRecord / (raw || Infinity)) * 100 : (raw / worldRecord) * 100;
  return isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}

// Runs a slot's normal (un-overridden) scoring unless `overrides` has an
// entry for it, in which case that entry's constants drive the same-shape
// formula instead. `fallback` is the slot's usual formula contribution
// (e.g. `dl / 939 * 100`) — passed as a thunk so it's only evaluated when
// actually needed.
function slotScore(raw: number, key: TestKey, overrides: TestOverrides | undefined, fallback: () => number): number {
  const ov = overrides?.[key];
  return ov ? overrideScore(raw, ov.worldRecord, key, ov.spread) : fallback();
}

export function calcStrength(dl: number, sq: number, bn: number, pu: number, overrides?: TestOverrides): number {
  const dlScore = slotScore(dl, 'deadlift', overrides, () => dl / 939 * 100);
  const sqScore = slotScore(sq, 'squat', overrides, () => sq / 800 * 100);
  const bnScore = slotScore(bn, 'bench', overrides, () => bn / 600 * 100);
  const puScore = slotScore(pu, 'pullup1rm', overrides, () => pu / PULLUP_1RM_RECORD * 100);
  return (dlScore + sqScore + bnScore + puScore) / 4;
}
export function calcPower(lj: number, sp: number, overrides?: TestOverrides): number {
  const ljScore = slotScore(lj, 'longjump', overrides, () => lj / 147 * 100);
  const spScore = slotScore(sp, 'sprint', overrides, () => (Math.sqrt((sp - 10) / 0.125) * -1 + 10) * 10);
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

// Each rank's band is split in four: A (80-99) is AI, AII, AIII, AIV. S and Unranked have no tiers.
const TIERS = ['I', 'II', 'III', 'IV'];
export function tierNumeral(level: number, rank: OmniRank, sex: Sex = 'male'): string {
  if (rank === 'S-RANK' || rank === 'UNRANKED' || !isFinite(level)) return '';
  const { floor, ceil } = rankBandBounds(level, sex);
  const span = ceil - floor;
  if (span <= 0) return '';
  return TIERS[Math.max(0, Math.min(3, Math.floor(((level - floor) / span) * 4)))];
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

// ---------- Per-category ranks (display only) ----------
//
// Mirrored from Project-000's omni.util.ts — the athlete and the coach must
// never read a different rank off the same assessment.
//
// The five category scores are not comparable to each other, and none is
// comparable to the overall level, so they cannot share RANK_THRESHOLDS.
// Each table is built from two anchors instead of hand-written floors.
//
// Nothing here feeds computeOmni. A category rank never moves the overall
// level or rank — a gym bro can hold C-RANK strength while every other
// category, and his overall rank, stay UNRANKED.
export type OmniCategory = 'strength' | 'power' | 'endurance' | 'cardio' | 'flexibility';

// Anchor 1, the bottom: what someone who has never trained actually scores,
// which is where this category's ladder starts. Everything below is
// UNRANKED. These differ wildly because each formula's free baseline does:
// an untrained person already banks ~40 power (long jump is scored against
// 147", so even an unathletic 80" jump fills half the formula) and ~32
// flexibility (pike 4 / backbend 3 / straddle 110° is an average desk
// worker), but only ~10 endurance, since 150 pushups and 49 pull-ups define
// that formula's 100.
//
// Female floors carry the same ~0.75 discount RANK_THRESHOLDS applies to
// the overall table — except flexibility, held at parity deliberately. The
// discount corrects for a gap that runs the other way on pike/backbend/
// straddle, so applying it there would make S-RANK close to automatic.
const CATEGORY_FLOOR: Record<OmniCategory, { male: number; female: number }> = {
  strength:    { male: 18, female: 13.5 },
  power:       { male: 40, female: 30 },
  endurance:   { male: 10, female: 7.5 },
  // Raised twice from the original 18 / 13.5 — cardio was ranking people
  // about one full rank above where they belong. This and the S floor below
  // move together, shifting the whole ladder up roughly one rank.
  cardio:      { male: 31, female: 26 },
  flexibility: { male: 32, female: 32 }
};

// Anchor 2, the top: S-RANK in a category means "this category is pulling
// its weight for an S-RANK athlete" — NOT "world record". Derived as the
// score which, held in every category, lands exactly on the overall S-RANK
// threshold: computeOmni squares the five-category sum, so level L needs
// raw = sqrt(L / 1000) * 1000, split five ways — 63.2 for men (level 100),
// 56.6 for women (level 80). Clear it in one category and that category is
// doing S-RANK work, whatever the other four are doing.
//
// Two categories opt out with a fixed, higher floor. Both for the same
// reason — the derived number assumes the five categories span comparable
// ranges, and these two don't:
//
//   flexibility, because the derived floor is trivially cleared by someone
//     who simply stretches, and the bar there is meant to be high.
//   power, because its whole real range is compressed. Long jump is scored
//     against 147", which hands out ~50 for a mediocre jump, so the entire
//     roster lands between 39 and 66 — the derived 63.2 sat *inside* the
//     normal spread and three athletes cleared it on good-but-not-elite
//     numbers. 68 puts it back above them; reaching it takes roughly a 125"
//     jump paired with a 12.5s sprint.
//
// Checked against the real roster: in strength and endurance the best
// score on file is still 10+ short of the derived floor, so those two need
// no override. Cardio's is a deliberate tightening, not a fix.
// Power's female floor is the same ~7.5% lift over the derived number that
// 68 is for men, because the reason for the override (a compressed range)
// applies to both — unlike flexibility, which stays at parity on purpose.
// No female power scores on file to calibrate against, so this is a
// proportional mirror rather than a measured floor.
const CATEGORY_S_FLOOR_OVERRIDE: Partial<Record<OmniCategory, { male: number; female: number }>> = {
  power: { male: 70, female: 63 },
  // Well over the derived 63.2 / 56.6 — see cardio's floor above. Moved
  // with it so the ladder shifts up rather than squeezes.
  cardio: { male: 78, female: 71 },
  flexibility: { male: 82, female: 82 }
};

function evenSFloor(sex: Sex): number {
  const sLevel = (RANK_THRESHOLDS[sex] ?? RANK_THRESHOLDS['male'])[0].floor;
  return (Math.sqrt(sLevel / 1000) * 1000) / 5;
}

// C, B and A split the gap between the two anchors evenly. Highest floor
// first, so the first match wins — same convention as RANK_THRESHOLDS.
export function evenLadder(d: number, s: number): Array<{ floor: number; rank: OmniRank }> {
  const step = (s - d) / 4;
  return [
    { floor: s, rank: 'S-RANK' },
    { floor: d + step * 3, rank: 'A-RANK' },
    { floor: d + step * 2, rank: 'B-RANK' },
    { floor: d + step, rank: 'C-RANK' },
    { floor: d, rank: 'D-RANK' },
    { floor: 0, rank: 'UNRANKED' }
  ];
}

export function categoryRankThresholds(cat: OmniCategory, sex: Sex = 'male'): Array<{ floor: number; rank: OmniRank }> {
  const key = sex === 'female' ? 'female' : 'male';
  const d = CATEGORY_FLOOR[cat][key];
  const s = CATEGORY_S_FLOOR_OVERRIDE[cat]?.[key] ?? evenSFloor(sex);
  return evenLadder(d, s);
}

export function rankOnLadder(table: Array<{ floor: number; rank: OmniRank }>, score: number): OmniRank {
  if (!(typeof score === 'number' && isFinite(score))) return 'UNRANKED';
  return (table.find(t => score >= t.floor) ?? table[table.length - 1]).rank;
}

// The band `score` sits in on `table`, for the within-band colour blend.
export function ladderBand(table: Array<{ floor: number; rank: OmniRank }>, score: number): { floor: number; ceil: number } {
  const ascending = [...table].sort((a, b) => a.floor - b.floor);
  const top = ascending[ascending.length - 1];
  const idx = Math.max(0, ascending.findIndex(t => score < t.floor) - 1);
  const at = score >= top.floor ? ascending.length - 1 : idx;
  const next = ascending[at + 1];
  return { floor: ascending[at].floor, ceil: next ? next.floor : ascending[at].floor };
}

export function getCategoryRank(cat: OmniCategory, score: number, sex: Sex = 'male'): OmniRank {
  return rankOnLadder(categoryRankThresholds(cat, sex), score);
}

export function categoryRankBandBounds(cat: OmniCategory, score: number, sex: Sex = 'male'): { floor: number; ceil: number } {
  return ladderBand(categoryRankThresholds(cat, sex), score);
}

// Progress through the CURRENT rank band — how close this category is to
// the next rank up, not its position on the whole ladder. Returns 0 at
// S-RANK, which has no band above it; callers hide the bar entirely there
// rather than drawing an empty or permanently-full one.
export function categoryRankPct(cat: OmniCategory, score: number, sex: Sex = 'male'): number {
  const { floor, ceil } = categoryRankBandBounds(cat, score, sex);
  const span = ceil - floor;
  if (!(span > 0) || !isFinite(score)) return 0;
  return Math.min(Math.max(((score - floor) / span) * 100, 0), 100);
}

// Same rank shades and within-band ramp as levelColor/levelBgColor, driven
// by a category's own thresholds. S-RANK's static value is only a fallback —
// a caller that can reach the chroma ramp paints it live instead.
export function categoryColor(cat: OmniCategory, score: number, sex: Sex = 'male'): string {
  return ladderColor(categoryRankThresholds(cat, sex), score);
}

// Rank shade + within-band ramp on any D..S ladder.
export function ladderColor(table: Array<{ floor: number; rank: OmniRank }>, score: number): string {
  const shade = RANK_SHADES[rankOnLadder(table, score)];
  const { floor, ceil } = ladderBand(table, score);
  const span = ceil - floor;
  const t = span > 0 ? Math.min(Math.max((score - floor) / span, 0), 1) : 1;
  const [start, end] = DARKEN_AS_LEVEL_CLIMBS ? [shade.light, shade.dark] : [shade.dark, shade.light];
  return lerpHex(start, end, t);
}

export function categoryBgColor(cat: OmniCategory, score: number, sex: Sex = 'male'): string {
  return RANK_BG[getCategoryRank(cat, score, sex)];
}

// ---------- Per-test ranks ----------
// Every category score is the plain average of its tests' own 0-100
// contributions, so a single test's contribution sits on the same scale as
// the category itself. Ranking it against that category's (adjusted) ladder
// means a test reads B-RANK exactly when, were every test in the category
// that good, the category would be B-RANK too — and Project 000's copy of
// this map ranks it identically.
export type ScoredTestKey =
  'deadlift' | 'squat' | 'bench' | 'pullup1rm' | 'longjump' | 'sprint' | 'pushups' |
  'pullups' | 'run30' | 'speed2' | 'pike' | 'backbend' | 'straddle';

export const TEST_CATEGORY: Record<ScoredTestKey, OmniCategory> = {
  deadlift: 'strength', squat: 'strength', bench: 'strength', pullup1rm: 'strength',
  longjump: 'power', sprint: 'power',
  pushups: 'endurance', pullups: 'endurance',
  run30: 'cardio', speed2: 'cardio',
  pike: 'flexibility', backbend: 'flexibility', straddle: 'flexibility'
};

// One test's contribution to its category score — the same per-slot terms
// calcStrength/calcPower/... average, overrides included. NaN (a sprint or
// run left blank lands the sqrt below zero) ranks as UNRANKED downstream.
export function testScore(key: ScoredTestKey, i: AssessmentInputs, overrides?: TestOverrides): number {
  const v = num(i[key]);
  switch (key) {
    case 'deadlift': return slotScore(v, key, overrides, () => v / 939 * 100);
    case 'squat': return slotScore(v, key, overrides, () => v / 800 * 100);
    case 'bench': return slotScore(v, key, overrides, () => v / 600 * 100);
    case 'pullup1rm': return slotScore(v, key, overrides, () => v / PULLUP_1RM_RECORD * 100);
    case 'longjump': return slotScore(v, key, overrides, () => v / 147 * 100);
    case 'sprint': return slotScore(v, key, overrides, () => (Math.sqrt((v - 10) / 0.125) * -1 + 10) * 10);
    case 'pushups': return slotScore(v, key, overrides, () => (v / 150) * 100);
    case 'pullups': return slotScore(v, key, overrides, () => (v / 49) * 100);
    case 'run30': return slotScore(v, key, overrides, () => v < 4.02336
      ? (Math.sqrt((11.265408 - v) / 0.11265408) * -1 + 10) * 10
      : v / 11.265408 * 100);
    case 'speed2': return slotScore(v, key, overrides, () => (Math.sqrt((0.804672 - v) / 0.00804672) * -1 + 10) * 10);
    case 'pike': return slotScore(v, key, overrides, () => Math.max(0, Math.min(10, v)) * 10);
    case 'backbend': return slotScore(v, key, overrides, () => Math.max(0, Math.min(10, v)) * 10);
    case 'straddle': return slotScore(v, key, overrides, () => v < 80 ? 0 : v > 180 ? 100 : v - 80);
  }
}

// Tests the coaches have pinned to real-world numbers get their own
// anchors, still split evenly into D..S.
//
// Long jump, because its contribution runs too hot on the power ladder:
// it's scored against a 147" world record, so a 5-foot jump by an obese
// beginner already banks ~41 — enough for D on the power ladder, which was
// calibrated on the *average* of long jump and the far stingier sprint.
// Anchored in inches instead: D at 6 ft, then 14" per rank — C 86",
// B 100", A 114" (9'6"), S 128" (10'8"). Calibrated so Abram (119") and
// Raymond (117.5") both land low in A-RANK, which is where the coaches
// agreed they belong. Female mirrors it 1.5 ft lower, the same kind of
// proportional discount the category tables use.
//
// Bench, because the coaches set S-RANK at a 365 lb 1RM. D stays where the
// strength ladder already put it (18 → 108 lb) and C/B/A split the gap:
// C 172, B 237, A 301, S 365. Female keeps the strength ladder's own D
// (13.5 → 81 lb) and scales S by the same ratio the category tables use
// between the sexes (56.6 / 63.2), landing at 326 lb.
//
// Pull-up 1RM, because on the plain strength ladder it ranked people a full
// rank above where they belong. Same ladder moved up exactly one rank — D
// sits where C was, and so on, with S one step past the old S. In total
// load (bodyweight + added, scored against PULLUP_1RM_RECORD): D 142,
// C 197, B 251, A 306, S 361 lb for men; D 117, C 170, B 222, A 274,
// S 326 lb for women.
// Derived rather than typed in, so it keeps following the strength ladder.
function oneRankStricter(cat: OmniCategory, sex: Sex): { d: number; s: number } {
  const key = sex === 'female' ? 'female' : 'male';
  const d = CATEGORY_FLOOR[cat][key];
  const s = CATEGORY_S_FLOOR_OVERRIDE[cat]?.[key] ?? evenSFloor(sex);
  const step = (s - d) / 4;
  return { d: d + step, s: s + step };
}

const INCHES_TO_LJ_SCORE = 100 / 147;
const LBS_TO_BENCH_SCORE = 100 / 600;
const TEST_LADDER_OVERRIDE: Partial<Record<ScoredTestKey, { male: { d: number; s: number }; female: { d: number; s: number } }>> = {
  longjump: {
    male: { d: 72 * INCHES_TO_LJ_SCORE, s: 128 * INCHES_TO_LJ_SCORE },
    female: { d: 54 * INCHES_TO_LJ_SCORE, s: 110 * INCHES_TO_LJ_SCORE }
  },
  bench: {
    male: { d: 18, s: 365 * LBS_TO_BENCH_SCORE },
    female: { d: 13.5, s: 326 * LBS_TO_BENCH_SCORE }
  },
  pullup1rm: {
    male: oneRankStricter('strength', 'male'),
    female: oneRankStricter('strength', 'female')
  }
};

// A coach-replaced test is scored against its own record, so the feet-based
// anchors above no longer mean anything for it — it falls back to the
// category ladder.
export function testRankThresholds(key: ScoredTestKey, sex: Sex = 'male', overrides?: TestOverrides): Array<{ floor: number; rank: OmniRank }> {
  const own = overrides?.[key] ? undefined : TEST_LADDER_OVERRIDE[key];
  if (own) {
    const a = own[sex === 'female' ? 'female' : 'male'];
    return evenLadder(a.d, a.s);
  }
  return categoryRankThresholds(TEST_CATEGORY[key], sex);
}

export function getTestRank(key: ScoredTestKey, i: AssessmentInputs, sex: Sex = 'male', overrides?: TestOverrides): OmniRank {
  return rankOnLadder(testRankThresholds(key, sex, overrides), testScore(key, i, overrides));
}

// Static colour for a test's rank; S-RANK callers swap in the live chroma.
export function testColor(key: ScoredTestKey, i: AssessmentInputs, sex: Sex = 'male', overrides?: TestOverrides): string {
  const score = testScore(key, i, overrides);
  return ladderColor(testRankThresholds(key, sex, overrides), isFinite(score) ? score : 0);
}

// Card ground for a test's rank — same per-rank darks the category cards use.
export function testBgColor(key: ScoredTestKey, i: AssessmentInputs, sex: Sex = 'male', overrides?: TestOverrides): string {
  return RANK_BG[getTestRank(key, i, sex, overrides)];
}

export function isCategorySRank(cat: OmniCategory, score: number, sex: Sex = 'male'): boolean {
  return getCategoryRank(cat, score, sex) === 'S-RANK';
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

// ---------- Resilience ----------
//
// Ten joint-resilience exercises, tracked separately from the OMPAR
// assessment and NOT part of computeOmni — nothing here moves the Level.
//
// Every one is performed as sets of 8 reps, always, so the rep count is a
// constant rather than a field: only the resistance is worth recording.
// Scoring each lift against a per-exercise max is not built yet.
export type ResilienceKey =
  | 'calfRaises' | 'tibialisRaises' | 'hipFlexorGluteBridge' | 'abduction'
  | 'benchAdduction' | 'cubanRotation' | 'supineInternalRotation'
  | 'proneAroundTheWorlds' | 'wristExtensions' | 'radialDeviations';

export const RESILIENCE_REPS = 8;

// `max` is the resistance that scores 100 on that exercise — a *sets of 8*
// reference, not a 1RM, which is why several look low next to a gym PR.
//
// Two of these movements are the facility's own inventions with no outside
// standard to point at (prone around the worlds, supine internal rotation),
// so their numbers come straight from the coach. `note` records the
// protocol wherever the load is meaningless without it.
export const RESILIENCE_TESTS: ReadonlyArray<{
  key: ResilienceKey; label: string; max: number; note?: string;
}> = [
  { key: 'calfRaises', label: 'Calf Raises', max: 300 },
  { key: 'tibialisRaises', label: 'Tibialis Raises', max: 175 },
  { key: 'hipFlexorGluteBridge', label: 'Hip Flexor Glute Bridge', max: 135 },
  { key: 'abduction', label: 'Abduction', max: 30 },
  { key: 'benchAdduction', label: 'Bench Adduction', max: 100 },
  { key: 'cubanRotation', label: 'Cuban Rotation', max: 50 },
  { key: 'supineInternalRotation', label: 'Supine Internal Rotation', max: 60 },
  { key: 'proneAroundTheWorlds', label: 'Prone Around the Worlds', max: 30 },
  { key: 'wristExtensions', label: 'Wrist Extensions', max: 115 },
  { key: 'radialDeviations', label: 'Radial Deviations', max: 30 }
];

// Per-exercise percentage of its own max, clamped — the same ratio shape
// calcStrength uses for the four lifts.
export function resilienceTestPct(key: ResilienceKey, weight: number): number {
  const test = RESILIENCE_TESTS.find(t => t.key === key);
  if (!test || !test.max) return 0;
  const pct = (num(weight) / test.max) * 100;
  return isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0;
}

// The battery's own score, 0-100: a flat average across all ten, so an
// exercise left blank counts as a zero. That is deliberate and matches how
// computeOmni treats an unrecorded test — a partial entry should read as
// incomplete rather than quietly scoring only what was filled in.
//
// Kept out of computeOmni on purpose: resilience is scored alongside the
// OMPAR categories, not inside them, so nothing here moves anyone's Level.
export function calcResilience(inputs: Partial<ResilienceInputs> | null | undefined): number {
  if (!inputs) return 0;
  const total = RESILIENCE_TESTS.reduce(
    (sum, t) => sum + resilienceTestPct(t.key, num(inputs[t.key])), 0);
  return total / RESILIENCE_TESTS.length;
}

// The four joints this battery is actually protecting. Every exercise
// belongs to exactly one, and the list above is already ordered by group.
//
// The groups are the point of the whole battery: an average across ten
// lifts hides a single wrecked joint, and a single wrecked joint is what
// gets someone hurt. Each group scores as the flat average of its own
// exercises, so a joint covered by two tests counts as much as one covered
// by three.
export type ResilienceGroupKey = 'ankleKnee' | 'kneeHip' | 'shoulder' | 'wrist';

export const RESILIENCE_GROUPS: ReadonlyArray<{
  key: ResilienceGroupKey; label: string; short: string; tests: ResilienceKey[];
}> = [
  { key: 'ankleKnee', label: 'Ankles / Knees', short: 'ANK', tests: ['calfRaises', 'tibialisRaises'] },
  { key: 'kneeHip', label: 'Knees / Hips', short: 'HIP', tests: ['hipFlexorGluteBridge', 'abduction', 'benchAdduction'] },
  { key: 'shoulder', label: 'Shoulders', short: 'SHD', tests: ['cubanRotation', 'supineInternalRotation', 'proneAroundTheWorlds'] },
  { key: 'wrist', label: 'Wrists', short: 'WRI', tests: ['wristExtensions', 'radialDeviations'] }
];

export function calcResilienceGroup(
  group: ResilienceGroupKey, inputs: Partial<ResilienceInputs> | null | undefined
): number {
  const g = RESILIENCE_GROUPS.find(x => x.key === group);
  if (!g || !inputs) return 0;
  const total = g.tests.reduce((sum, k) => sum + resilienceTestPct(k, num(inputs[k])), 0);
  return total / g.tests.length;
}

// Resilience gets its own, deliberately generous floors rather than sharing
// RANK_THRESHOLDS with the overall level.
//
// Accessory work is scored against loads almost nobody approaches — the
// whole battery averaging even 60% of its maxes is exceptional — so reusing
// the level's floors put a healthy, uninjured A-RANK athlete at D-RANK,
// which tells him nothing useful. Calibrated instead against a real entry:
// a coach scoring 28.7 who has never been hurt and still has room to
// improve reads as B-RANK, with A a genuine target rather than a formality.
//
// Female floors carry the same ~0.75 discount as the rest of the app, since
// every max here is an absolute load.
//
// The letter is what the training gate compares (A-RANK work wants A-RANK
// resilience behind it), so these floors decide how hard that gate bites.
export const RESILIENCE_RANK_THRESHOLDS: Record<Sex, Array<{ floor: number; rank: OmniRank }>> = {
  male: [
    { floor: 60, rank: 'S-RANK' },
    { floor: 40, rank: 'A-RANK' },
    { floor: 25, rank: 'B-RANK' },
    { floor: 16, rank: 'C-RANK' },
    { floor: 8, rank: 'D-RANK' },
    { floor: 0, rank: 'UNRANKED' }
  ],
  female: [
    { floor: 45, rank: 'S-RANK' },
    { floor: 30, rank: 'A-RANK' },
    { floor: 19, rank: 'B-RANK' },
    { floor: 12, rank: 'C-RANK' },
    { floor: 6, rank: 'D-RANK' },
    { floor: 0, rank: 'UNRANKED' }
  ]
};

export function getResilienceRank(score: number, sex: Sex = 'male'): OmniRank {
  if (!(typeof score === 'number' && isFinite(score))) return 'UNRANKED';
  const table = RESILIENCE_RANK_THRESHOLDS[sex] ?? RESILIENCE_RANK_THRESHOLDS['male'];
  return (table.find(t => score >= t.floor) ?? table[table.length - 1]).rank;
}

// Band bounds for the colour ramp, mirroring rankBandBounds.
export function resilienceRankBandBounds(score: number, sex: Sex = 'male'): { floor: number; ceil: number } {
  const table = RESILIENCE_RANK_THRESHOLDS[sex] ?? RESILIENCE_RANK_THRESHOLDS['male'];
  const ascending = [...table].sort((a, b) => a.floor - b.floor);
  const top = ascending[ascending.length - 1];
  const idx = Math.max(0, ascending.findIndex(t => score < t.floor) - 1);
  const at = score >= top.floor ? ascending.length - 1 : idx;
  const next = ascending[at + 1];
  return { floor: ascending[at].floor, ceil: next ? next.floor : ascending[at].floor };
}

// Colour for a resilience score — the same rank shades and within-band
// ramp levelColor uses, but walked along resilience's own ladder, so the
// colour can never disagree with the letter beside it.
export function resilienceColor(score: number, sex: Sex = 'male'): string {
  const shade = RANK_SHADES[getResilienceRank(score, sex)];
  const { floor, ceil } = resilienceRankBandBounds(score, sex);
  const span = ceil - floor;
  const t = span > 0 ? Math.min(Math.max((score - floor) / span, 0), 1) : 1;
  const [start, end] = DARKEN_AS_LEVEL_CLIMBS ? [shade.light, shade.dark] : [shade.dark, shade.light];
  return lerpHex(start, end, t);
}

// Card ground per resilience rank, from the same hand-picked anchors the
// level cards use — so the whole pane recolours with the rank.
export function resilienceBgColor(score: number, sex: Sex = 'male'): string {
  return RANK_BG[getResilienceRank(score, sex)];
}



export type ResilienceInputs = Record<ResilienceKey, number>;

export function blankResilienceInputs(): ResilienceInputs {
  return RESILIENCE_TESTS.reduce((acc, t) => {
    acc[t.key] = 0;
    return acc;
  }, {} as ResilienceInputs);
}
