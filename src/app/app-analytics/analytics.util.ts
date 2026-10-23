import {
  AppEvent, ESTIMATE_STEPS, EVENTS, EventBatch, FunnelStep, NEW_USER_FUNNEL, PAGES, RUN_FUNNEL, TOUR_STEPS
} from '../program-engine/analytics';

// ---------- App analytics, worked out ----------
//
//  Everything the Analytics page shows, from the athlete app's anonymous event log (program-engine/analytics.ts).
//  A device is one athlete. Testers are left out. A device is an in-person facility member when the athlete it was
//  last linked to is one; every other device, including those that never got as far as linking, is remote.
//  Only the phone apps count: the web build is used for development and testing, not by athletes.

export type Section = 'remote' | 'facility';

const DAY = 86400000;

interface Device {
  id: string;
  section: Section;
  tester: boolean;
  events: AppEvent[];          // oldest first
  install: number | null;      // when they became a new user: first open, or creating an account
  first: number;               // first event of any kind
  days: Set<string>;           // days with any activity
}

export interface Bar {
  key: string; label: string; count: number; pctOfStart: number; dropFromPrev: number | null; worst?: boolean;
  who?: string[];      // the accounts that reached this step, when it is counted from their records
  missed?: string[];   // the accounts that did not
}
export interface DayPoint { day: string; users: number; }
export interface Cohort { week: string; users: number; d1: number | null; w1: number | null; w4: number | null; }
export interface PageRow { path: string; label: string; views: number; users: number; share: number; }
// One new athlete account, from the athlete's own record rather than from the usage log, so it counts the same whatever
// version of the app they have.
export interface AccountRow {
  name: string;
  intake: boolean;             // completed the intake form
  tourStep: string;            // the tour step the record holds, as written
  linkedAt: number;
  section: Section;
  tour: number;                // the furthest tour step reached: 0 for the first, -1 for none (see TOUR_ORDER)
  estimate: boolean;           // saved a starting estimate
  submittedVerified: boolean;  // sent a score that was approved
  savedUnreviewed: boolean;    // saved a score no coach will review: a private account, or a result sent without a video
  program: boolean;
  checkedIn: boolean;
  workout: boolean;
  goal: boolean;
  resilience: boolean;
  photo: boolean;
  results: boolean;            // has results in three or more tests
  board: boolean;              // is on the leaderboards: a public account with a level
  active: boolean;             // active in the last 7 days
}

// The tour as an athlete's record keeps it (tour.service.ts).
export const TOUR_ORDER = ['welcome', 'current', 'goals-tab', 'goals', 'resilience-tab', 'resilience', 'start', 'training', 'done'];

export interface JourneyGroup { title: string; note?: string; steps: Bar[]; }
export interface RetentionRow { label: string; share: number | null; back: number; of: number; }

export interface ErrorRow { what: string; count: number; users: number; }

export interface Report {
  newUsers: number;
  activeWeek: number;
  activeToday: number;
  back1: number | null;        // share of new users who came back a day or more later
  back7: number | null;
  sessionMinutes: number | null;
  sessionsPerUser: number | null;
  funnel: Bar[];
  worst: Bar | null;
  journey: JourneyGroup[];     // every step from opening the app to the first weeks, in order
  accountCount: number;
  journeyWorst: Bar | null;    // the step after which the most people are lost
  retention: RetentionRow[];   // 1 day, 1 week and 4 weeks           // the step that loses the most people
  daily: DayPoint[];
  cohorts: Cohort[];
  pages: PageRow[];            // opened, most first
  unused: PageRow[];           // opened by nobody, or by under 5% of active users
  allPages: PageRow[];         // every page of the app, most viewed first, including those nobody opened
  tour: Bar[];
  run: Bar[];
  errors: ErrorRow[];
  totalEvents: number;
}

const dayKey = (t: number) => new Date(t).toLocaleDateString('en-CA');

// Pages everyone passes through on the way in; they say nothing about which parts of the app are used.
const ENTRY_PAGES = new Set(['/auth', '/application', '/waiver']);

// One person per device, except that creating an account starts a new person: a phone that was someone else's (a
// tester's, or a family member's) counts the new account on its own from that moment.
function devices(batches: EventBatch[]): Device[] {
  type Tagged = AppEvent & { seg: EventBatch['seg'] };
  const byDevice = new Map<string, Tagged[]>();
  for (const b of batches) {
    if (b.pl === 'web') continue;
    const list = byDevice.get(b.d) ?? [];
    for (const e of b.ev ?? []) list.push({ ...e, seg: b.seg });
    byDevice.set(b.d, list);
  }
  const people: Device[] = [];
  for (const [id, list] of byDevice) {
    list.sort((a, b) => a.t - b.t);
    let part: Tagged[] = [], n = 0;
    const close = () => {
      if (!part.length) return;
      const known = part.filter(e => e.seg !== 'anon');
      const seg = known.length ? known[known.length - 1].seg : 'anon';
      const events: AppEvent[] = part.map(({ seg: _s, ...e }) => e);
      const start = events.find(e => e.e === EVENTS.install || e.e === EVENTS.signup)?.t ?? null;
      people.push({
        id: n ? `${id}#${n}` : id,
        section: seg === 'facility' ? 'facility' : 'remote',
        tester: part.some(e => e.seg === 'tester'),
        events,
        install: start,
        first: events[0]?.t ?? 0,
        days: new Set(events.map(e => dayKey(e.t)))
      });
      part = []; n++;
    };
    for (const e of list) {
      // A sign-up on a phone that was already someone's: it was in use before this tracking (upgrade), or an
      // account was already made on it. A brand-new install signing up is the same person carrying on.
      const owned = part.some(p => p.e === EVENTS.signup) || (part.length > 0 && !part.some(p => p.e === EVENTS.install));
      if (e.e === EVENTS.signup && owned) close();
      part.push(e);
    }
    close();
  }
  return people;
}

// Whether a device reached a step: the step's event (with its detail, if the step names one), or its page.
function reached(d: Device, s: FunnelStep): boolean {
  if (s.key === 'signup') return d.events.some(e => e.e === EVENTS.signup || e.e === EVENTS.signin);
  return d.events.some(e =>
    s.page ? (e.e === EVENTS.page && e.x === s.page)
    : e.e === s.event && (!s.x || (e.x ?? '').startsWith(s.x)));
}

// A step counts everyone who reached it or anything after it, so the bars only ever go down.
function bars(group: Device[], steps: Array<{ key: string; label: string; test: (d: Device) => boolean }>): Bar[] {
  const furthest = group.map(d => { let f = -1; steps.forEach((s, i) => { if (s.test(d)) f = i; }); return f; });
  const start = group.length;
  const out: Bar[] = steps.map((s, i) => {
    const count = furthest.filter(f => f >= i).length;
    return { key: s.key, label: s.label, count, pctOfStart: start ? count / start : 0, dropFromPrev: null };
  });
  out.forEach((b, i) => { if (i > 0 && out[i - 1].count) b.dropFromPrev = 1 - b.count / out[i - 1].count; });
  return out;
}

export function buildReport(batches: EventBatch[], section: Section, periodDays: number, accounts: AccountRow[] = [], now = Date.now()): Report {
  const all = devices(batches).filter(d => !d.tester && d.section === section);
  const since = now - periodDays * DAY;
  const today = dayKey(now);

  // ---- New users and how far they got ----
  const fresh = all.filter(d => d.install !== null && d.install >= since);
  const funnel = bars(fresh, NEW_USER_FUNNEL.map(s => ({ key: s.key, label: s.label, test: (d: Device) => reached(d, s) })));
  if (funnel.length) funnel[0].count = fresh.length;
  // The worst step: the one that loses the most people.
  let worst: Bar | null = null, most = 0;
  funnel.forEach((b, i) => {
    const lost = i ? funnel[i - 1].count - b.count : 0;
    if (lost > most) { most = lost; worst = b; }
  });
  if (worst) (worst as Bar).worst = true;

  // ---- The journey, step by step ----
  // The accounts come from the athletes' own records, so they are counted the same whatever version of the app people
  // have. The usage log only fills in the opening of the app, and who opened the walkthrough without finishing it.
  const mine = accounts.filter(a => a.section === section && a.linkedAt >= since);
  const N = mine.length;
  const opened = Math.max(fresh.length, N);
  const signedUp = Math.max(fresh.filter(d => d.events.some(e => e.e === EVENTS.signup)).length, N);
  const mk = (key: string, label: string, count: number, base: number): Bar => ({ key, label, count, pctOfStart: base ? Math.min(1, count / base) : 0, dropFromPrev: null });
  // A step counted from the athletes' own records, which can say who reached it.
  const mkA = (key: string, label: string, test: (a: AccountRow) => boolean, base: number): Bar => {
    const b = mk(key, label, mine.filter(test).length, base);
    b.who = mine.filter(test).map(a => a.name);
    b.missed = mine.filter(a => !test(a)).map(a => a.name);
    return b;
  };
  const link = (steps: Bar[]) => { steps.forEach((b, i) => { if (i > 0 && steps[i - 1].count > b.count) b.dropFromPrev = 1 - b.count / steps[i - 1].count; }); return steps; };

  const start = link([
    mk('opened', 'Opened the app', opened, opened),
    Object.assign(mk('signup', 'Created an account', signedUp, opened), { who: mine.map(a => a.name), missed: [] as string[] }),
    mkA('intake', 'Completed the intake form', () => true, opened)
  ]);

  // The walkthrough is the same for everyone, so it is one step: those who saved a starting estimate.
  const walk = [mkA('walk-saved', 'Walkthrough', a => a.estimate, N)];

  const tourSteps: Array<{ key: string; label: string }> = [...TOUR_STEPS, { key: 'done', label: 'Finished the tour' }];
  // The tour starts before the tests (Welcome to Start the tests) and finishes after the starting estimate is saved
  // (Training, then done), so it is shown on either side of the walkthrough.
  const tourAll = tourSteps.map((t, i) => mk('tour-' + t.key, t.label, mine.filter(a => a.tour >= i).length, N));
  tourAll.forEach((b, i) => { b.who = mine.filter(a => a.tour >= i).map(a => a.name); b.missed = mine.filter(a => !(a.tour >= i)).map(a => a.name); });
  const split = tourSteps.findIndex(t => t.key === 'training');
  const tourBefore = link(tourAll.slice(0, split));
  const tourAfter = link(tourAll.slice(split));

  const later = link([
    mkA('sub-verified', 'Sent a score that was verified', a => a.submittedVerified, N),
    mkA('sub-unreviewed', 'Saved a score without review (private account or no video)', a => a.savedUnreviewed, N),
    mkA('program', 'Set up a program', a => a.program, N),
    mkA('checkin', 'Checked in', a => a.checkedIn, N),
    mkA('workout', 'Logged a workout', a => a.workout, N),
    mkA('goal', 'Set a goal', a => a.goal, N),
    mkA('resilience', 'Entered a Resilience score', a => a.resilience, N),
    mkA('photo', 'Added a profile photo', a => a.photo, N),
    mkA('results', 'Has results in 3 or more tests', a => a.results, N),
    mkA('board', 'On the leaderboards', a => a.board, N),
    mkA('active', 'Active in the last 7 days', a => a.active, N)
  ]);
  // Later lines are counted on their own, so a drop between two of them means nothing.
  later.forEach(b => (b.dropFromPrev = null));

  const journey: JourneyGroup[] = [
    { title: 'Getting in', steps: start },
    { title: 'Tour, before the tests', note: 'The tour runs first and ends at "Start the tests", which opens the walkthrough below.', steps: tourBefore },
    { title: 'Starting level walkthrough', note: 'Counted from the athlete\'s record: a starting estimate was saved.', steps: walk },
    { title: 'Tour, after the tests', note: 'These come after the starting estimate is saved, so fewer people reach them than reached the start of the tour.', steps: tourAfter },
    { title: 'After joining', note: 'Each line is counted on its own, for the new accounts of this period.', steps: later }
  ];
  // The step after which the most people are lost, in the steps that follow one another.
  let journeyWorst: Bar | null = null, journeyMost = 0;
  [start, tourBefore, walk, tourAfter].forEach(group => group.forEach((b, i) => {
    const lost = i ? group[i - 1].count - b.count : 0;
    if (lost > journeyMost) { journeyMost = lost; journeyWorst = b; }
  }));
  if (journeyWorst) (journeyWorst as Bar).worst = true;

  const tour = bars(fresh.filter(d => d.events.some(e => e.e === EVENTS.tour)),
    TOUR_STEPS.map(s => ({ key: s.key, label: s.label, test: (d: Device) => d.events.some(e => e.e === EVENTS.tour && e.x === s.key) })));
  const runners = all.filter(d => d.events.some(e => e.e === EVENTS.run && e.t >= since));
  const run = bars(runners, RUN_FUNNEL.map(s => ({ key: s.key, label: s.label, test: (d: Device) => reached(d, s) })));

  // ---- Activity ----
  const daily: DayPoint[] = [];
  for (let i = periodDays - 1; i >= 0; i--) {
    const day = dayKey(now - i * DAY);
    daily.push({ day, users: all.filter(d => d.days.has(day)).length });
  }
  const weekAgo = now - 7 * DAY;
  const activeWeekList = all.filter(d => d.events.some(e => e.t >= weekAgo));
  const activeWeek = activeWeekList.length;
  const activeToday = all.filter(d => d.days.has(today)).length;

  // ---- Coming back: new users only ----
  const cameBack = (d: Device, n: number): boolean | null => {
    const start = d.install!;
    if (now - start < n * DAY) return null;   // too soon to know
    const firstDay = new Date(dayKey(start)).getTime();
    return d.events.some(e => e.t >= firstDay + n * DAY);
  };
  const rate = (list: Device[], n: number): { share: number | null; back: number; of: number } => {
    const known = list.map(d => cameBack(d, n)).filter((v): v is boolean => v !== null);
    return { share: known.length ? known.filter(Boolean).length / known.length : null, back: known.filter(Boolean).length, of: known.length };
  };
  const share = (list: Device[], n: number): number | null => {
    const known = list.map(d => cameBack(d, n)).filter((v): v is boolean => v !== null);
    return known.length ? known.filter(Boolean).length / known.length : null;
  };
  const weeks = new Map<string, Device[]>();
  for (const d of fresh) {
    const t = new Date(d.install!); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - ((t.getDay() + 6) % 7));   // Monday
    const k = dayKey(t.getTime());
    weeks.set(k, [...(weeks.get(k) ?? []), d]);
  }
  const cohorts: Cohort[] = [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]))
    .map(([week, list]) => ({ week, users: list.length, d1: share(list, 1), w1: share(list, 7), w4: share(list, 28) }));
  const retention: RetentionRow[] = [{ label: '1 day', n: 1 }, { label: '1 week', n: 7 }, { label: '4 weeks', n: 28 }].map(r => ({ label: r.label, ...(({ share, back, of }) => ({ share, back, of }))(rate(fresh, r.n)) }));

  // ---- Sessions ----
  const sessions = new Map<string, { a: number; b: number; n: number }>();
  for (const d of all) for (const e of d.events) {
    if (e.t < since) continue;
    const s = sessions.get(e.s) ?? { a: e.t, b: e.t, n: 0 };
    s.a = Math.min(s.a, e.t); s.b = Math.max(s.b, e.t); s.n++;
    sessions.set(e.s, s);
  }
  const lengths = [...sessions.values()].filter(s => s.n > 1).map(s => (s.b - s.a) / 60000).sort((a, b) => a - b);
  const activeInPeriod = all.filter(d => d.events.some(e => e.t >= since)).length;

  // ---- Pages ----
  const views = new Map<string, { views: number; users: Set<string> }>();
  for (const d of all) for (const e of d.events) {
    if (e.e !== EVENTS.page || e.t < since || !e.x || ENTRY_PAGES.has(e.x)) continue;
    const v = views.get(e.x) ?? { views: 0, users: new Set<string>() };
    v.views++; v.users.add(d.id); views.set(e.x, v);
  }
  const label = (p: string) => PAGES.find(x => x.path === p)?.label ?? p;
  const rows: PageRow[] = [...new Set([...PAGES.map(p => p.path), ...views.keys()])].filter(path => !ENTRY_PAGES.has(path)).map(path => {
    const v = views.get(path);
    return { path, label: label(path), views: v?.views ?? 0, users: v?.users.size ?? 0, share: activeInPeriod ? (v?.users.size ?? 0) / activeInPeriod : 0 };
  });
  const pages = rows.filter(r => r.views > 0).sort((a, b) => b.users - a.users || b.views - a.views);
  const unused = rows.filter(r => r.share < 0.05).sort((a, b) => a.users - b.users || a.label.localeCompare(b.label));

  // ---- Errors ----
  const errs = new Map<string, { count: number; users: Set<string> }>();
  for (const d of all) for (const e of d.events) {
    if (e.e !== EVENTS.error || e.t < since) continue;
    const k = e.x || 'Unknown';
    const v = errs.get(k) ?? { count: 0, users: new Set<string>() };
    v.count++; v.users.add(d.id); errs.set(k, v);
  }

  return {
    newUsers: fresh.length,
    activeWeek,
    activeToday,
    back1: share(fresh, 1),
    back7: share(fresh, 7),
    sessionMinutes: lengths.length ? lengths[Math.floor(lengths.length / 2)] : null,
    sessionsPerUser: activeInPeriod ? sessions.size / activeInPeriod / Math.max(1, periodDays / 7) : null,
    funnel,
    worst,
    journey,
    accountCount: N,
    journeyWorst,
    retention,
    daily,
    cohorts,
    pages,
    unused,
    allPages: [...rows].sort((a, b) => b.views - a.views || a.label.localeCompare(b.label)),
    tour,
    run,
    errors: [...errs.entries()].map(([what, v]) => ({ what, count: v.count, users: v.users.size })).sort((a, b) => b.count - a.count),
    totalEvents: all.reduce((t, d) => t + d.events.filter(e => e.t >= since).length, 0)
  };
}
