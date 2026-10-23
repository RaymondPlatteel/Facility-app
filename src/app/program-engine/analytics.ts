// ---------- App analytics ----------
//
//  The athlete app keeps an anonymous event log in the `appEvents` collection: no names, only a random id for the
//  device, the pages opened and the steps a new athlete takes. The coach app's Analytics page reads it. Both apps share
//  this file (the coach app copies it with scripts/sync-program-engine.sh), so the step names cannot drift apart.
//
//  One document per upload, holding a few seconds to a few minutes of events from one device.

export type Segment = 'remote' | 'facility' | 'tester' | 'anon';

export interface AppEvent {
  e: string;      // event name, see EVENTS
  t: number;      // when, ms since 1970
  s: string;      // session id
  x?: string;     // detail: the page for 'page', the step for 'tour', the source for 'run'…
}

export interface EventBatch {
  d: string;      // device id (random, made on first open)
  seg: Segment;   // the athlete's kind when uploaded; 'anon' before an athlete is linked
  v: string;      // app version
  pl: string;     // 'ios' | 'android' | 'web'
  day: string;    // YYYY-MM-DD of the upload, for reading a period
  at: number;     // upload time, ms
  ev: AppEvent[];
}

export const EVENTS = {
  install: 'install',       // first open on a device with no one signed in: a new user
  upgrade: 'upgrade',       // first open after this tracking shipped, already signed in: an existing user
  open: 'open',             // a session starts (first event, or 30 minutes after the last one)
  page: 'page',             // x: the page path, ids replaced by :id
  signup: 'signup',
  signin: 'signin',
  intake: 'intake',         // intake form submitted
  waiver: 'waiver',
  estimate: 'estimate',     // x: '<number>:<test>', each step of the starting-level walkthrough as it is shown
  tour: 'tour',             // x: the tour step reached
  baseline: 'baseline',     // starting estimate saved, which ends the tour
  programSetup: 'program_setup',
  subscribe: 'subscribe',
  checkin: 'checkin',
  workout: 'workout',
  assessment: 'assessment', // a result submitted for review
  run: 'run',               // x: 'open' | 'source:<name>' | 'scored' | 'used'
  error: 'error'            // x: what failed
} as const;

// A step a new athlete reaches: an event, or a page they open.
export interface FunnelStep { key: string; label: string; event?: string; page?: string; x?: string; }

// The path from opening the app to training, in order.
export const NEW_USER_FUNNEL: FunnelStep[] = [
  { key: 'install', label: 'Opened the app', event: EVENTS.install },
  { key: 'auth', label: 'Saw sign-in', page: '/auth' },
  { key: 'signup', label: 'Created an account', event: EVENTS.signup },
  { key: 'intake-open', label: 'Started intake', page: '/application' },
  { key: 'intake', label: 'Submitted intake', event: EVENTS.intake },
  { key: 'tour', label: 'Started the tour', event: EVENTS.tour },
  { key: 'baseline', label: 'Saved a starting estimate', event: EVENTS.baseline },
  { key: 'setup', label: 'Set up a program', event: EVENTS.programSetup },
  { key: 'subscribe', label: 'Subscribed', event: EVENTS.subscribe },
  { key: 'workout', label: 'Logged a workout', event: EVENTS.workout }
];

// The guided tour, step by step (tour.service.ts).
export const TOUR_STEPS: Array<{ key: string; label: string }> = [
  { key: 'welcome', label: 'Welcome' },
  { key: 'current', label: 'Level and Rank' },
  { key: 'goals-tab', label: 'Goals tab' },
  { key: 'goals', label: 'Goals' },
  { key: 'resilience-tab', label: 'Resilience tab' },
  { key: 'resilience', label: 'Resilience' },
  { key: 'start', label: 'Start the tests' },
  { key: 'training', label: 'Training' }
];

// The starting-level walkthrough (get-started.page.ts), one step for each test, in order.
export const ESTIMATE_STEPS: Array<{ key: string; label: string }> = [
  'Deadlift', 'Squat', 'Bench Press', 'Push-ups', 'Pull-ups', 'Standing Long Jump', '100m Sprint', '30-Minute Run', '400 m Run', 'Pike', 'Backbend', 'Middle Split'
].map((t, i) => ({ key: `${i + 1}:`, label: t }));

// The 30-Minute Run import, in order.
export const RUN_FUNNEL: FunnelStep[] = [
  { key: 'open', label: 'Opened import', event: EVENTS.run, x: 'open' },
  { key: 'source', label: 'Chose a source', event: EVENTS.run, x: 'source' },
  { key: 'scored', label: 'Run read and scored', event: EVENTS.run, x: 'scored' },
  { key: 'used', label: 'Used as score', event: EVENTS.run, x: 'used' }
];

// Every page of the athlete app, with the name the coach reads, so pages nobody opens still show.
export const PAGES: Array<{ path: string; label: string }> = [
  { path: '/auth', label: 'Sign in' },
  { path: '/application', label: 'Intake' },
  { path: '/home', label: 'World' },
  { path: '/get-started', label: 'Get Started' },
  { path: '/assessment', label: 'Profile' },
  { path: '/history', label: 'Assessment History' },
  { path: '/new-assessment', label: 'Submit Results' },
  { path: '/goals', label: 'Goals' },
  { path: '/new-resilience', label: 'Resilience Results' },
  { path: '/training', label: 'Training' },
  { path: '/training/today', label: 'Today' },
  { path: '/fundamentals', label: 'Fundamentals' },
  { path: '/daily-check-in', label: 'Daily Check-In' },
  { path: '/workout-log', label: 'Workout Log' },
  { path: '/workout-log/session', label: 'Workout' },
  { path: '/workout-log/session/:id', label: 'Workout (saved)' },
  { path: '/trends', label: 'Trends' },
  { path: '/program', label: 'Program' },
  { path: '/program/setup', label: 'Program Setup' },
  { path: '/program/support', label: 'Program Support' },
  { path: '/schedule', label: 'Schedule' },
  { path: '/membership', label: 'Membership' },
  { path: '/leaderboard', label: 'Leaderboard' },
  { path: '/activity', label: 'Activity' },
  { path: '/lookup', label: 'Lookup' },
  { path: '/shop', label: 'Shop' },
  { path: '/settings', label: 'Settings' },
  { path: '/ai-chat', label: 'AI Chat' },
  { path: '/job-board', label: 'Job Board' },
  { path: '/vote/:id', label: 'Vote' },
  { path: '/reserve/:id', label: 'Reserve' }
];

// A page path with ids replaced, so every workout or vote counts as one page.
export function pagePath(url: string): string {
  const path = url.split(/[?#]/)[0] || '/';
  return path.split('/').map(seg => (/^\d+$/.test(seg) || /^[A-Za-z0-9_-]{16,}$/.test(seg) ? ':id' : seg)).join('/') || '/';
}
