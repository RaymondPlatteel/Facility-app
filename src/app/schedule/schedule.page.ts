import { Component, OnInit } from '@angular/core';
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
import { FirebaseService, PackageRecord, CheckIn, AttendanceStatus, SessionOverride, SingleSession, ClientProfile, localDateString } from '../services/firebase.service';
import { CalendarSyncService } from '../services/calendar-sync.service';
import { AuthService, TRAINERS, trainerName } from '../services/auth.service';
import {
  ScheduleEntry,
  generateScheduleForRange,
  startOfWeek,
  addDays,
  formatTime12h
} from '../services/schedule.util';

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
export class SchedulePage implements OnInit, ViewWillEnter {
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

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController,
    private calendarSync: CalendarSyncService,
    private auth: AuthService
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
      [this.packages, this.overrides, this.singleSessions] = await Promise.all([
        this.firebase.listPackages(),
        this.firebase.listSessionOverrides(),
        this.firebase.listSingleSessions()
      ]);
      await this.autoMarkNoShows();
    } catch (err) {
      console.error('Schedule: failed to load schedule data', err);
    }
    await this.rebuild();
    this.loading = false;
    this.syncCalendarInBackground();
  }

  // How many days back to sweep for missed check-ins each time the schedule loads.
  private static readonly NO_SHOW_LOOKBACK_DAYS = 14;

  // Once a session's day has fully passed with nobody marked present/excused/
  // unexcused, default it to "no-show" automatically — coaches shouldn't have
  // to manually flag every miss. Idempotent: only fills in clients that still
  // have no check-in record, so re-running (e.g. on every page visit) is safe.
  private async autoMarkNoShows() {
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

  // ----- Reschedule (single occurrence only) -----
  toggleReschedule() {
    if (this.selectedEntry) {
      this.reschedDate = this.selectedEntry.dateKey;
      this.reschedTime = this.selectedEntry.time || this.selectedEntry.originalTime || '';
    }
    this.reschedOpen = !this.reschedOpen;
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
      await this.firebase.setSessionOverride({
        id: entry.overrideId,
        packageId: entry.packageId,
        originalDate: entry.originalDateKey,
        newDate: this.reschedDate,
        newTime: this.reschedTime || ''
      });
      this.closeSession();
      await this.loadSchedule(false);
      await this.presentToast('Session rescheduled');
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
    if (!entry || !entry.overrideId || this.reschedBusy) return;
    this.reschedBusy = true;
    try {
      await this.firebase.deleteSessionOverride(entry.overrideId);
      this.closeSession();
      await this.loadSchedule(false);
      await this.presentToast('Reschedule reverted');
    } catch (err) {
      console.error('Schedule: failed to revert reschedule', err);
      await this.presentToast('Could not revert', 'danger');
    } finally {
      this.reschedBusy = false;
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

    if (clearing) {
      this.weekCheckIns = this.weekCheckIns.filter(c => c !== existing);
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
        const remaining = await this.firebase.undoCheckIn(existing!);
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
      }
    } catch (err) {
      console.error('Schedule: failed to set attendance', err);
      this.weekCheckIns = previousCheckIns;
      this.presentToast('Could not save attendance', 'danger');
    } finally {
      this.busyRowKeys.delete(key);
    }
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
