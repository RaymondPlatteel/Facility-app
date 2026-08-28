import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, add, chevronDown, chevronForward, chevronUp, trashOutline,
  addCircleOutline, searchOutline, lockClosed, saveOutline, settingsOutline,
  barbellOutline, bedOutline, closeOutline, copyOutline, trendingUpOutline
} from 'ionicons/icons';
import {
  FirebaseService, Program, ProgramDay, ProgramExercise, ProgramAttribute, ClientProfile
} from '../services/firebase.service';
import { matchAssessmentLift } from '../services/omni.util';

type CreatorView = 'setup' | 'builder';

const DISTANCE_UNITS = ['Feet', 'Yards', 'Meters', 'Miles', 'Kilometers'];
const SPEED_UNITS = ['mph', 'kph'];
const PACE_UNITS = ['min/mile', 'min/km'];

@Component({
  selector: 'app-program-creator',
  templateUrl: './program-creator.page.html',
  styleUrls: ['./program-creator.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class ProgramCreatorPage implements OnInit {
  readonly MAX_SESSIONS = 182;
  readonly MAX_CYCLES = 26;
  readonly MAX_DAYS_PER_CYCLE = 7;

  loading = true;
  saving = false;
  view: CreatorView = 'setup';
  programId: string | null = null;
  private createdAt?: string;

  // Setup fields
  name = '';
  description = '';
  goals = '';
  fitnessLevel = '';
  cycles = 4;
  daysPerCycle = 7;
  isStandardWeek = true;
  durationPerDayMinutes = 60;
  equipment: string[] = [];
  assignedClientIds: string[] = [];
  // Optional; blank = no fixed calendar position (current behavior — the
  // client app bases "today" on completed workouts instead).
  startDate: string | null = null;

  clients: ClientProfile[] = [];

  fitnessLevelOptions = ['Beginner', 'Novice', 'Intermediate', 'Advanced', 'Elite'];
  availableEquipment = [
    'Barbell', 'Dumbbells', 'Kettlebells', 'Resistance Bands', 'Pull-up Bar',
    'Bench', 'Squat Rack', 'Cable Machine', 'Treadmill', 'Rowing Machine',
    'Bike', 'Yoga Mat', 'Medicine Ball', 'Foam Roller', 'Jump Rope', 'Bodyweight Only'
  ];

  availableAttributes = [
    'Sets', 'Reps', 'Load', 'Duration', 'RIR', 'RPE', 'Tempo',
    'Feet', 'Yards', 'Meters', 'Miles', 'Kilometers',
    'mph', 'kph', 'min/mile', 'min/km',
    'Watts', 'SPM', 'RPM', 'Incline', 'Drag Factor', 'Gear', 'HR'
  ];

  // Builder state
  schedule: ProgramDay[] = [];
  currentIdx = 0;
  openCycles: { [key: number]: boolean } = { 0: true };

  // Inline attribute-picker panel (per exercise card)
  attrPanelIdx: number | null = null;
  attrSearch = '';

  constructor(
    private firebase: FirebaseService,
    private route: ActivatedRoute,
    private router: Router,
    private toastController: ToastController,
    private alertController: AlertController
  ) {
    addIcons({
      arrowBack, add, chevronDown, chevronForward, chevronUp, trashOutline,
      addCircleOutline, searchOutline, lockClosed, saveOutline, settingsOutline,
      barbellOutline, bedOutline, closeOutline, copyOutline, trendingUpOutline
    });
  }

  async ngOnInit() {
    try {
      this.clients = await this.firebase.listClientProfiles();
    } catch (err) {
      console.error('Creator: failed to load clients', err);
    }
    this.programId = this.route.snapshot.paramMap.get('id');
    if (this.programId) {
      const program = await this.firebase.getProgram(this.programId);
      if (program) {
        this.applyProgram(program);
        this.view = 'builder';
      }
    }
    this.loading = false;
  }

  private applyProgram(p: Program) {
    this.name = p.name;
    this.description = p.description || '';
    this.goals = p.goals || '';
    this.fitnessLevel = p.fitnessLevel || '';
    this.cycles = p.cycles;
    this.daysPerCycle = p.daysPerCycle;
    this.isStandardWeek = p.isStandardWeek;
    this.durationPerDayMinutes = p.durationPerDayMinutes || 60;
    this.equipment = p.equipment || [];
    this.assignedClientIds = p.assignedClientIds || [];
    this.startDate = p.startDate || null;
    this.schedule = p.schedule || [];
    this.createdAt = p.createdAt;
    this.currentIdx = 0;
    this.openCycles = { 0: true };
  }

  // ---------- Setup ----------
  get effectiveDays(): number {
    return this.isStandardWeek ? 7 : this.daysPerCycle;
  }

  get totalSessions(): number {
    return (this.cycles || 0) * this.effectiveDays;
  }

  get cycleLabel(): string {
    return this.isStandardWeek ? 'Week' : 'Cycle';
  }

  get setupError(): string {
    if (!this.name.trim()) return 'Program name is required';
    if (!this.cycles || this.cycles < 1) return `At least 1 ${this.cycleLabel.toLowerCase()} required`;
    if (this.cycles > this.MAX_CYCLES) return `Maximum ${this.MAX_CYCLES} ${this.cycleLabel.toLowerCase()}s`;
    if (this.effectiveDays < 1) return 'At least 1 day per cycle required';
    if (this.effectiveDays > this.MAX_DAYS_PER_CYCLE) return `Maximum ${this.MAX_DAYS_PER_CYCLE} days per cycle`;
    if (this.totalSessions > this.MAX_SESSIONS) return `Total days cannot exceed ${this.MAX_SESSIONS}`;
    return '';
  }

  toggleEquipment(eq: string) {
    const i = this.equipment.indexOf(eq);
    if (i > -1) this.equipment.splice(i, 1);
    else this.equipment.push(eq);
  }

  toggleClient(id: string) {
    const i = this.assignedClientIds.indexOf(id);
    if (i > -1) this.assignedClientIds.splice(i, 1);
    else this.assignedClientIds.push(id);
  }

  isClientAssigned(id: string): boolean {
    return this.assignedClientIds.includes(id);
  }

  durationOptions(): number[] {
    const out: number[] = [];
    for (let m = 15; m <= 180; m += 5) out.push(m);
    return out;
  }

  async enterBuilder() {
    if (this.setupError) {
      await this.presentToast(this.setupError, 'danger');
      return;
    }
    this.resizeSchedule(this.cycles, this.effectiveDays);
    this.lastDaysPerCycle = this.effectiveDays;
    this.view = 'builder';
    this.loadDay(Math.min(this.currentIdx, this.schedule.length - 1));
  }

  openSetup() {
    this.view = 'setup';
  }

  // Rebuilds the schedule grid, preserving existing day data by (cycle, day) position.
  private resizeSchedule(cycles: number, days: number) {
    const oldDays = this.scheduleDaysPerCycle();
    const next: ProgramDay[] = [];
    for (let c = 0; c < cycles; c++) {
      for (let d = 0; d < days; d++) {
        const oldIdx = c * oldDays + d;
        const existing = (d < oldDays) ? this.schedule[oldIdx] : undefined;
        if (existing) {
          existing.id = c * days + d;
          next.push(existing);
        } else {
          next.push(this.emptyDay(c * days + d));
        }
      }
    }
    this.schedule = next;
  }

  // Days-per-cycle of the schedule as currently stored (before a resize).
  private scheduleDaysPerCycle(): number {
    if (this.schedule.length === 0) return this.effectiveDays;
    // schedule was always built as cycles*days; infer from stored ids being sequential
    return this.lastDaysPerCycle || this.effectiveDays;
  }
  private lastDaysPerCycle = 0;

  private emptyDay(id: number): ProgramDay {
    return {
      id,
      name: '',
      notes: '',
      isRestDay: false,
      repeat: 'Never',
      exercises: []
    };
  }

  // ---------- Builder: sidebar ----------
  get currentDay(): ProgramDay | null {
    return this.schedule[this.currentIdx] ?? null;
  }

  getCycles(): number[] {
    return Array.from({ length: this.cycles || 0 }, (_, i) => i);
  }

  getDaysForCycle(c: number): ProgramDay[] {
    const start = c * this.effectiveDays;
    return this.schedule.slice(start, start + this.effectiveDays);
  }

  toggleCycle(c: number) {
    this.openCycles[c] = !this.openCycles[c];
  }

  getCycleNumber(idx: number): number {
    return Math.floor(idx / this.effectiveDays) + 1;
  }

  getDayNumber(idx: number): number {
    return (idx % this.effectiveDays) + 1;
  }

  hasDayData(day: ProgramDay): boolean {
    return day.isRestDay || day.exercises.length > 0;
  }

  loadDay(idx: number) {
    if (idx < 0 || idx >= this.schedule.length) return;
    this.currentIdx = idx;
    this.lastDaysPerCycle = this.effectiveDays;
    const day = this.schedule[idx];
    if (!day.name) {
      day.name = `Day ${this.getDayNumber(idx)}`;
    }
    this.attrPanelIdx = null;
    this.openExercises = new Set(day.exercises.map((_, i) => i).filter(i => !day.exercises[i].name));
    const cycle = Math.floor(idx / this.effectiveDays);
    this.openCycles[cycle] = true;
  }

  trackByIdx(i: number): number { return i; }

  // True when an exercise name matches one of the Omni Method benchmark lifts —
  // logging it in a session can auto-update the athlete's assessment level.
  assessmentLiftLabel(name: string): string | null {
    return matchAssessmentLift(name)?.label ?? null;
  }

  // ---------- Builder: day meta ----------
  onDayMetaChanged() {
    const day = this.currentDay;
    if (day && day.repeat !== 'Never') this.applyRepeatToSchedule();
  }

  toggleRestDay(isRest: boolean) {
    const day = this.currentDay;
    if (!day) return;
    day.isRestDay = isRest;
    if (isRest) day.exercises = [];
    this.onDayMetaChanged();
  }

  // ---------- Repeat logic (ported from omni-method creator) ----------
  onRepeatChange(freq: string) {
    const day = this.currentDay;
    if (!day) return;
    if (day.repeat !== 'Never' && freq === 'Never') {
      this.clearRepeats();
    }
    day.repeat = freq;
    if (freq === 'Never') {
      day.repeatEndAfter = undefined;
      day.repeatCustomDays = undefined;
      return;
    }
    if (!day.repeatEndAfter) {
      day.repeatEndAfter = this.cycles || 1;
    }
    if (freq === 'Custom' && (!day.repeatCustomDays || day.repeatCustomDays.length === 0)) {
      day.repeatCustomDays = [this.getDayNumber(this.currentIdx)];
    }
    this.applyRepeatToSchedule();
  }

  toggleCustomRepeatDay(dayNum: number) {
    const day = this.currentDay;
    if (!day) return;
    day.repeatCustomDays = day.repeatCustomDays || [];
    const i = day.repeatCustomDays.indexOf(dayNum);
    if (i > -1) day.repeatCustomDays.splice(i, 1);
    else {
      day.repeatCustomDays.push(dayNum);
      day.repeatCustomDays.sort((a, b) => a - b);
    }
    this.applyRepeatToSchedule();
  }

  isCustomRepeatDaySelected(dayNum: number): boolean {
    return (this.currentDay?.repeatCustomDays || []).includes(dayNum);
  }

  getDaysInCycle(): number[] {
    return Array.from({ length: this.effectiveDays }, (_, i) => i + 1);
  }

  updateRepeatEndAfter(value: any) {
    const day = this.currentDay;
    if (!day) return;
    day.repeatEndAfter = Math.max(1, Math.min(this.cycles, parseInt(value, 10) || 1));
    this.applyRepeatToSchedule();
  }

  private clearRepeats() {
    const day = this.currentDay;
    if (!day) return;
    const step = this.effectiveDays;
    const startIdx = this.currentIdx;
    const currentDayNumber = this.getDayNumber(startIdx);

    const wipe = (target: ProgramDay) => {
      target.name = '';
      target.notes = '';
      target.repeat = 'Never';
      target.repeatEndAfter = undefined;
      target.repeatCustomDays = undefined;
      target.isRestDay = false;
      target.exercises = [];
    };

    if (day.repeat === 'Custom' && day.repeatCustomDays) {
      for (let cycle = 0; cycle < this.cycles; cycle++) {
        for (const dayNum of day.repeatCustomDays) {
          if (cycle === 0 && dayNum === currentDayNumber) continue;
          const targetIdx = cycle * step + (dayNum - 1);
          if (targetIdx >= 0 && targetIdx < this.schedule.length && targetIdx !== startIdx) {
            const target = this.schedule[targetIdx];
            if (target.name === day.name) wipe(target);
          }
        }
      }
    } else {
      for (let cycle = 1; cycle < this.cycles; cycle++) {
        const targetIdx = startIdx + step * cycle;
        if (targetIdx >= 0 && targetIdx < this.schedule.length) {
          const target = this.schedule[targetIdx];
          if (target.name === day.name && targetIdx !== startIdx) wipe(target);
        }
      }
    }
  }

  private applyRepeatToSchedule() {
    const day = this.currentDay;
    if (!day || day.repeat === 'Never') return;
    const source = this.schedule[this.currentIdx];
    this.clearRepeats();

    const copyInto = (target: ProgramDay) => {
      target.name = source.name;
      target.repeat = 'Never';
      target.isRestDay = source.isRestDay;
      target.notes = source.notes;
      target.repeatEndAfter = undefined;
      target.repeatCustomDays = undefined;
      target.exercises = JSON.parse(JSON.stringify(source.exercises));
    };

    if (day.repeat === 'Custom' && day.repeatCustomDays) {
      const currentDayNumber = this.getDayNumber(this.currentIdx);
      if (!day.repeatCustomDays.includes(currentDayNumber)) return;
      const endAfter = Math.min(day.repeatEndAfter || this.cycles, this.cycles);
      for (let cycle = 0; cycle < endAfter; cycle++) {
        for (const dayNum of day.repeatCustomDays) {
          if (cycle === 0 && dayNum === currentDayNumber) continue;
          const targetIdx = cycle * this.effectiveDays + (dayNum - 1);
          if (targetIdx >= 0 && targetIdx < this.schedule.length && targetIdx !== this.currentIdx) {
            copyInto(this.schedule[targetIdx]);
          }
        }
      }
    } else if (day.repeat === 'Repeat every cycle') {
      const endAfter = Math.min(day.repeatEndAfter || this.cycles, this.cycles);
      for (let cycle = 1; cycle < endAfter; cycle++) {
        const targetIdx = this.currentIdx + this.effectiveDays * cycle;
        if (targetIdx >= 0 && targetIdx < this.schedule.length) {
          copyInto(this.schedule[targetIdx]);
        }
      }
    }
  }

  // ---------- Exercises ----------
  addExercise() {
    const day = this.currentDay;
    if (!day) return;
    const t = Date.now();
    day.exercises.push({
      name: '',
      attributes: [
        { id: `${t}1`, type: 'Sets', strategy: 'Fixed', val: '3' },
        { id: `${t}2`, type: 'Reps', strategy: 'Fixed', val: '6' },
        { id: `${t}3`, type: 'Load', strategy: 'User Input', val: '' },
        { id: `${t}4`, type: 'RIR', strategy: 'Fixed', val: '1' }
      ]
    });
    this.openExercises.add(day.exercises.length - 1);
    this.onDayMetaChanged();
  }

  // UI-only expand/collapse state, per exercise index of the current day
  openExercises = new Set<number>([0]);

  isExOpen(idx: number): boolean {
    return this.openExercises.has(idx);
  }

  toggleExercise(idx: number) {
    if (this.openExercises.has(idx)) this.openExercises.delete(idx);
    else this.openExercises.add(idx);
  }

  async deleteExercise(idx: number) {
    const day = this.currentDay;
    if (!day) return;
    const alert = await this.alertController.create({
      header: 'Delete exercise?',
      message: `Remove "${day.exercises[idx].name || 'New Exercise'}" from this day?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => {
          day.exercises.splice(idx, 1);
          this.onDayMetaChanged();
        } }
      ]
    });
    await alert.present();
  }

  duplicateExercise(idx: number) {
    const day = this.currentDay;
    if (!day) return;
    const copy: ProgramExercise = JSON.parse(JSON.stringify(day.exercises[idx]));
    copy.attributes.forEach((a, i) => a.id = `${Date.now()}${i}`);
    day.exercises.splice(idx + 1, 0, copy);
    this.onDayMetaChanged();
  }

  getExerciseSummary(ex: ProgramExercise): string {
    return ex.attributes.map(a =>
      `${a.type}: ${a.strategy === 'User Input' ? 'User Input' : (a.strategy === 'Bodyweight' ? 'BW' : a.val || '—')}`
    ).join(' · ');
  }

  // ---------- Attributes ----------
  getStrategiesForAttribute(attrType: string): string[] {
    switch (attrType) {
      case 'Sets': return ['Fixed', 'Range', 'User Input'];
      case 'Reps': return ['Fixed', 'Range', 'AMRAP', 'User Input'];
      case 'Load': return ['Fixed', 'Range', '%1RM', 'Bodyweight', 'User Input'];
      case 'Tempo': return ['Fixed'];
      default: return ['Fixed', 'Range', 'User Input'];
    }
  }

  isAttributeDisabled(exIdx: number, attrType: string): boolean {
    const day = this.currentDay;
    if (!day) return false;
    const existing = day.exercises[exIdx].attributes.map(a => a.type);
    if (existing.includes(attrType)) return false;
    if (attrType === 'RIR' && existing.includes('RPE')) return true;
    if (attrType === 'RPE' && existing.includes('RIR')) return true;
    if (attrType === 'Tempo' && existing.includes('Duration')) return true;
    if (attrType === 'Duration' && existing.includes('Tempo')) return true;
    if (attrType === 'Reps' && existing.includes('Duration')) return true;
    if (attrType === 'Duration' && existing.includes('Reps')) return true;
    if (DISTANCE_UNITS.includes(attrType)) return existing.some(t => DISTANCE_UNITS.includes(t));
    if (SPEED_UNITS.includes(attrType)) return existing.some(t => SPEED_UNITS.includes(t));
    if (PACE_UNITS.includes(attrType)) return existing.some(t => PACE_UNITS.includes(t));
    return false;
  }

  getAvailableAttributesForExercise(exIdx: number): string[] {
    const day = this.currentDay;
    if (!day) return [];
    const existing = day.exercises[exIdx].attributes.map(a => a.type);
    const available = this.availableAttributes.filter(a => !existing.includes(a));
    return available.sort((a, b) => {
      const aD = this.isAttributeDisabled(exIdx, a);
      const bD = this.isAttributeDisabled(exIdx, b);
      return aD === bD ? 0 : (aD ? 1 : -1);
    });
  }

  toggleAttrPanel(exIdx: number) {
    this.attrPanelIdx = this.attrPanelIdx === exIdx ? null : exIdx;
    this.attrSearch = '';
  }

  filteredAttributes(exIdx: number): string[] {
    const list = this.getAvailableAttributesForExercise(exIdx);
    if (!this.attrSearch) return list;
    const q = this.attrSearch.toLowerCase();
    return list.filter(a => a.toLowerCase().includes(q));
  }

  selectAttribute(exIdx: number, type: string) {
    if (this.isAttributeDisabled(exIdx, type)) return;
    const day = this.currentDay;
    if (!day) return;
    const strategies = this.getStrategiesForAttribute(type);
    day.exercises[exIdx].attributes.push({
      id: Date.now().toString(),
      type,
      strategy: strategies[0],
      val: type === 'Duration' ? '00:00:00' : ''
    });
    this.attrPanelIdx = null;
    this.onDayMetaChanged();
  }

  deleteAttribute(exIdx: number, attrId: string) {
    const day = this.currentDay;
    if (!day) return;
    const ex = day.exercises[exIdx];
    ex.attributes = ex.attributes.filter(a => a.id !== attrId);
    this.onDayMetaChanged();
  }

  updateAttrStrategy(attr: ProgramAttribute, strategy: string) {
    attr.strategy = strategy;
    attr.val = attr.type === 'Duration' ? (strategy === 'Range' ? '00:00:00-00:00:00' : '00:00:00') : '';
    this.onDayMetaChanged();
  }

  updateAttrVal(attr: ProgramAttribute, value: string) {
    if (attr.type === 'RPE' && value) {
      const n = parseFloat(value);
      if (isNaN(n) || n < 1 || n > 20) return;
    }
    attr.val = value;
    this.onDayMetaChanged();
  }

  // Range helpers
  getRangeStart(v: string): string {
    return v && v.includes('-') ? v.split('-')[0].trim() : '';
  }
  getRangeEnd(v: string): string {
    return v && v.includes('-') ? (v.split('-')[1] || '').trim() : '';
  }
  updateRange(attr: ProgramAttribute, start: string, end: string) {
    attr.val = `${start || ''}-${end || ''}`;
    this.onDayMetaChanged();
  }

  // Tempo helpers (4 numbers: eccentric-pause-concentric-pause)
  getTempoValues(v: string): string[] {
    const p = (v || '').split('-');
    return [p[0] || '', p[1] || '', p[2] || '', p[3] || ''];
  }
  updateTempo(attr: ProgramAttribute, i: number, value: string) {
    const vals = this.getTempoValues(attr.val);
    vals[i] = value || '';
    attr.val = vals.join('-');
    this.onDayMetaChanged();
  }

  // Duration helpers (hh:mm:ss)
  getDurationParts(v: string): { hours: string; minutes: string; seconds: string } {
    if (!v) return { hours: '00', minutes: '00', seconds: '00' };
    const p = v.split(':');
    if (p.length === 3) return { hours: p[0] || '00', minutes: p[1] || '00', seconds: p[2] || '00' };
    const total = parseInt(v, 10) || 0;
    return {
      hours: Math.floor(total / 3600).toString().padStart(2, '0'),
      minutes: Math.floor((total % 3600) / 60).toString().padStart(2, '0'),
      seconds: (total % 60).toString().padStart(2, '0')
    };
  }
  updateDuration(attr: ProgramAttribute, part: 'hours' | 'minutes' | 'seconds', value: string) {
    const p = this.getDurationParts(attr.val);
    p[part] = (value || '0').padStart(2, '0');
    attr.val = `${p.hours}:${p.minutes}:${p.seconds}`;
    this.onDayMetaChanged();
  }
  updateDurationRange(attr: ProgramAttribute, which: 'start' | 'end', part: 'hours' | 'minutes' | 'seconds', value: string) {
    const parts = attr.val.split('-');
    const start = this.getDurationParts(parts[0] || '00:00:00');
    const end = this.getDurationParts(parts[1] || '00:00:00');
    const target = which === 'start' ? start : end;
    target[part] = (value || '0').padStart(2, '0');
    attr.val = `${start.hours}:${start.minutes}:${start.seconds}-${end.hours}:${end.minutes}:${end.seconds}`;
    this.onDayMetaChanged();
  }

  // ---------- Stats ----------
  getDaysWithExercises(): number {
    return this.schedule.filter(d => !d.isRestDay && d.exercises.length > 0).length;
  }
  getTotalExercises(): number {
    return this.schedule.reduce((t, d) => t + d.exercises.length, 0);
  }
  getRestDaysCount(): number {
    return this.schedule.filter(d => d.isRestDay).length;
  }

  // ---------- Save ----------
  async save(navigateBack = true) {
    if (!this.name.trim()) {
      await this.presentToast('Program name is required', 'danger');
      this.view = 'setup';
      return;
    }
    this.saving = true;
    try {
      const idToName = new Map(this.clients.map(c => [c.id!, c.fullName]));
      const program: Program = {
        id: this.programId || undefined,
        name: this.name.trim(),
        description: this.description.trim(),
        goals: this.goals.trim(),
        fitnessLevel: this.fitnessLevel,
        cycles: this.cycles,
        daysPerCycle: this.effectiveDays,
        isStandardWeek: this.isStandardWeek,
        durationPerDayMinutes: this.durationPerDayMinutes,
        equipment: this.equipment,
        schedule: this.schedule,
        assignedClientIds: this.assignedClientIds,
        assignedClientNames: this.assignedClientIds.map(id => idToName.get(id) || '').filter(Boolean),
        startDate: this.startDate || null,
        status: 'active',
        createdAt: this.createdAt
      };
      this.programId = await this.firebase.saveProgram(program);
      await this.presentToast('Program saved');
      if (navigateBack) this.router.navigateByUrl('/programs');
    } catch (err) {
      console.error('Creator: save failed', err);
      await this.presentToast('Could not save program', 'danger');
    } finally {
      this.saving = false;
    }
  }

  goBack() {
    this.router.navigateByUrl('/programs');
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 1600, position: 'bottom', color });
    await toast.present();
  }
}
