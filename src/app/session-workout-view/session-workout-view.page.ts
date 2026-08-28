import { Component, OnInit, OnDestroy, AfterViewInit, ViewChild, ElementRef, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController } from '@ionic/angular';
import { ActivatedRoute, Router } from '@angular/router';
import { FirebaseService, Session, Workout, Exercise } from '../services/firebase.service';

@Component({
  selector: 'app-session-workout-view',
  templateUrl: './session-workout-view.page.html',
  styleUrls: ['./session-workout-view.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule]
})
export class SessionWorkoutViewPage implements OnInit, OnDestroy, AfterViewInit {
  session: Session | null = null;
  workout: Workout | null = null;
  loading = true;
  error: string | null = null;

  // Timer-based workout properties
  currentSectionIndex = 0;
  currentExerciseIndex = 0;
  isTimerRunning = false;
  workoutElapsedTime = 0; // in seconds
  private timer: any;
  private startTime: Date | null = null;
  private sectionStartTimes: number[] = []; // Track when each section should start (in seconds)

  @ViewChild('exercisesLayout', { static: false }) exercisesLayoutRef!: ElementRef;
  dynamicFontSize = 16; // px, default
  readonly minFontSize = 1; // px

  constructor(
    private route: ActivatedRoute,
    private firebaseService: FirebaseService,
    private router: Router,
    private alertController: AlertController,
    private ngZone: NgZone
  ) { }

  async ngOnInit() {
    const sessionId = this.route.snapshot.paramMap.get('sessionId');
    if (sessionId) {
      // Always reset timer state when entering the page
      this.stopTimer(); // Make sure any existing timer is stopped
      this.workoutElapsedTime = 0;
      this.currentSectionIndex = 0;
      this.currentExerciseIndex = 0;
      this.sectionStartTimes = [];
      this.isTimerRunning = false;
      this.startTime = null;
      
      await this.loadSessionAndWorkout(sessionId);
    } else {
      this.error = 'No session ID provided';
      this.loading = false;
    }
  }

  ngAfterViewInit() {
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('resize', this.recalculateFontSize);
    });
    setTimeout(() => this.recalculateFontSize(), 100);
  }

  ngOnDestroy() {
    this.stopTimer();
    window.removeEventListener('resize', this.recalculateFontSize);
  }

  get currentSection() {
    return this.workout?.sections[this.currentSectionIndex] || null;
  }

  get currentExercise() {
    return this.currentSection?.exercises[this.currentExerciseIndex] || null;
  }

  calculateSectionStartTimes() {
    if (!this.workout?.sections) return;
    
    this.sectionStartTimes = [];
    let cumulativeTime = 0;
    
    for (const section of this.workout.sections) {
      this.sectionStartTimes.push(cumulativeTime);
      cumulativeTime += (section.duration || 0) * 60; // Convert minutes to seconds
    }
  }

  startTimer() {
    // Stop any existing timer first
    this.stopTimer();
    
    this.isTimerRunning = true;
    this.startTime = new Date();

    this.timer = setInterval(() => {
      this.workoutElapsedTime++;
      
      // Check if we should auto-advance to the next section
      this.checkForSectionAdvance();
      
      // Update current exercise highlighting based on time (if we didn't just advance sections)
      if (this.currentSection?.duration) {
        this.updateCurrentExerciseByTime();
      }
    }, 1000);
  }

  checkForSectionAdvance() {
    if (!this.workout?.sections || this.currentSectionIndex >= this.workout.sections.length - 1) {
      return; // Don't advance if we're on the last section
    }
    
    const nextSectionIndex = this.currentSectionIndex + 1;
    const nextSectionStartTime = this.sectionStartTimes[nextSectionIndex];
    
    if (this.workoutElapsedTime >= nextSectionStartTime) {
      this.currentSectionIndex = nextSectionIndex;
      this.currentExerciseIndex = 0;
    }
    
    // Update current exercise based on time within section
    this.updateCurrentExerciseByTime();
  }

  updateCurrentExerciseByTime() {
    if (!this.currentSection?.exercises.length || !this.currentSection.duration) {
      return;
    }
    
    const sectionStartTime = this.sectionStartTimes[this.currentSectionIndex];
    const timeIntoSection = this.workoutElapsedTime - sectionStartTime;
    const actualSectionDuration = this.getActualSectionDuration();
    const exerciseCount = this.currentSection.exercises.length;
    
    // Calculate which exercise should be highlighted based on actual duration (including bonus time)
    const timePerExercise = actualSectionDuration / exerciseCount;
    const calculatedExerciseIndex = Math.floor(timeIntoSection / timePerExercise);
    
    // Ensure we don't go beyond the last exercise
    this.currentExerciseIndex = Math.min(calculatedExerciseIndex, exerciseCount - 1);
  }

  getActualSectionDuration(): number {
    if (!this.currentSection?.duration) return 0;
    
    // Calculate the actual duration including any bonus time from early section advances
    const originalDuration = this.currentSection.duration * 60; // Convert to seconds
    const sectionStartTime = this.sectionStartTimes[this.currentSectionIndex];
    
    // If this is not the last section, the actual duration is until the next section starts
    if (this.currentSectionIndex < this.sectionStartTimes.length - 1) {
      const nextSectionStartTime = this.sectionStartTimes[this.currentSectionIndex + 1];
      return nextSectionStartTime - sectionStartTime;
    }
    
    // For the last section, use the original duration
    return originalDuration;
  }

  getSectionProgress(): number {
    if (!this.currentSection?.duration) return 0;
    
    const sectionStartTime = this.sectionStartTimes[this.currentSectionIndex];
    const timeIntoSection = this.workoutElapsedTime - sectionStartTime;
    const actualSectionDuration = this.getActualSectionDuration();
    
    const progress = (timeIntoSection / actualSectionDuration) * 100;
    return Math.min(Math.max(progress, 0), 100); // Clamp between 0 and 100
  }

  stopTimer() {
    this.isTimerRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  nextExercise() {
    if (this.currentExerciseIndex < (this.currentSection?.exercises.length || 0) - 1) {
      this.currentExerciseIndex++;
    } else {
      this.nextSection();
    }
  }

  previousExercise() {
    if (this.currentExerciseIndex > 0) {
      this.currentExerciseIndex--;
    } else if (this.currentSectionIndex > 0) {
      this.currentSectionIndex--;
      this.currentExerciseIndex = (this.currentSection?.exercises.length || 1) - 1;
    }
  }

  previousSection() {
    if (this.currentSectionIndex > 0) {
      this.currentSectionIndex--;
      this.currentExerciseIndex = 0;
    }
  }

  nextSection() {
    if (this.currentSectionIndex < (this.workout?.sections.length || 0) - 1) {
      this.adjustSectionTimesForEarlyAdvance();
      this.currentSectionIndex++;
      this.currentExerciseIndex = 0;
      this.ngAfterSectionChange();
    } else {
      // Workout complete
      this.finishWorkout();
    }
  }

  adjustSectionTimesForEarlyAdvance() {
    if (!this.currentSection?.duration) return;
    
    const sectionStartTime = this.sectionStartTimes[this.currentSectionIndex];
    const timeIntoSection = this.workoutElapsedTime - sectionStartTime;
    const sectionDurationSeconds = this.currentSection.duration * 60;
    const remainingTimeInSection = sectionDurationSeconds - timeIntoSection;
    
    // Only adjust if there's remaining time (i.e., advancing early)
    if (remainingTimeInSection > 0) {
      // Subtract the remaining time from all future section start times
      // This effectively gives you extra time in the next section
      for (let i = this.currentSectionIndex + 1; i < this.sectionStartTimes.length; i++) {
        this.sectionStartTimes[i] -= remainingTimeInSection;
      }
    }
  }

  finishWorkout() {
    // Stop the timer and reset all state
    this.stopTimer();
    this.workoutElapsedTime = 0;
    this.currentSectionIndex = 0;
    this.currentExerciseIndex = 0;
    this.sectionStartTimes = [];
    this.isTimerRunning = false;
    this.startTime = null;
    
    // Clear any stored timer state
    localStorage.removeItem('workoutTimerState');
    
    // Could add completion logic here
    this.goBack();
  }

  isLastExercise(): boolean {
    const isLastSection = this.currentSectionIndex === (this.workout?.sections.length || 0) - 1;
    const isLastExerciseInSection = this.currentExerciseIndex === (this.currentSection?.exercises.length || 0) - 1;
    return isLastSection && isLastExerciseInSection;
  }

  getOverallProgress(): number {
    if (!this.workout?.sections.length) return 0;
    
    const totalSections = this.workout.sections.length;
    const completedSections = this.currentSectionIndex;
    const currentSectionProgress = this.currentSection?.exercises.length ? 
      this.currentExerciseIndex / this.currentSection.exercises.length : 0;
    
    return ((completedSections + currentSectionProgress) / totalSections) * 100;
  }

  formatTimerTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  formatTime(date: Date | string): string {
    try {
      const dateObj = new Date(date);
      return dateObj.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch (error) {
      return 'Invalid time';
    }
  }

  async loadSessionAndWorkout(sessionId: string) {
    try {
      // Load all sessions and find the specific one
      const sessions = await this.firebaseService.getSessions();
      this.session = sessions.find(s => s.id === sessionId) || null;

      if (!this.session) {
        this.error = 'Session not found';
        this.loading = false;
        return;
      }

      // Load the linked workout if it exists
      if (this.session?.workoutId) {
        const workouts = await this.firebaseService.getWorkouts();
        this.workout = workouts.find(w => w.id === this.session!.workoutId) || null;
        
        if (!this.workout) {
          this.error = 'Workout not found for this session';
        } else {
          // Calculate section start times
          this.calculateSectionStartTimes();
          // Automatically start the timer when workout loads
          this.startTimer();
        }
      } else {
        this.error = 'No workout linked to this session';
      }

    } catch (error) {
      console.error('Error loading session and workout:', error);
      this.error = 'Failed to load session data';
    } finally {
      this.loading = false;
    }
  }

  formatDate(date: Date | string): string {
    try {
      const sessionDate = new Date(date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sessionDateOnly = new Date(sessionDate);
      sessionDateOnly.setHours(0, 0, 0, 0);
      
      if (sessionDateOnly.getTime() === today.getTime()) {
        return 'Today';
      }
      
      return sessionDate.toLocaleDateString('en-US', { 
        weekday: 'long',
        month: 'long', 
        day: 'numeric',
        year: 'numeric'
      });
    } catch (error) {
      return 'Invalid date';
    }
  }

  editWorkout() {
    if (this.workout?.id) {
      // Pause the timer while editing
      const wasRunning = this.isTimerRunning;
      if (wasRunning) {
        this.stopTimer();
      }
      
      // Store timer state for when we return
      localStorage.setItem('workoutTimerState', JSON.stringify({
        workoutElapsedTime: this.workoutElapsedTime,
        currentSectionIndex: this.currentSectionIndex,
        currentExerciseIndex: this.currentExerciseIndex,
        sectionStartTimes: this.sectionStartTimes,
        wasRunning: wasRunning,
        sessionId: this.route.snapshot.paramMap.get('sessionId')
      }));
      
      // Navigate to workouts page with correct edit parameters
      this.router.navigate(['/workouts'], { 
        queryParams: { 
          id: this.workout.id,
          mode: 'edit'
        } 
      });
    }
  }

  goBack() {
    this.router.navigate(['/sessions']);
  }

  getExerciseDetails(exercise: any): string[] {
    const details: string[] = [];
    
    if (exercise.sets && exercise.reps) {
      details.push(`${exercise.sets} sets × ${exercise.reps} reps`);
    }
    
    if (exercise.percent) {
      details.push(`${exercise.percent}% intensity`);
    }
    
    if (exercise.rir !== undefined && exercise.rir !== null) {
      details.push(`${exercise.rir} RIR`);
    }
    
    if (exercise.restTime) {
      details.push(`${exercise.restTime} rest`);
    }
    
    if (exercise.tempo) {
      details.push(`Tempo: ${exercise.tempo}`);
    }
    
    return details;
  }

  getCompactExerciseDetails(exercise: any): string {
    const details: string[] = [];
    
    if (exercise.sets && exercise.reps) {
      details.push(`${exercise.sets}×${exercise.reps}`);
    }
    
    return details.join(' • ');
  }

  isResistanceExercise(exercise: any): boolean {
    // Check if exercise has a percentage (indicating it's a resistance exercise)
    return exercise.percent && exercise.percent > 0;
  }

  getParticipantWeight(participant: string, exercise: any): string {
    if (!exercise.percent) return 'N/A';
    
    // Get participant's 1RM for this exercise from localStorage
    const participantData = this.getParticipantData(participant);
    const exerciseName = exercise.name.toLowerCase();
    const oneRM = participantData.exercises[exerciseName]?.oneRM || 0;
    
    if (oneRM === 0) {
      return 'No data';
    }
    
    // Calculate working weight based on percentage
    const workingWeight = Math.round((oneRM * exercise.percent) / 100);
    return `${workingWeight} lbs`;
  }

  getParticipantData(participant: string): any {
    const key = `participant_${participant.toLowerCase().replace(/\s+/g, '_')}`;
    const data = localStorage.getItem(key);
    
    if (data) {
      return JSON.parse(data);
    }
    
    // Return default structure
    return {
      name: participant,
      exercises: {},
      lastUpdated: new Date().toISOString()
    };
  }

  saveParticipantData(participant: string, data: any): void {
    const key = `participant_${participant.toLowerCase().replace(/\s+/g, '_')}`;
    data.lastUpdated = new Date().toISOString();
    localStorage.setItem(key, JSON.stringify(data));
  }

  ngAfterSectionChange() {
    setTimeout(() => this.recalculateFontSize(), 50);
  }

  recalculateFontSize = () => {
    if (!this.exercisesLayoutRef || !this.currentSection) return;
    const container = this.exercisesLayoutRef.nativeElement as HTMLElement;
    const availableHeight = container.clientHeight;
    const exerciseCount = this.currentSection.exercises.length;
    if (exerciseCount === 0) return;
    // Use a very small fudge factor so font shrinks as much as needed
    let fontSize = Math.floor(availableHeight / (exerciseCount * 1.05));
    if (fontSize < this.minFontSize) fontSize = this.minFontSize;
    this.dynamicFontSize = fontSize;
  }
}
