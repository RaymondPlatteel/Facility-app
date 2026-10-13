import type { AthleteState, EngineModule, PlanDay } from './types';
import type { ProgramExercise } from '../services/firebase.service';
import { RESILIENCE_TESTS } from '../services/omni.util';

// ---------- The 60 minute workout ----------
//
//  The workout is 60 minutes. The supplemental routines (morning, evening, the daily run and resilience) are extra
//  and never count toward it. Flexibility fills whatever the day has left, and is never less than 10 minutes.
//
//  A or S strength is not capped: it prescribes what it needs and the day runs over if it has to.
//  For every other rank a day that cannot hold its work gives things up, in this order, because the earlier
//  ones keep improving on their own:
//    1. Push-up and pull-up endurance   it follows strength, which is still being trained. It loses sets, one at a
//                                       a time, down to a single set; a set takes seconds, the rest takes the time.
//    2. Power (jumps and sprints)       it follows strength too.
//    3. Speed intervals                 they follow regular cardio.
//    4. Cardio is shortened to 20    cardio does not improve unless it is trained, so a session is made shorter
//                                       before it is cut.
//    5. Hard cardio                     easy cardio is kept and never cut.
//  Flexibility keeps its 12 minutes throughout; it does not improve unless it is trained. A full day of lifts,
//  a 20 minute run and 12 minutes of flexibility can therefore come to a little over 60.

export const WORKOUT_MINUTES = 60;
export const FLEXIBILITY_FLOOR = 12;   // the short routines for the three tests, 4 minutes each
export const CARDIO_FLOOR = 20;
export const OVERRUN = 5;   // a day may run this far over rather than lose a session

const POWER = /^(Broad jump|Single-leg jumps|Acceleration sprints|Flying sprints|Speed endurance sprints|100 m sprint)$/;
const isEndurance = (e: ProgramExercise) => /^(Push-up|Pull-up)$/.test(e.name) && e.attributes.some(a => a.type === 'RPE');
const isPower = (e: ProgramExercise) => POWER.test(e.name);
const isSpeed = (e: ProgramExercise) => e.name === 'Speed intervals';
const isHard = (e: ProgramExercise) => e.name === 'Hard cardio';
const isEasy = (e: ProgramExercise) => e.name === 'Easy cardio';
export const isFlexibility = (e: ProgramExercise) => /flexibility$/.test(e.name);
const resilienceNames = new Set(RESILIENCE_TESTS.map(t => t.label));
export const isResilience = (e: ProgramExercise) => resilienceNames.has(e.name);

const val = (e: ProgramExercise, type: string) => Number(e.attributes.find(a => a.type === type)?.val) || 0;

// Rough minutes for one exercise: a set of a main lift takes about 4 minutes, a pull-up set about 2.7.
export function minutesOf(e: ProgramExercise): number {
  const n = e.name;
  const sets = e.setPlan?.length || val(e, 'Sets') || 1;
  // A circuit alternates its lifts, so the rest of one is spent on another: about 3 minutes a set rather than 4.
  if (/^Barbell/.test(n)) return sets * (e.instructions?.startsWith('Round') ? 3 : 4);
  if (n === 'Push-up') return e.setPlan ? Math.round(sets * 1.75) : Math.max(2, sets * 1.5);
  if (/pull-up/i.test(n)) return e.setPlan ? Math.round(sets * 1.75) : sets * 2.7;
  if (/cardio/i.test(n)) return val(e, 'Duration') / 60;
  if (isSpeed(e)) return 20;
  if (n === 'Broad jump') return 12;
  if (n === 'Single-leg jumps') return 5;
  if (n === 'Acceleration sprints' || n === 'Flying sprints') return 8;
  if (n === 'Speed endurance sprints') return 12;
  if (n === '100 m sprint') return 10;
  if (isFlexibility(e)) return val(e, 'Duration') / 60 || 0;
  return 0;   // resilience and anything supplemental
}

// The workout's minutes before flexibility: the part flexibility has to share the day with.
export function workMinutes(day: { exercises: ProgramExercise[] }): number {
  return day.exercises.filter(e => !isFlexibility(e) && !isResilience(e)).reduce((t, e) => t + minutesOf(e), 0);
}

const uncapped = (state: AthleteState) => state.strengthRank === 'A-RANK' || state.strengthRank === 'S-RANK';

// Takes one set from the push-up or pull-up endurance work with the most sets; false once each is down to one set.
// The last set is the biggest, so the earlier sets go first.
function trim(day: PlanDay): boolean {
  const found = day.exercises.filter(e => isEndurance(e));
  const sets = (e: ProgramExercise) => e.setPlan?.length || val(e, 'Sets') || 1;
  const e = found.filter(x => sets(x) > 1).sort((a, b) => sets(b) - sets(a))[0];
  if (!e) return false;
  const n = sets(e) - 1;
  if (e.setPlan) e.setPlan = e.setPlan.slice(1);
  const a = e.attributes.find(x => x.type === 'Sets');
  if (a) a.val = String(n);
  const r = e.attributes.find(x => x.type === 'Reps');
  if (r && e.setPlan?.length) r.val = String(e.setPlan[0].reps);
  return true;
}

// Removes or shortens the next thing in line. False when nothing is left to give up.
function giveUp(day: PlanDay): boolean {
  const drop = (test: (e: ProgramExercise) => boolean) => {
    const i = day.exercises.map(test).lastIndexOf(true);
    if (i < 0) return false;
    day.exercises.splice(i, 1);
    return true;
  };
  if (trim(day) || drop(isPower) || drop(isSpeed)) return true;
  // a session is made shorter before it is cut
  for (const e of day.exercises.filter(x => isHard(x) || isEasy(x))) {
    const d = e.attributes.find(a => a.type === 'Duration');
    if (d && Number(d.val) > CARDIO_FLOOR * 60) { d.val = String(CARDIO_FLOOR * 60); return true; }
  }
  return drop(isHard);   // easy cardio is kept
}

// Runs after the exercise modules and before flexibility.
export const budgetModule: EngineModule = (state: AthleteState, week: PlanDay[]) => {
  if (uncapped(state)) return;
  for (const day of week) {
    if (day.minutes <= 0) continue;
    while (workMinutes(day) > WORKOUT_MINUTES - FLEXIBILITY_FLOOR + OVERRUN && giveUp(day)) { /* keep giving up */ }
  }
};
