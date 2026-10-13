import type { AthleteState, EngineModule, PlanDay } from './types';
import type { OmniRank, ProgramExercise } from '../services/firebase.service';
import { attr } from './pushups';

// ---------- Power: the broad jump and the 100 m sprint ----------
//
//  Power goes first in a session, after the warm-up, and stays small: the reps need full rest and quality
//  falls off fast. Every number below is a placeholder to be tuned.
//
//  Four or more training days: one track day. The broad jumps, the sprint work and that day's cardio go
//  together, so the athlete goes to the track once and stays, and no strength day gets longer. It goes on the
//  day with the least strength work, preferring a day that already has cardio. Power ahead of deadlifts on the
//  same day is fine.
//    Sprint work: acceleration drills, flying runs from B, a 60 to 80 m run about monthly from A, and from C
//    one maximal 100 m attempt.
//  Three days or fewer: no track day. A 10 minute primer before the session on the lightest day (two days at
//  three days): single-leg jumps, broad jumps and a few short accelerations.
//
//  Every broad jump attempt is already a test, so there is no separate test session. The sprint session
//  from C rank on includes one maximal 100 m attempt after a few acceleration drills.

const RANKS: OmniRank[] = ['UNRANKED', 'D-RANK', 'C-RANK', 'B-RANK', 'A-RANK', 'S-RANK'];
const level = (r: OmniRank) => RANKS.indexOf(r);


function ex(name: string, sets: number, reps: number | null, meters: number | null, note: string): ProgramExercise {
  const attributes = [attr('Sets', 'Fixed', String(sets))];
  if (reps != null) attributes.push(attr('Reps', 'Fixed', String(reps)));
  if (meters != null) attributes.push(attr('Meters', 'Fixed', String(meters)));
  return { name, attributes, instructions: note };
}

const broadJumps = (_rank: OmniRank) =>
  ex('Broad jump', 1, 15, null, 'Maximal effort, after your warm-up. Rest until you feel ready to potentially beat your record. Stop the exercise if your distance drops by about 5%.');
const singleLegJumps = () =>
  ex('Single-leg jumps', 3, 5, null, 'Five jumps on each leg per set, with full rest between sets.');
const accelerations = (rank: OmniRank, meters = 20, reps?: number) =>
  ex('Acceleration sprints', 1, reps ?? 4 + Math.floor(level(rank) / 2), meters,
    'Build to full speed over the distance. Walk back for about 2 minutes of rest between runs.');
const flying = () => ex('Flying sprints', 1, 3, 20, 'Build up for 20 m, then hold top speed for 20 m. Rest 3 minutes between runs.');
const speedEndurance = () => ex('Speed endurance sprints', 1, 2, 70, 'Run hard for 60 to 80 m. Rest 5 minutes between runs.');
const maxAttempt = (): ProgramExercise => ({
  name: '100 m sprint',
  attributes: [attr('Sets', 'Fixed', '1'), attr('Meters', 'Fixed', '100'), attr('Duration', 'User Input', '')],
  instructions: 'One maximal attempt. Record your time.'
});

// The short primer for weeks of three days or fewer. Also used when the trainer model adds a primer to a day.
export function primer(state: AthleteState): ProgramExercise[] {
  return [singleLegJumps(), broadJumps(state.powerRanks.longjump), accelerations(state.powerRanks.sprint, 15, 3)];
}

// Places an exercise list at the very start of a day, ahead of anything already there.
function front(day: PlanDay, list: ProgramExercise[]) { day.exercises.unshift(...list); }

export const powerModule: EngineModule = (state: AthleteState, week: PlanDay[], weekIndex) => {
  const training = week.filter(d => d.minutes > 0 && !d.reserved);
  if (!training.length) return;
  const jumpRank = state.powerRanks.longjump;
  const sprintRank = state.powerRanks.sprint;
  const load = (d: PlanDay) => d.exercises.filter(e => /^Barbell|^Weighted|^Pull-up|^Assisted/.test(e.name)).length;

  // Three days or fewer: a short primer, before the session.
  if (training.length <= 3) {
    const byLoad = [...training].sort((x, y) => load(x) - load(y) || x.index - y.index);
    const primerDays = (training.length <= 2 ? byLoad.slice(0, 1) : byLoad.slice(0, 2)).sort((x, y) => x.index - y.index);
    primerDays.forEach(d => front(d, primer(state)));
    return;
  }

  // Four days or more: one track day with the broad jumps, the sprint work and that day's cardio, so the
  // athlete goes to the track once and stays. It goes on the day with the least strength work, preferring a
  // day that already carries cardio. Power before deadlifts on the same day is fine.
  const cardio = (d: PlanDay) => d.exercises.some(e => /cardio|Speed intervals/.test(e.name));
  const speed = (d: PlanDay) => d.exercises.some(e => e.name === 'Speed intervals');
  // The track day is the speed-interval day when there is one, so all of the track work happens in one visit.
  const trackDay = [...training].sort((x, y) => Number(speed(y)) - Number(speed(x)) || load(x) - load(y) || Number(cardio(y)) - Number(cardio(x)) || x.index - y.index)[0];
  // Acceleration drills warm up for the maximal 100 m attempt (from C rank), which goes first while the legs are fresh.
  // The broad jumps follow: they are not tiring, so they come before the rest of the day, but after the attempt.
  const sprintList: ProgramExercise[] = [accelerations(sprintRank, 20, 3)];
  if (level(sprintRank) >= 2) sprintList.push(maxAttempt());
  const rest: ProgramExercise[] = [broadJumps(jumpRank)];
  if (level(sprintRank) >= 3) rest.push(flying());
  if (level(sprintRank) >= 4 && weekIndex % 4 === 2) rest.push(speedEndurance());
  front(trackDay, [...sprintList, ...rest]);
};
