import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { FirebaseService } from './firebase.service';

// Tells the coach when someone downloads the athlete app, creates an account, or saves a score that no coach will review
// (a private account, or a result sent without a video; results waiting for review are in Pending already), on the coach's iPhone.
// - While this app is open, the usage log the athlete app writes (appEvents) is watched, and an 'install' (first open
//   on a new device) or a 'signup' shows a banner at once.
// - With this app closed, the Worker sends a push to the device tokens saved here (coachDevices); see
//   stripe-webhook/src/notify.ts.
@Injectable({ providedIn: 'root' })
export class NewUserAlertsService {
  private started = false;
  private nextId = Math.floor(Date.now() / 1000) % 1_000_000;

  constructor(private firebase: FirebaseService) {}

  async start() {
    if (this.started || Capacitor.getPlatform() !== 'ios') return;
    this.started = true;
    try {
      const local = await LocalNotifications.requestPermissions();
      const push = await PushNotifications.requestPermissions();
      if (push.receive === 'granted') {
        await PushNotifications.addListener('registration', t => this.firebase.saveCoachDevice(t.value).catch(() => undefined));
        await PushNotifications.addListener('registrationError', () => undefined);
        await PushNotifications.register();
      }
      if (local.display === 'granted') this.watch();
    } catch { /* notifications are optional; the app works without them */ }
  }

  // Banners for what happens while the app is open.
  private watch() {
    this.firebase.watchAppEvents(Date.now(), events => {
      const notes: Array<{ id: number; title: string; body: string; schedule: { at: Date } }> = [];
      for (const b of events) {
        for (const e of b.ev) {
          if (e.e !== 'install' && e.e !== 'signup' && e.e !== 'saved') continue;
          notes.push({
            id: ++this.nextId,
            title: e.e === 'install' ? 'New download' : e.e === 'signup' ? 'New account' : 'Score saved without review',
            body: e.e === 'install'
              ? `Someone opened the app for the first time${b.pl ? ' on ' + (b.pl === 'ios' ? 'iPhone' : b.pl) : ''}${b.v ? ', version ' + b.v : ''}.`
              : e.e === 'signup' ? 'Someone created an account.'
              : e.x === 'private' ? 'A private account saved a score. It is not in the pending list.'
              : 'An athlete saved a score without a video. It is not in the pending list.',
            schedule: { at: new Date(Date.now() + 500) }
          });
        }
      }
      if (notes.length) LocalNotifications.schedule({ notifications: notes.slice(0, 10) }).catch(() => undefined);
    });
  }
}
