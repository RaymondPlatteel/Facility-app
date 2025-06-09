import { Component, OnInit, AfterViewInit, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

@Component({
  selector: 'app-waiver',
  templateUrl: './waiver.page.html',
  styleUrls: ['./waiver.page.scss'],
  standalone: true,
  imports: [IonContent, IonHeader, IonTitle, IonToolbar, CommonModule, FormsModule]
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

  ngOnInit() {}

  ngAfterViewInit() {
    // Canvas context will be set when modal is opened
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

  submitWaiver(type: 'adult' | 'child') {
    alert('Waiver submitted successfully!');
    this.generateWaiverPDF(type);
    if (type === 'adult') {
      this.resetAdultForm();
      this.showAdultForm = false;
    } else {
      this.resetChildForm();
      this.showChildForm = false;
    }
    this.showWaiverSelect = true;
  }

  async generateWaiverPDF(type: 'adult' | 'child') {
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 40;
    let y = margin;
    let waiverText = '';
    let signatureDataUrl = '';
    let dateText = '';
    if (type === 'adult') {
      pdf.setFontSize(18);
      pdf.text('New Student Enrollment Waiver', margin, y); y += 30;
      pdf.setFontSize(12);
      pdf.text(`Full Name: ${this.adult.fullName}`, margin, y); y += 18;
      pdf.text(`Phone: ${this.adult.phone}`, margin, y); y += 18;
      pdf.text(`Email: ${this.adult.email}`, margin, y); y += 18;
      waiverText = `I acknowledge and agree that my participation in any and all training activities, exercises, programs, and services offered by this facility and its trainers, employees, agents, successors, and assigns (collectively referred to as \"the Provider\") is entirely voluntary and undertaken at my own risk. I understand that physical training carries inherent risks including, but not limited to, serious bodily injury, permanent disability, heart attack, stroke, paralysis, psychological trauma, or death, as well as property loss or damage. I hereby expressly and unequivocally waive, release, discharge, indemnify, and hold harmless the Provider from any and all claims, liabilities, obligations, demands, actions, damages, expenses, and costs of any kind or nature whatsoever, whether now known or unknown, foreseeable or unforeseeable, arising directly or indirectly out of or in connection with my participation, regardless of whether caused by negligence, fault, omission, or any other act or condition of the Provider or any other party.\n\n- I am physically fit and capable of safely participating in all training activities. I have either consulted a licensed physician or have voluntarily chosen not to do so and accept full responsibility for this decision.\n- I will not hold the Provider responsible for any aggravation or worsening of any existing injuries or conditions, including unknown or latent medical issues.\n- I waive the right to bring any claim in a court of law and agree to binding arbitration in the Commonwealth of Massachusetts as the sole and exclusive venue for any dispute resolution.\n- I will not bring any collective or class action lawsuit against the Provider.\n- This agreement shall be governed by and interpreted in accordance with the laws of the Commonwealth of Massachusetts, without regard to conflicts of laws principles.\n- If any part of this waiver is deemed unenforceable, the remainder shall remain in full force and effect.\n\nI have read and understood this entire waiver and agree to be bound by its terms. I understand that by signing below, I am giving up substantial legal rights and that I am doing so voluntarily and of my own free will.`;
      signatureDataUrl = this.adult.signatureDataUrl;
      dateText = this.adult.signatureDate;
    } else {
      pdf.setFontSize(18);
      pdf.text('New Student Enrollment Waiver', margin, y); y += 30;
      pdf.setFontSize(12);
      pdf.text(`Child's Name: ${this.child.childName}`, margin, y); y += 18;
      pdf.text(`Parent/Guardian Name: ${this.child.guardianName}`, margin, y); y += 18;
      pdf.text(`Parent/Guardian Phone: ${this.child.guardianPhone}`, margin, y); y += 18;
      pdf.text(`Parent/Guardian Email: ${this.child.guardianEmail}`, margin, y); y += 18;
      waiverText = `As the parent or legal guardian of the above-named child, I hereby give permission for my child to participate in training programs offered by this facility. I acknowledge that all training activities, programs, and services carry inherent risks, including serious injury or death. I agree to assume all risks and liabilities and voluntarily waive, release, discharge, and indemnify the Provider, its employees, agents, successors, and assigns from all liability, including that resulting from negligence. This waiver is binding and irrevocable.\n\n- I confirm my child is medically and physically able to participate.\n- I take full legal and financial responsibility for any injuries or damages.\n- I waive the right to any future claims or lawsuits under any circumstances.\n- I agree to binding arbitration in Massachusetts for any disputes.\n- This waiver remains in effect indefinitely unless explicitly revoked in writing and acknowledged by the Provider.\n\nI have read and understood this entire waiver and agree to be bound by its terms.`;
      signatureDataUrl = this.child.signatureDataUrl;
      dateText = this.child.signatureDate;
    }
    const waiverLines = pdf.splitTextToSize(waiverText, 520);
    pdf.text(waiverLines, margin, y);
    y += waiverLines.length * 14 + 20;
    if (signatureDataUrl && signatureDataUrl.startsWith('data:image')) {
      pdf.text('Signature:', margin, y);
      pdf.addImage(signatureDataUrl, 'PNG', margin + 70, y - 12, 150, 40);
      y += 50;
    }
    pdf.text(dateText, margin, y);
    // Placeholder: Google Drive upload logic can be added here
    pdf.save(type === 'adult' ? 'Waiver-Adult.pdf' : 'Waiver-Child.pdf');
  }
}
