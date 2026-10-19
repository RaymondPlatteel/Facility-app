import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { AiReviewService, ReviewerState } from '../ai/ai-review.service';
import { AiModel, AiReview, TEST_LABELS, VIDEO_TESTS, VideoTest } from '../ai/ai-review.types';
import { AiPanelComponent } from '../ai/ai-panel.component';

interface TestRow { test: VideoTest; label: string; reviews: number; decided: number; agree: number; valid: number; review: number; invalid: number }

// The AI reviewer at a glance: whether it is working and on what, how much it has learned from the coach's decisions,
// how often it agrees with the coach for each test, and every review it has made.
@Component({
  selector: 'app-ai-review',
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon, AiPanelComponent],
  templateUrl: './ai-review.page.html',
  styleUrls: ['./ai-review.page.scss']
})
export class AiReviewPage implements OnDestroy {
  state: ReviewerState | null = null;
  reviews: AiReview[] = [];
  model: AiModel | null = null;
  open: string | null = null;
  training = false;
  private subs = new Subscription();

  constructor(public ai: AiReviewService, private router: Router) {
    addIcons({ arrowBack });
    this.ai.start();
    this.subs.add(this.ai.state$.subscribe(s => this.state = s));
    this.subs.add(this.ai.reviews$.subscribe(r => this.reviews = [...r].sort((a, b) => (b.analyzedAt || b.startedAt || '').localeCompare(a.analyzedAt || a.startedAt || ''))));
    this.subs.add(this.ai.model$.subscribe(m => this.model = m));
  }

  ngOnDestroy() { this.subs.unsubscribe(); }

  goBack() { this.router.navigateByUrl('/home'); }

  label(t: string): string { return TEST_LABELS[t as VideoTest] ?? t; }

  private agrees(r: AiReview): boolean {
    return (r.verdict === 'likely-invalid') === (r.coachDecision === 'rejected');
  }

  get done(): AiReview[] { return this.reviews.filter(r => r.status === 'done'); }
  get decided(): AiReview[] { return this.done.filter(r => !!r.coachDecision); }
  get agreement(): number | null { const d = this.decided; return d.length ? d.filter(r => this.agrees(r)).length / d.length : null; }
  // How the clear-cut calls went: of the videos it called likely valid, how many the coach approved, and so on.
  get validPrecision(): string {
    const v = this.decided.filter(r => r.verdict === 'likely-valid');
    return v.length ? `${v.filter(r => r.coachDecision === 'approved').length} of ${v.length}` : '—';
  }
  get invalidPrecision(): string {
    const v = this.decided.filter(r => r.verdict === 'likely-invalid');
    return v.length ? `${v.filter(r => r.coachDecision === 'rejected').length} of ${v.length}` : '—';
  }

  get rows(): TestRow[] {
    return VIDEO_TESTS.map(test => {
      const list = this.done.filter(r => r.test === test);
      const dec = list.filter(r => !!r.coachDecision);
      return {
        test, label: TEST_LABELS[test], reviews: list.length, decided: dec.length,
        agree: dec.length ? Math.round((dec.filter(r => this.agrees(r)).length / dec.length) * 100) : -1,
        valid: list.filter(r => r.verdict === 'likely-valid').length,
        review: list.filter(r => r.verdict === 'needs-review').length,
        invalid: list.filter(r => r.verdict === 'likely-invalid').length
      };
    }).filter(r => r.reviews > 0);
  }

  get errors(): number { return this.reviews.filter(r => r.status === 'error').length; }

  verdictText(r: AiReview): string {
    if (r.status === 'running') return 'Analyzing';
    if (r.status === 'error') return 'Could not read';
    return r.verdict === 'likely-valid' ? 'Likely valid' : r.verdict === 'likely-invalid' ? 'Likely invalid' : 'Needs review';
  }

  toggle(r: AiReview) { this.open = this.open === r.id ? null : (r.id ?? null); }

  async retrain() {
    this.training = true;
    try { await this.ai.retrain(); } finally { this.training = false; }
  }
}
