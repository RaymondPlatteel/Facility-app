import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon, ToastController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBack, calendarOutline } from 'ionicons/icons';
import { CalendarSyncService } from '../services/calendar-sync.service';

// App-wide coach preferences. Currently just Apple Calendar sync — moved
// here from the Schedule page header so it's somewhere discoverable and
// stable rather than competing for space next to the week/month toggle.
@Component({
  selector: 'app-settings',
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonIcon]
})
export class SettingsPage implements OnInit {
  calendarSyncEnabled = false;
  calendarSyncBusy = false;

  constructor(
    private router: Router,
    private toastController: ToastController,
    private calendarSync: CalendarSyncService
  ) {
    addIcons({ arrowBack, calendarOutline });
  }

  ngOnInit() {
    this.calendarSyncEnabled = this.calendarSync.isEnabled;
    // Opening this page doubles as a refresh, same as the Schedule page
    // syncing on every load — covers anyone whose calendar was left empty
    // by enabling before syncCurrentSchedule() existed, with no extra tap.
    // syncCurrentSchedule() itself already no-ops when sync is off.
    this.calendarSync.syncCurrentSchedule().catch(err =>
      console.error('Settings: background calendar refresh failed', err));
  }

  get calendarSyncSupported(): boolean {
    return this.calendarSync.isSupported;
  }

  // Enables/disables the whole feature: requests calendar write access (or,
  // when turning off, deletes the dedicated calendar and forgets everything
  // synced). Enabling also immediately pushes the current schedule in —
  // enable() on its own only creates the empty calendar, so without this the
  // calendar would stay blank until the Schedule page next happened to load.
  async toggleCalendarSync() {
    if (this.calendarSyncBusy) return;
    this.calendarSyncBusy = true;
    try {
      if (this.calendarSyncEnabled) {
        await this.calendarSync.disable();
        this.calendarSyncEnabled = false;
        this.presentToast('Apple Calendar sync turned off');
      } else {
        const granted = await this.calendarSync.enable();
        if (!granted) {
          this.presentToast('Calendar access was not granted', 'danger');
          return;
        }
        this.calendarSyncEnabled = true;
        this.presentToast('Syncing your schedule to Apple Calendar…');
        await this.calendarSync.syncCurrentSchedule();
        this.presentToast('Synced to Apple Calendar');
      }
    } catch (err) {
      console.error('Settings: calendar sync toggle failed', err);
      this.presentToast('Could not update calendar sync', 'danger');
    } finally {
      this.calendarSyncBusy = false;
    }
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  private async presentToast(message: string, color: 'success' | 'danger' = 'success') {
    const toast = await this.toastController.create({ message, duration: 2200, position: 'bottom', color });
    await toast.present();
  }
}
