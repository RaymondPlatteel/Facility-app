import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  addOutline,
  watchOutline,
  heartOutline,
  closeOutline,
  refreshOutline,
  batteryHalfOutline,
  bluetoothOutline,
  pulseOutline,
  alertCircleOutline
} from 'ionicons/icons';
import { Subscription } from 'rxjs';
import { HeartRateService, WatchSlot, MAX_SLOTS } from '../services/heart-rate.service';

interface Zone {
  name: string;
  color: string;
}

const ZONES: { min: number; name: string; color: string }[] = [
  { min: 0.9, name: 'Zone 5 · Max', color: '#ff5a6a' },
  { min: 0.8, name: 'Zone 4 · Hard', color: '#ff8a4a' },
  { min: 0.7, name: 'Zone 3 · Moderate', color: '#f5b942' },
  { min: 0.6, name: 'Zone 2 · Light', color: '#2dd36f' },
  { min: 0.5, name: 'Zone 1 · Easy', color: '#00d4ff' },
  { min: 0, name: 'Resting', color: '#88a6bf' }
];

@Component({
  selector: 'app-live-monitor',
  templateUrl: './live-monitor.page.html',
  styleUrls: ['./live-monitor.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, RouterModule]
})
export class LiveMonitorPage implements OnInit, OnDestroy {
  readonly maxSlots = MAX_SLOTS;
  supported = true;
  connectError = '';

  private sub?: Subscription;

  constructor(public hrs: HeartRateService) {
    addIcons({
      arrowBack,
      addOutline,
      watchOutline,
      heartOutline,
      closeOutline,
      refreshOutline,
      batteryHalfOutline,
      bluetoothOutline,
      pulseOutline,
      alertCircleOutline
    });
  }

  ngOnInit(): void {
    this.supported = this.hrs.isSupported();
    this.sub = this.hrs.changes.subscribe(() => { /* trigger CD */ });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    // connections intentionally stay alive in the service so the
    // monitor keeps data if the user navigates away and back
  }

  get slots(): WatchSlot[] {
    return this.hrs.slots;
  }

  trackById(_i: number, slot: WatchSlot): string {
    return slot.id;
  }

  async addWatch(): Promise<void> {
    this.connectError = '';
    try {
      await this.hrs.addWatch();
    } catch {
      this.connectError = 'Could not connect to that device. Make sure heart-rate broadcasting is enabled on the watch, then try again.';
    }
  }

  remove(slot: WatchSlot): void {
    this.hrs.remove(slot.id);
  }

  resetStats(slot: WatchSlot): void {
    this.hrs.resetStats(slot.id);
  }

  setLabel(slot: WatchSlot, value: string): void {
    slot.label = value;
  }

  setMaxHr(slot: WatchSlot, value: string): void {
    const n = parseInt(value, 10);
    if (!isNaN(n) && n >= 100 && n <= 230) slot.maxHr = n;
  }

  zone(slot: WatchSlot): Zone {
    if (!slot.hr) return { name: '—', color: '#4a6378' };
    const pct = slot.hr / slot.maxHr;
    const z = ZONES.find(z => pct >= z.min)!;
    return { name: z.name, color: z.color };
  }

  zonePct(slot: WatchSlot): number {
    if (!slot.hr) return 0;
    return Math.min(100, Math.round((slot.hr / slot.maxHr) * 100));
  }

  /** Beats-per-second pulse animation duration, clamped for sanity. */
  pulseDuration(slot: WatchSlot): string {
    const hr = slot.hr || 60;
    return `${(60 / Math.max(40, Math.min(200, hr))).toFixed(2)}s`;
  }

  /** Latest RR interval in ms, if the watch sends beat-to-beat data. */
  lastRr(slot: WatchSlot): number | null {
    return slot.rrMs.length ? slot.rrMs[slot.rrMs.length - 1] : null;
  }

  /** SVG polyline points for the last 5 minutes of samples. */
  sparkline(slot: WatchSlot): string {
    const s = slot.samples;
    if (s.length < 2) return '';
    const w = 100;
    const h = 28;
    const t0 = s[0].t;
    const t1 = s[s.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const lo = Math.min(...s.map(p => p.hr));
    const hi = Math.max(...s.map(p => p.hr));
    const range = Math.max(hi - lo, 5);
    return s
      .map(p => {
        const x = ((p.t - t0) / span) * w;
        const y = h - 2 - ((p.hr - lo) / range) * (h - 4);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  secondsAgo(slot: WatchSlot): number | null {
    if (!slot.lastUpdate) return null;
    return Math.round((Date.now() - slot.lastUpdate) / 1000);
  }
}
