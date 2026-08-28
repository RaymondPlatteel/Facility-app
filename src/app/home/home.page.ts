import { Component, OnInit } from '@angular/core';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { RouterModule } from '@angular/router';
import { addIcons } from 'ionicons';
import {
  logInOutline,
  chatbubblesOutline,
  documentTextOutline,
  calendarOutline,
  peopleOutline,
  keypadOutline,
  barbellOutline,
  fitnessOutline,
  cubeOutline,
  pulseOutline,
  trendingUpOutline,
  notificationsOutline,
  arrowForwardOutline,
  warningOutline,
  cashOutline,
  checkmarkCircleOutline,
  refreshOutline
} from 'ionicons/icons';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth.service';
import { FirebaseService, PackageRecord } from '../services/firebase.service';
import { generateScheduleForRange, ScheduleEntry, formatTime12h } from '../services/schedule.util';

// One row in the "Needs Attention" panel — the things that actually cost
// the facility money or block work if they're missed: packages about to
// run out (a renewal conversation), outstanding balances, and submissions
// waiting on a coach.
interface AttentionItem {
  kind: 'low' | 'unpaid' | 'review';
  label: string;
  detail: string;
  link: string;
}

// One entry in the "Score Updates" feed — an athlete's OMNI level moving.
// Deliberately assessments ONLY: check-ins and logged workouts are noise
// here, since neither changes anyone's score.
interface ScoreUpdate {
  clientName: string;
  lvl: number;
  rank: string;
  delta: number | null; // null = their first assessment, nothing to compare to
  at: number;           // epoch ms, for sorting
}

// 'YYYY-MM-DD' must be parsed as LOCAL — new Date('2026-08-17') is UTC and
// lands on the previous day in western timezones.
function parseWhen(value?: string): number {
  if (!value) return 0;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])).getTime();
  const t = new Date(value).getTime();
  return isFinite(t) ? t : 0;
}

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonContent, IonIcon, RouterModule, CommonModule],
})
export class HomePage implements OnInit {
  isAuthenticated = false;
  trainerName = '';
  formatTime12h = formatTime12h;

  // Today's actual recurring schedule — generated the same way the real
  // Schedule page does (packages + overrides + one-off sessions).
  todaySchedule: ScheduleEntry[] = [];
  loadingSchedule = true;

  attention: AttentionItem[] = [];
  loadingAttention = true;

  scoreUpdates: ScoreUpdate[] = [];
  loadingScores = true;

  constructor(private authService: AuthService, private firebase: FirebaseService) {
    addIcons({
      logInOutline,
      chatbubblesOutline,
      documentTextOutline,
      calendarOutline,
      peopleOutline,
      keypadOutline,
      barbellOutline,
      fitnessOutline,
      cubeOutline,
      pulseOutline,
      trendingUpOutline,
      notificationsOutline,
      arrowForwardOutline,
      warningOutline,
      cashOutline,
      checkmarkCircleOutline,
      refreshOutline
    });
  }

  ngOnInit() {
    this.authService.isAuthenticated$.subscribe(isAuth => {
      this.isAuthenticated = isAuth;
      if (isAuth) this.loadDashboard();
    });
    this.authService.currentTrainer$.subscribe(t => {
      this.trainerName = t?.name || '';
    });
  }

  get greeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  get todayLabel(): string {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  clientLabel(entry: ScheduleEntry): string {
    return entry.clientNames.length ? entry.clientNames.join(', ') : 'No clients linked';
  }

  timeAgo(at: number): string {
    if (!at) return '';
    const mins = Math.floor((Date.now() - at) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  private async loadDashboard() {
    // Packages feed BOTH the schedule and the attention panel, so they're
    // fetched once here rather than once per section.
    let packages: PackageRecord[] = [];
    try {
      packages = await this.firebase.listPackages();
    } catch (err) {
      console.error('Home: packages load failed', err);
    }

    this.buildSchedule(packages);
    this.buildAttention(packages);
    this.buildScoreUpdates();
  }

  private async buildSchedule(packages: PackageRecord[]) {
    this.loadingSchedule = true;
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      const [overrides, singleSessions] = await Promise.all([
        this.firebase.listSessionOverrides(),
        this.firebase.listSingleSessions()
      ]);
      this.todaySchedule = generateScheduleForRange(packages, start, end, overrides, singleSessions)
        .sort((a, b) => a.time.localeCompare(b.time));
    } catch (err) {
      console.error('Home: schedule load failed', err);
    } finally {
      this.loadingSchedule = false;
    }
  }

  private async buildAttention(packages: PackageRecord[]) {
    this.loadingAttention = true;
    const items: AttentionItem[] = [];

    const active = packages.filter(p => p.status === 'active');

    // Running out of sessions → a renewal conversation to have now, not
    // after the client has already stopped coming.
    for (const pkg of active) {
      const left = pkg.sessionsRemaining ?? 0;
      if (left > 2) continue;
      const who = (pkg.linkedClientNames || []).join(', ') || pkg.packageName || 'Unnamed package';
      items.push({
        kind: 'low',
        label: who,
        detail: left === 0 ? 'No sessions left' : `${left} session${left === 1 ? '' : 's'} left`,
        link: '/packages'
      });
    }

    // Outstanding balances, summed per package across its linked clients.
    for (const pkg of active) {
      let owed = 0;
      for (const cid of pkg.linkedClientIds || []) {
        const payment = pkg.clientPayments?.[cid];
        if (!payment || payment.paid) continue;
        owed += Math.max(0, (payment.amount ?? 0) - (payment.amountPaid ?? 0));
      }
      if (owed <= 0) continue;
      const who = (pkg.linkedClientNames || []).join(', ') || pkg.packageName || 'Unnamed package';
      items.push({
        kind: 'unpaid',
        label: who,
        detail: `$${owed.toFixed(0)} outstanding`,
        link: '/packages'
      });
    }

    try {
      const [assessments, links] = await Promise.all([
        this.firebase.listPendingAssessments(),
        this.firebase.listPendingLinkRequests()
      ]);
      const total = assessments.length + links.length;
      if (total > 0) {
        items.push({
          kind: 'review',
          label: 'Waiting on your review',
          detail: `${total} submission${total === 1 ? '' : 's'}`,
          link: '/pending-assessments'
        });
      }
    } catch (err) {
      console.error('Home: pending review load failed', err);
    }

    // Review items first (fastest to clear), then low sessions, then money.
    const order: Record<AttentionItem['kind'], number> = { review: 0, low: 1, unpaid: 2 };
    this.attention = items.sort((a, b) => order[a.kind] - order[b.kind]);
    this.loadingAttention = false;
  }

  // Every approved assessment, turned into "whose score moved, and by how
  // much". The delta needs each athlete's PREVIOUS assessment, so the list
  // is grouped by athlete and walked oldest-first before being flattened
  // back into one newest-first feed.
  private async buildScoreUpdates() {
    this.loadingScores = true;
    try {
      const all = await this.firebase.listAllAssessments();

      const byAthlete = new Map<string, typeof all>();
      for (const a of all) {
        const key = a.nameKey || a.clientName;
        if (!key) continue;
        const list = byAthlete.get(key) || [];
        list.push(a);
        byAthlete.set(key, list);
      }

      const updates: ScoreUpdate[] = [];
      for (const list of byAthlete.values()) {
        const ordered = [...list].sort(
          (x, y) => parseWhen(x.timestamp) - parseWhen(y.timestamp)
        );
        ordered.forEach((a, i) => {
          const at = parseWhen(a.timestamp);
          if (!at) return;
          const prev = i > 0 ? ordered[i - 1] : null;
          updates.push({
            clientName: a.clientName,
            lvl: Math.max(1, Math.round(a.lvl)),
            rank: a.rank,
            delta: prev ? Math.round(a.lvl) - Math.round(prev.lvl) : null,
            at
          });
        });
      }

      this.scoreUpdates = updates.sort((a, b) => b.at - a.at).slice(0, 8);
    } catch (err) {
      console.error('Home: score updates load failed', err);
    } finally {
      this.loadingScores = false;
    }
  }

  openKeypad() {
    this.authService.requestKeypad();
  }
}
