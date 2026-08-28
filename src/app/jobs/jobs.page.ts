import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonIcon, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, addOutline, createOutline, trashOutline, closeOutline, saveOutline, peopleOutline, chevronDownOutline } from 'ionicons/icons';
import { FirebaseService, JobPosting, JobAcceptance } from '../services/firebase.service';

interface JobForm {
  title: string;
  description: string;
  hours: number | null;
  quantityTotal: number | null;
  // How many times one client may accept this specific job PER WEEK —
  // blank/null means no limit. Resets every Monday at 6am Eastern (e.g. a
  // recurring chore several people can each grab more than once a week).
  maxPerClient: number | null;
  // Whether the whole pool auto-refills back to quantityTotal on a
  // schedule — null means it never auto-refills.
  quantityResetCadence: 'weekly' | 'monthly' | null;
}

function blankForm(): JobForm {
  return {
    title: '', description: '', hours: null, quantityTotal: null,
    maxPerClient: null, quantityResetCadence: null
  };
}

// Job Request Board admin: create/edit/delete postings that show up as a
// 3x3 grid in Project-000. Clients accept postings there (transactionally —
// quantityAvailable is never written from here once a job is live); this
// page just shows who's accepted each one so the coach knows who to credit
// hours to on their client profile once the job is actually done.
@Component({
  selector: 'app-jobs',
  templateUrl: './jobs.page.html',
  styleUrls: ['./jobs.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule]
})
export class JobsPage implements OnInit {
  loading = true;
  jobs: JobPosting[] = [];
  acceptancesByJob = new Map<string, JobAcceptance[]>();
  expandedJobId: string | null = null;

  editingId: string | null = null; // null = not editing; 'new' = creating; else a job id
  form: JobForm = blankForm();
  saving = false;

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController
  ) {
    addIcons({ arrowBack, addOutline, createOutline, trashOutline, closeOutline, saveOutline, peopleOutline, chevronDownOutline });
  }

  async ngOnInit() {
    await this.loadData();
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  async loadData() {
    this.loading = true;
    try {
      const [jobs, acceptances] = await Promise.all([
        this.firebase.listJobPostings(),
        this.firebase.listJobAcceptances()
      ]);
      this.jobs = jobs.sort((a, b) => a.title.localeCompare(b.title));
      this.acceptancesByJob = new Map();
      for (const a of acceptances) {
        const list = this.acceptancesByJob.get(a.jobId) || [];
        list.push(a);
        this.acceptancesByJob.set(a.jobId, list);
      }
    } catch (err) {
      console.error('Jobs: load failed', err);
      this.toast('Failed to load jobs', 'danger');
    } finally {
      this.loading = false;
    }
  }

  // One row per acceptance (not deduped by client) — a client can accept the
  // same job more than once, and each occurrence has its own date.
  acceptedFor(job: JobPosting): JobAcceptance[] {
    return job.id ? this.acceptancesByJob.get(job.id) || [] : [];
  }

  toggleExpanded(job: JobPosting) {
    if (!job.id) return;
    this.expandedJobId = this.expandedJobId === job.id ? null : job.id;
  }

  startCreate() {
    this.editingId = 'new';
    this.form = blankForm();
  }

  startEdit(job: JobPosting) {
    if (!job.id) return;
    this.editingId = job.id;
    this.form = {
      title: job.title,
      description: job.description,
      hours: job.hours,
      quantityTotal: job.quantityTotal,
      maxPerClient: job.maxPerClient ?? null,
      quantityResetCadence: job.quantityResetCadence ?? null
    };
  }

  // What the pool actually shows as available right now — reads through a
  // stale pre-reset value the same way the client board does.
  quantityLeft(job: JobPosting): number {
    return this.firebase.effectiveQuantityAvailable(job);
  }

  cancelEdit() {
    this.editingId = null;
    this.form = blankForm();
  }

  get canSave(): boolean {
    return !this.saving && !!this.form.title.trim() &&
      this.form.hours != null && this.form.hours >= 0 &&
      this.form.quantityTotal != null && this.form.quantityTotal >= 0 &&
      (this.form.maxPerClient == null || this.form.maxPerClient >= 1);
  }

  async save() {
    if (!this.canSave) return;
    this.saving = true;
    try {
      const quantityTotal = Math.floor(this.form.quantityTotal!);
      const hours = this.form.hours!;
      const maxPerClient = this.form.maxPerClient != null ? Math.floor(this.form.maxPerClient) : null;
      const quantityResetCadence = this.form.quantityResetCadence;
      const quantityPeriodKey = this.firebase.computeQuantityPeriodKey(quantityResetCadence);

      if (this.editingId === 'new') {
        await this.firebase.upsertJobPosting({
          title: this.form.title.trim(),
          description: this.form.description.trim(),
          hours,
          quantityTotal,
          quantityAvailable: quantityTotal,
          maxPerClient,
          quantityResetCadence,
          quantityPeriodKey,
          status: 'active'
        });
        this.toast('Job posted');
      } else if (this.editingId) {
        const existing = this.jobs.find(j => j.id === this.editingId);
        if (!existing) return;
        // Already-accepted spots must stay claimed — shift the pool's
        // CURRENT effective value (which may itself be a stale pre-reset
        // number) by however much the total changed, instead of resetting
        // it outright.
        const effectiveExisting = this.firebase.effectiveQuantityAvailable(existing);
        const delta = quantityTotal - existing.quantityTotal;
        const quantityAvailable = Math.max(0, Math.min(quantityTotal, effectiveExisting + delta));
        await this.firebase.upsertJobPosting({
          id: existing.id,
          title: this.form.title.trim(),
          description: this.form.description.trim(),
          hours,
          quantityTotal,
          quantityAvailable,
          maxPerClient,
          quantityResetCadence,
          quantityPeriodKey
        });
        this.toast('Job updated');
      }
      this.editingId = null;
      this.form = blankForm();
      await this.loadData();
    } catch (err) {
      console.error('Jobs: save failed', err);
      this.toast('Save failed', 'danger');
    } finally {
      this.saving = false;
    }
  }

  async deleteJob(job: JobPosting) {
    if (!job.id) return;
    const ok = confirm(`Delete "${job.title}"? This can't be undone.`);
    if (!ok) return;
    try {
      await this.firebase.deleteJobPosting(job.id);
      this.jobs = this.jobs.filter(j => j.id !== job.id);
      this.toast('Job deleted');
    } catch (err) {
      console.error('Jobs: delete failed', err);
      this.toast('Delete failed', 'danger');
    }
  }

  private async toast(message: string, color: 'success' | 'danger' = 'success') {
    const t = await this.toastController.create({ message, duration: 1800, position: 'bottom', color });
    await t.present();
  }
}
