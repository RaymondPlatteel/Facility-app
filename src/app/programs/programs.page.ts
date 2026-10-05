import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { IonContent, IonIcon, ViewWillEnter, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, add, barbellOutline, createOutline, trashOutline, copyOutline,
  peopleOutline, calendarOutline, clipboardOutline, readerOutline, gitCompareOutline
} from 'ionicons/icons';
import { FirebaseService, Program, WorkoutLog } from '../services/firebase.service';
import { TopBarActionService } from '../services/top-bar-action.service';

@Component({
  selector: 'app-programs',
  templateUrl: './programs.page.html',
  styleUrls: ['./programs.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule, RouterModule]
})
export class ProgramsPage implements OnInit, OnDestroy, ViewWillEnter {
  loading = true;
  programs: Program[] = [];
  recentLogs: WorkoutLog[] = [];

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController,
    private alertController: AlertController,
    private topBarAction: TopBarActionService
  ) {
    addIcons({
      arrowBack, add, barbellOutline, createOutline, trashOutline, copyOutline,
      peopleOutline, calendarOutline, clipboardOutline, readerOutline, gitCompareOutline
    });
  }

  async ngOnInit() {
    this.topBarAction.set({ label: 'New Program', icon: 'add', onClick: () => this.newProgram() });
    await this.load(true);
  }

  ngOnDestroy() {
    this.topBarAction.clear();
  }

  async ionViewWillEnter() {
    await this.load(false);
  }

  private async load(showLoading: boolean) {
    if (showLoading) this.loading = true;
    try {
      const [programs, logs] = await Promise.all([
        this.firebase.listPrograms(),
        this.firebase.listWorkoutLogs({ max: 8 })
      ]);
      this.programs = programs;
      this.recentLogs = logs;
    } catch (err) {
      console.error('Programs: failed to load', err);
    }
    this.loading = false;
  }

  // Generated programs waiting on a first review, or with a question from the athlete not yet answered.
  get toReview(): Program[] {
    return this.programs.filter(p => p.generated && (p.reviewStatus !== 'approved' || !!p.proposal || this.needsReply(p)));
  }

  needsReply(p: Program): boolean {
    const last = (p.support || [])[(p.support || []).length - 1];
    return !!last && last.from === 'athlete';
  }

  reviewReason(p: Program): string {
    const parts: string[] = [];
    if (p.reviewStatus !== 'approved') parts.push('New program');
    if (p.proposal) parts.push('Program changes');
    if (this.needsReply(p)) parts.push('Question from the athlete');
    return parts.join(' · ');
  }

  newProgram() {
    this.router.navigateByUrl('/program-creator');
  }

  // Generated programs are reviewed in the review page; the creator would drop their per-set targets.
  editProgram(p: Program) {
    this.router.navigate([p.generated ? '/program-review' : '/program-creator', p.id]);
  }

  logSession(p: Program) {
    this.router.navigate(['/workout-log'], { queryParams: { programId: p.id } });
  }

  openLog(log: WorkoutLog) {
    this.router.navigate(['/workout-log'], { queryParams: { logId: log.id } });
  }

  openChangeLog() { this.router.navigateByUrl('/program-changes'); }

  openLogPage() {
    this.router.navigateByUrl('/workout-log');
  }

  trainingDays(p: Program): number {
    return (p.schedule || []).filter(d => !d.isRestDay && d.exercises.length > 0).length;
  }

  exerciseCount(p: Program): number {
    return (p.schedule || []).reduce((t, d) => t + d.exercises.length, 0);
  }

  cycleLabel(p: Program): string {
    return p.isStandardWeek ? 'week' : 'cycle';
  }

  async duplicateProgram(p: Program) {
    const copy: Program = JSON.parse(JSON.stringify(p));
    delete copy.id;
    copy.name = `${p.name} (copy)`;
    copy.createdAt = undefined;
    copy.assignedClientIds = [];
    copy.assignedClientNames = [];
    try {
      await this.firebase.saveProgram(copy);
      await this.load(false);
      await this.presentToast('Program duplicated');
    } catch (err) {
      console.error('Programs: duplicate failed', err);
      await this.presentToast('Could not duplicate', 'danger');
    }
  }

  async deleteProgram(p: Program) {
    const alert = await this.alertController.create({
      header: 'Delete program?',
      message: `"${p.name}" will be permanently deleted. Workout logs already recorded are kept.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete', role: 'destructive', handler: async () => {
            try {
              await this.firebase.deleteProgram(p.id!);
              this.programs = this.programs.filter(x => x.id !== p.id);
              await this.presentToast('Program deleted');
            } catch (err) {
              console.error('Programs: delete failed', err);
              await this.presentToast('Could not delete', 'danger');
            }
          }
        }
      ]
    });
    await alert.present();
  }

  logDateLabel(log: WorkoutLog): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(log.date);
    if (!m) return log.date;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 1500, position: 'bottom', color });
    await toast.present();
  }
}
