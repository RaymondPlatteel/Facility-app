import { Component, HostListener, NgZone, OnDestroy, OnInit } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, arrowUp, arrowDown, add, addCircleOutline, barbellOutline, checkmark, checkmarkCircle,
  chevronDown, chevronUp, clipboardOutline, closeOutline, copyOutline, ellipsisHorizontal, flame,
  lockClosed, readerOutline, removeOutline, saveOutline, searchOutline, timeOutline, trashOutline,
  trendingUpOutline, trophy
} from 'ionicons/icons';
import {
  FirebaseService, Program, ProgramDay, ProgramAttribute, ClientProfile,
  WorkoutLog, LoggedExercise, SetLog, localDateString, MemberWorkoutLog
} from '../services/firebase.service';
import {
  SyncExercise, WorkoutSyncState, ensureExerciseKeys, merge3, newExerciseKey, normalizeState,
  patchInPlace, sameValue, sheetToSync, syncToSheet
} from '../services/workout-sync';
import {
  AttrKind, EXERCISE_PRESETS, LOG_ATTRIBUTE_TYPES, attrMeta, durationFromDigits, fmtDuration, formatTarget,
  isAttributeLocked, lockReason, parsePrescription, prescriptionText
} from '../services/attributes';
import { matchAssessmentLift } from '../services/omni.util';
import {
  LogSummary, SessionStats, exerciseKey, formatVolume, hasEntered, normName, prSetIndex, prevLabel,
  roundLoad, sessionStats, setE1rm, summarizeLog, topSetLabel, tracksMax
} from './log-math';

interface DayOption {
  index: number;
  label: string;   // "C1 · D2 — Upper"
  code: string;    // "C1 · D2"
  name: string;    // "Upper"
}

// What was prescribed for one column, and what a tick should log for it.
interface Target {
  text: string;          // shown above the column: "8–12", "70% 1RM"
  note: string;          // "≈ 185 lb" worked out from the athlete's history
  ghost: string;         // placeholder inside the empty field
  fill: string | null;   // what ticking the set logs when the field is empty
}

interface ExHints {
  chips: { type: string; text: string }[];
  targets: { [column: string]: Target };
  prev: SetLog[];        // the same lift last time
  prevDate: string;
  best: number | null;   // best estimated max before this session
}

const NO_HINTS: ExHints = { chips: [], targets: {}, prev: [], prevDate: '', best: null };

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
  // Phone width: the sheet drops the "previous" column and tightens up so
  // the set number and tick stay on screen.
  compact = window.innerWidth <= 560;

  programs: Program[] = [];
  clients: ClientProfile[] = [];

  // Selection
  selectedProgramId = '';
  private appliedProgramId = '';
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
  private editingDuration: number | null = null;

  // A workout being done right now, edited live: every change here goes to
  // the athlete's phone within a moment and theirs come back, merged three
  // ways (see workout-sync.ts). `synced` is the version both last agreed
  // on; `canon` keeps what this sheet can't show (video links).
  liveId: string | null = null;
  liveName = '';
  private stopLiveDoc: (() => void) | null = null;
  private synced: WorkoutSyncState | null = null;
  private canon: SyncExercise[] = [];
  private liveStartedAt: number | null = null;
  private liveSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  // Exercise cards: UI state by exercise key, so it survives live updates.
  private collapsedKeys = new Set<string>();
  private toolsKeys = new Set<string>();
  attrPanelKey: string | null = null;
  attrSearch = '';
  addOpen = false;
  newName = '';
  newPreset = 'strength';
  readonly presets = EXERCISE_PRESETS;

  // Prescription, last time and PR context per exercise key.
  hints: { [key: string]: ExHints } = {};
  private progIdx: { [key: string]: number } = {};
  exerciseNames: string[] = [];

  // Program progression for the selected client
  lastDoneLabel: string | null = null;
  programComplete = false;
  upNext: number | null = null;
  doneDays = new Set<number>();

  // History
  history: WorkoutLog[] = [];
  histSummary: { [id: string]: LogSummary } = {};
  private clientLogs: WorkoutLog[] = [];
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
      arrowBack, arrowUp, arrowDown, add, addCircleOutline, barbellOutline, checkmark, checkmarkCircle,
      chevronDown, chevronUp, clipboardOutline, closeOutline, copyOutline, ellipsisHorizontal, flame,
      lockClosed, readerOutline, removeOutline, saveOutline, searchOutline, timeOutline, trashOutline,
      trendingUpOutline, trophy
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

  private dayOptionsFor: Program | null = null;
  private dayOptionsCache: DayOption[] = [];

  get dayOptions(): DayOption[] {
    const p = this.selectedProgram;
    if (p !== this.dayOptionsFor) {
      this.dayOptionsFor = p;
      const cycleLabel = p?.isStandardWeek ? 'W' : 'C';
      this.dayOptionsCache = !p ? [] : p.schedule
        .map((day, index) => ({ day, index }))
        .filter(x => !x.day.isRestDay && x.day.exercises.length > 0)
        .map(x => {
          const code = `${cycleLabel}${Math.floor(x.index / p.daysPerCycle) + 1} · D${(x.index % p.daysPerCycle) + 1}`;
          const name = x.day.name && x.day.name !== `Day ${(x.index % p.daysPerCycle) + 1}` ? x.day.name : '';
          return { index: x.index, code, name, label: `${code}${name ? ' — ' + name : ''}` };
        });
    }
    return this.dayOptionsCache;
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
    this.editingDuration = null;
  }

  // Starting over throws away what was typed and not saved, so ask first.
  private async okToReplace(): Promise<boolean> {
    if (this.liveId || this.editingLogId || !hasEntered(this.entries)) return true;
    const alert = await this.alertController.create({
      header: 'Discard this sheet?',
      message: 'What you entered hasn\'t been saved.',
      buttons: [
        { text: 'Keep editing', role: 'cancel' },
        { text: 'Discard', role: 'destructive' }
      ]
    });
    await alert.present();
    return (await alert.onDidDismiss()).role === 'destructive';
  }

  async onProgramChange() {
    if (!(await this.okToReplace())) {
      this.selectedProgramId = this.appliedProgramId;
      return;
    }
    this.appliedProgramId = this.selectedProgramId;
    this.clearEditing();
    const opts = this.dayOptions;
    this.selectedDayIndex = opts.length > 0 ? opts[0].index : null;
    const p = this.selectedProgram;
    if (p && (p.assignedClientIds || []).length > 0 && !this.selectedClientId) {
      this.selectedClientId = p.assignedClientIds![0];
      await this.refreshHistory();
    }
    this.computeDoneDays();
    await this.autoAdvanceDay();
    this.buildEntries();
    setTimeout(() => this.scrollRailToSelected(), 120);
  }

  async pickDay(index: number) {
    if (index === this.selectedDayIndex && !this.editingLogId) return;
    if (!(await this.okToReplace())) return;
    this.clearEditing();
    this.selectedDayIndex = index;
    this.buildEntries();
  }

  // A client picked after the sheet was filled in keeps the sheet.
  async onClientChange() {
    const keep = !this.editingLogId && hasEntered(this.entries);
    if (!keep) this.clearEditing();
    await this.refreshHistory();
    if (keep) return;
    await this.autoAdvanceDay();
    this.buildEntries();
  }

  // ---------- Program progression ----------
  // Figure out where this client is in the program from their logged history,
  // and jump the day selector to the next training day they haven't done yet.
  private async autoAdvanceDay() {
    this.lastDoneLabel = null;
    this.programComplete = false;
    this.upNext = null;
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
      this.lastDoneLabel = `${lastOpt?.code || 'Last session'} on ${this.shortDate(pos.lastDate)}`;
    }

    if (pos.complete) {
      // Finished the last training day → program complete, don't force a day.
      this.programComplete = true;
      return;
    }
    if (pos.nextDayIndex !== null) {
      this.selectedDayIndex = pos.nextDayIndex;
      this.upNext = pos.nextDayIndex;
    }
  }

  private computeDoneDays() {
    this.doneDays = new Set(this.clientLogs
      .filter(l => l.programId === this.selectedProgramId && l.dayIndex !== null && !l.inProgress)
      .map(l => l.dayIndex as number));
  }

  // ---------- Build the log sheet from the prescription ----------
  private buildEntries() {
    const p = this.selectedProgram;
    this.entries = [];
    this.progIdx = {};
    this.collapsedKeys.clear();
    this.toolsKeys.clear();
    this.attrPanelKey = null;
    this.sessionNotes = '';
    if (p && this.selectedDayIndex !== null) {
      const day: ProgramDay | undefined = p.schedule[this.selectedDayIndex];
      day?.exercises.forEach((ex, i) => {
        const columns = ex.attributes.filter(a => a.type !== 'Sets').map(a => a.type);
        const entry: LoggedExercise = {
          key: newExerciseKey(),
          exerciseName: ex.name || 'Exercise',
          prescription: prescriptionText(ex.attributes),
          attrColumns: columns.length ? columns : ['Reps', 'Load', 'RIR'],
          sets: Array.from({ length: this.defaultSetCount(ex.attributes.find(a => a.type === 'Sets')) }, () => blankSet())
        };
        this.entries.push(entry);
        this.progIdx[entry.key as string] = i;
      });
    }
    this.rebuildHints();
  }

  private defaultSetCount(setsAttr?: ProgramAttribute): number {
    if (!setsAttr) return 3;
    if (setsAttr.strategy === 'Fixed') return Math.max(1, parseInt(setsAttr.val, 10) || 3);
    if (setsAttr.strategy === 'Range') return Math.max(1, parseInt(setsAttr.val.split('-')[0], 10) || 3);
    return 3;
  }

  // ---------- Hints: prescription, last time, PRs ----------
  private currentDayDef(): ProgramDay | null {
    const p = this.selectedProgram;
    return p && this.selectedDayIndex !== null ? p.schedule[this.selectedDayIndex] ?? null : null;
  }

  // Ties each exercise on the sheet to the program exercise it came from.
  // Ones built from a day already know; saved ones are matched by name.
  private matchProgramExercises() {
    const day = this.currentDayDef();
    const claimed = new Set(Object.values(this.progIdx).filter(i => i >= 0));
    const live = new Set(this.entries.map(e => e.key as string));
    for (const k of Object.keys(this.progIdx)) if (!live.has(k)) delete this.progIdx[k];
    for (const e of this.entries) {
      const key = e.key as string;
      if (key in this.progIdx) continue;
      const at = day ? day.exercises.findIndex((x, i) => !claimed.has(i) && (x.name || 'Exercise') === e.exerciseName) : -1;
      this.progIdx[key] = at;
      if (at >= 0) claimed.add(at);
    }
  }

  rebuildHints() {
    this.matchProgramExercises();
    const day = this.currentDayDef();
    const out: { [key: string]: ExHints } = {};
    for (const e of this.entries) {
      const key = e.key as string;
      const at = this.progIdx[key];
      const attrs = day && at >= 0 ? day.exercises[at].attributes : [];
      const prev = this.findPrevious(e.exerciseName);
      const best = this.bestFor(e.exerciseName);
      const targets: { [column: string]: Target } = {};
      for (const a of attrs) if (a.type !== 'Sets') targets[a.type] = this.targetFor(a, best);
      const chips = attrs.length
        ? attrs.map(a => ({ type: a.type, text: [formatTarget(a), targets[a.type]?.note].filter(Boolean).join(' ') }))
        : parsePrescription(e.prescription).map(c => ({ type: c.type, text: c.value }));
      out[key] = {
        chips,
        targets,
        prev: prev?.ex.sets || [],
        prevDate: prev?.date || '',
        best
      };
    }
    this.hints = out;
  }

  private targetFor(a: ProgramAttribute, best: number | null): Target {
    const text = formatTarget(a);
    const t: Target = { text, note: '', ghost: '', fill: null };
    switch (a.strategy) {
      case 'Fixed': {
        const v = a.type === 'Duration' ? fmtDuration(a.val) : a.val;
        t.ghost = v;
        t.fill = v && /[0-9]/.test(v) ? v : null;
        break;
      }
      case 'Range':
        t.ghost = text;
        break;
      case 'AMRAP':
        t.ghost = 'AMRAP';
        break;
      case 'Bodyweight':
        t.ghost = 'BW';
        t.fill = 'BW';
        break;
      case '%1RM': {
        const pct = parseFloat(a.val);
        t.ghost = a.val ? `${a.val}%` : '';
        if (a.type === 'Load' && best && pct > 0) {
          const load = roundLoad(best * pct / 100);
          t.note = `≈ ${load} lb`;
          t.ghost = String(load);
          t.fill = String(load);
        }
        break;
      }
      default:
        break;
    }
    return t;
  }

  private hasValues(s: SetLog): boolean {
    return Object.values(s.values || {}).some(v => (v || '').trim());
  }

  // The athlete's most recent session with this lift.
  private findPrevious(name: string): { ex: LoggedExercise; date: string } | null {
    const key = exerciseKey(name);
    if (!normName(name)) return null;
    for (const log of this.clientLogs) {
      if (log.inProgress || (log.id && log.id === this.editingLogId) || (!!this.date && log.date > this.date)) continue;
      const ex = log.exercises.find(e => exerciseKey(e.exerciseName) === key && e.sets.some(s => this.hasValues(s)));
      if (ex) return { ex, date: log.date };
    }
    return null;
  }

  // Best estimated one-rep max on this lift before today.
  private bestFor(name: string): number | null {
    if (!normName(name) || !tracksMax(name)) return null;
    const key = exerciseKey(name);
    let best = 0;
    for (const log of this.clientLogs) {
      if ((log.id && log.id === this.editingLogId) || (!!this.date && log.date > this.date)) continue;
      for (const e of log.exercises) {
        if (exerciseKey(e.exerciseName) !== key) continue;
        for (const s of e.sets) if (!s.warmup) best = Math.max(best, setE1rm(s) ?? 0);
      }
    }
    return best > 0 ? best : null;
  }

  private collectNames() {
    const names = new Map<string, string>();
    const add = (n: string) => { const k = normName(n); if (k && !names.has(k)) names.set(k, n.trim()); };
    this.programs.forEach(p => p.schedule?.forEach(d => d.exercises?.forEach(e => add(e.name || ''))));
    this.clientLogs.forEach(l => l.exercises.forEach(e => add(e.exerciseName)));
    this.exerciseNames = [...names.values()].sort((a, b) => a.localeCompare(b));
  }

  hint(e: LoggedExercise): ExHints {
    return this.hints[e.key as string] || NO_HINTS;
  }

  shortDate(key: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(key);
    if (!m) return key;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------- Exercise cards ----------
  trackKey(_i: number, e: LoggedExercise): string | undefined { return e.key; }
  trackIdx(i: number): number { return i; }

  benchmarkLabel(e: LoggedExercise): string | null {
    return matchAssessmentLift(e.exerciseName)?.label ?? null;
  }

  isCollapsed(e: LoggedExercise): boolean { return this.collapsedKeys.has(e.key as string); }
  toggleCollapse(e: LoggedExercise) {
    const k = e.key as string;
    if (!this.collapsedKeys.delete(k)) this.collapsedKeys.add(k);
  }

  isToolsOpen(e: LoggedExercise): boolean { return this.toolsKeys.has(e.key as string); }
  toggleTools(e: LoggedExercise) {
    const k = e.key as string;
    if (!this.toolsKeys.delete(k)) this.toolsKeys.add(k);
  }

  exDone(e: LoggedExercise): number { return e.sets.filter(s => s.done).length; }
  isComplete(e: LoggedExercise): boolean { return e.sets.length > 0 && this.exDone(e) === e.sets.length; }
  exProgress(e: LoggedExercise): string {
    return e.sets.length ? String(this.exDone(e) / e.sets.length) : '0';
  }
  exSummary(e: LoggedExercise): string {
    const top = topSetLabel(e);
    return `${this.exDone(e)}/${e.sets.length} sets${top ? ' · top ' + top : ''}`;
  }

  prIdx(e: LoggedExercise): number { return prSetIndex(e.sets, this.hint(e).best); }
  hasPr(e: LoggedExercise): boolean { return this.prIdx(e) >= 0; }

  jumpTo(e: LoggedExercise) {
    document.getElementById('ex-' + e.key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  onRename(e: LoggedExercise) {
    this.rebuildHints();
    this.markDirty();
  }

  moveExercise(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= this.entries.length) return;
    [this.entries[i], this.entries[j]] = [this.entries[j], this.entries[i]];
    this.markDirty();
  }

  duplicateExercise(i: number) {
    const src = this.entries[i];
    const copy: LoggedExercise = {
      key: newExerciseKey(),
      exerciseName: src.exerciseName,
      prescription: src.prescription,
      attrColumns: [...src.attrColumns],
      sets: src.sets.map(() => blankSet()),
      notes: ''
    };
    this.entries.splice(i + 1, 0, copy);
    this.rebuildHints();
    this.markDirty();
    setTimeout(() => this.jumpTo(copy));
  }

  async removeExercise(i: number) {
    const e = this.entries[i];
    const remove = () => {
      this.entries.splice(i, 1);
      this.rebuildHints();
      this.markDirty();
    };
    if (!hasEntered([e])) { remove(); return; }
    const alert = await this.alertController.create({
      header: 'Remove exercise?',
      message: `"${e.exerciseName || 'This exercise'}" and what you logged on it will be removed.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Remove', role: 'destructive', handler: remove }]
    });
    await alert.present();
  }

  // ---------- Add an exercise ----------
  openAdd() {
    this.addOpen = true;
    setTimeout(() => document.getElementById('new-ex-name')?.focus(), 60);
  }

  // The columns a new exercise starts with: what the athlete logged on it
  // last time, else the chosen starting point.
  get newPlan(): { columns: string[]; sets: number; fromHistory: boolean } {
    const prev = this.findPrevious(this.newName);
    if (prev && prev.ex.attrColumns.length) {
      return { columns: [...prev.ex.attrColumns], sets: Math.min(6, prev.ex.sets.length || 3), fromHistory: true };
    }
    const preset = EXERCISE_PRESETS.find(p => p.id === this.newPreset) || EXERCISE_PRESETS[0];
    return { columns: [...preset.columns], sets: preset.sets, fromHistory: false };
  }

  addExercise() {
    const name = this.newName.trim();
    if (!name) {
      this.presentToast('Name the exercise first', 'danger');
      document.getElementById('new-ex-name')?.focus();
      return;
    }
    const plan = this.newPlan;
    const entry: LoggedExercise = {
      key: newExerciseKey(),
      exerciseName: name,
      prescription: '',
      attrColumns: plan.columns,
      sets: Array.from({ length: plan.sets }, () => blankSet()),
      notes: ''
    };
    this.entries.push(entry);
    this.newName = '';
    this.addOpen = false;
    this.rebuildHints();
    this.markDirty();
    setTimeout(() => this.jumpTo(entry), 60);
  }

  // ---------- Attribute columns ----------
  attrOptions(e: LoggedExercise): string[] {
    const q = this.attrSearch.trim().toLowerCase();
    return LOG_ATTRIBUTE_TYPES
      .filter(t => !e.attrColumns.includes(t) && (!q || t.toLowerCase().includes(q)))
      .sort((a, b) => Number(this.isLocked(e, a)) - Number(this.isLocked(e, b)));
  }

  isLocked(e: LoggedExercise, type: string): boolean { return isAttributeLocked(e.attrColumns, type); }
  lockWhy(e: LoggedExercise, type: string): string { return lockReason(e.attrColumns, type); }

  toggleAttrPanel(e: LoggedExercise) {
    this.attrPanelKey = this.attrPanelKey === e.key ? null : (e.key as string);
    this.attrSearch = '';
  }

  addColumn(e: LoggedExercise, type: string) {
    if (this.isLocked(e, type)) return;
    e.attrColumns = [...e.attrColumns, type];
    this.attrPanelKey = null;
    this.rebuildHints();
    this.markDirty();
  }

  async removeColumn(e: LoggedExercise, col: string) {
    if (e.attrColumns.length <= 1) return;
    const drop = () => {
      e.attrColumns = e.attrColumns.filter(c => c !== col);
      e.sets.forEach(s => { delete s.values[col]; });
      this.markDirty();
    };
    if (!e.sets.some(s => (s.values?.[col] || '').trim())) { drop(); return; }
    const alert = await this.alertController.create({
      header: `Remove ${col}?`,
      message: `What's logged under ${col} on ${e.exerciseName || 'this exercise'} will be cleared.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, { text: 'Remove', role: 'destructive', handler: drop }]
    });
    await alert.present();
  }

  kind(col: string): AttrKind { return attrMeta(col).kind; }
  header(col: string): string { return attrMeta(col).header; }
  unit(col: string): string { return attrMeta(col).unit || ''; }
  mode(col: string): string { return attrMeta(col).mode; }

  @HostListener('window:resize')
  onResize() {
    this.compact = window.innerWidth <= 560;
  }

  hasPrev(e: LoggedExercise): boolean { return this.hint(e).prev.length > 0; }
  showPrev(e: LoggedExercise): boolean { return this.hasPrev(e) && !this.compact; }

  private colWidth(col: string): number {
    const w = attrMeta(col).width;
    return this.compact ? Math.round(w * 0.88) : w;
  }

  gridCols(e: LoggedExercise): string {
    const cols = [this.compact ? '36px' : '46px'];
    if (this.showPrev(e)) cols.push('108px');
    e.attrColumns.forEach(c => cols.push(`minmax(${this.colWidth(c)}px, 1fr)`));
    cols.push(this.compact ? '44px' : '56px');
    return cols.join(' ');
  }

  gridMin(e: LoggedExercise): number {
    const gaps = (e.attrColumns.length + (this.showPrev(e) ? 3 : 2)) * 8;
    return (this.compact ? 36 + 44 : 46 + 56) + (this.showPrev(e) ? 108 : 0)
      + e.attrColumns.reduce((t, c) => t + this.colWidth(c), 0) + gaps + 32;
  }

  target(e: LoggedExercise, col: string): Target | null {
    return this.hint(e).targets[col] || null;
  }

  ghost(e: LoggedExercise, col: string): string {
    return this.target(e, col)?.ghost || '';
  }

  tempoGhost(e: LoggedExercise, col: string, n: number): string {
    const g = (this.target(e, col)?.ghost || '').split('-')[n];
    return g || '–';
  }

  tempoPart(set: SetLog, col: string, n: number): string {
    return (set.values?.[col] || '').split('-')[n] || '';
  }

  // ---------- Set editing ----------
  setLabel(e: LoggedExercise, i: number): string {
    if (e.sets[i].warmup) return 'W';
    return String(e.sets.slice(0, i + 1).filter(s => !s.warmup).length);
  }

  addSet(e: LoggedExercise, copyLast = false) {
    const last = e.sets[e.sets.length - 1];
    e.sets.push(copyLast && last ? { values: { ...last.values }, done: false, warmup: !!last.warmup } : blankSet());
    this.markDirty();
  }

  removeSet(e: LoggedExercise) {
    if (e.sets.length > 1) e.sets.pop();
    this.markDirty();
  }

  toggleWarmup(set: SetLog) {
    set.warmup = !set.warmup;
    this.markDirty();
  }

  // Ticking a set off with fields left empty logs what was prescribed.
  toggleDone(e: LoggedExercise, set: SetLog) {
    set.done = !set.done;
    if (set.done && !set.warmup) {
      const targets = this.hint(e).targets;
      for (const col of e.attrColumns) {
        if ((set.values[col] || '').trim()) continue;
        const fill = targets[col]?.fill;
        if (fill) set.values[col] = fill;
      }
    }
    this.markDirty();
  }

  // Everything went as prescribed: tick every set, filling what was prescribed.
  completeAll(e: LoggedExercise) {
    for (const set of e.sets) if (!set.done) this.toggleDone(e, set);
  }

  prevText(e: LoggedExercise, i: number): string {
    return prevLabel(this.hint(e).prev[i], e.attrColumns);
  }

  // Every empty field on the sheet from the same set last time.
  useLastTime(e: LoggedExercise) {
    const prev = this.hint(e).prev;
    e.sets.forEach((set, i) => {
      const p = prev[i];
      if (!p) return;
      for (const col of e.attrColumns) {
        const v = p.values?.[col] ?? (col === 'Load' ? p.values?.['Weight'] : undefined);
        if (v && !(set.values[col] || '').trim()) set.values[col] = v;
      }
    });
    this.markDirty();
  }

  usePrev(e: LoggedExercise, i: number) {
    const prev = this.hint(e).prev[i];
    if (!prev) return;
    for (const col of e.attrColumns) {
      const v = prev.values?.[col] ?? (col === 'Load' ? prev.values?.['Weight'] : undefined);
      if (v) e.sets[i].values[col] = v;
    }
    this.markDirty();
  }

  selectAll(ev: Event) {
    const el = ev.target as HTMLInputElement;
    setTimeout(() => { try { el.setSelectionRange(0, el.value.length); } catch { /* not selectable */ } });
  }

  // Four boxes, one digit each, that hand the cursor on.
  onTempo(ev: Event, set: SetLog, col: string, n: number) {
    const el = ev.target as HTMLInputElement;
    const ch = el.value.replace(/[^0-9xX]/g, '').slice(-1).toUpperCase();
    el.value = ch;
    const parts = (set.values[col] || '').split('-');
    while (parts.length < 4) parts.push('');
    parts[n] = ch;
    if (parts.some(p => p)) set.values[col] = parts.join('-');
    else delete set.values[col];
    // the next box's digit is selected, so the next key replaces it
    const next = el.parentElement?.querySelectorAll('input')[n + 1] as HTMLInputElement | undefined;
    if (ch && n < 3 && next) { next.focus(); next.select(); }
    this.markDirty();
  }

  // Digits slide in from the right, like a kitchen timer.
  onDuration(ev: Event, set: SetLog, col: string) {
    const el = ev.target as HTMLInputElement;
    const text = durationFromDigits(el.value);
    el.value = text;
    if (text) set.values[col] = text;
    else delete set.values[col];
    this.markDirty();
  }

  onValue(set: SetLog, col: string) {
    if (!(set.values[col] || '').trim()) delete set.values[col];
    this.markDirty();
  }

  // ---------- Session numbers ----------
  get stats(): SessionStats { return sessionStats(this.entries); }
  get prCount(): number { return this.entries.filter(e => this.hasPr(e)).length; }
  fmtVolume(v: number): string { return formatVolume(v); }
  fmtDur(seconds: number): string { return fmtDuration(String(Math.round(seconds))); }

  get elapsedLabel(): string {
    if (this.liveId && this.liveStartedAt) {
      const m = Math.max(0, Math.floor((Date.now() - this.liveStartedAt) / 60000));
      return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
    }
    return this.editingDuration ? `${this.editingDuration} min` : '';
  }

  get sessionLabel(): string {
    const day = this.dayOptions.find(o => o.index === this.selectedDayIndex);
    if (this.selectedProgramId && day && !this.editingTitle) return day.label;
    return this.editingTitle || (this.selectedProgram?.name ?? 'Freeform workout');
  }

  // ---------- Save / load / delete ----------
  get canSave(): boolean {
    return !!(this.selectedClientId || this.selectedClient) && this.entries.length > 0 && !!this.date;
  }

  async save() {
    if (!this.canSave || this.saving) return;
    const wasNew = !this.editingLogId;
    const prs = this.prCount;
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
        dayIndex: this.selectedProgramId ? this.selectedDayIndex : null,
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
      const prNote = prs ? ` · ${prs} new PR${prs === 1 ? '' : 's'}` : '';
      // Fresh session → advance to the next day in the program automatically.
      if (wasNew && this.selectedProgramId && this.selectedClientId) {
        this.clearEditing();
        this.date = localDateString();
        await this.autoAdvanceDay();
        this.buildEntries();
        await this.presentToast(
          this.programComplete
            ? `Logged — program complete${prNote}`
            : `Logged${prNote} — up next: Day ${this.dayPosition} of ${this.dayTotal}`
        );
      } else {
        await this.presentToast(`Session logged${prNote}`);
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
    setTimeout(() => this.scrollRailToSelected(), 80);
  }

  applyLog(log: WorkoutLog) {
    this.stopLive();
    this.editingLogId = log.id || null;
    this.editingSource = log.source;
    this.editingTitle = log.title || '';
    this.editingDuration = log.durationMin ?? null;
    this.selectedProgramId = log.programId || '';
    this.appliedProgramId = this.selectedProgramId;
    this.selectedDayIndex = log.dayIndex;
    this.selectedClientId = log.clientId || this.clients.find(c =>
      (c.nameKey || c.fullName).trim().toLowerCase() === log.clientName.trim().toLowerCase())?.id || '';
    this.date = log.date;
    this.entries = ensureExerciseKeys(JSON.parse(JSON.stringify(log.exercises)) as LoggedExercise[]);
    this.sessionNotes = log.sessionNotes || '';
    this.progIdx = {};
    this.collapsedKeys.clear();
    this.toolsKeys.clear();
    this.attrPanelKey = null;
    this.upNext = null;
    this.rebuildHints();
    this.refreshHistory();
  }

  // ---------- Live ----------
  private startLive(id: string, clientName: string) {
    this.liveId = id;
    this.liveName = (clientName || '').trim().split(/\s+/)[0] || 'the athlete';
    this.synced = null;
    this.stopLiveDoc = this.firebase.watchSharedWorkout(id, w => this.zone.run(() => this.onLiveChange(id, w)));
    // The elapsed minutes need a nudge to move on their own.
    this.clearTick();
    this.tick = setInterval(() => this.zone.run(() => undefined), 30000);
  }

  private clearTick() {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
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
    this.clearTick();
    this.liveId = null;
    this.liveStartedAt = null;
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
      this.clearTick();
      this.liveId = null;
      if (this.liveSaveTimer) { clearTimeout(this.liveSaveTimer); this.liveSaveTimer = null; }
      if (w) {
        // Finished: stays open here as a normal saved workout.
        this.editingDuration = w.durationMin ?? null;
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
      const minutes = this.liveStartedAt ? Math.max(1, Math.round((Date.now() - this.liveStartedAt) / 60000)) : null;
      this.stopLiveDoc?.();
      this.stopLiveDoc = null;
      this.clearTick();
      this.liveId = null;
      this.editingDuration = minutes;
      await this.firebase.writeSharedWorkout(id, {
        exercises: state.exercises,
        notes: state.notes,
        inProgress: false,
        timestamp: new Date().toISOString(),
        durationMin: minutes
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

  // Any workout can be deleted from the list, whoever recorded it.
  async deleteLog(log: WorkoutLog, event: Event) {
    event.stopPropagation();
    if (!log.id) return;
    const alert = await this.alertController.create({
      header: 'Delete this workout?',
      message: `${log.clientName || 'This client'}'s ${this.historyLabel(log)} on ${this.historyDate(log)} will be permanently deleted.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete', role: 'destructive', handler: async () => {
            try {
              await this.firebase.deleteWorkoutLog(log.id!, log.source);
              if (log.id === this.editingLogId) this.startFresh();
              await this.refreshHistory();
              await this.presentToast('Workout deleted');
            } catch (err) {
              console.error('Log: delete failed', err);
              await this.presentToast('Could not delete the workout', 'danger');
            }
          }
        }
      ]
    });
    await alert.present();
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
    this.clearTick();
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
  // Loads the selected client's whole history (the sheet's "previous" and
  // PR numbers come from it) and shows the newest of it below.
  async refreshHistory() {
    this.watchHistory();
    const clientId = this.selectedClientId;
    try {
      let logs: WorkoutLog[];
      if (clientId) {
        logs = await this.firebase.listWorkoutLogs({ clientId, nameKey: this.selectedClient?.nameKey });
        if (clientId !== this.selectedClientId) return;   // picked someone else meanwhile
        this.clientLogs = logs;
        this.history = logs.slice(0, 30);
      } else {
        this.clientLogs = [];
        this.history = await this.firebase.listWorkoutLogs(
          this.selectedProgramId ? { programId: this.selectedProgramId, max: 30 } : { max: 30 });
      }
    } catch (err) {
      console.error('Log: failed to load history', err);
      this.history = [];
      this.clientLogs = [];
    }
    this.histSummary = {};
    for (const l of this.history) if (l.id) this.histSummary[l.id] = summarizeLog(l);
    this.computeDoneDays();
    this.collectNames();
    this.rebuildHints();
    setTimeout(() => this.scrollRailToSelected(), 60);
  }

  summary(log: WorkoutLog): LogSummary | null {
    return log.id ? this.histSummary[log.id] || null : null;
  }

  historyDate(log: WorkoutLog): string {
    return this.shortDate(log.date);
  }

  // The day's name for a program session, else what the athlete named it.
  historyLabel(log: WorkoutLog): string {
    return log.dayName || log.title || 'Session';
  }

  // Keeps the chosen day in view along the day strip, without moving the page.
  scrollRailToSelected() {
    const rail = document.querySelector('.rail-scroll') as HTMLElement | null;
    const chip = rail?.querySelector('.day-chip.sel') as HTMLElement | null;
    if (!rail || !chip) return;
    rail.scrollTo({ left: chip.offsetLeft - (rail.clientWidth - chip.clientWidth) / 2, behavior: 'smooth' });
  }

  goBack() {
    this.location.back();
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 1800, position: 'bottom', color });
    await toast.present();
  }
}

function blankSet(): SetLog {
  return { values: {}, done: false };
}
