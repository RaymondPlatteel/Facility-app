import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { FirebaseService, Workout } from '../services/firebase.service';

@Component({
  selector: 'app-workout-display',
  templateUrl: './workout-display.page.html',
  styleUrls: ['./workout-display.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule]
})
export class WorkoutDisplayPage implements OnInit {
  workout: Workout | null = null;
  loading = true;
  error: string | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private firebaseService: FirebaseService
  ) { }

  async ngOnInit() {
    const workoutId = this.route.snapshot.queryParamMap.get('id');
    if (workoutId) {
      await this.loadWorkout(workoutId);
    } else {
      this.error = 'No workout ID provided';
      this.loading = false;
    }
  }

  async loadWorkout(workoutId: string) {
    try {
      const workouts = await this.firebaseService.getWorkouts();
      this.workout = workouts.find(w => w.id === workoutId) || null;
      
      if (!this.workout) {
        this.error = 'Workout not found';
      }
    } catch (error) {
      console.error('Error loading workout:', error);
      this.error = 'Failed to load workout';
    } finally {
      this.loading = false;
    }
  }

  editWorkout() {
    if (this.workout?.id) {
      this.router.navigate(['/workouts'], { queryParams: { id: this.workout.id, mode: 'edit' } });
    }
  }

  goBack() {
    this.router.navigate(['/workouts-list']);
  }

  getExerciseDetails(exercise: any): string {
    const details: string[] = [];
    
    if (exercise.sets && exercise.reps) {
      details.push(`${exercise.sets} sets × ${exercise.reps} reps`);
    }
    
    if (exercise.percent) {
      details.push(`${exercise.percent}%`);
    }
    
    if (exercise.rir !== undefined) {
      details.push(`RIR ${exercise.rir}`);
    }
    
    if (exercise.restTime) {
      details.push(`Rest: ${exercise.restTime}`);
    }
    
    if (exercise.tempo) {
      details.push(`Tempo: ${exercise.tempo}`);
    }
    
    return details.join(' • ');
  }
} 