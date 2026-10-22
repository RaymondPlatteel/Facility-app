import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { TEST_LABELS } from '../ai/ai-review.types';
import { SubmissionRow } from './ai-trainer.components';

// The list of submissions: each row opens the side-by-side review of that video.
@Component({
  selector: 'app-ai-submissions',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="sub-empty" *ngIf="!rows.length">No videos yet. Athletes' submissions appear here as they are analysed, or add one above.</div>
    <button type="button" class="sub-row" *ngFor="let r of rows; trackBy: byRow" [disabled]="!r.id" (click)="open(r)">
      <span class="sub-thumb"><img *ngIf="r.thumb" [src]="r.thumb" alt=""></span>
      <span class="sub-main">
        <b>{{ r.name }}</b>
        <small>{{ labels[r.test] }} · {{ r.source }} · {{ r.date | date:'MMM d, y' }}</small>
        <small *ngIf="r.weight">AI estimated {{ r.weight.estimate ?? '—' }}<ng-container *ngIf="r.weight.estimate"> lb</ng-container> · real weight {{ r.weight.real ?? 'not entered' }}<ng-container *ngIf="r.weight.real"> lb</ng-container></small>
      </span>
      <span class="sub-state">
        <span class="verdict" *ngIf="r.status === 'done'" [class]="r.verdict">{{ r.verdict === 'likely-valid' ? 'Likely valid' : r.verdict === 'likely-invalid' ? 'Likely invalid' : 'Needs review' }}</span>
        <span class="sub-note" *ngIf="r.status === 'running' || r.status === 'waiting'">Being analysed</span>
        <span class="sub-note" *ngIf="r.status === 'error'">Could not be analysed</span>
        <small *ngIf="r.status === 'done'" [class.complete]="r.completed">{{ r.completed ? 'Complete' : r.judged + '/' + r.total + ' judged' }}</small>
      </span>
    </button>
  `,
  styles: [`
    :host { display: block; }
    .sub-empty { font-size: 12.5px; color: var(--hud-text-mute, #79899a); }
    .sub-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px; margin-top: 8px; border-radius: 12px; border: 1px solid var(--hud-border, #2a3340);
      background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
      &:hover:not(:disabled) { border-color: var(--hud-accent, #00d4ff); } &:disabled { cursor: default; opacity: .7; } }
    .sub-thumb { flex: none; width: 76px; height: 54px; border-radius: 8px; overflow: hidden; background: #000; img { width: 100%; height: 100%; object-fit: cover; } }
    .sub-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; b { font-size: 14px; color: var(--hud-text, #fff); } small { font-size: 12px; color: var(--hud-text-mute, #79899a); } }
    .sub-state { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; font-size: 12px; color: var(--hud-text-mute, #79899a);
      .verdict { font-weight: 700; &.likely-valid { color: #2dd36f; } &.likely-invalid { color: #ff5a6a; } &.needs-review { color: #f5b942; } } .complete { color: #2dd36f; } }
    .sub-note { font-size: 12px; }
  `]
})
export class AiSubmissionsComponent {
  @Input() rows: SubmissionRow[] = [];
  readonly labels = TEST_LABELS;
  constructor(private router: Router) {}
  byRow = (_: number, r: SubmissionRow) => r.id ?? `${r.name}|${r.date}`;
  open(r: SubmissionRow) { if (r.id) this.router.navigateByUrl(`/ai-trainer/review/${encodeURIComponent(r.id)}`); }
}
