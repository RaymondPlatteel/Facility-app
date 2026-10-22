import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AiReviewService } from '../ai/ai-review.service';
import { AiReview, AiTrainingVideo, TEST_LABELS, VIDEO_TESTS, VideoTest, plateEstimateOf, speedEstimateOf } from '../ai/ai-review.types';
import { GLOBAL_TUNABLES, TUNABLES, Tunable, getOverrides } from '../ai/thresholds';
import { AiSubmissionsComponent } from './ai-submissions.component';
import { Answer, COMPONENT_STATUS, COMPONENTS, Component as Part, ComponentStats, LIFT_TESTS, VIDEO_COMPONENTS, agreement, answerOf, componentById, componentStats, feedbackFor, submissionRows } from './ai-trainer.components';

// One component of a test's checklist, trained on its own: the videos that show it, how strict it is, and how often the AI
// gets it right. A component such as the weight on the bar is the same in every lift, so its page takes the videos of all of
// them; one such as the lockout is a different thing in each test, so its page takes that test's videos.
@Component({
  selector: 'app-ai-component',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, AiSubmissionsComponent],
  templateUrl: './ai-component.page.html',
  styleUrls: ['./ai-trainer.page.scss', './ai-trainer-detail.page.scss', './ai-component.page.scss']
})
export class AiComponentPage implements OnDestroy {
  part: Part = COMPONENTS[0];
  // The test this page is for, or null when the component is shared by every test that has it.
  test: VideoTest | null = null;
  reviews: AiReview[] = [];
  videos: AiTrainingVideo[] = [];
  values: Record<string, number> = {};
  busy = '';
  message = '';
  showAll = false;
  private subs = new Subscription();
  readonly statusText = COMPONENT_STATUS;
  readonly labels = TEST_LABELS;

  form = { test: 'deadlift' as VideoTest, expected: 'pass' as 'pass' | 'fail', value: null as number | null, weight: null as number | null, reps: null as number | null,
    height: null as number | null, body: null as number | null, file: null as File | null };

  constructor(private route: ActivatedRoute, private router: Router, private ai: AiReviewService) {
    addIcons({ arrowBack });
    this.ai.start();
    this.subs.add(this.route.paramMap.subscribe(p => {
      const area = p.get('area') ?? '', id = p.get('component') ?? '';
      const part = componentById(id);
      const test = (VIDEO_TESTS as readonly string[]).includes(area) ? area as VideoTest : null;
      if (!part || (!test && !this.shared(part)) || (test && !part.tests.includes(test))) { this.router.navigateByUrl('/ai-trainer'); return; }
      this.part = part;
      this.test = this.shared(part) ? null : test;
      this.form.test = this.test ?? this.scope[0];
      this.loadValues();
    }));
    this.subs.add(this.ai.reviews$.subscribe(r => this.reviews = r));
    this.subs.add(this.ai.trainingVideos$.subscribe(v => this.videos = v));
  }
  ngOnDestroy() { this.subs.unsubscribe(); }

  // Shared across every test that has it: the weight, and the checks of the video itself.
  private shared(c: Part): boolean { return c.id === 'weight' || VIDEO_COMPONENTS.includes(c.id); }
  get isShared(): boolean { return this.test === null; }
  get isWeight(): boolean { return this.part.kind === 'weight'; }
  // The tests whose videos this page takes.
  get scope(): readonly VideoTest[] { return this.test ? [this.test] : this.part.tests; }
  get title(): string { return this.part.label; }
  get subtitle(): string { return this.test ? this.labels[this.test] : this.isWeight ? 'All lifts' : 'Every test'; }
  get backLink(): string { return this.test ? `/ai-trainer/${this.test}` : '/ai-trainer'; }
  goBack() { this.router.navigateByUrl(this.backLink); }

  get stats(): ComponentStats { return componentStats(this.part, this.reviews, this.test ?? undefined); }
  readonly pctText = (v: number | null) => (v === null ? '\u2014' : Math.round(v * 100) + '%');
  speedOf(r: AiReview): number | null { return speedEstimateOf(r.weight); }
  // Why the plates were not read on a review, or how sure the reading was.
  plateNote(r: AiReview): string { return r.weight?.plates?.note ?? ''; }
  confidenceText(r: AiReview): string {
    const c = r.weight?.confidence;
    return c === 'high' ? 'High confidence' : c === 'medium' ? 'Medium confidence' : c === 'low' ? 'Low confidence' : 'Plates not read';
  }

  // ---- how strict it is ----
  // Each number the component judges by, and the scopes that hold it: the test's own settings, or the settings every video shares.
  // Built once per page, so the list is stable between change-detection passes.
  tunables: Array<{ t: Tunable; scopes: string[] }> = [];
  private buildTunables(): Array<{ t: Tunable; scopes: string[] }> {
    const out: Array<{ t: Tunable; scopes: string[] }> = [];
    for (const key of this.part.tunables) {
      const own = this.scope.filter(s => TUNABLES[s].some(t => t.key === key));
      if (own.length) out.push({ t: TUNABLES[own[0]].find(t => t.key === key)!, scopes: own });
      else { const g = GLOBAL_TUNABLES.find(t => t.key === key); if (g) out.push({ t: g, scopes: ['*'] }); }
    }
    return out;
  }
  private current(scope: string, t: Tunable): number { return getOverrides()[scope]?.[t.key] ?? t.value; }
  private loadValues() {
    this.tunables = this.buildTunables();
    this.values = {};
    for (const x of this.tunables) this.values[x.t.key] = this.current(x.scopes[0], x.t);
  }
  get dirty(): boolean { return this.tunables.some(x => this.values[x.t.key] !== this.current(x.scopes[0], x.t)); }
  get tuned(): boolean { return this.tunables.some(x => this.values[x.t.key] !== x.t.value); }
  resetValues() { for (const x of this.tunables) this.values[x.t.key] = x.t.value; }

  async saveValues() {
    this.busy = 'save';
    try {
      // Each scope's own settings are written whole, so keep what is already set for the other components.
      const scopes = new Set<string>();
      for (const x of this.tunables) for (const sc of x.scopes) scopes.add(sc);
      for (const s of Array.from(scopes)) {
        const out: Record<string, number> = { ...(getOverrides()[s] ?? {}) };
        for (const x of this.tunables) if (x.scopes.includes(s)) {
          if (Number(this.values[x.t.key]) === x.t.value) delete out[x.t.key]; else out[x.t.key] = Number(this.values[x.t.key]);
        }
        await this.ai.saveThresholds(s, out);
      }
      this.message = 'Settings saved. Analyse the videos again to apply them.';
    } catch { this.message = 'Settings could not be saved.'; }
    this.busy = '';
  }
  async rerunAll() {
    this.busy = 'rerun';
    let n = 0;
    for (const t of this.scope) n += await this.ai.rerunTest(t);
    this.message = `${n} video${n === 1 ? '' : 's'} queued to be analysed again.`;
    this.busy = '';
  }

  // ---- the videos to judge ----
  private get mineReviews(): AiReview[] {
    return this.reviews.filter(r => r.status === 'done' && this.scope.includes(r.test)
      && (this.isWeight ? !!r.weight : (r.checks ?? []).some(c => c.id === this.part.id)));
  }
  private judged(r: AiReview): boolean {
    return this.isWeight ? !!this.actual(r) : !!r.trainer?.checks?.[this.part.id];
  }
  // Every video this component was checked on, to open and compare.
  get rows() {
    return submissionRows(this.reviews, this.videos, r => this.scope.includes(r.test) && (this.isWeight ? (r.status !== 'done' || !!r.weight) : !!r.checks?.some(c => c.id === this.part.id)));
  }
  // The ones nobody has judged and the AI was least sure of come first: those teach it most.
  get examples(): AiReview[] {
    const unsure = (r: AiReview) => Math.abs((r.confidence ?? 0.5) - 0.5);
    const list = [...this.mineReviews].sort((a, b) => Number(this.judged(a)) - Number(this.judged(b)) || unsure(a) - unsure(b) || (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? ''));
    return this.showAll ? list : list.slice(0, 12);
  }
  get total(): number { return this.mineReviews.length; }
  isJudged(r: AiReview): boolean { return this.judged(r); }
  checkOf(r: AiReview) { return (r.checks ?? []).find(c => c.id === this.part.id); }
  // What you say this component should have found, beside what the AI found.
  answer(r: AiReview): Answer | undefined { const c = this.checkOf(r); return c ? answerOf(r, c) : undefined; }
  agrees(r: AiReview) { const c = this.checkOf(r); return c ? agreement(r, c) : undefined; }
  setAnswer(r: AiReview, a: Answer) {
    const c = this.checkOf(r);
    if (c) this.ai.saveTrainer(r.id!, feedbackFor(c, a)).catch(() => this.message = 'That could not be saved.');
  }
  actual(r: AiReview): number | string { return r.trainer?.actualWeight ?? r.coachLabels?.actualWeight ?? ''; }
  setActual(r: AiReview, v: string) {
    const n = parseFloat(v);
    this.ai.saveTrainer(r.id!, { actualWeight: isFinite(n) && n > 0 ? n : null }).catch(() => this.message = 'That could not be saved.');
  }
  when(r: AiReview): string { return r.id?.startsWith('tv_') ? 'Training video' : r.clientName; }
  trackId = (_: number, r: AiReview) => r.id;

  // ---- add a training video ----
  get mine(): AiTrainingVideo[] { return this.videos.filter(v => v.component === this.part.id && this.scope.includes(v.test)); }
  get formLift(): boolean { return (LIFT_TESTS as readonly string[]).includes(this.form.test); }
  pick(e: Event) { this.form.file = (e.target as HTMLInputElement).files?.[0] ?? null; }
  // Checks that compare against a claim need one; the rest can be taught without it.
  get needsClaim(): boolean { return ['distance', 'length', 'hold', 'reach'].includes(this.part.id); }
  // What is still missing before the video can be added, in words, so the button never just sits there.
  get missing(): string {
    if (!this.form.file) return 'Choose a video file.';
    if (this.isWeight && !(this.form.weight && this.form.weight > 0)) return 'Enter the weight on the bar.';
    if (this.needsClaim && !(this.form.value && this.form.value > 0)) return 'Enter the claimed result, which this component is checked against.';
    return '';
  }
  get canAdd(): boolean { return !this.busy && !this.missing; }
  async add() {
    if (!this.canAdd || !this.form.file) return;
    this.busy = 'add';
    try {
      const reps = Number(this.form.reps) || 1;
      // For the weight, the answer is the weight on the bar; the score is worked out from it so the video can be analysed.
      const weight = this.isWeight ? Number(this.form.weight) : (Number(this.form.weight) || null);
      const value = this.isWeight ? Math.round(weight! * (reps >= 37 ? 1 : 36 / (37 - reps))) : (Number(this.form.value) || 0);
      await this.ai.addTrainingVideo(this.form.file, {
        test: this.form.test, component: this.part.id,
        ...(this.isWeight ? { actualWeight: weight } : { expected: this.form.expected }),
        claimed: { value, weight: this.formLift ? weight : null, reps: this.formLift || this.test === 'pushups' || this.test === 'pullups' ? reps : (Number(this.form.reps) || null) },
        heightIn: this.form.height || null, bodyWeightLb: this.form.body || null
      }, this.form.file.name);
      this.message = 'The video was added. It is analysed shortly, then the AI is marked against your answer.';
      this.form.file = null; this.form.value = null; this.form.weight = null; this.form.reps = null;
    } catch (err: any) { this.message = `The video could not be uploaded${err?.code ? ' (' + err.code + ')' : ''}. ${err?.message ?? ''}`.trim(); }
    this.busy = '';
  }
  async remove(v: AiTrainingVideo) {
    if (!v.id || !confirm('Remove this training video?')) return;
    await this.ai.deleteTrainingVideo(v.id).catch(() => this.message = 'It could not be removed.');
  }

  // How the AI did on one training video of this component, for the list.
  outcome(v: AiTrainingVideo): string {
    const r = this.reviews.find(x => x.id === `tv_${v.id}_0`);
    if (!r || r.status === 'running') return 'Being analysed';
    if (r.status === 'error') return 'Could not be analysed';
    if (this.isWeight) {
      const p = plateEstimateOf(r.weight);
      return p ? `Plates read as ${p} lb, real ${v.actualWeight} lb` : 'The plates could not be read';
    }
    const c = this.checkOf(r);
    if (!c) return 'This check did not apply';
    if (c.result === 'unclear') return 'The AI was unsure';
    return c.result === v.expected ? 'The AI was right' : 'The AI was wrong';
  }
}
