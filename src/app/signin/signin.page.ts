import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { 
  IonContent, 
  IonHeader, 
  IonTitle, 
  IonToolbar, 
  IonIcon,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonList,
  IonItem,
  IonLabel,
  IonButton,
  IonButtons,
  IonBadge,
  LoadingController,
  AlertController 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, person, checkmarkCircle, time } from 'ionicons/icons';
import { FirebaseService, Session, AttendanceRecord } from '../services/firebase.service';

interface TodaySession {
  session: Session;
  participants: string[];
  checkedInStudents: string[];
}

@Component({
  selector: 'app-signin',
  templateUrl: './signin.page.html',
  styleUrls: ['./signin.page.scss'],
  standalone: true,
  imports: [
    IonContent, 
    IonHeader, 
    IonTitle, 
    IonToolbar, 
    IonIcon,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonList,
    IonItem,
    IonLabel,
    IonButton,
    IonButtons,
    IonBadge,
    CommonModule, 
    FormsModule
  ]
})
export class SigninPage implements OnInit {
  todaySessions: TodaySession[] = [];
  selectedSession: TodaySession | null = null;
  loading = false;

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ arrowBack, person, checkmarkCircle, time });
  }

  async ngOnInit() {
    await this.loadTodaySessions();
  }

  async loadTodaySessions() {
    const loading = await this.loadingController.create({
      message: 'Loading today\'s sessions...'
    });
    await loading.present();

    try {
      const allSessions = await this.firebaseService.getSessions();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const todayEnd = new Date(today);
      todayEnd.setHours(23, 59, 59, 999);

      // Filter sessions for today
      const todaysSessionData = allSessions.filter(session => {
        const sessionDate = new Date(session.date);
        return sessionDate >= today && sessionDate <= todayEnd;
      });

      // Load attendance for each session
      this.todaySessions = [];
      for (const session of todaysSessionData) {
        const attendance = await this.firebaseService.getSessionAttendance(session.id!);
        const checkedInStudents = attendance
          .filter(record => record.present)
          .map(record => record.studentName);

        this.todaySessions.push({
          session,
          participants: session.participants,
          checkedInStudents
        });
      }

      // Sort by session time
      this.todaySessions.sort((a, b) => 
        new Date(a.session.date).getTime() - new Date(b.session.date).getTime()
      );

    } catch (error) {
      console.error('Error loading today\'s sessions:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load today\'s sessions. Please try again.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  selectSession(todaySession: TodaySession) {
    this.selectedSession = todaySession;
  }

  goBack() {
    if (this.selectedSession) {
      this.selectedSession = null;
    } else {
      this.router.navigate(['/home']);
    }
  }

  async checkInStudent(studentName: string) {
    if (!this.selectedSession?.session.id) return;

    // Check if student is already checked in
    if (this.selectedSession.checkedInStudents.includes(studentName)) {
      const alert = await this.alertController.create({
        header: 'Already Checked In',
        message: `${studentName} is already checked in for this session.`,
        buttons: ['OK']
      });
      await alert.present();
      return;
    }

    this.loading = true;

    const loading = await this.loadingController.create({
      message: `Checking in ${studentName}...`
    });
    await loading.present();

    try {
      const attendanceRecord: AttendanceRecord = {
        sessionId: this.selectedSession.session.id,
        studentName: studentName,
        checkInTime: new Date().toISOString(),
        date: new Date().toISOString().split('T')[0],
        present: true
      };

      await this.firebaseService.saveAttendance(attendanceRecord);
      
      // Update local state
      this.selectedSession.checkedInStudents.push(studentName);

      const successAlert = await this.alertController.create({
        header: 'Success!',
        message: `${studentName} has been checked in successfully.`,
        buttons: ['OK']
      });
      await successAlert.present();

    } catch (error) {
      console.error('Error checking in student:', error);
      const errorAlert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to check in student. Please try again.',
        buttons: ['OK']
      });
      await errorAlert.present();
    } finally {
      this.loading = false;
      await loading.dismiss();
    }
  }

  isStudentCheckedIn(studentName: string): boolean {
    return this.selectedSession?.checkedInStudents.includes(studentName) || false;
  }

  formatSessionTime(date: Date): string {
    return new Date(date).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }

  getSessionStatus(todaySession: TodaySession): string {
    const total = todaySession.participants.length;
    const checkedIn = todaySession.checkedInStudents.length;
    return `${checkedIn}/${total} checked in`;
  }
} 