import { Component, OnDestroy, OnInit } from '@angular/core';
import { IonApp, IonRouterOutlet, IonIcon, IonModal } from '@ionic/angular/standalone';
import { RouterModule, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService, Trainer } from './services/auth.service';
import { FirebaseService } from './services/firebase.service';
import { CalendarSyncService } from './services/calendar-sync.service';
import { addIcons } from 'ionicons';
import {
  lockClosedOutline,
  keypadOutline,
  homeOutline,
  analyticsOutline,
  calendarOutline,
  peopleOutline,
  fitnessOutline,
  cubeOutline,
  chevronForwardOutline,
  listOutline,
  logInOutline,
  chatbubblesOutline,
  documentTextOutline,
  close,
  backspaceOutline,
  pulseOutline,
  trendingUpOutline,
  notificationsOutline,
  personCircleOutline,
  menuOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-root',
  templateUrl: 'app.component.html',
  styleUrls: ['app.component.scss'],
  imports: [IonApp, IonRouterOutlet, IonIcon, IonModal, RouterModule, CommonModule],
})
export class AppComponent implements OnInit, OnDestroy {
  isAuthenticated = false;
  currentTrainer: Trainer | null = null;

  // Admin PIN keypad (hosted here so it can open from anywhere)
  keypadOpen = false;
  enteredCode = '';
  showError = false;

  // Count of mobile-submitted benchmark PRs awaiting coach review, shown as
  // a nav badge. No live listeners exist anywhere in this app yet, so this
  // just polls on the same one-time-read pattern everything else here uses.
  pendingReviewCount = 0;
  private pendingReviewInterval: ReturnType<typeof setInterval> | null = null;

  // calendarSync is injected purely so it EXISTS for the whole session, not
  // to be called from here. It's providedIn: 'root', so Angular only
  // constructs it on first injection — and its constructor is what
  // subscribes to FirebaseService.scheduleDataChanged$. Without this, a
  // coach who opened the app straight to Packages and saved would get no
  // calendar sync at all, because nothing had ever instantiated the
  // service. Don't "clean up" this seemingly-unused dependency.
  constructor(
    private authService: AuthService,
    private firebase: FirebaseService,
    private router: Router,
    private calendarSync: CalendarSyncService
  ) {
    addIcons({
      lockClosedOutline,
      keypadOutline,
      homeOutline,
      analyticsOutline,
      calendarOutline,
      peopleOutline,
      fitnessOutline,
      cubeOutline,
      chevronForwardOutline,
      listOutline,
      logInOutline,
      chatbubblesOutline,
      documentTextOutline,
      close,
      backspaceOutline,
      pulseOutline,
      trendingUpOutline,
      notificationsOutline,
      personCircleOutline,
      menuOutline
    });
  }

  ngOnInit() {
    this.authService.isAuthenticated$.subscribe(isAuth => {
      this.isAuthenticated = isAuth;
      if (isAuth) this.refreshPendingReviewCount();
    });
    this.authService.currentTrainer$.subscribe(t => this.currentTrainer = t);
    this.authService.keypadRequest$.subscribe(() => this.openKeypad());
    this.pendingReviewInterval = setInterval(() => {
      if (this.isAuthenticated) this.refreshPendingReviewCount();
    }, 60000);
  }

  ngOnDestroy() {
    if (this.pendingReviewInterval) clearInterval(this.pendingReviewInterval);
  }

  private async refreshPendingReviewCount() {
    try {
      this.pendingReviewCount = (await this.firebase.listPendingAssessments()).length;
    } catch (err) {
      console.error('Nav: pending review count failed', err);
    }
  }

  lockApp() {
    this.authService.logout();
    this.router.navigate(['/home']);
  }

  openKeypad() {
    this.keypadOpen = true;
    this.enteredCode = '';
    this.showError = false;
  }

  closeKeypad() {
    this.keypadOpen = false;
    this.enteredCode = '';
    this.showError = false;
  }

  onKeypadPress(value: number | string | null) {
    if (value === null) return;

    if (value === 'clear') {
      this.enteredCode = this.enteredCode.slice(0, -1);
      this.showError = false;
      return;
    }

    if (this.enteredCode.length < 4) {
      this.enteredCode += value.toString();
      if (this.enteredCode.length === 4) {
        this.checkCode();
      }
    }
  }

  private checkCode() {
    if (this.authService.verifyPin(this.enteredCode)) {
      this.closeKeypad();
    } else {
      this.showError = true;
      setTimeout(() => {
        this.enteredCode = '';
        this.showError = false;
      }, 1200);
    }
  }
}
