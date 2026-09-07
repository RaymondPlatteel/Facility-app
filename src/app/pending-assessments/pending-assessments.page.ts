import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon, AlertController, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, checkmarkCircleOutline, closeCircleOutline, chevronDownOutline, swapHorizontalOutline, chevronForwardOutline } from 'ionicons/icons';
import { FirebaseService, PendingAssessment, AssessmentInputs, LinkRequest, SwapRequest } from '../services/firebase.service';
import { ASSESSMENT_META } from '../services/omni.util';

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
  imports: [CommonModule, IonContent, IonIcon]
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
  swapRequestBusy = new Set<string>();

  expandedId: string | null = null;
  diffRows: DiffRow[] = [];
  loadingDiff = false;

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private alertController: AlertController,
    private toastController: ToastController
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

  async toggleReview(p: PendingAssessment) {
    if (this.expandedId === p.id) {
      this.expandedId = null;
      this.diffRows = [];
      return;
    }
    this.expandedId = p.id ?? null;
    this.diffRows = [];
    this.loadingDiff = true;
    try {
      const history = await this.firebase.listAssessmentsForClient({ clientName: p.clientName });
      const baseline = history.length ? history[history.length - 1].inputs : null;
      this.diffRows = DIFF_META.map(m => {
        const oldVal = baseline ? Number(baseline[m.key]) || 0 : 0;
        const newVal = Number(p.inputs[m.key]) || 0;
        return {
          label: m.label,
          unit: m.unit,
          decimals: m.decimals,
          oldVal,
          newVal,
          changed: Math.abs(newVal - oldVal) > 1e-9
        };
      });
    } catch (err) {
      console.error('Pending assessments: baseline lookup failed', err);
    } finally {
      this.loadingDiff = false;
    }
  }

  // Leaves the pendingAssessments doc in place with status: 'approved' —
  // the mobile client shows that outcome to the athlete until they dismiss
  // it themselves, rather than it just silently vanishing.
  async approve(p: PendingAssessment) {
    try {
      await this.firebase.saveAssessment({
        clientId: null,
        clientName: p.clientName,
        nameKey: p.nameKey,
        timestamp: p.timestamp,
        dateLabel: p.dateLabel,
        inputs: p.inputs,
        lvl: p.lvl,
        rank: p.rank
      });
      await this.firebase.setPendingAssessmentStatus(p.id!, 'approved');
      this.pending = this.pending.filter(x => x.id !== p.id);
      if (this.expandedId === p.id) this.expandedId = null;
      const t = await this.toastController.create({ message: 'Approved', duration: 1500, position: 'bottom' });
      await t.present();
    } catch (err) {
      console.error('Pending assessments: approve failed', err);
    }
  }

  async reject(p: PendingAssessment) {
    const alert = await this.alertController.create({
      header: 'Reject this assessment?',
      message: `${p.clientName} — LVL ${Math.max(1, Math.round(p.lvl))} · ${p.rank} will be discarded, not saved.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Reject',
          role: 'destructive',
          handler: async () => {
            try {
              await this.firebase.setPendingAssessmentStatus(p.id!, 'rejected');
              this.pending = this.pending.filter(x => x.id !== p.id);
              if (this.expandedId === p.id) this.expandedId = null;
              const t = await this.toastController.create({ message: 'Rejected', duration: 1500, position: 'bottom' });
              await t.present();
            } catch (err) {
              console.error('Pending assessments: reject failed', err);
            }
          }
        }
      ]
    });
    await alert.present();
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
