import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { Platform } from '@ionic/angular';
import { Subscription } from 'rxjs';
import { 
  IonContent, 
  IonHeader, 
  IonTitle, 
  IonToolbar, 
  IonIcon,
  IonButton,
  IonButtons,
  IonSelect,
  IonSelectOption,
  IonModal,
  LoadingController,
  AlertController 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, add, create, trash, time, barbellOutline, close, save } from 'ionicons/icons';
import { FirebaseService, Workout, WorkoutSection, Exercise } from '../services/firebase.service';

@Component({
  selector: 'app-workouts',
  templateUrl: './workouts.page.html',
  styleUrls: ['./workouts.page.scss'],
  standalone: true,
  imports: [
    IonContent, 
    IonHeader, 
    IonTitle, 
    IonToolbar, 
    IonIcon,
    IonButton,
    IonButtons,
    IonSelect,
    IonSelectOption,
    IonModal,
    CommonModule, 
    FormsModule
  ]
})
export class WorkoutsPage implements OnInit, OnDestroy {
  
  // Workout management
  currentWorkout: Workout = this.createEmptyWorkout();
  isEditMode = false;
  private originalWorkout: Workout = this.createEmptyWorkout(); // Track original state
  
  // Section management
  showSectionModal = false;
  currentSection: WorkoutSection = this.createEmptySection();
  editingSectionIndex = -1;
  
  // Exercise management
  showExerciseModal = false;
  currentExercise: Exercise = this.createEmptyExercise();
  editingExerciseIndex = -1;
  currentSectionIndex = -1;

  private backButtonSubscription!: Subscription;

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router,
    private route: ActivatedRoute,
    private platform: Platform
  ) {
    addIcons({
      arrowBack,
      add,
      create,
      trash,
      time,
      barbellOutline,
      close,
      save
    });
  }

  async ngOnInit() {
    console.log('Workout creation page loaded');
    
    // Check for edit mode query parameters
    this.route.queryParams.subscribe(async params => {
      const workoutId = params['id'];
      const mode = params['mode'];
      
      if (workoutId && mode === 'edit') {
        await this.loadWorkoutForEdit(workoutId);
      }
    });
    
    // Store the initial state
    this.originalWorkout = JSON.parse(JSON.stringify(this.currentWorkout));
    
    // Handle hardware back button
    this.backButtonSubscription = this.platform.backButton.subscribeWithPriority(10, () => {
      this.goBack();
    });
  }

  ngOnDestroy() {
    this.backButtonSubscription.unsubscribe();
  }

  // Navigation with unsaved changes detection
  async goBack() {
    if (this.hasUnsavedChanges()) {
      await this.showUnsavedChangesDialog();
    } else {
      this.navigateBack();
    }
  }

  private hasUnsavedChanges(): boolean {
    // Check if there are any meaningful changes
    const current = this.currentWorkout;
    const original = this.originalWorkout;
    
    // If the workout has a name or sections, consider it as having changes
    return !!(
      current.name.trim() ||
      current.description?.trim() ||
      current.sections.length > 0 ||
      (current.totalDuration && current.totalDuration !== original.totalDuration)
    );
  }

  private async showUnsavedChangesDialog() {
    const alert = await this.alertController.create({
      header: 'Unsaved Changes',
      message: 'You have unsaved changes to your workout. What would you like to do?',
      buttons: [
        {
          text: 'Discard Changes',
          role: 'destructive',
          handler: () => {
            this.navigateBack();
          }
        },
        {
          text: 'Save as Draft',
          handler: async () => {
            await this.saveDraft();
          }
        },
        {
          text: 'Continue Editing',
          role: 'cancel'
        }
      ]
    });
    
    await alert.present();
  }

  private async saveDraft() {
    // Save as draft even if incomplete
    const loading = await this.loadingController.create({
      message: 'Saving draft...'
    });
    await loading.present();

    try {
      // Create a draft version of the workout
      const draftWorkout: any = {
        name: this.currentWorkout.name || 'Untitled Workout Draft',
        description: this.currentWorkout.description || '',
        sections: this.currentWorkout.sections || [],
        totalDuration: this.currentWorkout.totalDuration || 60,
        equipment: this.currentWorkout.equipment || [],
        tags: [...(this.currentWorkout.tags || []), 'draft'],
        isDraft: true,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      await this.firebaseService.saveWorkout(draftWorkout);
      await loading.dismiss();

      const successAlert = await this.alertController.create({
        header: 'Draft Saved!',
        message: 'Your workout has been saved as a draft. You can continue editing it later.',
        buttons: [
          {
            text: 'OK',
            handler: () => {
              this.navigateBack();
            }
          }
        ]
      });
      await successAlert.present();

    } catch (error) {
      await loading.dismiss();
      console.error('Error saving draft:', error);
      
      const errorAlert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to save draft. Your changes will be lost if you leave now.',
        buttons: ['OK']
      });
      await errorAlert.present();
    }
  }

  private navigateBack() {
    // Check if we have a saved timer state to determine where to go back
    const savedState = localStorage.getItem('workoutTimerState');
    if (savedState && this.isEditMode) {
      try {
        const state = JSON.parse(savedState);
        if (state.sessionId) {
          // Navigate back to the workout view
          this.router.navigate(['/session-workout-view', state.sessionId]);
          return;
        }
      } catch (error) {
        console.error('Error parsing saved state:', error);
      }
    }
    
    // Default navigation
    this.router.navigate(['/home']);
  }

  async loadWorkoutForEdit(workoutId: string) {
    const loading = await this.loadingController.create({
      message: 'Loading workout...'
    });
    await loading.present();

    try {
      const workouts = await this.firebaseService.getWorkouts();
      const workout = workouts.find(w => w.id === workoutId);
      
      if (workout) {
        this.currentWorkout = { ...workout };
        this.isEditMode = true;
        console.log('Loaded workout for editing:', this.currentWorkout);
      } else {
        const alert = await this.alertController.create({
          header: 'Error',
          message: 'Workout not found.',
          buttons: ['OK']
        });
        await alert.present();
        this.navigateBack();
      }
    } catch (error) {
      console.error('Error loading workout:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load workout.',
        buttons: ['OK']
      });
      await alert.present();
      this.navigateBack();
    } finally {
      await loading.dismiss();
    }
  }

  // Factory methods for empty objects
  createEmptyWorkout(): Workout {
    return {
      name: '',
      description: '',
      sections: [],
      totalDuration: 60, // Default to 1 hour (60 minutes)
      equipment: [],
      tags: []
    };
  }

  createEmptySection(): WorkoutSection {
    return {
      name: '',
      exercises: [],
      duration: undefined,
      notes: ''
    };
  }

  createEmptyExercise(): Exercise {
    return {
      name: '',
      sets: 1,
      reps: '',
      percent: '',
      rir: undefined,
      notes: '',
      restTime: '',
      tempo: ''
    };
  }

  // Section Management
  openSectionModal() {
    this.currentSection = this.createEmptySection();
    this.editingSectionIndex = -1;
    this.showSectionModal = true;
  }

  editSection(sectionIndex: number) {
    this.currentSection = { ...this.currentWorkout.sections[sectionIndex] };
    this.editingSectionIndex = sectionIndex;
    this.showSectionModal = true;
  }

  closeSectionModal() {
    this.showSectionModal = false;
    this.currentSection = this.createEmptySection();
    this.editingSectionIndex = -1;
  }

  saveSection() {
    if (!this.currentSection.name) return;

    if (this.editingSectionIndex >= 0) {
      // Update existing section
      this.currentWorkout.sections[this.editingSectionIndex] = { ...this.currentSection };
    } else {
      // Add new section
      this.currentWorkout.sections.push({ ...this.currentSection });
    }

    this.closeSectionModal();
  }

  removeSection(sectionIndex: number) {
    this.currentWorkout.sections.splice(sectionIndex, 1);
  }

  // Exercise Management
  addExerciseToSection(sectionIndex: number) {
    this.currentSectionIndex = sectionIndex;
    this.currentExercise = this.createEmptyExercise();
    this.editingExerciseIndex = -1;
    this.showExerciseModal = true;
  }

  editExercise(sectionIndex: number, exerciseIndex: number) {
    this.currentSectionIndex = sectionIndex;
    this.currentExercise = { ...this.currentWorkout.sections[sectionIndex].exercises[exerciseIndex] };
    this.editingExerciseIndex = exerciseIndex;
    this.showExerciseModal = true;
  }

  closeExerciseModal() {
    this.showExerciseModal = false;
    this.currentExercise = this.createEmptyExercise();
    this.editingExerciseIndex = -1;
    this.currentSectionIndex = -1;
  }

  saveExercise() {
    if (!this.currentExercise.name || !this.currentExercise.sets || !this.currentExercise.reps) {
      return;
    }

    if (this.editingExerciseIndex >= 0) {
      // Update existing exercise
      this.currentWorkout.sections[this.currentSectionIndex].exercises[this.editingExerciseIndex] = { ...this.currentExercise };
    } else {
      // Add new exercise
      this.currentWorkout.sections[this.currentSectionIndex].exercises.push({ ...this.currentExercise });
    }

    this.closeExerciseModal();
  }

  removeExercise(sectionIndex: number, exerciseIndex: number) {
    this.currentWorkout.sections[sectionIndex].exercises.splice(exerciseIndex, 1);
  }

  // Validation
  canSaveWorkout(): boolean {
    return !!(this.currentWorkout.name && this.currentWorkout.sections.length > 0);
  }

  // Save workout
  async saveWorkout() {
    console.log('🔄 saveWorkout() called');
    console.log('📋 Current workout data:', JSON.stringify(this.currentWorkout, null, 2));
    
    if (!this.canSaveWorkout()) {
      console.log('❌ canSaveWorkout() returned false');
      console.log('📊 Validation details:', {
        hasName: !!this.currentWorkout.name,
        nameValue: this.currentWorkout.name,
        hasSections: this.currentWorkout.sections.length > 0,
        sectionsCount: this.currentWorkout.sections.length,
        sectionsWithExercises: this.currentWorkout.sections.filter(s => s.exercises.length > 0).length
      });
      
      const alert = await this.alertController.create({
        header: 'Incomplete Workout',
        message: 'Please provide a workout name and add at least one section.',
        buttons: ['OK']
      });
      await alert.present();
      return;
    }

    console.log('✅ Validation passed, proceeding with save');

    const loading = await this.loadingController.create({
      message: 'Saving workout...'
    });
    await loading.present();

    try {
      console.log('🧹 Cleaning workout data...');
      
      // Clean up the workout data to prevent undefined errors
      const cleanWorkout: any = {
        name: this.currentWorkout.name || '',
        description: this.currentWorkout.description || '',
        sections: this.currentWorkout.sections.map(section => {
          console.log(`📝 Processing section: ${section.name} with ${section.exercises.length} exercises`);
          const cleanSection: any = {
            name: section.name || '',
            exercises: section.exercises.map(exercise => {
              console.log(`💪 Processing exercise: ${exercise.name} - Sets: ${exercise.sets}, Reps: ${exercise.reps}, Percent: ${exercise.percent}`);
              const cleanExercise: any = {
                name: exercise.name || '',
                sets: exercise.sets || 1,
                reps: exercise.reps || ''
              };
              
              // Only add fields if they have actual values (not empty strings or undefined)
              if (exercise.percent && exercise.percent.trim()) {
                cleanExercise.percent = exercise.percent.trim();
              }
              if (exercise.rir !== undefined && exercise.rir !== null) {
                cleanExercise.rir = exercise.rir;
              }
              if (exercise.notes && exercise.notes.trim()) {
                cleanExercise.notes = exercise.notes.trim();
              }
              if (exercise.restTime && exercise.restTime.trim()) {
                cleanExercise.restTime = exercise.restTime.trim();
              }
              if (exercise.tempo && exercise.tempo.trim()) {
                cleanExercise.tempo = exercise.tempo.trim();
              }
              
              console.log('🔧 Cleaned exercise:', cleanExercise);
              return cleanExercise;
            })
          };
          
          // Only add section fields if they have actual values
          if (section.duration !== undefined && section.duration !== null) {
            cleanSection.duration = section.duration;
          }
          if (section.notes && section.notes.trim()) {
            cleanSection.notes = section.notes.trim();
          }
          
          return cleanSection;
        }),
        totalDuration: this.currentWorkout.totalDuration || 60,
        equipment: this.currentWorkout.equipment || [],
        tags: this.currentWorkout.tags || []
      };

      console.log('✨ Final cleaned workout data:', JSON.stringify(cleanWorkout, null, 2));

      if (this.isEditMode && this.currentWorkout.id) {
        console.log('📝 Updating existing workout with ID:', this.currentWorkout.id);
        await this.firebaseService.updateWorkout(this.currentWorkout.id, cleanWorkout);
        console.log('✅ Workout updated successfully');
      } else {
        console.log('💾 Saving new workout to Firebase...');
        const workoutId = await this.firebaseService.saveWorkout(cleanWorkout);
        console.log('✅ New workout saved with ID:', workoutId);
      }

      await loading.dismiss();

      const alert = await this.alertController.create({
        header: 'Success!',
        message: `Workout ${this.isEditMode ? 'updated' : 'created'} successfully!`,
        buttons: ['OK']
      });
      await alert.present();

      // Reset change tracking since we've successfully saved
      this.originalWorkout = JSON.parse(JSON.stringify(this.currentWorkout));

      this.navigateBack();

    } catch (error) {
      console.error('💥 Error saving workout:', error);
      const errorObj = error as any;
      console.error('📄 Error details:', {
        message: errorObj?.message || 'Unknown error',
        code: errorObj?.code || 'No error code',
        stack: errorObj?.stack || 'No stack trace',
        name: errorObj?.name || 'No error name'
      });
      await loading.dismiss();

      const alert = await this.alertController.create({
        header: 'Error',
        message: `Failed to save workout. Error: ${errorObj?.message || error}. Please check console for details.`,
        buttons: ['OK']
      });
      await alert.present();
    }
  }
}
