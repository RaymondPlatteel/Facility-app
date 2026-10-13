import type { OmniRank, ProgramDay, ProgramExercise } from '../services/firebase.service';
import { RESILIENCE_TESTS } from '../services/omni.util';

// ---------- Blocks ----------
//
//  The trainer (facility-app's Program Trainer) and its model work with a week as blocks, one per piece of the program, not as sets and reps. Anything that
//  changes from week to week is left out, since it is in the program whatever the week looks like: squat and
//  deadlift alternate, so both are "Squat or Deadlift"; max tests replace a session in some weeks, so they count
//  as that session; the monthly speed-endurance run is part of the track day.

// 'resilience' is no longer placed (it is a supplemental routine outside the program); older corrections may hold it.
export type BlockKey =
  'bench' | 'lower' | 'pullup' | 'pushups' | 'pullupEnd' |
  'easy' | 'hard' | 'speed' | 'track' | 'primer' | 'resilience' | 'flexibility';

export type BlockGroup = 'Strength' | 'Endurance' | 'Cardio' | 'Power' | 'Supplemental';

export interface BlockDef { key: BlockKey; label: string; group: BlockGroup; }

export const BLOCKS: BlockDef[] = [
  { key: 'bench', label: 'Bench Press', group: 'Strength' },
  { key: 'lower', label: 'Squat or Deadlift', group: 'Strength' },
  { key: 'pullup', label: 'Pull-up', group: 'Strength' },
  { key: 'pushups', label: 'Push-ups', group: 'Endurance' },
  { key: 'pullupEnd', label: 'Pull-up Endurance', group: 'Endurance' },
  { key: 'easy', label: 'Easy Cardio', group: 'Cardio' },
  { key: 'hard', label: 'Hard Cardio', group: 'Cardio' },
  { key: 'speed', label: 'Speed Intervals', group: 'Cardio' },
  { key: 'track', label: 'Track Day', group: 'Power' },
  { key: 'primer', label: 'Power Primer', group: 'Power' },
  { key: 'flexibility', label: 'Flexibility', group: 'Supplemental' }
];

export const BLOCK_KEYS: BlockKey[] = BLOCKS.map(b => b.key);
const KNOWN = new Set<string>(BLOCK_KEYS);
export const blockDef = (k: BlockKey) => BLOCKS.find(b => b.key === k)!;

// Monday first; each day lists its blocks in order.
export type WeekBlocks = BlockKey[][];

const RESILIENCE = new Set(RESILIENCE_TESTS.map(t => t.label));
const TRACK = /^(Broad jump|Acceleration sprints|Flying sprints|Speed endurance sprints|100 m sprint)$/;

// Blocks that stand for a group of exercises (the track day, the primer, flexibility) appear once a day.
export const GROUP_BLOCKS: BlockKey[] = ['track', 'primer', 'flexibility'];

// The block one exercise belongs to; null for anything the trainer does not place (accessories).
export function blockOf(e: ProgramExercise, dayHasPrimer: boolean): BlockKey | null {
  const n = e.name;
  const rpe = e.attributes.some(a => a.type === 'RPE');
  if (n === 'Barbell Bench Press') return 'bench';
  if (n === 'Barbell Squat' || n === 'Barbell Deadlift') return 'lower';
  if (n === 'Push-up') return 'pushups';
  if (/pull-up/i.test(n)) return rpe ? 'pullupEnd' : 'pullup';
  if (n === 'Easy cardio') return 'easy';
  if (n === 'Hard cardio') return 'hard';
  if (n === 'Speed intervals') return 'speed';
  if (n === 'Single-leg jumps') return 'primer';
  if (TRACK.test(n)) return dayHasPrimer ? 'primer' : 'track';
  if (RESILIENCE.has(n)) return null;
  if (/flexibility$/.test(n)) return 'flexibility';
  return null;
}
export const hasPrimer = (day: { exercises: ProgramExercise[] }) => day.exercises.some(e => e.name === 'Single-leg jumps');

// The blocks of one generated day.
export function dayBlocks(day: ProgramDay): BlockKey[] {
  const out: BlockKey[] = [];
  const primer = hasPrimer(day);
  for (const e of day.exercises) {
    const k = blockOf(e, primer);
    if (k && !(GROUP_BLOCKS.includes(k) && out.includes(k))) out.push(k);
  }
  return out;
}

export function weekBlocks(schedule: ProgramDay[]): WeekBlocks {
  return Array.from({ length: 7 }, (_, i) => schedule[i] ? dayBlocks(schedule[i]) : []);
}

export function counts(day: BlockKey[]): Record<BlockKey, number> {
  const c = {} as Record<BlockKey, number>;
  BLOCK_KEYS.forEach(k => c[k] = 0);
  day.forEach(k => { if (KNOWN.has(k)) c[k]++; });
  return c;
}

// How far one week is from another: every block one has and the other lacks, day by day.
export function distance(a: WeekBlocks, b: WeekBlocks): number {
  let d = 0;
  for (let i = 0; i < 7; i++) {
    const ca = counts(a[i] ?? []), cb = counts(b[i] ?? []);
    for (const k of BLOCK_KEYS) d += Math.abs(ca[k] - cb[k]);
  }
  return d;
}

// Share of the blocks the two weeks agree on, 0 to 1.
export function accuracy(a: WeekBlocks, b: WeekBlocks): number {
  let union = 0;
  for (let i = 0; i < 7; i++) {
    const ca = counts(a[i] ?? []), cb = counts(b[i] ?? []);
    for (const k of BLOCK_KEYS) union += Math.max(ca[k], cb[k]);
  }
  return union ? 1 - distance(a, b) / union : 1;
}

// Firestore keeps no arrays inside arrays, so a week is stored as { "0": [...], ..., "6": [...] }.
export function toStored(w: WeekBlocks): Record<string, BlockKey[]> {
  const out: Record<string, BlockKey[]> = {};
  w.forEach((d, i) => out[String(i)] = [...d]);
  return out;
}
export function fromStored(s: Record<string, BlockKey[]> | undefined): WeekBlocks {
  return Array.from({ length: 7 }, (_, i) => (s?.[String(i)] ?? []).filter(k => KNOWN.has(k)));
}

export const RANKS: OmniRank[] = ['UNRANKED', 'D-RANK', 'C-RANK', 'B-RANK', 'A-RANK', 'S-RANK'];
// A rank's level, Unranked 0 to S 5.
export const levelOf = (r: OmniRank) => RANKS.indexOf(r);

export const cloneWeek = (w: WeekBlocks): WeekBlocks => w.map(d => [...d]);
