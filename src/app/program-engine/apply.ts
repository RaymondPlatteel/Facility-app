import type { Program, ProgramDay, ProgramExercise } from '../services/firebase.service';
import type { AthleteState } from './types';
import { BlockKey, BLOCK_KEYS, GROUP_BLOCKS, WeekBlocks, blockDef, blockOf, counts, fromStored, hasPrimer, weekBlocks } from './blocks';
import { Example, Learner } from './learner';
import { generateProgram } from './generator';
import { session } from './cardio';
import { primer } from './power';

// ---------- The trainer model in a real program ----------
//
//  The rules build the program; the model (learner.ts), taught by the coach's corrections in facility-app's Program
//  Trainer and program reviews, then changes the blocks it is confident about. The change is worked out on the first
//  week and made the same way in every week, so anything that alternates from week to week stays as the rules wrote it.
//  A block taken off one day and put on another keeps its exercises. A block added fresh is copied from another day of
//  the same week when there is one, otherwise built by the rule that makes it (cardio, the primer); a
//  block with neither is not added. Resilience is not part of the program, so the model never places it.

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The corrections as the model reads them: the coach's week is the answer, and the rules' week is rebuilt with the
// current rules, so corrections made under earlier rules still count.
export function examplesFrom(corrections: Array<{ state: unknown; corrected: Record<string, string[]> }>): Example[] {
  return corrections.map(c => {
    const state = c.state as AthleteState;
    return {
      state,
      rules: weekBlocks(generateProgram(state, { weeks: 1 }).schedule.slice(0, 7)),
      corrected: fromStored(c.corrected as Record<string, BlockKey[]>)
    };
  });
}

// The program with the model's changes made, and a line for each change ("Mon: added Easy Cardio").
export function applyModel(program: Program, state: AthleteState, learner: Learner): { program: Program; changes: string[] } {
  if (!learner.size) return { program, changes: [] };
  const rules = weekBlocks(program.schedule.slice(0, 7));
  const target = learner.predict(state, rules);
  const delta = rules.map((day, i) => {
    const r = counts(day), t = counts(target[i]);
    const d = {} as Record<BlockKey, number>;
    BLOCK_KEYS.forEach(k => d[k] = t[k] - r[k]);
    return d;
  });
  if (delta.every(d => BLOCK_KEYS.every(k => !d[k]))) return { program, changes: [] };

  const schedule = program.schedule.map(d => ({ ...d, exercises: d.exercises.map(e => ({ ...e })) }));
  const changes: string[] = [];
  for (let w = 0; w * 7 < schedule.length; w++) {
    const week = schedule.slice(w * 7, w * 7 + 7);
    const made = applyWeek(week, delta, state);
    if (w === 0) changes.push(...made);
  }
  return { program: { ...program, schedule }, changes };
}

function applyWeek(week: ProgramDay[], delta: Array<Record<BlockKey, number>>, state: AthleteState): string[] {
  const pool = new Map<BlockKey, ProgramExercise[][]>();
  const made: string[] = [];

  // Taken off first, so a block moved to another day keeps its exercises.
  week.forEach((day, i) => {
    for (const k of BLOCK_KEYS) {
      for (let n = 0; n < -delta[i][k]; n++) {
        const group = take(day, k);
        if (!group.length) break;
        pool.set(k, [...(pool.get(k) ?? []), group]);
        made.push(`${DAYS[i]}: removed ${blockDef(k).label}`);
      }
    }
  });
  week.forEach((day, i) => {
    for (const k of BLOCK_KEYS) {
      for (let n = 0; n < delta[i][k]; n++) {
        const group = pool.get(k)?.shift() ?? copyFrom(week, i, k) ?? build(k, state);
        if (!group?.length) break;
        put(day, k, group);
        made.push(`${DAYS[i]}: added ${blockDef(k).label}`);
      }
    }
  });
  week.forEach(d => d.isRestDay = d.exercises.length === 0);
  return made;
}

// Removes one of the block from the day (all of a group block's exercises) and returns what was removed.
function take(day: ProgramDay, k: BlockKey): ProgramExercise[] {
  const primerDay = hasPrimer(day);
  const of = (e: ProgramExercise) => blockOf(e, primerDay) === k;
  if (GROUP_BLOCKS.includes(k)) {
    const group = day.exercises.filter(of);
    day.exercises = day.exercises.filter(e => !of(e));
    return group;
  }
  const at = day.exercises.map(of).lastIndexOf(true);
  return at < 0 ? [] : day.exercises.splice(at, 1);
}

function copyFrom(week: ProgramDay[], skip: number, k: BlockKey): ProgramExercise[] | null {
  for (let j = 0; j < week.length; j++) {
    if (j === skip) continue;
    const primerDay = hasPrimer(week[j]);
    const found = week[j].exercises.filter(e => blockOf(e, primerDay) === k);
    if (found.length) return JSON.parse(JSON.stringify(GROUP_BLOCKS.includes(k) ? found : [found[found.length - 1]]));
  }
  return null;
}

function build(k: BlockKey, state: AthleteState): ProgramExercise[] | null {
  if (k === 'easy' || k === 'hard' || k === 'speed') return [session(k, state, 30)];
  if (k === 'primer') return primer(state);
  return null;
}

// Power goes first in a session, flexibility last, everything else before it.
function put(day: ProgramDay, k: BlockKey, group: ProgramExercise[]) {
  if (k === 'track' || k === 'primer') { day.exercises.unshift(...group); return; }
  if (k === 'flexibility') { day.exercises.push(...group); return; }
  const primerDay = hasPrimer(day);
  const tail = (e: ProgramExercise) => blockOf(e, primerDay) === 'flexibility';
  const at = day.exercises.findIndex(tail);
  day.exercises.splice(at < 0 ? day.exercises.length : at, 0, ...group);
}

export type { WeekBlocks };
