import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import {
  arrowBack,
  searchOutline,
  addOutline,
  removeOutline,
  closeOutline,
  chevronForwardOutline,
  personOutline,
  trashOutline,
  cardOutline,
  cubeOutline,
  logInOutline,
  saveOutline,
  barbellOutline,
  chevronForward,
  trendingUpOutline,
  documentTextOutline,
  downloadOutline
} from 'ionicons/icons';
import {
  FirebaseService,
  ClientProfile,
  PackageRecord,
  CheckIn,
  PaymentRecord,
  WorkoutLog,
  FitnessAssessment,
  WaiverData,
  localDateString, Sex } from '../services/firebase.service';
import { rankLetter, rankLabel, levelColor as omniLevelColor } from '../services/omni.util';
import { isSRank } from '../services/level-color.util';
import { ChromaMotionService } from '../services/chroma-motion.service';

interface ClientRow {
  profile: ClientProfile;
  activePackage: PackageRecord | null;
  sessionsRemaining: number | null;
  totalSessions: number | null;
  lastCheckIn: string | null; // ISO
  checkInCount: number;
}

type StatusFilter = 'all' | 'active' | 'prospect' | 'paused' | 'inactive';

@Component({
  selector: 'app-students',
  templateUrl: './students.page.html',
  styleUrls: ['./students.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class StudentsPage implements OnInit {
  loading = true;
  searchQuery = '';
  statusFilter: StatusFilter = 'all';

  clients: ClientProfile[] = [];
  packages: PackageRecord[] = [];
  recentCheckIns: CheckIn[] = [];
  rows: ClientRow[] = [];

  // detail panel
  panelOpen = false;
  panelNew = false;
  panelSaving = false;
  selected: ClientRow | null = null;
  form: Partial<ClientProfile> = {};
  clientPackages: PackageRecord[] = [];

  // group designation (cell/generation/cohort — mobile Settings' "000" code)
  // lives on members/{nameKey}, not on ClientProfile — kept as separate
  // component state and loaded/saved alongside the profile, not part of it
  groupCell: number | null = null;
  groupGeneration: number | null = null;
  groupCohort: number | null = null;
  // Also on members/{nameKey}. Decides which rank threshold table this
  // athlete is scored against — female floors sit lower (D15/C30/B45/A60/
  // S80 vs D20/C40/B60/A80/S100). Defaults to male for every record written
  // before the field existed.
  groupSex: Sex = 'male';
  clientCheckIns: CheckIn[] = [];
  clientPayments: PaymentRecord[] = [];
  clientWorkouts: WorkoutLog[] = [];
  clientLatestAssessment: FitnessAssessment | null = null;
  rankLetter = rankLetter;
  rankLabel = rankLabel;
  // levelColor stays flat — omniLevelColor already returns a static white
  // for S-Rank, same as every other rank returns its static hue. The
  // moving chromium sweep lives only in the gradient text/border, driven
  // by isChroma()/levelGrad() below. Bound as methods (not fields) so
  // Angular re-evaluates them every change-detection pass and levelGrad
  // keeps animating for free off the chroma service's own tick.
  levelColor(lvl: number, sex: Sex): string {
    return omniLevelColor(lvl, sex);
  }

  isChroma(lvl: number, sex: Sex): boolean {
    return isSRank(lvl, sex);
  }

  levelGrad(lvl: number, sex: Sex): string {
    if (isSRank(lvl, sex)) return this.chroma.gradient;
    const c = omniLevelColor(lvl, sex);
    return `linear-gradient(${c}, ${c})`;
  }
  paymentsLoading = false;

  // waivers — signed on the public waiver form, viewed/printed from here
  clientWaivers: WaiverData[] = [];
  waiverListOpen = false;
  pdfOpen = false;
  private pdfWaiver: WaiverData | null = null;
  @ViewChild('waiverPdfPage') pdfPage?: ElementRef<HTMLDivElement>;
  @ViewChild('waiverPdfScaleWrap') pdfScaleWrap?: ElementRef<HTMLDivElement>;
  @ViewChild('waiverPdfScroll') pdfScroll?: ElementRef<HTMLDivElement>;

  // add payment mini-form
  showPaymentForm = false;
  paymentForm = this.blankPayment();

  statusOptions: Array<ClientProfile['currentStatus']> = ['active', 'prospect', 'paused', 'inactive'];

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController,
    private alertController: AlertController,
    private chroma: ChromaMotionService
  ) {
    addIcons({
      arrowBack,
      searchOutline,
      addOutline,
      removeOutline,
      closeOutline,
      chevronForwardOutline,
      personOutline,
      trashOutline,
      cardOutline,
      cubeOutline,
      logInOutline,
      saveOutline,
      barbellOutline,
      chevronForward,
      trendingUpOutline,
      documentTextOutline,
      downloadOutline
    });
  }

  async ngOnInit() {
    await this.loadData();
  }

  async ionViewWillEnter() {
    if (!this.loading) await this.loadData(true);
  }

  async loadData(silent = false) {
    if (!silent) this.loading = true;
    try {
      const [clients, packages, recentCheckIns] = await Promise.all([
        this.firebase.listClientProfiles(),
        this.firebase.listPackages(),
        this.firebase.getRecentCheckIns(500)
      ]);
      this.clients = clients;
      this.packages = packages;
      this.recentCheckIns = recentCheckIns;
      this.buildRows();
    } catch (err) {
      console.error('Clients: load failed', err);
      this.toast('Failed to load clients', 'danger');
    } finally {
      this.loading = false;
    }
  }

  private buildRows() {
    this.rows = this.clients
      .map(profile => {
        const pkg = this.activePackageFor(profile);
        const checkIns = this.recentCheckIns.filter(c => this.checkInMatches(c, profile));
        return {
          profile,
          activePackage: pkg,
          sessionsRemaining: pkg ? (pkg.sessionsRemaining ?? pkg.totalSessions ?? 0) : null,
          totalSessions: pkg ? (pkg.totalSessions ?? null) : null,
          lastCheckIn: checkIns.length ? checkIns[0].checkInTime : null,
          checkInCount: checkIns.length
        } as ClientRow;
      })
      .sort((a, b) => a.profile.fullName.localeCompare(b.profile.fullName));
  }

  private checkInMatches(c: CheckIn, profile: ClientProfile): boolean {
    if (profile.id && c.clientId === profile.id) return true;
    return c.clientName.trim().toLowerCase() === profile.fullName.trim().toLowerCase();
  }

  private packagesFor(profile: ClientProfile): PackageRecord[] {
    const nameKey = profile.fullName.trim().toLowerCase();
    return this.packages.filter(p =>
      (!!profile.id && (p.linkedClientIds || []).includes(profile.id)) ||
      (p.linkedClientNames || []).some(n => n.trim().toLowerCase() === nameKey)
    );
  }

  private activePackageFor(profile: ClientProfile): PackageRecord | null {
    const todayKey = localDateString();
    const active = this.packagesFor(profile)
      .filter(p => p.status === 'active')
      .filter(p => !p.expirationDate || p.expirationDate.slice(0, 10) >= todayKey)
      .sort((a, b) => (a.expirationDate || '9999').localeCompare(b.expirationDate || '9999'));
    return active.find(p => (p.sessionsRemaining ?? p.totalSessions ?? 0) > 0) || active[0] || null;
  }

  get filteredRows(): ClientRow[] {
    const q = this.searchQuery.trim().toLowerCase();
    return this.rows.filter(r => {
      if (this.statusFilter !== 'all' && (r.profile.currentStatus || 'active') !== this.statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        r.profile.fullName.toLowerCase().includes(q) ||
        (r.profile.email || '').toLowerCase().includes(q) ||
        (r.profile.phone || '').toLowerCase().includes(q) ||
        (r.profile.clientId || '').toLowerCase().includes(q)
      );
    });
  }

  countByStatus(status: StatusFilter): number {
    if (status === 'all') return this.rows.length;
    return this.rows.filter(r => (r.profile.currentStatus || 'active') === status).length;
  }

  trackByRow = (_: number, r: ClientRow) => r.profile.id || r.profile.fullName;

  goBack() {
    this.router.navigateByUrl('/home');
  }

  initials(name: string): string {
    return (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0].toUpperCase())
      .join('') || '?';
  }

  relativeDate(iso: string | null): string {
    if (!iso) return 'Never';
    const then = new Date(iso);
    const today = new Date();
    const dayMs = 86400000;
    const thenDay = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const diff = Math.round((todayDay - thenDay) / dayMs);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  formatDateTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  formatCurrency(n: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n || 0);
  }

  // ----- Workout history -----
  workoutDate(log: WorkoutLog): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(log.date);
    if (!m) return log.date;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  workoutTitle(log: WorkoutLog): string {
    return [log.programName, log.dayName].filter(Boolean).join(' · ') || 'Freeform session';
  }

  workoutSummary(log: WorkoutLog): string {
    const exercises = log.exercises?.length || 0;
    const sets = (log.exercises || []).reduce(
      (n, ex) => n + ex.sets.filter(s => s.done).length, 0
    );
    return `${exercises} exercise${exercises === 1 ? '' : 's'} · ${sets} set${sets === 1 ? '' : 's'}`;
  }

  openWorkoutLog(log: WorkoutLog) {
    this.router.navigate(['/workout-log'], { queryParams: { logId: log.id } });
  }

  get paymentsTotal(): number {
    return this.clientPayments
      .filter(p => p.paymentStatus === 'paid')
      .reduce((sum, p) => sum + (p.amount || 0), 0);
  }

  // ---------- Detail panel ----------
  async openClient(row: ClientRow) {
    this.selected = row;
    this.panelNew = false;
    this.form = { ...row.profile };
    this.clientPackages = this.packagesFor(row.profile);
    this.clientCheckIns = [];
    this.clientPayments = [];
    this.clientWorkouts = [];
    this.clientLatestAssessment = null;
    this.clientWaivers = [];
    this.showPaymentForm = false;
    this.paymentForm = this.blankPayment();
    this.groupCell = null;
    this.groupGeneration = null;
    this.groupCohort = null;
    this.groupSex = 'male';
    this.panelOpen = true;

    this.paymentsLoading = true;
    try {
      const [checkIns, payments, workouts, assessments, member, waivers] = await Promise.all([
        this.firebase.getCheckInsForClient({ clientId: row.profile.id, clientName: row.profile.fullName }),
        this.firebase.getPaymentsForClient(row.profile.fullName),
        row.profile.id
          ? this.firebase.listWorkoutLogs({ clientId: row.profile.id, max: 25 })
          : Promise.resolve([]),
        this.firebase.listAssessmentsForClient({ clientId: row.profile.id, clientName: row.profile.fullName }),
        this.firebase.getMember(row.profile.nameKey),
        this.firebase.getStudentWaivers(row.profile.fullName).catch(() => [] as WaiverData[])
      ]);
      this.clientCheckIns = checkIns.slice(0, 12);
      this.clientPayments = payments;
      this.clientWorkouts = workouts;
      // listAssessmentsForClient returns oldest → newest, so the last is current.
      this.clientLatestAssessment = assessments.length ? assessments[assessments.length - 1] : null;
      this.groupCell = member?.cell ?? null;
      this.groupGeneration = member?.generation ?? null;
      this.groupCohort = member?.cohort ?? null;
      this.groupSex = member?.sex ?? 'male';
      this.clientWaivers = waivers;
    } catch (err) {
      console.error('Clients: detail load failed', err);
    } finally {
      this.paymentsLoading = false;
    }
  }

  newClient() {
    this.selected = null;
    this.panelNew = true;
    this.form = {
      fullName: '',
      email: '',
      phone: '',
      birthdate: '',
      referralSource: '',
      currentStatus: 'active',
      onboardDate: localDateString()
    };
    this.clientPackages = [];
    this.clientCheckIns = [];
    this.clientPayments = [];
    this.clientWorkouts = [];
    this.clientLatestAssessment = null;
    this.clientWaivers = [];
    this.showPaymentForm = false;
    this.groupCell = null;
    this.groupGeneration = null;
    this.groupCohort = null;
    this.groupSex = 'male';
    this.panelOpen = true;
  }

  // Jump to the Omni Method assessment for this client (prefilled by name).
  openAssessment() {
    const name = this.selected?.profile.fullName || this.form.fullName;
    if (!name) return;
    this.router.navigate(['/assessments'], { queryParams: { client: name } });
  }

  // "Modify assessment" — lets this client's assessment replace any of the
  // 13 tracked tests with a custom one (Assessments page). Persists
  // immediately, same as a packages-page checkbox, rather than waiting on
  // the broader Save Profile button.
  async toggleAssessmentCustomizable() {
    if (!this.selected?.profile.id) return;
    const next = !this.selected.profile.assessmentCustomizable;
    this.selected.profile.assessmentCustomizable = next;
    try {
      await this.firebase.updateClientProfile(this.selected.profile.id, { assessmentCustomizable: next });
    } catch (err) {
      console.error('Students: failed to toggle assessmentCustomizable', err);
      this.selected.profile.assessmentCustomizable = !next;
      this.toast('Could not save that change', 'danger');
    }
  }

  closePanel() {
    this.panelOpen = false;
    this.selected = null;
  }

  // ---------- Waivers ----------
  // Tapping the client's name in the panel header is the entry point the
  // waiver was asked for — it lists whatever's on file (a client can have
  // more than one, e.g. re-signed or both an adult + child waiver) so any of
  // them can be opened as a printable PDF.
  onClientNameClick() {
    if (this.panelNew) return;
    if (!this.clientWaivers.length) {
      this.toast('No signed waiver on file for this client', 'warning');
      return;
    }
    this.waiverListOpen = true;
  }

  closeWaiverList() {
    this.waiverListOpen = false;
  }

  waiverDisplayName(w: WaiverData): string {
    return (w.waiverType === 'child' ? w.childName : w.fullName) || w.studentName;
  }

  waiverTypeLabel(w: WaiverData): string {
    return w.waiverType === 'child' ? 'Minor / Youth Waiver' : 'Adult Waiver';
  }

  openWaiverPdf(waiver: WaiverData) {
    this.pdfWaiver = waiver;
    this.waiverListOpen = false;
    this.pdfOpen = true;
    // Inject after the modal renders (ViewChild exists) and the layout has a
    // real size — two rAFs so the flex container is measured, not zero.
    requestAnimationFrame(() => {
      if (this.pdfPage) this.pdfPage.nativeElement.innerHTML = this.buildWaiverHtml(waiver);
      requestAnimationFrame(() => this.scaleWaiverToFit());
    });
  }

  closeWaiverPdf() {
    this.pdfOpen = false;
  }

  private scaleWaiverToFit() {
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

  async downloadWaiverPdf() {
    const page = this.pdfPage?.nativeElement;
    const waiver = this.pdfWaiver;
    if (!page || !waiver) return;
    try {
      const canvas = await html2canvas(page, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const pdf = new jsPDF({ unit: 'px', format: [794, 1123], orientation: 'portrait' });
      pdf.addImage(canvas.toDataURL('image/jpeg', 1), 'JPEG', 0, 0, 794, 1123);
      const safeName = (this.waiverDisplayName(waiver) || 'client')
        .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
      pdf.save(`waiver_${safeName || 'client'}_${waiver.signedDate}.pdf`);
    } catch (err) {
      console.error('Clients: waiver PDF export failed', err);
      this.toast('PDF export failed', 'danger');
    }
  }

  private adultWaiverText(): string {
    return `
      <p style="margin:0 0 10px">I acknowledge and agree that my participation in any and all training activities, exercises, programs, and services offered by this facility and its trainers, employees, agents, successors, and assigns (collectively referred to as "the Provider") is entirely voluntary and undertaken at my own risk. I understand that physical training carries inherent risks including, but not limited to, serious bodily injury, permanent disability, heart attack, stroke, paralysis, psychological trauma, or death, as well as property loss or damage. I hereby expressly and unequivocally waive, release, discharge, indemnify, and hold harmless the Provider from any and all claims, liabilities, obligations, demands, actions, damages, expenses, and costs of any kind or nature whatsoever, whether now known or unknown, foreseeable or unforeseeable, arising directly or indirectly out of or in connection with my participation, regardless of whether caused by negligence, fault, omission, or any other act or condition of the Provider or any other party.</p>
      <ul style="margin:0 0 10px;padding-left:18px">
        <li>I am physically fit and capable of safely participating in all training activities. I have either consulted a licensed physician or have voluntarily chosen not to do so and accept full responsibility for this decision.</li>
        <li>I will not hold the Provider responsible for any aggravation or worsening of any existing injuries or conditions, including unknown or latent medical issues.</li>
        <li>I waive the right to bring any claim in a court of law and agree to binding arbitration in the Commonwealth of Massachusetts as the sole and exclusive venue for any dispute resolution.</li>
        <li>I will not bring any collective or class action lawsuit against the Provider.</li>
        <li>This agreement shall be governed by and interpreted in accordance with the laws of the Commonwealth of Massachusetts, without regard to conflicts of laws principles.</li>
        <li>If any part of this waiver is deemed unenforceable, the remainder shall remain in full force and effect.</li>
      </ul>
      <p style="margin:0">I have read and understood this entire waiver and agree to be bound by its terms. I understand that by signing below, I am giving up substantial legal rights and that I am doing so voluntarily and of my own free will.</p>`;
  }

  private childWaiverText(): string {
    return `
      <p style="margin:0 0 10px">As the parent or legal guardian of the above-named child, I hereby give permission for my child to participate in any and all training activities, exercises, programs, and services offered by this facility and its trainers, employees, agents, successors, and assigns (collectively referred to as "the Provider"). I acknowledge that all training activities, programs, and services carry inherent risks, including but not limited to serious bodily injury, permanent disability, or death. On behalf of my child and myself, I hereby expressly and unequivocally waive, release, discharge, indemnify, and hold harmless the Provider from any and all claims, liabilities, obligations, demands, actions, damages, expenses, and costs of any kind or nature whatsoever arising directly or indirectly out of or in connection with my child's participation, regardless of whether caused by negligence, fault, omission, or any other act or condition of the Provider or any other party. This waiver is binding upon signing.</p>
      <ul style="margin:0 0 10px;padding-left:18px">
        <li>I confirm my child is medically and physically able to participate.</li>
        <li>I take full legal and financial responsibility for any injuries or damages.</li>
        <li>I waive the right to bring any claim in a court of law on my child's behalf or my own.</li>
        <li>I agree to binding arbitration in the Commonwealth of Massachusetts as the sole and exclusive venue for any dispute resolution.</li>
        <li>This waiver remains in effect indefinitely unless explicitly revoked in writing and acknowledged by the Provider.</li>
      </ul>
      <p style="margin:0">I have read and understood this entire waiver and agree to be bound by its terms. I understand that by signing below, I am giving up substantial legal rights on my child's behalf and my own, and that I am doing so voluntarily and of my own free will.</p>`;
  }

  private buildWaiverHtml(w: WaiverData): string {
    const isChild = w.waiverType === 'child';
    const name = this.waiverDisplayName(w);
    const dateLabel = new Date(w.signedDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const contactBlock = isChild
      ? `<div><strong>Child:</strong> ${w.childName || ''}</div>
         <div><strong>Guardian:</strong> ${w.guardianName || ''}</div>
         <div><strong>Guardian phone:</strong> ${w.guardianPhone || ''}</div>
         <div><strong>Guardian email:</strong> ${w.guardianEmail || ''}</div>`
      : `<div><strong>Name:</strong> ${w.fullName || ''}</div>
         <div><strong>Phone:</strong> ${w.phone || ''}</div>
         <div><strong>Email:</strong> ${w.email || ''}</div>`;

    return `
      <div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #e0e0e0;padding-bottom:14px;margin-bottom:24px">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:0.1em;color:#00d4ff">ASSESSMENTS</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.25em;text-transform:uppercase;color:#888888">Liability Waiver &amp; Release</div>
      </div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:34px;letter-spacing:0.03em;color:#111114">${name}</div>
      <div style="font-family:'Barlow',sans-serif;font-size:12px;color:#666666;margin-top:4px">
        ${this.waiverTypeLabel(w)} &nbsp;·&nbsp; Signed ${dateLabel}
      </div>
      <div style="margin-top:20px;font-family:'Barlow',sans-serif;font-size:11px;line-height:1.6;color:#333333">
        ${isChild ? this.childWaiverText() : this.adultWaiverText()}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:20px;font-family:'Barlow',sans-serif;font-size:11px;color:#444444">
        <div>${contactBlock}</div>
        <div style="text-align:right">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#999999;margin-bottom:6px">Signature</div>
          <img src="${w.signatureDataUrl}" style="max-width:260px;max-height:100px;border-bottom:1px solid #cccccc" />
        </div>
      </div>
      <div style="margin-top:auto;padding-top:12px;border-top:1px solid #eeeeee;font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#aaaaaa;text-align:center">
        ASSESSMENTS &nbsp;·&nbsp; ${dateLabel} &nbsp;·&nbsp; Project [000]
      </div>`;
  }

  async saveProfile() {
    const name = (this.form.fullName || '').trim();
    if (!name) {
      this.toast('Name is required', 'warning');
      return;
    }
    this.panelSaving = true;
    try {
      if (this.panelNew || !this.selected?.profile.id) {
        await this.firebase.upsertClientProfile({ ...this.form, fullName: name });
        this.toast('Client created');
      } else {
        await this.firebase.updateClientProfile(this.selected.profile.id, { ...this.form, fullName: name });
        this.toast('Client saved');
      }
      await this.firebase.setMemberDesignation(name.toLowerCase(), name, {
        cell: this.groupCell, generation: this.groupGeneration, cohort: this.groupCohort
      });
      await this.firebase.setMemberSex(name.toLowerCase(), name, this.groupSex);
      this.panelOpen = false;
      await this.loadData(true);
    } catch (err) {
      console.error('Clients: save failed', err);
      this.toast('Save failed', 'danger');
    } finally {
      this.panelSaving = false;
    }
  }

  async deleteClient() {
    if (!this.selected?.profile.id) return;
    const profile = this.selected.profile;
    const alert = await this.alertController.create({
      header: 'Delete client?',
      message: `${profile.fullName} will be removed. Their check-in history and packages stay in the database.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            await this.firebase.deleteClientProfile(profile.id!);
            this.toast('Client deleted');
            this.panelOpen = false;
            await this.loadData(true);
          }
        }
      ]
    });
    await alert.present();
  }

  // ---------- Check-in history ----------
  checkInBusy = new Set<string>();

  async deleteCheckIn(c: CheckIn) {
    if (!c.id || this.checkInBusy.has(c.id)) return;
    const alert = await this.alertController.create({
      header: 'Delete check-in?',
      message: c.decremented
        ? `Removes this visit from ${c.clientName}'s history and restores one session.`
        : `Removes this visit from ${c.clientName}'s history.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.doDeleteCheckIn(c)
        }
      ]
    });
    await alert.present();
  }

  private async doDeleteCheckIn(c: CheckIn) {
    const id = c.id!;
    this.checkInBusy.add(id);
    try {
      const remaining = await this.firebase.undoCheckIn(c);
      this.clientCheckIns = this.clientCheckIns.filter(x => x.id !== id);
      if (c.packageId && remaining != null) {
        const pkg = this.clientPackages.find(p => p.id === c.packageId);
        if (pkg) pkg.sessionsRemaining = remaining;
        if (this.selected?.activePackage?.id === c.packageId) {
          this.selected.sessionsRemaining = remaining;
        }
        const row = this.rows.find(r => r.activePackage?.id === c.packageId);
        if (row) row.sessionsRemaining = remaining;
      }
      this.toast('Check-in deleted');
    } catch (err) {
      console.error('Clients: failed to delete check-in', err);
      this.toast('Could not delete check-in', 'danger');
    } finally {
      this.checkInBusy.delete(id);
    }
  }

  async adjustSessions(pkg: PackageRecord, delta: number) {
    if (!pkg.id) return;
    try {
      const next = await this.firebase.adjustPackageSessions(pkg.id, delta);
      pkg.sessionsRemaining = next;
      const row = this.rows.find(r => r.activePackage?.id === pkg.id);
      if (row) row.sessionsRemaining = next;
    } catch (err) {
      console.error('Clients: session adjust failed', err);
      this.toast('Could not adjust sessions', 'danger');
    }
  }

  // ---------- Payments ----------
  private blankPayment() {
    return {
      amount: null as number | null,
      date: localDateString(),
      paymentMethod: 'venmo' as PaymentRecord['paymentMethod'],
      paymentStatus: 'paid' as PaymentRecord['paymentStatus'],
      notes: ''
    };
  }

  async savePayment() {
    if (!this.selected || !this.paymentForm.amount || this.paymentForm.amount <= 0) {
      this.toast('Enter a payment amount', 'warning');
      return;
    }
    const pkg = this.selected.activePackage;
    const sessionType: PaymentRecord['sessionType'] =
      pkg?.sessionType === 'Private' ? 'private' :
      pkg?.sessionType === 'Semi' ? 'semi-private' : 'group';
    try {
      await this.firebase.savePayment({
        studentName: this.selected.profile.fullName,
        amount: this.paymentForm.amount,
        date: this.paymentForm.date,
        sessionType,
        numSessions: pkg?.totalSessions ?? 0,
        discountPercent: 0,
        paymentMethod: this.paymentForm.paymentMethod,
        paymentStatus: this.paymentForm.paymentStatus,
        notes: this.paymentForm.notes
      });
      this.clientPayments = await this.firebase.getPaymentsForClient(this.selected.profile.fullName);
      this.showPaymentForm = false;
      this.paymentForm = this.blankPayment();
      this.toast('Payment recorded');
    } catch (err) {
      console.error('Clients: payment save failed', err);
      this.toast('Payment save failed', 'danger');
    }
  }

  private async toast(message: string, color: 'success' | 'warning' | 'danger' = 'success') {
    const t = await this.toastController.create({ message, duration: 1800, position: 'bottom', color });
    await t.present();
  }
}
