import { Component, OnDestroy, OnInit, HostListener, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, watchOutline, pulseOutline, flashOutline,
  timerOutline, hardwareChipOutline, bluetoothOutline, checkmark,
  personOutline, peopleOutline, saveOutline, optionsOutline, refreshOutline,
  addOutline, close, chevronDown
} from 'ionicons/icons';
import { Subscription } from 'rxjs';
import {
  FirebaseService, WorkoutLog, ClientProfile, Program,
  LoggedExercise, SetLog, AssessmentInputs, localDateString, Sex, MemberWorkoutLog } from '../services/firebase.service';
import {
  WorkoutSyncState, SyncExercise, ensureExerciseKeys, isLiveWorkout, merge3, newExerciseKey,
  normalizeState, patchInPlace, sameValue, sheetToSync, syncToSheet
} from '../services/workout-sync';
import { HeartRateService, WatchSlot } from '../services/heart-rate.service';
import {
  matchAssessmentLift, brzycki, computeOmni, getOmniRank, blankAssessmentInputs
} from '../services/omni.util';

interface ProtocolRow {
  num: number;
  name: string;
  reps: string;
  weight: string;
  rest: string;
}

interface IntervalBar {
  label: string;
  pct: number;     // 0-100 bar height
  value: string;
}

interface StatBlock {
  label: string;
  value: string;
  unit: string;
  accent?: boolean;
  color?: string;
}

type HrSample = { t: number; hr: number };

// One athlete's session: their workout log + heart-rate stream.
interface Lane {
  id: 'A' | 'B';
  color: string;
  clientId: string;
  clientName: string;
  program: Program | null;
  dayIndex: number | null;
  dayPosition: number;
  dayTotal: number;
  programLabel: string;
  entries: LoggedExercise[];
  targets: number[];
  prev: string[];          // per-exercise "last session" summary (e.g. "100×5 · 100×5")
  prevSets: Record<string, string>[][]; // per-exercise, per-set: last session's actual column values (e.g. prevSets[i][s]['RIR'] = '2'), used as per-field placeholders
  editingLogId: string | null;  // the workout being edited, whichever collection — skipped for "last time"
  nameKey: string;
  history: WorkoutLog[];        // past workouts from both apps, newest first
  // The shared workout this lane is editing live with the athlete's phone
  // (see workout-sync.ts). synced is the version both sides last agreed on;
  // canon is the workout as last stored, which keeps what the sheet can't
  // show (warm-up flags, set videos).
  sharedId: string | null;
  synced: WorkoutSyncState | null;
  canon: SyncExercise[];
  docTitle: string;
  docNotes: string;
  startedAt: number | null;
  creating: Promise<void> | null;
  stopDoc: (() => void) | null;
  stopLive: (() => void) | null;
  // Today's unfinished session from before workouts were shared — keeps
  // saving the old way so it isn't split across two records.
  legacyLogId: string | null;
  programComplete: boolean;
  noProgram: boolean;
  emptyProgram: boolean;   // program assigned but no day has exercises
  pickerOpen: boolean;     // program picker shown for an unassigned client
  dayPickerOpen: boolean;  // day-switcher dropdown shown for the lane
  dayList: { index: number; position: number; label: string }[];  // stable list for the picker
  saveTimer: any;
  newExerciseName: string; // typed into the "add exercise" field, cleared on add
  addExerciseOpen: boolean; // "add exercise" input expanded for this lane
  // Heart rate (from a paired sensor, or simulated)
  demoSamples: HrSample[];
  demoPhase: number;
  hrNow: number | null;
  hrAvg: number | null;
  hrMax: number | null;
  kcal: number;
  zonePct: number;
  linePoints: string;
  endXPct: number;   // last point of the trace, as % of chart width (-1 = none)
  endYPct: number;   // last point of the trace, as % of chart height
  zones: IntervalBar[];
}

const LANE_A_COLOR = '#00d4ff';
const LANE_B_COLOR = '#f5b942';

// Demo protocol shown until a real workout log exists for today
const DEMO_PROTOCOL: Array<[string, string, string, string]> = [
  ['Back Squat', '5', '102.5', '180'],
  ['Bench Press', '5', '82.5', '180'],
  ['Pendlay Row', '6', '70.0', '150'],
  ['Overhead Press', '8', '47.5', '120'],
  ['Romanian Deadlift', '8', '90.0', '120'],
  ['Weighted Pull-Up', '6', '+15.0', '120'],
  ['Bulgarian Split Squat', '10', '22.5', '90'],
  ['Incline DB Press', '10', '30.0', '90'],
  ['Seated Cable Row', '12', '60.0', '75'],
  ['Lateral Raise', '15', '10.0', '60'],
  ['Hanging Leg Raise', '12', 'BW', '60'],
  ['Farmer Carry', '40m', '2×32', '90'],
];

const DEMO_HISTORY: Array<[string, string, string, string]> = [
  ['Back Squat', '5 × 5', '100.0', '178'],
  ['Bench Press', '5 × 5', '80.0', '182'],
  ['Pendlay Row', '6 × 4', '67.5', '149'],
  ['Overhead Press', '8 × 3', '45.0', '118'],
  ['Romanian Deadlift', '8 × 3', '87.5', '121'],
  ['Weighted Pull-Up', '6 × 4', '+12.5', '117'],
];

// A heart-rate zone: everything below `max` (% of max HR) and above the
// previous zone's max. The last zone's max acts as +infinity.
interface ZoneDef { label: string; max: number; color: string; }
const DEFAULT_ZONES: ZoneDef[] = [
  { label: 'Z1', max: 60,  color: '#6a8aa3' }, // recovery
  { label: 'Z2', max: 70,  color: '#00d4ff' }, // easy
  { label: 'Z3', max: 80,  color: '#2dd36f' }, // aerobic
  { label: 'Z4', max: 90,  color: '#f5b942' }, // threshold
  { label: 'Z5', max: 999, color: '#ff5a6a' }  // max
];
const ZONE_CFG_KEY = 'ls_zone_config';

@Component({
  selector: 'app-live-session',
  templateUrl: './live-session.page.html',
  styleUrls: ['./live-session.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class LiveSessionPage implements OnInit, OnDestroy {
  // Specimen / demo tables
  protocolRows: ProtocolRow[] = [];
  historyRows: ProtocolRow[] = [];
  coachNotes = 'Maintain bar speed on working sets. Cap RPE at 8.';

  // Base data
  clients: ClientProfile[] = [];
  programs: Program[] = [];
  private forcedProgramId: string | null = null;

  // Athletes
  lanes: Lane[] = [];
  duo = false;

  // Shared heart-rate chart
  hrAreaPath = '';
  hrAxis: number[] = [200, 150, 100, 50];
  simulated = true;

  // Configurable HR zones + zone-based graph coloring
  zones: ZoneDef[] = DEFAULT_ZONES.map(z => ({ ...z }));
  zoneColoring = true;
  showZoneSettings = false;

  // Right rail
  stats: StatBlock[] = [];

  sessionClock = '00:00';
  wallClock = '';

  private startedAt = Date.now();
  private tickTimer: any = null;
  private finishing = false;
  private hrSub: Subscription | null = null;

  constructor(
    private firebase: FirebaseService,
    private heartRate: HeartRateService,
    private router: Router,
    private route: ActivatedRoute,
    private toast: ToastController,
    private zone: NgZone
  ) {
    addIcons({
      arrowBack, watchOutline, pulseOutline, flashOutline,
      timerOutline, hardwareChipOutline, bluetoothOutline, checkmark,
      personOutline, peopleOutline, saveOutline, optionsOutline, refreshOutline,
      addOutline, close, chevronDown
    });
  }

  async ngOnInit() {
    this.lanes = [this.makeLane('A', LANE_A_COLOR)];
    this.loadZoneConfig();
    this.buildDemoTables();
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 1000);
    this.hrSub = this.heartRate.changes.subscribe(() => this.refreshHr());

    try {
      [this.programs, this.clients] = await Promise.all([
        this.firebase.listPrograms(),
        this.firebase.listClientProfiles()
      ]);
      this.clients.sort((a, b) => a.fullName.localeCompare(b.fullName));
    } catch (err) {
      console.error('Live session: failed to load base data', err);
    }

    const qp = this.route.snapshot.queryParamMap;
    this.forcedProgramId = qp.get('programId');
    const clientId = qp.get('clientId');
    if (clientId) await this.loadLane(this.lanes[0], clientId);
  }

  ngOnDestroy() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.lanes.forEach(lane => {
      if (lane.saveTimer) { clearTimeout(lane.saveTimer); lane.saveTimer = null; this.persist(lane); }
      this.detachLane(lane);
    });
    this.hrSub?.unsubscribe();
  }

  private makeLane(id: 'A' | 'B', color: string): Lane {
    return {
      id, color,
      clientId: '', clientName: '', program: null,
      dayIndex: null, dayPosition: 0, dayTotal: 0, programLabel: '',
      entries: [], targets: [], prev: [], prevSets: [], editingLogId: null,
      nameKey: '', history: [], sharedId: null, synced: null, canon: [], docTitle: '', docNotes: '',
      startedAt: null, creating: null, stopDoc: null, stopLive: null, legacyLogId: null,
      programComplete: false, noProgram: false, emptyProgram: false, pickerOpen: false, dayPickerOpen: false, dayList: [], saveTimer: null,
      newExerciseName: '', addExerciseOpen: false,
      demoSamples: [], demoPhase: Math.random() * 100,
      hrNow: null, hrAvg: null, hrMax: null, kcal: 0, zonePct: 0,
      linePoints: '', endXPct: -1, endYPct: -1, zones: []
    };
  }

  // ---------- Mode ----------
  get usingDemoProtocol(): boolean {
    return !this.duo && !this.lanes[0]?.clientId;
  }

  get laneA(): Lane { return this.lanes[0]; }

  setDuo(on: boolean) {
    if (on === this.duo) return;
    this.duo = on;
    if (on) {
      if (this.lanes.length < 2) this.lanes.push(this.makeLane('B', LANE_B_COLOR));
    } else {
      const b = this.lanes[1];
      if (b) { if (b.saveTimer) clearTimeout(b.saveTimer); this.persist(b); this.detachLane(b); }
      this.lanes = this.lanes.slice(0, 1);
    }
    this.refreshHr();
  }

  // ---------- Header ----------
  get headerTitle(): string {
    if (this.usingDemoProtocol) return 'LIVE WORKOUT';
    if (this.duo) {
      const names = this.lanes.map(l => this.firstName(l.clientName)).filter(Boolean);
      return names.length ? names.join('  ×  ') : 'DUO SESSION';
    }
    const a = this.laneA;
    if (a.program) return a.program.name.toUpperCase();
    return (a.clientName || 'LIVE SESSION').toUpperCase();
  }

  get headerSubtitle(): string {
    if (this.usingDemoProtocol) return 'Project [000]';
    if (this.duo) return 'TWO-ATHLETE SESSION · Project [000]';
    const a = this.laneA;
    if (!a.program) return 'EXPERIMENTAL PERFORMANCE INTERFACE · Project [000]';
    const day = a.dayIndex !== null ? a.program.schedule[a.dayIndex]?.name : '';
    const dayLabel = a.dayTotal ? `DAY ${a.dayPosition} OF ${a.dayTotal}` : '';
    return [a.clientName, day, dayLabel].filter(Boolean).join(' · ').toUpperCase() || 'OMNILAB';
  }

  private firstName(name: string): string {
    return (name || '').trim().split(/\s+/)[0] || '';
  }

  // ---------- Watch ----------
  get activeSlot(): WatchSlot | null {
    return this.heartRate.slots.find(s => s.connected) || null;
  }

  get bluetoothSupported(): boolean {
    return this.heartRate.isSupported();
  }

  private slotForLane(idx: number): WatchSlot | null {
    const s = this.heartRate.slots[idx];
    return s && s.connected ? s : null;
  }

  async connectWatch() {
    try {
      await this.heartRate.addWatch();
      this.refreshHr();
    } catch (err) {
      console.error('Live session: watch connect failed', err);
    }
  }

  // ---------- Athlete selection ----------
  clientOptions(lane: Lane): ClientProfile[] {
    const taken = this.lanes.filter(l => l !== lane && l.clientId).map(l => l.clientId);
    return this.clients.filter(c => !taken.includes(c.id!));
  }

  laneTag(lane: Lane): string {
    if (!lane.clientId) return '—';
    if (lane.noProgram) return 'NO PROGRAM';
    if (lane.emptyProgram) return 'NO DAYS';
    if (lane.programComplete) return 'COMPLETE';
    return lane.dayTotal ? `DAY ${lane.dayPosition}/${lane.dayTotal}` : 'LIVE';
  }

  // ---------- Manual day switch (click the DAY x/y badge) ----------
  // True when the badge can open a day picker (a program with training days).
  canPickDay(lane: Lane): boolean {
    return !!lane.program && lane.dayTotal > 0 && !lane.noProgram && !lane.emptyProgram;
  }

  // The program's training days, for the dropdown.
  dayOptions(lane: Lane): { index: number; position: number; label: string }[] {
    if (!lane.program) return [];
    const order = this.firebase.programTrainingDays(lane.program);
    return order.map((index, i) => ({
      index,
      position: i + 1,
      label: lane.program!.schedule[index]?.name || `Day ${i + 1}`
    }));
  }

  toggleDayPicker(lane: Lane) {
    if (!this.canPickDay(lane)) return;
    const willOpen = !lane.dayPickerOpen;
    this.lanes.forEach(l => l.dayPickerOpen = false);
    lane.dayPickerOpen = willOpen;
  }

  // Close any open day picker on an outside click (badge/menu clicks stop propagation).
  @HostListener('document:click')
  closeDayPickers() {
    this.lanes.forEach(l => l.dayPickerOpen = false);
  }

  // Switch the lane to a specific program day, loading its prescription.
  // Mid-workout, that day replaces what the shared workout holds (asked
  // first once anything's been logged), and the athlete's phone follows.
  async pickDay(lane: Lane, dayIndex: number) {
    lane.dayPickerOpen = false;
    if (!lane.program || dayIndex === lane.dayIndex) return;
    const order = this.firebase.programTrainingDays(lane.program);
    if (!order.includes(dayIndex)) return;

    // Flush any pending autosave of the current day before switching.
    if (lane.saveTimer) { clearTimeout(lane.saveTimer); lane.saveTimer = null; await this.persist(lane); }

    const logged = lane.entries.some(e => e.sets.some(s => s.done || Object.values(s.values || {}).some(v => (v || '').trim())));
    const day = lane.program.schedule[dayIndex];
    if (lane.sharedId && logged && !confirm(`Switch to ${day?.name || 'that day'}? What's logged in this workout will be replaced.`)) return;

    lane.programComplete = false;
    lane.emptyProgram = false;
    lane.legacyLogId = null;
    lane.entries = this.firebase.buildSessionExercises(lane.program, dayIndex);
    lane.dayIndex = dayIndex;
    lane.dayPosition = order.indexOf(dayIndex) + 1;
    lane.programLabel = [lane.program.name, day?.name].filter(Boolean).join(' · ').toUpperCase();

    if (lane.sharedId) {
      lane.canon = [];
      lane.docTitle = [lane.program.name, day?.name].filter(Boolean).join(' — ');
      const state = this.laneState(lane);
      lane.synced = state;
      lane.canon = state.exercises;
      try {
        await this.firebase.writeSharedWorkout(lane.sharedId, {
          title: lane.docTitle,
          exercises: state.exercises,
          programId: lane.program.id || null,
          programName: lane.program.name,
          dayIndex,
          dayName: day?.name || null
        });
      } catch (err) {
        console.error('Live session: day switch save failed', err);
      }
    } else {
      lane.editingLogId = null;
    }
    this.refreshLaneHints(lane);
  }

  private programForClient(clientId: string): Program | null {
    if (this.forcedProgramId) {
      const forced = this.programs.find(p => p.id === this.forcedProgramId);
      if (forced) return forced;
    }
    const assigned = this.programs.filter(p => (p.assignedClientIds || []).includes(clientId));
    return assigned.find(p => p.status === 'active') || assigned[0] || null;
  }

  // Bound from the template's lane picker
  onLaneClient(lane: Lane, clientId: string) {
    this.loadLane(lane, clientId);
  }

  // ---------- Quick program assignment (for unassigned clients) ----------
  openProgramPicker(lane: Lane) { lane.pickerOpen = true; }
  closeProgramPicker(lane: Lane) { lane.pickerOpen = false; }

  // Number of runnable (non-rest, has-exercises) days in a program.
  programDayCount(program: Program): number {
    return this.firebase.programTrainingDays(program).length;
  }

  // Assign the chosen program to this lane's client (persisted so it sticks),
  // then load it into the lane so the session can start immediately.
  async chooseProgram(lane: Lane, program: Program) {
    lane.pickerOpen = false;
    if (!lane.clientId) return;
    try {
      program.assignedClientIds = Array.from(new Set([...(program.assignedClientIds || []), lane.clientId]));
      program.assignedClientNames = Array.from(
        new Set([...(program.assignedClientNames || []), lane.clientName].filter(Boolean))
      );
      await this.firebase.saveProgram(program);
    } catch (err) {
      console.error('Live session: assign program failed', err);
    }
    await this.loadLane(lane, lane.clientId);
  }

  async loadLane(lane: Lane, clientId: string) {
    this.detachLane(lane);
    lane.clientId = clientId;
    lane.editingLogId = null;
    lane.legacyLogId = null;
    lane.programComplete = false;
    lane.noProgram = false;
    lane.emptyProgram = false;
    lane.pickerOpen = false;
    lane.dayPickerOpen = false;
    lane.dayList = [];
    lane.entries = [];
    lane.targets = [];
    lane.prev = [];
    lane.prevSets = [];
    lane.dayPosition = 0;
    lane.dayTotal = 0;
    lane.program = null;
    lane.programLabel = '';
    lane.history = [];

    if (!clientId) { lane.clientName = ''; lane.nameKey = ''; return; }

    const client = this.clients.find(c => c.id === clientId);
    lane.clientName = client?.fullName || '';
    lane.nameKey = (client?.nameKey || lane.clientName).trim().toLowerCase();

    try {
      lane.history = await this.firebase.listWorkoutLogs({ clientId, nameKey: lane.nameKey });
    } catch (err) {
      console.error('Live session: failed to load workout history', err);
    }
    if (lane.clientId !== clientId) return;   // switched athlete while loading

    // Already under way today, on either app — join it.
    const live = lane.history.find(l => l.source === 'member' && l.inProgress && l.id);
    if (live) {
      await this.joinShared(lane, live.id!);
      this.watchForAthlete(lane);
      return;
    }

    const program = this.programForClient(clientId);
    if (!program) {
      lane.noProgram = true;
      this.watchForAthlete(lane);
      return;
    }

    lane.program = program;
    const order = this.firebase.programTrainingDays(program);
    lane.dayTotal = order.length;
    lane.dayList = this.dayOptions(lane);   // stable list (built once, not per change-detection)
    const logs = lane.history.filter(l => l.programId === program.id);
    const today = localDateString();

    // An unfinished coach session from today, saved before workouts were
    // shared, picks up where it left off; a finished one advances.
    const todayLog = logs.find(l =>
      l.source === 'coach' && l.date === today && l.dayIndex !== null && order.includes(l.dayIndex!) && l.completed === false
    );
    if (todayLog) {
      lane.dayIndex = todayLog.dayIndex;
      lane.editingLogId = todayLog.id || null;
      lane.legacyLogId = todayLog.id || null;
      lane.entries = ensureExerciseKeys(JSON.parse(JSON.stringify(todayLog.exercises)) as LoggedExercise[]);
    } else if (order.length === 0) {
      // Program assigned but no day has exercises — nothing to run yet.
      lane.emptyProgram = true;
      lane.dayIndex = null;
      lane.entries = [];
    } else {
      const last = logs.find(l => l.dayIndex !== null && order.includes(l.dayIndex!));
      // Loop back to the first training day once the written program is
      // finished, so an ongoing client always has the next session queued
      // instead of a dead-end blank "complete" state.
      const nextPos = last ? (order.indexOf(last.dayIndex!) + 1) % order.length : 0;
      lane.dayIndex = order[nextPos];
      lane.entries = this.firebase.buildSessionExercises(program, lane.dayIndex);
    }

    if (lane.dayIndex !== null) {
      lane.dayPosition = order.indexOf(lane.dayIndex) + 1;
      const day = program.schedule[lane.dayIndex];
      lane.programLabel = [program.name, day?.name].filter(Boolean).join(' · ').toUpperCase();
    } else {
      lane.programLabel = `${program.name} · NO WORKOUT DAYS`.toUpperCase();
    }
    this.refreshLaneHints(lane);
    this.watchForAthlete(lane);
  }

  // "Last time" per exercise and the set targets, from the lane's history.
  private refreshLaneHints(lane: Lane) {
    // Previous weights: for each exercise, the values from the most recent
    // prior workout that contains it — so the coach can match or beat last
    // time. Skips the workout being edited.
    lane.prev = lane.entries.map(ex => this.previousSummary(ex, lane.history, lane.editingLogId));
    lane.prevSets = lane.entries.map(ex => this.previousSets(ex, lane.history, lane.editingLogId));
    lane.targets = lane.entries.map(ex => Math.max(1, ex.sets.length));
  }

  // ---------- Live, shared with the athlete's phone ----------
  private detachLane(lane: Lane) {
    lane.stopDoc?.();
    lane.stopLive?.();
    lane.stopDoc = null;
    lane.stopLive = null;
    lane.sharedId = null;
    lane.synced = null;
    lane.canon = [];
    lane.docTitle = '';
    lane.docNotes = '';
    lane.startedAt = null;
  }

  // Joins a workout already under way: the first snapshot fills the lane.
  private joinShared(lane: Lane, id: string): Promise<void> {
    lane.stopDoc?.();
    lane.synced = null;
    return new Promise(resolve => {
      let first = true;
      this.watchShared(lane, id, () => {
        if (first) { first = false; resolve(); }
      });
    });
  }

  private watchShared(lane: Lane, id: string, after?: () => void) {
    lane.sharedId = id;
    lane.editingLogId = id;
    lane.legacyLogId = null;
    lane.stopDoc = this.firebase.watchSharedWorkout(id, w => this.zone.run(() => {
      this.onSharedChange(lane, id, w);
      after?.();
    }));
  }

  // Picks up the athlete starting a workout on their phone. Only takes over
  // a lane with nothing saved or waiting to save — once this app has a
  // workout going, the phone joins that one instead.
  private watchForAthlete(lane: Lane) {
    if (!lane.nameKey) return;
    lane.stopLive?.();
    lane.stopLive = this.firebase.watchLiveWorkout(lane.nameKey, w => this.zone.run(() => {
      if (!w?.id || lane.sharedId || lane.legacyLogId || lane.creating || lane.saveTimer) return;
      this.joinShared(lane, w.id);
    }));
  }

  private onSharedChange(lane: Lane, id: string, w: MemberWorkoutLog | null) {
    if (lane.sharedId !== id) return;
    // Its own workout counts as going until finished (not just today), so a
    // session running past midnight isn't dropped.
    if (!w || !w.inProgress) {
      if (this.finishing) return;
      const who = this.firstName(lane.clientName) || 'The athlete';
      lane.stopDoc?.();
      lane.stopDoc = null;
      lane.sharedId = null;
      this.notify(w ? `${who} finished the workout` : `${who}'s workout was discarded`);
      this.loadLane(lane, lane.clientId);
      return;
    }
    const remote = normalizeState(w);
    lane.startedAt = w.startedAt || lane.startedAt;
    if (!lane.synced) {
      lane.synced = remote;
      this.applyShared(lane, remote);
      this.useProgramOf(lane, w);
      this.refreshLaneHints(lane);
      return;
    }
    const merged = merge3(lane.synced, this.laneState(lane), remote);
    lane.synced = remote;
    if (this.applyShared(lane, merged)) this.refreshLaneHints(lane);
    else lane.targets = lane.entries.map(ex => Math.max(1, ex.sets.length));
    // Edits made here since the last save are still to be written.
    if (!sameValue(merged, remote)) this.scheduleSave(lane);
  }

  // Shows `state` in the lane, keeping the inputs in place when only values
  // changed. True when the exercise list itself changed.
  private applyShared(lane: Lane, state: WorkoutSyncState): boolean {
    lane.canon = state.exercises;
    lane.docTitle = state.title;
    lane.docNotes = state.notes;
    const sheets = state.exercises.map((e, i) => syncToSheet(e, i)) as LoggedExercise[];
    if (patchInPlace(lane.entries, sheets, (x, i) => x.key || `x${i}`)) return false;
    lane.entries = sheets;
    return true;
  }

  // Program/day badges for a workout joined from the phone.
  private useProgramOf(lane: Lane, w: MemberWorkoutLog) {
    const program = w.programId ? this.programs.find(p => p.id === w.programId) || null : null;
    lane.program = program;
    lane.noProgram = false;
    lane.emptyProgram = false;
    lane.programComplete = false;
    if (program) {
      const order = this.firebase.programTrainingDays(program);
      lane.dayTotal = order.length;
      lane.dayList = this.dayOptions(lane);
      lane.dayIndex = w.dayIndex ?? null;
      lane.dayPosition = lane.dayIndex !== null ? order.indexOf(lane.dayIndex) + 1 : 0;
      const day = lane.dayIndex !== null ? program.schedule[lane.dayIndex] : null;
      lane.programLabel = [program.name, day?.name].filter(Boolean).join(' · ').toUpperCase();
    } else {
      lane.dayTotal = 0;
      lane.dayList = [];
      lane.dayIndex = null;
      lane.dayPosition = 0;
      lane.programLabel = (w.title || 'Workout').toUpperCase();
    }
  }

  // The lane's workout in the shared shape.
  private laneState(lane: Lane): WorkoutSyncState {
    return {
      title: lane.docTitle,
      notes: lane.docNotes,
      exercises: lane.entries.map((e, i) => sheetToSync(e, lane.canon.find(c => c.key === e.key), i))
    };
  }

  private async notify(message: string) {
    const t = await this.toast.create({ message, duration: 2500, position: 'bottom', color: 'medium' });
    await t.present();
  }

  // ---------- Per-set logging ----------
  private repsCol(ex: LoggedExercise): string {
    return ex.attrColumns.find(c => c === 'Reps') || 'Reps';
  }
  private weightCol(ex: LoggedExercise): string {
    return ex.attrColumns.find(c => c === 'Load' || c === 'Weight') || 'Load';
  }

  // Summarise an exercise's sets from the most recent prior log containing it.
  private previousSummary(ex: LoggedExercise, logs: WorkoutLog[], skipLogId: string | null): string {
    const name = ex.exerciseName.trim().toLowerCase();
    for (const log of logs) {                       // logs are date-desc (newest first)
      if (log.id && log.id === skipLogId) continue; // don't echo the session we're resuming
      const match = (log.exercises || []).find(e => e.exerciseName.trim().toLowerCase() === name);
      if (!match) continue;
      const loadCol = (match.attrColumns || []).find(c => c === 'Load' || c === 'Weight');
      const repCol = (match.attrColumns || []).find(c => c === 'Reps');
      const parts = match.sets
        .map(s => {
          const load = loadCol ? (s.values[loadCol] || '').trim() : '';
          const reps = repCol ? (s.values[repCol] || '').trim() : '';
          if (load && reps) return `${load}×${reps}`;
          return load || reps || '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join(' · ');
    }
    return '';
  }

  // Per-set values (all columns — Reps, Load, RIR, whatever the exercise
  // tracks) from the same prior log previousSummary() would summarise, so
  // each input can show its own actual last-time number as a placeholder
  // instead of one flattened "Last 30 30 35" line covering just load/reps.
  private previousSets(ex: LoggedExercise, logs: WorkoutLog[], skipLogId: string | null): Record<string, string>[] {
    const name = ex.exerciseName.trim().toLowerCase();
    for (const log of logs) {                       // logs are date-desc (newest first)
      if (log.id && log.id === skipLogId) continue; // don't echo the session we're resuming
      const match = (log.exercises || []).find(e => e.exerciseName.trim().toLowerCase() === name);
      if (!match) continue;
      const sets = match.sets.map(s => s.values || {});
      if (sets.some(v => Object.values(v).some(x => (x || '').trim()))) return sets;
    }
    return [];
  }

  prevSummary(lane: Lane, i: number): string {
    return lane.prev[i] || '';
  }

  // Placeholder for one specific set+column cell: last session's actual
  // value for that same set number, falling back to the prescribed
  // target (rxAttr) when there's no history for this exercise yet — same
  // fallback behavior the inputs always had, just filled in per-field now
  // instead of only ever showing the prescription.
  prevAttr(lane: Lane, i: number, s: number, col: string): string {
    const prevVal = (lane.prevSets[i]?.[s]?.[col] || '').trim();
    return prevVal || this.rxAttr(lane, i, col);
  }

  doneSets(lane: Lane, i: number): number {
    return lane.entries[i]?.sets.filter(s => s.done).length || 0;
  }
  targetSets(lane: Lane, i: number): number {
    return lane.targets[i] || 0;
  }
  exerciseComplete(lane: Lane, i: number): boolean {
    return this.doneSets(lane, i) >= this.targetSets(lane, i);
  }
  rxAttr(lane: Lane, i: number, col: string): string {
    const v = this.fromPrescription(lane.entries[i]?.prescription || '', col);
    return v === '—' ? '' : v;
  }

  // Adds an exercise on the fly — not in the athlete's program, or there's
  // no program running at all. Same shape buildSessionExercises() produces
  // for a real program day, just with no prescription text and a single
  // blank set to start (a coach can + Set from there like any other row).
  addFreeExercise(lane: Lane) {
    const name = lane.newExerciseName.trim();
    if (!name) return;
    lane.entries.push({
      key: newExerciseKey(),
      exerciseName: name,
      prescription: '',
      attrColumns: ['Reps', 'Load'],
      sets: [{ values: {}, done: false }],
      notes: ''
    });
    lane.targets.push(1);
    lane.prev.push('');
    lane.prevSets.push([]);
    lane.newExerciseName = '';
    lane.addExerciseOpen = false;
    this.scheduleSave(lane);
  }

  removeExercise(lane: Lane, i: number) {
    lane.entries.splice(i, 1);
    lane.targets.splice(i, 1);
    lane.prev.splice(i, 1);
    lane.prevSets.splice(i, 1);
    this.scheduleSave(lane);
  }

  addSet(lane: Lane, i: number) {
    const ex = lane.entries[i];
    if (!ex) return;
    ex.sets.push({ values: {}, done: false });
    lane.targets[i] = ex.sets.length;
    this.scheduleSave(lane);
  }
  removeSet(lane: Lane, i: number) {
    const ex = lane.entries[i];
    if (!ex || ex.sets.length <= 1) return;
    ex.sets.pop();
    lane.targets[i] = ex.sets.length;
    this.scheduleSave(lane);
  }
  toggleSet(lane: Lane, i: number, s: number) {
    const ex = lane.entries[i];
    const set = ex?.sets[s];
    if (!ex || !set) return;

    set.done = !set.done;
    // Checking a set (not unchecking) commits whatever's showing in each
    // still-empty cell — last session's actual number, or the prescribed
    // target if there's no history — as a real saved value. Otherwise a
    // coach who matched last time's numbers exactly and just tapped the
    // checkmark would save a set with blank fields, since a placeholder is
    // never part of the input's value.
    if (set.done) {
      for (const col of ex.attrColumns) {
        if (!(set.values[col] || '').trim()) {
          const fill = this.prevAttr(lane, i, s, col);
          if (fill) set.values[col] = fill;
        }
      }
    }
    this.scheduleSave(lane);
  }
  markDirty(lane: Lane) {
    this.scheduleSave(lane);
  }

  private scheduleSave(lane: Lane) {
    if (lane.saveTimer) clearTimeout(lane.saveTimer);
    lane.saveTimer = setTimeout(() => { lane.saveTimer = null; this.persist(lane); }, 400);
  }

  // Saves the lane to the shared workout the athlete's phone sees — made on
  // the first change, then updated in place — or, for an unfinished
  // session from before sharing, where it always lived.
  private async persist(lane: Lane, completed = false) {
    // No program (or no day picked) is a valid state to save from — a
    // coach can log a fully ad-hoc session, or bolt extra exercises onto a
    // programmed one. Only a picked athlete is required.
    if (!lane.clientId) return;
    const day = lane.program && lane.dayIndex !== null ? lane.program.schedule[lane.dayIndex] : null;
    const program = {
      programId: lane.program?.id || null,
      programName: lane.program?.name || null,
      dayIndex: lane.dayIndex,
      dayName: day?.name || null
    };
    try {
      if (lane.legacyLogId) {
        await this.firebase.saveWorkoutLog({
          id: lane.legacyLogId,
          source: 'coach',
          ...program,
          programName: program.programName || '',
          dayName: program.dayName || '',
          clientId: lane.clientId,
          clientName: lane.clientName,
          date: localDateString(),
          exercises: lane.entries,
          sessionNotes: '',
          completed
        });
        return;
      }
      if (lane.creating) await lane.creating;

      if (!lane.sharedId) {
        if (!lane.entries.length) return;
        lane.docTitle = lane.docTitle || [lane.program?.name, day?.name].filter(Boolean).join(' — ') || 'Workout';
        const state = this.laneState(lane);
        lane.creating = (async () => {
          const id = await this.firebase.createSharedWorkout({
            clientId: lane.clientId,
            clientName: lane.clientName,
            nameKey: lane.nameKey,
            date: localDateString(),
            title: state.title,
            notes: state.notes,
            exercises: state.exercises,
            ...program,
            inProgress: !completed,
            startedAt: this.startedAt
          });
          lane.synced = state;
          lane.canon = state.exercises;
          lane.startedAt = this.startedAt;
          if (!completed) this.watchShared(lane, id);
        })();
        try { await lane.creating; } finally { lane.creating = null; }
        return;
      }

      const state = this.laneState(lane);
      if (!completed && lane.synced && sameValue(state, lane.synced)) return;
      lane.synced = state;
      lane.canon = state.exercises;
      await this.firebase.writeSharedWorkout(lane.sharedId, {
        exercises: state.exercises,
        ...(completed ? {
          inProgress: false,
          timestamp: new Date().toISOString(),
          durationMin: Math.max(1, Math.round((Date.now() - (lane.startedAt || this.startedAt)) / 60000))
        } : {})
      });
    } catch (err) {
      console.error('Live session: save failed', err);
    }
  }

  get canFinish(): boolean {
    return this.lanes.some(l => l.clientId && l.entries.length > 0);
  }

  async finishWorkout() {
    this.finishing = true;
    let saved = 0;
    const prMessages: string[] = [];
    for (const lane of this.lanes) {
      if (lane.saveTimer) { clearTimeout(lane.saveTimer); lane.saveTimer = null; }
      if (lane.clientId && lane.entries.length > 0) {
        await this.persist(lane, true);
        saved++;
        const pr = await this.updateAssessmentFromLane(lane);
        if (pr) prMessages.push(pr);
      }
      this.detachLane(lane);
    }
    this.finishing = false;
    const base = saved > 1 ? 'Both workouts saved' : 'Workout saved';
    const t = await this.toast.create({
      message: prMessages.length ? `${base} · ${prMessages.join(' · ')}` : base,
      duration: prMessages.length ? 4000 : 1600, position: 'bottom', color: 'success'
    });
    await t.present();
    this.router.navigateByUrl('/schedule');
  }

  // After a session, turn any benchmark-lift PRs into an updated Omni assessment.
  // Takes the client's latest assessment as the base, bumps only the lifts that
  // beat their stored estimate, recomputes the level, and saves a snapshot dated
  // now. Returns a short PR summary for the toast (or null if nothing improved).
  private async updateAssessmentFromLane(lane: Lane): Promise<string | null> {
    if (!lane.clientId) return null;

    let history;
    try {
      history = await this.firebase.listAssessmentsForClient({
        clientId: lane.clientId, clientName: lane.clientName
      });
    } catch (err) {
      console.error('Live session: assessment lookup failed', err);
      return null;
    }
    const latest = history.length ? history[history.length - 1] : null;
    const bodyWeight = latest?.inputs.bodyWeight || 0;

    // Best estimated 1RM per benchmark lift across this session's logged sets.
    const bests = new Map<string, { weight: number; reps: number; est: number; label: string }>();
    for (const ex of lane.entries) {
      const lift = matchAssessmentLift(ex.exerciseName);
      if (!lift) continue;
      for (const set of ex.sets) {
        const load = parseFloat(set.values['Load'] ?? set.values['Weight'] ?? '');
        const reps = parseFloat(set.values['Reps'] ?? '');
        if (!isFinite(reps) || reps < 1) continue;
        let est: number, recordWeight: number;
        if (lift.bodyweightBased) {
          if (!bodyWeight) continue;                       // can't estimate without bodyweight
          const added = isFinite(load) && load > 0 ? load : 0;
          est = brzycki(bodyWeight + added, reps);
          recordWeight = added;
        } else {
          if (!isFinite(load) || load <= 0) continue;
          est = brzycki(load, reps);
          recordWeight = load;
        }
        const cur = bests.get(lift.key);
        if (!cur || est > cur.est) bests.set(lift.key, { weight: recordWeight, reps, est, label: lift.label });
      }
    }
    if (!bests.size) return null;

    const inputs: AssessmentInputs = latest ? { ...latest.inputs } : blankAssessmentInputs();
    const prs: string[] = [];
    bests.forEach((b, key) => {
      const current = (inputs as any)[key] || 0;
      if (b.est > current + 0.5) {                          // epsilon so noise doesn't churn
        (inputs as any)[key] = Math.round(b.est * 10) / 10;
        (inputs as any)[key + 'Weight'] = b.weight;
        (inputs as any)[key + 'Reps'] = b.reps;
        prs.push(`${b.label} ${Math.round(b.est)}lb`);
      }
    });
    if (!prs.length) return null;

    const totals = computeOmni(inputs);
    const now = new Date();
    const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const nameKey = lane.clientName.trim().toLowerCase();
    // The rank stored on an assessment depends on the athlete's threshold
    // table, so it has to be read rather than assumed. Falls back to male
    // if the member record is missing, which matches the default elsewhere.
    let sex: Sex = 'male';
    try {
      sex = (await this.firebase.getMember(nameKey))?.sex ?? 'male';
    } catch {
      // Directory read failed — the default is still correct for most
      // athletes and a PR is not worth losing over it.
    }
    try {
      await this.firebase.saveAssessment({
        clientId: lane.clientId,
        clientName: lane.clientName,
        nameKey,
        timestamp: localNow,
        dateLabel: now.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        inputs,
        lvl: totals.lvl,
        rank: getOmniRank(totals.lvl, sex)
      });
    } catch (err) {
      console.error('Live session: assessment PR save failed', err);
      return null;
    }
    return `${this.firstName(lane.clientName)} PR: ${prs.join(', ')} → Lvl ${totals.lvl}`;
  }

  private fromPrescription(prescription: string, key: string): string {
    const part = (prescription || '').split('·').map(s => s.trim()).find(s => s.startsWith(key + ':'));
    const val = part ? part.slice(key.length + 1).trim() : '';
    return val && val !== '—' ? val : '—';
  }

  private buildDemoTables() {
    this.protocolRows = DEMO_PROTOCOL.map(([name, reps, weight, rest], i) =>
      ({ num: i + 1, name, reps, weight, rest }));
    this.historyRows = DEMO_HISTORY.map(([name, reps, weight, rest], i) =>
      ({ num: i + 1, name, reps, weight, rest }));
  }

  trackByNum = (_: number, row: ProtocolRow) => row.num;
  trackByStat = (_: number, stat: StatBlock) => stat.label;
  trackLane = (_: number, lane: Lane) => lane.id;
  trackDay = (_: number, d: { index: number }) => d.index;

  laneName(lane: Lane): string {
    return this.firstName(lane.clientName) || `Athlete ${lane.id}`;
  }

  get footProgram(): string {
    if (this.usingDemoProtocol) return 'NO PROGRAM ASSIGNED';
    if (this.duo) {
      return this.lanes.map(l => l.programLabel || this.laneName(l)).join('   ·   ');
    }
    const a = this.laneA;
    return a.programLabel || (a.noProgram ? 'NO PROGRAM ASSIGNED' : '—');
  }

  // ---------- Live tick ----------
  private tick() {
    const now = new Date();
    this.wallClock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    this.sessionClock = h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

    this.pushDemoSamples();
    this.refreshHr();
    if (elapsed % 4 === 0) this.lanes.forEach(l => l.demoPhase += 0.35);
  }

  private pushDemoSamples() {
    const t = Date.now();
    this.lanes.forEach((lane, idx) => {
      if (this.slotForLane(idx)) return; // real sensor is feeding this lane
      const base = (idx === 0 ? 132 : 148) + Math.sin(lane.demoPhase * 0.6 + t / 45000) * 20;
      const hr = Math.round(base + Math.sin(t / 7000 + idx) * 6 + (Math.random() - 0.5) * 4);
      lane.demoSamples.push({ t, hr });
      const cutoff = t - 3 * 60 * 1000;
      while (lane.demoSamples.length && lane.demoSamples[0].t < cutoff) lane.demoSamples.shift();
    });
  }

  private laneSamples(lane: Lane, idx: number): HrSample[] {
    return this.slotForLane(idx)?.samples ?? lane.demoSamples;
  }

  private refreshHr() {
    this.lanes.forEach((lane, idx) => {
      const slot = this.slotForLane(idx);
      const samples = slot ? slot.samples : lane.demoSamples;
      const maxHr = slot?.maxHr || 190;
      if (slot) {
        lane.hrNow = slot.hr;
        lane.hrAvg = slot.avgHr;
        lane.hrMax = slot.maxSeenHr;
        lane.kcal = slot.energyKJ !== null ? Math.round(slot.energyKJ * 0.239) : this.estimateKcal(samples);
      } else {
        const last = samples[samples.length - 1];
        lane.hrNow = last ? last.hr : null;
        if (samples.length) {
          lane.hrAvg = Math.round(samples.reduce((a, b) => a + b.hr, 0) / samples.length);
          lane.hrMax = Math.max(...samples.map(x => x.hr));
        }
        lane.kcal = this.estimateKcal(samples);
      }
      lane.zonePct = lane.hrNow ? Math.min(100, Math.round((lane.hrNow / maxHr) * 100)) : 0;
      this.buildZones(lane, idx);
    });

    this.simulated = !this.heartRate.slots.some(s => s.connected);
    this.buildHrChart();
    this.buildStats();
  }

  private estimateKcal(samples: HrSample[]): number {
    if (!samples.length) return 0;
    const minutes = (Date.now() - this.startedAt) / 60000;
    const avg = samples.reduce((a, b) => a + b.hr, 0) / samples.length;
    return Math.max(0, Math.round((0.6309 * avg - 55.0969) * minutes / 4.184));
  }

  private buildZones(lane: Lane, idx: number) {
    const samples = this.laneSamples(lane, idx);
    const maxHr = this.slotForLane(idx)?.maxHr || 190;
    const counts = this.zones.map(() => 0);
    for (const s of samples) {
      const pctMax = (s.hr / maxHr) * 100;
      counts[this.zoneIndexForPct(pctMax)]++;
    }
    const total = samples.length || 1;
    lane.zones = this.zones.map((z, i) => {
      const pct = Math.round((counts[i] / total) * 100);
      return { label: z.label, pct, value: `${pct}%` };
    });
  }

  private zoneIndexForPct(pct: number): number {
    const i = this.zones.findIndex(z => pct < z.max);
    return i >= 0 ? i : this.zones.length - 1;
  }

  zoneForPct(pct: number): ZoneDef {
    return this.zones[this.zoneIndexForPct(pct)];
  }

  // The colour an athlete's trace should use right now.
  laneLineColor(lane: Lane): string {
    if (!this.zoneColoring || lane.hrNow === null) return lane.color;
    return this.zoneForPct(lane.zonePct).color;
  }

  laneAreaFill(lane: Lane): string {
    return this.laneLineColor(lane) + '22'; // translucent
  }

  // Zone columns for the bar chart (with each zone's colour).
  get zoneCols() {
    return this.zones.map((z, zi) => ({
      label: z.label,
      color: z.color,
      lanes: this.lanes.map(l => ({ color: l.color, pct: l.zones[zi]?.pct ?? 0 }))
    }));
  }

  // ----- Zone settings -----
  toggleZoneSettings() { this.showZoneSettings = !this.showZoneSettings; }

  setZoneColoring(on: boolean) {
    this.zoneColoring = on;
    this.saveZoneConfig();
  }

  zoneLow(i: number): number {
    return i === 0 ? 0 : this.zones[i - 1].max;
  }

  onZoneBoundChange() {
    // Clamp each editable bound to 1–100 and keep them strictly ascending.
    for (let i = 0; i < this.zones.length - 1; i++) {
      let v = Math.round(Number(this.zones[i].max));
      if (!isFinite(v)) v = DEFAULT_ZONES[i].max;
      this.zones[i].max = Math.max(1, Math.min(100, v));
    }
    for (let i = 1; i < this.zones.length - 1; i++) {
      if (this.zones[i].max <= this.zones[i - 1].max) {
        this.zones[i].max = Math.min(100, this.zones[i - 1].max + 1);
      }
    }
    this.saveZoneConfig();
    this.refreshHr();
  }

  resetZones() {
    this.zones = DEFAULT_ZONES.map(z => ({ ...z }));
    this.saveZoneConfig();
    this.refreshHr();
  }

  private loadZoneConfig() {
    try {
      const raw = localStorage.getItem(ZONE_CFG_KEY);
      if (!raw) return;
      const cfg = JSON.parse(raw);
      if (typeof cfg.zoneColoring === 'boolean') this.zoneColoring = cfg.zoneColoring;
      if (Array.isArray(cfg.bounds)) {
        cfg.bounds.forEach((b: number, i: number) => {
          if (this.zones[i] && Number(b) > 0) this.zones[i].max = Number(b);
        });
      }
    } catch { /* ignore corrupt config */ }
  }

  private saveZoneConfig() {
    try {
      localStorage.setItem(ZONE_CFG_KEY, JSON.stringify({
        zoneColoring: this.zoneColoring,
        bounds: this.zones.slice(0, this.zones.length - 1).map(z => z.max)
      }));
    } catch { /* storage may be unavailable */ }
  }

  private buildHrChart() {
    const W = 600, H = 210, PAD = 6, windowMs = 3 * 60 * 1000;
    const series = this.lanes.map((lane, idx) => ({ lane, samples: this.laneSamples(lane, idx) }));
    const all = series.reduce<HrSample[]>((acc, s) => acc.concat(s.samples), []);
    if (all.length < 2) {
      this.lanes.forEach(l => { l.linePoints = ''; l.endXPct = -1; l.endYPct = -1; });
      this.hrAreaPath = '';
      return;
    }
    const tEnd = Math.max(...all.map(s => s.t));
    const tStart = Math.max(Math.min(...all.map(s => s.t)), tEnd - windowMs);
    const span = Math.max(1, tEnd - tStart);

    const windowedHrs = all.filter(s => s.t >= tStart).map(s => s.hr);
    const dataLo = Math.min(...windowedHrs);
    const dataHi = Math.max(...windowedHrs);
    const pad = Math.max(5, Math.round((dataHi - dataLo) * 0.2));
    let lo = Math.floor((dataLo - pad) / 5) * 5;
    let hi = Math.ceil((dataHi + pad) / 5) * 5;
    if (hi - lo < 25) {
      const mid = Math.round((dataHi + dataLo) / 2 / 5) * 5;
      lo = mid - 15; hi = mid + 15;
    }
    lo = Math.max(35, lo);
    hi = Math.min(215, Math.max(lo + 20, hi));
    this.hrAxis = [hi, Math.round(hi - (hi - lo) / 3), Math.round(lo + (hi - lo) / 3), lo];

    this.hrAreaPath = '';
    series.forEach(({ lane, samples }, idx) => {
      const pts = samples.filter(s => s.t >= tStart).map(s => {
        const x = PAD + ((s.t - tStart) / span) * (W - PAD * 2);
        const y = H - PAD - ((Math.min(hi, Math.max(lo, s.hr)) - lo) / (hi - lo)) * (H - PAD * 2);
        return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
      });
      lane.linePoints = pts.map(p => p.join(',')).join(' ');
      // Remember the trace's right-most point so the template can pin a name
      // tag there (in duo mode) — the only reliable "which line is whom" cue
      // once zone-colouring makes both traces the same colour.
      const end = pts[pts.length - 1];
      lane.endXPct = end ? (end[0] / W) * 100 : -1;
      lane.endYPct = end ? (end[1] / H) * 100 : -1;
      // Soft area fill only for the first lane (and only in solo, to keep duo clean)
      if (idx === 0 && !this.duo && pts.length > 1) {
        const first = pts[0], last = pts[pts.length - 1];
        this.hrAreaPath = `M ${first[0]},${H - PAD} L ${lane.linePoints.replace(/ /g, ' L ')} L ${last[0]},${H - PAD} Z`;
      }
    });
  }

  private buildStats() {
    if (this.duo) {
      this.stats = [
        { label: 'SESSION TIME', value: this.sessionClock, unit: 'ELAPSED', accent: true },
        ...this.lanes.map(l => ({
          label: (this.firstName(l.clientName) || `ATHLETE ${l.id}`).toUpperCase(),
          value: l.hrNow !== null ? String(l.hrNow) : '--',
          unit: `BPM · AVG ${l.hrAvg ?? '--'} / MAX ${l.hrMax ?? '--'}`,
          color: l.color
        }))
      ];
      return;
    }
    const a = this.laneA;
    this.stats = [
      { label: 'SESSION TIME', value: this.sessionClock, unit: 'ELAPSED', accent: true },
      { label: 'HEART RATE', value: a.hrNow !== null ? String(a.hrNow) : '--', unit: 'BPM', accent: true },
      { label: 'AVG / MAX', value: `${a.hrAvg ?? '--'} / ${a.hrMax ?? '--'}`, unit: 'BPM' },
      { label: 'ENERGY', value: String(a.kcal), unit: 'KCAL' },
      { label: 'EFFORT ZONE', value: `${a.zonePct}`, unit: '% MAX HR' },
      { label: 'LOAD INDEX', value: '14.9', unit: 'A.U.' },
    ];
  }

  get zoneMeterPct(): number {
    return this.laneA?.zonePct || 0;
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }
}
