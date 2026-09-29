import { Component, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, add, saveOutline, trashOutline, clipboardOutline,
  checkmarkCircle, removeOutline, readerOutline, barbellOutline
} from 'ionicons/icons';
import {
  FirebaseService, Program, ProgramDay, ProgramAttribute, ClientProfile,
  WorkoutLog, LoggedExercise, localDateString, MemberWorkoutLog
} from '../services/firebase.service';
import {
  SyncExercise, WorkoutSyncState, merge3, newExerciseKey, normalizeState, patchInPlace, sameValue, sheetToSync, syncToSheet
} from '../services/workout-sync';

interface DayOption {
  index: number;
  label: string;
}

@Component({
  selector: 'app-workout-log',
  templateUrl: './workout-log.page.html',
  styleUrls: ['./workout-log.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class WorkoutLogPage implements OnInit, OnDestroy {
  loading = true;
  saving = false;

  programs: Program[] = [];
  clients: ClientProfile[] = [];

  // Selection
  selectedProgramId = '';
  selectedDayIndex: number | null = null;
  selectedClientId = '';
  date = localDateString();

  // Entries being logged
  entries: LoggedExercise[] = [];
  sessionNotes = '';
  editingLogId: string | null = null;
  // Where the log being edited lives and what the athlete called it — see
  // WorkoutLog.source. Every workout shows the same here whichever app
  // recorded it.
  private editingSource: 'coach' | 'member' | undefined;
  private editingTitle = '';

  // A workout being done right now, edited live: every change here goes to
  // the athlete's phone within a moment and theirs come back, merged three
  // ways (see workout-sync.ts). `synced` is the version both last agreed
  // on; `canon` keeps what this sheet can't show (warm-ups, set videos).
  liveId: string | null = null;
  liveName = '';
  private stopLiveDoc: (() => void) | null = null;
  private synced: WorkoutSyncState | null = null;
  private canon: SyncExercise[] = [];
  private liveStartedAt: number | null = null;
  private liveSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Prescription lookup for placeholders: entryIdx -> attrType -> ProgramAttribute
  private prescriptions: Array<Map<string, ProgramAttribute>> = [];

  // "Last time" summaries per entry index
  lastTime: Array<string | null> = [];

  // Program progression for the selected client
  lastDoneLabel: string | null = null;
  programComplete = false;

  // History
  history: WorkoutLog[] = [];
  // Keeps the list current while it's open — an athlete starting, editing
  // or finishing a workout on their phone shows up without reopening.
  private stopWatch: (() => void) | null = null;
  private watchingKey: string | null | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private firebase: FirebaseService,
    private route: ActivatedRoute,
    private router: Router,
    private location: Location,
    private toastController: ToastController,
    private alertController: AlertController,
    private zone: NgZone
  ) {
    addIcons({
      arrowBack, add, saveOutline, trashOutline, clipboardOutline,
      checkmarkCircle, removeOutline, readerOutline, barbellOutline
    });
  }

  async ngOnInit() {
    try {
      [this.programs, this.clients] = await Promise.all([
        this.firebase.listPrograms(),
        this.firebase.listClientProfiles()
      ]);
    } catch (err) {
      console.error('Log: failed to load base data', err);
    }

    const qp = this.route.snapshot.queryParamMap;
    const logId = qp.get('logId');
    const programId = qp.get('programId');

    if (logId) {
      await this.loadExistingLog(logId);
    } else if (programId) {
      this.selectedProgramId = programId;
      await this.onProgramChange();
    }

    await this.refreshHistory();
    this.loading = false;
  }

  // ---------- Selection ----------
  get selectedProgram(): Program | null {
    return this.programs.find(p => p.id === this.selectedProgramId) || null;
  }

  get selectedClient(): ClientProfile | null {
    return this.clients.find(c => c.id === this.selectedClientId) || null;
  }

  get dayOptions(): DayOption[] {
    const p = this.selectedProgram;
    if (!p) return [];
    const cycleLabel = p.isStandardWeek ? 'W' : 'C';
    return p.schedule
      .map((day, index) => ({ day, index }))
      .filter(x => !x.day.isRestDay && x.day.exercises.length > 0)
      .map(x => ({
        index: x.index,
        label: `${cycleLabel}${Math.floor(x.index / p.daysPerCycle) + 1} · D${(x.index % p.daysPerCycle) + 1}${x.day.name ? ' — ' + x.day.name : ''}`
      }));
  }

  // Assigned clients first in the dropdown
  get clientOptions(): ClientProfile[] {
    const p = this.selectedProgram;
    if (!p || !(p.assignedClientIds || []).length) return this.clients;
    const assigned = new Set(p.assignedClientIds);
    return [...this.clients].sort((a, b) =>
      Number(assigned.has(b.id!)) - Number(assigned.has(a.id!)) || a.fullName.localeCompare(b.fullName)
    );
  }

  isAssigned(c: ClientProfile): boolean {
    return (this.selectedProgram?.assignedClientIds || []).includes(c.id!);
  }

  // 1-based position of the selected day within the program's training days
  get dayPosition(): number {
    if (this.selectedDayIndex === null) return 0;
    return this.dayOptions.findIndex(o => o.index === this.selectedDayIndex) + 1;
  }

  get dayTotal(): number {
    return this.dayOptions.length;
  }

  private clearEditing() {
    this.stopLive();
    this.editingLogId = null;
    this.editingSource = undefined;
    this.editingTitle = '';
  }

  async onProgramChange() {
    this.clearEditing();
    const opts = this.dayOptions;
    this.selectedDayIndex = opts.length > 0 ? opts[0].index : null;
    const p = this.selectedProgram;
    if (p && (p.assignedClientIds || []).length > 0 && !this.selectedClientId) {
      this.selectedClientId = p.assignedClientIds![0];
    }
    await this.autoAdvanceDay();
    await this.buildEntries();
  }

  async onDayChange() {
    this.clearEditing();
    await this.buildEntries();
  }

  async onClientChange() {
    this.clearEditing();
    await this.autoAdvanceDay();
    await this.buildEntries();
    this.refreshHistory();
  }

  // ---------- Program progression ----------
  // Figure out where this client is in the program from their logged history,
  // and jump the day selector to the next training day they haven't done yet.
  private async autoAdvanceDay() {
    this.lastDoneLabel = null;
    this.programComplete = false;
    const p = this.selectedProgram;
    const opts = this.dayOptions;
    if (!p || !this.selectedClientId || opts.length === 0) return;

    let pos;
    try {
      pos = await this.firebase.clientProgramPosition(p, this.selectedClientId);
    } catch (err) {
      console.error('Log: progress lookup failed', err);
      return;
    }

    if (pos.lastDayIndex !== null && pos.lastDate) {
      const lastOpt = opts.find(o => o.index === pos.lastDayIndex);
      const lastLabel = (lastOpt?.label || '').split(' — ')[0];
      this.lastDoneLabel = `${lastLabel} on ${this.shortDate(pos.lastDate)}`;
    }

    if (pos.complete) {
      // Finished the last training day → program complete, don't force a day.
      this.programComplete = true;
      return;
    }
    if (pos.nextDayIndex !== null) this.selectedDayIndex = pos.nextDayIndex;
  }

  // ---------- Build the log sheet from the prescription ----------
  private async buildEntries() {
    const p = this.selectedProgram;
    this.entries = [];
    this.prescriptions = [];
    this.lastTime = [];
    this.sessionNotes = '';
    if (!p || this.selectedDayIndex === null) return;
    const day: ProgramDay | undefined = p.schedule[this.selectedDayIndex];
    if (!day) return;

    for (const ex of day.exercises) {
      const attrMap = new Map<string, ProgramAttribute>();
      ex.attributes.forEach(a => attrMap.set(a.type, a));
      const columns = ex.attributes.filter(a => a.type !== 'Sets').map(a => a.type);
      const setCount = this.defaultSetCount(attrMap.get('Sets'));

      this.entries.push({
        key: newExerciseKey(),
        exerciseName: ex.name || 'Exercise',
        prescription: ex.attributes.map(a =>
          `${a.type}: ${a.strategy === 'User Input' ? '—' : a.strategy === 'Bodyweight' ? 'BW' : a.val || '—'}`
        ).join(' · '),
        attrColumns: columns,
        sets: Array.from({ length: setCount }, () => ({ values: {}, done: false }))
      });
      this.prescriptions.push(attrMap);
    }
    await this.updateLastTime();
  }

  private defaultSetCount(setsAttr?: ProgramAttribute): number {
    if (!setsAttr) return 3;
    if (setsAttr.strategy === 'Fixed') return Math.max(1, parseInt(setsAttr.val, 10) || 3);
    if (setsAttr.strategy === 'Range') return Math.max(1, parseInt(setsAttr.val.split('-')[0], 10) || 3);
    return 3;
  }

  placeholderFor(entryIdx: number, col: string): string {
    const attr = this.prescriptions[entryIdx]?.get(col);
    if (!attr) return '';
    switch (attr.strategy) {
      case 'Fixed': return attr.val;
      case 'Range': return attr.val;
      case '%1RM': return `${attr.val}%`;
      case 'AMRAP': return 'AMRAP';
      case 'Bodyweight': return 'BW';
      default: return '';
    }
  }

  // ---------- "Last time" ----------
  private async updateLastTime() {
    this.lastTime = this.entries.map(() => null);
    if (!this.selectedClientId || !this.selectedProgramId || this.selectedDayIndex === null) return;
    try {
      const logs = await this.firebase.listWorkoutLogs({ clientId: this.selectedClientId, nameKey: this.selectedClient?.nameKey });
      const prev = logs.find(l =>
        l.programId === this.selectedProgramId &&
        l.dayIndex === this.selectedDayIndex &&
        l.id !== this.editingLogId
      );
      if (!prev) return;
      this.lastTime = this.entries.map(entry => {
        const match = prev.exercises.find(e => e.exerciseName === entry.exerciseName);
        if (!match) return null;
        const summary = match.sets
          .map(s => match.attrColumns.map(c => s.values[c] || '—').join('/'))
          .join(', ');
        return summary ? `${this.shortDate(prev.date)}: ${summary}` : null;
      });
    } catch (err) {
      console.error('Log: failed to fetch last-time data', err);
    }
  }

  private shortDate(key: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
    if (!m) return key;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------- Set editing ----------
  addSet(entry: LoggedExercise) {
    entry.sets.push({ values: {}, done: false });
    this.markDirty();
  }

  removeSet(entry: LoggedExercise) {
    if (entry.sets.length > 1) entry.sets.pop();
    this.markDirty();
  }

  toggleDone(set: { done?: boolean }) {
    set.done = !set.done;
    this.markDirty();
  }

  // ---------- Save / load / delete ----------
  get canSave(): boolean {
    return !!(this.selectedClientId || this.selectedClient) && this.entries.length > 0 && !!this.date;
  }

  async save() {
    if (!this.canSave || this.saving) return;
    const wasNew = !this.editingLogId;
    this.saving = true;
    try {
      const p = this.selectedProgram;
      const day = p && this.selectedDayIndex !== null ? p.schedule[this.selectedDayIndex] : null;
      const log: WorkoutLog = {
        id: this.editingLogId || undefined,
        source: this.editingLogId ? this.editingSource : undefined,
        title: this.editingTitle || undefined,
        programId: this.selectedProgramId || null,
        programName: p?.name || '',
        dayIndex: this.selectedDayIndex,
        dayName: day?.name || '',
        clientId: this.selectedClientId || null,
        clientName: this.selectedClient?.fullName || '',
        date: this.date,
        exercises: this.entries,
        sessionNotes: this.sessionNotes
      };
      this.editingLogId = await this.firebase.saveWorkoutLog(log);
      if (wasNew) this.editingSource = 'member';
      await this.refreshHistory();
      // Fresh session → advance to the next day in the program automatically.
      if (wasNew && this.selectedProgramId && this.selectedClientId) {
        this.clearEditing();
        this.date = localDateString();
        await this.autoAdvanceDay();
        await this.buildEntries();
        await this.presentToast(
          this.programComplete
            ? 'Logged — program complete 🎉'
            : `Logged — up next: Day ${this.dayPosition} of ${this.dayTotal}`
        );
      } else {
        await this.presentToast('Session logged');
      }
    } catch (err) {
      console.error('Log: save failed', err);
      await this.presentToast('Could not save log', 'danger');
    } finally {
      this.saving = false;
    }
  }

  private async loadExistingLog(id: string) {
    try {
      const logs = await this.firebase.listWorkoutLogs({ max: 500 });
      const log = logs.find(l => l.id === id);
      if (!log) return;
      this.openLog(log);
    } catch (err) {
      console.error('Log: failed to load existing log', err);
    }
  }

  // A workout being done right now opens live.
  openLog(log: WorkoutLog) {
    this.applyLog(log);
    if (log.inProgress && log.source === 'member' && log.id) this.startLive(log.id, log.clientName);
  }

  applyLog(log: WorkoutLog) {
    this.stopLive();
    this.editingLogId = log.id || null;
    this.editingSource = log.source;
    this.editingTitle = log.title || '';
    this.selectedProgramId = log.programId || '';
    this.selectedDayIndex = log.dayIndex;
    this.selectedClientId = log.clientId || this.clients.find(c =>
      (c.nameKey || c.fullName).trim().toLowerCase() === log.clientName.trim().toLowerCase())?.id || '';
    this.date = log.date;
    this.entries = JSON.parse(JSON.stringify(log.exercises));
    this.sessionNotes = log.sessionNotes || '';
    // Rebuild prescription placeholders from the (possibly updated) program
    this.prescriptions = this.entries.map(entry => {
      const p = this.selectedProgram;
      const day = p && log.dayIndex !== null ? p.schedule[log.dayIndex] : null;
      const ex = day?.exercises.find(e => (e.name || 'Exercise') === entry.exerciseName);
      const map = new Map<string, ProgramAttribute>();
      ex?.attributes.forEach(a => map.set(a.type, a));
      return map;
    });
    this.lastTime = this.entries.map(() => null);
    this.updateLastTime();
  }

  // Placeholders and "last time" per exercise, after the list changed.
  private rebuildHints() {
    const p = this.selectedProgram;
    const day = p && this.selectedDayIndex !== null ? p.schedule[this.selectedDayIndex] : null;
    this.prescriptions = this.entries.map(entry => {
      const ex = day?.exercises.find(e => (e.name || 'Exercise') === entry.exerciseName);
      const map = new Map<string, ProgramAttribute>();
      ex?.attributes.forEach(a => map.set(a.type, a));
      return map;
    });
    this.updateLastTime();
  }

  // ---------- Live ----------
  private startLive(id: string, clientName: string) {
    this.liveId = id;
    this.liveName = (clientName || '').trim().split(/\s+/)[0] || 'the athlete';
    this.synced = null;
    this.stopLiveDoc = this.firebase.watchSharedWorkout(id, w => this.zone.run(() => this.onLiveChange(id, w)));
  }

  // Writes any unsaved edit, then stops following the workout.
  private stopLive() {
    if (!this.liveId) return;
    if (this.liveSaveTimer) {
      clearTimeout(this.liveSaveTimer);
      this.liveSaveTimer = null;
      this.persistLive();
    }
    this.stopLiveDoc?.();
    this.stopLiveDoc = null;
    this.liveId = null;
    this.synced = null;
    this.canon = [];
  }

  // Bound to every edit on the sheet; only live workouts save as they go.
  markDirty() {
    if (!this.liveId) return;
    if (this.liveSaveTimer) clearTimeout(this.liveSaveTimer);
    this.liveSaveTimer = setTimeout(() => { this.liveSaveTimer = null; this.persistLive(); }, 400);
  }

  private liveState(): WorkoutSyncState {
    return {
      title: this.editingTitle,
      notes: this.sessionNotes,
      exercises: this.entries.map((e, i) => sheetToSync(e, this.canon.find(c => c.key === e.key), i))
    };
  }

  private async persistLive() {
    const id = this.liveId;
    if (!id) return;
    const state = this.liveState();
    if (this.synced && sameValue(state, this.synced)) return;
    this.synced = state;
    this.canon = state.exercises;
    try {
      await this.firebase.writeSharedWorkout(id, { exercises: state.exercises, notes: state.notes });
    } catch (err) {
      console.error('Log: live save failed', err);
      this.synced = null;
    }
  }

  private onLiveChange(id: string, w: MemberWorkoutLog | null) {
    if (this.liveId !== id) return;
    if (!w || !w.inProgress) {
      this.stopLiveDoc?.();
      this.stopLiveDoc = null;
      this.liveId = null;
      if (this.liveSaveTimer) { clearTimeout(this.liveSaveTimer); this.liveSaveTimer = null; }
      if (w) {
        // Finished: stays open here as a normal saved workout.
        this.presentToast(`${this.liveName} finished the workout`);
      } else {
        this.presentToast(`${this.liveName}'s workout was discarded`, 'danger');
        this.startFresh();
      }
      this.refreshHistory();
      return;
    }
    this.liveStartedAt = w.startedAt || this.liveStartedAt;
    const remote = normalizeState(w);
    const merged = this.synced ? merge3(this.synced, this.liveState(), remote) : remote;
    this.synced = remote;
    this.canon = merged.exercises;
    this.editingTitle = merged.title;
    this.sessionNotes = merged.notes;
    const sheets = merged.exercises.map((e, i) => syncToSheet(e, i)) as LoggedExercise[];
    if (!patchInPlace(this.entries, sheets, (x, i) => x.key || `x${i}`)) {
      this.entries = sheets;
      this.rebuildHints();
    }
    // Edits made here since the last save are still to be written.
    if (!sameValue(merged, remote)) this.markDirty();
  }

  // Ends the workout for both apps; it stays open here as a saved one.
  async finishLive() {
    const id = this.liveId;
    if (!id || this.saving) return;
    this.saving = true;
    try {
      if (this.liveSaveTimer) { clearTimeout(this.liveSaveTimer); this.liveSaveTimer = null; }
      const state = this.liveState();
      this.stopLiveDoc?.();
      this.stopLiveDoc = null;
      this.liveId = null;
      await this.firebase.writeSharedWorkout(id, {
        exercises: state.exercises,
        notes: state.notes,
        inProgress: false,
        timestamp: new Date().toISOString(),
        durationMin: this.liveStartedAt ? Math.max(1, Math.round((Date.now() - this.liveStartedAt) / 60000)) : null
      });
      await this.refreshHistory();
      await this.presentToast('Workout finished');
    } catch (err) {
      console.error('Log: finish failed', err);
      await this.presentToast('Could not finish the workout', 'danger');
    } finally {
      this.saving = false;
    }
  }

  startFresh() {
    this.clearEditing();
    this.date = localDateString();
    this.buildEntries();
  }

  async deleteCurrentLog() {
    if (!this.editingLogId) return;
    const alert = await this.alertController.create({
      header: 'Delete this log?',
      message: 'The recorded session data will be permanently deleted.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete', role: 'destructive', handler: async () => {
            try {
              await this.firebase.deleteWorkoutLog(this.editingLogId!, this.editingSource);
              await this.presentToast('Log deleted');
              this.startFresh();
              await this.refreshHistory();
            } catch (err) {
              console.error('Log: delete failed', err);
              await this.presentToast('Could not delete log', 'danger');
            }
          }
        }
      ]
    });
    await alert.present();
  }

  // Ionic keeps this page alive between visits, so coming back to it
  // reloads the list too.
  ionViewWillEnter() {
    if (this.loading) return;
    this.refreshHistory();
    // Opened again with a specific workout (e.g. from a client's page).
    const logId = this.route.snapshot.queryParamMap.get('logId');
    if (logId && logId !== this.editingLogId) this.loadExistingLog(logId);
  }

  ngOnDestroy() {
    this.stopLive();
    this.stopWatch?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  private watchHistory() {
    const key = this.selectedClient ? (this.selectedClient.nameKey || this.selectedClient.fullName).trim().toLowerCase() : null;
    if (key === this.watchingKey) return;
    this.stopWatch?.();
    this.watchingKey = key;
    let first = true;
    this.stopWatch = this.firebase.watchWorkoutChanges(key, () => this.zone.run(() => {
      if (first) { first = false; return; }   // the list was just loaded
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => this.refreshHistory(), 600);
    }));
  }

  // ---------- History ----------
  async refreshHistory() {
    this.watchHistory();
    try {
      if (this.selectedClientId) {
        this.history = await this.firebase.listWorkoutLogs({ clientId: this.selectedClientId, nameKey: this.selectedClient?.nameKey, max: 30 });
      } else if (this.selectedProgramId) {
        this.history = await this.firebase.listWorkoutLogs({ programId: this.selectedProgramId, max: 30 });
      } else {
        this.history = await this.firebase.listWorkoutLogs({ max: 30 });
      }
    } catch (err) {
      console.error('Log: failed to load history', err);
      this.history = [];
    }
  }

  historyDate(log: WorkoutLog): string {
    return this.shortDate(log.date);
  }

  // The day's name for a program session, else what the athlete named it.
  historyLabel(log: WorkoutLog): string {
    return log.dayName || log.title || 'Session';
  }

  goBack() {
    this.location.back();
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 1500, position: 'bottom', color });
    await toast.present();
  }
}
