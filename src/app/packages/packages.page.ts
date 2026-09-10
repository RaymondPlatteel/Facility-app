import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
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
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, cubeOutline, calculatorOutline, calendarOutline, peopleOutline, pricetagOutline, timeOutline, ellipsisVertical, chevronBackOutline, chevronForwardOutline, chevronDownOutline, alertCircle, closeOutline, downloadOutline } from 'ionicons/icons';
import { Router } from '@angular/router';
import { FirebaseService, ClientProfile, PackageRecord, ClientPayment, SessionOverride, localDateString } from '../services/firebase.service';
import { ToastController } from '@ionic/angular/standalone';
import { generateScheduleForRange, startOfWeek, addDays } from '../services/schedule.util';
import { TRAINERS } from '../services/auth.service';
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

@Component({
  selector: 'app-packages',
  templateUrl: './packages.page.html',
  styleUrls: ['./packages.page.scss'],
  standalone: true,
  imports: [
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
export class PackagesPage implements OnInit {
  searchQuery = '';
  clients: ClientProfile[] = [];
  packages: PackageRecord[] = [];
  tableStatusFilter: 'all' | PackageStatus = 'all';

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
    private toastController: ToastController
  ) {
    addIcons({ arrowBack, cubeOutline, calculatorOutline, calendarOutline, peopleOutline, pricetagOutline, timeOutline, ellipsisVertical, chevronBackOutline, chevronForwardOutline, chevronDownOutline, alertCircle, closeOutline, downloadOutline });
  }

  ngOnInit(): void {
    this.recalculateTotals();
    this.loadData();
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
    const [packages, usedByPackage, overrides] = await Promise.all([
      this.firebase.listPackages(),
      this.firebase.getDecrementedCountsByPackage(),
      this.firebase.listSessionOverrides()
    ]);
    this.packages = packages;
    this.overrides = overrides;
    for (const p of this.packages) {
      if (!p.daysOfWeek) p.daysOfWeek = [] as any;
      if (!p.dayTimes) p.dayTimes = {} as any;
      const used = p.id ? (usedByPackage.get(p.id) ?? 0) : 0;
      const beforeRemaining = p.sessionsRemaining;
      this.recalcRow(p, used);
      if (p.id && beforeRemaining !== p.sessionsRemaining) {
        await this.firebase.upsertPackage({
          id: p.id,
          packageName: p.packageName,
          totalSessions: p.totalSessions,
          sessionsPerWeek: p.sessionsPerWeek,
          sessionsRemaining: p.sessionsRemaining
        });
      }
    }
    this.buildLegend();
    this.buildCalendar();
  }

  setViewMode(mode: 'table' | 'calendar') {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
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
    const active = this.packages
      .filter(p => p.status === 'active' && (p.id || p.packageId))
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
    const entries = generateScheduleForRange(this.packages, gridStart, gridEnd, this.overrides);
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
    const sessionsUsed = pkg.id
      ? await this.firebase.getDecrementedSessionCount(pkg.id)
      : 0;
    this.recalcRow(pkg, sessionsUsed);
    if ((pkg.daysOfWeek?.length ?? 0) > 0 && pkg.status === 'prospect') {
      pkg.status = 'active';
    }
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
      cost: this.totalCost(pkg),
      clientPayments: pkg.clientPayments || {},
      trainerId: pkg.trainerId || '',
      purchaseDate: pkg.purchaseDate,
      expirationDate: pkg.expirationDate,
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
    this.buildLegend();
    this.buildCalendar();
    // No explicit calendar sync here: FirebaseService emits on every
    // package write and CalendarSyncService re-syncs off that, so this
    // (and every other package write in the app) is covered automatically.
    const toast = await this.toastController.create({ message: toastMessage, duration: 1500, position: 'bottom', color: 'success' });
    await toast.present();
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

  recalcRow(pkg: PackageRecord, sessionsUsed?: number) {
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
      const final = this.computeFinalSessionDate(
        new Date(pkg.purchaseDate),
        total,
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
  // with no error, since nothing ever actually throws.
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


