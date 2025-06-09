import { Injectable } from '@angular/core';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, orderBy, where } from 'firebase/firestore';
import { environment } from '../../environments/environment';

export interface Session {
  id?: string;
  date: Date;
  name: string;
  participants: string[];
  attendance?: AttendanceRecord[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AttendanceRecord {
  sessionId: string;
  studentName: string;
  checkInTime: string;
  date: string;
  present: boolean;
}

export interface FeedbackData {
  id?: string;
  studentName: string;
  feedback: string;
  submittedDate: string;
  sessionName?: string;
  rating?: number;
}

export interface StudentStats {
  studentName: string;
  totalSessions: number;
  attendedSessions: number;
  missedSessions: number;
  makeUpSessionsRemaining: number;
}

export interface WaiverData {
  id?: string;
  waiverType: 'adult' | 'child';
  studentName: string;
  signedDate: string;
  signatureDataUrl: string;
  // Adult waiver fields
  fullName?: string;
  phone?: string;
  email?: string;
  // Child waiver fields
  childName?: string;
  guardianName?: string;
  guardianPhone?: string;
  guardianEmail?: string;
  // Timestamps
  createdAt?: string;
}

@Injectable({
  providedIn: 'root'
})
export class FirebaseService {
  private app;
  private db;

  constructor() {
    this.app = initializeApp(environment.firebase);
    this.db = getFirestore(this.app);
    
    console.log('Firebase initialized successfully', {
      projectId: environment.firebase.projectId
    });
  }

  // Save a new session
  async saveSession(session: Omit<Session, 'id'>): Promise<string> {
    try {
      const sessionData = {
        ...session,
        date: session.date.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      const docRef = await addDoc(collection(this.db, 'sessions'), sessionData);
      console.log('Session saved with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving session: ', error);
      throw error;
    }
  }

  // Get all sessions
  async getSessions(): Promise<Session[]> {
    try {
      const q = query(collection(this.db, 'sessions'), orderBy('date'));
      const querySnapshot = await getDocs(q);
      
      const sessions: Session[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        sessions.push({
          id: doc.id,
          name: data['name'],
          participants: data['participants'],
          date: new Date(data['date']),
          createdAt: data['createdAt'] ? new Date(data['createdAt']) : undefined,
          updatedAt: data['updatedAt'] ? new Date(data['updatedAt']) : undefined
        });
      });
      
      return sessions;
    } catch (error) {
      console.error('Error getting sessions: ', error);
      throw error;
    }
  }

  // Update a session
  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    try {
      const sessionRef = doc(this.db, 'sessions', id);
      const updateData: any = {
        ...updates,
        updatedAt: new Date().toISOString()
      };
      
      if (updates.date) {
        updateData.date = updates.date.toISOString();
      }
      
      await updateDoc(sessionRef, updateData);
      console.log('Session updated successfully');
    } catch (error) {
      console.error('Error updating session: ', error);
      throw error;
    }
  }

  // Delete a session
  async deleteSession(id: string): Promise<void> {
    try {
      await deleteDoc(doc(this.db, 'sessions', id));
      console.log('Session deleted successfully');
    } catch (error) {
      console.error('Error deleting session: ', error);
      throw error;
    }
  }

  // Save waiver data directly to Firestore
  async saveWaiver(waiver: WaiverData): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'waivers'), waiver);
      console.log('Waiver saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving waiver: ', error);
      throw error;
    }
  }

  // Get all waivers for a specific student
  async getStudentWaivers(studentName: string): Promise<WaiverData[]> {
    try {
      const waivers: WaiverData[] = [];
      const querySnapshot = await getDocs(collection(this.db, 'waivers'));
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        if (data['studentName'].toLowerCase() === studentName.toLowerCase()) {
          waivers.push({
            id: doc.id,
            waiverType: data['waiverType'],
            studentName: data['studentName'],
            signedDate: data['signedDate'],
            signatureDataUrl: data['signatureDataUrl'],
            fullName: data['fullName'],
            phone: data['phone'],
            email: data['email'],
            childName: data['childName'],
            guardianName: data['guardianName'],
            guardianPhone: data['guardianPhone'],
            guardianEmail: data['guardianEmail'],
            createdAt: data['createdAt']
          });
        }
      });
      
      return waivers.sort((a, b) => new Date(b.signedDate).getTime() - new Date(a.signedDate).getTime());
    } catch (error) {
      console.error('Error getting student waivers: ', error);
      throw error;
    }
  }

  // Get all waivers (for admin view)
  async getAllWaivers(): Promise<WaiverData[]> {
    try {
      const waivers: WaiverData[] = [];
      const querySnapshot = await getDocs(query(collection(this.db, 'waivers'), orderBy('signedDate', 'desc')));
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        waivers.push({
          id: doc.id,
          waiverType: data['waiverType'],
          studentName: data['studentName'],
          signedDate: data['signedDate'],
          signatureDataUrl: data['signatureDataUrl'],
          fullName: data['fullName'],
          phone: data['phone'],
          email: data['email'],
          childName: data['childName'],
          guardianName: data['guardianName'],
          guardianPhone: data['guardianPhone'],
          guardianEmail: data['guardianEmail'],
          createdAt: data['createdAt']
        });
      });
      
      return waivers;
    } catch (error) {
      console.error('Error getting all waivers: ', error);
      throw error;
    }
  }

  // Save feedback
  async saveFeedback(feedback: FeedbackData): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'feedback'), feedback);
      console.log('Feedback saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving feedback: ', error);
      throw error;
    }
  }

  // Save attendance record
  async saveAttendance(attendance: AttendanceRecord): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'attendance'), attendance);
      console.log('Attendance saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving attendance: ', error);
      throw error;
    }
  }

  // Get attendance for a specific session
  async getSessionAttendance(sessionId: string): Promise<AttendanceRecord[]> {
    try {
      const attendance: AttendanceRecord[] = [];
      const q = query(collection(this.db, 'attendance'), where('sessionId', '==', sessionId));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        attendance.push({
          sessionId: data['sessionId'],
          studentName: data['studentName'],
          checkInTime: data['checkInTime'],
          date: data['date'],
          present: data['present']
        });
      });
      
      return attendance;
    } catch (error) {
      console.error('Error getting session attendance: ', error);
      throw error;
    }
  }

  // Get student attendance across all sessions
  async getStudentAttendance(studentName: string): Promise<AttendanceRecord[]> {
    try {
      const attendance: AttendanceRecord[] = [];
      const q = query(collection(this.db, 'attendance'), where('studentName', '==', studentName));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        attendance.push({
          sessionId: data['sessionId'],
          studentName: data['studentName'],
          checkInTime: data['checkInTime'],
          date: data['date'],
          present: data['present']
        });
      });
      
      return attendance.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } catch (error) {
      console.error('Error getting student attendance: ', error);
      throw error;
    }
  }

  // Calculate student statistics including make-up sessions
  async getStudentStats(studentName: string): Promise<StudentStats> {
    try {
      // Get all sessions where student is a participant
      const sessions = await this.getSessions();
      const studentSessions = sessions.filter(session => 
        session.participants.some(participant => participant.toLowerCase() === studentName.toLowerCase())
      );

      // Get attendance records for this student
      const attendanceRecords = await this.getStudentAttendance(studentName);
      
      const totalSessions = studentSessions.length;
      const attendedSessions = attendanceRecords.filter(record => record.present).length;
      const missedSessions = totalSessions - attendedSessions;
      
      // Calculate make-up sessions remaining (assuming 2 make-ups per missed session)
      const makeUpSessionsRemaining = Math.max(0, missedSessions * 2);

      return {
        studentName,
        totalSessions,
        attendedSessions,
        missedSessions,
        makeUpSessionsRemaining
      };
    } catch (error) {
      console.error('Error calculating student stats: ', error);
      throw error;
    }
  }

  // Check if student is already checked in for a session
  async isStudentCheckedIn(studentName: string, sessionId: string): Promise<boolean> {
    try {
      const q = query(
        collection(this.db, 'attendance'), 
        where('studentName', '==', studentName),
        where('sessionId', '==', sessionId),
        where('present', '==', true)
      );
      const querySnapshot = await getDocs(q);
      return !querySnapshot.empty;
    } catch (error) {
      console.error('Error checking student attendance: ', error);
      return false;
    }
  }
} 