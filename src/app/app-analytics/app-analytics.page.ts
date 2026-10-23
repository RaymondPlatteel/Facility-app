import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, alertCircle, trendingDown, refreshOutline } from 'ionicons/icons';
import { FirebaseService } from '../services/firebase.service';
import type { EventBatch } from '../program-engine/analytics';
import { Bar, PageRow, Report, Section, TOUR_ORDER, buildReport } from './analytics.util';
import { demoBatches } from './demo';
import { getOmniRank } from '../services/omni.util';

const DAY = 86400000;
// Internal accounts: the App Store reviewer and the developer's test athlete. They are never counted (the same list the
// athlete app leaves off its standings).
const INTERNAL = ['apple reviewer', 'casey sandbox'];
// Without anything done in the app for this long, an athlete is inactive.
const ACTIVE_DAYS = 28;

export type Tab = 'downloads' | 'onboarding' | 'active' | 'inactive';

// One athlete with a login to the athlete app, from their own record.
export interface Person {
  name: string;
  section: Section;
  linkedAt: number;          // when the login was made
  intake: boolean;           // accepted the terms on the intake form
  tour: number;              // the furthest tour step on the record (TOUR_ORDER), -1 for none
  estimate: boolean;         // saved a starting estimate in the walkthrough
  coachHad: boolean;         // an athlete the coach already had: the app skips the tour and walkthrough for them
  finishedAt: number | null; // when onboarding was finished: the walkthrough saved, or the login made for the coach's athletes
  level: number | null;
  rank: string;
  times: number[];           // everything the athlete did in the app themselves, oldest first
  last: number | null;
}

// How the athlete app is used, as a flow: downloads, getting through the account, tour and walkthrough, then active or
// inactive. Each athlete is in one stage. Remote athletes and in-person members are shown apart.
@Component({
  selector: 'app-app-analytics',
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon],
  templateUrl: './app-analytics.page.html',
  styleUrls: ['./app-analytics.page.scss']
})
export class AppAnalyticsPage implements OnInit {
  readonly periods = [7, 30, 90];
  readonly tabs: Array<{ id: Tab; label: string }> = [
    { id: 'downloads', label: 'Downloads' }, { id: 'onboarding', label: 'Onboarding' },
    { id: 'active', label: 'Active' }, { id: 'inactive', label: 'Inactive' }
  ];
  tab: Tab = 'onboarding';
  section: Section = 'remote';
  period = 30;
  loading = true;
  error = '';
  demo = false;
  private batches: EventBatch[] = [];
  people: Person[] = [];
  updatedAt: Date | null = null;
  report: Report | null = null;
  hover: { i: number; x: number } | null = null;   // the day under the pointer on the activity chart

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({ arrowBack, alertCircle, trendingDown, refreshOutline });
  }

  ngOnInit() { return this.load(); }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const since = new Date(Date.now() - 120 * DAY).toLocaleDateString('en-CA');
      const [batches, links, members, testers, activity] = await Promise.all([
        this.firebase.listEventBatches(since),
        this.firebase.listAllLinks().catch(() => []),
        this.firebase.listMembers().catch(() => []),
        this.firebase.getTesters().catch(() => [] as string[]),
        this.firebase.listAthleteActivity().catch(() => ({ times: new Map<string, number[]>(), onboardedAt: new Map<string, number>(), coachHad: new Set<string>() }))
      ]);
      this.batches = batches;
      const byKey = new Map(members.map(m => [m.nameKey, m]));
      // The first login made for each athlete.
      const firstLink = new Map<string, number>();
      for (const l of links) {
        const t = Date.parse(l.linkedAt);
        if (isFinite(t) && t < (firstLink.get(l.nameKey) ?? Infinity)) firstLink.set(l.nameKey, t);
      }
      this.people = [];
      for (const [key, linkedAt] of firstLink) {
        const m = byKey.get(key);
        if (!m || testers.includes(key) || INTERNAL.includes(key) || (m as { mergedInto?: string }).mergedInto) continue;
        const estimate = m.estimateLvl != null || (m.estimatedTests?.length ?? 0) > 0;
        const coachHad = activity.coachHad.has(key);
        const level = typeof m.latestLvl === 'number' ? m.latestLvl : null;
        const times = [...(activity.times.get(key) ?? [])].sort((a, b) => a - b);
        this.people.push({
          name: m.clientName || key,
          section: m.inPerson ? 'facility' : 'remote',
          linkedAt,
          intake: !!m.termsAcceptedAt,
          tour: m.tourStep ? TOUR_ORDER.indexOf(m.tourStep) : -1,
          estimate,
          coachHad,
          finishedAt: coachHad ? linkedAt : estimate ? (activity.onboardedAt.get(key) ?? linkedAt) : null,
          level,
          rank: level !== null ? getOmniRank(level, m.sex ?? 'male') : 'UNRANKED',
          times,
          last: times.length ? times[times.length - 1] : null
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

  // ---------- The stages ----------
  private get mine(): Person[] { return this.people.filter(p => p.section === this.section); }
  private get from(): number { return Date.now() - this.period * DAY; }
  // Through the account, tour and walkthrough (the walkthrough saved), or an athlete the coach already had.
  private done(p: Person): boolean { return p.coachHad || p.estimate; }
  // Did something in the app themselves in the last four weeks. Onboarding itself does not count.
  private isActive(p: Person): boolean { return this.done(p) && (p.last ?? 0) >= Date.now() - ACTIVE_DAYS * DAY; }
  // Finished onboarding in the last four weeks and has not done anything since: not active, and not yet inactive.
  private isWaiting(p: Person): boolean { return this.done(p) && !p.last && (p.finishedAt ?? 0) >= Date.now() - ACTIVE_DAYS * DAY; }

  get newAccounts(): Person[] { return this.mine.filter(p => p.linkedAt >= this.from).sort((a, b) => b.linkedAt - a.linkedAt); }
  get onboarding(): Person[] { return this.mine.filter(p => !this.done(p)).sort((a, b) => b.linkedAt - a.linkedAt); }
  get waiting(): Person[] { return this.mine.filter(p => this.isWaiting(p)).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)); }
  get active(): Person[] { return this.mine.filter(p => this.isActive(p)).sort((a, b) => (b.last ?? 0) - (a.last ?? 0)); }
  get inactive(): Person[] { return this.mine.filter(p => this.done(p) && !this.isActive(p) && !this.isWaiting(p)).sort((a, b) => (b.last ?? 0) - (a.last ?? 0)); }
  count(t: Tab): number {
    return t === 'downloads' ? this.newAccounts.length : t === 'onboarding' ? this.onboarding.length + this.waiting.length : t === 'active' ? this.active.length : this.inactive.length;
  }

  // The onboarding flow for the accounts made in the period that signed up in the app, each step with who reached it.
  flow: Bar[] = [];
  private buildFlow(): Bar[] {
    const list = this.newAccounts.filter(p => !p.coachHad);
    const N = list.length;
    const start = TOUR_ORDER.indexOf('start');
    const steps: Array<{ key: string; label: string; test: (p: Person) => boolean }> = [
      { key: 'account', label: 'Created an account', test: () => true },
      { key: 'intake', label: 'Completed the intake form', test: p => p.intake || p.tour >= 0 || this.done(p) },
      { key: 'tour', label: 'Started the tour', test: p => p.tour >= 0 || this.done(p) },
      { key: 'tour-end', label: 'Reached Start the tests', test: p => p.tour >= start || this.done(p) },
      { key: 'walk', label: 'Walkthrough', test: p => p.estimate || this.done(p) }
    ];
    const out = steps.map(s => {
      const who = list.filter(s.test);
      return { key: s.key, label: s.label, count: who.length, pctOfStart: N ? who.length / N : 0, dropFromPrev: null as number | null,
        who: who.map(p => p.name), missed: list.filter(p => !s.test(p)).map(p => p.name) };
    });
    let worst: Bar | null = null, most = 0;
    out.forEach((b, i) => {
      if (i && out[i - 1].count > b.count) {
        b.dropFromPrev = 1 - b.count / out[i - 1].count;
        if (out[i - 1].count - b.count > most) { most = out[i - 1].count - b.count; worst = b; }
      }
    });
    if (worst) (worst as Bar).worst = true;
    return out;
  }
  get coachHad(): Person[] { return this.newAccounts.filter(p => p.coachHad); }

  stageName(p: Person): string { return !this.done(p) ? 'Onboarding' : this.isActive(p) ? 'Active' : this.isWaiting(p) ? 'Finished onboarding' : 'Inactive'; }

  // Where an athlete still in onboarding has got to.
  stage(p: Person): string {
    if (p.estimate) return 'Walkthrough done';
    if (p.tour >= TOUR_ORDER.indexOf('start')) return 'At Start the tests';
    if (p.tour >= 0) return 'In the tour';
    if (p.intake) return 'Intake done';
    return 'Account created';
  }

  // Coming back after onboarding, by name: on the second day, in the second week (days 8 to 14) and after four weeks
  // (days 29 to 35), counting the athletes who finished the walkthrough long enough ago for that day to have come.
  readonly windows = [{ id: 'd2', label: 'Second day', from: 1, to: 1 }, { id: 'w2', label: 'Second week', from: 7, to: 13 }, { id: 'w5', label: 'After 4 weeks', from: 28, to: 34 }];
  openReturn: string | null = null;
  returned(id: string): { back: Person[]; not: Person[] } {
    const w = this.windows.find(x => x.id === id)!;
    const back: Person[] = [], not: Person[] = [];
    for (const p of this.mine) {
      if (p.coachHad || !p.estimate || p.finishedAt === null) continue;
      const day0 = new Date(p.finishedAt); day0.setHours(0, 0, 0, 0);
      const a = day0.getTime() + w.from * DAY, b = day0.getTime() + (w.to + 1) * DAY;
      if (Date.now() < a + DAY) continue;   // too soon to tell
      (p.times.some(t => t >= a && t < b) ? back : not).push(p);
    }
    return { back, not };
  }

  // Ranks of everyone through onboarding.
  readonly rankOrder: Array<{ rank: string; label: string; color: string }> = [
    { rank: 'UNRANKED', label: 'Unranked', color: '#7d8895' },
    { rank: 'D-RANK', label: 'D-Rank', color: '#2dd36f' },
    { rank: 'C-RANK', label: 'C-Rank', color: '#3b9cff' },
    { rank: 'B-RANK', label: 'B-Rank', color: '#a35cff' },
    { rank: 'A-RANK', label: 'A-Rank', color: '#ff4d5e' },
    { rank: 'S-RANK', label: 'S-Rank', color: '#f2f4f7' }
  ];
  get rankBars(): Array<{ label: string; color: string; count: number; share: number; height: number }> {
    const list = this.mine.filter(p => this.done(p));
    const counts = this.rankOrder.map(r => list.filter(p => p.rank === r.rank).length);
    const top = Math.max(1, ...counts);
    return this.rankOrder.map((r, i) => ({ label: r.label, color: r.color, count: counts[i], share: list.length ? counts[i] / list.length : 0, height: counts[i] / top * 100 }));
  }
  get rankTotal(): number { return this.mine.filter(p => this.done(p)).length; }

  names(list: Person[]): string { return list.map(p => p.name).join(', '); }
  when(t: number): string { return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); }
  ago(t: number | null): string {
    if (!t) return 'Nothing yet';
    const d = Math.floor((Date.now() - t) / DAY);
    return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`;
  }
  rankLabel(r: string): string { return r === 'UNRANKED' ? 'Unranked' : r.replace('-RANK', '-Rank'); }

  // The step whose accounts are shown under it.
  openStep = '';
  toggleStep(b: Bar) { this.openStep = this.openStep === b.key ? '' : b.key; }

  goBack() { this.router.navigate(['/home']); }
  // Usage from the phone apps; the web build is only used for development (see analytics.util.ts).
  get hasData(): boolean { return this.batches.some(b => b.pl !== 'web'); }

  setTab(t: Tab) { this.tab = t; this.openStep = ''; this.openReturn = null; }
  setSection(s: Section) { this.section = s; this.rebuild(); }
  setPeriod(p: number) { this.period = p; this.rebuild(); }
  showDemo(on: boolean) { this.demo = on; this.rebuild(); }

  private rebuild() {
    this.report = buildReport(this.demo ? demoBatches() : this.batches, this.section, this.period);
    this.flow = this.buildFlow();
    this.hover = null;
  }

  // ---------- Words and numbers ----------
  pct(v: number | null | undefined): string { return v == null ? '—' : `${Math.round(v * 100)}%`; }
  num(v: number | null | undefined, digits = 0): string { return v == null ? '—' : v.toFixed(digits); }
  get sectionName(): string { return this.section === 'remote' ? 'remote athletes' : 'in-person members'; }

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
