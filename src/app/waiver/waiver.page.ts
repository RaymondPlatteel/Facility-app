import { Component, OnInit, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonTitle, IonToolbar, IonIcon, IonButton, IonButtons, LoadingController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack } from 'ionicons/icons';
import { FirebaseService, WaiverData } from '../services/firebase.service';

@Component({
  selector: 'app-waiver',
  templateUrl: './waiver.page.html',
  styleUrls: ['./waiver.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, IonIcon, IonButton, IonButtons, CommonModule, FormsModule]
})
export class WaiverPage implements OnInit, AfterViewInit {
  showWaiverSelect = true;
  showAdultForm = false;
  showChildForm = false;
  showSignatureModal = false;
  signatureContext: 'adult' | 'child' = 'adult';

  adult = {
    fullName: '',
    phone: '',
    email: '',
    agree: false,
    signed: false,
    signatureDataUrl: '',
    signatureDate: ''
  };
  child = {
    childName: '',
    guardianName: '',
    guardianPhone: '',
    guardianEmail: '',
    agree: false,
    signed: false,
    signatureDataUrl: '',
    signatureDate: ''
  };

  @ViewChild('canvas', { static: false }) canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('savedSignature', { static: false }) savedSignatureRef!: ElementRef<HTMLImageElement>;
  @ViewChild('savedSignatureChild', { static: false }) savedSignatureChildRef!: ElementRef<HTMLImageElement>;
  drawing = false;
  ctx!: CanvasRenderingContext2D;

  constructor(
    private firebaseService: FirebaseService,
    private loadingController: LoadingController,
    private alertController: AlertController,
    private router: Router
  ) {
    addIcons({ arrowBack });
  }

  ngOnInit() {}

  ngAfterViewInit() {
    // Canvas context will be set when modal is opened
  }

  goBack() {
    if (this.showAdultForm || this.showChildForm) {
      // Go back to waiver selection
      this.showWaiverSelect = true;
      this.showAdultForm = false;
      this.showChildForm = false;
      this.resetAdultForm();
      this.resetChildForm();
    } else {
      // Go back to home page
      this.router.navigate(['/home']);
    }
  }

  selectWaiver(type: 'adult' | 'child') {
    this.showWaiverSelect = false;
    this.showAdultForm = type === 'adult';
    this.showChildForm = type === 'child';
  }

  openSignatureModal(context: 'adult' | 'child') {
    if (context === 'adult' && !this.adult.agree) {
      alert('You must agree to the terms first.');
      return;
    }
    if (context === 'child' && !this.child.agree) {
      alert('You must agree to the terms first.');
      return;
    }
    this.signatureContext = context;
    this.showSignatureModal = true;
    setTimeout(() => {
      const canvas = this.canvasRef.nativeElement;
      this.ctx = canvas.getContext('2d')!;
      this.ctx.clearRect(0, 0, canvas.width, canvas.height);
      this.attachCanvasEvents();
    });
  }

  attachCanvasEvents() {
    const canvas = this.canvasRef.nativeElement;
    canvas.onmousedown = (e) => {
      this.drawing = true;
      this.ctx.beginPath();
      this.ctx.moveTo(e.offsetX, e.offsetY);
    };
    canvas.onmousemove = (e) => {
      if (this.drawing) {
        this.ctx.lineTo(e.offsetX, e.offsetY);
        this.ctx.stroke();
      }
    };
    canvas.onmouseup = () => this.drawing = false;
    canvas.onmouseout = () => this.drawing = false;
    // Touch events
    canvas.ontouchstart = (e: TouchEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      this.ctx.beginPath();
      this.ctx.moveTo(touch.clientX - rect.left, touch.clientY - rect.top);
      this.drawing = true;
    };
    canvas.ontouchmove = (e: TouchEvent) => {
      e.preventDefault();
      if (!this.drawing) return;
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      this.ctx.lineTo(touch.clientX - rect.left, touch.clientY - rect.top);
      this.ctx.stroke();
    };
    canvas.ontouchend = () => this.drawing = false;
  }

  clearCanvas() {
    const canvas = this.canvasRef.nativeElement;
    this.ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (this.signatureContext === 'adult') {
      this.adult.signed = false;
      this.adult.signatureDataUrl = '';
      this.adult.signatureDate = '';
    } else {
      this.child.signed = false;
      this.child.signatureDataUrl = '';
      this.child.signatureDate = '';
    }
  }

  saveSignature() {
    const canvas = this.canvasRef.nativeElement;
    const dataURL = canvas.toDataURL();
    const date = new Date().toISOString().split('T')[0];
    if (this.signatureContext === 'adult') {
      this.adult.signatureDataUrl = dataURL;
      this.adult.signed = true;
      this.adult.signatureDate = `Signed on ${date}`;
    } else {
      this.child.signatureDataUrl = dataURL;
      this.child.signed = true;
      this.child.signatureDate = `Signed on ${date}`;
    }
    this.showSignatureModal = false;
  }

  isAdultFormComplete() {
    return this.adult.fullName.trim() && this.adult.phone.trim() && this.adult.email.trim() && this.adult.agree && this.adult.signed;
  }
  isChildFormComplete() {
    return this.child.childName.trim() && this.child.guardianName.trim() && this.child.guardianPhone.trim() && this.child.guardianEmail.trim() && this.child.agree && this.child.signed;
  }

  resetAdultForm() {
    this.adult = { fullName: '', phone: '', email: '', agree: false, signed: false, signatureDataUrl: '', signatureDate: '' };
  }
  resetChildForm() {
    this.child = { childName: '', guardianName: '', guardianPhone: '', guardianEmail: '', agree: false, signed: false, signatureDataUrl: '', signatureDate: '' };
  }

  async submitWaiver(type: 'adult' | 'child') {
    console.log('Starting waiver submission for type:', type);
    const loading = await this.loadingController.create({
      message: 'Submitting waiver...'
    });
    await loading.present();

    try {
      console.log('About to save waiver data...');
      
      // Create waiver data object
      const waiverData: WaiverData = {
        waiverType: type,
        studentName: type === 'adult' ? this.adult.fullName : this.child.childName,
        signedDate: new Date().toISOString(),
        signatureDataUrl: type === 'adult' ? this.adult.signatureDataUrl : this.child.signatureDataUrl,
        createdAt: new Date().toISOString()
      };

      // Add type-specific fields
      if (type === 'adult') {
        waiverData.fullName = this.adult.fullName;
        waiverData.phone = this.adult.phone;
        waiverData.email = this.adult.email;
      } else {
        waiverData.childName = this.child.childName;
        waiverData.guardianName = this.child.guardianName;
        waiverData.guardianPhone = this.child.guardianPhone;
        waiverData.guardianEmail = this.child.guardianEmail;
      }

      // Save to Firestore
      const waiverId = await this.firebaseService.saveWaiver(waiverData);
      console.log('Waiver saved successfully with ID:', waiverId);
      
      const alert = await this.alertController.create({
        header: 'Success',
        message: 'Waiver submitted successfully!',
        buttons: ['OK']
      });
      await alert.present();

      // Reset form and navigate back
      if (type === 'adult') {
        this.resetAdultForm();
        this.showAdultForm = false;
      } else {
        this.resetChildForm();
        this.showChildForm = false;
      }
      this.showWaiverSelect = true;
    } catch (error) {
      console.error('Error submitting waiver:', error);
      const alert = await this.alertController.create({
        header: 'Error',
        message: `Failed to submit waiver: ${error}. Please try again.`,
        buttons: ['OK']
      });
      await alert.present();
    } finally {
      await loading.dismiss();
    }
  }
}
