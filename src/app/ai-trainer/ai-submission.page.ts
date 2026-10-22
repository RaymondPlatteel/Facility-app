import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AiReviewService } from '../ai/ai-review.service';
import { AiCheck, AiReview, TEST_LABELS } from '../ai/ai-review.types';
import { AiAccuracy, Answer, accuracyOf, agreement, answerOf, checklistOf, componentById, feedbackFor } from './ai-trainer.components';

// One video, side by side. The video on top; under it, on the left the checklist the AI filled out and what it saw, on the
// right the same checklist for you to fill out and write what you see. Every row of yours is kept and the AI learns from it.
@Component({
  selector: 'app-ai-submission',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './ai-submission.page.html',
  styleUrls: ['./ai-trainer.page.scss', './ai-trainer-detail.page.scss', './ai-component.page.scss', './ai-submission.page.scss']
})
export class AiSubmissionPage implements OnDestroy {
  id = '';
  r: AiReview | null = null;
  loaded = false;
  message = '';
  readonly labels = TEST_LABELS;
  private subs = new Subscription();

  constructor(private route: ActivatedRoute, private router: Router, private ai: AiReviewService) {
    addIcons({ arrowBack });
    this.ai.start();
    this.subs.add(this.route.paramMap.subscribe(p => { this.id = decodeURIComponent(p.get('id') ?? ''); this.pick(); }));
    this.subs.add(this.ai.reviews$.subscribe(list => { this.all = list; this.pick(); }));
  }
  private all: AiReview[] = [];
  // While the AI analyses a video again its record is empty for a while. The checklist stays as it was, with your answers
  // kept up to date, and is replaced when the new result arrives.
  running = false;
  private pick() {
    const found = this.all.find(x => x.id === this.id) ?? null;
    this.loaded = this.all.length > 0;
    if (!found) return;
    this.running = found.status === 'running';
    if (found.checks?.length || !this.r || this.r.id !== found.id) this.r = found;
    else this.r = { ...this.r, status: found.status, error: found.error, trainer: found.trainer, coachLabels: found.coachLabels, coachDecision: found.coachDecision };
  }
  ngOnDestroy() { this.subs.unsubscribe(); }

  goBack() { this.router.navigateByUrl(this.r ? `/ai-trainer/${this.r.test}` : '/ai-trainer'); }
  get isTraining(): boolean { return this.id.startsWith('tv_'); }
  get title(): string { return this.r ? (this.isTraining ? 'Training video' : this.r.clientName) : 'Review'; }
  get isLift(): boolean { return !!this.r && ['deadlift', 'squat', 'bench'].includes(this.r.test); }

  // The checklist, weight first. What the AI knows only from the athlete's history is left off: it cannot be judged from the video.
  get checks(): AiCheck[] {
    return this.r ? [...checklistOf(this.r)].sort((a, b) => Number(b.id === 'weight') - Number(a.id === 'weight')) : [];
  }
  answer(c: AiCheck): Answer | undefined { return this.r ? answerOf(this.r, c) : undefined; }
  agrees(c: AiCheck) { return this.r ? agreement(this.r, c) : undefined; }
  // The number to give for this item, when it measures one (the weight has its own box).
  measure(c: AiCheck) { return c.id === 'weight' ? undefined : componentById(c.id)?.measure; }
  value(c: AiCheck): number | string { return this.r?.trainer?.values?.[c.id] ?? ''; }
  get answered(): number { return this.checks.filter(c => this.answer(c)).length; }
  get realWeight(): number | string { return this.r?.trainer?.actualWeight ?? this.r?.coachLabels?.actualWeight ?? ''; }

  private fail = () => { this.message = 'That could not be saved.'; };
  setAnswer(c: AiCheck, a: Answer) { if (this.r) this.ai.saveTrainer(this.r.id!, feedbackFor(c, a)).catch(this.fail); }
  setValue(c: AiCheck, v: string) {
    const n = parseFloat(v);
    if (this.r && isFinite(n) && n >= 0) this.ai.saveTrainer(this.r.id!, { values: { [c.id]: n } }).catch(this.fail);
  }
  setActual(v: string) {
    const n = parseFloat(v);
    if (this.r) this.ai.saveTrainer(this.r.id!, { actualWeight: isFinite(n) && n > 0 ? n : null }).catch(this.fail);
  }
  setLabel(l: 'valid' | 'invalid') { if (this.r) this.ai.saveTrainer(this.r.id!, { label: this.r.trainer?.label === l ? null : l }).catch(this.fail); }
  // ---- Complete ----
  completing = false;
  get completed(): boolean { return !!this.r?.trainer?.completedAt; }
  get allAnswered(): boolean { return this.checks.length > 0 && this.answered === this.checks.length; }
  // How the AI did on this video, and on every video of this test that has been completed.
  get thisVideo(): AiAccuracy { return accuracyOf(this.r ? [this.r] : []); }
  get testWide(): AiAccuracy { return accuracyOf(this.all.filter(x => this.r && x.test === this.r.test && !!x.trainer?.completedAt)); }
  get testVideos(): number { return this.all.filter(x => this.r && x.test === this.r.test && !!x.trainer?.completedAt).length; }
  async complete() {
    if (!this.r || this.completing) return;
    this.completing = true;
    try { await this.ai.completeReview(this.r.id!); } catch { this.message = 'That could not be completed. Try again.'; }
    this.completing = false;
  }
  async reopen() { if (this.r) await this.ai.saveTrainer(this.r.id!, { completedAt: null }).catch(this.fail); }

  verdictText(): string { const v = this.r?.verdict; return v === 'likely-valid' ? 'Likely valid' : v === 'likely-invalid' ? 'Likely invalid' : 'Needs review'; }
  glyph(res: string): string { return res === 'pass' ? '✓' : res === 'fail' ? '✕' : '?'; }
  resText(res: string): string { return res === 'pass' ? 'Pass' : res === 'fail' ? 'Fail' : 'Unsure'; }
}
