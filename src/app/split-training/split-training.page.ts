import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { addIcons } from 'ionicons';
import { arrowBack, cloudUploadOutline } from 'ionicons/icons';
import { FirebaseService } from '../services/firebase.service';
import { SplitMark, SplitModel, SplitPoints, SplitStats, PointSpread, AngleSpread, ANGLE_TARGET, ANGLE_FAR, POINT_CLOSE_PX, POINT_FAR_PX, STAT_PX, splitDeg } from '../services/split-mark.util';
import { SplitMarkEditorComponent } from '../shared/split-mark/split-mark-editor.component';

type Conf = Record<'hip' | 'left' | 'right', number>;
interface PoseDetectPlugin {
  detectSplit(options: { image: string }): Promise<{ found: boolean; confidence?: Conf; kneeStandsIn?: { left: boolean; right: boolean } } & Partial<SplitPoints>>;
}
const PoseDetect = registerPlugin<PoseDetectPlugin>('PoseDetect');
const DETECT_PX = 1280;   // longest side of the copy sent for detection, as in the athlete app
const KEEP_PX = 2048;     // longest side of the photo kept with the sample

interface Photo { url: string; file: File; iw: number; ih: number; detected: SplitPoints | null; conf: Conf | null; knee: { left: boolean; right: boolean } | null; }

// Teaches middle split detection from photos the coach picks. Each photo is run through the same body pose detection the
// athlete's phone uses; the coach moves the three points to where they belong; saving records the difference, and the
// learned correction (see split-mark.util) is recomputed from every sample so far.
@Component({
  selector: 'app-split-training',
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, SplitMarkEditorComponent],
  templateUrl: './split-training.page.html',
  styleUrls: ['./split-training.page.scss']
})
export class SplitTrainingPage implements OnInit, OnDestroy {
  readonly native = Capacitor.getPlatform() === 'ios';
  queue: Photo[] = [];
  index = 0;
  points: SplitPoints | null = null;
  loadingPhotos = false;
  saving = false;
  saved = 0;
  skipped = 0;
  error = '';
  model: SplitModel | null = null;
  stats: SplitStats | null = null;
  readonly pointRows: Array<{ key: 'hip' | 'left' | 'right'; label: string }> = [
    { key: 'hip', label: 'Hip' }, { key: 'left', label: 'Left ankle' }, { key: 'right', label: 'Right ankle' }
  ];
  readonly target = ANGLE_TARGET;
  readonly far = ANGLE_FAR;
  readonly closePx = POINT_CLOSE_PX;
  readonly farPx = POINT_FAR_PX;
  readonly statPx = STAT_PX;
  readonly rows: Array<{ key: 'hip' | 'left' | 'right'; label: string }> = [
    { key: 'left', label: 'Left ankle' }, { key: 'right', label: 'Right ankle' }, { key: 'hip', label: 'Hip' }
  ];
  constructor(private router: Router, private firebase: FirebaseService) {
    addIcons({ arrowBack, cloudUploadOutline });
  }

  ngOnInit() { this.loadModel(); }
  ngOnDestroy() { this.queue.forEach(p => URL.revokeObjectURL(p.url)); }

  private async loadModel() {
    [this.model, this.stats] = await Promise.all([this.firebase.getSplitModel().catch(() => null), this.firebase.getSplitStats().catch(() => null)]);
  }

  px(v: number): string { return `${Math.round(Math.abs(v))} px`; }
  // Which way detection is off, from the signed pixels: up is "too high", out is "too far out".
  vert(v: number): string { return Math.abs(v) < 1 ? 'level' : `${Math.round(Math.abs(v))} px too ${v > 0 ? 'high' : 'low'}`; }
  horiz(key: string, v: number): string {
    if (Math.abs(v) < 1) return 'centred';
    const word = key === 'hip' ? (v > 0 ? 'right' : 'left') : (v > 0 ? 'out' : 'in');
    return `${Math.round(Math.abs(v))} px too far ${word}`;
  }
  deg1(v: number): string { return `${v.toFixed(1)}°`; }
  of(e: { hits: number; count: number }): string { return `${e.hits} of ${e.count}`; }
  wrong(e: { farCount: number; count: number }): string { return `${e.farCount} of ${e.count}`; }
  conf(c: number | undefined): string { return c == null ? '–' : `${Math.round(c * 100)}%`; }

  goBack() { this.router.navigate(['/home']); }

  get current(): Photo | null { return this.queue[this.index] ?? null; }
  get remaining(): number { return Math.max(0, this.queue.length - this.index); }
  get deg(): number | null { return this.current && this.points ? splitDeg(this.points, this.current.iw, this.current.ih) : null; }
  // Learned from this many reviews; the athlete app applies the correction from three.
  get samples(): number { return this.model?.n ?? 0; }
  get moved(): boolean {
    const c = this.current;
    if (!c?.detected || !this.points) return false;
    return (['hip', 'left', 'right'] as const).some(k => this.points![k].x !== c.detected![k].x || this.points![k].y !== c.detected![k].y);
  }

  async onFiles(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    this.loadingPhotos = true;
    this.error = '';
    const fresh: Photo[] = [];
    for (const file of files) {
      try { fresh.push(await this.prepare(file)); } catch { this.skipped++; }
    }
    // Photos where detection found no body cannot teach anything: they are left out and counted.
    const usable = fresh.filter(p => p.detected);
    this.skipped += fresh.length - usable.length;
    fresh.filter(p => !p.detected).forEach(p => URL.revokeObjectURL(p.url));
    const wasEmpty = this.index >= this.queue.length;
    if (wasEmpty) { this.queue = []; this.index = 0; }
    this.queue.push(...usable);
    if (wasEmpty) this.showCurrent();
    this.loadingPhotos = false;
    if (!usable.length) this.error = 'Detection found no body in these photos. Choose photos where the whole split is visible.';
  }

  private prepare(file: File): Promise<Photo> {
    const url = URL.createObjectURL(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = async () => {
        const photo: Photo = { url, file, iw: img.naturalWidth, ih: img.naturalHeight, detected: null, conf: null, knee: null };
        const found = await this.detect(img);
        photo.detected = found?.points ?? null;
        photo.conf = found?.conf ?? null;
        photo.knee = found?.knee ?? null;
        resolve(photo);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
      img.src = url;
    });
  }

  // The same detection call as the athlete app, on an upright copy no longer than DETECT_PX.
  private async detect(img: HTMLImageElement): Promise<{ points: SplitPoints; conf: Conf | null; knee: { left: boolean; right: boolean } | null } | null> {
    if (!this.native) return null;
    try {
      const k = Math.min(1, DETECT_PX / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * k);
      canvas.height = Math.round(img.naturalHeight * k);
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
      const image = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      const r = await PoseDetect.detectSplit({ image });
      return r.found && r.hip && r.left && r.right ? { points: { hip: r.hip, left: r.left, right: r.right }, conf: r.confidence ?? null, knee: r.kneeStandsIn ?? null } : null;
    } catch {
      return null;
    }
  }

  private showCurrent() { this.points = this.current?.detected ? JSON.parse(JSON.stringify(this.current.detected)) : null; }

  trackPhoto = (_: number, p: Photo) => p.url;

  onPoints(p: SplitPoints) { this.points = p; }

  skip() { this.advance(); }

  private advance() {
    const done = this.current;
    this.index++;
    this.showCurrent();
    if (done) setTimeout(() => URL.revokeObjectURL(done.url), 500);
  }

  async save() {
    const c = this.current;
    if (!c?.detected || !this.points || this.saving) return;
    this.saving = true;
    this.error = '';
    try {
      const photoUrl = await this.firebase.uploadSplitPhoto(await this.keptCopy(c));
      const mark: SplitMark = {
        slot: 0, iw: c.iw, ih: c.ih, points: this.points, deg: splitDeg(c.detected, c.iw, c.ih),
        detected: c.detected, coach: this.points, coachDeg: splitDeg(this.points, c.iw, c.ih)
      };
      await this.firebase.learnSplit(mark, photoUrl);
      this.saved++;
      await this.loadModel();
      this.advance();
    } catch (err) {
      console.error('Split training: could not save', err);
      this.error = 'Could not save this sample. Check the connection and try again.';
    }
    this.saving = false;
  }

  // An upright JPEG no larger than KEEP_PX, so the stored photo matches the points.
  private keptCopy(c: Photo): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, KEEP_PX / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * k);
        canvas.height = Math.round(img.naturalHeight * k);
        canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(b => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.88);
      };
      img.onerror = () => reject(new Error('unreadable'));
      img.src = c.url;
    });
  }
}
