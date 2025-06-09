import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonTitle, IonToolbar, IonIcon, LoadingController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addCircleOutline, createOutline, peopleOutline, calendarOutline, settingsOutline, close, trashOutline, save, add, trash, today, arrowBack } from 'ionicons/icons';
import { FirebaseService, Session } from '../services/firebase.service';

interface NewSession {
  name: string;
  participants: string[];
  startDate: string;
  time: string;
  daysOfWeek: number[];
  sessionCount: number;
}

interface WeekDay {
  label: string;
  date: Date;
  dayIndex: number;
}

@Component({
  selector: 'app-schedule',
  templateUrl: './schedule.page.html',
  styleUrls: ['./schedule.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, IonIcon, CommonModule, FormsModule]
})
export class SchedulePage implements OnInit {
  sidebarOpen = false;
  formPageActive = false;
  isEditMode = false;
  editingSession: Session | null = null;
  viewMode = 'weekly';
  currentDate = new Date();
  monthYearText = '';
  sessionData: Session[] = [];
  weekDays: WeekDay[] = [];
  timeSlots: number[] = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  
  // Student suggestions
  allStudentNames: string[] = [];
  filteredSuggestions: string[][] = []; // Array of suggestions for each participant input
  
  newSession: NewSession = {
    name: '',
    participants: [''],
    startDate: '',
    time: '',
    daysOfWeek: [],
    sessionCount: 8
  };

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ addCircleOutline, createOutline, peopleOutline, calendarOutline, settingsOutline, today, close, trashOutline, add, trash, save, arrowBack });
  }

  async ngOnInit() {
    this.generateCalendar(this.currentDate);
    await this.loadSessions();
    await this.loadStudentNames();
  }

  async loadSessions() {
    const loading = await this.loadingController.create({
      message: 'Loading sessions...'
    });
    await loading.present();

    try {
      this.sessionData = await this.firebaseService.getSessions();
      console.log('Loaded sessions from Firebase:', this.sessionData);
    } catch (error) {
      console.error('Error loading sessions:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load sessions. Please check your internet connection.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  async loadStudentNames() {
    try {
      // Get all unique student names from waivers and existing sessions
      const [waivers, sessions] = await Promise.all([
        this.firebaseService.getAllWaivers(),
        this.firebaseService.getSessions()
      ]);

      const studentNamesSet = new Set<string>();
      
      // Add names from waivers
      waivers.forEach(waiver => {
        if (waiver.studentName && waiver.studentName.trim()) {
          studentNamesSet.add(waiver.studentName.trim());
        }
      });
      
      // Add names from session participants
      sessions.forEach(session => {
        session.participants.forEach(participant => {
          if (participant && participant.trim()) {
            studentNamesSet.add(participant.trim());
          }
        });
      });

      // Convert to sorted array
      this.allStudentNames = Array.from(studentNamesSet).sort((a, b) => a.localeCompare(b));
      console.log('Loaded student names for autofill:', this.allStudentNames);
      
      // Initialize suggestions array
      this.updateFilteredSuggestions();
    } catch (error) {
      console.error('Error loading student names:', error);
    }
  }

  updateFilteredSuggestions() {
    this.filteredSuggestions = this.newSession.participants.map(() => []);
  }

  onParticipantInput(index: number, value: string) {
    this.newSession.participants[index] = value;
    
    if (value.trim()) {
      // Filter suggestions based on input
      this.filteredSuggestions[index] = this.allStudentNames.filter(name =>
        name.toLowerCase().includes(value.toLowerCase()) &&
        !this.newSession.participants.includes(name) // Don't suggest already selected names
      ).slice(0, 5); // Limit to 5 suggestions
    } else {
      // Show all available names when input is empty
      this.filteredSuggestions[index] = this.allStudentNames.filter(name =>
        !this.newSession.participants.includes(name)
      ).slice(0, 8); // Show more when no filter
    }
  }

  selectSuggestion(participantIndex: number, suggestion: string) {
    this.newSession.participants[participantIndex] = suggestion;
    this.filteredSuggestions[participantIndex] = []; // Clear suggestions after selection
  }

  clearSuggestions(index: number) {
    // Delay clearing to allow for click on suggestion
    setTimeout(() => {
      this.filteredSuggestions[index] = [];
    }, 150);
  }

  showAllStudentSuggestions(index: number) {
    // Show available students when clicking on empty input
    if (!this.newSession.participants[index].trim()) {
      this.filteredSuggestions[index] = this.allStudentNames.filter(name =>
        !this.newSession.participants.includes(name)
      ).slice(0, 8);
    }
  }

  toggleSidebar(event: Event) {
    event.stopPropagation();
    this.sidebarOpen = !this.sidebarOpen;
  }

  showFormPage() {
    console.log('Opening form page for new session');
    this.isEditMode = false;
    this.editingSession = null;
    this.resetNewSession();
    this.formPageActive = true;
    this.sidebarOpen = false;
  }

  showEditPage(session: Session) {
    console.log('Opening form page for editing session:', session);
    this.isEditMode = true;
    this.editingSession = session;
    
    // Populate form with existing session data
    const sessionDate = new Date(session.date);
    this.newSession = {
      name: session.name,
      participants: [...session.participants],
      startDate: sessionDate.toISOString().split('T')[0],
      time: sessionDate.toTimeString().slice(0, 5),
      daysOfWeek: [sessionDate.getDay()],
      sessionCount: 1
    };
    
    this.formPageActive = true;
    this.sidebarOpen = false;
  }

  hideFormPage() {
    this.formPageActive = false;
    this.isEditMode = false;
    this.editingSession = null;
    this.resetNewSession();
  }

  prevPeriod() {
    if (this.viewMode === 'monthly') {
      this.currentDate.setMonth(this.currentDate.getMonth() - 1);
    } else {
      this.currentDate.setDate(this.currentDate.getDate() - 7);
    }
    this.generateCalendar(this.currentDate);
  }

  nextPeriod() {
    if (this.viewMode === 'monthly') {
      this.currentDate.setMonth(this.currentDate.getMonth() + 1);
    } else {
      this.currentDate.setDate(this.currentDate.getDate() + 7);
    }
    this.generateCalendar(this.currentDate);
  }

  onViewModeChange() {
    this.generateCalendar(this.currentDate);
  }

  addParticipant() {
    this.newSession.participants.push('');
    this.filteredSuggestions.push([]); // Add empty suggestions for new participant
  }

  removeParticipant(index: number) {
    if (this.newSession.participants.length > 1) {
      this.newSession.participants.splice(index, 1);
      this.filteredSuggestions.splice(index, 1); // Remove suggestions for removed participant
    }
  }

  addExistingStudent(studentName: string) {
    // Find first empty participant slot or add new one
    const emptyIndex = this.newSession.participants.findIndex(p => !p.trim());
    if (emptyIndex >= 0) {
      this.newSession.participants[emptyIndex] = studentName;
    } else {
      this.newSession.participants.push(studentName);
      this.filteredSuggestions.push([]);
    }
    // Clear suggestions after adding
    this.updateFilteredSuggestions();
  }

  toggleDay(dayIndex: number) {
    const index = this.newSession.daysOfWeek.indexOf(dayIndex);
    if (index > -1) {
      this.newSession.daysOfWeek.splice(index, 1);
    } else {
      this.newSession.daysOfWeek.push(dayIndex);
    }
  }

  trackParticipant(index: number): number {
    return index;
  }

  formatHour(hour: number): string {
    const suffix = hour >= 12 ? 'pm' : 'am';
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}${suffix}`;
  }

  generateCalendar(date: Date) {
    this.monthYearText = date.toLocaleString('default', { month: 'long', year: 'numeric' });
    
    if (this.viewMode === 'weekly') {
      this.generateWeeklyView(date);
    }
  }

  generateWeeklyView(date: Date) {
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay());
    
    this.weekDays = [];
    const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(startOfWeek);
      dayDate.setDate(dayDate.getDate() + i);
      
      this.weekDays.push({
        label: days[i],
        date: new Date(dayDate),
        dayIndex: i
      });
    }
  }

  formatDate(date: Date): string {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    return `${day}/${month}`;
  }

  getSessionForSlot(date: Date, hour: number): Session | null {
    const targetDate = new Date(date);
    targetDate.setHours(hour, 0, 0, 0);
    
    const session = this.sessionData.find(s => {
      const sessionDate = new Date(s.date);
      return sessionDate.getFullYear() === targetDate.getFullYear() &&
             sessionDate.getMonth() === targetDate.getMonth() &&
             sessionDate.getDate() === targetDate.getDate() &&
             sessionDate.getHours() === targetDate.getHours();
    });
    
    return session || null;
  }

  isLastSessionInSeries(session: Session): boolean {
    if (!session) return false;
    
    // Find all sessions with the same name and participants
    const seriesSessions = this.sessionData.filter(s => 
      s.name === session.name &&
      s.participants.length === session.participants.length &&
      s.participants.every((participant, index) => participant === session.participants[index])
    );
    
    // Sort sessions by date to find the last one
    const sortedSessions = seriesSessions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    
    // Check if this session is the last one in the sorted array
    const lastSession = sortedSessions[sortedSessions.length - 1];
    return session.id === lastSession.id;
  }

  onTimeSlotClick(date: Date, hour: number) {
    const session = this.getSessionForSlot(date, hour);
    if (session) {
      // Edit existing session
      this.showEditPage(session);
    } else {
      // Create new session at this time slot
      const clickedDate = new Date(date);
      clickedDate.setHours(hour, 0, 0, 0);
      
      this.newSession = {
        name: '',
        participants: [''],
        startDate: clickedDate.toISOString().split('T')[0],
        time: clickedDate.toTimeString().slice(0, 5),
        daysOfWeek: [clickedDate.getDay()],
        sessionCount: 8
      };
      
      this.showFormPage();
    }
  }

  testButton() {
    console.log('Test button clicked!');
    alert('Button click works!');
  }

  async deleteSession() {
    if (!this.editingSession?.id) return;

    // Find future sessions with the same name and participants (excluding the current one)
    const futureSessions = this.sessionData.filter(session => 
      session.id !== this.editingSession!.id && // Exclude the current session
      session.name === this.editingSession!.name &&
      session.participants.length === this.editingSession!.participants.length &&
      session.participants.every((participant, index) => participant === this.editingSession!.participants[index]) &&
      new Date(session.date) > new Date(this.editingSession!.date) // Only future sessions
    );

    const hasFutureSessions = futureSessions.length > 0;

    const alert = await this.alertController.create({
      header: 'Delete Session',
      message: hasFutureSessions 
        ? `Found ${futureSessions.length} future session${futureSessions.length > 1 ? 's' : ''} in this series. What would you like to delete?`
        : 'Are you sure you want to delete this session?',
      buttons: [
        {
          text: 'Cancel',
          role: 'cancel'
        },
        ...(hasFutureSessions ? [
          {
            text: 'Just This Session',
            handler: async () => {
              await this.performDelete([this.editingSession!.id!], 'Session deleted successfully!');
            }
          },
          {
            text: `All Future Sessions (${futureSessions.length + 1})`,
            role: 'destructive',
            handler: async () => {
              // Include current session + all future sessions
              const allSessionIds = [this.editingSession!.id!, ...futureSessions.map(s => s.id!)].filter(id => id);
              const totalCount = allSessionIds.length;
              await this.performDelete(allSessionIds, `Successfully deleted ${totalCount} session${totalCount > 1 ? 's' : ''}!`);
            }
          }
        ] : [
          {
            text: 'Delete',
            role: 'destructive',
            handler: async () => {
              await this.performDelete([this.editingSession!.id!], 'Session deleted successfully!');
            }
          }
        ])
      ]
    });
    await alert.present();
  }

  private async performDelete(sessionIds: string[], successMessage: string) {
    const loading = await this.loadingController.create({
      message: sessionIds.length > 1 ? 'Deleting sessions...' : 'Deleting session...'
    });
    await loading.present();

    try {
      // Delete all sessions
      for (const sessionId of sessionIds) {
        await this.firebaseService.deleteSession(sessionId);
      }
      
      await this.loadSessions();
      this.hideFormPage();
      
      const successAlert = await this.alertController.create({
        header: 'Success',
        message: successMessage,
        buttons: ['OK']
      });
      await successAlert.present();
    } catch (error) {
      console.error('Error deleting session(s):', error);
      const errorAlert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to delete session(s). Please try again.',
        buttons: ['OK']
      });
      await errorAlert.present();
    } finally {
      await loading.dismiss();
    }
  }

  async saveSession() {
    console.log('Starting saveSession...');
    console.log('Form data:', this.newSession);
    console.log('Edit mode:', this.isEditMode);
    
    // Basic validation
    if (!this.newSession.name || !this.newSession.startDate || !this.newSession.time) {
      console.log('Validation failed - missing required fields');
      const alert = await this.alertController.create({
        header: 'Validation Error',
        message: 'Please fill in all required fields',
        buttons: ['OK']
      });
      await alert.present();
      return;
    }

    if (!this.isEditMode && (!this.newSession.sessionCount || this.newSession.sessionCount < 1)) {
      const alert = await this.alertController.create({
        header: 'Validation Error',
        message: 'Please enter a valid number of sessions',
        buttons: ['OK']
      });
      await alert.present();
      return;
    }
    
    if (this.newSession.daysOfWeek.length === 0) {
      console.log('Validation failed - no days selected');
      const alert = await this.alertController.create({
        header: 'Validation Error',
        message: 'Please select at least one day of the week',
        buttons: ['OK']
      });
      await alert.present();
      return;
    }

    const loading = await this.loadingController.create({
      message: this.isEditMode ? 'Updating session...' : 'Saving sessions...'
    });
    await loading.present();

    try {
      const sessionName = this.newSession.name;
      const [hour, minute] = this.newSession.time.split(':').map(Number);
      const participants = this.newSession.participants.filter(p => p.trim() !== '');

      if (this.isEditMode && this.editingSession) {
        // Update existing session
        const sessionDate = new Date(this.newSession.startDate);
        sessionDate.setHours(hour, minute, 0, 0);
        
        await this.firebaseService.updateSession(this.editingSession.id!, {
          name: sessionName,
          participants: participants,
          date: sessionDate
        });
        
        console.log('Updated session');
        
        // Reload sessions from Firebase
        await this.loadSessions();
        
        this.hideFormPage();
        this.generateCalendar(this.currentDate);
        
        const alert = await this.alertController.create({
          header: 'Success',
          message: 'Session updated successfully!',
          buttons: ['OK']
        });
        await alert.present();
      } else {
        // Create new sessions
        const startDate = new Date(this.newSession.startDate);
        const days = this.newSession.daysOfWeek.map(day => parseInt(day.toString()));
        const totalSessions = this.newSession.sessionCount;

        console.log('Creating', totalSessions, 'sessions for:', sessionName, 'on days:', days, 'at', hour + ':' + minute);

        let sessionsCreated = 0;
        const sessionsToSave: Omit<Session, 'id'>[] = [];
        let currentDate = new Date(startDate);
        
        while (sessionsCreated < totalSessions) {
          const dayOfWeek = currentDate.getDay();
          
          // Check if this day is in our selected days
          if (days.includes(dayOfWeek) && currentDate >= startDate) {
            const sessionDate = new Date(currentDate);
            sessionDate.setHours(hour, minute, 0, 0);
            
            sessionsToSave.push({ 
              date: sessionDate, 
              name: sessionName,
              participants: [...participants]
            });
            sessionsCreated++;
          }
          
          // Move to next day
          currentDate.setDate(currentDate.getDate() + 1);
          
          // Safety break to prevent infinite loops
          if (currentDate > new Date(startDate.getTime() + (365 * 24 * 60 * 60 * 1000))) {
            break;
          }
        }

        // Save all sessions to Firebase
        for (const session of sessionsToSave) {
          await this.firebaseService.saveSession(session);
        }
        
        console.log(`Created ${sessionsCreated} sessions`);
        
        // Reload sessions from Firebase
        await this.loadSessions();
        
        this.hideFormPage();
        this.generateCalendar(this.currentDate);
        
        const alert = await this.alertController.create({
          header: 'Success',
          message: `Successfully created ${sessionsCreated} sessions!`,
          buttons: ['OK']
        });
        await alert.present();
      }
      
      console.log('saveSession completed');
    } catch (error) {
      console.error('Error saving sessions:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to save sessions. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  resetNewSession() {
    this.newSession = {
      name: '',
      participants: [''],
      startDate: '',
      time: '',
      daysOfWeek: [],
      sessionCount: 8
    };
    this.updateFilteredSuggestions(); // Reset suggestions array
  }

  goToCurrentWeek() {
    this.currentDate = new Date();
    this.generateCalendar(this.currentDate);
  }

  calculateWeeks(): number {
    if (this.newSession.daysOfWeek.length === 0) return 0;
    return Math.ceil(this.newSession.sessionCount / this.newSession.daysOfWeek.length);
  }

  isToday(date: Date): boolean {
    const today = new Date();
    return date.getDate() === today.getDate() &&
           date.getMonth() === today.getMonth() &&
           date.getFullYear() === today.getFullYear();
  }

  isPastDate(date: Date): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate < today;
  }

  isFutureDate(date: Date): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const compareDate = new Date(date);
    compareDate.setHours(0, 0, 0, 0);
    return compareDate > today;
  }

  goToHome() {
    this.router.navigate(['/home']);
  }

  goToStudents() {
    this.router.navigate(['/students']);
  }
}
