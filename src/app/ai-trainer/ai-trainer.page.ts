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
import { COMPONENTS, COMPONENT_STATUS, ComponentStats, VIDEO_COMPONENTS, componentStats, componentsOf } from './ai-trainer.components';

interface Card { area: Area | 'split' | 'program' | 'review'; title: string; blurb: string; link: string; stats: AreaStats | null }

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

  constructor(private ai: AiReviewService, public router: Router) {
    addIcons({ arrowBack, chevronForwardOutline });
    this.ai.start();
    this.subs.add(this.ai.state$.subscribe(s => this.state = s));
    this.subs.add(this.ai.reviews$.subscribe(r => this.reviews = r));
  }
  ngOnDestroy() { this.subs.unsubscribe(); }

  // The lists are rebuilt on every update, so the cards are matched by what they are. Without this the button under a press
  // is replaced before the release and the tap is lost.
  byArea = (_: number, c: { area: string }) => c.area;
  byId = (_: number, c: { id: string }) => c.id;

  goBack() { this.router.navigateByUrl('/home'); }
  open(c: Card) { this.router.navigateByUrl(c.link); }

  get tests(): Card[] {
    return VIDEO_TESTS.map(t => ({ area: t, title: TEST_LABELS[t], blurb: this.blurbOf(t), link: `/ai-trainer/${t}`, stats: statsFor(t, this.reviews) }));
  }
  // The components every test shares: the weight on the bar, and the checks of the video itself. Each is trained once, on the
  // videos of every test that has it.
  get shared(): Array<{ id: string; title: string; blurb: string; link: string; stats: ComponentStats }> {
    return ['weight', ...VIDEO_COMPONENTS].map(id => {
      const c = COMPONENTS.find(x => x.id === id)!;
      return { id, title: c.label, blurb: c.what, link: `/ai-trainer/all/${id}`, stats: componentStats(c, this.reviews) };
    });
  }
  readonly componentStatus = COMPONENT_STATUS;
  checklist(t: string) { return componentsOf(t as any); }
  readonly others: Card[] = [
    { area: 'review', title: 'AI Review', blurb: 'The reviewer itself: switch it on or off, see what it is analysing and the models it has learned.', link: '/ai-review', stats: null },
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
