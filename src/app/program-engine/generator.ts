import type { Program, ProgramDay } from '../services/firebase.service';
import type { AthleteState, EngineModule, EngineOptions, PlanDay } from './types';
import { strengthModule } from './strength';
import { pushupModule } from './pushups';
import { pullupModule } from './pullups';
import { cardioModule, session as cardioSession } from './cardio';
import { powerModule } from './power';
import { flexibilityModule } from './flexibility';
import { budgetModule } from './budget';

// Strength comes first so later modules can see which days have bench press; each exercise
// module adds a line here as it is built.
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Budget trims the day to 60 minutes; flexibility fills what is left. Resilience is not part of the program: it is a
// supplemental routine on the days the athlete chose, shown on its own on the Today page (resilience.ts builds it).
const MODULES: EngineModule[] = [strengthModule, pushupModule, pullupModule, cardioModule, powerModule, budgetModule, flexibilityModule];

export function generateProgram(state: AthleteState, opts: EngineOptions): Program {
  const schedule: ProgramDay[] = [];
  for (let w = 0; w < opts.weeks; w++) {
    const week: PlanDay[] = state.minutes.map((minutes, index) => ({ index, minutes, exercises: [], hasBench: false, reserved: false }));
    for (const run of MODULES) run(state, week, w, opts);
    // Daily cardio: an easy 20 minute run on each chosen day the program has no cardio of its own.
    week.forEach(d => {
      if (state.dailyCardio[d.index] && !d.exercises.some(e => /cardio|intervals/i.test(e.name))) d.exercises.unshift(cardioSession('easy', state, 20));
    });
    week.forEach((d, i) => schedule.push({
      id: w * 7 + i,
      name: DAY_NAMES[i],
      notes: '',
      isRestDay: d.exercises.length === 0,
      repeat: 'none',
      exercises: d.exercises
    }));
  }
  return {
    name: 'Customized program',
    cycles: opts.weeks,
    daysPerCycle: 7,
    isStandardWeek: true,
    loops: !opts.ending,   // one week that repeats; a cancelled program plays its final week once
    schedule,
    status: 'active'
  };
}
