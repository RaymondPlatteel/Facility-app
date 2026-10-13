import type { AthleteState } from './types';
import { BLOCK_KEYS, BlockKey, WeekBlocks, accuracy, cloneWeek, counts, distance, levelOf } from './blocks';

// ---------- The trainer's model ----------
//
//  It starts from the rules: with nothing learned, its week is the rules' week. Every correction the coach saves
//  teaches it what was changed, day by day: which blocks were added to or taken from a day, and what that day looked
//  like (the athlete's ranks, how many days they train, whether the days beside it are rest days, and what the rules
//  put on it). For a new athlete it finds the most similar days among the corrections and makes the change most of
//  them agree on. Days unlike anything it has seen keep the rules' blocks.

export interface Example {
  state: AthleteState;
  rules: WeekBlocks;        // what the rules gave
  corrected: WeekBlocks;    // what the coach made it
}

interface DayCase {
  f: number[];                            // features, see dayFeatures
  rule: Record<BlockKey, number>;
  delta: Record<BlockKey, number>;        // corrected minus rules
}

const K = 7;

// How sure the model must be before it changes a week: at least three similar days, and at least 60% of their weight
// changing the block the same way. The trainer uses the same bar, so its proposals are what athletes get.
export const LIVE = { minNeighbors: 3, minAgreement: 0.6 };
// Days further than this from every learned day keep the rules' blocks.
const MAX_DISTANCE = 9;

function ranks(s: AthleteState): number[] {
  const flex = (levelOf(s.flexibilityRanks.pike) + levelOf(s.flexibilityRanks.backbend) + levelOf(s.flexibilityRanks.straddle)) / 3;
  return [levelOf(s.strengthRank), levelOf(s.pushupRank), levelOf(s.pullupRank), levelOf(s.cardioRank),
    levelOf(s.powerRanks.sprint), levelOf(s.powerRanks.longjump), flex];
}

// [ranks x7, training days, trains today, trains the day before, trains the day after]
function dayFeatures(s: AthleteState, i: number): number[] {
  const on = s.minutes.map(m => m > 0);
  return [...ranks(s), on.filter(Boolean).length, +on[i], +on[(i + 6) % 7], +on[(i + 1) % 7]];
}

// What the rules put on the day weighs most, then whether the athlete trains that day and beside it, then the ranks.
function gap(a: DayCase, f: number[], rule: Record<BlockKey, number>): number {
  let d = 0;
  for (let j = 0; j < 7; j++) d += Math.abs(a.f[j] - f[j]) * (j === 0 || j === 3 ? 1 : 0.5);   // strength and cardio count double
  d += Math.abs(a.f[7] - f[7]) * 0.75;
  d += (a.f[8] !== f[8] ? 6 : 0) + (a.f[9] !== f[9] ? 1 : 0) + (a.f[10] !== f[10] ? 1 : 0);
  for (const k of BLOCK_KEYS) d += Math.abs(a.rule[k] - rule[k]) * 2;
  return d;
}

export class Learner {
  private cases: DayCase[] = [];

  constructor(examples: Example[] = []) { examples.forEach(e => this.learn(e)); }

  get size(): number { return this.cases.length / 7; }

  learn(e: Example) {
    for (let i = 0; i < 7; i++) {
      const rule = counts(e.rules[i]), fixed = counts(e.corrected[i]);
      const delta = {} as Record<BlockKey, number>;
      BLOCK_KEYS.forEach(k => delta[k] = fixed[k] - rule[k]);
      this.cases.push({ f: dayFeatures(e.state, i), rule, delta });
    }
  }

  // The rules' week with the learned changes made. A change is made when, among the similar days, at least
  // `minNeighbors` were found and at least `minAgreement` of their weight changed that block the same way.
  // Rest days are never given anything.
  predict(state: AthleteState, rules: WeekBlocks, opts: { minNeighbors?: number; minAgreement?: number } = LIVE): WeekBlocks {
    const out = cloneWeek(rules);
    if (!this.cases.length) return out;
    const minNeighbors = opts.minNeighbors ?? 1, minAgreement = opts.minAgreement ?? 0;
    for (let i = 0; i < 7; i++) {
      if (state.minutes[i] <= 0) continue;
      const f = dayFeatures(state, i), rule = counts(rules[i]);
      const near = this.cases.map(c => ({ c, d: gap(c, f, rule) })).sort((a, b) => a.d - b.d).slice(0, K)
        .filter(x => x.d <= MAX_DISTANCE);
      if (near.length < Math.max(1, minNeighbors)) continue;
      const weight = near.map(x => 1 / (1 + x.d));
      const total = weight.reduce((a, b) => a + b, 0);
      for (const k of BLOCK_KEYS) {
        const change = Math.round(near.reduce((t, x, j) => t + x.c.delta[k] * weight[j], 0) / total);
        const agree = near.reduce((t, x, j) => t + (Math.sign(x.c.delta[k]) === Math.sign(change) ? weight[j] : 0), 0) / total;
        if (agree < minAgreement) continue;
        if (change > 0) for (let n = 0; n < change; n++) out[i].push(k);
        if (change < 0) for (let n = 0; n < -change; n++) { const at = out[i].lastIndexOf(k); if (at >= 0) out[i].splice(at, 1); }
      }
    }
    return out;
  }
}

// How the model did over time: each correction scored against what the model would have proposed from the
// corrections before it, next to the rules alone.
export interface Score { rules: number; model: number; rulesOff: number; modelOff: number; }
export function history(examples: Example[]): Score[] {
  const learner = new Learner();
  return examples.map(e => {
    const proposed = learner.predict(e.state, e.rules);
    const row = {
      rules: accuracy(e.rules, e.corrected), model: accuracy(proposed, e.corrected),
      rulesOff: distance(e.rules, e.corrected), modelOff: distance(proposed, e.corrected)
    };
    learner.learn(e);
    return row;
  });
}
