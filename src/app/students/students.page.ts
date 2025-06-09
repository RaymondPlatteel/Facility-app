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
  IonList,
  IonItem,
  IonLabel,
  IonButton,
  IonModal,
  IonButtons,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCardContent,
  IonBadge,
  LoadingController,
  AlertController 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, person, checkmarkCircle, closeCircle, document, calendarOutline, alertCircle } from 'ionicons/icons';
import { FirebaseService, WaiverData, Session, StudentStats } from '../services/firebase.service';

interface Student {
  name: string;
  hasWaiver: boolean;
  waivers: WaiverData[];
  sessions: string[]; // Session names they participate in
  stats?: StudentStats; // Attendance statistics including make-up sessions
}

@Component({
  selector: 'app-students',
  templateUrl: './students.page.html',
  styleUrls: ['./students.page.scss'],
  standalone: true,
  imports: [
    IonContent, 
    IonHeader, 
    IonTitle, 
    IonToolbar, 
    IonIcon,
    IonList,
    IonItem,
    IonLabel,
    IonButton,
    IonModal,
    IonButtons,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonBadge,
    CommonModule, 
    FormsModule
  ]
})
export class StudentsPage implements OnInit {
  students: Student[] = [];
  selectedStudent: Student | null = null;
  isModalOpen = false;
  loading = false;

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({arrowBack,person,closeCircle,calendarOutline,document,checkmarkCircle,alertCircle});
  }

  async ngOnInit() {
    await this.loadStudents();
  }

  async loadStudents() {
    const loading = await this.loadingController.create({
      message: 'Loading students...'
    });
    await loading.present();

    try {
      // Get all waivers
      const waivers = await this.firebaseService.getAllWaivers();
      
      // Get all sessions
      const sessions = await this.firebaseService.getSessions();
      
      // Create a map to collect all unique student names
      const studentMap = new Map<string, Student>();
      
      // Add students from waivers
      waivers.forEach(waiver => {
        const name = waiver.studentName.trim();
        if (!studentMap.has(name)) {
          studentMap.set(name, {
            name: name,
            hasWaiver: true,
            waivers: [waiver],
            sessions: []
          });
        } else {
          const student = studentMap.get(name)!;
          student.hasWaiver = true;
          student.waivers.push(waiver);
        }
      });
      
      // Add students from session participants
      sessions.forEach(session => {
        session.participants.forEach(participantName => {
          const name = participantName.trim();
          if (name) { // Only add non-empty names
            if (!studentMap.has(name)) {
              studentMap.set(name, {
                name: name,
                hasWaiver: false,
                waivers: [],
                sessions: [session.name]
              });
            } else {
              const student = studentMap.get(name)!;
              if (!student.sessions.includes(session.name)) {
                student.sessions.push(session.name);
              }
            }
          }
        });
      });
      
      // Convert map to array
      this.students = Array.from(studentMap.values());
      
      // Load attendance statistics for each student
      for (const student of this.students) {
        try {
          student.stats = await this.firebaseService.getStudentStats(student.name);
        } catch (error) {
          console.error(`Error loading stats for ${student.name}:`, error);
          // Set default stats if loading fails
          student.stats = {
            studentName: student.name,
            totalSessions: 0,
            attendedSessions: 0,
            missedSessions: 0,
            makeUpSessionsRemaining: 0
          };
        }
      }
      
      // Sort alphabetically
      this.students.sort((a, b) => a.name.localeCompare(b.name));
      
      console.log('Loaded students with stats:', this.students);
    } catch (error) {
      console.error('Error loading students:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to load students. Please check your internet connection.',
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }

  openStudentDetails(student: Student) {
    this.selectedStudent = student;
    this.isModalOpen = true;
  }

  closeModal() {
    this.isModalOpen = false;
    this.selectedStudent = null;
  }

  goBack() {
    this.router.navigate(['/schedule']);
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }

  getWaiverTypeDisplay(waiverType: string): string {
    return waiverType === 'adult' ? 'Adult Waiver' : 'Child Waiver';
  }

  getAttendanceRate(student: Student): number {
    if (!student.stats || student.stats.totalSessions === 0) return 100;
    return Math.round((student.stats.attendedSessions / student.stats.totalSessions) * 100);
  }

  getAttendanceColor(student: Student): string {
    const rate = this.getAttendanceRate(student);
    if (rate >= 90) return 'success';
    if (rate >= 70) return 'warning';
    return 'danger';
  }

  hasMissedSessions(student: Student): boolean {
    return (student.stats?.missedSessions || 0) > 0;
  }

  getMakeUpBadgeColor(student: Student): string {
    const remaining = student.stats?.makeUpSessionsRemaining || 0;
    if (remaining === 0) return 'medium';
    if (remaining <= 2) return 'warning';
    return 'danger';
  }

  onSignatureError(event: any) {
    console.error('Error loading signature image:', event);
    // You could set a fallback image or show an error message here
    event.target.style.display = 'none';
  }
} 