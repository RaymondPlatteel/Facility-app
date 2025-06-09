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
  IonTextarea,
  IonButton,
  IonButtons,
  LoadingController,
  AlertController 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, send, star, starOutline } from 'ionicons/icons';
import { FirebaseService, FeedbackData } from '../services/firebase.service';

@Component({
  selector: 'app-feedback',
  templateUrl: './feedback.page.html',
  styleUrls: ['./feedback.page.scss'],
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
    IonTextarea,
    IonButton,
    IonButtons,
    CommonModule, 
    FormsModule
  ]
})
export class FeedbackPage implements OnInit {
  feedback = {
    studentName: '',
    comment: '',
    rating: 5
  };
  
  isSubmitting = false;

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ arrowBack, send, star, starOutline });
  }

  ngOnInit() {
  }

  goBack() {
    this.router.navigate(['/home']);
  }

  setRating(rating: number) {
    this.feedback.rating = rating;
  }

  async submitFeedback() {
    if (!this.feedback.studentName.trim() || !this.feedback.comment.trim()) {
      const alert = await this.alertController.create({
        header: 'Missing Information',
        message: 'Please fill in your name and feedback comment.',
        buttons: ['OK']
      });
      await alert.present();
      return;
    }

    this.isSubmitting = true;

    const loading = await this.loadingController.create({
      message: 'Submitting feedback...'
    });
    await loading.present();

    try {
      const feedbackData: FeedbackData = {
        studentName: this.feedback.studentName.trim(),
        feedback: this.feedback.comment.trim(),
        rating: this.feedback.rating,
        submittedDate: new Date().toISOString()
      };

      await this.firebaseService.saveFeedback(feedbackData);

      // Clear form
      this.feedback = {
        studentName: '',
        comment: '',
        rating: 5
      };

      const successAlert = await this.alertController.create({
        header: 'Thank You!',
        message: 'Your feedback has been submitted successfully. We appreciate your input!',
        buttons: ['OK']
      });
      await successAlert.present();

    } catch (error) {
      console.error('Error submitting feedback:', error);
      const errorAlert = await this.alertController.create({
        header: 'Error',
        message: 'Failed to submit feedback. Please try again.',
        buttons: ['OK']
      });
      await errorAlert.present();
    } finally {
      this.isSubmitting = false;
      await loading.dismiss();
    }
  }
} 