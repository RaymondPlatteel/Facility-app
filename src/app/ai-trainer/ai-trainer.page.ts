import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, chevronForwardOutline } from 'ionicons/icons';
import { AiReviewService, ReviewerState } from '../ai/ai-review.service';
import { AiReview, TEST_LABELS, VIDEO_TESTS } from '../ai/ai-review.types';
import { Area, AreaStats, STATUS_TEXT, areaTitle, statsFor } from './ai-trainer.shared';

interface Card { area: Area | 'split' | 'program'; title: string; blurb: string; link: string; stats: AreaStats | null }

// Every trainer in one place. Each video test has its own: the coach teaches it by judging its checks on real videos,
// tuning what it demands, and adding videos of their own. Weight and video integrity have theirs, and the middle split and
// program trainers sit alongside.
@Component({
  selector: 'app-ai-trainer',
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon],
  templateUrl: './ai-trainer.page.html',
  styleUrls: ['./ai-trainer.page.scss']
})
export class AiTrainerPage implements OnDestroy {
  state: ReviewerState | null = null;
  reviews: AiReview[] = [];
  private subs = new Subscription();
  readonly statusText = STATUS_TEXT;

  constructor(private ai: AiReviewService, private router: Router) {
    addIcons({ arrowBack, chevronForwardOutline });
    this.ai.start();
    this.subs.add(this.ai.state$.subscribe(s => this.state = s));
    this.subs.add(this.ai.reviews$.subscribe(r => this.reviews = r));
  }
  ngOnDestroy() { this.subs.unsubscribe(); }

  goBack() { this.router.navigateByUrl('/home'); }
  open(c: Card) { this.router.navigateByUrl(c.link); }

  get tests(): Card[] {
    return VIDEO_TESTS.map(t => ({ area: t, title: TEST_LABELS[t], blurb: this.blurbOf(t), link: `/ai-trainer/${t}`, stats: statsFor(t, this.reviews) }));
  }
  get special(): Card[] {
    return [
      { area: 'weight', title: 'Weight on the Bar', blurb: 'Learns the weight from the video. Enter what was really on the bar and it gets better at estimating.', link: '/ai-trainer/weight', stats: statsFor('weight', this.reviews) },
      { area: 'integrity', title: 'Video Integrity', blurb: 'Catches cut and edited videos, footage sent twice, and the wrong exercise. Tell it which flags were right.', link: '/ai-trainer/integrity', stats: statsFor('integrity', this.reviews) }
    ];
  }
  readonly others: Card[] = [
    { area: 'split', title: 'Middle Split', blurb: 'Teaches detection where the hip and ankles are on a photo.', link: '/split-training', stats: null },
    { area: 'program', title: 'Programs', blurb: 'Teaches the program builder by correcting the weeks it writes.', link: '/program-trainer', stats: null }
  ];

  private blurbOf(t: string): string {
    return ({
      deadlift: 'Reps, lockout, start from the floor, bar speed.', squat: 'Reps, depth, standing at the top, bar speed.',
      bench: 'Reps, bar to the chest, lockout, hips on the bench.', longjump: 'Take-off, landing, two feet, measured distance.',
      sprint: 'Video length against the time, running seen.', pushups: 'Reps, elbow bend, lockout, straight body.',
      pullups: 'Reps, full hang, chin over the bar, no kipping.', run400: 'Video length against the time, running seen.',
      pike: 'The hold and how far the reach goes.', backbend: 'The hold and how far the backbend goes.'
    } as Record<string, string>)[t] ?? '';
  }

  title(a: Area): string { return areaTitle(a); }
  get taughtTotal(): number { return this.tests.reduce((s, c) => s + (c.stats?.taught ?? 0), 0); }
  get attentionTotal(): number { return this.tests.reduce((s, c) => s + (c.stats?.attention ?? 0), 0); }
}
