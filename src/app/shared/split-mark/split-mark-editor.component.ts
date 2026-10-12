import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Pt, SplitPoints, splitDeg } from '../../services/split-mark.util';

type NodeKey = 'hip' | 'left' | 'right';
const LENS = 140;       // magnifier diameter, px
const LENS_ZOOM = 3;
const MAX_ZOOM = 16;

// The athlete's middle split photo with the points exactly where they left them (the points are fractions of the
// photo, drawn in its own pixel space). The coach drags a point to correct it; a magnifier shows the spot under the
// finger. Emits the points after every move.
@Component({
  selector: 'app-split-mark-editor',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="sme-head">
      <span class="sme-deg">{{ deg }}°</span>
      <span class="sme-sub" *ngIf="deg !== athleteDeg">Athlete measured {{ athleteDeg }}°</span>
      <span class="sme-sub" *ngIf="deg === athleteDeg">As measured by the athlete</span>
      <button type="button" class="sme-reset" *ngIf="moved" (click)="reset()">Reset</button>
    </div>
    <div class="sme" #box [style.aspect-ratio]="iw + ' / ' + ih" (pointerdown)="viewDown($event)" (wheel)="wheel($event)">
      <div class="layer" #layer [style.transform]="'translate(' + tx + 'px,' + ty + 'px) scale(' + z + ')'">
      <img [src]="src" alt="Middle split photo" draggable="false" />
      <svg [attr.viewBox]="'0 0 ' + iw + ' ' + ih" preserveAspectRatio="none">
        <g *ngIf="moved" class="compare" [attr.stroke-width]="stroke" [attr.stroke-dasharray]="stroke * 3 + ' ' + stroke * 2.5">
          <line [attr.x1]="athlete.hip.x * iw" [attr.y1]="athlete.hip.y * ih" [attr.x2]="athlete.left.x * iw" [attr.y2]="athlete.left.y * ih" />
          <line [attr.x1]="athlete.hip.x * iw" [attr.y1]="athlete.hip.y * ih" [attr.x2]="athlete.right.x * iw" [attr.y2]="athlete.right.y * ih" />
        </g>
        <g class="main" [attr.stroke-width]="stroke">
          <line [attr.x1]="pts.hip.x * iw" [attr.y1]="pts.hip.y * ih" [attr.x2]="pts.left.x * iw" [attr.y2]="pts.left.y * ih" />
          <line [attr.x1]="pts.hip.x * iw" [attr.y1]="pts.hip.y * ih" [attr.x2]="pts.right.x * iw" [attr.y2]="pts.right.y * ih" />
        </g>
        <g *ngFor="let k of keys" class="node" [class.on]="drag === k" (pointerdown)="down($event, k)">
          <circle class="hit" [attr.cx]="pts[k].x * iw" [attr.cy]="pts[k].y * ih" [attr.r]="stroke * 9" />
          <circle class="ring" [attr.cx]="pts[k].x * iw" [attr.cy]="pts[k].y * ih" [attr.r]="stroke * 3.6" [attr.stroke-width]="stroke * 0.8" />
          <circle class="dot" [attr.cx]="pts[k].x * iw" [attr.cy]="pts[k].y * ih" [attr.r]="stroke * 1.2" />
        </g>
      </svg>
      </div>
      <button type="button" class="fit" *ngIf="z > 1.01" (pointerdown)="$event.stopPropagation()" (click)="fit()">Fit</button>
      <span class="zhint" *ngIf="z <= 1.01">Pinch, scroll or double-tap to zoom</span>
      <div class="lens" *ngIf="lens as L" [style.width.px]="size" [style.height.px]="size" [style.left.px]="L.left" [style.top.px]="L.top"
           [style.background-image]="'url(' + src + ')'" [style.background-size]="L.bw + 'px ' + L.bh + 'px'"
           [style.background-position]="L.bx + 'px ' + L.by + 'px'">
        <span class="cross"></span>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; margin-top: 6px; }
    .sme-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
    .sme-deg { font-size: 26px; font-weight: 700; color: var(--hud-accent, #00d4ff); font-variant-numeric: tabular-nums; }
    .sme-sub { font-size: 13px; color: #8aa0b4; }
    .sme-reset { margin-left: auto; padding: 6px 12px; border-radius: 8px; border: 1px solid var(--hud-border, rgba(255,255,255,0.2));
                 background: transparent; color: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
    .sme { position: relative; width: 100%; max-width: 640px; border-radius: 10px; overflow: hidden; touch-action: none; background: #000; }
    .layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; transform-origin: 0 0; }
    .sme img, .sme svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .fit { position: absolute; right: 8px; bottom: 8px; padding: 4px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.3);
           background: rgba(0,0,0,0.6); color: #fff; font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; cursor: pointer; }
    .zhint { position: absolute; left: 8px; bottom: 8px; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,0.55); font-size: 11px; color: #cfe0ec; pointer-events: none; }
    .sme img { user-select: none; -webkit-user-drag: none; pointer-events: none; }
    .main { stroke: var(--hud-accent, #00d4ff); stroke-linecap: round; }
    .compare { stroke: #fff; opacity: 0.55; stroke-linecap: round; }
    .node { cursor: grab; }
    .node.on { cursor: grabbing; }
    .hit { fill: transparent; }
    .ring { fill: rgba(0,0,0,0.35); stroke: var(--hud-accent, #00d4ff); }
    .dot { fill: var(--hud-accent, #00d4ff); pointer-events: none; }
    .lens { position: absolute; border-radius: 50%; border: 2px solid var(--hud-accent, #00d4ff); background-repeat: no-repeat;
            box-shadow: 0 6px 20px rgba(0,0,0,0.55); pointer-events: none; }
    .cross { position: absolute; left: 50%; top: 50%; width: 18px; height: 18px; transform: translate(-50%, -50%);
             background: linear-gradient(#fff, #fff) center / 1.5px 100% no-repeat, linear-gradient(#fff, #fff) center / 100% 1.5px no-repeat;
             filter: drop-shadow(0 0 2px rgba(0,0,0,0.9)); }
  `]
})
export class SplitMarkEditorComponent implements OnChanges {
  @ViewChild('box') box!: ElementRef<HTMLDivElement>;
  @ViewChild('layer') layer!: ElementRef<HTMLDivElement>;
  @Input() src = '';
  @Input() iw = 1;
  @Input() ih = 1;
  @Input() athlete!: SplitPoints;            // where the athlete left the points
  @Output() pointsChange = new EventEmitter<SplitPoints>();

  readonly keys: NodeKey[] = ['left', 'right', 'hip'];
  readonly size = LENS;
  pts!: SplitPoints;
  drag: NodeKey | null = null;
  private pointer = -1;
  private grab: Pt = { x: 0, y: 0 };

  // View: zoom and where the photo's top-left sits in the frame. One finger on the photo pans, two pinch.
  z = 1; tx = 0; ty = 0;
  private views = new Map<number, { x: number; y: number }>();
  private tap: { x: number; y: number; t: number; moved: boolean } | null = null;
  private lastTap: { x: number; y: number; t: number } | null = null;

  ngOnChanges() { this.pts = clone(this.athlete); }

  // Constant on screen at any zoom.
  get stroke(): number { return Math.max(this.iw, this.ih) / 160 / this.z; }
  get deg(): number { return splitDeg(this.pts, this.iw, this.ih); }
  get athleteDeg(): number { return splitDeg(this.athlete, this.iw, this.ih); }
  get moved(): boolean { return this.keys.some(k => this.pts[k].x !== this.athlete[k].x || this.pts[k].y !== this.athlete[k].y); }

  // The magnifier sits in the top corner away from the point, so the finger never covers it.
  get lens() {
    if (!this.drag || !this.box) return null;
    const r = this.box.nativeElement.getBoundingClientRect(), p = this.pts[this.drag];
    const bw = r.width * this.z * LENS_ZOOM, bh = r.height * this.z * LENS_ZOOM;
    return {
      left: p.x < 0.5 ? r.width - LENS - 10 : 10, top: 10,
      bw, bh, bx: LENS / 2 - p.x * bw, by: LENS / 2 - p.y * bh
    };
  }

  reset() {
    this.pts = clone(this.athlete);
    this.pointsChange.emit(clone(this.pts));
  }

  down(e: PointerEvent, k: NodeKey) {
    e.preventDefault();
    e.stopPropagation();
    const f = this.frac(e);
    this.drag = k;
    this.pointer = e.pointerId;
    this.grab = { x: f.x - this.pts[k].x, y: f.y - this.pts[k].y };
  }

  @HostListener('window:pointermove', ['$event'])
  move(e: PointerEvent) {
    if (this.drag && e.pointerId === this.pointer) {
      const f = this.frac(e);
      this.pts = { ...this.pts, [this.drag]: { x: clamp(f.x - this.grab.x), y: clamp(f.y - this.grab.y) } };
      return;
    }
    const prev = this.views.get(e.pointerId);
    if (!prev) return;
    const cur = this.local(e);
    if (this.tap && Math.hypot(cur.x - this.tap.x, cur.y - this.tap.y) > 8) this.tap.moved = true;
    if (this.views.size === 1) {
      this.tx += cur.x - prev.x; this.ty += cur.y - prev.y; this.clampView();
    } else {
      const other = [...this.views.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(cur.x - other.x, cur.y - other.y);
      const mid0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const mid1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
      if (before > 0) this.zoomAt(mid0, after / before);
      this.tx += mid1.x - mid0.x; this.ty += mid1.y - mid0.y; this.clampView();
    }
    this.views.set(e.pointerId, cur);
  }

  @HostListener('window:pointerup', ['$event'])
  @HostListener('window:pointercancel', ['$event'])
  up(e: PointerEvent) {
    if (this.drag && e.pointerId === this.pointer) {
      this.drag = null;
      this.pointer = -1;
      this.pointsChange.emit(clone(this.pts));
      return;
    }
    if (!this.views.delete(e.pointerId)) return;
    const tap = this.tap;
    this.tap = null;
    if (e.type !== 'pointerup' || !tap || tap.moved || e.timeStamp - tap.t > 300) return;
    const last = this.lastTap;
    if (last && e.timeStamp - last.t < 350 && Math.hypot(tap.x - last.x, tap.y - last.y) < 30) {
      this.lastTap = null;
      if (this.z > 1.5) this.fit(); else this.zoomAt(tap, 4 / this.z);
    } else {
      this.lastTap = { ...tap, t: e.timeStamp };
    }
  }

  viewDown(e: PointerEvent) {
    e.preventDefault();
    const p = this.local(e);
    this.views.set(e.pointerId, p);
    this.tap = this.views.size === 1 ? { ...p, t: e.timeStamp, moved: false } : null;
  }

  wheel(e: WheelEvent) {
    e.preventDefault();
    this.zoomAt(this.local(e), Math.exp(-e.deltaY * 0.004));
  }

  fit() { this.z = 1; this.tx = 0; this.ty = 0; }

  private zoomAt(c: { x: number; y: number }, factor: number) {
    const next = Math.max(1, Math.min(MAX_ZOOM, this.z * factor));
    const k = next / this.z;
    if (k === 1) return;
    this.z = next;
    this.tx = c.x + (this.tx - c.x) * k;
    this.ty = c.y + (this.ty - c.y) * k;
    this.clampView();
  }

  // The photo always covers the frame.
  private clampView() {
    const r = this.box.nativeElement.getBoundingClientRect();
    this.tx = Math.min(0, Math.max(r.width * (1 - this.z), this.tx));
    this.ty = Math.min(0, Math.max(r.height * (1 - this.z), this.ty));
  }

  private local(e: { clientX: number; clientY: number }) {
    const r = this.box.nativeElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Position as a fraction of the photo, through the current zoom and pan.
  private frac(e: PointerEvent): Pt {
    const r = this.layer.nativeElement.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
}

function clamp(v: number) { return Math.min(1, Math.max(0, v)); }
function clone(p: SplitPoints): SplitPoints { return { hip: { ...p.hip }, left: { ...p.left }, right: { ...p.right } }; }
