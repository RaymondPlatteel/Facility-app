// Numbers behind the Workout Log: what a set was worth, what a session
// added up to, and how a lift compares with the athlete's history.
import type { LoggedExercise, SetLog } from '../services/firebase.service';
import { brzycki, matchAssessmentLift } from '../services/omni.util';
import { durationSeconds } from '../services/attributes';

export function toNumber(text: unknown): number | null {
  if (typeof text === 'number') return isFinite(text) ? text : null;
  const n = parseFloat(String(text ?? '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

export function normName(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// What makes two logged exercises "the same lift": the benchmark lift they
// both are (Squat, Back Squats and Barbell Squat are one), else the name
// with spacing, case and a trailing plural ignored.
export function exerciseKey(name: string): string {
  const lift = matchAssessmentLift(name);
  if (lift) return `lift:${lift.key}`;
  if (isPullUp(name)) return 'lift:pullup';
  return normName(name).replace(/s$/, '');
}

// Pull-ups and chin-ups are no longer a scored benchmark, but they still
// log as one exercise whatever the variation.
function isPullUp(name: string): boolean {
  const n = (name || '').toLowerCase();
  return ['pull-up', 'pullup', 'pull up', 'chin-up', 'chinup', 'chin up'].some(x => n.includes(x));
}

// Bodyweight lifts log added weight, which says nothing about a max.
export function tracksMax(name: string): boolean {
  return !isPullUp(name);
}

export function loadOf(set: SetLog): number | null {
  return toNumber(set.values?.['Load'] ?? set.values?.['Weight']);
}

export function repsOf(set: SetLog): number | null {
  return toNumber(set.values?.['Reps']);
}

// Estimated one-rep max for a set; sets past 12 reps say too little about
// strength to count.
export function setE1rm(set: SetLog): number | null {
  const load = loadOf(set);
  const reps = repsOf(set);
  if (!load || load <= 0 || !reps || reps < 1 || reps > 12) return null;
  return brzycki(load, reps);
}

// Nearest 5 lb, the way plates go on.
export function roundLoad(n: number): number {
  return Math.round(n / 5) * 5;
}

// A set only counts toward the numbers once it's ticked off, and a warm-up
// never does.
export function counts(set: SetLog): boolean {
  return !!set.done && !set.warmup;
}

export function setVolume(set: SetLog): number {
  if (!counts(set)) return 0;
  const load = loadOf(set);
  const reps = repsOf(set);
  return load && reps ? load * reps : 0;
}

export interface SessionStats {
  sets: number;
  setsDone: number;
  exercisesDone: number;
  volume: number;
  seconds: number;   // time logged in duration columns
}

export function sessionStats(entries: LoggedExercise[]): SessionStats {
  const out: SessionStats = { sets: 0, setsDone: 0, exercisesDone: 0, volume: 0, seconds: 0 };
  for (const e of entries) {
    out.sets += e.sets.length;
    const done = e.sets.filter(s => s.done).length;
    out.setsDone += done;
    if (e.sets.length && done === e.sets.length) out.exercisesDone++;
    for (const s of e.sets) {
      out.volume += setVolume(s);
      if (counts(s) && e.attrColumns.includes('Duration')) out.seconds += durationSeconds(s.values?.['Duration'] || '');
    }
  }
  return out;
}

// Index of the set that beat everything the athlete had done before on this
// lift, or -1. Only the best set of the session is flagged.
export function prSetIndex(sets: SetLog[], priorBest: number | null | undefined): number {
  if (!priorBest) return -1;
  let best = priorBest;
  let at = -1;
  sets.forEach((s, i) => {
    if (!counts(s)) return;
    const e = setE1rm(s);
    if (e && e > best + 0.5) { best = e; at = i; }
  });
  return at;
}

// The set worth remembering from an exercise: the heaviest by estimated max,
// else the longest hold.
export function topSetLabel(e: LoggedExercise): string {
  const done = e.sets.filter(counts);
  if (!done.length) return '';
  let best: SetLog | null = null;
  let bestScore = 0;
  for (const s of done) {
    const score = setE1rm(s) ?? loadOf(s) ?? 0;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  if (best) {
    const reps = repsOf(best);
    const load = loadOf(best);
    return reps && load ? `${reps} × ${trim(load)}` : load ? `${trim(load)}` : '';
  }
  if (e.attrColumns.includes('Duration')) {
    const longest = Math.max(...done.map(s => durationSeconds(s.values?.['Duration'] || '')));
    if (longest > 0) return `${Math.floor(longest / 60)}:${String(longest % 60).padStart(2, '0')}`;
  }
  return '';
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// What a previous set looked like, short enough for a narrow column:
// "8 × 175 · RIR 1".
export function prevLabel(set: SetLog | undefined, columns: string[]): string {
  if (!set) return '';
  const v = set.values || {};
  const reps = columns.includes('Reps') ? v['Reps'] : '';
  const load = columns.includes('Load') ? v['Load'] ?? v['Weight'] : columns.includes('Weight') ? v['Weight'] : '';
  const head = reps && load ? `${reps} × ${load}` : reps || load || '';
  const rest = columns
    .filter(c => c !== 'Reps' && c !== 'Load' && c !== 'Weight')
    .map(c => (v[c] ? (c === 'RIR' || c === 'RPE' ? `${c} ${v[c]}` : v[c]) : ''))
    .filter(Boolean);
  return [head, ...rest].join(' · ');
}

export function formatVolume(v: number): string {
  if (v >= 100000) return `${Math.round(v / 1000)}k`;
  return Math.round(v).toLocaleString('en-US');
}

// A saved session in one line: "5 ex · 14 sets · 8,400 lb". Counts what was
// recorded, not what was ticked — older logs never used the tick.
export interface LogSummary {
  exercises: number;
  sets: number;
  volume: number;
}

export function summarizeLog(log: { exercises: LoggedExercise[] }): LogSummary {
  const out: LogSummary = { exercises: log.exercises.length, sets: 0, volume: 0 };
  for (const e of log.exercises) {
    for (const s of e.sets) {
      if (!s.done && !Object.values(s.values || {}).some(v => (v || '').trim())) continue;
      out.sets++;
      if (s.warmup) continue;
      const load = loadOf(s);
      const reps = repsOf(s);
      if (load && reps) out.volume += load * reps;
    }
  }
  return out;
}

// Any value typed, or the set ticked off.
export function hasEntered(entries: LoggedExercise[]): boolean {
  return entries.some(e => e.sets.some(s => s.done || Object.values(s.values || {}).some(v => (v || '').trim())));
}
