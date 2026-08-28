import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { IonContent, IonIcon, ViewWillEnter, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack, add, barbellOutline, createOutline, trashOutline, copyOutline,
  peopleOutline, calendarOutline, clipboardOutline, readerOutline
} from 'ionicons/icons';
import { FirebaseService, Program, WorkoutLog } from '../services/firebase.service';

@Component({
  selector: 'app-programs',
  templateUrl: './programs.page.html',
  styleUrls: ['./programs.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule, RouterModule]
})
export class ProgramsPage implements OnInit, ViewWillEnter {
  loading = true;
  programs: Program[] = [];
  recentLogs: WorkoutLog[] = [];

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private toastController: ToastController,
    private alertController: AlertController
  ) {
    addIcons({
      arrowBack, add, barbellOutline, createOutline, trashOutline, copyOutline,
      peopleOutline, calendarOutline, clipboardOutline, readerOutline
    });
  }

  async ngOnInit() {
    await this.load(true);
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

  newProgram() {
    this.router.navigateByUrl('/program-creator');
  }

  editProgram(p: Program) {
    this.router.navigate(['/program-creator', p.id]);
  }

  logSession(p: Program) {
    this.router.navigate(['/workout-log'], { queryParams: { programId: p.id } });
  }

  openLog(log: WorkoutLog) {
    this.router.navigate(['/workout-log'], { queryParams: { logId: log.id } });
  }

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
