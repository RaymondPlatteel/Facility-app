import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon, AlertController, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, checkmarkCircleOutline, closeCircleOutline, chevronDownOutline, swapHorizontalOutline, chevronForwardOutline } from 'ionicons/icons';
import { FirebaseService, PendingAssessment, AssessmentInputs, LinkRequest, SwapRequest, PendingResilience } from '../services/firebase.service';
import { ASSESSMENT_META, RESILIENCE_TESTS, RESILIENCE_REPS, resilienceTestPct, computeOmni, getOmniRank } from '../services/omni.util';
import { SplitPoints, splitDeg } from '../services/split-mark.util';
import { SplitMarkEditorComponent } from '../shared/split-mark/split-mark-editor.component';
import { RunReviewComponent } from '../shared/run-review/run-review.component';
import { AiReviewService } from '../ai/ai-review.service';
import type { AiReview } from '../ai/ai-review.types';
import { AiPanelComponent } from '../ai/ai-panel.component';

interface DiffRow {
  label: string;
  unit: string;
  decimals: number;
  oldVal: number;
  newVal: number;
  changed: boolean;
}

// Field metadata for the diff view — bodyWeight/height aren't in
// ASSESSMENT_META (that's just the "highest level impact" test list) but
// belong in the comparison same as everything else.
const DIFF_META: Array<{ key: keyof AssessmentInputs; label: string; unit: string; decimals: number }> = [
  { key: 'bodyWeight', label: 'Body Weight', unit: 'lbs', decimals: 1 },
  { key: 'height', label: 'Height', unit: 'in', decimals: 1 },
  ...ASSESSMENT_META.map(m => ({ key: m.key as keyof AssessmentInputs, label: m.label, unit: m.unit, decimals: m.decimals }))
];

// Review happens entirely on this page: expanding a pending submission
// shows a read-only diff against the client's most recent approved
// assessment (changed fields highlighted, unchanged ones faded), with
// Approve/Reject right there — no navigating to the full assessments editor.
@Component({
  selector: 'app-pending-assessments',
  standalone: true,
  templateUrl: './pending-assessments.page.html',
  styleUrls: ['./pending-assessments.page.scss'],
  imports: [CommonModule, IonContent, IonIcon, SplitMarkEditorComponent, RunReviewComponent, AiPanelComponent]
})
export class PendingAssessmentsPage implements OnInit {
  pending: PendingAssessment[] = [];
  loading = true;

  // Project-000 "link my account" requests — a separate queue from the
  // assessment submissions above (different collection, no diff view
  // needed), shown on this same "things waiting on me" page rather than a
  // whole extra route.
  linkRequests: LinkRequest[] = [];
  linkRequestsLoading = true;

  // Athlete-submitted "request a different time" swap requests — a third
  // "things waiting on me" queue, same idea as link requests: its own
  // collection, no diff view, shown here rather than a whole extra route.
  swapRequests: SwapRequest[] = [];
  swapRequestsLoading = true;

  // Athlete-submitted resilience entries, reviewed the same way.
  readonly resilienceTests = RESILIENCE_TESTS;
  readonly resilienceReps = RESILIENCE_REPS;
  pendingRes: PendingResilience[] = [];
  pendingResLoading = true;
  expandedResId: string | null = null;
  swapRequestBusy = new Set<string>();

  expandedId: string | null = null;
  diffRows: DiffRow[] = [];
  // Unchanged results are folded away under the changed ones.
  showUnchanged = false;
  get changedRows(): DiffRow[] { return this.diffRows.filter(r => r.changed); }
  get unchangedRows(): DiffRow[] { return this.diffRows.filter(r => !r.changed); }
  // Keeps each proof's element in place across change detection, so a playing video is not reloaded.
  trackProof = (i: number) => i;
  trackPending = (_: number, p: PendingAssessment) => p.id;
  loadingDiff = false;
  // The coach's corrected middle split points, per submission, until it is approved.
  splitEdits: Record<string, SplitPoints> = {};
  // Who the open submission's run was already approved for, if anyone.
  runDuplicate: string | null = null;

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private alertController: AlertController,
    private toastController: ToastController,
    public aiReview: AiReviewService
  ) {
    addIcons({ arrowBack, checkmarkCircleOutline, closeCircleOutline, chevronDownOutline, swapHorizontalOutline, chevronForwardOutline });
  }

  async ngOnInit() {
    await this.refresh();
  }

  async ionViewWillEnter() {
    await this.refresh();
  }

  private async refresh() {
    this.loading = true;
    this.linkRequestsLoading = true;
    this.swapRequestsLoading = true;
    try {
      this.pending = (await this.firebase.listPendingAssessments())
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    } catch (err) {
      console.error('Pending assessments: load failed', err);
    } finally {
      this.loading = false;
    }
    try {
      this.pendingRes = (await this.firebase.listPendingResilience())
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    } catch (err) {
      console.error('Pending assessments: resilience load failed', err);
    } finally {
      this.pendingResLoading = false;
    }
    try {
      this.linkRequests = (await this.firebase.listPendingLinkRequests())
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (err) {
      console.error('Pending assessments: link request load failed', err);
    } finally {
      this.linkRequestsLoading = false;
    }
    try {
      this.swapRequests = (await this.firebase.listSwapRequests())
        .filter(r => r.status === 'pending')
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    } catch (err) {
      console.error('Pending assessments: swap request load failed', err);
    } finally {
      this.swapRequestsLoading = false;
    }
  }

  // Formats a swap request's from/to as one readable line, e.g.
  // "Wed, Sep 10 at 5:00 PM -> Fri, Sep 12 at 6:00 PM".
  swapRequestLabel(req: SwapRequest): { from: string; to: string } {
    const fmt = (dateKey: string, time: string) => {
      const d = new Date(dateKey + 'T00:00:00');
      const dateStr = isNaN(d.getTime())
        ? dateKey
        : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const formatTime12h = (t: string) => {
        if (!t || !/^\d{2}:\d{2}$/.test(t)) return '';
        const [hh, mm] = t.split(':').map(n => parseInt(n, 10));
        const period = hh >= 12 ? 'PM' : 'AM';
        const hour = hh % 12 === 0 ? 12 : hh % 12;
        return `${hour}:${String(mm).padStart(2, '0')} ${period}`;
      };
      return time ? `${dateStr} at ${formatTime12h(time)}` : dateStr;
    };
    return {
      from: fmt(req.originalDateKey, req.originalTime),
      to: fmt(req.requestedDateKey, req.requestedTime)
    };
  }

  async respondToSwap(req: SwapRequest, approve: boolean) {
    if (!req.id || this.swapRequestBusy.has(req.id)) return;
    this.swapRequestBusy.add(req.id);
    try {
      await this.firebase.respondToSwapRequest(req, approve);
      this.swapRequests = this.swapRequests.filter(r => r.id !== req.id);
      const t = await this.toastController.create({
        message: approve ? 'Swap approved' : 'Swap denied',
        duration: 1600, position: 'bottom', color: 'success'
      });
      await t.present();
    } catch (err) {
      console.error('Pending: failed to respond to swap request', err);
      const t = await this.toastController.create({
        message: 'Could not update the request', duration: 2000, position: 'bottom', color: 'danger'
      });
      await t.present();
    } finally {
      this.swapRequestBusy.delete(req.id);
    }
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  // ---------- AI review ----------
  aiFor(p: PendingAssessment, slot: number): AiReview | undefined {
    return this.aiReview.reviews$.value.find(r => r.id === `${p.id}_${slot}`);
  }

  // One line on the collapsed row: the worst verdict among the submission's videos.
  aiSummary(p: PendingAssessment): { text: string; tone: 'valid' | 'invalid' | 'review' } | null {
    const list = this.aiReview.reviews$.value.filter(r => r.pendingId === p.id);
    if (!list.length) return null;
    if (list.some(r => r.status === 'running')) return { text: 'analyzing', tone: 'review' };
    const done = list.filter(r => r.status === 'done');
    if (!done.length) return { text: 'could not read the video', tone: 'review' };
    if (done.some(r => r.verdict === 'likely-invalid')) return { text: 'likely invalid', tone: 'invalid' };
    if (done.some(r => r.verdict === 'needs-review')) return { text: 'needs your review', tone: 'review' };
    return { text: 'likely valid', tone: 'valid' };
  }

  // Each proof on a submission, labelled with the test it is for. A url is null while the phone is still uploading.
  proofItems(p: PendingAssessment): Array<{ label: string; kind: 'video' | 'photo' | 'run'; url: string | null }> {
    const slots = p.proofs?.length ?? p.videoPaths?.length ?? 0;
    return Array.from({ length: slots }, (_, i) => {
      const proof = p.proofs?.[i];
      const label = proof ? (ASSESSMENT_META.find(m => m.key === proof.test)?.label ?? proof.test) : `Video ${i + 1}`;
      return { label, kind: proof?.kind ?? 'video', url: p.videoUrls?.['v' + i] ?? null };
    });
  }

  proofSummary(p: PendingAssessment): string {
    const items = this.proofItems(p);
    if (!items.length) return '';
    return items.some(x => !x.url) ? ` · ${items.length} proof files, uploading` : ` · ${items.length} proof files`;
  }

  async toggleReview(p: PendingAssessment) {
    if (this.expandedId === p.id) {
      this.expandedId = null;
      this.diffRows = [];
      return;
    }
    this.expandedId = p.id ?? null;
    this.diffRows = [];
    this.loadingDiff = true;
    this.showUnchanged = false;
    this.runDuplicate = null;
    if (p.run?.key) {
      this.firebase.runApprovedFor(p.run.key)
        .then(who => { if (this.expandedId === p.id) this.runDuplicate = who; })
        .catch(err => console.error('Pending assessments: run check failed', err));
    }
    try {
      // The submission carries what the athlete started from and which inputs they changed; older submissions
      // fall back to the client's latest assessment and a comparison at display precision.
      let baseline: AssessmentInputs | null = p.baseInputs ?? null;
      if (!baseline) {
        const history = await this.firebase.listAssessmentsForClient({ clientName: p.clientName });
        baseline = history.length ? history[history.length - 1].inputs : null;
      }
      const changedKeys = p.changed?.length ? p.changed : null;
      this.diffRows = DIFF_META.map(m => {
        const oldVal = baseline ? Number(baseline[m.key]) || 0 : 0;
        const newVal = Number(p.inputs[m.key]) || 0;
        const changed = changedKeys
          ? changedKeys.some(k => k === m.key || k === m.key + 'Weight' || k === m.key + 'Reps')
          : oldVal.toFixed(m.decimals) !== newVal.toFixed(m.decimals);
        return { label: m.label, unit: m.unit, decimals: m.decimals, oldVal, newVal, changed };
      }).sort((a, b) => Number(b.changed) - Number(a.changed));
    } catch (err) {
      console.error('Pending assessments: baseline lookup failed', err);
    } finally {
      this.loadingDiff = false;
    }
  }

  // Leaves the pendingAssessments doc in place with status: 'approved' —
  // the mobile client shows that outcome to the athlete until they dismiss
  // it themselves, rather than it just silently vanishing.
  // Every approve and reject asks for an optional comment, which the athlete reads with the outcome.
  private async confirmWithComment(header: string, message: string, action: string, destructive: boolean): Promise<string | null> {
    const alert = await this.alertController.create({
      header,
      message,
      inputs: [{ name: 'note', type: 'textarea', placeholder: 'Comment for the athlete (optional)', attributes: { maxlength: 500, rows: 4 } }],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: action, role: destructive ? 'destructive' : 'confirm' }
      ]
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: { note?: string } }>();
    if (role === 'cancel' || role === 'backdrop') return null;
    return (data?.values?.note ?? '').trim();
  }

  // The middle split photo slot that carries the athlete's points.
  isSplitSlot(p: PendingAssessment, i: number): boolean { return !!p.split && p.split.slot === i; }
  onSplitEdit(p: PendingAssessment, pts: SplitPoints) { if (p.id) this.splitEdits[p.id] = pts; }

  // A middle split is scored by the coach's points. The recorded score is the coach's angle, or the athlete's current
  // score when that is higher, so a correction never takes a score below what was already approved.
  private async splitOutcome(p: PendingAssessment) {
    const m = p.split;
    if (!m || !p.changed?.includes('straddle')) return null;
    const coach = this.splitEdits[p.id ?? ''] ?? m.points;
    const coachDeg = splitDeg(coach, m.iw, m.ih);
    const history = await this.firebase.listAssessmentsForClient({ clientName: p.clientName });
    const current = Number(history[history.length - 1]?.inputs?.straddle) || 0;
    return { split: { ...m, coach, coachDeg, applied: Math.max(coachDeg, current) }, coachDeg, current };
  }

  async approve(p: PendingAssessment) {
    let outcome: Awaited<ReturnType<PendingAssessmentsPage['splitOutcome']>>;
    try {
      outcome = await this.splitOutcome(p);
    } catch (err) {
      console.error('Pending assessments: split lookup failed', err);
      return;
    }
    // A corrected angle changes the score, so the level and rank are worked out again.
    let { inputs, lvl, rank } = p;
    if (outcome && outcome.split.applied !== Number(p.inputs.straddle)) {
      inputs = { ...p.inputs, straddle: outcome.split.applied };
      lvl = computeOmni(inputs).lvl;
      rank = getOmniRank(lvl, (await this.firebase.getMember(p.nameKey).catch(() => null))?.sex ?? 'male');
    }
    const splitLine = !outcome ? '' : outcome.split.applied === outcome.coachDeg
      ? ` Middle Split is recorded as ${outcome.coachDeg}°.`
      : ` Middle Split measures ${outcome.coachDeg}°, below the current ${outcome.current}°, so ${outcome.current}° stays.`;
    const note = await this.confirmWithComment('Approve this assessment?',
      `${p.clientName} — LVL ${Math.max(1, Math.round(lvl))} · ${rank} will be saved to their record.${splitLine}`, 'Approve', false);
    if (note === null) return;
    try {
      await this.firebase.saveAssessment({
        clientId: null,
        clientName: p.clientName,
        nameKey: p.nameKey,
        timestamp: p.timestamp,
        dateLabel: p.dateLabel,
        inputs,
        lvl,
        rank
      }, (p.proofs ?? []).map(x => x.test));
      await this.firebase.approvePublicProofs(p, inputs);
      if (p.run?.key && p.changed?.includes('run30')) await this.firebase.markRunApproved(p.run.key, p.clientName);
      if (outcome) {
        await this.firebase.saveSplitReview(p.id!, outcome.split);
        // Learning is a bonus: a failure here never holds up the approval.
        this.firebase.learnSplit(outcome.split, p.videoUrls?.['v' + outcome.split.slot] ?? null)
          .catch(err => console.error('Pending assessments: split learning failed', err));
      }
      await this.firebase.setPendingAssessmentStatus(p.id!, 'approved', note);
      this.aiReview.recordDecision(p.id!, 'approved').catch(() => {});
      this.pending = this.pending.filter(x => x.id !== p.id);
      if (this.expandedId === p.id) this.expandedId = null;
      const t = await this.toastController.create({ message: 'Approved', duration: 1500, position: 'bottom' });
      await t.present();
    } catch (err) {
      console.error('Pending assessments: approve failed', err);
    }
  }

  toggleRes(p: PendingResilience) {
    this.expandedResId = this.expandedResId === p.id ? null : (p.id ?? null);
  }

  // Floor, not round — same convention as the Level everywhere else.
  resilienceLevel(p: PendingResilience): number {
    return Math.floor(p.score);
  }

  // Rows for the expanded view: every exercise, so a blank one is visibly
  // blank rather than silently missing from the list.
  resilienceRows(p: PendingResilience): Array<{ label: string; value: number; max: number; pct: number }> {
    return this.resilienceTests.map(t => {
      const value = Number(p.inputs?.[t.key] ?? 0);
      return { label: t.label, value, max: t.max, pct: resilienceTestPct(t.key, value) };
    });
  }

  async approveResilience(p: PendingResilience) {
    const note = await this.confirmWithComment('Approve this resilience entry?',
      `${p.clientName} — ${Math.floor(p.score)} · ${p.rank} will be saved to their record.`, 'Approve', false);
    if (note === null) return;
    try {
      await this.firebase.approvePendingResilience(p, note);
      this.pendingRes = this.pendingRes.filter(x => x.id !== p.id);
      if (this.expandedResId === p.id) this.expandedResId = null;
      const t = await this.toastController.create({ message: 'Approved', duration: 1500, position: 'bottom' });
      await t.present();
    } catch (err) {
      console.error('Pending assessments: resilience approve failed', err);
    }
  }

  async rejectResilience(p: PendingResilience) {
    const note = await this.confirmWithComment('Reject this resilience entry?',
      `${p.clientName} — ${Math.floor(p.score)} · ${p.rank} will be discarded, not saved.`, 'Reject', true);
    if (note === null) return;
    try {
      await this.firebase.setPendingResilienceStatus(p.id!, 'rejected', note);
      this.pendingRes = this.pendingRes.filter(x => x.id !== p.id);
      if (this.expandedResId === p.id) this.expandedResId = null;
      const t = await this.toastController.create({ message: 'Rejected', duration: 1500, position: 'bottom' });
      await t.present();
    } catch (err) {
      console.error('Pending assessments: resilience reject failed', err);
    }
  }

  async reject(p: PendingAssessment) {
    const note = await this.confirmWithComment('Reject this assessment?',
      `${p.clientName} — LVL ${Math.max(1, Math.round(p.lvl))} · ${p.rank} will be discarded, not saved.`, 'Reject', true);
    if (note === null) return;
    try {
      await this.firebase.setPendingAssessmentStatus(p.id!, 'rejected', note);
      this.aiReview.recordDecision(p.id!, 'rejected').catch(() => {});
      this.pending = this.pending.filter(x => x.id !== p.id);
      if (this.expandedId === p.id) this.expandedId = null;
      const t = await this.toastController.create({ message: 'Rejected', duration: 1500, position: 'bottom' });
      await t.present();
    } catch (err) {
      console.error('Pending assessments: reject failed', err);
    }
  }

  async approveLink(req: LinkRequest) {
    const alert = await this.alertController.create({
      header: 'Confirm this is them?',
      message: `Link this account to "${req.requestedName}"? They'll immediately be able to see that athlete's assessments, logs, and trends.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Approve',
          handler: async () => {
            try {
              await this.firebase.approveLinkRequest(req);
              this.linkRequests = this.linkRequests.filter(x => x.id !== req.id);
              const t = await this.toastController.create({ message: `Linked as ${req.requestedName}`, duration: 1500, position: 'bottom' });
              await t.present();
            } catch (err) {
              console.error('Pending assessments: link approve failed', err);
              // A mismatched name (see FirebaseService.approveLinkRequest) used
              // to fail silently here — the request just sat there with no
              // feedback, and the coach had no way to tell "nothing happened"
              // from "it worked." Surface whatever reason it was rejected for.
              const message = err instanceof Error ? err.message : 'Could not approve this link request.';
              const t = await this.toastController.create({ message, duration: 4000, position: 'bottom', color: 'danger' });
              await t.present();
            }
          }
        }
      ]
    });
    await alert.present();
  }

  async rejectLink(req: LinkRequest) {
    const alert = await this.alertController.create({
      header: 'Reject this link request?',
      message: `The account asking to be "${req.requestedName}" will not be linked.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Reject',
          role: 'destructive',
          handler: async () => {
            try {
              await this.firebase.rejectLinkRequest(req.id!);
              this.linkRequests = this.linkRequests.filter(x => x.id !== req.id);
              const t = await this.toastController.create({ message: 'Rejected', duration: 1500, position: 'bottom' });
              await t.present();
            } catch (err) {
              console.error('Pending assessments: link reject failed', err);
            }
          }
        }
      ]
    });
    await alert.present();
  }
}
