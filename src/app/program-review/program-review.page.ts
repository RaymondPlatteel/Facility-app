import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, AlertController, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, arrowUp, arrowDown, closeOutline, checkmarkCircle } from 'ionicons/icons';
import { FirebaseService, Program, ProgramChange, ProgramDay, ProgramExercise } from '../services/firebase.service';
import { ProgramReviewCountService } from '../services/program-review-count.service';

// A coach's review of an athlete's generated program: see every week at once, move exercises, swap days,
// write notes, answer the athlete's questions and approve. Edits go straight to the program document.
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

  // The days where the proposed version differs from the current program.
  get changes(): Array<{ week: number; day: number; current: ProgramExercise[]; proposed: ProgramExercise[] }> {
    const p = this.proposal;
    if (!p || !this.program) return [];
    const out: Array<{ week: number; day: number; current: ProgramExercise[]; proposed: ProgramExercise[] }> = [];
    for (let w = 0; w < this.weeks.length; w++) {
      for (let d = 0; d < 7; d++) {
        const cur = this.day(w, d)?.exercises ?? [];
        const prop = p.schedule[w * 7 + d]?.exercises ?? [];
        if (this.sig(cur) !== this.sig(prop)) out.push({ week: w, day: d, current: cur, proposed: prop });
      }
    }
    return out;
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
      this.dirty = false;
      this.reviewCount.refresh();
      await this.toast(approve ? 'Program approved' : 'Changes saved');
    } catch (err) {
      console.error('Program review: save failed', err);
      await this.toast('Could not save', 'danger');
    }
    this.saving = false;
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
