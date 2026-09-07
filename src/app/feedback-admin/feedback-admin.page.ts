import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonContent,
  IonHeader,
  IonTitle,
  IonToolbar,
  IonButtons,
  IonButton,
  IonIcon,
  AlertController,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, chatbubblesOutline, star, starOutline, trashOutline } from 'ionicons/icons';
import { Router } from '@angular/router';
import { FirebaseService, FeedbackData } from '../services/firebase.service';

@Component({
  selector: 'app-feedback-admin',
  templateUrl: './feedback-admin.page.html',
  styleUrls: ['./feedback-admin.page.scss'],
  standalone: true,
  imports: [
    IonContent,
    IonHeader,
    IonTitle,
    IonToolbar,
    IonButtons,
    IonButton,
    IonIcon,
    CommonModule,
    FormsModule,
  ],
})
export class FeedbackAdminPage implements OnInit {
  allFeedback: FeedbackData[] = [];
  filteredFeedback: FeedbackData[] = [];
  isLoading = true;

  searchQuery = '';
  ratingFilter = 'all';

  averageRating = 0;
  stars = [1, 2, 3, 4, 5];

  constructor(
    private firebaseService: FirebaseService,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ arrowBack, chatbubblesOutline, star, starOutline, trashOutline });
  }

  async ngOnInit() {
    await this.loadFeedback();
  }

  async ionViewWillEnter() {
    await this.loadFeedback();
  }

  goBack() {
    this.router.navigate(['/home']);
  }

  async loadFeedback() {
    this.isLoading = true;
    try {
      this.allFeedback = await this.firebaseService.getFeedback();
      this.computeAverage();
      this.applyFilters();
    } catch (error) {
      console.error('Error loading feedback:', error);
      this.allFeedback = [];
      this.filteredFeedback = [];
    } finally {
      this.isLoading = false;
    }
  }

  private computeAverage() {
    const rated = this.allFeedback.filter((f) => typeof f.rating === 'number');
    this.averageRating = rated.length
      ? rated.reduce((sum, f) => sum + (f.rating || 0), 0) / rated.length
      : 0;
  }

  applyFilters() {
    const q = this.searchQuery.trim().toLowerCase();
    this.filteredFeedback = this.allFeedback.filter((f) => {
      if (this.ratingFilter !== 'all' && f.rating !== Number(this.ratingFilter)) {
        return false;
      }
      if (q && !f.studentName.toLowerCase().includes(q) && !f.feedback.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }

  trackById(_index: number, item: FeedbackData): string {
    return item.id || item.submittedDate + item.studentName;
  }

  formatDate(iso: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) {
      return iso;
    }
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  async confirmDelete(item: FeedbackData) {
    const alert = await this.alertController.create({
      header: 'Delete Feedback',
      message: `Delete feedback from ${item.studentName}? This cannot be undone.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => {
            this.deleteFeedback(item);
          },
        },
      ],
    });
    await alert.present();
  }

  private async deleteFeedback(item: FeedbackData) {
    if (!item.id) {
      return;
    }
    try {
      await this.firebaseService.deleteFeedback(item.id);
      this.allFeedback = this.allFeedback.filter((f) => f.id !== item.id);
      this.computeAverage();
      this.applyFilters();
    } catch (error) {
      console.error('Error deleting feedback:', error);
      const errorAlert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to delete feedback. Please try again.',
        buttons: ['OK'],
      });
      await errorAlert.present();
    }
  }
}
