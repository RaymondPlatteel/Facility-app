import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, alertCircle, trendingDown } from 'ionicons/icons';
import { FirebaseService } from '../services/firebase.service';
import type { EventBatch } from '../program-engine/analytics';
import { Bar, Report, Section, buildReport } from './analytics.util';
import { demoBatches } from './demo';

const DAY = 86400000;

// How the athlete app is used, from its anonymous event log: where new athletes stop on the way in, who comes back,
// which pages are used and which are not. Remote athletes and in-person facility members are shown apart.
@Component({
  selector: 'app-app-analytics',
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon],
  templateUrl: './app-analytics.page.html',
  styleUrls: ['./app-analytics.page.scss']
})
export class AppAnalyticsPage implements OnInit {
  readonly periods = [7, 30, 90];
  section: Section = 'remote';
  period = 30;
  loading = true;
  error = '';
  demo = false;
  private batches: EventBatch[] = [];
  report: Report | null = null;
  hover: { i: number; x: number } | null = null;   // the day under the pointer on the activity chart

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, alertCircle, trendingDown });
  }

  async ngOnInit() {
    try {
      const since = new Date(Date.now() - 120 * DAY).toLocaleDateString('en-CA');
      this.batches = await this.firebase.listEventBatches(since);
    } catch (e) {
      console.error('App analytics: could not load', e);
      this.error = 'Usage could not be loaded. Check the connection and reload.';
    }
    this.loading = false;
    this.rebuild();
  }

  goBack() { this.router.navigate(['/home']); }
  // Usage from the phone apps; the web build is only used for development (see analytics.util.ts).
  get hasData(): boolean { return this.batches.some(b => b.pl !== 'web'); }

  setSection(s: Section) { this.section = s; this.rebuild(); }
  setPeriod(p: number) { this.period = p; this.rebuild(); }
  showDemo(on: boolean) { this.demo = on; this.rebuild(); }

  private rebuild() {
    this.report = buildReport(this.demo ? demoBatches() : this.batches, this.section, this.period);
    this.hover = null;
  }

  // ---------- Words and numbers ----------
  pct(v: number | null | undefined): string { return v == null ? '—' : `${Math.round(v * 100)}%`; }
  num(v: number | null | undefined, digits = 0): string { return v == null ? '—' : v.toFixed(digits); }
  get sectionName(): string { return this.section === 'remote' ? 'remote athletes' : 'in-person members'; }

  // The one sentence the page leads with.
  get headline(): { lead: string; from: string; to: string; lost: number; of: number; share: number } | null {
    const r = this.report;
    if (!r?.worst) return null;
    const i = r.funnel.indexOf(r.worst);
    const prev = r.funnel[i - 1];
    return { lead: 'Most new users are lost between', from: prev.label, to: r.worst.label, lost: prev.count - r.worst.count, of: prev.count, share: r.worst.dropFromPrev ?? 0 };
  }

  barWidth(b: Bar): number { return Math.max(b.count ? 1.5 : 0, b.pctOfStart * 100); }

  // ---------- Activity chart: 640 × 180, plot inset for the y labels ----------
  readonly W = 640; readonly H = 180; readonly L = 34; readonly T = 12; readonly B = 26;
  get yMax(): number {
    const m = Math.max(1, ...(this.report?.daily ?? []).map(d => d.users));
    const step = m <= 5 ? 1 : m <= 10 ? 2 : m <= 25 ? 5 : m <= 50 ? 10 : m <= 100 ? 20 : 50;
    return Math.ceil(m / step) * step;
  }
  get yTicks(): number[] { const m = this.yMax; return [0, m / 2, m].map(v => Math.round(v)); }
  x(i: number): number { const n = (this.report?.daily.length ?? 1) - 1; return this.L + (n ? i / n : 0) * (this.W - this.L - 8); }
  y(v: number): number { return this.T + (1 - v / this.yMax) * (this.H - this.T - this.B); }
  get linePath(): string { return (this.report?.daily ?? []).map((d, i) => `${i ? 'L' : 'M'}${this.x(i).toFixed(1)} ${this.y(d.users).toFixed(1)}`).join(' '); }
  get areaPath(): string {
    const d = this.report?.daily ?? [];
    if (!d.length) return '';
    return `${this.linePath} L${this.x(d.length - 1).toFixed(1)} ${this.y(0)} L${this.x(0).toFixed(1)} ${this.y(0)} Z`;
  }
  get xLabels(): Array<{ x: number; text: string }> {
    const d = this.report?.daily ?? [];
    if (!d.length) return [];
    const at = [0, Math.floor((d.length - 1) / 2), d.length - 1];
    return at.map(i => ({ x: this.x(i), text: this.shortDate(d[i].day) }));
  }
  shortDate(day: string): string { return new Date(day + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }

  onChartMove(e: MouseEvent) {
    const svg = e.currentTarget as SVGSVGElement, r = svg.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * this.W;
    const n = this.report?.daily.length ?? 0;
    if (!n) return;
    const i = Math.max(0, Math.min(n - 1, Math.round((px - this.L) / (this.W - this.L - 8) * (n - 1))));
    this.hover = { i, x: this.x(i) };
  }
  get hoverDay() { return this.hover && this.report ? this.report.daily[this.hover.i] : null; }
  get hoverLeft(): number { return this.hover ? this.hover.x / this.W * 100 : 0; }

  // Return-rate cells: a single blue, deeper for a higher share.
  cellBg(v: number | null): string {
    return v == null ? 'transparent' : `color-mix(in srgb, var(--accent) ${Math.round(8 + v * 52)}%, transparent)`;
  }
  weekLabel(week: string): string { return `Week of ${this.shortDate(week)}`; }
}
