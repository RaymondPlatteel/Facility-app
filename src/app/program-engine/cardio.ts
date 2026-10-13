import type { AthleteState, EngineModule, PlanDay } from './types';
import type { ProgramExercise } from '../services/firebase.service';
import { attr } from './pushups';
import { spreadDays } from './strength';
import { FLEXIBILITY_FLOOR, WORKOUT_MINUTES, workMinutes } from './budget';

// ---------- Cardio ----------
//
//  Easy sessions hold a heart rate of 130 to 145 bpm; hard days hold 150 to 170.
//    Unranked   1 easy day.
//    D          1 easy day; 2 with more training days.
//    C          2 easy days; 3 with more training days.
//    B          3 easy days and 1 hard day.
//    A and S    3 easy days, 1 hard day, and 1 speed day: three 800 m runs at 85% of the
//               athlete's speed from the 800 m run assessment.
//  "More training days" means the athlete has days to place the extra session with a rest day between
//  the sessions (D needs two such days, C needs three).
//
//  Sessions run 20 to 35 minutes: 30 is the most common, 25 fairly common, and 20 and 35 rare. The
//  length is drawn from the athlete's seed, so a given program always comes out the same.
//  They go where the 60 minute workout has room: days with no strength training first (a free day takes the
//  hard session), then upper-body days, then lower-body days, never beside another cardio day when it can be
//  avoided. Hard cardio and speed intervals go on a lower-body day like any other session. With fewer
//  training days than sessions, easy sessions are dropped first.

// Weighted lengths: 20 (5%), 25 (25%), 30 (65%), 35 (5%).
const LENGTHS: Array<[number, number]> = [[20, 5], [25, 25], [30, 65], [35, 5]];

function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sessionMinutes(roll: number): number {
  let acc = 0;
  for (const [minutes, weight] of LENGTHS) { acc += weight; if (roll * 100 < acc) return minutes; }
  return 30;
}

// Whether k of the training days can be placed with at least a rest day between them.
function canSpace(training: number[], k: number): boolean {
  if (training.length < k) return false;
  const days = spreadDays(training, k);
  const gaps = days.map((d, i) => (i === k - 1 ? days[0] + 7 - d : days[i + 1] - d));
  return Math.min(...gaps) >= 2;
}

type Kind = 'easy' | 'hard' | 'speed';

// The sessions for a rank, in the order they should fall through the week.
export function sessionsFor(rank: AthleteState['cardioRank'], training: number[]): Kind[] {
  switch (rank) {
    case 'UNRANKED': return ['easy'];
    case 'D-RANK': return canSpace(training, 2) ? ['easy', 'easy'] : ['easy'];
    case 'C-RANK': return canSpace(training, 3) ? ['easy', 'easy', 'easy'] : ['easy', 'easy'];
    case 'B-RANK': return ['easy', 'hard', 'easy', 'easy'];
    default: return ['easy', 'hard', 'easy', 'speed', 'easy'];
  }
}

// Drops easy sessions first when there are fewer days than sessions.
function fit(kinds: Kind[], days: number): Kind[] {
  const out = [...kinds];
  while (out.length > days) {
    const i = out.lastIndexOf('easy');
    out.splice(i >= 0 ? i : out.length - 1, 1);
  }
  return out;
}

const LOWER = ['Barbell Squat', 'Barbell Deadlift'];
const hasLift = (d: PlanDay, names: string[]) => d.exercises.some(e => names.includes(e.name));
const hasStrength = (d: PlanDay) => d.exercises.some(e => /^Barbell/.test(e.name));

// Where a session goes: a day with no strength training first, an upper-body day next, a lower-body day last.
// Sessions also stay off the days beside each other.
function placeSessions(kinds: Kind[], training: PlanDay[], week: PlanDay[]): Array<{ day: PlanDay; kind: Kind }> {
  const order: Kind[] = [...kinds].sort((a, b) => rank(a) - rank(b));
  const used = new Map<number, Kind>();
  const prev = (d: PlanDay) => week[(d.index + 6) % 7];
  const next = (d: PlanDay) => week[(d.index + 1) % 7];

  const cost = (d: PlanDay, kind: Kind): number => {
    const intense = kind !== 'easy';
    // Cardio of any kind is fine on a lifting day (hard cardio included), so the day's other work decides: a day with
    // room takes it, and a day with no strength is the first choice.
    let c = hasLift(d, LOWER) ? 1 : hasStrength(d) ? 0.5 : 0;
    c += Math.max(0, workMinutes(d) + 30 - (WORKOUT_MINUTES - FLEXIBILITY_FLOOR)) / 5;   // minutes it would push past the day
    for (const n of [prev(d), next(d)]) {
      const other = used.get(n.index);
      if (other) c += intense && other !== 'easy' ? 8 : 3;                // cardio beside cardio
    }
    return c;
  };

  for (const kind of order) {
    const open = training.filter(d => !used.has(d.index));
    if (!open.length) break;
    let best = open[0], bestCost = Infinity;
    for (const d of open) {
      const x = cost(d, kind);
      if (x < bestCost) { best = d; bestCost = x; }
    }
    used.set(best.index, kind);
  }
  return [...used.entries()].map(([index, kind]) => ({ day: week[index], kind })).sort((a, b) => a.day.index - b.day.index);
}

// Speed and hard days are placed first, then the easy ones around them.
function rank(kind: Kind): number { return kind === 'speed' ? 0 : kind === 'hard' ? 1 : 2; }

// the pace they actually ran, entered afterwards
const pace = (state: AthleteState) => attr(state.units === 'metric' ? 'min/km' : 'min/mile', 'User Input', '');

const heartRate = (lo: number, hi: number) => attr('HR', 'Range', `${lo}-${hi}`);

export function session(kind: Kind, state: AthleteState, minutes: number): ProgramExercise {
  if (kind === 'easy') {
    return {
      name: 'Easy cardio',
      attributes: [attr('Sets', 'Fixed', '1'), attr('Duration', 'Fixed', String(minutes * 60)), heartRate(130, 145), pace(state)],
      instructions: 'Keep your heart rate between 130 and 145 bpm.'
    };
  }
  if (kind === 'hard') {
    return {
      name: 'Hard cardio',
      attributes: [attr('Sets', 'Fixed', '1'), attr('Duration', 'Fixed', String(minutes * 60)), heartRate(150, 170), pace(state)],
      instructions: 'Keep your heart rate between 150 and 170 bpm.'
    };
  }
  // speed: 3 x 800 m at 85% of the speed of the 800 m run (km in 2 minutes x 30 = km/h)
  const kph = state.speed2Km * 30 * 0.85;
  const metric = state.units === 'metric';
  const target = metric ? kph : kph * 0.621371;
  const unit = metric ? 'kph' : 'mph';
  const shown = Math.round(target * 10) / 10;
  const sec = kph > 0 ? Math.round(800 / (kph / 3.6)) : 0;
  const time = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  return {
    name: 'Speed intervals',
    attributes: [attr('Sets', 'Fixed', '3'), ...(sec ? [attr('Duration', 'Fixed', String(sec)), attr(unit, 'Fixed', String(shown))] : [])],
    instructions: sec
      ? `Three 800 m runs, each in ${time} (${shown} ${unit}), which is 85% of your speed from your 800 m run assessment.`
      : 'Three 800 m runs at 85% of your speed from your 800 m run assessment.'
  };
}

export const cardioModule: EngineModule = (state: AthleteState, week: PlanDay[], weekIndex) => {
  const trainingDays = week.filter(d => d.minutes > 0 && !d.reserved);
  const training = trainingDays.map(d => d.index);
  if (!training.length) return;
  const kinds = fit(sessionsFor(state.cardioRank, training), training.length);
  const roll = rng(`${state.seed}:cardio:${weekIndex}`);
  placeSessions(kinds, trainingDays, week).forEach(({ day, kind }) => day.exercises.push(session(kind, state, sessionMinutes(roll()))));
};
