import { Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  IonButtons,
  IonButton,
  IonIcon,
  IonInput,
  IonSelect,
  IonSelectOption,
  IonItem,
  IonList,
  IonPopover,
  IonDatetime,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, cubeOutline, calculatorOutline, calendarOutline, peopleOutline, pricetagOutline, timeOutline, ellipsisVertical, chevronBackOutline, chevronForwardOutline, chevronDownOutline, alertCircle, closeOutline, downloadOutline, refreshOutline, reorderTwoOutline, arrowUndoOutline } from 'ionicons/icons';
import { Router } from '@angular/router';
import { FirebaseService, ClientProfile, PackageRecord, ClientPayment, SessionOverride, localDateString, CheckIn, AttendanceStatus } from '../services/firebase.service';
import { ToastController } from '@ionic/angular/standalone';
import { generateScheduleForRange, startOfWeek, addDays, countScheduledOccurrences, projectPackageEnd, usesStoredSessions, planMigration, formatTime12h, ScheduleEntry } from '../services/schedule.util';
import { SessionDrag } from '../services/session-drag';
import { postponeBillingForExcuse } from '../services/payments.config';
import { TRAINERS } from '../services/auth.service';
import { TopBarActionService } from '../services/top-bar-action.service';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

type SessionType = 'Private' | 'Semi' | 'Group';
type PackageStatus = 'active' | 'completed' | 'prospect';
type CalendarMonthCount = 1 | 2 | 3 | 4;

interface CalendarDot {
  packageId: string;
  name: string;
  color: string;
}

interface CalendarDay {
  dateKey: string;
  dayNum: number;
  inMonth: boolean;
  isToday: boolean;
  dots: CalendarDot[];
}

interface CalendarMonth {
  label: string;
  weeks: CalendarDay[][];
}

interface LegendPackage {
  id: string;
  name: string;
  color: string;
  visible: boolean;
}

// Distinct, dark-theme-legible hues — cycles if there are more packages than colors.
const CLIENT_PALETTE = [
  '#00d4ff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff',
  '#f72585', '#4cc9f0', '#f9844a', '#90be6d', '#e63946',
  '#8ecae6', '#ffb703', '#43aa8b', '#a685e2', '#ef476f', '#118ab2'
];

interface PackageForm {
  packageId: string;
  packageName: string;
  linkedClients: string[]; // placeholder until wired to clients list
  sessionType: SessionType;
  sessionDurationMinutes: number;
  sessionsPerWeek: number;
  packageDuration: number; // months
  totalSessions: number;
  sessionsRemaining?: number;
  daysOfWeek: string[];
  dayTimes?: { [day: string]: string };
  cost: number;
  purchaseDate?: string; // ISO
  expirationDate?: string; // ISO
  status: PackageStatus;
}

// One date on a package's session calendar. attended/missed/excused come
// from attendance records; upcoming/unrecorded are scheduled dates with no
// record yet (future / past); unlinked is a client of this package checking
// in that day with no package attached, so it counted toward nothing.
type CalStatus = 'attended' | 'missed' | 'excused' | 'upcoming' | 'unrecorded' | 'unlinked';

interface CalDay {
  dateKey: string;
  label: string;
  time: string;
  status: CalStatus;
  clients: { name: string; status: string }[];
  note?: string;
  entry?: ScheduleEntry;  // the scheduled session on this date, if there is one
  movable?: boolean;      // scheduled, with no attendance filed on it yet
  // Records left on a session's old date after it was moved to movedTo,
  // where attendance was taken too — the same session counted twice.
  movedTo?: string;
}

// One client's attendance row in the selected date's editor.
interface CalClientRow {
  key: string;
  id: string | null;
  name: string;
  status: AttendanceStatus | 'none';
  unlinked: boolean;      // checked in that day, but with no package attached
}

function sameClient(r: CheckIn, c: { id: string | null; name: string }): boolean {
  return (!!r.clientId && !!c.id && r.clientId === c.id) ||
    r.clientName.trim().toLowerCase() === c.name.trim().toLowerCase();
}

const CAL_COLORS: Record<CalStatus, string> = {
  attended: '#06d6a0',
  missed: '#ff5d6c',
  excused: '#f5b942',
  upcoming: '#00d4ff',
  unrecorded: '#6b8499',
  unlinked: '#a78bfa'
};

const CAL_LABELS: Record<CalStatus, string> = {
  attended: 'Attended',
  missed: 'Missed',
  excused: 'Excused',
  upcoming: 'Upcoming',
  unrecorded: 'No record',
  unlinked: 'Not counted'
};

@Component({
  selector: 'app-packages',
  templateUrl: './packages.page.html',
  styleUrls: ['./packages.page.scss'],
  standalone: true,
  imports: [
    IonDatetime,
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonButtons,
    IonButton,
    IonIcon,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonItem,
    IonList,
    IonPopover,
    CommonModule,
    FormsModule
  ]
})
export class PackagesPage implements OnInit, OnDestroy {
  searchQuery = '';
  clients: ClientProfile[] = [];
  packages: PackageRecord[] = [];
  tableStatusFilter: 'all' | PackageStatus = 'active';

  get filteredPackages(): PackageRecord[] {
    if (this.tableStatusFilter === 'all') return this.packages;
    return this.packages.filter(p => p.status === this.tableStatusFilter);
  }

  setTableStatusFilter(status: 'all' | PackageStatus) {
    this.tableStatusFilter = status;
  }

  // add row buffer
  newPackage: PackageForm = {
    packageId: '',
    packageName: 'Standard Training',
    linkedClients: [],
    sessionType: 'Private',
    sessionDurationMinutes: 60,
    sessionsPerWeek: 1,
    packageDuration: 1,
    totalSessions: 4,
    daysOfWeek: [],
    dayTimes: {},
    cost: 0,
    status: 'active'
  };

  daysOfWeekOptions = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  trainers = TRAINERS;

  // ---------- Shared row popovers ----------
  // One popover instance per TYPE (times/cost/actions), reused across every
  // row, instead of one per row. With ~20 packages that was ~60 eagerly
  // mounted <ion-popover> web components on page load — each a full Stencil
  // component with its own overlay/animation lifecycle — which was heavy
  // enough to stall Angular's renderer and Ionic's page-transition on this
  // page specifically (nowhere else in the app has this many overlays per
  // page). Presenting a single shared popover programmatically, pointed at
  // whichever row was clicked, does the same job for a fraction of the cost.
  @ViewChild('timesPopover') timesPopoverRef?: IonPopover;
  @ViewChild('costPopover') costPopoverRef?: IonPopover;
  @ViewChild('actionsPopover') actionsPopoverRef?: IonPopover;
  activeTimesPkg: PackageRecord | null = null;
  activeTimesIndex = 0;
  activeCostPkg: PackageRecord | null = null;
  activeActionsPkg: PackageRecord | null = null;

  openTimesPopover(ev: Event, pkg: PackageRecord, i: number) {
    this.activeTimesPkg = pkg;
    this.activeTimesIndex = i;
    this.timesPopoverRef?.present(ev as any);
  }

  openCostPopover(ev: Event, pkg: PackageRecord) {
    this.activeCostPkg = pkg;
    this.costPopoverRef?.present(ev as any);
  }

  openActionsPopover(ev: Event, pkg: PackageRecord) {
    this.activeActionsPkg = pkg;
    this.actionsPopoverRef?.present(ev as any);
  }

  // ---------- Receipt / invoice PDF ----------
  pdfOpen = false;
  private pdfPackage: PackageRecord | null = null;
  private pdfClientId: string | null = null;
  @ViewChild('receiptPdfPage') pdfPage?: ElementRef<HTMLDivElement>;
  @ViewChild('receiptPdfScaleWrap') pdfScaleWrap?: ElementRef<HTMLDivElement>;
  @ViewChild('receiptPdfScroll') pdfScroll?: ElementRef<HTMLDivElement>;

  // ---------- Visual calendar view ----------
  viewMode: 'table' | 'calendar' = 'table';
  calendarMonthCount: CalendarMonthCount = 1;
  calendarCursor: Date = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  calendarMonths: CalendarMonth[] = [];
  legendPackages: LegendPackage[] = [];
  legendOpen = false;
  private overrides: SessionOverride[] = [];
  private hiddenPackageIds = new Set<string>();
  private packageColorMap = new Map<string, string>();
  readonly calendarWeekdayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  constructor(
    private router: Router,
    private firebase: FirebaseService,
    private toastController: ToastController,
    private topBarAction: TopBarActionService,
    private zone: NgZone
  ) {
    addIcons({ arrowBack, cubeOutline, calculatorOutline, calendarOutline, peopleOutline, pricetagOutline, timeOutline, ellipsisVertical, chevronBackOutline, chevronForwardOutline, chevronDownOutline, alertCircle, closeOutline, downloadOutline, refreshOutline, reorderTwoOutline, arrowUndoOutline });
  }

  ngOnInit(): void {
    this.recalculateTotals();
    this.loadData();
    this.syncTopBarAction();
  }

  ngOnDestroy() {
    this.topBarAction.clear();
    this.calDrag.cancel();
  }

  // Only worth showing in table view — a calendar has no "add a row" to
  // create. Called on load and every time the view toggles, rather than
  // just once, so the button actually disappears/reappears with the view
  // instead of staying stuck in whichever state ngOnInit saw first.
  private syncTopBarAction() {
    if (this.viewMode === 'table') {
      this.topBarAction.set({ label: 'New Package', icon: 'cube-outline', onClick: () => this.addNewRow() });
    } else {
      this.topBarAction.clear();
    }
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  onFormChange() {
    this.recalculateTotals();
  }

  private recalculateTotals() {
    const duration = Number(this.newPackage.packageDuration) || 1;
    const totalSessions = (Number(this.newPackage.sessionsPerWeek) || 0) * this.getWeeksFromDuration(duration);
    this.newPackage.totalSessions = totalSessions;
    // final session date ("expiration")
    if (this.newPackage.purchaseDate) {
      const final = this.computeFinalSessionDate(
        new Date(this.newPackage.purchaseDate),
        totalSessions,
        this.newPackage.daysOfWeek as any, // tolerated for new row if present later
        duration
      );
      if (final) this.newPackage.expirationDate = localDateString(final);
    }
  }

  private getWeeksFromDuration(months: number): number {
    return Math.max(1, months) * 4;
  }

  private addMonths(date: Date, months: number): Date {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  // Calculate the final session date: step through `totalSessions` occurrences on
  // the selected weekdays from the start date. `fallbackMonths` is used when no
  // days are selected (null = leave expiration blank, e.g. custom with no days).
  private computeFinalSessionDate(
    startDate: Date,
    totalSessions: number,
    daysOfWeek: string[] | undefined,
    fallbackMonths: number
  ): Date | null {
    if (!daysOfWeek || daysOfWeek.length === 0) {
      return this.addMonths(startDate, fallbackMonths);
    }
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const selected = daysOfWeek
      .map(d => dayMap[d])
      .filter(v => v !== undefined)
      .sort((a,b)=>a-b) as number[];
    if (selected.length === 0) {
      return this.addMonths(startDate, fallbackMonths);
    }

    // Normalize to date-only to avoid TZ drift
    const norm = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let current = norm(startDate);

    const findNextOnOrAfter = (from: Date): Date => {
      const fromDow = from.getDay();
      // find the first selected dow >= fromDow; if none, jump to next week's first selected
      let delta = Number.POSITIVE_INFINITY;
      for (const dow of selected) {
        const off = (dow - fromDow + 7) % 7; // 0 if same day
        if (off < delta) delta = off;
      }
      const next = new Date(from);
      next.setDate(next.getDate() + delta);
      return next;
    };

    const findNextAfter = (from: Date): Date => {
      // strictly after 'from'
      const tmp = new Date(from);
      tmp.setDate(tmp.getDate() + 1);
      return findNextOnOrAfter(tmp);
    };

    // First session on/after purchase date
    let first = findNextOnOrAfter(current);
    // Iterate to the final session. Cap the walk — a bad/huge totalSessions
    // (e.g. a mistyped duration) would otherwise run this loop synchronously
    // into the millions on every single Packages-page load, freezing the
    // whole tab with no error. This is a pure safety cap, not a feature change.
    const MAX_ITERATIONS = 5000; // ~19 years of daily sessions — comfortably past any real package
    const steps = Math.min(Math.max(1, totalSessions), MAX_ITERATIONS);
    let final = new Date(first);
    for (let i = 1; i < steps; i++) {
      final = findNextAfter(final);
    }
    return final;
  }

  async loadData() {
    this.clients = await this.firebase.listClientProfiles();
    const [packages, usedByPackage, excusedByPackage, overrides, marksByPackage] = await Promise.all([
      this.firebase.listPackages(),
      this.firebase.getDecrementedCountsByPackage(),
      this.firebase.getExcusedCountsByPackage(),
      this.firebase.listSessionOverrides(),
      this.firebase.getAttendanceMarksByPackage()
    ]);
    this.packages = packages;
    this.overrides = overrides;
    for (const p of this.packages) {
      if (!p.daysOfWeek) p.daysOfWeek = [] as any;
      if (!p.dayTimes) p.dayTimes = {} as any;
      // Daily-group packages decrement by scheduled day, not by check-in.
      const used = p.dailyGroupProgram
        ? countScheduledOccurrences(p)
        : (p.id ? (usedByPackage.get(p.id) ?? 0) : 0);
      const excused = p.dailyGroupProgram ? 0 : (p.id ? (excusedByPackage.get(p.id) ?? 0) : 0);
      const beforeRemaining = p.sessionsRemaining;
      const beforeExpiration = p.expirationDate;
      const beforeSkips = (p.skipDates || []).join();
      this.recalcRow(p, used, excused);
      if (p.id) this.patternSig.set(p.id, this.patternSignature(p));
      if (p.id && p.purchaseDate) this.savedStart.set(p.id, p.purchaseDate);
      // Stored sessions own their end date (the last booked session) —
      // neither projection below applies to them.
      if (p.bookedSessions) p.expirationDate = beforeExpiration;
      // Weekly packages: the end date comes from attendance (see
      // projectPackageEnd), so an owed session always has a calendar slot.
      // recalcRow's slot-count projection only stands for the rest.
      // Active packages only: a completed or prospect package isn't owed
      // anything on the calendar, and projecting one pushed finished
      // packages' Final Session out to today. For those, recalcRow's own
      // date stands — the same one this page always saved for them.
      const projected = p.id && !p.bookedSessions && p.status === 'active'
        ? projectPackageEnd({ ...p, expirationDate: beforeExpiration }, marksByPackage.get(p.id) || [], overrides)
        : null;
      if (projected) {
        p.expirationDate = projected.expirationDate;
        p.skipDates = projected.skipDates;
      }
      if (p.id && (beforeRemaining !== p.sessionsRemaining || beforeExpiration !== p.expirationDate || beforeSkips !== (p.skipDates || []).join())) {
        await this.firebase.upsertPackage({
          id: p.id,
          packageName: p.packageName,
          totalSessions: p.totalSessions,
          sessionsPerWeek: p.sessionsPerWeek,
          sessionsRemaining: p.sessionsRemaining,
          expirationDate: p.expirationDate,
          skipDates: p.skipDates
        });
      }
    }
    this.buildLegend();
    this.buildCalendar();
  }

  setViewMode(mode: 'table' | 'calendar') {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.syncTopBarAction();
    if (mode === 'calendar') {
      this.buildLegend();
      this.buildCalendar();
    }
  }

  setCalendarMonths(n: CalendarMonthCount) {
    this.calendarMonthCount = n;
    this.buildCalendar();
  }

  calendarPrev() {
    this.calendarCursor = new Date(this.calendarCursor.getFullYear(), this.calendarCursor.getMonth() - this.calendarMonthCount, 1);
    this.buildCalendar();
  }

  calendarNext() {
    this.calendarCursor = new Date(this.calendarCursor.getFullYear(), this.calendarCursor.getMonth() + this.calendarMonthCount, 1);
    this.buildCalendar();
  }

  calendarToday() {
    const now = new Date();
    this.calendarCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    this.buildCalendar();
  }

  toggleLegendOpen() {
    this.legendOpen = !this.legendOpen;
  }

  get visiblePackageCount(): number {
    return this.legendPackages.filter(p => p.visible).length;
  }

  togglePackageVisibility(pkg: LegendPackage) {
    if (this.hiddenPackageIds.has(pkg.id)) {
      this.hiddenPackageIds.delete(pkg.id);
    } else {
      this.hiddenPackageIds.add(pkg.id);
    }
    pkg.visible = !this.hiddenPackageIds.has(pkg.id);
    this.buildCalendar();
  }

  trackByMonth = (_: number, m: CalendarMonth) => m.label;
  trackByDay = (_: number, d: CalendarDay) => d.dateKey;
  trackByLegend = (_: number, p: LegendPackage) => p.id;

  // Every active package gets a dot color, shown/hidden via the checklist. Colors
  // are assigned once per package (stable across toggles/rebuilds), alphabetically.
  private buildLegend() {
    // Completed stays alongside active here — a package finishing shouldn't
    // instantly erase its sessions from the calendar overview. Prospect
    // holds too — matches the 'prospect' status now included in the
    // buildCalendar() generateScheduleForRange call below; without a color
    // mapped here, those entries would generate but render with no dot.
    const active = this.packages
      .filter(p => (p.status === 'active' || p.status === 'completed' || p.status === 'prospect') && (p.id || p.packageId))
      .slice()
      .sort((a, b) => (a.packageName || '').localeCompare(b.packageName || ''));

    this.packageColorMap = new Map(
      active.map((p, i) => [p.id || p.packageId, CLIENT_PALETTE[i % CLIENT_PALETTE.length]])
    );
    this.legendPackages = active.map(p => {
      const id = p.id || p.packageId;
      return {
        id,
        name: p.packageName || 'Untitled Package',
        color: this.packageColorMap.get(id)!,
        visible: !this.hiddenPackageIds.has(id)
      };
    });
  }

  private buildCalendar() {
    const months: CalendarMonth[] = [];
    for (let i = 0; i < this.calendarMonthCount; i++) {
      const monthDate = new Date(this.calendarCursor.getFullYear(), this.calendarCursor.getMonth() + i, 1);
      months.push(this.buildMonthBlock(monthDate));
    }
    this.calendarMonths = months;
  }

  private buildMonthBlock(monthDate: Date): CalendarMonth {
    const gridStart = startOfWeek(monthDate);
    const gridEnd = addDays(gridStart, 41);
    const entries = generateScheduleForRange(this.packages, gridStart, gridEnd, this.overrides, [], ['active', 'completed', 'prospect']);
    const todayKey = localDateString();

    const allDays: CalendarDay[] = [];
    for (let i = 0; i < 42; i++) {
      const date = addDays(gridStart, i);
      const dateKey = localDateString(date);
      const dayEntries = entries.filter(e => e.dateKey === dateKey);

      const seen = new Set<string>();
      const dots: CalendarDot[] = [];
      for (const entry of dayEntries) {
        const packageId = entry.packageId;
        if (!packageId || this.hiddenPackageIds.has(packageId) || seen.has(packageId)) continue;
        const color = this.packageColorMap.get(packageId);
        if (!color) continue; // not a "current" (active) package — skip
        seen.add(packageId);
        dots.push({ packageId, name: entry.packageName || 'Package', color });
      }

      allDays.push({
        dateKey,
        dayNum: date.getDate(),
        inMonth: date.getMonth() === monthDate.getMonth(),
        isToday: dateKey === todayKey,
        dots
      });
    }

    const weeks: CalendarDay[][] = [];
    for (let i = 0; i < 42; i += 7) weeks.push(allDays.slice(i, i + 7));

    return {
      label: monthDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      weeks
    };
  }

  // Efficient rendering
  // Every row gets a stable synthetic key the first time it's rendered, kept
  // for that object's whole lifetime in the page — including the moment an
  // unsaved row is first persisted and `pkg.id` goes from undefined to a
  // real id. Keying off `p.id || new-${index}` (the old approach) changes
  // the returned key at exactly that moment, so Angular tears down and
  // recreates the <tr> mid-save; if that happens while the linked-clients
  // multi-select popover is open, its <ion-select> gets destroyed and the
  // next click on it silently does nothing (the "have to click it twice" bug).
  private rowKeys = new WeakMap<PackageRecord, string>();
  private rowKeySeq = 0;
  trackByPkg = (_: number, p: PackageRecord): string => {
    let key = this.rowKeys.get(p);
    if (!key) {
      key = `row-${this.rowKeySeq++}`;
      this.rowKeys.set(p, key);
    }
    return key;
  };

  // Column resizing
  columnWidths: {
    packageId: number;
    packageName: number;
    linkedClients: number;
    trainer: number;
    duration: number;
    totalSessions: number;
    daysOfWeek: number;
    timeOfDay: number;
    sessionsRemaining: number;
    purchaseDate: number;
    finalSession: number;
    status: number;
    cost: number;
    actions: number;
  } = {
    packageId: 130,
    packageName: 200,
    linkedClients: 200,
    trainer: 130,
    duration: 120,
    totalSessions: 120,
    daysOfWeek: 160,
    timeOfDay: 180,
    sessionsRemaining: 140,
    purchaseDate: 140,
    finalSession: 140,
    status: 120,
    cost: 200,
    actions: 80
  };
  private resizingCol: keyof PackagesPage['columnWidths'] | null = null;
  private startX = 0;
  private startWidth = 0;
  private moveListener?: (e: MouseEvent) => void;
  private upListener?: () => void;

  onHeaderResizeMouseDown(colKey: keyof PackagesPage['columnWidths'], event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.resizingCol = colKey;
    this.startX = event.clientX;
    this.startWidth = this.columnWidths[colKey] || 120;
    this.moveListener = (e: MouseEvent) => {
      if (!this.resizingCol) return;
      const delta = e.clientX - this.startX;
      const newWidth = Math.max(80, this.startWidth + delta);
      const key = this.resizingCol as keyof PackagesPage['columnWidths'];
      this.columnWidths[key] = newWidth;
    };
    this.upListener = () => {
      window.removeEventListener('mousemove', this.moveListener!);
      window.removeEventListener('mouseup', this.upListener!);
      this.resizingCol = null;
    };
    window.addEventListener('mousemove', this.moveListener);
    window.addEventListener('mouseup', this.upListener);
  }

  addNewRow() {
    this.recalculateTotals();
    // add a local unsaved row at the top
    this.packages = [
      {
        id: undefined,
        packageId: '',
        packageName: this.newPackage.packageName,
        linkedClientIds: [],
        linkedClientNames: [],
        sessionType: this.newPackage.sessionType,
        sessionDurationMinutes: this.newPackage.sessionDurationMinutes,
        sessionsPerWeek: this.newPackage.sessionsPerWeek,
        packageDuration: this.newPackage.packageDuration,
        totalSessions: this.newPackage.totalSessions,
        sessionsRemaining: this.newPackage.totalSessions,
        daysOfWeek: [],
        dayTimes: {},
        cost: this.newPackage.cost,
        clientPayments: {},
        trainerId: '',
        purchaseDate: this.newPackage.purchaseDate,
        expirationDate: this.newPackage.expirationDate,
        status: this.newPackage.status
      },
      ...this.packages
    ];
  }

  async saveRow(pkg: PackageRecord, toastMessage = 'Package saved') {
    // Daily-group packages decrement by scheduled day, not by check-in —
    // showing up or not, the slot is used. Skip the check-in lookups
    // entirely and use the schedule-derived count instead.
    const [checkedInCount, excusedCount] = pkg.id && !pkg.dailyGroupProgram
      ? await Promise.all([
          this.firebase.getDecrementedSessionCount(pkg.id),
          this.firebase.getExcusedSessionCount(pkg.id)
        ])
      : [0, 0];
    const sessionsUsed = pkg.dailyGroupProgram ? countScheduledOccurrences(pkg) : checkedInCount;
    const beforeExpiration = pkg.expirationDate;
    this.recalcRow(pkg, sessionsUsed, excusedCount);
    if (pkg.bookedSessions) pkg.expirationDate = beforeExpiration;
    // Same attendance-driven end date as loadData, so editing a weekly
    // package (days, duration, start date) can't strand an owed session.
    if (pkg.id && !pkg.bookedSessions && pkg.status === 'active') {
      const [marks, overrides] = await Promise.all([
        this.firebase.getAttendanceMarks(pkg.id),
        this.firebase.listSessionOverrides()
      ]);
      const projected = projectPackageEnd({ ...pkg, expirationDate: beforeExpiration }, marks, overrides);
      if (projected) {
        pkg.expirationDate = projected.expirationDate;
        pkg.skipDates = projected.skipDates;
      }
    }
    if (pkg.isFree) {
      // Every linked client is $0 and paid, current and newly-added alike —
      // re-normalize on every save instead of only when the checkbox is
      // first ticked, so adding a client to an already-free package doesn't
      // need a separate manual step.
      const payments = this.clientPaymentsOf(pkg);
      for (const cid of pkg.linkedClientIds || []) {
        payments[cid] = { ...(payments[cid] || {}), amount: 0, paid: true };
      }
    }
    // A prospect can hold a tentative day/time without becoming a confirmed,
    // billing client — it used to auto-promote to 'active' the instant days
    // were assigned, which meant "prospect" could never actually mean
    // "tentative hold" in practice. The coach flips it to Active manually
    // once it's real.
    // derive linkedClientNames from ids
    const idToName = new Map(this.clients.map(c => [c.id!, c.fullName]));
    const names = (pkg.linkedClientIds || []).map(id => idToName.get(id) || '').filter(Boolean);
    const savedId = await this.firebase.upsertPackage({
      id: pkg.id,
      packageId: pkg.packageId,
      packageName: pkg.packageName || 'Standard Training',
      linkedClientIds: pkg.linkedClientIds || [],
      linkedClientNames: names,
      sessionType: pkg.sessionType,
      sessionDurationMinutes: pkg.sessionDurationMinutes,
      sessionsPerWeek: pkg.sessionsPerWeek,
      packageDuration: pkg.packageDuration,
      totalSessions: pkg.totalSessions,
      sessionsRemaining: pkg.sessionsRemaining ?? pkg.totalSessions,
      daysOfWeek: pkg.daysOfWeek || [],
      dayTimes: pkg.dayTimes || {},
      perSessionPack: pkg.perSessionPack ?? false,
      isFree: pkg.isFree ?? false,
      dailyGroupProgram: pkg.dailyGroupProgram ?? false,
      cost: this.totalCost(pkg),
      clientPayments: pkg.clientPayments || {},
      trainerId: pkg.trainerId || '',
      purchaseDate: pkg.purchaseDate,
      expirationDate: pkg.expirationDate,
      skipDates: pkg.skipDates,
      status: pkg.status
    });
    // Patch the same object in place instead of a full loadData() reload.
    // A reload re-fetches and re-sorts the whole list, which (a) jumps the
    // row to a different position and (b) for a brand-new row swaps its
    // trackBy key from `new-N` to the real id, tearing down and recreating
    // the <tr>. The linked-clients multi-select uses a popover that applies
    // each click immediately via (ionChange) — if that reload/recreate
    // happens between clicks, the popover's underlying <ion-select> gets
    // destroyed mid-interaction and the next click on it does nothing,
    // which is exactly the "have to click it twice" bug this fixes.
    pkg.id = pkg.id || savedId;
    pkg.linkedClientNames = names;
    await this.syncStoredSessions(pkg);
    this.buildLegend();
    this.buildCalendar();
    // No explicit calendar sync here: FirebaseService emits on every
    // package write and CalendarSyncService re-syncs off that, so this
    // (and every other package write in the app) is covered automatically.
    const toast = await this.toastController.create({ message: toastMessage, duration: 1500, position: 'bottom', color: 'success' });
    await toast.present();
  }

  // The start date saves on change like every other cell, but on an
  // existing package it asks first: it moves the whole package, and a stray
  // flick of the iPad's date wheel once turned The Dads' 8/19 into 9/19
  // with no sign anything had happened.
  private savedStart = new Map<string, string>();

  async onStartDateChange(pkg: PackageRecord) {
    const before = pkg.id ? this.savedStart.get(pkg.id) : undefined;
    if (pkg.id && before && pkg.purchaseDate !== before) {
      const ok = confirm(`Change the start date of "${pkg.packageName}" from ${before} to ${pkg.purchaseDate}?`);
      if (!ok) {
        pkg.purchaseDate = before;
        return;
      }
    }
    await this.saveRow(pkg);
    if (pkg.id && pkg.purchaseDate) this.savedStart.set(pkg.id, pkg.purchaseDate);
  }

  // ---------- Per-package session calendar ----------
  // Every date the package was scheduled or used, colored by what happened.
  // Tapping a date opens its editor below it in the list: attendance for
  // past dates, and moving a session that has no attendance yet — by date
  // and time fields, or by pressing and dragging it on the calendar.
  calOpen = false;
  calLoading = false;
  calPkg: PackageRecord | null = null;
  calDays: CalDay[] = [];
  calHighlights: { date: string; textColor: string; backgroundColor: string }[] = [];
  calSummary: { status: CalStatus; label: string; count: number }[] = [];
  calUsed = 0;             // distinct dates that used a session
  calSelected = '';
  formatTime12h = formatTime12h;
  readonly calLegend = (Object.keys(CAL_LABELS) as CalStatus[]).map(status => ({ status, label: CAL_LABELS[status] }));

  // Selected date's editor.
  calEdit: { day: CalDay; canMark: boolean; canMove: boolean; clients: CalClientRow[] } | null = null;
  calBusy = new Set<string>();
  calMoveDate = '';
  calMoveTime = '';
  calMoving = false;
  private calRecords: CheckIn[] = [];        // this package's attendance
  private calClientRecords: CheckIn[] = [];  // its clients' check-ins, any package or none
  private calChanged = false;

  // Drag on the calendar. calDropRect is the hovered day's box, for the
  // ring drawn over it (the day itself lives in ion-datetime's shadow DOM),
  // relative to the modal: ion-page's `contain: layout` makes it, not the
  // screen, the frame for anything position: fixed inside the page.
  @ViewChild('pkgCal', { read: ElementRef }) private pkgCalEl?: ElementRef<HTMLElement>;
  @ViewChild('pkgCalModal') private pkgCalModal?: ElementRef<HTMLElement>;
  @ViewChild('pkgCalBody') private pkgCalBody?: ElementRef<HTMLElement>;
  calDragDay: CalDay | null = null;
  calDropKey: string | null = null;
  calDropOk = false;
  calDropRect: { left: number; top: number; width: number; height: number } | null = null;
  private calDrag = new SessionDrag();

  statusLabel(status: CalStatus): string {
    return CAL_LABELS[status];
  }

  closePackageCalendar() {
    this.calOpen = false;
    this.calEdit = null;
    if (this.calChanged) {
      this.calChanged = false;
      this.buildCalendar();
    }
  }

  onCalDayChange(ev: CustomEvent) {
    const v = ev.detail?.value;
    if (typeof v === 'string') this.selectCalDay(v.slice(0, 10));
    else this.calEdit = null;
  }

  selectCalDay(dateKey: string) {
    this.calSelected = dateKey;
    this.syncCalEditor();
  }

  // Tapping the open date again closes its editor.
  toggleCalDay(dateKey: string) {
    if (this.calEdit?.day.dateKey === dateKey) {
      this.calEdit = null;
      return;
    }
    this.selectCalDay(dateKey);
  }

  trackCalDay = (_: number, d: CalDay) => d.dateKey;
  trackCalClient = (_: number, c: CalClientRow) => c.key;

  async openPackageCalendar(pkg: PackageRecord) {
    if (!pkg.id) return;
    this.calPkg = pkg;
    this.calOpen = true;
    this.calLoading = true;
    this.calDays = [];
    this.calEdit = null;
    await this.loadPackageCalendar();
    this.calLoading = false;
    // Show the month of the most recent session that's already happened,
    // with nothing open until a date is tapped.
    const today = localDateString();
    const past = this.calDays.filter(d => d.dateKey <= today);
    this.calSelected = (past[past.length - 1] || this.calDays[0])?.dateKey || today;
  }

  private async loadPackageCalendar() {
    const pkg = this.calPkg;
    if (!pkg?.id) return;
    try {
      const clientIds = pkg.linkedClientIds || [];
      const clientNames = pkg.linkedClientNames || [];
      const [records, ...perClient] = await Promise.all([
        this.firebase.listCheckInsForPackage(pkg.id),
        ...clientIds.map((id, i) => this.firebase.getCheckInsForClient({ clientId: id, clientName: clientNames[i] }))
      ]);
      this.calRecords = records;
      this.calClientRecords = ([] as CheckIn[]).concat(...perClient);
      this.calDays = this.buildCalendarDays(pkg, records, this.calClientRecords);
    } catch (err) {
      console.error('Packages: failed to load session calendar', err);
    }
    this.calHighlights = this.calDays.map(d => ({
      date: d.dateKey,
      textColor: CAL_COLORS[d.status],
      backgroundColor: CAL_COLORS[d.status] + '2e'
    }));
    this.calUsed = new Set(this.calRecords.filter(r => r.decremented).map(r => r.date)).size;
    const counts = new Map<CalStatus, number>();
    this.calDays.forEach(d => counts.set(d.status, (counts.get(d.status) || 0) + 1));
    this.calSummary = this.calLegend
      .filter(l => counts.get(l.status))
      .map(l => ({ ...l, count: counts.get(l.status)! }));
  }

  // After an edit: the package's end date and sessions left may have
  // moved, so re-read those (patching the table row too), then rebuild.
  private async refreshPackageCalendar() {
    const pkg = this.calPkg;
    if (!pkg?.id) return;
    const [fresh, overrides, booked] = await Promise.all([
      this.firebase.getPackageSchedule(pkg.id),
      this.firebase.listSessionOverrides(),
      pkg.bookedSessions ? this.firebase.listBookedSessionsFor(pkg.id) : Promise.resolve(null)
    ]);
    if (fresh) Object.assign(pkg, fresh);
    if (booked) pkg.bookedSessions = booked;
    this.overrides = overrides;
    await this.loadPackageCalendar();
    if (this.calEdit) this.syncCalEditor();
  }

  // Sessions used beyond what the package holds.
  get calOverUsed(): number {
    return Math.max(0, this.calUsed - (this.calPkg?.totalSessions ?? 0));
  }

  private syncCalEditor() {
    const pkg = this.calPkg;
    const day = this.calDays.find(d => d.dateKey === this.calSelected) || null;
    if (!pkg || !day) {
      this.calEdit = null;
      return;
    }
    const people: { id: string | null; name: string }[] = (pkg.linkedClientNames || [])
      .map((name, i) => ({ id: pkg.linkedClientIds?.[i] ?? null, name }));
    // Someone with attendance here who's since been taken off the package.
    for (const r of this.calRecords) {
      if (r.date === day.dateKey && !people.some(c => sameClient(r, c))) people.push({ id: r.clientId, name: r.clientName });
    }
    const clients = people.map(c => {
      const rec = this.calRecords.find(r => r.date === day.dateKey && sameClient(r, c));
      const loose = this.calClientRecords.find(r => !r.packageId && r.date === day.dateKey && sameClient(r, c));
      return { key: `${day.dateKey}|${c.id || c.name}`, id: c.id, name: c.name, status: rec?.status ?? 'none', unlinked: !rec && !!loose } as CalClientRow;
    });
    this.calEdit = {
      day,
      canMark: day.dateKey <= localDateString(),
      canMove: !!day.movable,
      clients
    };
    this.calMoveDate = day.dateKey;
    this.calMoveTime = day.entry?.time || day.time || '';
  }

  // Same rules as the Schedule page: Present and No-show use a session,
  // Excused doesn't, tapping the active one clears it. A check-in with no
  // package (the kiosk on a moved day) is linked to this package instead of
  // adding a second record.
  async setCalAttendance(row: CalClientRow, status: AttendanceStatus) {
    const pkg = this.calPkg;
    const day = this.calEdit?.day;
    if (!pkg?.id || !day || this.calBusy.has(row.key)) return;
    this.calBusy.add(row.key);
    try {
      // Normally one record per client per date, but a double-run no-show
      // sweep left pairs behind. The first is the one shown; the copies go
      // with it, or tapping No-show to clear would leave it still showing.
      const mine = this.calRecords.filter(r => r.date === day.dateKey && sameClient(r, row));
      const existing = mine[0] || null;
      const copies = mine.slice(1);
      if (existing && existing.status === status) {
        for (const r of mine) await this.firebase.undoCheckIn(r);
      } else {
        const loose = existing ? null : this.calClientRecords.find(r => !r.packageId && r.date === day.dateKey && sameClient(r, row)) || null;
        await this.firebase.setAttendance({
          existing: existing ?? loose,
          client: { id: row.id, fullName: row.name },
          pkg,
          date: day.dateKey,
          status
        });
        for (const r of copies) await this.firebase.undoCheckIn(r);
        if (status === 'excused' && existing?.status !== 'excused') {
          postponeBillingForExcuse(pkg.id).then(days => {
            if (days) this.presentCalToast(`${row.name} — next charge pushed back ${Math.round(days * 10) / 10} days`);
          });
        }
      }
      this.calChanged = true;
      await this.refreshPackageCalendar();
    } catch (err) {
      console.error('Packages: failed to set attendance', err);
      this.presentCalToast('Could not save attendance', 'danger');
    } finally {
      this.calBusy.delete(row.key);
    }
  }

  // Clears every record this package has on a leftover date (see
  // CalDay.movedTo) — the session's attendance lives on the date it moved to.
  async clearLeftover(day: CalDay) {
    const pkg = this.calPkg;
    const records = this.calRecords.filter(r => r.date === day.dateKey);
    if (!pkg?.id || !day.movedTo || !records.length || this.calMoving) return;
    const ok = confirm(`Clear the ${records.length === 1 ? 'record' : `${records.length} records`} on ${day.label}? ` +
      `This session moved to ${this.calDateLabel(day.movedTo)}, and its attendance there stays as it is.`);
    if (!ok) return;
    this.calMoving = true;
    try {
      for (const r of records) await this.firebase.undoCheckIn(r);
      this.calChanged = true;
      this.calSelected = day.movedTo;
      await this.refreshPackageCalendar();
      this.presentCalToast(`Cleared ${day.label}`);
    } catch (err) {
      console.error('Packages: failed to clear leftover records', err);
      this.presentCalToast('Could not clear those records', 'danger');
    } finally {
      this.calMoving = false;
    }
  }

  saveCalMove() {
    const day = this.calEdit?.day;
    if (!day) return;
    if (!this.calMoveDate) {
      this.presentCalToast('Pick a date', 'danger');
      return;
    }
    this.moveCalSession(day, this.calMoveDate, this.calMoveTime || '');
  }

  revertCalMove() {
    const entry = this.calEdit?.day.entry;
    if (entry) this.moveCalSession(this.calEdit!.day, entry.originalDateKey, entry.originalTime);
  }

  private async moveCalSession(day: CalDay, date: string, time: string) {
    const pkg = this.calPkg;
    const entry = day.entry;
    if (!pkg?.id || !entry || this.calMoving) return;
    if (date === entry.dateKey && time === entry.time) return;
    this.calMoving = true;
    try {
      const undo = await this.firebase.movePackageSession(entry, date, time);
      await this.firebase.recomputePackageSessions(pkg.id);
      this.calChanged = true;
      this.calSelected = date;
      await this.refreshPackageCalendar();
      const t = formatTime12h(time);
      this.presentCalToast(`Moved to ${this.calDateLabel(date)}${t ? ' · ' + t : ''}`, 'success', async () => {
        await undo();
        await this.firebase.recomputePackageSessions(pkg.id!);
        this.calSelected = entry.dateKey;
        await this.refreshPackageCalendar();
      });
    } catch (err) {
      console.error('Packages: failed to move session', err);
      this.presentCalToast('Could not move the session', 'danger');
    } finally {
      this.calMoving = false;
    }
  }

  calDateLabel(key: string): string {
    return new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  private async presentCalToast(message: string, color: 'success' | 'danger' = 'success', undo?: () => Promise<void>) {
    const toast = await this.toastController.create({
      message,
      duration: undo ? 6000 : 1600,
      position: 'bottom',
      color,
      buttons: undo ? [{
        text: 'Undo',
        handler: () => {
          undo().catch(err => {
            console.error('Packages: undo failed', err);
            this.presentCalToast('Could not undo', 'danger');
          });
        }
      }] : undefined
    });
    await toast.present();
  }

  // ----- Drag a session to a new date -----
  // From its row in the list, or straight off the calendar.
  onCalRowPointerDown(ev: PointerEvent, day: CalDay) {
    if (!day.movable) return;
    this.startCalDrag(ev, day, ev.currentTarget as HTMLElement);
  }

  onCalGridPointerDown(ev: PointerEvent) {
    const btn = ev.composedPath().find(el => el instanceof HTMLElement && el.classList.contains('calendar-day')) as HTMLElement | undefined;
    const key = btn ? this.calDayKey(btn) : null;
    const day = key ? this.calDays.find(d => d.dateKey === key) : undefined;
    if (btn && day?.movable) this.startCalDrag(ev, day, btn);
  }

  private startCalDrag(ev: PointerEvent, day: CalDay, source: HTMLElement) {
    this.calDrag.begin(ev, {
      zone: this.zone,
      source,
      ghost: this.calGhost(day),
      scrollEl: this.pkgCalBody?.nativeElement,
      canStart: () => {
        this.calDragDay = day;
        return true;
      },
      targetAt: (x, y) => this.calTargetAt(x, y),
      canDrop: key => key !== day.dateKey && key >= localDateString(),
      onOver: (key, ok) => {
        this.calDropKey = key && key !== 'prev' && key !== 'next' ? key : null;
        this.calDropOk = ok;
      },
      onEnd: () => {
        this.calDragDay = null;
        this.calDropRect = null;
      },
      onDrop: key => this.moveCalSession(day, key, day.entry?.time || day.time || ''),
      onFlip: dir => {
        // The native button inside ion-button — clicking the host doesn't
        // always turn the month.
        const nav = this.calNavButtons()[dir === 'prev' ? 0 : 1];
        (nav?.shadowRoot?.querySelector('button') ?? nav)?.click();
      }
    });
  }

  private calNavButtons(): HTMLElement[] {
    const sr = this.pkgCalEl?.nativeElement.shadowRoot;
    return sr ? Array.from(sr.querySelectorAll<HTMLElement>('.calendar-next-prev ion-button')) : [];
  }

  // YYYY-MM-DD for one of ion-datetime's day buttons (data-month is 1-based).
  private calDayKey(btn: HTMLElement): string | null {
    const { year, month, day } = btn.dataset;
    return year && month && day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : null;
  }

  private calTargetAt(x: number, y: number): string | null {
    this.calDropRect = null;
    const sr = this.pkgCalEl?.nativeElement.shadowRoot;
    const el = sr?.elementFromPoint(x, y) as HTMLElement | null;
    if (!el) return null;
    const nav = el.closest('.calendar-next-prev ion-button');
    if (nav) return this.calNavButtons().indexOf(nav as HTMLElement) === 0 ? 'prev' : 'next';
    const btn = el.closest<HTMLElement>('.calendar-day[data-day]');
    const key = btn ? this.calDayKey(btn) : null;
    if (btn && key) {
      const box = btn.getBoundingClientRect();
      const frame = this.pkgCalModal?.nativeElement.getBoundingClientRect();
      this.calDropRect = {
        left: box.left - (frame?.left ?? 0),
        top: box.top - (frame?.top ?? 0),
        width: box.width,
        height: box.height
      };
    }
    return key;
  }

  // What floats under the finger: the session's date and time as a chip.
  private calGhost(day: CalDay): HTMLElement {
    const color = CAL_COLORS[day.status];
    const el = document.createElement('div');
    const t = formatTime12h(day.entry?.time || day.time);
    el.textContent = `${day.label}${t ? ' · ' + t : ''}`;
    Object.assign(el.style, {
      padding: '8px 14px',
      borderRadius: '999px',
      background: '#0d1520',
      border: `1px solid ${color}`,
      color,
      font: '600 13px/1.2 -apple-system, BlinkMacSystemFont, sans-serif',
      whiteSpace: 'nowrap'
    } as Partial<CSSStyleDeclaration>);
    return el;
  }

  private buildCalendarDays(pkg: PackageRecord, records: CheckIn[], clientRecords: CheckIn[]): CalDay[] {
    const today = localDateString();
    const start = pkg.purchaseDate ? new Date(`${pkg.purchaseDate.slice(0, 10)}T00:00:00`) : new Date();
    // Through the end date, today, or the latest session moved or booked
    // past both — a session dragged beyond the end date still shows.
    const moved = this.overrides.filter(o => o.packageId === pkg.id).map(o => o.newDate);
    const booked = (pkg.bookedSessions || []).filter(b => b.status === 'booked').map(b => b.date);
    const endKey = [(pkg.expirationDate || '').slice(0, 10), today, ...moved, ...booked].sort().pop()!;
    const end = new Date(`${endKey}T00:00:00`);
    const scheduled = generateScheduleForRange([pkg], start, end, this.overrides, [], ['active', 'completed', 'prospect'])
      .filter(e => !e.isSingle);

    const days = new Map<string, CalDay>();
    const label = (key: string) => this.calDateLabel(key);
    const clientStatus = (c: CheckIn) =>
      c.status === 'excused' ? 'excused' : c.status === 'unexcused' ? 'no-show' : 'present';

    // Attendance recorded against this package. One status per date:
    // anyone present makes it attended, else a no-show makes it missed.
    const byDate = new Map<string, CheckIn[]>();
    for (const r of records) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r);
    }
    byDate.forEach((recs, dateKey) => {
      const clients = new Map<string, string>();
      recs.forEach(r => clients.set(r.clientName, clientStatus(r)));
      const statuses = [...clients.values()];
      const status: CalStatus = statuses.includes('present') ? 'attended'
        : statuses.includes('no-show') ? 'missed' : 'excused';
      days.set(dateKey, {
        dateKey, label: label(dateKey), time: '', status,
        clients: [...clients.entries()].map(([name, st]) => ({ name, status: st }))
      });
    });

    // Scheduled dates with no record. A session moved to another day may
    // have its attendance filed under either date, so either one counts.
    for (const e of scheduled) {
      const oldDay = e.dateKey !== e.originalDateKey ? days.get(e.originalDateKey) : undefined;
      if (oldDay && days.has(e.dateKey)) {
        oldDay.movedTo = e.dateKey;
        oldDay.note = (byDate.get(e.originalDateKey) || []).some(r => r.decremented)
          ? `Moved to ${label(e.dateKey)}, where attendance was taken. This record is left over and uses a second session.`
          : `Moved to ${label(e.dateKey)}, where attendance was taken. This record is left over.`;
      }
      const recorded = days.get(e.dateKey) || days.get(e.originalDateKey);
      if (recorded) {
        if (!recorded.time) recorded.time = e.time;
        if (!recorded.entry) recorded.entry = e;
        continue;
      }
      const movedNote = e.dateKey !== e.originalDateKey ? `Moved from ${label(e.originalDateKey)}` : undefined;
      days.set(e.dateKey, {
        dateKey: e.dateKey, label: label(e.dateKey), time: e.time,
        status: e.dateKey < today ? 'unrecorded' : 'upcoming',
        clients: [], note: movedNote, entry: e, movable: true
      });
    }

    // A client of this package checking in with no package attached, inside
    // the package's dates — it happened, but it didn't count toward anything.
    const startKey = localDateString(start);
    for (const r of clientRecords) {
      if (r.packageId || r.date < startKey || r.date > endKey) continue;
      const existing = days.get(r.date);
      if (existing && existing.status !== 'unrecorded' && existing.status !== 'unlinked') continue;
      const day = existing ?? {
        dateKey: r.date, label: label(r.date), time: '', status: 'unlinked' as CalStatus, clients: []
      };
      day.status = 'unlinked';
      day.note = 'Checked in without a package — not counted toward this one';
      if (!day.clients.some(c => c.name === r.clientName)) day.clients.push({ name: r.clientName, status: clientStatus(r) });
      days.set(r.date, day);
    }

    return [...days.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }

  // ---------- Stored sessions ----------
  // Last-saved weekly pattern per package, so a save that only renames a
  // package or edits a payment doesn't re-book anyone's upcoming sessions.
  private patternSig = new Map<string, string>();

  private patternSignature(pkg: PackageRecord): string {
    const times = Object.entries(pkg.dayTimes || {}).sort().map(([d, t]) => `${d}${t}`).join(',');
    return [[...(pkg.daysOfWeek || [])].sort().join(','), times, pkg.purchaseDate || '', pkg.totalSessions ?? 0].join('|');
  }

  // Once the facility runs on stored sessions, every save keeps this
  // package's bookings right: a changed weekly pattern re-books what's still
  // upcoming, any other save just tops up to credits left, and a package
  // with no sessions yet (new, renewed, duplicated) gets them booked.
  private async syncStoredSessions(pkg: PackageRecord) {
    if (!pkg.id || !usesStoredSessions(pkg) || pkg.status !== 'active') return;
    if (await this.firebase.getSchedulingMode() !== 'sessions') return;
    const sig = this.patternSignature(pkg);
    const changed = this.patternSig.get(pkg.id) !== sig;
    this.patternSig.set(pkg.id, sig);
    try {
      const existing = await this.firebase.listBookedSessionsFor(pkg.id);
      if (!existing.length) {
        const [overrides, marks] = await Promise.all([
          this.firebase.listSessionOverrides(),
          this.firebase.getAttendanceMarks(pkg.id)
        ]);
        await this.firebase.applyStoredSessionsMigration([planMigration(pkg, overrides, marks)]);
      } else if (changed) {
        await this.firebase.rebookFuture(pkg);
      } else {
        await this.firebase.topUpPackage(pkg, existing);
      }
      const booked = await this.firebase.listBookedSessionsFor(pkg.id);
      pkg.bookedSessions = booked.length ? booked : undefined;
      const last = booked.filter(b => b.status === 'booked').map(b => b.date).sort().pop();
      if (last) pkg.expirationDate = last;
      this.buildLegend();
      this.buildCalendar();
    } catch (err) {
      console.error('Packages: failed to sync stored sessions', err);
    }
  }

  // ---------- Duplicate / Renew ----------
  // Both start from the same clone: a fresh, unpersisted copy of the
  // package (new id, sessions reset to a full pack, payments reset to
  // unpaid, purchase date = today) that gets saved immediately and dropped
  // in at the top of the table so the coach can review/adjust it right
  // there like any other row. "Renew" and "Duplicate" are the same
  // operation under the hood — the distinction is just which one reads
  // right coming from a finished package vs. an active one you want a
  // second copy of (e.g. for another client on the same plan).
  private clonePackage(pkg: PackageRecord): PackageRecord {
    const clientPayments: Record<string, ClientPayment> = {};
    for (const [cid, payment] of Object.entries(pkg.clientPayments || {})) {
      clientPayments[cid] = { amount: payment.amount, paid: false, amountPaid: 0 };
    }
    const clone: PackageRecord = {
      id: undefined,
      packageId: '',
      packageName: pkg.packageName,
      linkedClientIds: [...(pkg.linkedClientIds || [])],
      linkedClientNames: [...(pkg.linkedClientNames || [])],
      sessionType: pkg.sessionType,
      sessionDurationMinutes: pkg.sessionDurationMinutes,
      sessionsPerWeek: pkg.sessionsPerWeek,
      packageDuration: pkg.packageDuration,
      totalSessions: pkg.totalSessions,
      sessionsRemaining: pkg.totalSessions,
      daysOfWeek: [...(pkg.daysOfWeek || [])],
      dayTimes: { ...(pkg.dayTimes || {}) },
      perSessionPack: pkg.perSessionPack ?? false,
      cost: pkg.cost,
      clientPayments,
      trainerId: pkg.trainerId || '',
      purchaseDate: localDateString(),
      expirationDate: undefined,
      status: 'active'
    };
    this.recalcRow(clone);
    return clone;
  }

  // saveRow() already rebuilds the legend/calendar and syncs the device
  // calendar in the background, so there's nothing left to do here beyond
  // inserting the row and persisting it.
  async duplicatePackage(pkg: PackageRecord) {
    const clone = this.clonePackage(pkg);
    this.packages = [clone, ...this.packages];
    await this.saveRow(clone, 'Package duplicated');
  }

  async renewPackage(pkg: PackageRecord) {
    const clone = this.clonePackage(pkg);
    this.packages = [clone, ...this.packages];
    await this.saveRow(clone, 'Package renewed');
  }

  async onDeletePackage(pkg: PackageRecord) {
    if (!pkg.id) return; // only persisted
    const ok = confirm(`Delete package "${pkg.packageName}"?`);
    if (!ok) return;
    await this.firebase.deletePackage(pkg.id);
    this.packages = this.packages.filter(p => p.id !== pkg.id);
  }

  recalcRow(pkg: PackageRecord, sessionsUsed?: number, excusedCount = 0) {
    const duration = Number(pkg.packageDuration) || 1;

    // Per-session pack: no recurring weekly slot, so there's nothing to
    // derive totalSessions FROM — it's a number the coach typed in
    // directly (a flat pack, like "10 sessions, use them whenever").
    if (pkg.perSessionPack) {
      pkg.sessionsPerWeek = 0;
      const total = Math.max(0, Number(pkg.totalSessions) || 0);
      pkg.totalSessions = total;
      if (sessionsUsed !== undefined) {
        pkg.sessionsRemaining = Math.max(0, total - sessionsUsed);
      } else if (!pkg.id) {
        pkg.sessionsRemaining = total;
      }
      // No fixed cadence to project a final session date from — same
      // fallback as "no days selected yet" below: purchase date + duration.
      if (pkg.purchaseDate) {
        pkg.expirationDate = localDateString(this.addMonths(new Date(pkg.purchaseDate), duration));
      }
      return;
    }

    const perWeek = (pkg.daysOfWeek && pkg.daysOfWeek.length) ? pkg.daysOfWeek.length : 0;
    pkg.sessionsPerWeek = perWeek;

    const total = perWeek * this.getWeeksFromDuration(duration);
    pkg.totalSessions = total;

    if (sessionsUsed !== undefined) {
      pkg.sessionsRemaining = Math.max(0, total - sessionsUsed);
    } else if (!pkg.id) {
      pkg.sessionsRemaining = total;
    }
    if (pkg.purchaseDate) {
      // An excused occurrence still happens on the calendar — it just
      // doesn't deduct — so it doesn't get the client any closer to their
      // last real session. Push the projection out by however many of
      // those have happened, or the "Final Session" date cuts the calendar
      // off before sessionsRemaining actually reaches zero.
      const final = this.computeFinalSessionDate(
        new Date(pkg.purchaseDate),
        total + excusedCount,
        pkg.daysOfWeek,
        duration
      );
      if (final) pkg.expirationDate = localDateString(final);
    }
  }

  // "Per-Session" lives as an option INSIDE the same Days of Week select
  // rather than a separate control next to it — pick it instead of real
  // days when a package is just a flat pack of sessions with no fixed
  // weekly slot. It's exclusive: whenever it's present in the selection,
  // that wins and any real days get cleared, since a package can't be both
  // "every Monday" and "no fixed schedule" at once.
  readonly PER_SESSION_VALUE = 'PER_SESSION';
  // Stable array references for daysSelectValue()'s fallbacks below. This is
  // bound directly in the template ([ngModel]="daysSelectValue(pkg)" on a
  // multi-select), which Angular re-evaluates on every change-detection
  // pass. Returning a brand-new array literal each call (as this used to
  // do for any perSessionPack package) means the binding's value is never
  // referentially equal to itself between checks, so the view can never be
  // considered stable — for a real package with perSessionPack:true this
  // pinned Angular in an endless re-check loop (100% CPU, unresponsive tab)
  // with no error, since nothing ever actually throws. (Same bug, found and
  // fixed independently in Project-000's sibling schedule code the night
  // before — confirms this really is the root cause.)
  private readonly PER_SESSION_SELECTION: string[] = [this.PER_SESSION_VALUE];
  private readonly EMPTY_DAYS: string[] = [];

  daysSelectValue(pkg: PackageRecord): string[] {
    return pkg.perSessionPack ? this.PER_SESSION_SELECTION : (pkg.daysOfWeek || this.EMPTY_DAYS);
  }

  onDaysOfWeekChange(pkg: PackageRecord, selected: string[]) {
    if (selected.includes(this.PER_SESSION_VALUE)) {
      pkg.perSessionPack = true;
      pkg.daysOfWeek = [];
      pkg.dayTimes = {};
      if (!pkg.totalSessions) pkg.totalSessions = 10;
    } else {
      pkg.perSessionPack = false;
      pkg.daysOfWeek = selected;
    }
    this.recalcRow(pkg);
    this.saveRow(pkg);
  }

  // Total Sessions is read-only in recurring mode (derived from days x
  // weeks) but directly editable for a per-session pack.
  onTotalSessionsChange(pkg: PackageRecord) {
    if (!pkg.perSessionPack) return;
    this.recalcRow(pkg);
    this.saveRow(pkg);
  }

  // Every day but the first "mirrors" the first day's time until the user edits
  // that day directly — then it breaks off and stops following. Keyed per package
  // row and reset each time its Time of Day popover opens.
  private linkedTimeDays = new Map<string, Set<string>>();

  private timeLinkKey(pkg: PackageRecord, i: number): string {
    return pkg.id || `new-${i}`;
  }

  // Update the in-memory model as the user edits (no persist until Done)
  setDayTime(pkg: PackageRecord, day: string, value: string | null | undefined, i: number) {
    pkg.dayTimes = pkg.dayTimes || {};
    const v = value || '';
    const days = pkg.daysOfWeek || [];
    const firstDay = days[0];
    const key = this.timeLinkKey(pkg, i);
    const linked = this.linkedTimeDays.get(key) || new Set<string>();

    pkg.dayTimes[day] = v;
    if (day === firstDay) {
      for (const d of linked) pkg.dayTimes[d] = v;
    } else {
      linked.delete(day);
      this.linkedTimeDays.set(key, linked);
    }
  }

  // Seed unset times to a sensible PM default (5:00 PM) when the popover opens,
  // so trainers never accidentally leave a slot on AM. Persists when they press Done.
  // Also resets the day-linking: every day but the first starts out mirroring it.
  seedDefaultTimes(pkg: PackageRecord, i: number) {
    pkg.dayTimes = pkg.dayTimes || {};
    for (const d of pkg.daysOfWeek || []) {
      if (!pkg.dayTimes[d]) pkg.dayTimes[d] = '17:00';
    }
    const days = pkg.daysOfWeek || [];
    this.linkedTimeDays.set(this.timeLinkKey(pkg, i), new Set(days.slice(1)));
  }

  formatDayTimes(pkg: PackageRecord): string {
    if (!pkg.daysOfWeek || pkg.daysOfWeek.length === 0) return '—';
    const parts = pkg.daysOfWeek.map(d => {
      const t = pkg.dayTimes && pkg.dayTimes[d] ? pkg.dayTimes[d] : '';
      return t ? `${d} ${t}` : d;
    });
    return parts.join(', ');
  }

  // ---------- Per-client payment tracking ----------
  clientName(clientId: string): string {
    return this.clients.find(c => c.id === clientId)?.fullName || 'Unknown';
  }

  private clientPaymentsOf(pkg: PackageRecord): Record<string, ClientPayment> {
    pkg.clientPayments = pkg.clientPayments || {};
    return pkg.clientPayments;
  }

  paymentAmount(pkg: PackageRecord, clientId: string): number {
    return pkg.clientPayments?.[clientId]?.amount ?? 0;
  }

  isPaid(pkg: PackageRecord, clientId: string): boolean {
    return !!pkg.clientPayments?.[clientId]?.paid;
  }

  amountPaidSoFar(pkg: PackageRecord, clientId: string): number {
    return pkg.clientPayments?.[clientId]?.amountPaid ?? 0;
  }

  setPaymentAmount(pkg: PackageRecord, clientId: string, value: string) {
    const payments = this.clientPaymentsOf(pkg);
    const existing = payments[clientId] || { amount: 0, paid: false };
    payments[clientId] = { ...existing, amount: Number(value) || 0 };
    this.saveRow(pkg);
  }

  setAmountPaidSoFar(pkg: PackageRecord, clientId: string, value: string) {
    const payments = this.clientPaymentsOf(pkg);
    const existing = payments[clientId] || { amount: 0, paid: false };
    payments[clientId] = { ...existing, amountPaid: Number(value) || 0 };
    this.saveRow(pkg);
  }

  togglePaid(pkg: PackageRecord, clientId: string) {
    const payments = this.clientPaymentsOf(pkg);
    const existing = payments[clientId] || { amount: 0, paid: false };
    payments[clientId] = { ...existing, paid: !existing.paid };
    this.saveRow(pkg);
  }

  isPaymentPlan(pkg: PackageRecord, clientId: string): boolean {
    return !!pkg.clientPayments?.[clientId]?.paymentPlan;
  }

  togglePaymentPlan(pkg: PackageRecord, clientId: string) {
    const payments = this.clientPaymentsOf(pkg);
    const existing = payments[clientId] || { amount: 0, paid: false };
    payments[clientId] = { ...existing, paymentPlan: !existing.paymentPlan };
    this.saveRow(pkg);
  }

  // Every linked client (now and any added later) gets zeroed to $0/paid —
  // see saveRow()'s normalization.
  toggleFree(pkg: PackageRecord) {
    pkg.isFree = !pkg.isFree;
    this.saveRow(pkg);
  }

  // Meets on a fixed schedule with no makeups — sessions decrement by
  // scheduled day instead of by check-in. See saveRow()/loadData().
  toggleDailyGroup(pkg: PackageRecord) {
    pkg.dailyGroupProgram = !pkg.dailyGroupProgram;
    this.saveRow(pkg);
  }

  // The table's Cost cell shows this total (sum of each linked client's price).
  totalCost(pkg: PackageRecord): number {
    const ids = pkg.linkedClientIds || [];
    return ids.reduce((sum, id) => sum + (pkg.clientPayments?.[id]?.amount ?? 0), 0);
  }

  // How many linked clients haven't checked off "paid" yet and aren't on an
  // approved payment plan — drives the table's unpaid flag. A payment-plan
  // client is intentionally not paid in full yet, so they don't count here.
  unpaidCount(pkg: PackageRecord): number {
    return (pkg.linkedClientIds || []).filter(id => !this.isPaid(pkg, id) && !this.isPaymentPlan(pkg, id)).length;
  }

  hasUnpaid(pkg: PackageRecord): boolean {
    return this.unpaidCount(pkg) > 0;
  }

  // Linked clients who are unpaid but explicitly approved for a payment
  // plan — shown as a distinct, non-alarming flag from hasUnpaid().
  paymentPlanCount(pkg: PackageRecord): number {
    return (pkg.linkedClientIds || []).filter(id => !this.isPaid(pkg, id) && this.isPaymentPlan(pkg, id)).length;
  }

  hasPaymentPlan(pkg: PackageRecord): boolean {
    return this.paymentPlanCount(pkg) > 0;
  }

  // ---------- Receipt / invoice PDF ----------
  // Paid clients get an official receipt; anyone still owing gets an invoice
  // showing the balance due — same document, different framing, driven off
  // the same isPaid()/amountPaidSoFar() state already used by the Cost popover.
  openReceipt(pkg: PackageRecord, clientId: string) {
    this.pdfPackage = pkg;
    this.pdfClientId = clientId;
    this.pdfOpen = true;
    // Inject after the modal renders (ViewChild exists) and the layout has a
    // real size — two rAFs so the flex container is measured, not zero.
    requestAnimationFrame(() => {
      if (this.pdfPage) this.pdfPage.nativeElement.innerHTML = this.buildReceiptHtml(pkg, clientId);
      requestAnimationFrame(() => this.scaleReceiptToFit());
    });
  }

  closeReceipt() {
    this.pdfOpen = false;
  }

  private scaleReceiptToFit() {
    const wrap = this.pdfScaleWrap?.nativeElement;
    const scroll = this.pdfScroll?.nativeElement;
    if (!wrap || !scroll || scroll.clientWidth < 50 || scroll.clientHeight < 50) return;
    const scaleX = (scroll.clientWidth - 40) / 794;
    const scaleY = (scroll.clientHeight - 40) / 1123;
    const scale = Math.min(scaleX, scaleY, 1);
    wrap.style.transform = `scale(${scale})`;
    wrap.style.transformOrigin = 'top center';
    wrap.style.marginBottom = -(1123 - 1123 * scale) + 'px';
  }

  async downloadReceipt() {
    const page = this.pdfPage?.nativeElement;
    const pkg = this.pdfPackage;
    const clientId = this.pdfClientId;
    if (!page || !pkg || !clientId) return;
    try {
      const canvas = await html2canvas(page, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const pdf = new jsPDF({ unit: 'px', format: [794, 1123], orientation: 'portrait' });
      pdf.addImage(canvas.toDataURL('image/jpeg', 1), 'JPEG', 0, 0, 794, 1123);
      const kind = this.isPaid(pkg, clientId) ? 'receipt' : 'invoice';
      const safeName = (this.clientName(clientId) || 'client')
        .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
      const safePkgId = (pkg.packageId || pkg.id || 'package').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
      pdf.save(`${kind}_${safeName || 'client'}_${safePkgId}.pdf`);
    } catch (err) {
      console.error('Packages: receipt PDF export failed', err);
      const toast = await this.toastController.create({ message: 'PDF export failed', duration: 1800, position: 'bottom', color: 'danger' });
      await toast.present();
    }
  }

  private buildReceiptHtml(pkg: PackageRecord, clientId: string): string {
    const name = this.clientName(clientId);
    const amount = this.paymentAmount(pkg, clientId);
    const paidInFull = this.isPaid(pkg, clientId);
    const paidSoFar = paidInFull ? amount : this.amountPaidSoFar(pkg, clientId);
    const balance = Math.max(0, amount - paidSoFar);

    const docLabel = paidInFull ? 'RECEIPT' : 'INVOICE';
    const docColor = paidInFull ? '#06d6a0' : '#ff6b6b';
    const dateLabel = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const purchaseLabel = pkg.purchaseDate
      ? new Date(pkg.purchaseDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      : '—';
    const docNumber = `${pkg.packageId || 'PKG'}-${clientId.slice(0, 6).toUpperCase()}`;
    const sessionDesc = `${pkg.sessionType} Training &middot; ${pkg.sessionDurationMinutes} min sessions`;

    return `
      <div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #e0e0e0;padding-bottom:14px;margin-bottom:24px">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:0.1em;color:#00d4ff">ASSESSMENTS</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;letter-spacing:0.12em;color:${docColor}">${docLabel}</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:24px;margin-bottom:22px">
        <div style="font-family:'Barlow',sans-serif;font-size:12px;color:#333333;line-height:1.6">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#999999;margin-bottom:4px">Billed To</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:20px;color:#111114">${name}</div>
        </div>
        <div style="font-family:'Barlow',sans-serif;font-size:12px;color:#444444;text-align:right;line-height:1.6">
          <div><strong>${paidInFull ? 'Receipt' : 'Invoice'} #</strong> ${docNumber}</div>
          <div><strong>Date issued</strong> ${dateLabel}</div>
          <div><strong>Purchase date</strong> ${purchaseLabel}</div>
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-family:'Barlow',sans-serif;font-size:12px;margin-bottom:20px">
        <thead>
          <tr style="border-bottom:1px solid #cccccc">
            <th style="text-align:left;padding:8px 0;color:#888888;font-family:'Barlow Condensed',sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase">Description</th>
            <th style="text-align:center;padding:8px 0;color:#888888;font-family:'Barlow Condensed',sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase">Sessions</th>
            <th style="text-align:right;padding:8px 0;color:#888888;font-family:'Barlow Condensed',sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr style="border-bottom:1px solid #eeeeee">
            <td style="padding:12px 0;color:#111114">
              ${pkg.packageName}<br/>
              <span style="color:#888888;font-size:10.5px">${sessionDesc}</span>
            </td>
            <td style="padding:12px 0;text-align:center;color:#111114">${pkg.totalSessions}</td>
            <td style="padding:12px 0;text-align:right;color:#111114">$${amount.toFixed(2)}</td>
          </tr>
        </tbody>
      </table>
      <div style="display:flex;justify-content:flex-end;margin-bottom:24px">
        <div style="width:240px;font-family:'Barlow',sans-serif;font-size:12px">
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#444444"><span>Total</span><span>$${amount.toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:4px 0;color:#444444"><span>Amount Paid</span><span>$${paidSoFar.toFixed(2)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;margin-top:4px;border-top:1px solid #cccccc;font-weight:700;color:${docColor}">
            <span>${paidInFull ? 'Paid in Full' : 'Balance Due'}</span><span>$${(paidInFull ? 0 : balance).toFixed(2)}</span>
          </div>
        </div>
      </div>
      <div style="display:inline-block;padding:6px 18px;border:2px solid ${docColor};color:${docColor};font-family:'Bebas Neue',sans-serif;font-size:16px;letter-spacing:0.15em;transform:rotate(-3deg)">
        ${paidInFull ? 'PAID' : 'PAYMENT DUE'}
      </div>
      <div style="margin-top:auto;padding-top:12px;border-top:1px solid #eeeeee;font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#aaaaaa;text-align:center">
        ASSESSMENTS &nbsp;&middot;&nbsp; ${dateLabel} &nbsp;&middot;&nbsp; Project [000]
      </div>`;
  }
}


