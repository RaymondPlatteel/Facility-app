import type { ProgramDay, ProgramExercise } from '../services/firebase.service';
import { RESILIENCE_TESTS } from '../services/omni.util';

// A day in a few words: what kind of day it is, without the exercises, sets or reps.
export function dayFocus(day: ProgramDay | undefined): string {
  const names = (day?.exercises ?? []).map(e => e.name);
  if (!names.length) return 'Rest';
  const resilience = new Set(RESILIENCE_TESTS.map(t => t.label));
  const upper = names.includes('Barbell Bench Press');
  const lower = names.some(n => n === 'Barbell Squat' || n === 'Barbell Deadlift');
  const parts: string[] = [];
  if (upper && lower) parts.push('Full body');
  else if (upper) parts.push('Upper body');
  else if (lower) parts.push('Lower body');
  if (names.some(n => resilience.has(n))) parts.push('Resilience');
  if (names.some(n => /jump|sprint|acceleration/i.test(n))) parts.push('Power');
  if (names.some(n => /cardio|speed intervals/i.test(n))) parts.push('Cardio');
  if (names.some(n => /flexibility/i.test(n))) parts.push('Flexibility');
  return parts.join(' · ') || 'Training';
}

// Cardio is its own part of the day, apart from the workout.
export type DayPart = 'cardio' | 'workout';
export function isCardioExercise(e: { name?: string }): boolean {
  return /cardio|speed intervals/i.test(e.name ?? '');
}
export function partExercises(day: ProgramDay | null | undefined, part: DayPart | null | undefined): ProgramExercise[] {
  const all = day?.exercises ?? [];
  if (part === 'cardio') return all.filter(isCardioExercise);
  const rest = all.filter(e => !isCardioExercise(e));
  return rest.length ? rest : all;   // a day of nothing but cardio is its own workout
}
export function dayPart(day: ProgramDay | null | undefined, part: DayPart | null | undefined): ProgramDay | null {
  return day ? { ...day, exercises: partExercises(day, part) } : null;
}
