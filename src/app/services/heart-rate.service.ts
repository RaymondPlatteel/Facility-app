import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';

export interface HrSample {
  t: number;   // epoch ms
  hr: number;  // bpm
}

export interface WatchSlot {
  id: string;             // bluetooth device id
  label: string;          // person name (editable)
  deviceName: string;
  manufacturer: string | null;
  connected: boolean;
  reconnecting: boolean;
  hr: number | null;
  contact: 'yes' | 'no' | 'unknown';
  energyKJ: number | null;        // energy expended, if the watch reports it
  rrMs: number[];                 // latest beat-to-beat intervals in ms
  battery: number | null;         // percent
  minHr: number | null;
  maxSeenHr: number | null;
  avgHr: number | null;
  samples: HrSample[];            // rolling history for sparkline
  maxHr: number;                  // user-set max HR for zone calc
  lastUpdate: number | null;
  device: BluetoothDevice;
}

export const MAX_SLOTS = 6;
const HISTORY_MS = 5 * 60 * 1000; // keep 5 minutes of samples

const HEART_RATE_SERVICE = 'heart_rate';
const HEART_RATE_MEASUREMENT = 'heart_rate_measurement';
const BATTERY_SERVICE = 'battery_service';
const BATTERY_LEVEL = 'battery_level';
const DEVICE_INFO_SERVICE = 'device_information';
const MANUFACTURER_NAME = 'manufacturer_name_string';

@Injectable({ providedIn: 'root' })
export class HeartRateService {
  slots: WatchSlot[] = [];
  changes = new Subject<void>();

  private hrSum = new Map<string, { sum: number; count: number }>();

  constructor(private zone: NgZone) {}

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).bluetooth;
  }

  get full(): boolean {
    return this.slots.length >= MAX_SLOTS;
  }

  /** Opens the browser device chooser and connects the picked watch.
   *  Must be called from a user gesture (button click). */
  async addWatch(): Promise<WatchSlot | null> {
    if (!this.isSupported() || this.full) return null;

    let device: BluetoothDevice;
    try {
      device = await (navigator as any).bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }],
        optionalServices: [BATTERY_SERVICE, DEVICE_INFO_SERVICE]
      });
    } catch {
      // user cancelled the chooser
      return null;
    }

    const existing = this.slots.find(s => s.id === device.id);
    if (existing) {
      if (!existing.connected) await this.connect(existing);
      return existing;
    }

    const slot: WatchSlot = {
      id: device.id,
      label: `Athlete ${this.slots.length + 1}`,
      deviceName: device.name || 'Unknown device',
      manufacturer: null,
      connected: false,
      reconnecting: false,
      hr: null,
      contact: 'unknown',
      energyKJ: null,
      rrMs: [],
      battery: null,
      minHr: null,
      maxSeenHr: null,
      avgHr: null,
      samples: [],
      maxHr: 190,
      lastUpdate: null,
      device
    };
    this.slots.push(slot);
    this.hrSum.set(slot.id, { sum: 0, count: 0 });

    device.addEventListener('gattserverdisconnected', () => {
      this.zone.run(() => this.onDisconnected(slot));
    });

    await this.connect(slot);
    return slot;
  }

  async remove(id: string): Promise<void> {
    const slot = this.slots.find(s => s.id === id);
    if (!slot) return;
    this.slots = this.slots.filter(s => s !== slot);
    this.hrSum.delete(id);
    try {
      slot.device.gatt?.disconnect();
    } catch { /* already gone */ }
    this.changes.next();
  }

  async disconnectAll(): Promise<void> {
    for (const slot of [...this.slots]) {
      await this.remove(slot.id);
    }
  }

  resetStats(id: string): void {
    const slot = this.slots.find(s => s.id === id);
    if (!slot) return;
    slot.minHr = null;
    slot.maxSeenHr = null;
    slot.avgHr = null;
    slot.samples = [];
    slot.energyKJ = null;
    this.hrSum.set(id, { sum: 0, count: 0 });
    this.changes.next();
  }

  private async connect(slot: WatchSlot): Promise<void> {
    try {
      slot.reconnecting = true;
      this.changes.next();

      const server = await slot.device.gatt!.connect();

      const hrService = await server.getPrimaryService(HEART_RATE_SERVICE);
      const hrChar = await hrService.getCharacteristic(HEART_RATE_MEASUREMENT);
      hrChar.addEventListener('characteristicvaluechanged', (ev: Event) => {
        const value = (ev.target as any).value as DataView;
        this.zone.run(() => this.onHrMeasurement(slot, value));
      });
      await hrChar.startNotifications();

      // Battery and manufacturer are optional — many watches don't expose them
      this.readBattery(server, slot).catch(() => {});
      this.readManufacturer(server, slot).catch(() => {});

      slot.connected = true;
      slot.reconnecting = false;
      this.changes.next();
    } catch (err) {
      slot.connected = false;
      slot.reconnecting = false;
      this.changes.next();
      throw err;
    }
  }

  private async readBattery(server: BluetoothRemoteGATTServer, slot: WatchSlot): Promise<void> {
    const svc = await server.getPrimaryService(BATTERY_SERVICE);
    const char = await svc.getCharacteristic(BATTERY_LEVEL);
    const val = await char.readValue();
    slot.battery = val.getUint8(0);
    try {
      char.addEventListener('characteristicvaluechanged', (ev: Event) => {
        const v = (ev.target as any).value as DataView;
        this.zone.run(() => {
          slot.battery = v.getUint8(0);
          this.changes.next();
        });
      });
      await char.startNotifications();
    } catch { /* battery notifications unsupported — keep the one-shot read */ }
    this.changes.next();
  }

  private async readManufacturer(server: BluetoothRemoteGATTServer, slot: WatchSlot): Promise<void> {
    const svc = await server.getPrimaryService(DEVICE_INFO_SERVICE);
    const char = await svc.getCharacteristic(MANUFACTURER_NAME);
    const val = await char.readValue();
    slot.manufacturer = new TextDecoder().decode(val).trim() || null;
    this.changes.next();
  }

  /** Parses a Heart Rate Measurement characteristic per the Bluetooth GATT spec. */
  private onHrMeasurement(slot: WatchSlot, data: DataView): void {
    const flags = data.getUint8(0);
    const hr16 = (flags & 0x01) !== 0;
    const contactSupported = (flags & 0x04) !== 0;
    const contactDetected = (flags & 0x02) !== 0;
    const energyPresent = (flags & 0x08) !== 0;
    const rrPresent = (flags & 0x10) !== 0;

    let offset = 1;
    const hr = hr16 ? data.getUint16(offset, true) : data.getUint8(offset);
    offset += hr16 ? 2 : 1;

    if (energyPresent) {
      slot.energyKJ = data.getUint16(offset, true);
      offset += 2;
    }

    if (rrPresent) {
      const rr: number[] = [];
      while (offset + 1 < data.byteLength) {
        rr.push(Math.round((data.getUint16(offset, true) / 1024) * 1000));
        offset += 2;
      }
      if (rr.length) slot.rrMs = rr.slice(-4);
    }

    slot.hr = hr;
    slot.contact = contactSupported ? (contactDetected ? 'yes' : 'no') : 'unknown';
    slot.lastUpdate = Date.now();

    if (hr > 0) {
      slot.minHr = slot.minHr === null ? hr : Math.min(slot.minHr, hr);
      slot.maxSeenHr = slot.maxSeenHr === null ? hr : Math.max(slot.maxSeenHr, hr);
      const agg = this.hrSum.get(slot.id);
      if (agg) {
        agg.sum += hr;
        agg.count += 1;
        slot.avgHr = Math.round(agg.sum / agg.count);
      }
      slot.samples.push({ t: slot.lastUpdate, hr });
      const cutoff = slot.lastUpdate - HISTORY_MS;
      while (slot.samples.length && slot.samples[0].t < cutoff) slot.samples.shift();
    }

    this.changes.next();
  }

  private onDisconnected(slot: WatchSlot): void {
    if (!this.slots.includes(slot)) return; // removed on purpose
    slot.connected = false;
    this.changes.next();
    this.autoReconnect(slot);
  }

  private async autoReconnect(slot: WatchSlot, attempt = 1): Promise<void> {
    if (attempt > 5 || !this.slots.includes(slot)) {
      slot.reconnecting = false;
      this.changes.next();
      return;
    }
    slot.reconnecting = true;
    this.changes.next();
    await new Promise(r => setTimeout(r, attempt * 2000));
    if (!this.slots.includes(slot) || slot.connected) return;
    try {
      await this.connect(slot);
    } catch {
      this.autoReconnect(slot, attempt + 1);
    }
  }
}
