import type { AthleteState, EngineModule, PlanDay } from './types';
import type { ProgramExercise } from '../services/firebase.service';
import { RESILIENCE_REPS, RESILIENCE_TESTS } from '../services/omni.util';
import { attr } from './pushups';
import { workMinutes } from './budget';

// ---------- Resilience ----------
//
//  Resilience is a supplemental routine, not part of the program: the generator leaves it out, and the Today page
//  shows it on its own on the days the athlete chose (resilienceExercises below). It is every test exercise in order,
//  sets of 8. resilienceModule is the older placement inside the program, kept only for reference.
//    From four training days a week. Below that there is no room for it.
//    The athlete chooses the days: at most three, with a day between each (Sunday counts into Monday).
//    One day a week is 3 sets, two days 2 sets, three days 1 set.
//    With no choice made, the program picks one day: the training day with the least other work.
//
//  Loads are the athlete's own resistance. When they have a recorded result for an exercise it starts
//  there; otherwise they enter it.

export const MIN_DAYS_FOR_RESILIENCE = 4;
export const MAX_RESILIENCE_DAYS = 3;

// Whether the chosen days are allowed: no more than three, none beside another.
export function resilienceDaysValid(days: boolean[]): boolean {
  const on = days.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  return on.length <= MAX_RESILIENCE_DAYS && on.every(i => !days[(i + 1) % 7] || on.length === 1);
}

function chosenDays(state: AthleteState, week: PlanDay[]): number[] {
  const training = week.filter(d => d.minutes > 0);
  if (state.resilienceDays) {
    const picked = training.map(d => d.index).filter(i => state.resilienceDays![i]);
    return picked.length <= MAX_RESILIENCE_DAYS ? picked : picked.slice(0, MAX_RESILIENCE_DAYS);
  }
  const lightest = [...training].sort((a, b) => workMinutes(a) - workMinutes(b) || a.index - b.index)[0];
  return lightest ? [lightest.index] : [];
}

export const resilienceModule: EngineModule = (state: AthleteState, week) => {
  if (week.filter(d => d.minutes > 0).length < MIN_DAYS_FOR_RESILIENCE) return;
  const days = chosenDays(state, week);
  if (!days.length) return;
  const sets = days.length === 1 ? 3 : days.length === 2 ? 2 : 1;
  for (const index of days) {
    const day = week.find(d => d.index === index)!;
    day.exercises.push(...resilienceExercises(state, sets));
  }
};

// Every resilience exercise in order, sets of 8.
export function resilienceExercises(state: AthleteState, sets: number): ProgramExercise[] {
  return RESILIENCE_TESTS.map((t): ProgramExercise => {
    const known = state.resilienceLoads?.[t.key];
    return {
      name: t.label,
      attributes: [
        attr('Sets', 'Fixed', String(sets)),
        attr('Reps', 'Fixed', String(RESILIENCE_REPS)),
        known ? attr('Load', 'Fixed', String(known)) : attr('Load', 'User Input', '')
      ]
    };
  });
}

// Sets by how many days the athlete chose: one day 3 sets, two days 2, three days 1.
export function resilienceSets(days: boolean[] | undefined): number {
  const n = (days ?? []).filter(Boolean).length;
  return n <= 1 ? 3 : n === 2 ? 2 : 1;
}
