import { Component, OnDestroy, OnInit } from '@angular/core';
import { IonApp, IonRouterOutlet, IonIcon, IonModal } from '@ionic/angular/standalone';
import { RouterModule, Router, ActivatedRoute, NavigationEnd } from '@angular/router';
import { CommonModule, Location } from '@angular/common';
import { AuthService, Trainer } from './services/auth.service';
import { ProgramReviewCountService } from './services/program-review-count.service';
import { FirebaseService } from './services/firebase.service';
import { CalendarSyncService } from './services/calendar-sync.service';
import { TopBarActionService, TopBarAction } from './services/top-bar-action.service';
import { addIcons } from 'ionicons';
import {
  lockClosedOutline,
  keypadOutline,
  homeOutline,
  megaphoneOutline,
  trophyOutline,
  trashOutline,
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
  menuOutline,
  arrowBack,
  addOutline
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

  // Mobile nav: the persistent sidebar becomes a slide-in overlay drawer
  // below the phone breakpoint (see app.component.scss) — this is just
  // whether that drawer is open. Desktop/tablet never reads this.
  mobileMenuOpen = false;

  // The mobile top bar's title — the ACTUAL page title (from the active
  // route's data.title, see app.routes.ts), not a static "Project [000]"
  // repeated on every page. Each page's own on-screen title is hidden on
  // mobile (see each page's own stylesheet) specifically because this bar
  // now carries it instead — one title, not two stacked on top of each
  // other. Home has no title of its own, so it keeps the brand name here.
  pageTitle = 'Project [000]';

  // Home is the only screen with nowhere to "go back" to — everywhere else
  // the top bar's left button is a back arrow (same job each page's own
  // now-hidden back button used to do), and the hamburger/full nav drawer
  // moves to being Home-only. One consistent way in, one consistent way
  // back, instead of both existing on every page at once.
  isHomeRoute = true;

  // A page's own "+ New X" action, relocated into the top bar's right side
  // instead of living in its own header row below — see
  // TopBarActionService's comment for the set/clear contract pages follow.
  topBarAction: TopBarAction | null = null;

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
    private activatedRoute: ActivatedRoute,
    private location: Location,
    private topBarActionService: TopBarActionService,
    private calendarSync: CalendarSyncService,
    public programReviews: ProgramReviewCountService
  ) {
    addIcons({
      lockClosedOutline,
      keypadOutline,
      homeOutline,
      megaphoneOutline,
      trophyOutline,
      trashOutline,
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
      menuOutline,
      arrowBack,
      addOutline
    });
  }

  ngOnInit() {
    // A mouse wheel over a focused number input changes its value in
    // Chrome/Safari instead of scrolling the page — easy to trigger by
    // accident while scrolling past the Assessments form, and it silently
    // nudges a score with no visual warning. Blurring the input on wheel
    // stops that: the same event that would have incremented it instead
    // drops focus, so the page scrolls normally from then on. Passive
    // (never blocks the actual scroll) and global (every number input in
    // the app, not just Assessments — the failure mode is identical
    // anywhere a number field sits in a scrolling page).
    document.addEventListener('wheel', () => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement && el.type === 'number') el.blur();
    }, { passive: true });

    this.authService.isAuthenticated$.subscribe(isAuth => {
      this.isAuthenticated = isAuth;
      if (isAuth) this.refreshPendingReviewCount();
    });
    this.authService.currentTrainer$.subscribe(t => this.currentTrainer = t);
    this.authService.keypadRequest$.subscribe(() => this.openKeypad());
    this.pendingReviewInterval = setInterval(() => {
      if (this.isAuthenticated) this.refreshPendingReviewCount();
    }, 60000);
    this.router.events.subscribe(event => {
      if (!(event instanceof NavigationEnd)) return;
      // Walk to the deepest activated route — data.title lives on the
      // leaf route (app.routes.ts), never on the root.
      let route = this.activatedRoute;
      while (route.firstChild) route = route.firstChild;
      this.pageTitle = route.snapshot.data['title'] || 'Project [000]';
      const goingHome = event.urlAfterRedirects === '/home' || event.urlAfterRedirects === '/';
      this.isHomeRoute = goingHome;
      // Tapping a link closes the drawer while it takes you to that page —
      // but landing back on Home (via the top bar's back arrow, same as
      // any other back navigation) reopens it instead of leaving you
      // looking at a plain Home screen with no obvious way back into the
      // drawer you were just using.
      this.mobileMenuOpen = goingHome;
    });
    this.topBarActionService.action$.subscribe(action => { this.topBarAction = action; });
  }

  toggleMobileMenu() {
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }

  closeMobileMenu() {
    this.mobileMenuOpen = false;
  }

  // The top bar's one left-side button: opens the nav drawer on Home
  // (nowhere to go "back" to there), goes back everywhere else. Plain
  // browser-history back rather than each page's own bespoke goBack() —
  // pages are almost always reached by tapping into them from wherever
  // makes sense, so history already points to the right place, and one
  // generic implementation is what makes it possible for the app shell
  // (which doesn't know any given page's "back" destination) to own this
  // button at all.
  onTopBarLeftButton() {
    if (this.isHomeRoute) this.toggleMobileMenu();
    else this.location.back();
  }

  ngOnDestroy() {
    if (this.pendingReviewInterval) clearInterval(this.pendingReviewInterval);
  }

  // Counts everything the Pending page shows — assessment submissions,
  // link requests, and swap requests — so the sidebar badge matches what's
  // actually waiting instead of just one of the three queues.
  private async refreshPendingReviewCount() {
    this.programReviews.refresh();
    try {
      const [assessments, links, swaps] = await Promise.all([
        this.firebase.listPendingAssessments(),
        this.firebase.listPendingLinkRequests(),
        this.firebase.listSwapRequests()
      ]);
      this.pendingReviewCount =
        assessments.length + links.length + swaps.filter(r => r.status === 'pending').length;
    } catch (err) {
      console.error('Nav: pending review count failed', err);
    }
  }

  lockApp() {
    this.authService.logout();
    // Back to the check-in screen, not the (now keypad-only) kiosk home —
    // this device sits on check-in at rest.
    this.router.navigate(['/signin']);
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
