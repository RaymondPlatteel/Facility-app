import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, LoadingController } from '@ionic/angular';
import { Router } from '@angular/router';
import { FirebaseService, Session, Workout } from '../services/firebase.service';

interface GroupedSession {
  name: string;
  sessions: Session[];
  isRecurring: boolean;
  nextDate?: Date;
  count: number;
  linkedWorkout?: Workout | null;
}

@Component({
  selector: 'app-sessions',
  templateUrl: './sessions.page.html',
  styleUrls: ['./sessions.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule]
})
export class SessionsPage implements OnInit {
  todaysGroups: GroupedSession[] = [];
  futureGroups: GroupedSession[] = [];
  pastGroups: GroupedSession[] = [];
  workouts: { [key: string]: Workout } = {}; // Workout cache by ID
  selectedSegment: string = 'today';

  constructor(
    private firebaseService: FirebaseService,
    private router: Router,
    private alertController: AlertController,
    private loadingController: LoadingController
  ) { }

  async ngOnInit() {
    await this.loadAllSessions();
  }

  async ionViewWillEnter() {
    await this.loadAllSessions();
  }

  async loadAllSessions() {
    const loading = await this.loadingController.create({
      message: 'Loading sessions...'
    });
    await loading.present();

    try {
      // Get all sessions
      const allSessions = await this.firebaseService.getSessions();
      console.log('Total sessions loaded from Firebase:', allSessions.length);
      console.log('Sessions data:', allSessions);
      
      // Debug: Check each session's date
      allSessions.forEach((session, index) => {
        console.log(`Session ${index}: ${session.name}, Date: ${session.date}, Type: ${typeof session.date}`);
      });
      
      // Load workouts first - regardless of session count
      await this.loadLinkedWorkouts();
      
      // Get today's date boundaries
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      console.log('Today boundary:', today);

      // Categorize sessions by date
      const todaysSessions: Session[] = [];
      const futureSessions: Session[] = [];
      const pastSessions: Session[] = [];

      allSessions.forEach(session => {
        try {
          // Ensure date is properly parsed
          let sessionDate: Date;
          if (session.date instanceof Date) {
            sessionDate = new Date(session.date);
          } else {
            sessionDate = new Date(session.date);
          }
          
          // Check if date is valid
          if (isNaN(sessionDate.getTime())) {
            console.error('Invalid date for session:', session);
            return;
          }
          
          sessionDate.setHours(0, 0, 0, 0);
          console.log(`Processing session "${session.name}": ${sessionDate} vs ${today}`);
          
          if (sessionDate.getTime() === today.getTime()) {
            console.log(`  -> TODAY: ${session.name}`);
            todaysSessions.push(session);
          } else if (sessionDate.getTime() > today.getTime()) {
            console.log(`  -> FUTURE: ${session.name}`);
            futureSessions.push(session);
          } else {
            console.log(`  -> PAST: ${session.name}`);
            pastSessions.push(session);
          }
        } catch (error) {
          console.error('Error processing session date:', session, error);
        }
      });

      console.log('Raw session counts:', {
        today: todaysSessions.length,
        future: futureSessions.length,
        past: pastSessions.length
      });

      // Group sessions by name
      this.todaysGroups = this.groupSessions(todaysSessions);
      this.futureGroups = this.groupSessions(futureSessions);
      this.pastGroups = this.groupSessions(pastSessions);

      console.log('Grouped sessions:', {
        today: this.todaysGroups,
        future: this.futureGroups,
        past: this.pastGroups
      });

    } catch (error) {
      console.error('Error loading sessions:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load sessions. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  groupSessions(sessions: Session[]): GroupedSession[] {
    const groups: { [name: string]: Session[] } = {};
    
    // Group sessions by name
    sessions.forEach(session => {
      if (!groups[session.name]) {
        groups[session.name] = [];
      }
      groups[session.name].push(session);
    });

    // Convert to GroupedSession objects
    const groupedSessions: GroupedSession[] = Object.keys(groups).map(name => {
      const sessionGroup = groups[name];
      const sortedSessions = sessionGroup.sort((a, b) => {
        const dateA = new Date(a.date);
        const dateB = new Date(b.date);
        return dateA.getTime() - dateB.getTime();
      });

      // Get linked workout (use first session's workout since they should be the same for recurring sessions)
      const firstSession = sortedSessions[0];
      const linkedWorkout = this.getLinkedWorkout(firstSession);

      return {
        name,
        sessions: sortedSessions,
        isRecurring: sessionGroup.length > 1,
        nextDate: sortedSessions[0]?.date,
        count: sessionGroup.length,
        linkedWorkout
      };
    });

    // Sort groups by next date
    return groupedSessions.sort((a, b) => {
      const dateA = new Date(a.nextDate || 0);
      const dateB = new Date(b.nextDate || 0);
      return dateA.getTime() - dateB.getTime();
    });
  }

  async loadLinkedWorkouts() {
    try {
      const allWorkouts = await this.firebaseService.getWorkouts();
      // Create a lookup map for quick access
      this.workouts = {};
      allWorkouts.forEach(workout => {
        if (workout.id) {
          this.workouts[workout.id] = workout;
        }
      });
    } catch (error) {
      console.error('Error loading workouts:', error);
    }
  }

  getLinkedWorkout(session: Session): Workout | null {
    if (session.workoutId && this.workouts[session.workoutId]) {
      return this.workouts[session.workoutId];
    }
    return null;
  }

  async linkWorkout(group: GroupedSession) {
    const firstSession = group.sessions[0];
    if (!firstSession?.id) return;

    // For recurring sessions, we'll link all future sessions
    const futureSessions = group.sessions.filter(session => {
      const sessionDate = new Date(session.date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return sessionDate.getTime() >= today.getTime();
    });

    this.router.navigate(['/workouts-list'], { 
      queryParams: { 
        sessionId: firstSession.id, 
        mode: 'link',
        sessionName: group.name,
        multiSessionCount: group.isRecurring ? futureSessions.length : 0
      } 
    });
  }

  async unlinkWorkout(group: GroupedSession) {
    const linkedWorkout = group.linkedWorkout;
    const workoutName = linkedWorkout ? linkedWorkout.name : 'this workout';
    
    const message = group.isRecurring 
      ? `Are you sure you want to unlink "${workoutName}" from all "${group.name}" sessions?`
      : `Are you sure you want to unlink "${workoutName}" from "${group.name}"?`;
    
    const alert = await this.alertController.create({
      header: 'Unlink Workout',
      message,
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        {
          text: 'Unlink',
          handler: async () => {
            await this.performUnlinkWorkout(group);
          }
        }
      ]
    });
    await alert.present();
  }

  async performUnlinkWorkout(group: GroupedSession) {
    const loading = await this.loadingController.create({
      message: 'Unlinking workout...'
    });
    await loading.present();

    try {
      // Unlink all sessions in the group that have workouts linked
      for (const session of group.sessions) {
        if (session.workoutId && session.id) {
          await this.firebaseService.unlinkWorkoutFromSession(session.id);
        }
      }
      
      await this.loadAllSessions(); // Refresh the list

      const alert = await this.alertController.create({
        header: 'Success',
        message: 'Workout unlinked successfully!',
        buttons: ['OK']
      });
      await alert.present();

    } catch (error) {
      console.error('Error unlinking workout:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to unlink workout. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  viewSessionWorkout(group: GroupedSession) {
    // Only allow viewing if there's a linked workout
    if (!group.linkedWorkout) {
      return;
    }

    // Navigate to the first session in the group (they all have the same workout)
    const firstSession = group.sessions[0];
    if (firstSession?.id) {
      this.router.navigate(['/session-workout-view', firstSession.id]);
    }
  }

  goBack() {
    this.router.navigate(['/home']);
  }

  formatTime(date: Date | string): string {
    try {
      const dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        return 'Invalid time';
      }
      return dateObj.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } catch (error) {
      console.error('Error formatting time:', error);
      return 'Invalid time';
    }
  }

  formatDate(date: Date | string): string {
    try {
      const sessionDate = new Date(date);
      if (isNaN(sessionDate.getTime())) {
        return 'Invalid date';
      }
      
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const sessionDateOnly = new Date(sessionDate);
      sessionDateOnly.setHours(0, 0, 0, 0);
      
      if (sessionDateOnly.getTime() === today.getTime()) {
        return 'Today';
      }
      
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (sessionDateOnly.getTime() === tomorrow.getTime()) {
        return 'Tomorrow';
      }
      
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (sessionDateOnly.getTime() === yesterday.getTime()) {
        return 'Yesterday';
      }
      
      return sessionDate.toLocaleDateString('en-US', { 
        weekday: 'short',
        month: 'short', 
        day: 'numeric',
        year: sessionDate.getFullYear() !== today.getFullYear() ? 'numeric' : undefined
      });
    } catch (error) {
      console.error('Error formatting date:', error);
      return 'Invalid date';
    }
  }

  onSegmentChange(event: any) {
    console.log('Segment changed to:', event.detail.value);
    this.selectedSegment = event.detail.value;
  }

  getCurrentGroups(): GroupedSession[] {
    console.log(`Getting groups for segment: ${this.selectedSegment}`);
    console.log('Available groups:', {
      today: this.todaysGroups.length,
      future: this.futureGroups.length,
      past: this.pastGroups.length
    });
    
    switch (this.selectedSegment) {
      case 'today':
        console.log('Returning today groups:', this.todaysGroups);
        return this.todaysGroups;
      case 'future':
        console.log('Returning future groups:', this.futureGroups);
        return this.futureGroups;
      case 'past':
        console.log('Returning past groups:', this.pastGroups);
        return this.pastGroups;
      default:
        console.log('Returning empty array for unknown segment');
        return [];
    }
  }

  getEmptyMessage(): string {
    switch (this.selectedSegment) {
      case 'today':
        return 'No sessions scheduled for today';
      case 'future':
        return 'No future sessions scheduled';
      case 'past':
        return 'No past sessions found';
      default:
        return 'No sessions found';
    }
  }

  getSessionCount(tabName: string): number {
    switch (tabName) {
      case 'today':
        return this.todaysGroups.reduce((sum, group) => sum + group.count, 0);
      case 'future':
        return this.futureGroups.reduce((sum, group) => sum + group.count, 0);
      case 'past':
        return this.pastGroups.reduce((sum, group) => sum + group.count, 0);
      default:
        return 0;
    }
  }
}
