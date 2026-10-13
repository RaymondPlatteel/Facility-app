import type { AthleteState, EngineModule, PlanDay } from './types';
import { programSession, pushupDays } from './pushups';

// ---------- Pull-up endurance ----------
//
//  Unranked, D, C and B: no pull-up endurance work. Strength carries them (see the strength modules).
//  A-Rank pull-ups: the endurance program, the same as the pushup program, bodyweight only.
//  S-Rank pull-ups: the same, with extra weight of 5% of bodyweight.
//
//  It runs on the same three alternating days as the pushup program, so a pushup day is also a
//  pull-up day, and it has the same rules: five training days a week, a max test on Day 3 every other
//  week, and a final max test when the athlete cancels. Reps are a share of the latest assessed max,
//  rounded down.

const NAME = 'Pull-up';

export const pullupModule: EngineModule = (state: AthleteState, week: PlanDay[], weekIndex, opts) => {
  const { pullupMax: max, pullupRank: rank } = state;
  if (max <= 0 || (rank !== 'A-RANK' && rank !== 'S-RANK')) return;

  const training = week.filter(d => d.minutes > 0 && !d.reserved).map(d => d.index);
  if (training.length < 5) return;
  const days = pushupDays(training);
  if (!days) return;

  const load = rank === 'S-RANK' ? Math.round(state.bodyWeight * 0.05) : 0;
  days.forEach((dayIndex, n) => {
    week.find(d => d.index === dayIndex)!.exercises.push(programSession(NAME, max, n, load, weekIndex, opts));
  });
};
