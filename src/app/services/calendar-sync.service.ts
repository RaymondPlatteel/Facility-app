import { Injectable } from '@angular/core';
import { debounceTime } from 'rxjs/operators';
import { Capacitor } from '@capacitor/core';
import { CapacitorCalendar, CalendarPermissionScope } from '@ebarooni/capacitor-calendar';
import { ScheduleEntry, generateScheduleForRange, addDays } from './schedule.util';
import { FirebaseService } from './firebase.service';

const CALENDAR_NAME = 'Facility App Schedule';
const ENABLED_KEY = 'calendarSync.enabled';
const CALENDAR_ID_KEY = 'calendarSync.calendarId';
const EVENT_MAP_KEY = 'calendarSync.eventIdsByEntryKey';

// Syncs the coach's own device calendar with their training schedule, opt-in
// and native-only (iOS EventKit via Capacitor — there's no equivalent in a
// browser tab, so this silently no-ops on web). Everything lives in a single
// dedicated "Facility App Schedule" calendar rather than the user's default
// one, so turning sync off can cleanly remove everything it added without
// touching any of the user's own events, and so it's obvious in the Calendar
// app which events came from here.
//
// Each synced event is keyed by `packageId|originalDateKey` — the same
// identity SessionOverride already uses — so rescheduling a session moves
// its calendar event instead of leaving a stale one behind and creating a
// duplicate.
@Injectable({ providedIn: 'root' })
export class CalendarSyncService {
  constructor(private firebase: FirebaseService) {
    // Re-sync after every package / override / one-off-session write, from
    // anywhere in the app. Debounced so a burst of writes — the Packages
    // page recalculating several rows on load, or a few quick edits in a
    // row — collapses into a single sync instead of one per write.
    // syncCurrentSchedule() already no-ops when sync is off or unsupported.
    this.firebase.scheduleDataChanged$
      .pipe(debounceTime(1500))
      .subscribe(() => {
        this.syncCurrentSchedule().catch(err =>
          console.error('CalendarSync: auto-sync after data change failed', err));
      });
  }

  get isSupported(): boolean {
    return Capacitor.isNativePlatform();
  }

  get isEnabled(): boolean {
    return this.isSupported && localStorage.getItem(ENABLED_KEY) === 'true';
  }

  private get calendarId(): string | null {
    return localStorage.getItem(CALENDAR_ID_KEY);
  }

  private get eventMap(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(EVENT_MAP_KEY) || '{}');
    } catch {
      return {};
    }
  }

  private set eventMap(map: Record<string, string>) {
    localStorage.setItem(EVENT_MAP_KEY, JSON.stringify(map));
  }

  // Requests write access and resolves the dedicated calendar. Returns false
  // (without throwing) if the user declines the permission prompt.
  async enable(): Promise<boolean> {
    if (!this.isSupported) return false;
    const { result } = await CapacitorCalendar.requestWriteOnlyCalendarAccess();
    if (result !== 'granted') return false;

    const id = await this.resolveCalendarId(true);
    if (!id) return false;

    localStorage.setItem(ENABLED_KEY, 'true');
    return true;
  }

  // Removes the dedicated calendar(s) and forgets all locally-tracked event
  // ids. Deletes EVERY calendar named CALENDAR_NAME, not just the id we
  // happen to have cached — that's what lets a coach who already piled up
  // duplicates clear them all with one toggle instead of deleting each by
  // hand in the Calendar app.
  async disable(): Promise<void> {
    if (this.isSupported) {
      const cached = this.calendarId;
      try {
        const { result: calendars } = await CapacitorCalendar.listCalendars();
        const ours = calendars.filter(c => c.title === CALENDAR_NAME || c.id === cached);
        for (const cal of ours) {
          try {
            await CapacitorCalendar.deleteCalendar({ id: cal.id });
          } catch (err) {
            console.error('CalendarSync: failed to delete calendar', cal.id, err);
          }
        }
      } catch (err) {
        // Couldn't enumerate — still try the one id we know about.
        console.error('CalendarSync: failed to list calendars on disable', err);
        if (cached) {
          try {
            await CapacitorCalendar.deleteCalendar({ id: cached });
          } catch (e) {
            console.error('CalendarSync: failed to delete cached calendar', e);
          }
        }
      }
    }
    localStorage.removeItem(ENABLED_KEY);
    localStorage.removeItem(CALENDAR_ID_KEY);
    localStorage.removeItem(EVENT_MAP_KEY);
  }

  // The single place that decides which calendar to write to. Always looks
  // for an existing "Facility App Schedule" BY NAME before creating one.
  //
  // This is the duplicate-calendar fix. The old code only validated the id
  // cached in localStorage, so any time that cache was lost — reinstall,
  // storage cleared, restore from backup — it created ANOTHER calendar with
  // the same name alongside the one already on the device, and whatever
  // sharing had been set up on the old one was left behind with it.
  private async resolveCalendarId(createIfMissing: boolean): Promise<string | null> {
    if (!this.isSupported) return null;

    const cached = this.calendarId;
    let found: string | null = null;
    try {
      const { result: calendars } = await CapacitorCalendar.listCalendars();
      if (cached && calendars.some(c => c.id === cached)) {
        found = cached;
      } else {
        found = calendars.find(c => c.title === CALENDAR_NAME)?.id ?? null;
      }
    } catch (err) {
      // Can't enumerate — trust the cached id rather than risk creating a
      // duplicate on a transient failure.
      console.error('CalendarSync: listCalendars failed', err);
      return cached;
    }

    if (found) {
      if (found !== cached) {
        // Adopting a calendar we weren't previously tracking: our event map
        // doesn't describe its contents, so syncing as-is would recreate
        // every event on top of the ones already there. Start it from a
        // known-empty state instead.
        localStorage.setItem(CALENDAR_ID_KEY, found);
        await this.clearCalendarEvents(found);
        this.eventMap = {};
      }
      return found;
    }

    if (!createIfMissing) return null;
    const created = await CapacitorCalendar.createCalendar({ title: CALENDAR_NAME, color: '#00d4ff' });
    localStorage.setItem(CALENDAR_ID_KEY, created.id);
    this.eventMap = {};
    return created.id;
  }

  // Best-effort wipe of an adopted calendar so it can be rebuilt without
  // doubling up. Reading events needs full calendar access, and this app
  // only asks for write-only, so this may legitimately fail — in that case
  // we still adopt the calendar (no duplicate calendars, which is the worse
  // problem) and the coach can toggle sync off/on to get a clean rebuild.
  private async clearCalendarEvents(calendarId: string): Promise<void> {
    try {
      const from = addDays(new Date(), -365).getTime();
      const to = addDays(new Date(), 365).getTime();
      const { result: events } = await CapacitorCalendar.listEventsInRange({ from, to });
      for (const ev of events) {
        if (ev.calendarId !== calendarId) continue;
        try {
          await CapacitorCalendar.deleteEvent({ id: ev.id });
        } catch {
          // already gone — fine either way
        }
      }
    } catch (err) {
      console.error('CalendarSync: could not clear adopted calendar (needs full calendar access)', err);
    }
  }

  async checkWritePermission(): Promise<boolean> {
    if (!this.isSupported) return false;
    const { result } = await CapacitorCalendar.checkPermission({ scope: CalendarPermissionScope.WRITE_CALENDAR });
    return result === 'granted';
  }

  // Pulls the current schedule (today → +60 days, same rolling window the
  // Schedule page syncs on every load) fresh from Firestore and pushes it to
  // the dedicated calendar. Exists so turning sync ON anywhere — Settings
  // included — populates the calendar immediately, rather than silently
  // waiting for the Schedule page to happen to load next. That gap is
  // exactly what made "I turned it on but the calendar's empty" possible:
  // enable() only creates the calendar, it was never responsible for
  // filling it in on its own.
  async syncCurrentSchedule(): Promise<void> {
    if (!this.isEnabled) return;
    try {
      const [packages, overrides, singleSessions] = await Promise.all([
        this.firebase.listPackages(),
        this.firebase.listSessionOverrides(),
        this.firebase.listSingleSessions()
      ]);
      const start = new Date();
      const end = addDays(start, 60);
      const entries = generateScheduleForRange(packages, start, end, overrides, singleSessions);
      await this.sync(entries);
    } catch (err) {
      console.error('CalendarSync: syncCurrentSchedule failed', err);
    }
  }

  private entryKey(entry: ScheduleEntry): string {
    return `${entry.packageId}|${entry.originalDateKey}`;
  }

  private entryStartEnd(entry: ScheduleEntry): { start: number; end: number } {
    const [h, m] = /^\d{2}:\d{2}$/.test(entry.time) ? entry.time.split(':').map(n => parseInt(n, 10)) : [9, 0];
    const start = new Date(entry.date);
    start.setHours(h, m, 0, 0);
    const end = new Date(start.getTime() + (entry.durationMinutes || 60) * 60_000);
    return { start: start.getTime(), end: end.getTime() };
  }

  private entryTitle(entry: ScheduleEntry): string {
    const who = entry.clientNames.length ? entry.clientNames.join(', ') : entry.packageName;
    return `${who} — ${entry.sessionType}`;
  }

  // Reconciles the dedicated calendar with the given entries: creates events
  // for new sessions, moves/renames events for sessions whose entry changed
  // (e.g. a reschedule), and removes events for sessions no longer present
  // (e.g. a package ended or a reschedule was reverted). Silently gives up
  // if sync isn't enabled/supported or the calendar has vanished — this is a
  // best-effort background convenience, never something that should block or
  // fail the schedule itself.
  async sync(entries: ScheduleEntry[]): Promise<void> {
    if (!this.isEnabled) return;
    // Resolve rather than trusting the cached id: if the coach deleted the
    // calendar by hand, this re-adopts or recreates it instead of silently
    // doing nothing forever — and because it matches by name first, it
    // won't spawn a second copy alongside one that's still there.
    const calendarId = await this.resolveCalendarId(true);
    if (!calendarId) return;

    const map = this.eventMap;
    const currentKeys = new Set(entries.map(e => this.entryKey(e)));

    try {
      for (const entry of entries) {
        const key = this.entryKey(entry);
        const { start, end } = this.entryStartEnd(entry);
        const title = this.entryTitle(entry);
        const existingId = map[key];

        if (existingId) {
          try {
            await CapacitorCalendar.modifyEvent({
              id: existingId,
              title,
              startDate: start,
              endDate: end
            });
            continue;
          } catch {
            // The event was likely deleted out from under us — fall through
            // and recreate it below.
          }
        }

        const created = await CapacitorCalendar.createEvent({
          calendarId,
          title,
          startDate: start,
          endDate: end
        });
        map[key] = created.id;
      }

      // Drop anything we previously synced that no longer matches a current entry.
      for (const key of Object.keys(map)) {
        if (currentKeys.has(key)) continue;
        try {
          await CapacitorCalendar.deleteEvent({ id: map[key] });
        } catch {
          // already gone — fine either way
        }
        delete map[key];
      }

      this.eventMap = map;
    } catch (err) {
      console.error('CalendarSync: sync failed', err);
    }
  }
}
