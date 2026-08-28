import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, LoadingController } from '@ionic/angular';
import { Router, ActivatedRoute, RouterModule } from '@angular/router';
import { FirebaseService, Workout, Session } from '../services/firebase.service';

@Component({
  selector: 'app-workouts-list',
  templateUrl: './workouts-list.page.html',
  styleUrls: ['./workouts-list.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule, RouterModule]
})
export class WorkoutsListPage implements OnInit {
  workouts: Workout[] = [];
  isLinkingMode = false;
  sessionId: string | null = null;
  currentSession: Session | null = null;
  sessionName: string | null = null;
  multiSessionCount: number = 0;

  constructor(
    private firebaseService: FirebaseService,
    private router: Router,
    private route: ActivatedRoute,
    private alertController: AlertController,
    private loadingController: LoadingController
  ) { }

  async ngOnInit() {
    // Check if we're in linking mode
    this.route.queryParams.subscribe(params => {
      this.isLinkingMode = params['mode'] === 'link';
      this.sessionId = params['sessionId'] || null;
      this.sessionName = params['sessionName'] || null;
      this.multiSessionCount = parseInt(params['multiSessionCount']) || 0;
    });

    if (this.isLinkingMode && this.sessionId) {
      await this.loadCurrentSession();
    }

    await this.loadWorkouts();
  }

  async ionViewWillEnter() {
    await this.loadWorkouts();
  }

  async loadCurrentSession() {
    if (!this.sessionId) return;

    try {
      const sessions = await this.firebaseService.getSessions();
      this.currentSession = sessions.find(s => s.id === this.sessionId) || null;
    } catch (error) {
      console.error('Error loading current session:', error);
    }
  }

  async loadWorkouts() {
    const loading = await this.loadingController.create({
      message: 'Loading workouts...'
    });
    await loading.present();

    try {
      this.workouts = await this.firebaseService.getWorkouts();
      console.log('Total workouts loaded from Firebase:', this.workouts.length);

      // Sort workouts by most recently created
      this.workouts.sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();
        return dateB - dateA;
      });

    } catch (error) {
      console.error('Error loading workouts:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load workouts. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  async linkWorkoutToSession(workout: Workout) {
    if (!this.sessionId || !workout.id) return;

    // If there are multiple sessions with the same name, ask about linking to all
    if (this.multiSessionCount > 1) {
      const alert = await this.alertController.create({
        header: 'Link Workout',
        message: `Link "${workout.name}" to "${this.sessionName}"?\n\nThere are ${this.multiSessionCount} sessions with this name.`,
        buttons: [
          {
            text: 'Cancel',
            role: 'cancel'
          },
          {
            text: 'Link to This Session Only',
            handler: async () => {
              await this.performLinkWorkout(workout, false);
            }
          },
          {
            text: `Link to All ${this.multiSessionCount} Sessions`,
            handler: async () => {
              await this.performLinkWorkout(workout, true);
            }
          }
        ]
      });
      await alert.present();
    } else {
      const alert = await this.alertController.create({
        header: 'Link Workout',
        message: `Link "${workout.name}" to "${this.currentSession?.name || this.sessionName}"?`,
        buttons: [
          {
            text: 'Cancel',
            role: 'cancel'
          },
          {
            text: 'Link',
            handler: async () => {
              await this.performLinkWorkout(workout, false);
            }
          }
        ]
      });
      await alert.present();
    }
  }

  async performLinkWorkout(workout: Workout, linkToAll: boolean = false) {
    if (!this.sessionId || !workout.id) return;

    const loading = await this.loadingController.create({
      message: linkToAll ? 'Linking workout to all sessions...' : 'Linking workout...'
    });
    await loading.present();

    try {
      const sessions = await this.firebaseService.getSessions();
      
      if (linkToAll && this.sessionName) {
        // Find all sessions with the same name that are today or in the future
        const currentSession = sessions.find(s => s.id === this.sessionId);
        if (currentSession) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          const sessionsToLink = sessions.filter(s => 
            s.name === this.sessionName && 
            new Date(s.date).getTime() >= new Date(currentSession.date).getTime()
          );

          // Update all matching sessions
          for (const session of sessionsToLink) {
            const updatedSession = { ...session, workoutId: workout.id };
            await this.firebaseService.updateSession(session.id!, updatedSession);
          }

          const alert = await this.alertController.create({
            header: 'Success',
            message: `Workout linked to ${sessionsToLink.length} sessions successfully!`,
            buttons: [
              {
                text: 'OK',
                handler: () => {
                  this.router.navigate(['/sessions']);
                }
              }
            ]
          });
          await alert.present();
        }
      } else {
        // Link to single session only
        const session = sessions.find(s => s.id === this.sessionId);
        
        if (session) {
          const updatedSession = { ...session, workoutId: workout.id };
          await this.firebaseService.updateSession(this.sessionId, updatedSession);

          const alert = await this.alertController.create({
            header: 'Success',
            message: 'Workout linked successfully!',
            buttons: [
              {
                text: 'OK',
                handler: () => {
                  this.router.navigate(['/sessions']);
                }
              }
            ]
          });
          await alert.present();
        }
      }

    } catch (error) {
      console.error('Error linking workout:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to link workout. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  async viewWorkout(workout: Workout) {
    // Create a detailed view alert showing full workout information
    const sections = workout.sections.map(section => {
      const exercises = section.exercises.map(exercise => {
        let exerciseDetails = `${exercise.name}: ${exercise.sets} sets x ${exercise.reps} reps`;
        if (exercise.percent) exerciseDetails += ` @ ${exercise.percent}%`;
        if (exercise.restTime) exerciseDetails += ` (${exercise.restTime} rest)`;
        return exerciseDetails;
      }).join('\n  • ');
      
      return `${section.name.toUpperCase()}:\n  • ${exercises}`;
    }).join('\n\n');

    const workoutDetails = `
WORKOUT: ${workout.name}
${workout.description ? `\nDESCRIPTION: ${workout.description}` : ''}
${workout.totalDuration ? `\nDURATION: ${workout.totalDuration} minutes` : ''}
${workout.equipment && workout.equipment.length > 0 ? `\nEQUIPMENT: ${workout.equipment.join(', ')}` : ''}

SECTIONS:
${sections}
    `.trim();

    const alert = await this.alertController.create({
      header: workout.name,
      message: workoutDetails,
      buttons: [
        {
          text: 'Edit',
          handler: () => {
            this.router.navigate(['/workouts'], { queryParams: { id: workout.id, mode: 'edit' } });
          }
        },
        {
          text: 'Close',
          role: 'cancel'
        }
      ],
      cssClass: 'workout-details-alert'
    });
    await alert.present();
  }

  async deleteWorkout(workout: Workout) {
    const alert = await this.alertController.create({
      header: 'Delete Workout',
      message: `Are you sure you want to delete "${workout.name}"? This action cannot be undone.`,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            await this.performDeleteWorkout(workout);
          }
        }
      ]
    });
    await alert.present();
  }

  async performDeleteWorkout(workout: Workout) {
    if (!workout.id) return;

    const loading = await this.loadingController.create({
      message: 'Deleting workout...'
    });
    await loading.present();

    try {
      await this.firebaseService.deleteWorkout(workout.id);
      await this.loadWorkouts(); // Refresh the list

      const alert = await this.alertController.create({
        header: 'Success',
        message: 'Workout deleted successfully!',
        buttons: ['OK']
      });
      await alert.present();

    } catch (error) {
      console.error('Error deleting workout:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to delete workout. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  goBack() {
    if (this.isLinkingMode) {
      this.router.navigate(['/sessions']);
    } else {
      this.router.navigate(['/home']);
    }
  }

  getWorkoutSummary(workout: Workout): string {
    const sectionsCount = workout.sections.length;
    const duration = workout.totalDuration || 0;
    return `${sectionsCount} section${sectionsCount !== 1 ? 's' : ''} • ${duration} min`;
  }
}
