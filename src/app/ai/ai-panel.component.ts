import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AiReview } from './ai-review.types';
import { AiReviewService } from './ai-review.service';

// What the AI reviewer found in one video, under the video on the Pending page. It is advice only: the coach still
// approves or rejects, and that decision is what the reviewer learns from.
@Component({
  selector: 'app-ai-panel',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="ai" [class.valid]="review?.verdict === 'likely-valid'" [class.invalid]="review?.verdict === 'likely-invalid'">
      <div class="ai-head">
        <span class="ai-tag">AI Review</span>
        <ng-container [ngSwitch]="review?.status">
          <span *ngSwitchCase="'done'" class="ai-verdict">{{ verdictText }}</span>
          <span *ngSwitchCase="'running'" class="ai-muted">Analyzing the video…</span>
          <span *ngSwitchCase="'error'" class="ai-muted">Could not read this video.</span>
          <span *ngSwitchDefault class="ai-muted">Waiting in the queue.</span>
        </ng-container>
        <span class="ai-conf" *ngIf="review?.status === 'done'">
          {{ (review!.confidence ?? 0) * 100 | number:'1.0-0' }}% confidence<ng-container *ngIf="review!.learnedScore !== null && review!.learnedScore !== undefined"> · model {{ review!.learnedScore! * 100 | number:'1.0-0' }}% approve</ng-container>
        </span>
      </div>

      <div class="ai-error" *ngIf="review?.status === 'error'">{{ review?.error }}</div>

      <ng-container *ngIf="review?.status === 'done'">
        <ul class="ai-checks">
          <li *ngFor="let c of review!.checks" [class]="c.result">
            <span class="ai-mark">{{ c.result === 'pass' ? '✓' : c.result === 'fail' ? '✕' : '?' }}</span>
            <span class="ai-check-text"><b>{{ c.label }}</b> {{ c.detail }}</span>
          </li>
        </ul>

        <div class="ai-est" *ngIf="estimateRows.length">
          <div *ngFor="let e of estimateRows"><span>{{ e.k }}</span><b>{{ e.v }}</b></div>
        </div>

        <div class="ai-thumbs" *ngIf="review!.thumbs?.length">
          <span class="ai-sub">Start, middle and end of the video: check the plates and the setting.</span>
          <div class="ai-thumb-row"><img *ngFor="let t of review!.thumbs" [src]="t" alt=""></div>
        </div>

        <div class="ai-label" *ngIf="isLift">
          <span class="ai-sub">The weight on the bar</span>
          <button type="button" [class.on]="review!.coachLabels?.weight === 'ok'" (click)="label('ok')">Looks right</button>
          <button type="button" [class.on]="review!.coachLabels?.weight === 'doubtful'" (click)="label('doubtful')">Doubtful</button>
        </div>
      </ng-container>

      <button type="button" class="ai-rerun" *ngIf="review && review.status !== 'running'" (click)="rerun()">Analyze again</button>
    </div>
  `,
  styles: [`
    .ai { margin: 8px 0 14px; padding: 12px 14px; border-radius: 12px; border: 1px solid var(--hud-border, #2a3340);
      background: color-mix(in srgb, var(--hud-text, #fff) 3%, transparent); font-size: 13px; color: var(--hud-text-dim, #9fb0bd); }
    .ai.valid { border-color: color-mix(in srgb, #2dd36f 55%, transparent); }
    .ai.invalid { border-color: color-mix(in srgb, #ff5a6a 60%, transparent); }
    .ai-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
    .ai-tag { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--hud-text-mute, #79899a); }
    .ai-verdict { font-weight: 700; color: var(--hud-text, #fff); font-size: 14px; }
    .ai.valid .ai-verdict { color: #2dd36f; }
    .ai.invalid .ai-verdict { color: #ff5a6a; }
    .ai-conf, .ai-muted { color: var(--hud-text-mute, #79899a); }
    .ai-error { margin-top: 6px; color: #ff8a95; }
    .ai-checks { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 5px; }
    .ai-checks li { display: flex; gap: 8px; line-height: 1.35; }
    .ai-mark { flex: 0 0 16px; font-weight: 800; text-align: center; }
    .ai-checks li.pass .ai-mark { color: #2dd36f; }
    .ai-checks li.fail .ai-mark { color: #ff5a6a; }
    .ai-checks li.unclear .ai-mark { color: #f5b942; }
    .ai-check-text b { color: var(--hud-text, #fff); font-weight: 600; margin-right: 4px; }
    .ai-est { margin-top: 10px; display: grid; gap: 3px; }
    .ai-est div { display: flex; justify-content: space-between; gap: 10px; }
    .ai-est b { color: var(--hud-text, #fff); font-weight: 600; text-align: right; }
    .ai-sub { display: block; margin: 10px 0 6px; font-size: 11px; color: var(--hud-text-mute, #79899a); }
    .ai-thumb-row { display: flex; gap: 6px; }
    .ai-thumb-row img { width: calc(33.3% - 4px); border-radius: 6px; object-fit: cover; }
    .ai-label { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .ai-label .ai-sub { flex-basis: 100%; margin-bottom: 2px; }
    .ai-label button, .ai-rerun { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--hud-border, #2a3340); background: transparent;
      color: var(--hud-text-dim, #9fb0bd); font: inherit; font-size: 12px; cursor: pointer; }
    .ai-label button.on { border-color: var(--hud-accent, #00d4ff); color: var(--hud-accent, #00d4ff); }
    .ai-rerun { margin-top: 10px; }
  `]
})
export class AiPanelComponent {
  @Input() review: AiReview | undefined;

  constructor(private ai: AiReviewService) {}

  get verdictText(): string {
    const v = this.review?.verdict;
    return v === 'likely-valid' ? 'Likely valid' : v === 'likely-invalid' ? 'Likely invalid' : 'Needs your review';
  }

  get isLift(): boolean { return ['deadlift', 'squat', 'bench'].includes(this.review?.test ?? ''); }

  get estimateRows(): Array<{ k: string; v: string }> {
    return Object.entries(this.review?.estimates ?? {}).map(([k, v]) => ({ k, v: String(v) }));
  }

  label(l: 'ok' | 'doubtful') { if (this.review?.id) this.ai.labelWeight(this.review.id, l).catch(() => {}); }
  rerun() { if (this.review?.id) this.ai.rerun(this.review.id); }
}
