import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, closeOutline, refreshOutline, trashOutline, sparklesOutline } from 'ionicons/icons';
import type { OmniRank } from '../services/firebase.service';
import { FirebaseService, TrainerCorrection } from '../services/firebase.service';
import { generateProgram } from '../program-engine/generator';
import type { AthleteState } from '../program-engine/types';
import { ENGINE_VERSION } from '../program-engine/version';
import { BLOCKS, BlockDef, BlockGroup, BlockKey, WeekBlocks, accuracy, blockDef, cloneWeek, counts, distance, fromStored, toStored, weekBlocks } from '../program-engine/blocks';
import { MIN_DAYS, PracticeAthlete, RANKS, RANK_SHORT, practiceAthlete } from './athlete-gen';
import { Example, Learner, Score, history } from '../program-engine/learner';
import { examplesFrom } from '../program-engine/apply';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const GROUPS: BlockGroup[] = ['Strength', 'Endurance', 'Cardio', 'Power', 'Supplemental'];
const ORDER = new Map(BLOCKS.map((b, i) => [b.key, i]));

type RankField = 'strength' | 'pushup' | 'pullup' | 'cardio' | 'sprint' | 'longjump' | 'pike' | 'backbend' | 'straddle';
type Drag = { from: 'palette'; key: BlockKey } | { from: 'day'; day: number; index: number };

// The Program Trainer. A practice athlete gets a week from the rules, the model adjusts it from what it has learned,
// and the coach corrects it by moving blocks. Each saved correction teaches the model, and the chart shows how close
// the rules and the model each came to the coach's week over time.
@Component({
  selector: 'app-program-trainer',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './program-trainer.page.html',
  styleUrls: ['./program-trainer.page.scss']
})
export class ProgramTrainerPage implements OnInit {
  readonly days = DAYS;
  readonly groups = GROUPS;
  readonly ranks = RANKS;
  readonly short = RANK_SHORT;
  readonly rankFields: Array<{ key: RankField; label: string }> = [
    { key: 'strength', label: 'Strength' }, { key: 'pushup', label: 'Push-up' }, { key: 'pullup', label: 'Pull-up' },
    { key: 'cardio', label: 'Cardio' }, { key: 'sprint', label: '100 m Sprint' }, { key: 'longjump', label: 'Broad Jump' },
    { key: 'pike', label: 'Pike' }, { key: 'backbend', label: 'Backbend' }, { key: 'straddle', label: 'Middle Split' }
  ];

  athlete!: PracticeAthlete;
  rules: WeekBlocks = [];
  model: WeekBlocks = [];
  week: WeekBlocks = [];

  corrections: TrainerCorrection[] = [];
  private learner = new Learner();
  chart: Score[] = [];

  loading = true;
  saving = false;
  error = '';
  note = '';
  selected: BlockKey | null = null;   // tapped in the sidebar; the next tapped day takes it
  private drag: Drag | null = null;
  private pending: { drag: Drag; x: number; y: number } | null = null;
  private justDragged = false;
  ghost: { key: BlockKey; x: number; y: number } | null = null;
  dropDay: number | null = null;

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, closeOutline, refreshOutline, trashOutline, sparklesOutline });
  }

  async ngOnInit() {
    this.newAthlete();
    try {
      // Every correction counts, whatever rules it was made under: the coach's week is the answer, and the rules' week
      // is rebuilt from the athlete with the current rules (see examples).
      this.corrections = await this.firebase.listTrainerCorrections();
      this.retrain();
      this.build(false);
    } catch (e) {
      console.error('Program Trainer: corrections could not be loaded', e);
      this.error = 'Saved corrections could not be loaded. The model is using the rules only.';
    } finally {
      this.loading = false;
    }
  }

  goBack() { this.router.navigate(['/home']); }

  // ---------- Athlete ----------
  newAthlete() {
    this.athlete = practiceAthlete();
    this.note = '';
    this.build(false);
  }

  get state(): AthleteState { return this.athlete.state; }
  trains(i: number): boolean { return this.state.minutes[i] > 0; }
  get trainingDays(): number { return this.state.minutes.filter(m => m > 0).length; }
  get belowMinimum(): boolean { return this.trainingDays < MIN_DAYS[this.athlete.overall]; }

  rankOf(f: RankField): OmniRank {
    const s = this.state;
    switch (f) {
      case 'strength': return s.strengthRank;
      case 'pushup': return s.pushupRank;
      case 'pullup': return s.pullupRank;
      case 'cardio': return s.cardioRank;
      case 'sprint': return s.powerRanks.sprint;
      case 'longjump': return s.powerRanks.longjump;
      default: return s.flexibilityRanks[f];
    }
  }

  setRank(f: RankField, r: OmniRank) {
    const s = this.state;
    if (f === 'strength') s.strengthRank = r;
    else if (f === 'pushup') s.pushupRank = r;
    else if (f === 'pullup') s.pullupRank = r;
    else if (f === 'cardio') s.cardioRank = r;
    else if (f === 'sprint') s.powerRanks.sprint = r;
    else if (f === 'longjump') s.powerRanks.longjump = r;
    else s.flexibilityRanks[f] = r;
    this.build(true);
  }

  setOverall(r: OmniRank) { this.athlete.overall = r; }

  toggleDay(i: number) {
    this.state.minutes = this.state.minutes.map((m, j) => (j === i ? (m > 0 ? 0 : 60) : m));
    this.build(true);
  }

  // The rules' week and the model's week for the athlete; the coach starts from the model's.
  private build(keepNote: boolean) {
    const program = generateProgram(this.state, { weeks: 1 });
    this.rules = weekBlocks(program.schedule.slice(0, 7));
    this.model = this.learner.predict(this.state, this.rules);
    this.week = cloneWeek(this.model);
    if (!keepNote) this.note = '';
  }

  // ---------- Week ----------
  sorted(day: BlockKey[]): Array<{ key: BlockKey; index: number }> {
    return day.map((key, index) => ({ key, index })).sort((a, b) => ORDER.get(a.key)! - ORDER.get(b.key)! || a.index - b.index);
  }
  def(k: BlockKey): BlockDef { return blockDef(k); }
  // The lists below are rebuilt on every render; tracking keeps the same elements, so a press and its click land on one.
  trackBlock = (_: number, b: { key: BlockKey; index: number }) => `${b.key}:${b.index}`;
  trackRemoved = (n: number, k: BlockKey) => `${k}:${n}`;
  trackDef = (_: number, b: BlockDef) => b.key;
  groupBlocks(g: BlockGroup): BlockDef[] { return BLOCKS.filter(b => b.group === g); }
  groupClass(k: BlockKey): string { return 'g-' + blockDef(k).group.toLowerCase(); }

  // Blocks the rules had on a day that the coach's week does not, shown struck through.
  removed(i: number): BlockKey[] {
    const r = counts(this.rules[i] ?? []), w = counts(this.week[i] ?? []);
    const out: BlockKey[] = [];
    for (const b of BLOCKS) for (let n = 0; n < r[b.key] - w[b.key]; n++) out.push(b.key);
    return out;
  }
  // Whether this block is beyond what the rules had on the day.
  added(i: number, k: BlockKey, index: number): boolean {
    const before = this.week[i].slice(0, index + 1).filter(x => x === k).length;
    return before > counts(this.rules[i] ?? [])[k];
  }

  remove(i: number, index: number) { this.week[i].splice(index, 1); }
  add(i: number, k: BlockKey) { if (this.trains(i)) this.week[i].push(k); }

  dayTap(i: number) {
    if (this.justDragged || !this.selected) return;
    this.add(i, this.selected);
  }
  choose(k: BlockKey) {
    if (this.justDragged) return;
    this.selected = this.selected === k ? null : k;
  }

  // Dragging works with a mouse, a finger or a pencil: a press that moves more than a few pixels becomes a drag,
  // and a press that does not is a tap. The block under the pointer follows it until it is let go over a day
  // (added there, or moved there) or over the sidebar (removed).
  press(e: PointerEvent, drag: Drag) {
    if ((e.target as HTMLElement).closest('.pt-x') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Stops the browser starting a text selection (Safari) or a native drag; the tap still arrives as a click.
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    this.pending = { drag, x: e.clientX, y: e.clientY };
  }

  // No text selection while a block is held.
  @HostListener('document:selectstart', ['$event'])
  noSelect(e: Event) { if (this.pending) e.preventDefault(); }

  @HostListener('document:pointermove', ['$event'])
  move(e: PointerEvent) {
    if (!this.pending) return;
    if (!this.ghost) {
      if (Math.hypot(e.clientX - this.pending.x, e.clientY - this.pending.y) < 6) return;
      const d = this.pending.drag;
      this.drag = d;
      this.ghost = { key: d.from === 'palette' ? d.key : this.week[d.day][d.index], x: 0, y: 0 };
    }
    e.preventDefault();
    this.ghost.x = e.clientX;
    this.ghost.y = e.clientY;
    const t = this.target(e);
    this.dropDay = t !== null && t !== 'sidebar' && this.trains(t) ? t : null;
  }

  @HostListener('document:pointerup', ['$event'])
  release(e: PointerEvent) {
    const d = this.drag;
    const dragged = !!this.ghost;
    this.pending = null;
    this.ghost = null;
    this.drag = null;
    this.dropDay = null;
    if (!dragged || !d) return;
    this.justDragged = true;
    setTimeout(() => (this.justDragged = false));
    const t = this.target(e);
    if (t === 'sidebar') { if (d.from === 'day') this.week[d.day].splice(d.index, 1); return; }
    if (t === null || !this.trains(t)) return;
    if (d.from === 'palette') { this.week[t].push(d.key); return; }
    if (d.day === t) return;
    const [k] = this.week[d.day].splice(d.index, 1);
    this.week[t].push(k);
  }

  @HostListener('document:pointercancel')
  cancel() { this.pending = null; this.ghost = null; this.drag = null; this.dropDay = null; }

  // The day column or the sidebar under the pointer.
  private target(e: PointerEvent): number | 'sidebar' | null {
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const col = el?.closest('[data-day]');
    if (col) return Number(col.getAttribute('data-day'));
    return el?.closest('.pt-palette') ? 'sidebar' : null;
  }

  resetToModel() { this.week = cloneWeek(this.model); }
  resetToRules() { this.week = cloneWeek(this.rules); }

  // ---------- Scores ----------
  get rulesOff(): number { return distance(this.rules, this.week); }
  get modelOff(): number { return distance(this.model, this.week); }
  get rulesPct(): number { return Math.round(accuracy(this.rules, this.week) * 100); }
  get modelPct(): number { return Math.round(accuracy(this.model, this.week) * 100); }
  get modelDiffers(): boolean { return distance(this.rules, this.model) > 0; }
  get edited(): boolean { return this.modelOff > 0; }

  private retrain() {
    const examples = this.examples();
    this.learner = new Learner(examples);
    this.chart = history(examples);
  }

  private examples(): Example[] { return examplesFrom(this.corrections); }

  // Blocks off per week, averaged over the latest ten corrections and over the first ten.
  recent(field: 'rulesOff' | 'modelOff'): string { return this.mean(this.chart.slice(-10), field); }
  first(field: 'rulesOff' | 'modelOff'): string { return this.mean(this.chart.slice(0, 10), field); }
  private mean(rows: Score[], field: 'rulesOff' | 'modelOff'): string {
    return rows.length ? (rows.reduce((t, r) => t + r[field], 0) / rows.length).toFixed(1) : '—';
  }

  // Five-correction running average of blocks off, as an SVG path across a 600 x 160 box (more off is lower).
  get chartTop(): number { return Math.max(4, ...this.chart.map(r => Math.max(r.rulesOff, r.modelOff))); }
  path(field: 'rulesOff' | 'modelOff'): string {
    const v = this.chart.map((_, i) => {
      const w = this.chart.slice(Math.max(0, i - 4), i + 1);
      return w.reduce((t, r) => t + r[field], 0) / w.length;
    });
    if (v.length < 2) return '';
    const top = this.chartTop;
    return v.map((y, i) => `${i ? 'L' : 'M'}${(i / (v.length - 1) * 600).toFixed(1)} ${(150 - (y / top) * 140).toFixed(1)}`).join(' ');
  }

  // ---------- Saving ----------
  async save() {
    if (this.saving) return;
    this.saving = true;
    this.error = '';
    const entry: TrainerCorrection = {
      createdAt: new Date().toISOString(),
      engineVersion: ENGINE_VERSION,
      name: this.athlete.name,
      overall: this.athlete.overall,
      state: this.state as unknown as Record<string, unknown>,
      rules: toStored(this.rules),
      model: toStored(this.model),
      corrected: toStored(this.week),
      source: 'practice',
      ...(this.note.trim() ? { note: this.note.trim() } : {})
    };
    try {
      const id = await this.firebase.addTrainerCorrection(entry);
      this.corrections = [...this.corrections, { ...entry, id }];
      this.retrain();
      this.newAthlete();
    } catch (e) {
      console.error('Program Trainer: save failed', e);
      this.error = 'The correction could not be saved. Check the connection and try again.';
    } finally {
      this.saving = false;
    }
  }

  async deleteCorrection(c: TrainerCorrection) {
    if (!c.id) return;
    try {
      await this.firebase.deleteTrainerCorrection(c.id);
      this.corrections = this.corrections.filter(x => x.id !== c.id);
      this.retrain();
      this.build(true);
    } catch (e) {
      console.error('Program Trainer: delete failed', e);
      this.error = 'The correction could not be deleted.';
    }
  }

  get latest(): TrainerCorrection[] { return [...this.corrections].reverse().slice(0, 8); }
  // Scored with the current rules, and the model as it stood before learning from the correction.
  correctionPct(c: TrainerCorrection, field: 'rules' | 'model'): number {
    const row = this.chart[this.corrections.indexOf(c)];
    return row ? Math.round(row[field] * 100) : 0;
  }
}
