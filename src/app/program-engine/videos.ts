import { RESILIENCE_TESTS } from '../services/omni.util';

// ---------- App videos ----------
//
//  The videos the app plays are not inside the build. Each one is a slot with a key; the coach app's App Videos page
//  uploads a video to a slot (Storage `appVideos/`, and a document in the `appVideos` collection with its address),
//  and the athlete app looks the address up by key. A video can be added or swapped without a new release.
//  The athlete app and the coach app share this file (the coach app copies it with scripts/sync-program-engine.sh).

export interface VideoSlot { key: string; title: string; group: string; }

// The assessment tests, as the About sheet lists them (its topic titles) and the key each one's video uses.
export const TEST_VIDEOS: Array<{ key: string; title: string; group: string }> = [
  { key: 'deadlift', title: 'Deadlift', group: 'Strength' },
  { key: 'squat', title: 'Squat', group: 'Strength' },
  { key: 'bench', title: 'Bench Press', group: 'Strength' },
  { key: 'longjump', title: 'Long Jump', group: 'Power' },
  { key: 'sprint', title: '100 m Sprint', group: 'Power' },
  { key: 'pushups', title: 'Push-ups', group: 'Endurance' },
  { key: 'pullups', title: 'Pull-ups', group: 'Endurance' },
  { key: 'run30', title: '30-Minute Run', group: 'Cardio' },
  { key: 'run800', title: '800 m Run', group: 'Cardio' },
  { key: 'pike', title: 'Pike', group: 'Flexibility' },
  { key: 'backbend', title: 'Backbend', group: 'Flexibility' },
  { key: 'straddle', title: 'Middle Split', group: 'Flexibility' }
];

export const testVideoKey = (title: string): string | null => {
  const t = TEST_VIDEOS.find(x => x.title === title);
  return t ? `test-${t.key}` : null;
};

// Flexibility: the base routine (the same for everyone) and one video each for pike, backbend and middle split.
export const flexVideoKey = (routine: string) => `flex-${routine}`;
export const resilienceVideoKey = (exercise: string) => `resilience-${exercise}`;
export const MORNING_VIDEO = 'morning';
export const EVENING_VIDEO = 'evening';

export function videoSlots(): VideoSlot[] {
  const resilience: VideoSlot[] = RESILIENCE_TESTS.map(t => ({ key: resilienceVideoKey(t.key), title: t.label, group: 'Resilience' }));
  return [
    { key: MORNING_VIDEO, title: 'Morning Fundamentals', group: 'Daily Routines' },
    { key: EVENING_VIDEO, title: 'Evening Stretch', group: 'Daily Routines' },
    { key: flexVideoKey('base'), title: 'Base Flexibility Routine', group: 'Flexibility' },
    { key: flexVideoKey('pike'), title: 'Pike', group: 'Flexibility' },
    { key: flexVideoKey('backbend'), title: 'Backbend', group: 'Flexibility' },
    { key: flexVideoKey('straddle'), title: 'Middle Split', group: 'Flexibility' },
    ...resilience,
    ...TEST_VIDEOS.map(t => ({ key: `test-${t.key}`, title: t.title, group: 'Assessment Tests' }))
  ];
}

// What a slot's document holds.
export interface AppVideo { url: string; path: string; name: string; bytes: number; updatedAt: string; }
