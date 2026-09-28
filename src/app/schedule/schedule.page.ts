import { AfterViewInit, Component, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { IonContent, IonIcon, IonModal, ToastController, ViewWillEnter } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  chevronBackOutline,
  chevronForwardOutline,
  calendarOutline,
  timeOutline,
  peopleOutline,
  cubeOutline,
  closeOutline,
  checkmarkCircle,
  removeCircle,
  closeCircle,
  ellipseOutline,
  pencilOutline,
  arrowUndoOutline,
  swapHorizontalOutline,
  barbellOutline,
  addOutline,
  trashOutline
} from 'ionicons/icons';
import { FirebaseService, PackageRecord, CheckIn, AttendanceStatus, SessionOverride, SingleSession, ClientProfile, localDateString, SwapRequest } from '../services/firebase.service';
import { CalendarSyncService } from '../services/calendar-sync.service';
import { AuthService, TRAINERS, trainerName } from '../services/auth.service';
import {
  ScheduleEntry,
  generateScheduleForRange,
  startOfWeek,
  addDays,
  formatTime12h
} from '../services/schedule.util';
import { postponeBillingForExcuse } from '../services/payments.config';
import { SessionDrag } from '../services/session-drag';

type ViewMode = 'week' | 'month';

interface DayColumn {
  date: Date;
  dateKey: string;
  label: string;     // 'Mon'
  dayNum: number;    // 8
  isToday: boolean;
  isPast: boolean;
  inMonth: boolean;  // false for adjacent-month padding days in month view
  entries: ScheduleEntry[];
}

interface SessionClient {
  id: string | null;
  name: string;
}

@Component({
  selector: 'app-schedule',
  templateUrl: './schedule.page.html',
  styleUrls: ['./schedule.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, IonModal, CommonModule, FormsModule, RouterModule]
})
export class SchedulePage implements OnInit, AfterViewInit, OnDestroy, ViewWillEnter {
  @ViewChild(IonContent) private content?: IonContent;
  loading = true;
  packages: PackageRecord[] = [];
  overrides: SessionOverride[] = [];
  singleSessions: SingleSession[] = [];
  clients: ClientProfile[] = [];
  weekCheckIns: CheckIn[] = [];
  viewMode: ViewMode = 'week';
  cursor: Date = new Date();        // reference date for the visible range
  days: DayColumn[] = [];
  weeks: DayColumn[][] = [];        // month view: rows of 7 days
  private dayKeys: string[] = [];

  // Session detail modal
  selectedEntry: ScheduleEntry | null = null;
  selectedDay: DayColumn | null = null;
  selectedClients: SessionClient[] = [];   // stable list for the open session
  isSessionOpen = false;
  // Rows currently saving in the background — per-row, not global, so
  // checking someone in never blocks tapping the next person.
  busyRowKeys = new Set<string>();

  // Reschedule form (within the session modal) — package occurrences only.
  reschedOpen = false;
  reschedDate = '';
  reschedTime = '';
  reschedBusy = false;

  // Add/edit single-session form (its own modal, separate from the
  // session-detail one — creating needs a client picker, date, time,
  // duration, and type, none of which the detail sheet has room for).
  addSessionOpen = false;
  addSessionBusy = false;
  singleActionBusy = false; // delete, specifically — edit routes through the same save path as create
  editingSingleSessionId: string | null = null;
  addForm: {
    date: string;
    time: string;
    durationMinutes: number;
    sessionType: 'Private' | 'Semi' | 'Group';
    title: string;
    clientIds: string[];
    trainerId: string;
  } = { date: '', time: '', durationMinutes: 60, sessionType: 'Private', title: '', clientIds: [], trainerId: '' };

  trainers = TRAINERS;
  // '' = show every trainer's sessions; otherwise only that trainer's.
  trainerFilter = '';

  // Pending athlete-submitted swap requests, shown as a panel above the
  // calendar — see SwapRequest's comment for how approving one applies.
  swapRequests: SwapRequest[] = [];
  swapRequestBusy = new Set<string>();

  // Press-and-drag rescheduling. dropTarget is the day (or 'prev'/'next'
  // week flip) under the finger; dropOk says whether letting go there moves it.
  draggingEntry: ScheduleEntry | null = null;
  dropTarget: string | null = null;
  dropOk = false;
  private drag = new SessionDrag();
  private scrollEl: HTMLElement | null = null;

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController,
    private calendarSync: CalendarSyncService,
    private auth: AuthService,
    private zone: NgZone
  ) {
    addIcons({
      arrowBack,
      chevronBackOutline,
      chevronForwardOutline,
      calendarOutline,
      timeOutline,
      peopleOutline,
      cubeOutline,
      closeOutline,
      checkmarkCircle,
      removeCircle,
      closeCircle,
      ellipseOutline,
      pencilOutline,
      arrowUndoOutline,
      swapHorizontalOutline,
      barbellOutline,
      addOutline,
      trashOutline
    });
  }

  // Launch the live-session HUD pre-loaded with this client's current workout.
  startLiveSession(client: SessionClient) {
    this.closeSession();
    this.router.navigate(['/live-session'], {
      queryParams: client.id ? { clientId: client.id } : {}
    });
  }

  async ngOnInit() {
    this.loadClients();
    await this.loadSchedule(true);
  }

  async ionViewWillEnter() {
    await this.loadSchedule(false);
  }

  ngAfterViewInit() {
    this.content?.getScrollElement().then(el => (this.scrollEl = el)).catch(() => {});
  }

  ngOnDestroy() {
    this.drag.cancel();
  }

  // Loaded once, separately from loadSchedule — the client list doesn't
  // change as often as the schedule itself, and it's only needed for the
  // add-session client picker.
  private async loadClients() {
    try {
      this.clients = await this.firebase.listClientProfiles();
    } catch (err) {
      console.error('Schedule: failed to load clients', err);
    }
  }

  private async loadSchedule(showLoading: boolean) {
    if (showLoading) this.loading = true;
    try {
      let swaps: SwapRequest[];
      [this.packages, this.overrides, this.singleSessions, swaps] = await Promise.all([
        this.firebase.listPackages(),
        this.firebase.listSessionOverrides(),
        this.firebase.listSingleSessions(),
        this.firebase.listSwapRequests()
      ]);
      this.swapRequests = swaps.filter(r => r.status === 'pending');
      await this.autoMarkNoShows();
      // After the sweep, so its new no-shows are counted: push out (or pull
      // in) any package end date that no longer leaves room for exactly the
      // sessions still owed. Patches this.packages in place.
      await this.firebase.reprojectPackageEnds(this.packages.filter(p => !p.bookedSessions), this.overrides);
    } catch (err) {
      console.error('Schedule: failed to load schedule data', err);
    }
    await this.rebuild();
    this.loading = false;
    this.syncCalendarInBackground();
  }

  // How many days back to sweep for missed check-ins each time the schedule loads.
  private static readonly NO_SHOW_LOOKBACK_DAYS = 14;

  // ngOnInit and ionViewWillEnter both load the schedule on the first visit,
  // at the same moment. Two sweeps racing each other both saw nobody marked
  // and both wrote the no-show — every miss got filed twice. Concurrent
  // callers now share the one sweep in flight.
  private noShowSweep: Promise<void> | null = null;

  private autoMarkNoShows(): Promise<void> {
    if (!this.noShowSweep) {
      this.noShowSweep = this.sweepNoShows().finally(() => (this.noShowSweep = null));
    }
    return this.noShowSweep;
  }

  // Once a session's day has fully passed with nobody marked present/excused/
  // unexcused, default it to "no-show" automatically — coaches shouldn't have
  // to manually flag every miss. Idempotent: only fills in clients that still
  // have no check-in record, so re-running (e.g. on every page visit) is safe.
  private async sweepNoShows() {
    const todayKey = localDateString();
    const start = addDays(new Date(), -SchedulePage.NO_SHOW_LOOKBACK_DAYS);
    const end = addDays(new Date(), -1); // through yesterday only
    const pastEntries = generateScheduleForRange(this.packages, start, end, this.overrides, this.singleSessions)
      .filter(e => e.dateKey < todayKey);
    if (pastEntries.length === 0) return;

    const dateKeys = Array.from(new Set(pastEntries.map(e => e.dateKey)));
    let pastCheckIns: CheckIn[];
    try {
      pastCheckIns = await this.firebase.getCheckInsForDates(dateKeys);
    } catch (err) {
      console.error('Schedule: failed to load check-ins for no-show sweep', err);
      return;
    }

    const hasCheckIn = (entry: ScheduleEntry, client: SessionClient) => {
      const nameKey = client.name.trim().toLowerCase();
      return pastCheckIns.some(c => c.date === entry.dateKey &&
        ((!!c.clientId && !!client.id && c.clientId === client.id) || c.clientName.trim().toLowerCase() === nameKey));
    };

    for (const entry of pastEntries) {
      const pkg = this.packages.find(p => (p.id || p.packageId) === entry.packageId) || null;
      for (const client of this.sessionClients(entry)) {
        if (hasCheckIn(entry, client)) continue;
        try {
          await this.firebase.setAttendance({
            existing: null,
            client: { id: client.id, fullName: client.name },
            pkg,
            date: entry.dateKey,
            status: 'unexcused'
          });
        } catch (err) {
          console.error('Schedule: failed to auto-mark no-show', err);
        }
      }
    }
  }

  // Turned on/off from Settings, not here — this just fires the sync
  // whenever the schedule data changes, same as always. See
  // CalendarSyncService and settings.page.ts for the enable/disable toggle.
  //
  // Syncs a rolling window (today → +60 days) regardless of which week/month
  // is currently on screen, so the device calendar always reflects the
  // near-term schedule rather than just whatever the coach happens to be
  // looking at. Fire-and-forget — a slow or failed background sync should
  // never hold up the schedule itself.
  private syncCalendarInBackground(): void {
    if (!this.calendarSync.isEnabled) return;
    const start = new Date();
    const end = addDays(start, 60);
    const entries = generateScheduleForRange(this.packages, start, end, this.overrides, this.singleSessions);
    this.calendarSync.sync(entries).catch(err => console.error('Schedule: background calendar sync failed', err));
  }

  private async rebuild() {
    if (this.viewMode === 'month') {
      await this.buildMonth();
    } else {
      await this.buildWeek();
    }
  }

  // Turn a contiguous run of days into DayColumns bucketed with their sessions.
  private buildDays(start: Date, count: number, monthRef?: number): DayColumn[] {
    const end = addDays(start, count - 1);
    const entries = generateScheduleForRange(this.packages, start, end, this.overrides, this.singleSessions);
    const todayKey = localDateString();
    const days: DayColumn[] = [];
    for (let i = 0; i < count; i++) {
      const date = addDays(start, i);
      const dateKey = localDateString(date);
      days.push({
        date,
        dateKey,
        label: date.toLocaleDateString('en-US', { weekday: 'short' }),
        dayNum: date.getDate(),
        isToday: dateKey === todayKey,
        isPast: dateKey < todayKey,
        inMonth: monthRef === undefined ? true : date.getMonth() === monthRef,
        entries: entries
          .filter(e => e.dateKey === dateKey)
          .filter(e => !this.trainerFilter || e.trainerId === this.trainerFilter)
          .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'))
      });
    }
    return days;
  }

  private async buildWeek() {
    const start = startOfWeek(this.cursor);
    this.days = this.buildDays(start, 7);
    this.weeks = [];
    this.dayKeys = this.days.map(d => d.dateKey);
    await this.refreshCheckIns();
  }

  private async buildMonth() {
    const monthStart = new Date(this.cursor.getFullYear(), this.cursor.getMonth(), 1);
    const gridStart = startOfWeek(monthStart);
    const allDays = this.buildDays(gridStart, 42, this.cursor.getMonth());
    this.days = allDays;
    this.weeks = [];
    for (let i = 0; i < allDays.length; i += 7) {
      this.weeks.push(allDays.slice(i, i + 7));
    }
    this.dayKeys = allDays.map(d => d.dateKey);
    await this.refreshCheckIns();
  }

  private async refreshCheckIns() {
    try {
      this.weekCheckIns = await this.firebase.getCheckInsForDates(this.dayKeys);
    } catch (err) {
      console.error('Schedule: failed to load check-ins', err);
      this.weekCheckIns = [];
    }
  }

  // Name to show on a session card ('' when unassigned — the card just omits it).
  trainerLabel(entry: ScheduleEntry): string {
    return entry.trainerId ? trainerName(entry.trainerId) : '';
  }

  async setTrainerFilter(trainerId: string) {
    if (this.trainerFilter === trainerId) return;
    this.trainerFilter = trainerId;
    await this.rebuild();
  }

  async setView(mode: ViewMode) {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    await this.rebuild();
  }

  get rangeLabel(): string {
    if (this.viewMode === 'month') {
      return this.cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    const start = startOfWeek(this.cursor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = end.toLocaleDateString('en-US', sameMonth
      ? { day: 'numeric' }
      : { month: 'short', day: 'numeric' });
    return `${startStr} – ${endStr}, ${end.getFullYear()}`;
  }

  // Short weekday headers for the month grid.
  get weekdayHeaders(): string[] {
    const start = startOfWeek(new Date());
    return Array.from({ length: 7 }, (_, i) =>
      addDays(start, i).toLocaleDateString('en-US', { weekday: 'short' })
    );
  }

  get hasAnySessions(): boolean {
    return this.days.some(d => d.entries.length > 0);
  }

  get activePackageCount(): number {
    return this.packages.filter(p => p.status === 'active').length;
  }

  async prev() {
    this.cursor = this.viewMode === 'month'
      ? new Date(this.cursor.getFullYear(), this.cursor.getMonth() - 1, 1)
      : addDays(this.cursor, -7);
    await this.rebuild();
  }

  async next() {
    this.cursor = this.viewMode === 'month'
      ? new Date(this.cursor.getFullYear(), this.cursor.getMonth() + 1, 1)
      : addDays(this.cursor, 7);
    await this.rebuild();
  }

  async goToday() {
    this.cursor = new Date();
    await this.rebuild();
  }

  // The check-in record (if any) for a given client on a given session date.
  private findCheckIn(entry: ScheduleEntry, client: SessionClient): CheckIn | null {
    const nameKey = client.name.trim().toLowerCase();
    return this.weekCheckIns.find(c =>
      c.date === entry.dateKey &&
      ((!!c.clientId && !!client.id && c.clientId === client.id) ||
        c.clientName.trim().toLowerCase() === nameKey)
    ) || null;
  }

  isClientCheckedIn(entry: ScheduleEntry, clientName: string): boolean {
    return this.findCheckIn(entry, { id: null, name: clientName })?.status === 'present';
  }

  // 'present' | 'excused' | 'unexcused' | 'none'
  clientStatus(entry: ScheduleEntry, client: SessionClient): AttendanceStatus | 'none' {
    return this.findCheckIn(entry, client)?.status ?? 'none';
  }

  showAttendance(day: DayColumn): boolean {
    return day.isToday || day.isPast;
  }

  // Pair up the parallel name/id arrays into client objects.
  sessionClients(entry: ScheduleEntry | null): SessionClient[] {
    if (!entry) return [];
    return entry.clientNames.map((name, i) => ({
      id: entry.clientIds[i] ?? null,
      name
    }));
  }

  openSession(entry: ScheduleEntry, day: DayColumn) {
    this.selectedEntry = entry;
    this.selectedDay = day;
    this.selectedClients = this.sessionClients(entry);
    this.reschedOpen = false;
    this.reschedDate = entry.dateKey;
    this.reschedTime = entry.time || entry.originalTime || '';
    this.isSessionOpen = true;
  }

  closeSession() {
    this.isSessionOpen = false;
    this.selectedEntry = null;
    this.selectedDay = null;
    this.selectedClients = [];
    this.reschedOpen = false;
  }

  // Attendance is filed by date, so moving a session that has some leaves
  // it behind on the old date, counting the session twice. Clear it first —
  // same rule as dragging.
  get selectedHasAttendance(): boolean {
    const entry = this.selectedEntry;
    return !!entry && this.selectedClients.some(c => this.clientStatus(entry, c) !== 'none');
  }

  // ----- Reschedule (single occurrence only) -----
  toggleReschedule() {
    if (this.selectedEntry) {
      this.reschedDate = this.selectedEntry.dateKey;
      this.reschedTime = this.selectedEntry.time || this.selectedEntry.originalTime || '';
    }
    this.reschedOpen = !this.reschedOpen;
  }

  // Formats a swap request's from/to as one readable line, e.g.
  // "Wed, Sep 10 at 5:00 PM -> Fri, Sep 12 at 6:00 PM".
  swapRequestLabel(req: SwapRequest): { from: string; to: string } {
    const fmt = (dateKey: string, time: string) => {
      const d = new Date(dateKey + 'T00:00:00');
      const dateStr = isNaN(d.getTime())
        ? dateKey
        : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      return time ? `${dateStr} at ${formatTime12h(time)}` : dateStr;
    };
    return {
      from: fmt(req.originalDateKey, req.originalTime),
      to: fmt(req.requestedDateKey, req.requestedTime)
    };
  }

  // "Mon 6:00 PM, Wed 6:00 PM" for a recurringChange request's before/after
  // slot — same format as Packages' formatDayTimes, kept in day-of-week
  // order regardless of the order stored on the request.
  private static readonly DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  recurringChangeLabel(days: string[] | undefined, times: { [day: string]: string } | undefined): string {
    if (!days || days.length === 0) return '—';
    const ordered = SchedulePage.DAY_ORDER.filter(d => days.includes(d));
    return ordered.map(d => times?.[d] ? `${d} ${formatTime12h(times[d])}` : d).join(', ');
  }

  async respondToSwap(req: SwapRequest, approve: boolean) {
    if (!req.id || this.swapRequestBusy.has(req.id)) return;
    this.swapRequestBusy.add(req.id);
    try {
      await this.firebase.respondToSwapRequest(req, approve);
      this.swapRequests = this.swapRequests.filter(r => r.id !== req.id);
      await this.loadSchedule(false);
      await this.presentToast(approve ? 'Swap approved' : 'Swap denied');
    } catch (err) {
      console.error('Schedule: failed to respond to swap request', err);
      await this.presentToast('Could not update the request', 'danger');
    } finally {
      this.swapRequestBusy.delete(req.id);
    }
  }

  async saveReschedule() {
    const entry = this.selectedEntry;
    if (!entry || this.reschedBusy) return;
    if (!this.reschedDate) {
      await this.presentToast('Pick a date', 'danger');
      return;
    }
    this.reschedBusy = true;
    try {
      const undo = await this.applyMove(entry, this.reschedDate, this.reschedTime || '');
      this.closeSession();
      await this.loadSchedule(false);
      await this.presentUndoToast(`Moved to ${this.moveLabel(this.reschedDate, this.reschedTime)}`, undo);
    } catch (err) {
      console.error('Schedule: failed to reschedule', err);
      await this.presentToast('Could not reschedule', 'danger');
    } finally {
      this.reschedBusy = false;
    }
  }

  // Restore a rescheduled occurrence back to its original recurring slot.
  async revertReschedule() {
    const entry = this.selectedEntry;
    if (!entry || (!entry.overrideId && !entry.sessionId) || this.reschedBusy) return;
    this.reschedBusy = true;
    try {
      const undo = await this.applyMove(entry, entry.originalDateKey, entry.originalTime);
      this.closeSession();
      await this.loadSchedule(false);
      await this.presentUndoToast('Back on its original day', undo);
    } catch (err) {
      console.error('Schedule: failed to revert reschedule', err);
      await this.presentToast('Could not revert', 'danger');
    } finally {
      this.reschedBusy = false;
    }
  }

  // Moves one session to a new date/time and returns how to put it back
  // (for the toast's Undo). A one-off session's own record changes; a
  // package session goes through movePackageSession.
  private async applyMove(entry: ScheduleEntry, date: string, time: string): Promise<() => Promise<void>> {
    if (entry.isSingle && entry.singleSessionId) {
      const session = this.singleSessions.find(s => s.id === entry.singleSessionId);
      if (!session) throw new Error('One-off session not found');
      const before = { ...session };
      await this.firebase.saveSingleSession({ ...session, date, time });
      return async () => { await this.firebase.saveSingleSession(before); };
    }
    return this.firebase.movePackageSession(entry, date, time);
  }

  // "Thu, Oct 2 · 5:00 PM"
  private moveLabel(dateKey: string, time: string): string {
    const t = formatTime12h(time);
    return t ? `${this.dateKeyLabel(dateKey)} · ${t}` : this.dateKeyLabel(dateKey);
  }

  // ----- Drag to reschedule -----
  // Hold a session card (tap-and-hold on touch, click-and-drag with a
  // mouse) and drop it on another day; it keeps its time. Hovering the
  // week/month arrows flips the calendar mid-drag.
  onCardPointerDown(ev: PointerEvent, entry: ScheduleEntry) {
    this.drag.begin(ev, {
      zone: this.zone,
      source: ev.currentTarget as HTMLElement,
      scrollEl: this.scrollEl,
      canStart: () => this.canDragEntry(entry),
      targetAt: (x, y) => {
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        return el?.closest<HTMLElement>('[data-drop]')?.dataset['drop'] ?? null;
      },
      canDrop: key => key !== entry.dateKey && key >= localDateString(),
      onOver: (key, ok) => {
        this.dropTarget = key;
        this.dropOk = ok;
      },
      onEnd: () => (this.draggingEntry = null),
      onDrop: key => this.dropEntry(entry, key),
      onFlip: dir => (dir === 'prev' ? this.prev() : this.next())
    });
  }

  // Attendance is filed by date, so a session that already has some would
  // leave it behind on the old day — clear it first (or use the sheet).
  private canDragEntry(entry: ScheduleEntry): boolean {
    const marked = this.sessionClients(entry).some(c => this.clientStatus(entry, c) !== 'none');
    if (marked) {
      this.presentToast('Attendance is already taken for this session — clear it to move it', 'danger');
      return false;
    }
    this.draggingEntry = entry;
    return true;
  }

  // Past days can't take a drop (they'd be auto-marked no-show), so a red
  // outline there explains why letting go does nothing.
  isDropBlocked(dateKey: string): boolean {
    return !!this.draggingEntry && this.dropTarget === dateKey && !this.dropOk && dateKey !== this.draggingEntry.dateKey;
  }

  private async dropEntry(entry: ScheduleEntry, dateKey: string) {
    this.moveLocally(entry, dateKey);
    try {
      const undo = await this.applyMove(entry, dateKey, entry.time);
      this.presentUndoToast(`Moved to ${this.moveLabel(dateKey, entry.time)}`, undo);
    } catch (err) {
      console.error('Schedule: failed to move session', err);
      this.presentToast('Could not move the session', 'danger');
    }
    await this.loadSchedule(false);
  }

  // Shows the card on its new day right away; the reload that follows the
  // save replaces this with the real data.
  private moveLocally(entry: ScheduleEntry, dateKey: string) {
    const from = this.days.find(d => d.entries.includes(entry));
    if (from) from.entries = from.entries.filter(e => e !== entry);
    const to = this.days.find(d => d.dateKey === dateKey);
    if (!to) return;
    const moved: ScheduleEntry = { ...entry, dateKey, date: to.date, rescheduled: true };
    to.entries = [...to.entries, moved].sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  }

  private async presentUndoToast(message: string, undo: () => Promise<void>) {
    const toast = await this.toastController.create({
      message,
      duration: 6000,
      position: 'bottom',
      color: 'success',
      buttons: [{ text: 'Undo', handler: () => { this.runUndo(undo); } }]
    });
    await toast.present();
  }

  private async runUndo(undo: () => Promise<void>) {
    try {
      await undo();
      await this.loadSchedule(false);
      await this.presentToast('Move undone');
    } catch (err) {
      console.error('Schedule: failed to undo move', err);
      await this.presentToast('Could not undo', 'danger');
    }
  }

  // ----- One-off sessions (not tied to any package) -----
  // `dateKey` prefills the date when opened from a specific day cell;
  // opened from the header "+" it defaults to today.
  openAddSession(dateKey?: string) {
    this.editingSingleSessionId = null;
    this.addForm = {
      date: dateKey || localDateString(),
      time: '',
      durationMinutes: 60,
      sessionType: 'Private',
      title: '',
      clientIds: [],
      // Whoever is signed in is almost always the one running a session they add.
      trainerId: this.auth.getCurrentTrainerId() || ''
    };
    this.addSessionOpen = true;
  }

  // Single sessions have no recurring slot to revert to, so editing changes
  // the record directly rather than going through SessionOverride.
  openEditSingleSession(entry: ScheduleEntry) {
    if (!entry.isSingle || !entry.singleSessionId) return;
    const session = this.singleSessions.find(s => s.id === entry.singleSessionId);
    if (!session) return;
    this.editingSingleSessionId = session.id!;
    this.addForm = {
      date: session.date,
      time: session.time || '',
      durationMinutes: session.durationMinutes || 60,
      sessionType: session.sessionType,
      title: session.title || '',
      clientIds: [...session.clientIds],
      trainerId: session.trainerId || ''
    };
    this.closeSession();
    this.addSessionOpen = true;
  }

  closeAddSession() {
    this.addSessionOpen = false;
    this.editingSingleSessionId = null;
  }

  isAddClientSelected(id: string): boolean {
    return this.addForm.clientIds.includes(id);
  }

  toggleAddClient(id: string) {
    const i = this.addForm.clientIds.indexOf(id);
    if (i > -1) this.addForm.clientIds.splice(i, 1);
    else this.addForm.clientIds.push(id);
  }

  async saveAddSession() {
    if (this.addSessionBusy) return;
    if (!this.addForm.date) {
      await this.presentToast('Pick a date', 'danger');
      return;
    }
    this.addSessionBusy = true;
    try {
      const idToName = new Map(this.clients.filter(c => c.id).map(c => [c.id!, c.fullName]));
      const clientNames = this.addForm.clientIds.map(id => idToName.get(id) || '').filter(Boolean);
      const title = this.addForm.title.trim() || (clientNames.length ? clientNames.join(', ') : 'Session');
      await this.firebase.saveSingleSession({
        id: this.editingSingleSessionId || undefined,
        date: this.addForm.date,
        time: this.addForm.time || '',
        durationMinutes: this.addForm.durationMinutes || 60,
        sessionType: this.addForm.sessionType,
        title,
        clientIds: this.addForm.clientIds,
        clientNames,
        trainerId: this.addForm.trainerId || ''
      });
      const wasEditing = !!this.editingSingleSessionId;
      this.closeAddSession();
      await this.loadSchedule(false);
      await this.presentToast(wasEditing ? 'Session updated' : 'Session added');
    } catch (err) {
      console.error('Schedule: failed to save single session', err);
      await this.presentToast('Could not save session', 'danger');
    } finally {
      this.addSessionBusy = false;
    }
  }

  async deleteSingleSession() {
    const entry = this.selectedEntry;
    if (!entry?.isSingle || !entry.singleSessionId || this.singleActionBusy) return;
    this.singleActionBusy = true;
    try {
      await this.firebase.deleteSingleSession(entry.singleSessionId);
      this.closeSession();
      await this.loadSchedule(false);
      await this.presentToast('Session deleted');
    } catch (err) {
      console.error('Schedule: failed to delete single session', err);
      await this.presentToast('Could not delete session', 'danger');
    } finally {
      this.singleActionBusy = false;
    }
  }

  // "Mon, Jun 9" for an arbitrary YYYY-MM-DD key.
  dateKeyLabel(key: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
    if (!m) return key;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // Stable identity for *ngFor so attendance rows aren't recreated on each
  // change-detection pass (which would break in-flight taps).
  trackClient(_index: number, client: SessionClient): string {
    return client.id || client.name;
  }

  private rowKey(entry: ScheduleEntry, client: SessionClient): string {
    return `${entry.dateKey}|${entry.packageId}|${client.id || client.name}`;
  }

  isRowBusy(entry: ScheduleEntry, client: SessionClient): boolean {
    return this.busyRowKeys.has(this.rowKey(entry, client));
  }

  // Set or toggle a client's attendance for the selected session.
  // Clicking the already-active status clears the record (back to unmarked).
  //
  // The UI updates optimistically (right away, from local state) and the
  // actual Firestore round trip — which can take a couple seconds — runs in
  // the background. Only the row being changed locks; every other row stays
  // tappable so check-ins can be fired off rapid-fire. On failure the
  // optimistic change rolls back and an error toast explains why.
  async setStatus(entry: ScheduleEntry, client: SessionClient, status: AttendanceStatus) {
    const key = this.rowKey(entry, client);
    if (this.busyRowKeys.has(key)) return;
    this.busyRowKeys.add(key);

    const existing = this.findCheckIn(entry, client);
    const pkg = this.packages.find(p => (p.id || p.packageId) === entry.packageId) || null;
    const clearing = !!existing && existing.status === status;
    const previousCheckIns = this.weekCheckIns;
    // Extra copies of the same record (same client, date and package) —
    // they go along with it, or clearing would leave the row still marked.
    const copies = existing
      ? this.weekCheckIns.filter(c => c !== existing && c.date === existing.date && c.packageId === existing.packageId &&
          ((!!c.clientId && c.clientId === existing.clientId) || c.clientName.trim().toLowerCase() === existing.clientName.trim().toLowerCase()))
      : [];

    if (clearing) {
      this.weekCheckIns = this.weekCheckIns.filter(c => c !== existing && !copies.includes(c));
    } else {
      const optimistic: CheckIn = {
        id: existing?.id,
        clientId: client.id ?? null,
        clientName: client.name,
        date: entry.dateKey,
        checkInTime: existing?.checkInTime ?? new Date().toISOString(),
        packageId: pkg?.id ?? null,
        packageName: pkg?.packageName ?? '',
        sessionType: pkg?.sessionType ?? '',
        decremented: status !== 'excused',
        status,
        sessionsRemainingAfter: existing?.sessionsRemainingAfter ?? null,
        packageTotalSessions: pkg?.totalSessions ?? null,
        createdAt: existing?.createdAt ?? new Date().toISOString()
      };
      this.weekCheckIns = existing
        ? this.weekCheckIns.map(c => (c === existing ? optimistic : c))
        : [...this.weekCheckIns, optimistic];
    }

    try {
      if (clearing) {
        let remaining = await this.firebase.undoCheckIn(existing!);
        for (const c of copies) remaining = await this.firebase.undoCheckIn(c);
        if (pkg?.id && remaining != null) pkg.sessionsRemaining = remaining;
        this.presentToast(`${client.name} — cleared`);
      } else {
        const saved = await this.firebase.setAttendance({
          existing,
          client: { id: client.id, fullName: client.name },
          pkg,
          date: entry.dateKey,
          status
        });
        for (const c of copies) await this.firebase.undoCheckIn(c);
        this.weekCheckIns = this.weekCheckIns.filter(c => !copies.includes(c));
        // Reconcile the optimistic record with the real one (id, sessionsRemainingAfter).
        this.weekCheckIns = this.weekCheckIns.map(c =>
          c.date === entry.dateKey &&
          c.packageId === (pkg?.id ?? null) &&
          ((!!c.clientId && !!client.id && c.clientId === client.id) || c.clientName === client.name)
            ? saved
            : c
        );
        if (pkg?.id && saved.sessionsRemainingAfter != null) pkg.sessionsRemaining = saved.sessionsRemainingAfter;
        this.presentToast(`${client.name} — ${this.statusLabel(status)}`);

        // "They weren't here and they don't get charged for it" — an
        // excused absence also slides their next subscription charge by
        // one session's worth. Only on a fresh excuse (not on re-tapping
        // an already-excused row, which would postpone twice for one
        // absence), and only for packages that actually bill monthly.
        if (status === 'excused' && existing?.status !== 'excused' && pkg?.id) {
          this.postponeBillingFor(pkg.id, client.name);
        }
      }
    } catch (err) {
      console.error('Schedule: failed to set attendance', err);
      this.weekCheckIns = previousCheckIns;
      this.presentToast('Could not save attendance', 'danger');
    } finally {
      this.busyRowKeys.delete(key);
    }
  }

  // Fire-and-forget: attendance is already saved and the coach has been
  // told. The Worker no-ops quietly for packages not on a subscription,
  // which is the common case for anyone paying per-package.
  private postponeBillingFor(packageId: string, clientName: string): void {
    postponeBillingForExcuse(packageId).then(days => {
      if (days) this.presentToast(`${clientName} — next charge pushed back ${Math.round(days * 10) / 10} days`);
    });
  }

  statusLabel(status: AttendanceStatus | 'none'): string {
    switch (status) {
      case 'present': return 'Present';
      case 'excused': return 'Excused';
      case 'unexcused': return 'Unexcused';
      default: return 'Not marked';
    }
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 1400, position: 'bottom', color });
    await toast.present();
  }

  get selectedDateLabel(): string {
    if (!this.selectedDay) return '';
    return this.selectedDay.date.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric'
    });
  }

  formatTime(time: string): string {
    return formatTime12h(time) || 'Time TBD';
  }

  typeClass(sessionType: string): string {
    switch (sessionType) {
      case 'Private': return 'private';
      case 'Semi': return 'semi';
      default: return 'group';
    }
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }
}
