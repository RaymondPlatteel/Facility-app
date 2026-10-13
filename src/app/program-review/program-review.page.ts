import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, AlertController, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, arrowUp, arrowDown, closeOutline, checkmarkCircle } from 'ionicons/icons';
import { FirebaseService, OmniRank, Program, ProgramChange, ProgramDay, ProgramExercise } from '../services/firebase.service';
import { toStored, weekBlocks } from '../program-engine/blocks';
import { generateProgram } from '../program-engine/generator';
import type { AthleteState } from '../program-engine/types';
import { ENGINE_VERSION } from '../program-engine/version';
import { ProgramReviewCountService } from '../services/program-review-count.service';

// A coach's review of an athlete's generated program: see every week at once, move exercises, swap days,
// write notes, answer the athlete's questions and approve. Edits go straight to the program document.
// One line of a proposed day: what was added, removed or changed.
interface DiffRow { kind: 'added' | 'removed' | 'changed' | 'order'; name: string; was?: string; now?: string; }

@Component({
  selector: 'app-program-review',
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule],
  templateUrl: './program-review.page.html',
  styleUrls: ['./program-review.page.scss']
})
export class ProgramReviewPage implements OnInit {
  loading = true;
  program: Program | null = null;
  week = 0;
  allWeeks = true;               // apply a change to the same day in every week
  reviewer = '';
  reply = '';
  dirty = false;
  saving = false;
  private pendingLog: Array<Pick<ProgramChange, 'key' | 'kind' | 'summary' | 'detail'>> = [];
  private savedNote = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private firebase: FirebaseService,
    private alertController: AlertController,
    private toastController: ToastController,
    private reviewCount: ProgramReviewCountService
  ) {
    addIcons({ arrowBack, arrowUp, arrowDown, closeOutline, checkmarkCircle });
  }

  async ngOnInit() {
    try { this.reviewer = localStorage.getItem('reviewerName') || ''; } catch { /* storage unavailable */ }
    await this.load();
  }

  private async load() {
    this.loading = true;
    const id = this.route.snapshot.paramMap.get('id');
    this.program = id ? await this.firebase.getProgram(id).catch(() => null) : null;
    this.dirty = false;
    this.savedNote = (this.program?.reviewNote || '').trim();
    this.loading = false;
  }

  get weeks(): number[] { return Array.from({ length: this.program?.cycles ?? 0 }, (_, i) => i); }
  get weekdays(): string[] { return (this.program?.schedule ?? []).slice(0, 7).map(d => d.name); }
  day(week: number, d: number): ProgramDay { return this.program!.schedule[week * 7 + d]; }
  get athlete(): string { return (this.program?.assignedClientNames ?? []).join(', ') || 'Athlete'; }
  get approved(): boolean { return this.program?.reviewStatus === 'approved'; }

  // The weeks a change applies to.
  private scope(): number[] { return this.allWeeks ? this.weeks : [this.week]; }

  summary(e: ProgramExercise): string {
    const attrs = e.attributes || [];
    const get = (t: string) => attrs.find(a => a.type === t);
    // A flexibility routine is a video and a check box: say which routine, with no sets or columns.
    const routine = get('Routine')?.val?.split('|');
    if (routine && routine.length === 3) {
      const rank = routine[0] === 'UNRANKED' ? 'Unranked' : routine[0].replace('-RANK', '-Rank');
      return `${rank} · ${routine[1][0].toUpperCase() + routine[1].slice(1)} routine`;
    }
    const parts: string[] = [];
    if (e.setPlan?.length) parts.push(`${e.setPlan.length} sets: ${e.setPlan.map(s => s.reps).join(' / ')}`);
    else {
      const sets = get('Sets')?.val;
      const reps = get('Reps');
      if (sets) parts.push(reps?.strategy === 'AMRAP' ? `${sets} × max` : reps?.val ? `${sets} × ${reps.val}` : `${sets} set${sets === '1' ? '' : 's'}`);
    }
    const rir = get('RIR')?.val; if (rir) parts.push(`${rir} RIR`);
    const dur = get('Duration')?.val; if (dur) parts.push(`${Math.round(Number(dur) / 60)} min`);
    const hr = get('HR')?.val; if (hr) parts.push(`HR ${hr}`);
    const cols = attrs.map(a => a.type).filter(x => x !== 'Sets');
    if (cols.length) parts.push(`Columns: ${cols.join(', ')}`);
    return parts.join(' · ');
  }

  // What a coach would notice about an exercise: if this matches, the exercise reads the same.
  private sig(list: ProgramExercise[]): string {
    return list.map(e => `${e.name}|${this.summary(e)}|${e.instructions || ''}|${JSON.stringify(e.setPlan || [])}`).join('\n');
  }

  // ---- a proposed update from the generator, after the athlete's results or schedule changed ----
  get proposal() { return this.program?.proposal ?? null; }

  // The days where the proposed version differs from the current program, and within each day only the exercises
  // that were added, removed or changed. What stayed the same is left out.
  get changes(): Array<{ week: number; day: number; rows: DiffRow[]; same: number }> {
    const p = this.proposal;
    if (!p || !this.program) return [];
    const out: Array<{ week: number; day: number; rows: DiffRow[]; same: number }> = [];
    for (let w = 0; w < this.weeks.length; w++) {
      for (let d = 0; d < 7; d++) {
        const cur = this.day(w, d)?.exercises ?? [];
        const prop = p.schedule[w * 7 + d]?.exercises ?? [];
        if (this.sig(cur) !== this.sig(prop)) out.push({ week: w, day: d, ...this.diff(cur, prop) });
      }
    }
    return out;
  }

  private one(e: ProgramExercise): string {
    return `${this.summary(e)}${e.instructions ? ` · ${e.instructions}` : ''}`;
  }

  // Exercises are matched by name, in order; a match that reads the same is unchanged and not listed.
  private diff(cur: ProgramExercise[], prop: ProgramExercise[]): { rows: DiffRow[]; same: number } {
    const rows: DiffRow[] = [];
    const left = [...cur];
    let same = 0;
    for (const e of prop) {
      const at = left.findIndex(c => c.name === e.name);
      if (at < 0) { rows.push({ kind: 'added', name: e.name, now: this.one(e) }); continue; }
      const [c] = left.splice(at, 1);
      if (this.sig([c]) === this.sig([e])) same++;
      else rows.push({ kind: 'changed', name: e.name, was: this.one(c), now: this.one(e) });
    }
    for (const c of left) rows.push({ kind: 'removed', name: c.name, was: this.one(c) });
    // the same exercises in a different order
    if (!rows.length) rows.push({ kind: 'order', name: 'Order of exercises' });
    return { rows, same };
  }

  useProposedDay(w: number, d: number) {
    const prop = this.proposal?.schedule[w * 7 + d];
    if (!prop) return;
    const day = this.day(w, d);
    day.exercises = JSON.parse(JSON.stringify(prop.exercises));
    day.isRestDay = prop.isRestDay;
    this.touch();
  }

  useProposedAll() {
    for (const c of this.changes) this.useProposedDay(c.week, c.day);
  }

  // Done with the proposal: save the schedule as it now stands and clear the proposal.
  async finishProposal() {
    if (!this.program?.id) return;
    this.saving = true;
    try {
      await this.firebase.saveProgramReview(this.program.id, { schedule: this.program.schedule }, true);
      await this.flushLog();
      this.program.proposal = undefined;
      this.dirty = false;
      this.reviewCount.refresh();
      await this.toast('Update reviewed');
    } catch (err) {
      console.error('Program review: could not finish the update', err);
      await this.toast('Could not save', 'danger');
    }
    this.saving = false;
  }

  // ---- edits (each applies to this week or to every week) ----
  private touch() { this.dirty = true; }
  private dayName(d: number): string { return this.weekdays[d] || `Day ${d + 1}`; }
  private note(kind: ProgramChange['kind'], key: string, summary: string, detail?: string) {
    this.pendingLog.push({ kind, key: `${kind}:${key}`, summary, detail });
  }

  move(d: number, i: number, dir: -1 | 1) {
    const name = this.day(this.week, d).exercises[i].name;
    this.note('move', `${name}|${this.dayName(d)}|${dir}`, `Move ${name} ${dir < 0 ? 'earlier' : 'later'} on ${this.dayName(d)}`);
    for (const w of this.scope()) {
      const list = this.day(w, d).exercises;
      const at = list.findIndex(e => e.name === name);
      const to = at + dir;
      if (at < 0 || to < 0 || to >= list.length) continue;
      [list[at], list[to]] = [list[to], list[at]];
    }
    this.touch();
  }

  moveToDay(d: number, i: number, target: string) {
    const to = Number(target);
    if (Number.isNaN(to) || to === d) return;
    const name = this.day(this.week, d).exercises[i].name;
    this.note('moveDay', `${name}|${this.dayName(d)}|${this.dayName(to)}`, `Move ${name} from ${this.dayName(d)} to ${this.dayName(to)}`);
    for (const w of this.scope()) {
      const from = this.day(w, d);
      const at = from.exercises.findIndex(e => e.name === name);
      if (at < 0) continue;
      const [ex] = from.exercises.splice(at, 1);
      const dest = this.day(w, to);
      dest.exercises.push(ex);
      dest.isRestDay = false;
      from.isRestDay = from.exercises.length === 0;
    }
    this.touch();
  }

  async remove(d: number, i: number) {
    const name = this.day(this.week, d).exercises[i].name;
    const alert = await this.alertController.create({
      header: 'Remove exercise?',
      message: `${name} will be removed from ${this.allWeeks ? 'this day in every week' : 'this day'}.`,
      buttons: [{ text: 'Cancel', role: 'cancel' }, {
        text: 'Remove', role: 'destructive', handler: () => {
          this.note('remove', name, `Remove ${name}`);
          for (const w of this.scope()) {
            const day = this.day(w, d);
            day.exercises = day.exercises.filter(e => e.name !== name);
            day.isRestDay = day.exercises.length === 0;
          }
          this.touch();
        }
      }]
    });
    await alert.present();
  }

  swapDays(d: number, target: string) {
    const other = Number(target);
    if (Number.isNaN(other) || other === d) return;
    const pair = [d, other].sort((x, y) => x - y).map(x => this.dayName(x));
    this.note('swapDays', pair.join('|'), `Swap ${pair[0]} and ${pair[1]}`);
    for (const w of this.scope()) {
      const a = this.day(w, d);
      const b = this.day(w, other);
      [a.exercises, b.exercises] = [b.exercises, a.exercises];
      [a.isRestDay, b.isRestDay] = [b.isRestDay, a.isRestDay];
      [a.notes, b.notes] = [b.notes, a.notes];
    }
    this.touch();
  }

  setNote(d: number, text: string) {
    const day = this.dayName(d);
    const at = this.pendingLog.findIndex(x => x.kind === 'dayNote' && x.key === `dayNote:${day}`);
    if (at >= 0) this.pendingLog.splice(at, 1);        // keep only the final wording of a note typed over several keystrokes
    if (text.trim()) this.note('dayNote', day, `Note on ${day}`, text.trim());
    for (const w of this.scope()) this.day(w, d).notes = text;
    this.touch();
  }

  // ---- save, approve, reply ----
  async save(approve = false) {
    if (!this.program?.id || this.saving) return;
    this.saving = true;
    try {
      try { localStorage.setItem('reviewerName', this.reviewer.trim()); } catch { /* storage unavailable */ }
      const fields: Partial<Program> = { schedule: this.program.schedule, reviewNote: (this.program.reviewNote || '').trim() };
      if (this.dirty) fields.coachEdited = true;   // from now on a newer version is proposed, not swapped in
      if (approve) {
        fields.reviewStatus = 'approved';
        fields.reviewedBy = this.reviewer.trim() || 'a coach';
        fields.reviewedAt = new Date().toISOString();
      }
      await this.firebase.saveProgramReview(this.program.id, fields);
      const noteNow = (fields.reviewNote || '');
      if (noteNow && noteNow !== this.savedNote) this.note('reviewNote', noteNow.toLowerCase(), 'Note to the athlete', noteNow);
      this.savedNote = noteNow;
      await this.flushLog();
      Object.assign(this.program, fields);
      await this.teach();
      this.dirty = false;
      this.reviewCount.refresh();
      await this.toast(approve ? 'Program approved' : 'Changes saved');
    } catch (err) {
      console.error('Program review: save failed', err);
      await this.toast('Could not save', 'danger');
    }
    this.saving = false;
  }

  // A saved review of a generated program is a correction for the Program Trainer's model: the athlete as the rules
  // read them, the rules' first week, and the first week as the coach left it. One per program, replaced on each save.
  // Best-effort, like the log: it never blocks saving the program.
  private async teach() {
    const p = this.program;
    const state = p?.generatedFrom?.state as AthleteState | undefined;
    if (!p?.id || !p.generated || !state?.minutes) return;
    try {
      const rules = weekBlocks(generateProgram(state, { weeks: 1 }).schedule.slice(0, 7));
      await this.firebase.setTrainerCorrection(`review-${p.id}`, {
        createdAt: new Date().toISOString(),
        engineVersion: ENGINE_VERSION,
        name: this.athlete,
        overall: (p.generatedFrom?.overall ?? state.strengthRank) as OmniRank,
        state: state as unknown as Record<string, unknown>,
        rules: toStored(rules),
        model: p.generatedFrom?.blocks ?? toStored(rules),   // the week as built, before the coach's edits
        corrected: toStored(weekBlocks(p.schedule.slice(0, 7))),
        source: 'review',
        programId: p.id
      });
    } catch (err) { console.error('Program review: trainer correction not saved', err); }
  }

  // Logging is best-effort: a failure here must never block saving the program.
  private async flushLog() {
    const entries = this.pendingLog.splice(0);
    if (!entries.length || !this.program?.id) return;
    const reviewer = this.reviewer.trim() || 'a coach';
    try {
      await this.firebase.logProgramChanges(entries.map(e => ({
        ...e, programId: this.program!.id!, athlete: this.athlete, reviewer, at: new Date().toISOString()
      })));
    } catch (err) { console.error('Program review: change log not saved', err); }
  }

  async sendReply() {
    const text = this.reply.trim();
    if (!text || !this.program?.id) return;
    try {
      await this.firebase.addProgramSupportReply(this.program.id, text);
      this.program.support = [...(this.program.support || []), { from: 'coach', text, at: new Date().toISOString() }];
      this.reply = '';
      this.reviewCount.refresh();
    } catch (err) {
      console.error('Program review: reply failed', err);
      await this.toast('Could not send the reply', 'danger');
    }
  }

  when(at: string): string {
    return new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  goBack() { this.router.navigateByUrl('/programs'); }

  private async toast(message: string, color: 'success' | 'danger' = 'success') {
    const t = await this.toastController.create({ message, duration: 1600, position: 'bottom', color });
    await t.present();
  }
}
