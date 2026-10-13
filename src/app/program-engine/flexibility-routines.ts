import type { ProgramExercise } from '../services/firebase.service';
import { flexVideoKey } from './videos';

// ---------- Flexibility routines ----------
//
//  One base routine, the same for everyone, and one video each for pike, backbend and middle split. The rank-specific
//  guidance is spoken in the videos, so there is a single routine per test, not one per rank or length. The athlete
//  follows a video and ticks the routine off; there is no timer or duration to enter.
//
//  The videos are uploaded in the coach app's App Videos page (see videos.ts), not stored in the build.

export type FlexTest = 'pike' | 'backbend' | 'straddle';
export type FlexRoutine = 'base' | FlexTest;

export const TEST_LABEL: Record<FlexTest, string> = { pike: 'Pike', backbend: 'Backbend', straddle: 'Middle Split' };

// The routine an exercise carries, from its Routine attribute ("base", "pike"…; an older program holds "B-RANK|standard|pike",
// whose last part is the test).
export function routineOf(e: ProgramExercise, uploaded?: (key: string) => string): { routine: FlexRoutine; title: string; video: string } | null {
  const raw = e.attributes?.find(a => a.type === 'Routine')?.val ?? '';
  const part = raw.split('|').pop() ?? '';
  if (part !== 'base' && !(part in TEST_LABEL)) return null;
  const routine = part as FlexRoutine;
  return {
    routine,
    title: routine === 'base' ? 'Flexibility' : TEST_LABEL[routine],
    video: uploaded?.(flexVideoKey(routine)) ?? ''
  };
}
