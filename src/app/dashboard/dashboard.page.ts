import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  analyticsOutline,
  peopleOutline,
  cubeOutline,
  logInOutline,
  alertCircleOutline,
  timeOutline,
  calendarOutline,
  pulseOutline,
  checkmarkCircle
} from 'ionicons/icons';
import { FirebaseService, PackageRecord, ClientProfile, CheckIn, localDateString } from '../services/firebase.service';
import {
  ScheduleEntry,
  generateScheduleForRange,
  startOfWeek,
  addDays,
  formatTime12h
} from '../services/schedule.util';

interface DayBar {
  label: string;
  count: number;
  pct: number;     // 0-100 bar height
  isToday: boolean;
}

interface PackageAlert {
  packageName: string;
  clientNames: string;
  detail: string;
  level: 'warn' | 'danger';
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, RouterModule]
})
export class DashboardPage implements OnInit, OnDestroy {
  loading = true;
  clock = '';
  dateLabel = '';

  packages: PackageRecord[] = [];
  clients: ClientProfile[] = [];
  todayCheckIns: CheckIn[] = [];
  weekCheckIns: CheckIn[] = [];
  todayEntries: ScheduleEntry[] = [];
  weekBars: DayBar[] = [];
  alerts: PackageAlert[] = [];

  private clockTimer: any = null;
  private refreshTimer: any = null;

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({
      arrowBack,
      analyticsOutline,
      peopleOutline,
      cubeOutline,
      logInOutline,
      alertCircleOutline,
      timeOutline,
      calendarOutline,
      pulseOutline,
      checkmarkCircle
    });
  }

  async ngOnInit() {
    this.tickClock();
    this.clockTimer = setInterval(() => this.tickClock(), 1000);
    await this.loadAll();
    this.loading = false;
    this.refreshTimer = setInterval(() => this.loadAll(), 60 * 1000);
  }

  ngOnDestroy() {
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  private tickClock() {
    const now = new Date();
    this.clock = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    this.dateLabel = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  async loadAll() {
    const today = new Date();
    const weekStart = startOfWeek(today);
    const weekKeys = Array.from({ length: 7 }, (_, i) => localDateString(addDays(weekStart, i)));

    try {
      const [packages, clients, weekCheckIns] = await Promise.all([
        this.firebase.listPackages(),
        this.firebase.listClientProfiles(),
        this.firebase.getCheckInsForDates(weekKeys)
      ]);
      this.packages = packages;
      this.clients = clients;
      this.weekCheckIns = weekCheckIns;
      const todayKey = localDateString(today);
      this.todayCheckIns = weekCheckIns
        .filter(c => c.date === todayKey)
        .sort((a, b) => b.checkInTime.localeCompare(a.checkInTime));
      this.todayEntries = generateScheduleForRange(packages, today, today);
      this.buildWeekBars(weekKeys, todayKey);
      this.buildAlerts();
    } catch (err) {
      console.error('Dashboard: load failed', err);
    }
  }

  private buildWeekBars(weekKeys: string[], todayKey: string) {
    const counts = weekKeys.map(key => this.weekCheckIns.filter(c => c.date === key).length);
    const max = Math.max(1, ...counts);
    const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    this.weekBars = weekKeys.map((key, i) => ({
      label: labels[i],
      count: counts[i],
      pct: Math.round((counts[i] / max) * 100),
      isToday: key === todayKey
    }));
  }

  private buildAlerts() {
    const alerts: PackageAlert[] = [];
    const todayKey = localDateString();
    const soonKey = localDateString(addDays(new Date(), 14));

    for (const pkg of this.packages) {
      if (pkg.status !== 'active') continue;
      const names = (pkg.linkedClientNames || []).join(', ') || 'No client linked';
      const remaining = pkg.sessionsRemaining ?? pkg.totalSessions ?? 0;

      if (remaining === 0) {
        alerts.push({ packageName: pkg.packageName, clientNames: names, detail: 'No sessions left', level: 'danger' });
      } else if (remaining <= 2) {
        alerts.push({
          packageName: pkg.packageName,
          clientNames: names,
          detail: `${remaining} session${remaining === 1 ? '' : 's'} left`,
          level: 'warn'
        });
      }

      const exp = (pkg.expirationDate || '').slice(0, 10);
      if (exp && exp >= todayKey && exp <= soonKey) {
        alerts.push({
          packageName: pkg.packageName,
          clientNames: names,
          detail: `Ends ${new Date(exp + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          level: 'warn'
        });
      }
    }

    for (const c of this.todayCheckIns) {
      if (!c.decremented) {
        alerts.push({
          packageName: c.clientName,
          clientNames: 'Checked in without an active package',
          detail: formatToTime(c.checkInTime),
          level: 'danger'
        });
      }
    }

    this.alerts = alerts.slice(0, 12);
  }

  // ---------- template helpers ----------
  get expectedTodayCount(): number {
    const names = new Set<string>();
    this.todayEntries.forEach(e => e.clientNames.forEach(n => names.add(n.trim().toLowerCase())));
    return names.size;
  }

  get activeClientCount(): number {
    return this.clients.filter(c => (c.currentStatus || 'active') === 'active').length;
  }

  get activePackageCount(): number {
    return this.packages.filter(p => p.status === 'active').length;
  }

  get weekVisitCount(): number {
    return this.weekCheckIns.length;
  }

  isClientCheckedIn(entry: ScheduleEntry, clientName: string): boolean {
    const nameKey = clientName.trim().toLowerCase();
    return this.todayCheckIns.some(c =>
      c.clientName.trim().toLowerCase() === nameKey ||
      (!!c.clientId && entry.clientIds.includes(c.clientId))
    );
  }

  formatEntryTime(time: string): string {
    return formatTime12h(time) || 'TBD';
  }

  formatCheckInTime(iso: string): string {
    return formatToTime(iso);
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }
}

function formatToTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
