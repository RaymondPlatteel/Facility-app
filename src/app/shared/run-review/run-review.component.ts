import { Component, Input, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RunSeries, RunSummary, clock, distAt } from '../../services/run-import.util';
import { RunCheckResult, checkRun, readRunFile } from '../../services/run-check.util';

// The coach's view of a 30-Minute Run. The original file is downloaded and checked here (run-check.util): a pass or
// fail verdict with each check, then the metrics, pace and heart rate minute by minute, the route and the splits.
@Component({
  selector: 'app-run-review',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="rr">
      <div class="rr-verdict loading" *ngIf="checking">Checking the run file…</div>
      <div class="rr-verdict fail" *ngIf="!checking && error">
        <strong>Auto Check: Not Run</strong><span>{{ error }}</span>
      </div>
      <div class="rr-verdict" *ngIf="result as r" [class.pass]="r.verdict === 'pass'" [class.fail]="r.verdict === 'fail'">
        <strong>Auto Check: {{ r.verdict === 'pass' ? 'Pass' : 'Fail' }}</strong>
        <span>{{ verdictLine(r) }}</span>
      </div>

      <div class="rr-head">
        <span class="rr-km">{{ shown.km.toFixed(2) }} km</span>
        <span class="rr-sub">Fastest 30:00, from {{ clock(shown.windowStart) }} to {{ clock(shown.windowStart + 1800) }} of a {{ clock(shown.totalSec) }} run</span>
      </div>

      <div class="rr-metrics" *ngIf="result as r">
        <div class="rr-metric"><span>Avg Pace</span><b>{{ clock(r.metrics.paceSecPerKm) }} /km</b></div>
        <div class="rr-metric"><span>Avg HR</span><b>{{ r.metrics.hrAvg ?? '—' }}<small *ngIf="r.metrics.hrAvg"> bpm</small></b></div>
        <div class="rr-metric"><span>Max HR</span><b>{{ r.metrics.hrMax ?? '—' }}<small *ngIf="r.metrics.hrMax"> bpm</small></b></div>
        <div class="rr-metric"><span>Min HR</span><b>{{ r.metrics.hrMin ?? '—' }}<small *ngIf="r.metrics.hrMin"> bpm</small></b></div>
        <div class="rr-metric"><span>Cadence</span><b>{{ r.metrics.cadenceAvg ?? '—' }}<small *ngIf="r.metrics.cadenceAvg"> spm</small></b></div>
        <div class="rr-metric"><span>Climb</span><b>{{ r.metrics.climbM ?? '—' }}<small *ngIf="r.metrics.climbM != null"> m</small></b></div>
        <div class="rr-metric"><span>GPS Distance</span><b>{{ r.metrics.gpsKm != null ? r.metrics.gpsKm.toFixed(2) : '—' }}<small *ngIf="r.metrics.gpsKm != null"> km</small></b></div>
        <div class="rr-metric"><span>Whole Run</span><b>{{ r.metrics.totalKm.toFixed(2) }}<small> km</small></b></div>
      </div>

      <ng-container *ngIf="result as r">
        <div class="rr-charts" (mousemove)="hover($event)" (touchmove)="hover($event)" (mouseleave)="hoverF = null">
          <div class="rr-chart" *ngFor="let c of detail">
            <div class="rr-chart-head">
              <span>{{ c.label }}</span>
              <span>{{ hoverF != null ? valueAt(c) : c.range }}</span>
            </div>
            <svg viewBox="0 0 600 120" preserveAspectRatio="none">
              <line *ngFor="let g of [20, 60, 100]" x1="0" x2="600" [attr.y1]="g" [attr.y2]="g" class="grid" />
              <path [attr.d]="c.path" [style.stroke]="c.color" />
              <line *ngIf="hoverF != null" class="cursor" [attr.x1]="hoverF * 600" [attr.x2]="hoverF * 600" y1="0" y2="120" />
            </svg>
          </div>
          <div class="rr-axis"><span *ngFor="let t of ticks">{{ t }}<ng-container *ngIf="t !== 0"> min</ng-container></span></div>
          <div class="rr-hover" *ngIf="hoverF != null">{{ clock(hoverF * 1800) }}</div>
        </div>
      </ng-container>

      <svg *ngIf="routePath" class="rr-route" viewBox="0 0 400 220" preserveAspectRatio="xMidYMid meet">
        <path [attr.d]="routePath" />
        <circle *ngIf="ends as e" class="rr-start" [attr.cx]="e.start[0]" [attr.cy]="e.start[1]" r="5" />
        <circle *ngIf="ends as e" class="rr-end" [attr.cx]="e.end[0]" [attr.cy]="e.end[1]" r="5" />
      </svg>

      <div class="rr-grid">
        <div class="rr-split" *ngFor="let m of shown.splits; let i = index">
          <span class="rr-split-t">{{ i * 5 }}–{{ (i + 1) * 5 }} min</span>
          <span class="rr-split-m">{{ m }} m</span>
          <span class="rr-split-p">{{ pace(m) }} /km</span>
        </div>
      </div>

      <div class="rr-checks" *ngIf="result as r">
        <div class="rr-check" *ngFor="let c of r.checks" [attr.data-s]="c.status">
          <span class="rr-dot"></span>
          <span class="rr-check-text"><b>{{ c.label }}</b>{{ c.detail }}</span>
        </div>
      </div>
      <!-- Without the file, the warnings worked out on the athlete's phone are all there is. -->
      <ng-container *ngIf="!checking && error">
        <div class="rr-warn" *ngFor="let f of run.flags">{{ f }}</div>
      </ng-container>

      <div class="rr-meta">
        <span>{{ shown.startedAt | date: 'EEE, MMM d, y · h:mm a' }}</span>
        <span>{{ shown.device }} · {{ shown.source === 'fit' ? '.fit file' : shown.source === 'gpx' ? '.gpx file' : 'Apple Health' }}</span>
        <a *ngIf="fileUrl" [href]="fileUrl" target="_blank" rel="noopener">Download {{ shown.source === 'fit' ? '.fit File' : shown.source === 'gpx' ? '.gpx File' : 'Run Data' }}</a>
      </div>
    </div>
  `,
  styles: [`
    .rr { margin-top: 6px; padding: 14px; border-radius: 10px; border: 1px solid var(--hud-border, rgba(255,255,255,0.15)); }
    .rr-verdict { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; padding: 10px 12px; border-radius: 8px; font-size: 13px;
                  background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: #b6c8d6; }
    .rr-verdict strong { font-size: 15px; letter-spacing: 0.04em; }
    .rr-verdict.pass { background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.5); }
    .rr-verdict.pass strong { color: #4ade80; }
    .rr-verdict.fail { background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.5); }
    .rr-verdict.fail strong { color: #f87171; }
    .rr-head { display: flex; flex-direction: column; gap: 2px; }
    .rr-km { font-size: 26px; font-weight: 700; color: var(--hud-accent, #00d4ff); font-variant-numeric: tabular-nums; }
    .rr-sub { font-size: 13px; color: #8aa0b4; }
    .rr-metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 8px; margin-top: 12px; }
    .rr-metric { display: flex; flex-direction: column; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.04); }
    .rr-metric span { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #8aa0b4; }
    .rr-metric b { font-size: 17px; font-variant-numeric: tabular-nums; }
    .rr-metric small { font-size: 12px; font-weight: 400; color: #8aa0b4; }
    .rr-chart { margin-top: 12px; }
    .rr-chart-head { display: flex; justify-content: space-between; font-size: 12px; color: #8aa0b4; margin-bottom: 4px; }
    .rr-chart svg { display: block; width: 100%; height: 120px; border-radius: 6px; background: rgba(255,255,255,0.03); }
    .rr-chart path { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
    .rr-chart .grid { stroke: rgba(255,255,255,0.07); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .rr-chart .cursor { stroke: rgba(255,255,255,0.5); stroke-width: 1; vector-effect: non-scaling-stroke; }
    .rr-charts { position: relative; touch-action: pan-y; }
    .rr-hover { margin-top: 4px; font-size: 12px; color: #b6c8d6; text-align: center; font-variant-numeric: tabular-nums; }
    .rr-chart path.pace { stroke: var(--hud-accent, #00d4ff); }
    .rr-chart path.hr { stroke: #f87171; }
    .rr-axis { display: flex; justify-content: space-between; margin-top: 2px; font-size: 11px; color: #6d8399; }
    .rr-warn { margin-top: 8px; padding: 8px 10px; border-radius: 8px; font-size: 13px;
               background: rgba(255, 176, 32, 0.12); border: 1px solid rgba(255, 176, 32, 0.45); color: #ffc861; }
    .rr-route { display: block; width: 100%; max-width: 520px; height: 220px; margin-top: 12px; border-radius: 8px; background: rgba(255,255,255,0.03); }
    .rr-route path { fill: none; stroke: var(--hud-accent, #00d4ff); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
    .rr-start { fill: #4ade80; }
    .rr-end { fill: #f87171; }
    .rr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; margin-top: 12px; }
    .rr-split { display: flex; flex-direction: column; padding: 8px 10px; border-radius: 8px; background: rgba(255,255,255,0.04); }
    .rr-split-t { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: #8aa0b4; }
    .rr-split-m { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .rr-split-p { font-size: 12px; color: #8aa0b4; font-variant-numeric: tabular-nums; }
    .rr-checks { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
    .rr-check { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; color: #b6c8d6; }
    .rr-check b { display: block; color: #dceaf6; font-size: 13px; }
    .rr-dot { flex: none; width: 10px; height: 10px; margin-top: 4px; border-radius: 50%; background: #4ade80; }
    .rr-check[data-s='warn'] .rr-dot { background: #fbbf24; }
    .rr-check[data-s='fail'] .rr-dot { background: #f87171; }
    .rr-meta { display: flex; flex-direction: column; gap: 3px; margin-top: 12px; font-size: 13px; color: #b6c8d6; }
    .rr-meta a { color: var(--hud-accent, #00d4ff); }
  `]
})
export class RunReviewComponent implements OnChanges {
  @Input() run!: RunSummary;                  // as submitted
  @Input() fileUrl: string | null = null;     // the original file
  @Input() submittedKm = 0;                   // the 30-Minute Run score on the submission
  @Input() submittedAt = '';
  @Input() duplicateOf: string | null = null; // who this run was already approved for
  readonly clock = clock;

  checking = false;
  error = '';
  result: RunCheckResult | null = null;
  private file: { url: string; bytes: ArrayBuffer } | null = null;

  // The run as checked from the file, or as submitted until then.
  detail: DetailChart[] = [];
  ticks = [0, 5, 10, 15, 20, 25, 30];
  hoverF: number | null = null;

  hover(e: MouseEvent | TouchEvent) {
    const svg = (e.currentTarget as HTMLElement).querySelector('svg');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const x = 'touches' in e ? e.touches[0].clientX : e.clientX;
    this.hoverF = Math.min(1, Math.max(0, (x - r.left) / r.width));
  }
  valueAt(c: DetailChart): string {
    const t = (this.hoverF ?? 0) * 1800;
    let best: [number, number] | null = null;
    for (const p of c.points) if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    return best && Math.abs(best[0] - t) < 30 ? c.fmt(best[1]) : '—';
  }

  get shown(): RunSummary { return this.result?.summary ?? this.run; }

  async ngOnChanges(changes: SimpleChanges) {
    if (!this.run) return;
    if (changes['fileUrl'] || changes['run']) this.file = null;
    await this.check();
  }

  private async check() {
    if (!this.fileUrl) { this.error = 'The run file is not uploaded yet.'; return; }
    this.checking = true;
    this.error = '';
    try {
      if (!this.file || this.file.url !== this.fileUrl) {
        const res = await fetch(this.fileUrl);
        if (!res.ok) throw new Error('download');
        this.file = { url: this.fileUrl, bytes: await res.arrayBuffer() };
      }
      const { meta, series } = readRunFile(this.run.source, this.file.bytes);
      this.result = checkRun(meta, series, { km: this.submittedKm, at: this.submittedAt, duplicateOf: this.duplicateOf });
      this.detail = buildDetail(series, this.result.summary.windowStart);
    } catch (e) {
      this.result = null;
      this.error = e instanceof Error && e.message !== 'download' && e.message
        ? `The run file could not be checked: ${e.message}`
        : 'The run file could not be downloaded. Reload to try again.';
    } finally {
      this.checking = false;
    }
  }

  verdictLine(r: RunCheckResult): string {
    const fails = r.checks.filter(c => c.status === 'fail').length;
    const warns = r.checks.filter(c => c.status === 'warn').length;
    if (fails) return `${fails} check${fails === 1 ? '' : 's'} failed. See below.`;
    if (warns) return `Every check passed, with ${warns} warning${warns === 1 ? '' : 's'} to look at.`;
    return 'Every check passed.';
  }

  // Minutes per km over a five-minute split.
  pace(m: number): string { return m > 0 ? clock(300 / (m / 1000)) : '—'; }

  private get projected(): Array<[number, number]> {
    const pts = this.shown?.route ?? [];
    if (pts.length < 2) return [];
    const k = Math.cos(pts[0].lat * Math.PI / 180);
    const xs = pts.map(p => p.lon * k), ys = pts.map(p => -p.lat);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 1e-9, h = Math.max(...ys) - y0 || 1e-9;
    const s = Math.min(380 / w, 200 / h), ox = (400 - w * s) / 2, oy = (220 - h * s) / 2;
    return pts.map((_, i) => [ox + (xs[i] - x0) * s, oy + (ys[i] - y0) * s]);
  }
  get routePath(): string {
    return this.projected.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  }
  get ends() {
    const p = this.projected;
    return p.length ? { start: p[0], end: p[p.length - 1] } : null;
  }
}

// One point per minute across the 400-wide chart; a missing minute breaks the line.
function line(ys: Array<number | null>): string {
  let d = '', pen = false;
  ys.forEach((y, i) => {
    if (y == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${((i + 0.5) / ys.length * 400).toFixed(1)} ${y.toFixed(1)} `;
    pen = true;
  });
  return d.trim();
}

interface DetailChart {
  label: string; color: string; range: string; path: string;
  points: Array<[number, number]>;      // seconds into the scored 30:00, value
  fmt: (n: number) => string;
}

// Every recorded point of the scored 30:00: pace from the distance (smoothed over 20 seconds), heart rate and elevation as recorded.
function buildDetail(series: RunSeries, windowStart: number): DetailChart[] {
  const dist = [...series.dist].sort((a, b) => a.t - b.t);
  if (dist.length < 2) return [];
  const s0 = dist[0].t + windowStart;
  const inWin = <T extends { t: number }>(a: T[] | undefined) => (a ?? []).filter(p => p.t >= s0 && p.t <= s0 + 1800);

  const pace: Array<[number, number]> = [];
  for (let t = 0; t <= 1800; t += 5) {
    const m = distAt(dist, s0 + Math.min(1800, t + 10)) - distAt(dist, s0 + Math.max(0, t - 10));
    const span = Math.min(1800, t + 10) - Math.max(0, t - 10);
    const sec = m > 1 ? span / (m / 1000) : 0;
    if (sec > 0 && sec < 1200) pace.push([t, sec]);
  }
  const hr: Array<[number, number]> = inWin(series.hr).map(p => [p.t - s0, p.bpm]);
  const alt: Array<[number, number]> = inWin(series.alt).map(p => [p.t - s0, p.m]);

  const out: DetailChart[] = [];
  const add = (label: string, pts: Array<[number, number]>, flip: boolean, color: string, fmt: (n: number) => string) => {
    if (pts.length < 2) return;
    const vs = pts.map(p => p[1]);
    const lo = Math.min(...vs), hi = Math.max(...vs), span = hi - lo || 1;
    const path = pts.map((p, i) => {
      const y = flip ? 8 + ((p[1] - lo) / span) * 104 : 112 - ((p[1] - lo) / span) * 104;
      return `${i ? 'L' : 'M'}${(p[0] / 1800 * 600).toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    out.push({ label, color, path, points: pts, fmt, range: `${fmt(lo)} – ${fmt(hi)}` });
  };
  add('Pace (/km)', pace, true, 'var(--hud-accent, #00d4ff)', n => clock(n));
  add('Heart Rate', hr, false, '#f87171', n => `${Math.round(n)} bpm`);
  add('Elevation', alt, false, '#4ade80', n => `${Math.round(n)} m`);
  return out;
}
