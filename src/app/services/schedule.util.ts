import { PackageRecord, SessionOverride, SingleSession } from './firebase.service';

// A package with NO clientPayments at all isn't being tracked through
// online payment — that's a coach scheduling someone by hand and
// collecting payment their own way, same as always, unaffected by this.
// A package that DOES have a payment record but shows `paid: false` for
// someone is one the payment system is actively tracking as incomplete —
// that one shouldn't show as scheduled until it's actually paid, even
// though status may already say 'active' with days/times assigned.
// The one exception is `paymentPlan: true` — a client the coach has
// explicitly approved to pay later or in installments. That's a deliberate
// override of the same "not paid in full" state, not a payment the system
// forgot about, so it clears this check same as `paid` would.
//
// Only clients still in linkedClientIds count. `clientPayments` is keyed by
// client id and nothing ever removes an old entry when a client is
// unlinked from the package (see packages.page.ts's linked-clients editor),
// so a stale unpaid record for someone no longer even on the package would
// otherwise block scheduling for everyone still linked, with no visible
// sign why — exactly what happened when a removed client's leftover
// `paid: false` record silently blocked a package for the 3 people
// actually on it.
function hasUnpaidOnlineBalance(pkg: PackageRecord): boolean {
  const payments = pkg.clientPayments;
  if (!payments) return false;
  const linked = new Set(pkg.linkedClientIds || []);
  return Object.entries(payments).some(([clientId, p]) => linked.has(clientId) && !p.paid && !p.paymentPlan);
}

// One recurring training slot derived from an active package, OR a one-off
// SingleSession folded into the same shape (packageId `single:<id>`,
// isSingle true) so the whole Schedule page — cards, the session modal,
// attendance, calendar sync — can treat both the same way without a second
// code path. The two kinds only diverge where they must: reschedule (a
// per-occurrence override) doesn't apply to a single session, which has no
// recurring "original" slot to revert to — it's edited/deleted directly instead.
export interface ScheduleEntry {
  date: Date;            // local midnight of the day (after any reschedule)
  dateKey: string;       // YYYY-MM-DD (after any reschedule)
  time: string;          // 'HH:mm' or '' when no time set for that day
  packageId: string;
  packageName: string;
  sessionType: string;
  durationMinutes: number;
  clientNames: string[];
  clientIds: string[];
  // Identity of the recurring slot this entry came from (stable across reschedules).
  originalDateKey: string;
  originalTime: string;
  rescheduled: boolean;  // true when a reschedule override moved this occurrence
  overrideId?: string;
  isSingle?: boolean;       // true for a one-off SingleSession, not a package occurrence
  singleSessionId?: string; // the SingleSession doc id, when isSingle
  trainerId?: string;       // which trainer runs it; '' / undefined = unassigned
}

function overrideKey(packageId: string, originalDate: string): string {
  return `${packageId}|${originalDate}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function toDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

// Parse 'YYYY-MM-DD' (or ISO) as a LOCAL date to avoid UTC off-by-one.
function parseLocalDate(value?: string): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function startOfWeek(d: Date): Date {
  const day = dateOnly(d);
  const dow = day.getDay(); // 0 = Sunday
  const monOffset = (dow + 6) % 7; // days since Monday
  day.setDate(day.getDate() - monOffset);
  return day;
}

export function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + days);
  return next;
}

// For a `dailyGroupProgram` package (meets on a fixed schedule with no
// makeups — attendance is data, not what decrements sessions): counts how
// many of the package's scheduled weekdays have occurred from purchaseDate
// through `asOf` (today, by default), inclusive of both ends, capped at
// totalSessions since a package can't be "more than fully used". This
// replaces the check-in-derived count as sessionsUsed for these packages —
// see packages.page.ts's saveRow()/loadData().
export function countScheduledOccurrences(pkg: PackageRecord, asOf: Date = new Date()): number {
  const start = parseLocalDate(pkg.purchaseDate);
  if (!start || !(pkg.daysOfWeek?.length)) return 0;
  const days = new Set(pkg.daysOfWeek);
  const end = dateOnly(asOf);
  const cap = pkg.totalSessions ?? Infinity;
  let count = 0;
  for (let d = dateOnly(start); d <= end && count < cap; d = addDays(d, 1)) {
    if (days.has(DAY_LABELS[d.getDay()])) count++;
  }
  return count;
}

// Expand active packages into concrete schedule entries within [start, end] inclusive.
// Per-occurrence reschedule overrides relocate or pull in occurrences as needed.
export function generateScheduleForRange(
  packages: PackageRecord[],
  start: Date,
  end: Date,
  overrides: SessionOverride[] = [],
  singleSessions: SingleSession[] = [],
  // Which package statuses count as "schedulable" — defaults to active-only
  // everywhere (attendance, today's schedule, device calendar sync all want
  // just what's actually running). The packages-page calendar overview
  // passes ['active', 'completed'] so a package's history doesn't vanish
  // from the calendar the instant it wraps up.
  statuses: string[] = ['active']
): ScheduleEntry[] {
  const rangeStart = dateOnly(start);
  const rangeEnd = dateOnly(end);
  const inRange = (key: string) => {
    const d = parseLocalDate(key);
    return !!d && d >= rangeStart && d <= rangeEnd;
  };

  const pkgById = new Map<string, PackageRecord>();
  const active = packages.filter(p => statuses.includes(p.status) && (p.daysOfWeek?.length ?? 0) > 0 && !hasUnpaidOnlineBalance(p));
  for (const p of active) pkgById.set(p.id || p.packageId, p);

  const overrideByKey = new Map<string, SessionOverride>();
  for (const o of overrides) overrideByKey.set(overrideKey(o.packageId, o.originalDate), o);

  // Build an entry from a package's recurring slot on `originalDate`.
  const buildEntry = (pkg: PackageRecord, originalDate: Date): ScheduleEntry => {
    const label = DAY_LABELS[originalDate.getDay()];
    const originalDateKey = toDateKey(originalDate);
    const originalTime = pkg.dayTimes?.[label] || '';
    const override = overrideByKey.get(overrideKey(pkg.id || pkg.packageId, originalDateKey));

    const finalKey = override ? override.newDate : originalDateKey;
    const finalDate = parseLocalDate(finalKey) || new Date(originalDate);
    return {
      date: finalDate,
      dateKey: finalKey,
      time: override ? override.newTime : originalTime,
      packageId: pkg.id || pkg.packageId,
      packageName: pkg.packageName,
      sessionType: pkg.sessionType,
      durationMinutes: pkg.sessionDurationMinutes || 60,
      clientNames: pkg.linkedClientNames || [],
      clientIds: pkg.linkedClientIds || [],
      originalDateKey,
      originalTime,
      rescheduled: !!override,
      overrideId: override?.id,
      trainerId: pkg.trainerId || ''
    };
  };

  const entries: ScheduleEntry[] = [];
  const seen = new Set<string>();

  // 1) Walk recurring occurrences over the range, applying any override.
  for (const pkg of active) {
    const pkgStart = parseLocalDate(pkg.purchaseDate || undefined);
    const pkgEnd = parseLocalDate(pkg.expirationDate || undefined);
    const days = new Set(pkg.daysOfWeek);

    for (let d = new Date(rangeStart); d <= rangeEnd; d = addDays(d, 1)) {
      const label = DAY_LABELS[d.getDay()];
      if (!days.has(label)) continue;
      if (pkgStart && d < pkgStart) continue;
      if (pkgEnd && d > pkgEnd) continue;

      const entry = buildEntry(pkg, new Date(d));
      seen.add(overrideKey(entry.packageId, entry.originalDateKey));
      if (inRange(entry.dateKey)) entries.push(entry); // may have moved out of view
    }
  }

  // 2) Pull in occurrences that were rescheduled INTO the range from outside it.
  for (const o of overrides) {
    if (!inRange(o.newDate)) continue;
    const key = overrideKey(o.packageId, o.originalDate);
    if (seen.has(key)) continue;            // already handled above
    const pkg = pkgById.get(o.packageId);
    if (!pkg) continue;
    const origDate = parseLocalDate(o.originalDate);
    if (!origDate) continue;
    entries.push(buildEntry(pkg, origDate));
    seen.add(key);
  }

  // 3) One-off sessions — no recurrence, no override, just whatever date they're on.
  for (const s of singleSessions) {
    if (!s.id || !inRange(s.date)) continue;
    const date = parseLocalDate(s.date);
    if (!date) continue;
    entries.push({
      date,
      dateKey: s.date,
      time: s.time || '',
      packageId: `single:${s.id}`,
      packageName: s.title || 'Session',
      sessionType: s.sessionType,
      durationMinutes: s.durationMinutes || 60,
      clientNames: s.clientNames || [],
      clientIds: s.clientIds || [],
      originalDateKey: s.date,
      originalTime: s.time || '',
      rescheduled: false,
      isSingle: true,
      singleSessionId: s.id,
      trainerId: s.trainerId || ''
    });
  }

  return entries.sort((a, b) =>
    a.dateKey.localeCompare(b.dateKey) || (a.time || '99').localeCompare(b.time || '99')
  );
}

export function formatTime12h(time: string): string {
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return '';
  const [hh, mm] = time.split(':').map(n => parseInt(n, 10));
  const period = hh >= 12 ? 'PM' : 'AM';
  const hour = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour}:${String(mm).padStart(2, '0')} ${period}`;
}
