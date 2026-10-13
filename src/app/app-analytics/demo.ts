import { AppEvent, EVENTS, EventBatch, NEW_USER_FUNNEL, PAGES, TOUR_STEPS } from '../program-engine/analytics';

// Made-up usage in the shape the athlete app records, for seeing the page before real data arrives. Never stored.
export function demoBatches(now = Date.now()): EventBatch[] {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const out: EventBatch[] = [];
  const DAY = 86400000;
  // How likely a new athlete is to take each next step.
  const keep = [1, 0.92, 0.7, 0.95, 0.78, 0.55, 0.93, 0.62, 0.7, 0.45, 0.8];
  const pages = PAGES.map(p => p.path);
  const popular = ['/training', '/assessment', '/training/today', '/workout-log/session', '/trends', '/workout-log', '/leaderboard', '/program'];

  for (let i = 0; i < 160; i++) {
    const facility = rnd() < 0.25;
    const isNew = rnd() < 0.7;
    const start = now - Math.floor(rnd() * 88 + 1) * DAY - Math.floor(rnd() * DAY);
    const d = `demo-${i}`;
    let s = `s-${i}-0`, t = start;
    const ev: AppEvent[] = [];
    const push = (e: string, x?: string) => { t += 20000 + rnd() * 90000; ev.push({ e, t, s, ...(x ? { x } : {}) }); };
    push(EVENTS.open);
    let alive = true;
    if (isNew) {
      push(EVENTS.install);
      NEW_USER_FUNNEL.forEach((step, n) => {
        if (!alive || n === 0) return;
        if (rnd() > keep[n] + (facility ? 0.1 : 0)) { alive = false; return; }
        if (step.page) push(EVENTS.page, step.page);
        else if (step.event === EVENTS.tour) TOUR_STEPS.forEach((ts, k) => { if (alive && (k < 3 || rnd() < 0.9)) push(EVENTS.tour, ts.key); else alive = false; });
        else push(step.event!);
      });
      if (!alive && rnd() < 0.15) push(EVENTS.error, ['Waiver', 'Intake', 'Assessment submit'][Math.floor(rnd() * 3)]);
    } else push(EVENTS.upgrade);
    // Days they come back. Someone who stopped partway rarely does, and never past where they stopped.
    const loyalty = alive ? rnd() : rnd() * 0.15;
    for (let day = 1; day < 90; day++) {
      if (start + day * DAY > now) break;
      if (rnd() > loyalty * (day < 8 ? 0.6 : 0.35)) continue;
      s = `s-${i}-${day}`; t = start + day * DAY + rnd() * 3600000;
      push(EVENTS.open);
      const n = 2 + Math.floor(rnd() * 6);
      if (!alive) { push(EVENTS.page, '/auth'); continue; }
      for (let k = 0; k < n; k++) push(EVENTS.page, rnd() < 0.8 ? popular[Math.floor(rnd() * popular.length)] : pages[Math.floor(rnd() * pages.length)]);
      if (rnd() < 0.5) push(EVENTS.workout);
      if (rnd() < 0.06) { push(EVENTS.run, 'open'); if (rnd() < 0.8) push(EVENTS.run, 'source:strava'); if (rnd() < 0.6) push(EVENTS.run, 'scored'); if (rnd() < 0.5) push(EVENTS.run, 'used'); }
      if (rnd() < 0.02) push(EVENTS.error, 'Workout save');
    }
    out.push({ d, seg: facility ? 'facility' : (isNew && rnd() < 0.3 ? 'anon' : 'remote'), v: '1.4 (9)', pl: 'ios', day: new Date(t).toLocaleDateString('en-CA'), at: t, ev });
  }
  return out;
}
