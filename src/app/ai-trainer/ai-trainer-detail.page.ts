import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AiReviewService } from '../ai/ai-review.service';
import { AiReview, AiTrainingVideo, TEST_LABELS, VIDEO_TESTS, VideoTest, actualWeightOf, decisionOf } from '../ai/ai-review.types';
import { GLOBAL_TUNABLES, TUNABLES, Tunable, defaultOf, getOverrides } from '../ai/thresholds';
import { Area, AreaStats, INTEGRITY_CHECKS, LIFTS, STATUS_TEXT, areaTitle, isArea, statsFor } from './ai-trainer.shared';
import { AiSubmissionsComponent } from './ai-submissions.component';
import { Answer, COMPONENT_STATUS, ComponentStats, VIDEO_COMPONENTS, agreement, answerOf, componentStats, componentsOf, feedbackFor, submissionRows } from './ai-trainer.components';
import type { AiCheck } from '../ai/ai-review.types';

// One trainer page for a test, for the weight, or for video integrity. The coach judges what the AI found on real videos,
// tunes how strict it is, and adds videos of their own to teach it directly.
@Component({
  selector: 'app-ai-trainer-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, AiSubmissionsComponent],
  templateUrl: './ai-trainer-detail.page.html',
  styleUrls: ['./ai-trainer.page.scss', './ai-trainer-detail.page.scss', './ai-component.page.scss']
})
export class AiTrainerDetailPage implements OnDestroy {
  area: Area = 'deadlift';
  reviews: AiReview[] = [];
  videos: AiTrainingVideo[] = [];
  values: Record<string, number> = {};
  busy = '';
  message = '';
  showAll = false;
  private subs = new Subscription();
  readonly statusText = STATUS_TEXT;
  readonly componentStatus = COMPONENT_STATUS;
  readonly tests = VIDEO_TESTS;
  readonly labels = TEST_LABELS;

  // The add-a-video form.
  form = { test: 'deadlift' as VideoTest, value: null as number | null, weight: null as number | null, reps: null as number | null,
    height: null as number | null, body: null as number | null, file: null as File | null };

  constructor(private route: ActivatedRoute, private router: Router, private ai: AiReviewService) {
    addIcons({ arrowBack });
    this.ai.start();
    this.subs.add(this.route.paramMap.subscribe(p => {
      const a = p.get('area') ?? '';
      if (!isArea(a)) { this.router.navigateByUrl('/ai-trainer'); return; }
      // The weight and the video checks are components now, each with a page of its own.
      if (a === 'weight') { this.router.navigateByUrl('/ai-trainer/all/weight', { replaceUrl: true }); return; }
      if (a === 'integrity') { this.router.navigateByUrl('/ai-trainer', { replaceUrl: true }); return; }
      this.area = a;
      this.form.test = this.isTest ? (a as VideoTest) : 'deadlift';
      this.loadValues();
    }));
    this.subs.add(this.ai.reviews$.subscribe(r => this.reviews = r));
    this.subs.add(this.ai.trainingVideos$.subscribe(v => this.videos = v));
  }
  ngOnDestroy() { this.subs.unsubscribe(); }

  goBack() { this.router.navigateByUrl('/ai-trainer'); }

  // The checklist: what this test is made of, each with how often the AI gets it right.
  get checklist(): Array<{ id: string; label: string; what: string; link: string; shared: boolean; taught: number; stats: ComponentStats }> {
    if (!this.isTest) return [];
    const test = this.area as VideoTest;
    return componentsOf(test).map(c => {
      const shared = c.id === 'weight' || VIDEO_COMPONENTS.includes(c.id);
      return { id: c.id, label: c.label, what: c.what, shared, taught: this.videos.filter(v => v.component === c.id && (shared || v.test === test)).length, link: `/ai-trainer/${shared ? 'all' : test}/${c.id}`, stats: componentStats(c, this.reviews, shared ? undefined : test) };
    });
  }
  byId = (_: number, c: { id: string }) => c.id;
  openComponent(link: string) { this.router.navigateByUrl(link); }
  get title(): string { return areaTitle(this.area); }
  get isTest(): boolean { return this.area !== 'weight' && this.area !== 'integrity'; }
  get isLiftArea(): boolean { return this.area === 'weight' || (LIFTS as readonly string[]).includes(this.area); }
  get stats(): AreaStats { return statsFor(this.area, this.reviews); }
  get tunables(): Tunable[] {
    return this.area === 'integrity' ? GLOBAL_TUNABLES.filter(t => t.key === 'cut' || t.key === 'duplicate' || t.key === 'handsUp' || t.key === 'upright')
      : this.isTest ? TUNABLES[this.area as VideoTest] : [];
  }
  private get scope(): string { return this.area === 'integrity' ? '*' : this.area; }

  private loadValues() {
    const o = getOverrides()[this.scope] ?? {};
    this.values = {};
    for (const t of this.tunables) this.values[t.key] = o[t.key] ?? t.value;
  }
  get dirty(): boolean { return this.tunables.some(t => this.values[t.key] !== (getOverrides()[this.scope]?.[t.key] ?? t.value)); }
  get tuned(): boolean { return this.tunables.some(t => this.values[t.key] !== t.value); }
  resetValues() { for (const t of this.tunables) this.values[t.key] = t.value; }

  async saveValues() {
    const out: Record<string, number> = {};
    for (const t of this.tunables) if (this.values[t.key] !== defaultOf(this.scope as any, t.key)) out[t.key] = Number(this.values[t.key]);
    this.busy = 'save';
    try {
      await this.ai.saveThresholds(this.scope, out);
      this.message = 'Settings saved. Analyse the videos again to apply them.';
    } catch { this.message = 'Settings could not be saved.'; }
    this.busy = '';
  }
  async rerunAll() {
    this.busy = 'rerun';
    const n = await this.ai.rerunTest(this.area === 'weight' || this.area === 'integrity' ? 'all' : this.area);
    this.message = `${n} video${n === 1 ? '' : 's'} queued to be analysed again.`;
    this.busy = '';
  }

  // Every video of this test, the athletes' and the ones you added, newest first.
  get rows() { return submissionRows(this.reviews, this.videos, r => r.test === this.area); }

  // The videos to judge, the AI's least sure and the unjudged first: those teach it most.
  get examples(): AiReview[] {
    let list = this.reviews.filter(r => r.status === 'done');
    if (this.area === 'weight') list = list.filter(r => (LIFTS as readonly string[]).includes(r.test) && r.weight);
    else if (this.area === 'integrity') list = list.filter(r => (r.checks ?? []).some(c => INTEGRITY_CHECKS.includes(c.id) && c.result !== 'pass'));
    else list = list.filter(r => r.test === this.area);
    const need = (r: AiReview) => this.area === 'weight' ? (actualWeightOf(r) ? 1 : 0) : this.area === 'integrity' ? (this.judgedIntegrity(r) ? 1 : 0) : (decisionOf(r) ? 1 : 0);
    const unsure = (r: AiReview) => Math.abs((r.confidence ?? 0.5) - 0.5);
    list = [...list].sort((a, b) => need(a) - need(b) || unsure(a) - unsure(b) || (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? ''));
    return this.showAll ? list : list.slice(0, 12);
  }
  get total(): number {
    return this.reviews.filter(r => r.status === 'done' && (this.area === 'weight' ? (LIFTS as readonly string[]).includes(r.test) && r.weight
      : this.area === 'integrity' ? (r.checks ?? []).some(c => INTEGRITY_CHECKS.includes(c.id) && c.result !== 'pass') : r.test === this.area)).length;
  }
  private judgedIntegrity(r: AiReview): boolean { return Object.keys(r.trainer?.checks ?? {}).some(k => INTEGRITY_CHECKS.includes(k)); }

  checksOf(r: AiReview) {
    const all = r.checks ?? [];
    if (this.area === 'integrity') return all.filter(c => INTEGRITY_CHECKS.includes(c.id));
    return all;
  }
  // The AI's result beside what you say it should have been, for every item on the checklist.
  answer(r: AiReview, c: AiCheck): Answer | undefined { return answerOf(r, c); }
  agrees(r: AiReview, c: AiCheck) { return agreement(r, c); }
  setAnswer(r: AiReview, c: AiCheck, a: Answer) { this.ai.saveTrainer(r.id!, feedbackFor(c, a)).catch(() => this.message = 'That could not be saved.'); }
  mark(r: AiReview, id: string): 'right' | 'wrong' | undefined { return r.trainer?.checks?.[id]; }
  setCheck(r: AiReview, id: string, v: 'right' | 'wrong') { this.ai.saveTrainer(r.id!, { checks: { [id]: v } }).catch(() => this.message = 'That could not be saved.'); }
  setLabel(r: AiReview, l: 'valid' | 'invalid') { this.ai.saveTrainer(r.id!, { label: r.trainer?.label === l ? null : l }).catch(() => this.message = 'That could not be saved.'); }
  setActual(r: AiReview, v: string) {
    const n = parseFloat(v);
    this.ai.saveTrainer(r.id!, { actualWeight: isFinite(n) && n > 0 ? n : null }).catch(() => this.message = 'That could not be saved.');
  }
  actual(r: AiReview): number | string { return actualWeightOf(r) ?? ''; }
  decision(r: AiReview) { return decisionOf(r); }
  verdictText(r: AiReview): string { return r.verdict === 'likely-valid' ? 'Likely valid' : r.verdict === 'likely-invalid' ? 'Likely invalid' : 'Needs review'; }
  isLift(r: AiReview): boolean { return (LIFTS as readonly string[]).includes(r.test); }
  when(r: AiReview): string { return r.id?.startsWith('tv_') ? 'Training video' : r.clientName; }

  // Training videos for this area.
  get mine(): AiTrainingVideo[] { return this.videos.filter(v => this.isTest ? v.test === this.area : this.area === 'weight' ? (LIFTS as readonly string[]).includes(v.test) : true); }
  pick(e: Event) { this.form.file = (e.target as HTMLInputElement).files?.[0] ?? null; }
  get formLift(): boolean { return (LIFTS as readonly string[]).includes(this.form.test); }
  async add() {
    if (!this.form.file || this.busy) return;
    this.busy = 'add';
    try {
      await this.ai.addTrainingVideo(this.form.file, {
        test: this.form.test,
        claimed: { value: Number(this.form.value) || 0, weight: this.formLift ? (Number(this.form.weight) || null) : null, reps: Number(this.form.reps) || null },
        heightIn: this.form.height || null, bodyWeightLb: this.form.body || null
      }, this.form.file.name);
      this.message = 'The video was added. It is analysed shortly, then it appears in the list below.';
      this.form.file = null; this.form.value = null; this.form.weight = null; this.form.reps = null;
    } catch (err: any) { this.message = `The video could not be uploaded${err?.code ? ' (' + err.code + ')' : ''}. ${err?.message ?? ''}`.trim(); }
    this.busy = '';
  }
  async remove(v: AiTrainingVideo) {
    if (!v.id || !confirm('Remove this training video?')) return;
    await this.ai.deleteTrainingVideo(v.id).catch(() => this.message = 'It could not be removed.');
  }
  trackId = (_: number, r: AiReview) => r.id;
}
