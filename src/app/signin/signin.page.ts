import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  searchOutline,
  checkmarkCircle,
  closeOutline,
  arrowUndoOutline,
  alertCircleOutline,
  heartOutline,
  chevronBackOutline,
  logInOutline
} from 'ionicons/icons';
import {
  FirebaseService,
  ClientProfile,
  PackageRecord,
  CheckIn,
  WellnessData,
  localDateString
} from '../services/firebase.service';

type KioskView = 'roster' | 'confirm' | 'success' | 'already' | 'wellness' | 'wellnessDone';

interface WellnessQuestion {
  question: string;
  type: 'scale' | 'yesno';
  property: keyof WellnessData;
}

@Component({
  selector: 'app-signin',
  templateUrl: './signin.page.html',
  styleUrls: ['./signin.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class SigninPage implements OnInit, OnDestroy {
  view: KioskView = 'roster';
  loading = true;
  loadError = false;

  clients: ClientProfile[] = [];
  packages: PackageRecord[] = [];
  todayCheckIns: CheckIn[] = [];

  searchQuery = '';

  // selection state
  selectedClient: ClientProfile | null = null;
  selectedPackage: PackageRecord | null = null;
  existingCheckIn: CheckIn | null = null;
  lastCheckIn: CheckIn | null = null;
  checkingIn = false;

  // success screen auto-return
  countdown = 0;
  private countdownTimer: any = null;
  private refreshTimer: any = null;

  // wellness
  wellnessIndex = 0;
  wellnessData: Partial<WellnessData> = {};
  wellnessQuestions: WellnessQuestion[] = [
    { question: 'How was your sleep last night?', type: 'scale', property: 'sleepQuality' },
    { question: 'How is your energy level today?', type: 'scale', property: 'energyLevel' },
    { question: 'How stressed do you feel right now?', type: 'scale', property: 'stressLevel' },
    { question: 'Did you eat nutritious food today?', type: 'yesno', property: 'ateHealthy' },
    { question: 'Did you drink enough water today?', type: 'yesno', property: 'drankWater' }
  ];
  scaleValues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  constructor(private firebase: FirebaseService, private router: Router) {
    addIcons({
      arrowBack,
      searchOutline,
      checkmarkCircle,
      closeOutline,
      arrowUndoOutline,
      alertCircleOutline,
      heartOutline,
      chevronBackOutline,
      logInOutline
    });
  }

  async ngOnInit() {
    await this.loadData();
    // Kiosk stays open all day — refresh roster data periodically.
    this.refreshTimer = setInterval(() => {
      if (this.view === 'roster') this.loadData(true);
    }, 5 * 60 * 1000);
  }

  ngOnDestroy() {
    this.clearCountdown();
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async loadData(silent = false) {
    if (!silent) this.loading = true;
    this.loadError = false;
    try {
      const [clients, packages, todayCheckIns] = await Promise.all([
        this.firebase.listClientProfiles(),
        this.firebase.listPackages(),
        this.firebase.getCheckInsForDate(localDateString())
      ]);
      this.clients = clients
        .filter(c => (c.currentStatus || 'active') !== 'inactive')
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
      this.packages = packages;
      this.todayCheckIns = todayCheckIns;
    } catch (err) {
      console.error('Kiosk: failed to load data', err);
      this.loadError = true;
    } finally {
      this.loading = false;
    }
  }

  get filteredClients(): ClientProfile[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.clients;
    return this.clients.filter(c => c.fullName.toLowerCase().includes(q));
  }

  initials(name: string): string {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0].toUpperCase())
      .join('');
  }

  isCheckedInToday(client: ClientProfile): boolean {
    return !!this.findTodayCheckIn(client);
  }

  private findTodayCheckIn(client: ClientProfile): CheckIn | undefined {
    const nameKey = client.fullName.trim().toLowerCase();
    return this.todayCheckIns.find(c =>
      (client.id && c.clientId === client.id) ||
      c.clientName.trim().toLowerCase() === nameKey
    );
  }

  // Active package the session will be deducted from: prefer ones with sessions
  // left, soonest expiration first so older packages get used up before new ones.
  private pickPackage(client: ClientProfile): PackageRecord | null {
    const nameKey = client.fullName.trim().toLowerCase();
    const todayKey = localDateString();
    const linked = this.packages.filter(p => {
      if (p.status !== 'active') return false;
      const byId = !!client.id && (p.linkedClientIds || []).includes(client.id);
      const byName = (p.linkedClientNames || []).some(n => n.trim().toLowerCase() === nameKey);
      if (!byId && !byName) return false;
      if (p.expirationDate && p.expirationDate.slice(0, 10) < todayKey) return false;
      return true;
    });
    if (linked.length === 0) return null;

    const byExpiration = (a: PackageRecord, b: PackageRecord) =>
      (a.expirationDate || '9999').localeCompare(b.expirationDate || '9999');
    const withSessions = linked
      .filter(p => (p.sessionsRemaining ?? p.totalSessions ?? 0) > 0)
      .sort(byExpiration);
    return withSessions[0] || linked.sort(byExpiration)[0];
  }

  selectClient(client: ClientProfile) {
    const existing = this.findTodayCheckIn(client);
    this.selectedClient = client;
    if (existing) {
      this.existingCheckIn = existing;
      this.view = 'already';
      return;
    }
    this.selectedPackage = this.pickPackage(client);
    this.view = 'confirm';
  }

  get confirmPackageLabel(): string {
    const pkg = this.selectedPackage;
    if (!pkg) return '';
    const remaining = pkg.sessionsRemaining ?? pkg.totalSessions ?? 0;
    return `${pkg.packageName} · ${remaining} session${remaining === 1 ? '' : 's'} left`;
  }

  get selectedPackageHasSessions(): boolean {
    const pkg = this.selectedPackage;
    return !!pkg && (pkg.sessionsRemaining ?? pkg.totalSessions ?? 0) > 0;
  }

  async confirmCheckIn() {
    if (!this.selectedClient || this.checkingIn) return;
    this.checkingIn = true;
    try {
      const record = await this.firebase.checkInClient(
        { id: this.selectedClient.id, fullName: this.selectedClient.fullName },
        this.selectedPackage
      );
      this.lastCheckIn = record;
      this.todayCheckIns = [record, ...this.todayCheckIns];
      this.view = 'success';
      this.startCountdown(9);
    } catch (err) {
      console.error('Kiosk: check-in failed', err);
      alert('Something went wrong — please try again or ask at the front desk.');
    } finally {
      this.checkingIn = false;
    }
  }

  async undoLastCheckIn() {
    if (!this.lastCheckIn) return;
    this.clearCountdown();
    try {
      await this.firebase.undoCheckIn(this.lastCheckIn);
      this.todayCheckIns = this.todayCheckIns.filter(c => c.id !== this.lastCheckIn!.id);
      // restore the local package counter
      if (this.lastCheckIn.decremented && this.selectedPackage) {
        this.selectedPackage.sessionsRemaining =
          (this.selectedPackage.sessionsRemaining ?? 0) + 1;
      }
    } catch (err) {
      console.error('Kiosk: undo failed', err);
    }
    this.lastCheckIn = null;
    this.backToRoster();
  }

  startWellness() {
    if (!this.lastCheckIn) return;
    this.clearCountdown();
    this.wellnessIndex = 0;
    this.wellnessData = {
      studentName: this.lastCheckIn.clientName,
      sessionId: this.lastCheckIn.id || '',
      date: this.lastCheckIn.date,
      checkInTime: this.lastCheckIn.checkInTime
    };
    this.view = 'wellness';
  }

  answerScale(value: number) {
    (this.wellnessData as any)[this.wellnessQuestions[this.wellnessIndex].property] = value;
    this.nextWellness();
  }

  answerYesNo(value: boolean) {
    (this.wellnessData as any)[this.wellnessQuestions[this.wellnessIndex].property] = value;
    this.nextWellness();
  }

  wellnessAnswer(): any {
    return (this.wellnessData as any)[this.wellnessQuestions[this.wellnessIndex].property];
  }

  previousWellness() {
    if (this.wellnessIndex > 0) this.wellnessIndex--;
  }

  private async nextWellness() {
    if (this.wellnessIndex < this.wellnessQuestions.length - 1) {
      this.wellnessIndex++;
      return;
    }
    try {
      await this.firebase.saveWellnessData(this.wellnessData as WellnessData);
    } catch (err) {
      console.error('Kiosk: wellness save failed', err);
    }
    this.view = 'wellnessDone';
    this.startCountdown(4);
  }

  backToRoster() {
    this.clearCountdown();
    this.view = 'roster';
    this.searchQuery = '';
    this.selectedClient = null;
    this.selectedPackage = null;
    this.existingCheckIn = null;
    this.lastCheckIn = null;
    this.wellnessData = {};
    this.loadData(true);
  }

  cancelConfirm() {
    this.view = 'roster';
    this.selectedClient = null;
    this.selectedPackage = null;
  }

  private startCountdown(seconds: number) {
    this.clearCountdown();
    this.countdown = seconds;
    this.countdownTimer = setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0) {
        this.backToRoster();
      }
    }, 1000);
  }

  private clearCountdown() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.countdown = 0;
  }

  goHome() {
    this.router.navigate(['/home']);
  }

  formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  get firstName(): string {
    return (this.selectedClient?.fullName || '').split(/\s+/)[0] || '';
  }
}
