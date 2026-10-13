import type { OmniRank } from '../services/firebase.service';
import type { AthleteState } from '../program-engine/types';

// ---------- Practice athletes ----------
//
//  A made-up athlete for the trainer: an overall rank drawn from a typical gym population, category ranks close to
//  it (flexibility wanders further, since it has little to do with the rest), test results that fit those ranks,
//  and a week of at least the overall rank's minimum days, usually in a common pattern.

export const RANKS: OmniRank[] = ['UNRANKED', 'D-RANK', 'C-RANK', 'B-RANK', 'A-RANK', 'S-RANK'];
export const RANK_SHORT: Record<OmniRank, string> = { 'UNRANKED': 'U', 'D-RANK': 'D', 'C-RANK': 'C', 'B-RANK': 'B', 'A-RANK': 'A', 'S-RANK': 'S' };
// The fewest training days a week for each overall rank, as in the athlete app's program setup.
export const MIN_DAYS: Record<OmniRank, number> = { 'UNRANKED': 1, 'D-RANK': 2, 'C-RANK': 3, 'B-RANK': 4, 'A-RANK': 5, 'S-RANK': 7 };

export interface PracticeAthlete {
  name: string;
  overall: OmniRank;
  state: AthleteState;
}

const NAMES = ['Jordan', 'Avery', 'Morgan', 'Riley', 'Casey', 'Taylor', 'Jamie', 'Quinn', 'Rowan', 'Skyler', 'Dakota', 'Reese',
  'Parker', 'Emerson', 'Hayden', 'Kendall', 'Logan', 'Peyton', 'Sage', 'Blake', 'Cameron', 'Drew', 'Elliot', 'Finley'];

// Overall rank: Unranked 15%, D 30%, C 28%, B 16%, A 8%, S 3%.
const OVERALL: Array<[number, number]> = [[0, 15], [1, 30], [2, 28], [3, 16], [4, 8], [5, 3]];
// How many days athletes tend to pick.
const DAY_WEIGHTS: Record<number, number> = { 1: 2, 2: 4, 3: 10, 4: 9, 5: 8, 6: 4, 7: 3 };
const PATTERNS: Record<number, number[][]> = {
  2: [[0, 3], [1, 4], [5, 6]],
  3: [[0, 2, 4], [1, 3, 5]],
  4: [[0, 1, 3, 4], [0, 2, 4, 5]],
  5: [[0, 1, 2, 3, 4]],
  6: [[0, 1, 2, 3, 4, 5]],
  7: [[0, 1, 2, 3, 4, 5, 6]]
};
// Test results inside each rank, Unranked to S.
const PUSHUPS: Array<[number, number]> = [[0, 8], [10, 20], [21, 35], [36, 50], [51, 70], [71, 90]];
const PULLUPS: Array<[number, number]> = [[0, 0], [1, 5], [6, 10], [11, 17], [18, 25], [26, 32]];
const RUN800_SEC: Array<[number, number]> = [[270, 330], [225, 270], [195, 225], [170, 195], [150, 170], [130, 150]];

const rand = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];
function weighted(pairs: Array<[number, number]>): number {
  const total = pairs.reduce((t, [, w]) => t + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of pairs) { if ((r -= w) < 0) return v; }
  return pairs[pairs.length - 1][0];
}
const clampLevel = (n: number) => Math.max(0, Math.min(5, n));
// Most categories sit at the overall rank or one away; flexibility up to two away.
const near = (level: number, spread: 1 | 2) =>
  clampLevel(level + (spread === 1 ? weighted([[-1, 25], [0, 50], [1, 25]]) : weighted([[-2, 10], [-1, 25], [0, 30], [1, 25], [2, 10]])));

export function trainingDays(min: number): boolean[] {
  const n = weighted(Object.entries(DAY_WEIGHTS).filter(([d]) => Number(d) >= min).map(([d, w]) => [Number(d), w]));
  let days: number[];
  if (PATTERNS[n] && Math.random() < 0.6) days = pick(PATTERNS[n]);
  else {
    days = [];
    while (days.length < n) { const d = rand(0, 6); if (!days.includes(d)) days.push(d); }
  }
  return Array.from({ length: 7 }, (_, i) => days.includes(i));
}

export function practiceAthlete(): PracticeAthlete {
  const level = weighted(OVERALL);
  const overall = RANKS[level];
  const name = pick(NAMES);
  const r = (spread: 1 | 2 = 1) => RANKS[near(level, spread)];
  const pushupRank = r(), pullupRank = r(), cardioRank = r();
  const lv = (x: OmniRank) => RANKS.indexOf(x);
  const run800 = rand(...RUN800_SEC[lv(cardioRank)]);
  const state: AthleteState = {
    seed: `${name.toLowerCase()}-${Date.now()}`,
    strengthRank: r(),
    minutes: trainingDays(MIN_DAYS[overall]).map(on => (on ? 60 : 0)),
    pushupMax: rand(...PUSHUPS[lv(pushupRank)]),
    pushupRank,
    pullupMax: rand(...PULLUPS[lv(pullupRank)]),
    pullupRank,
    flexibilityRanks: { pike: r(2), backbend: r(2), straddle: r(2) },
    cardioRank,
    speed2Km: (0.8 / run800) * 120,
    units: 'imperial',
    powerRanks: { longjump: r(), sprint: r() },
    bodyWeight: rand(130, 220),
    dailyCardio: []
  };
  return { name, overall, state };
}

// A rank's level, Unranked 0 to S 5.
export const levelOf = (r: OmniRank) => RANKS.indexOf(r);
