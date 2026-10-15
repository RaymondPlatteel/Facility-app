import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { FirebaseService, Member } from '../services/firebase.service';

interface Conflict { key: string; label: string; keepText: string; fromText: string }
interface Preview { keepName: string; fromName: string; counts: Array<{ collection: string; n: number }>; logins: number; conflicts: Conflict[]; fromProfile: boolean }

const LABELS: Record<string, string> = {
  assessments: 'Assessments', dailyCheckIns: 'Daily check-ins', memberWorkoutLogs: 'Workout logs', resilienceEntries: 'Resilience entries',
  assessmentGoals: 'Goals', pendingAssessments: 'Assessments awaiting review', pendingResilience: 'Resilience awaiting review', jobAcceptances: 'Accepted jobs'
};

// Joins two accounts of one person. Pick the account that stays (the one with the package) and the account to merge in;
// the page shows what will move and every setting where the two disagree, and you choose which to use. Nothing is deleted.
@Component({
  selector: 'app-merge',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './merge.page.html',
  styleUrls: ['./merge.page.scss']
})
export class MergePage implements OnInit {
  members: Member[] = [];
  keepKey = '';
  fromKey = '';
  preview: Preview | null = null;
  choices: Record<string, 'keep' | 'from'> = {};
  busy = false;
  done = false;
  error = '';

  constructor(private firebase: FirebaseService, private router: Router, private alerts: AlertController) {
    addIcons({ arrowBack });
  }

  async ngOnInit() {
    try { this.members = await this.firebase.listMembers(); } catch { this.error = 'The accounts could not be loaded.'; }
  }

  goBack() { this.router.navigate(['/remote-users']); }
  label(c: string) { return LABELS[c] ?? c; }
  option(m: Member) { return `${m.clientName}${m.inPerson ? ' · in person' : ''}${m.latestLvl != null ? ' · level ' + Math.round(m.latestLvl) : ''}`; }
  get ready(): boolean { return !!this.keepKey && !!this.fromKey && this.keepKey !== this.fromKey; }

  reset() { this.preview = null; this.done = false; this.error = ''; }

  async compare() {
    if (!this.ready || this.busy) return;
    this.busy = true; this.error = ''; this.preview = null;
    try {
      this.preview = await this.firebase.mergePreview(this.keepKey, this.fromKey);
      this.choices = {};
      this.preview.conflicts.forEach(c => { this.choices[c.key] = 'keep'; });
    } catch (e) { this.error = e instanceof Error ? e.message : 'The accounts could not be compared.'; }
    finally { this.busy = false; }
  }

  async merge() {
    if (!this.preview || this.busy) return;
    const p = this.preview;
    const alert = await this.alerts.create({
      header: 'Merge accounts?',
      message: `${p.fromName} will be merged into ${p.keepName}. Nothing is deleted.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Merge', handler: () => { this.run(); } }
      ]
    });
    await alert.present();
  }

  private async run() {
    this.busy = true; this.error = '';
    try {
      await this.firebase.mergeAccounts(this.keepKey, this.fromKey, this.choices);
      this.done = true;
    } catch (e) { this.error = e instanceof Error ? e.message : 'The merge failed. Nothing was deleted; it is safe to try again.'; }
    finally { this.busy = false; }
  }
}
