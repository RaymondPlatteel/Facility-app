import type { AthleteState, EngineModule } from './types';
import type { OmniRank, ProgramExercise } from '../services/firebase.service';
import { attr } from './pushups';

// ---------- Flexibility ----------
//
//  Every day the athlete trains, after everything else: the base routine, the same for everyone, and each test's
//  routine (pike, backbend, middle split). Each is one video and a check box (see flexibility-routines.ts); the
//  video speaks to the ranks. The routines carry no time: flexibility is not budgeted against the 60 minute workout.
//
//  An athlete with an A or S flexibility test trains one test a day instead of all three: the base routine plus
//  that test's routine, looping in that order.

const TESTS: Array<{ key: 'pike' | 'backbend' | 'straddle'; label: string }> = [
  { key: 'pike', label: 'Pike' },
  { key: 'backbend', label: 'Backbend' },
  { key: 'straddle', label: 'Middle Split' }
];

const ELITE: OmniRank[] = ['A-RANK', 'S-RANK'];

const routine = (name: string, which: string): ProgramExercise => ({
  name,
  attributes: [attr('Sets', 'Fixed', '1'), attr('Routine', 'Fixed', which)]
});

export const flexibilityModule: EngineModule = (state: AthleteState, week, weekIndex) => {
  const trainingDays = week.filter(d => d.minutes > 0).length;
  // An athlete with an A or S flexibility test trains one test a day (pike, backbend, straddle, looping).
  const elite = TESTS.some(t => ELITE.includes(state.flexibilityRanks[t.key]));
  let n = 0;
  for (const day of week) {
    if (day.minutes <= 0) continue;
    day.exercises.push(routine('Base flexibility', 'base'));
    const tests = elite ? [TESTS[(weekIndex * trainingDays + n++) % TESTS.length]] : TESTS;
    tests.forEach(t => day.exercises.push(routine(`${t.label} flexibility`, t.key)));
  }
};
