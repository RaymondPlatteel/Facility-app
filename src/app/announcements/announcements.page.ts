import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { FirebaseService, Announcement } from '../services/firebase.service';

// What athletes see at the top of the World page in the mobile app: official
// announcements (newest pinned first) and the prize-pool banner. Nothing is
// shown to athletes until something is entered here.
@Component({
  selector: 'app-announcements',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './announcements.page.html',
  styleUrls: ['./announcements.page.scss']
})
export class AnnouncementsPage implements OnInit {
  announcements: Announcement[] = [];
  isLoading = true;

  title = '';
  body = '';
  isPosting = false;

  prizePool: number | null = null;
  eventDate = '';
  eventEndDate = '';
  label = '';
  isSavingBanner = false;

  constructor(private firebase: FirebaseService, private toasts: ToastController, private alerts: AlertController) {}

  async ngOnInit() {
    await this.load();
  }

  private async load() {
    this.isLoading = true;
    try {
      const [list, cfg] = await Promise.all([this.firebase.listAnnouncements(), this.firebase.getCompetitionConfig()]);
      this.announcements = list;
      this.prizePool = cfg.prizePool ?? null;
      this.eventDate = cfg.eventDate ?? '';
      this.eventEndDate = cfg.eventEndDate ?? '';
      this.label = cfg.label ?? '';
    } finally {
      this.isLoading = false;
    }
  }

  get canPost(): boolean { return !!this.title.trim() && !!this.body.trim() && !this.isPosting; }

  async post() {
    if (!this.canPost) return;
    this.isPosting = true;
    try {
      await this.firebase.addAnnouncement(this.title, this.body);
      this.title = '';
      this.body = '';
      await this.load();
      this.toast('Announcement posted');
    } catch {
      this.toast('Could not post', 'danger');
    } finally {
      this.isPosting = false;
    }
  }

  async remove(a: Announcement) {
    if (!a.id) return;
    const alert = await this.alerts.create({
      header: 'Delete announcement?',
      message: a.title,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: async () => {
          await this.firebase.deleteAnnouncement(a.id!);
          await this.load();
        } }
      ]
    });
    await alert.present();
  }

  async saveBanner() {
    this.isSavingBanner = true;
    try {
      await this.firebase.setCompetitionConfig({
        prizePool: this.prizePool != null && this.prizePool > 0 ? this.prizePool : null,
        eventDate: this.eventDate || null,
        eventEndDate: this.eventEndDate || null,
        label: this.label
      });
      this.toast('Banner saved');
    } catch {
      this.toast('Could not save', 'danger');
    } finally {
      this.isSavingBanner = false;
    }
  }

  private async toast(message: string, color = 'success') {
    const t = await this.toasts.create({ message, duration: 1800, color, position: 'bottom' });
    await t.present();
  }
}
