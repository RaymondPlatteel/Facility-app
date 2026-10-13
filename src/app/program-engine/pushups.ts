import type { AthleteState, EngineModule, PlanDay } from './types';
import type { ProgramExercise, ProgramAttribute } from '../services/firebase.service';

// ---------- Pushup endurance ----------
//
//  No pushup yet (max 0), or Unranked in the pushup test: no pushup work.
//  D-Rank pushups: 2 sets of 50% of max, after the strength work on bench days.
//  C-Rank pushups: 3 sets of 60% of max, on 3 days a week: after bench on the bench days, and the rest on other
//  training days. With fewer than 3 days that can be spaced out, 2 or 1.
//  There is always at least one rest day between two pushup days, Sunday into Monday included.
//  D with no bench day: no pushups.
//  B-Rank pushups: the pushup program, three sessions on alternating days (day on, day off,
//  day on, day off, day on). It needs at least five training days a week; with fewer, B and A
//  do the C-Rank pushups instead.
//  A-Rank pushups: the same, with extra weight of 5% of bodyweight.
//
//  Every other week, Day 3 is replaced by a one-set max test. When the athlete has cancelled, the
//  final Day 3 is a max test as well.
//
//  Reps are a share of the latest assessed max, always rounded down (8.9 becomes 8).

const NAME = 'Push-up';

interface ProgramDayPlan { percents: number[]; rest: number; restBeforeLast: number; }
const PROGRAM: ProgramDayPlan[] = [
  { percents: [35, 40, 33, 33, 42], rest: 60, restBeforeLast: 120 },
  { percents: [22, 22, 29, 29, 22, 22, 53], rest: 60, restBeforeLast: 120 },
  { percents: [29, 29, 33, 33, 27, 27, 22, 64], rest: 90, restBeforeLast: 180 }
];

export const attr = (type: string, strategy: string, val: string): ProgramAttribute => ({ id: `${type}-${strategy}`, type, strategy, val });

// Integer-safe: 29% of 100 is 29, not 28.999999999999996.
export function repsFor(max: number, pct: number): number {
  return Math.max(1, Math.floor((max * pct) / 100 + 1e-9));
}

function clock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function exercise(name: string, reps: number[], opts: { load?: number; rest?: ProgramDayPlan; note?: string }): ProgramExercise {
  const attributes = [attr('Sets', 'Fixed', String(reps.length)), attr('Reps', 'Fixed', String(reps[0]))];
  if (opts.load) attributes.push(attr('Load', 'Fixed', String(opts.load)));
  attributes.push(attr('RPE', 'User Input', ''));   // endurance is rated by RPE, not RIR
  const lines: string[] = [];
  if (opts.rest) lines.push(`Rest ${clock(opts.rest.rest)} between sets and ${clock(opts.rest.restBeforeLast)} before the last set.`);
  if (opts.note) lines.push(opts.note);
  return {
    name,
    attributes,
    setPlan: reps.map(r => ({ reps: r, ...(opts.load ? { load: opts.load } : {}) })),
    instructions: lines.join(' ')
  };
}

function maxTest(name: string): ProgramExercise {
  return {
    name,
    attributes: [attr('Sets', 'Fixed', '1'), attr('Reps', 'AMRAP', ''), attr('RPE', 'User Input', '')],
    instructions: 'Max test: one set to failure. Record your total repetitions.'
  };
}

// One session of the endurance program (n = 0, 1, 2 for Day 1 to Day 3). Shared by pushups and pull-ups.
export function programSession(name: string, max: number, n: number, load: number, weekIndex: number, opts: { weeks: number; ending?: boolean }): ProgramExercise {
  const plan = PROGRAM[n];
  const finalWeek = !!opts.ending && weekIndex === opts.weeks - 1;
  if (n === 2 && (weekIndex % 2 === 1 || finalWeek)) return maxTest(name);
  return exercise(name, plan.percents.map(p => repsFor(max, p)), {
    load: load || undefined,
    rest: plan,
    note: load ? `Add ${load} lb of extra weight.` : undefined
  });
}

// The three alternating days: no two within a day of each other, counting Sunday into Monday,
// as evenly spread as the schedule allows (earliest wins a tie).
export function pushupDays(training: number[]): [number, number, number] | null {
  let best: [number, number, number] | null = null;
  let bestGap = -1;
  for (let i = 0; i < training.length; i++) for (let j = i + 1; j < training.length; j++) for (let k = j + 1; k < training.length; k++) {
    const [a, b, c] = [training[i], training[j], training[k]];
    const gaps = [b - a, c - b, a + 7 - c];
    if (Math.min(...gaps) < 2) continue;
    const g = Math.min(...gaps);
    if (g > bestGap) { bestGap = g; best = [a, b, c]; }
  }
  return best;
}

// Up to `want` of the candidate days with a rest day between any two (Sunday into Monday counts), taking as many as fit
// up to `want`. Bench days come first, then the most even spacing, then the earliest days.
export function restedDays(candidates: PlanDay[], week: PlanDay[], want: number): PlanDay[] {
  const idx = candidates.map(d => d.index);
  const bench = new Set(week.filter(d => d.hasBench).map(d => d.index));
  let best: number[] = [];
  let bestKey: number[] = [];
  const apart = (a: number, b: number) => Math.min((a - b + 7) % 7, (b - a + 7) % 7) >= 2;
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length) {
      const gaps = chosen.length > 1 ? chosen.map((d, i) => (i === chosen.length - 1 ? chosen[0] + 7 - d : chosen[i + 1] - d)) : [7];
      const key = [chosen.length, chosen.filter(d => bench.has(d)).length, Math.min(...gaps), -chosen.reduce((t, d) => t + d, 0)];
      const first = key.findIndex((v, i) => v !== bestKey[i]);
      if (!bestKey.length || (first >= 0 && key[first] > bestKey[first])) { best = [...chosen]; bestKey = key; }
    }
    if (chosen.length === want) return;
    for (let i = start; i < idx.length; i++) {
      if (chosen.every(c => apart(c, idx[i]))) pick(i + 1, [...chosen, idx[i]]);
    }
  };
  pick(0, []);
  return best.map(i => week.find(d => d.index === i)!);
}

export const pushupModule: EngineModule = (state: AthleteState, week: PlanDay[], weekIndex, opts) => {
  const { pushupMax: max } = state;
  const training5 = week.filter(d => d.minutes > 0 && !d.reserved).length >= 5;
  // The program needs five training days (it takes a week with two rest days); with fewer, B and A train as C.
  const rank = (state.pushupRank === 'B-RANK' || state.pushupRank === 'A-RANK' || state.pushupRank === 'S-RANK') && !training5 ? 'C-RANK' : state.pushupRank;
  if (max <= 0 || rank === 'UNRANKED') return;

  // D and C: after bench where there is a bench day. D trains only on bench days; C trains on 3 days a week.
  if (rank === 'D-RANK' || rank === 'C-RANK') {
    const sets = rank === 'D-RANK' ? 2 : 3;
    const pct = rank === 'D-RANK' ? 50 : 60;
    const open = week.filter(d => d.minutes > 0 && !d.reserved);
    const days = restedDays(rank === 'D-RANK' ? open.filter(d => d.hasBench) : open, week, rank === 'D-RANK' ? 7 : 3);
    for (const day of days) {
      day.exercises.push(exercise(NAME, Array(sets).fill(repsFor(max, pct)), day.hasBench ? { note: 'Complete after your bench press.' } : {}));
    }
    return;
  }

  // B and A: the pushup program.
  const training = week.filter(d => d.minutes > 0 && !d.reserved).map(d => d.index);
  if (training.length < 5) return;
  const days = pushupDays(training);
  if (!days) return;

  const load = rank === 'B-RANK' ? 0 : Math.round(state.bodyWeight * 0.05);
  days.forEach((dayIndex, n) => {
    week.find(d => d.index === dayIndex)!.exercises.push(programSession(NAME, max, n, load, weekIndex, opts));
  });
};
