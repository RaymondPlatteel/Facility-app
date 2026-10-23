import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, alertCircle, trendingDown, refreshOutline } from 'ionicons/icons';
import { FirebaseService } from '../services/firebase.service';
import type { EventBatch } from '../program-engine/analytics';
import { AccountRow, Bar, PageRow, Report, Section, TOUR_ORDER, buildReport } from './analytics.util';
import { demoBatches } from './demo';
import { getOmniRank } from '../services/omni.util';

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
  private accounts: AccountRow[] = [];
  private existingRows: Array<{ linkedAt: number; section: Section }> = [];   // athletes the coach already had who were given a login
  // How many of them in the period on screen: left out of the journey.
  get existing(): number { const from = Date.now() - this.period * DAY; return this.existingRows.filter(e => e.section === this.section && e.linkedAt >= from).length; }
  private levels: Array<{ section: Section; rank: string }> = [];
  updatedAt: Date | null = null;
  report: Report | null = null;
  hover: { i: number; x: number } | null = null;   // the day under the pointer on the activity chart

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, alertCircle, trendingDown, refreshOutline });
  }

  ngOnInit() { return this.load(); }

  // Reads the usage log and the new accounts again.
  async load() {
    this.loading = true;
    this.error = '';
    try {
      const since = new Date(Date.now() - 120 * DAY).toLocaleDateString('en-CA');
      const sinceIso = new Date(Date.now() - 120 * DAY).toISOString();
      const [batches, links, members, testers, did, requested] = await Promise.all([
        this.firebase.listEventBatches(since),
        this.firebase.listLinksSince(sinceIso).catch(() => []),
        this.firebase.listMembers().catch(() => []),
        this.firebase.getTesters().catch(() => [] as string[]),
        this.firebase.listMemberActivity(sinceIso).catch(() => null),
        this.firebase.listLinkedRequestUids().catch(() => new Set<string>())
      ]);
      this.batches = batches;
      // The accounts come from the athletes' own records, so they count the same whatever version of the app people have.
      const byKey = new Map(members.map(m => [m.nameKey, m]));
      this.accounts = [];
      this.levels = members
        .filter(m => !testers.includes(m.nameKey) && typeof m.latestLvl === 'number')
        .map(m => ({ section: (m.inPerson ? 'facility' : 'remote') as Section, rank: getOmniRank(m.latestLvl as number, m.sex ?? 'male') }));
      this.existingRows = [];
      for (const l of links) {
        const m = byKey.get(l.nameKey);
        if (!m || testers.includes(m.nameKey)) continue;
        // An athlete the coach already had, given a login (a link request a coach approved, or a link the coach made), did not
        // go through the app's own sign-up, so they are not a new user and are counted apart.
        const onboarded = m.tourStep != null || m.estimateLvl != null || (m.estimatedTests?.length ?? 0) > 0;
        if (requested.has(l.uid) || !onboarded) { this.existingRows.push({ linkedAt: Date.parse(l.linkedAt), section: m.inPerson ? 'facility' : 'remote' }); continue; }
        const week = Date.now() - 7 * DAY;
        this.accounts.push({
          linkedAt: Date.parse(l.linkedAt),
          section: m.inPerson ? 'facility' : 'remote',
          tour: m.tourStep ? TOUR_ORDER.indexOf(m.tourStep) : -1,
          estimate: m.estimateLvl != null || (m.estimatedTests?.length ?? 0) > 0,
          submittedVerified: !!did?.approved.has(m.nameKey),
          submittedPending: !!did?.pending.has(m.nameKey),
          program: !!m.programIntake,
          checkedIn: (m.checkInDays?.length ?? 0) > 0 || !!did?.checkIns.has(m.nameKey),
          workout: !!did?.workouts.has(m.nameKey),
          goal: !!did?.goals.has(m.nameKey),
          resilience: !!did?.resilience.has(m.nameKey),
          photo: !!m.photoUrl,
          results: Object.keys(m.testScores ?? {}).length >= 3,
          board: !m.private && !m.hideWorld && m.latestLvl != null,
          active: !!m.lastActivityAt && Date.parse(m.lastActivityAt) >= week
        });
      }
      this.updatedAt = new Date();
    } catch (e) {
      console.error('App analytics: could not load', e);
      this.error = 'Usage could not be loaded. Check the connection and try again.';
    }
    this.loading = false;
    this.rebuild();
  }

  // Everyone's current rank, from their latest Level, private accounts included: this page is the coach's own view.
  readonly rankOrder: Array<{ rank: string; label: string; color: string }> = [
    { rank: 'UNRANKED', label: 'Unranked', color: '#7d8895' },
    { rank: 'D-RANK', label: 'D-Rank', color: '#2dd36f' },
    { rank: 'C-RANK', label: 'C-Rank', color: '#3b9cff' },
    { rank: 'B-RANK', label: 'B-Rank', color: '#a35cff' },
    { rank: 'A-RANK', label: 'A-Rank', color: '#ff4d5e' },
    { rank: 'S-RANK', label: 'S-Rank', color: '#f2f4f7' }
  ];
  get rankBars(): Array<{ label: string; color: string; count: number; share: number; height: number }> {
    const mine = this.levels.filter(l => l.section === this.section);
    const counts = this.rankOrder.map(r => mine.filter(l => l.rank === r.rank).length);
    const top = Math.max(1, ...counts);
    return this.rankOrder.map((r, i) => ({ label: r.label, color: r.color, count: counts[i], share: mine.length ? counts[i] / mine.length : 0, height: counts[i] / top * 100 }));
  }
  get rankTotal(): number { return this.levels.filter(l => l.section === this.section).length; }

  goBack() { this.router.navigate(['/home']); }
  // Usage from the phone apps; the web build is only used for development (see analytics.util.ts).
  get hasData(): boolean { return this.batches.some(b => b.pl !== 'web'); }

  setSection(s: Section) { this.section = s; this.rebuild(); }
  setPeriod(p: number) { this.period = p; this.rebuild(); }
  showDemo(on: boolean) { this.demo = on; this.rebuild(); }

  private rebuild() {
    this.report = buildReport(this.demo ? demoBatches() : this.batches, this.section, this.period, this.demo ? [] : this.accounts);
    this.hover = null;
  }

  // ---------- Words and numbers ----------
  pct(v: number | null | undefined): string { return v == null ? '—' : `${Math.round(v * 100)}%`; }
  num(v: number | null | undefined, digits = 0): string { return v == null ? '—' : v.toFixed(digits); }
  get sectionName(): string { return this.section === 'remote' ? 'remote athletes' : 'in-person members'; }

  // The one sentence the page leads with.
  // Led by the new accounts, counted from their records; the usage log's earlier steps when there are none.
  get headline(): { lead: string; from: string; to: string; lost: number; of: number; share: number } | null {
    const r = this.report;
    if (!r) return null;
    const worst = r.journeyWorst;
    if (!worst) return null;
    const steps = r.journey.map(g => g.steps).find(s => s.includes(worst))!;
    const prev = steps[steps.indexOf(worst) - 1];
    return { lead: 'Most new users are lost between', from: prev.label, to: worst.label, lost: prev.count - worst.count, of: prev.count, share: worst.dropFromPrev ?? 0 };
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

  // ---------- Every page, as a pie of page views ----------
  // A slice clicked (or its row in the list) is taken out, and the rest share the pie; click again to put it back.
  hidden = new Set<string>();
  pieHover: string | null = null;
  readonly R = 150;   // pie radius, in a 320 × 320 box

  togglePage(path: string) {
    if (this.hidden.has(path)) this.hidden.delete(path); else this.hidden.add(path);
    this.hidden = new Set(this.hidden);
    this.pieHover = null;
  }
  showAllPages() { this.hidden = new Set(); }

  private get shown(): PageRow[] { return (this.report?.allPages ?? []).filter(p => p.views > 0 && !this.hidden.has(p.path)); }
  get pieTotal(): number { return this.shown.reduce((t, p) => t + p.views, 0); }

  // One colour per page, from the brightest blue for the most viewed to the deepest for the least, in the order of
  // the full list, so taking a slice out never repaints the others.
  pageColor(path: string): string {
    const all = (this.report?.allPages ?? []).filter(p => p.views > 0);
    const i = Math.max(0, all.findIndex(p => p.path === path));
    const t = all.length > 1 ? i / (all.length - 1) : 0;
    return `color-mix(in oklab, var(--accent) ${Math.round(100 - t * 78)}%, #0a1f2e)`;
  }

  get slices(): Array<{ path: string; label: string; d: string; share: number; views: number; users: number; color: string; mid: { x: number; y: number } }> {
    const total = this.pieTotal;
    if (!total) return [];
    const c = 160, R = this.R;
    let a0 = -Math.PI / 2;
    return this.shown.map(p => {
      const share = p.views / total;
      const a1 = a0 + share * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const pt = (a: number, r = R) => ({ x: c + r * Math.cos(a), y: c + r * Math.sin(a) });
      const s = pt(a0), e = pt(a1), mid = pt((a0 + a1) / 2, R * 0.62);
      const d = share >= 0.9999
        ? `M${c} ${c - R} A${R} ${R} 0 1 1 ${c - 0.01} ${c - R} Z`
        : `M${c} ${c} L${s.x.toFixed(2)} ${s.y.toFixed(2)} A${R} ${R} 0 ${big} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)} Z`;
      a0 = a1;
      return { path: p.path, label: p.label, d, share, views: p.views, users: p.users, color: this.pageColor(p.path), mid };
    });
  }
  get hovered() { return this.slices.find(s => s.path === this.pieHover) ?? null; }
  pageShare(p: PageRow): number { return this.pieTotal && !this.hidden.has(p.path) ? p.views / this.pieTotal : 0; }

  // Return-rate cells: a single blue, deeper for a higher share.
  cellBg(v: number | null): string {
    return v == null ? 'transparent' : `color-mix(in srgb, var(--accent) ${Math.round(8 + v * 52)}%, transparent)`;
  }
  weekLabel(week: string): string { return `Week of ${this.shortDate(week)}`; }
}
