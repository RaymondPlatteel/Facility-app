import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  cloudUploadOutline,
  closeOutline,
  flashOutline,
  timerOutline,
  alertCircleOutline
} from 'ionicons/icons';
import {
  parseFitActivity,
  parseGpxActivity,
  formatClock,
  ParsedActivity,
  MetricSeries,
  BestWindow
} from '../services/fit.util';

// SVG-ready view of one metric chart.
interface ChartView {
  label: string;
  unit: string;
  color: string;
  path: string;
  area: string;
  avg: string;
  min: string;
  max: string;
  yMaxLabel: string;
  yMinLabel: string;
  windowX: { x: number; w: number } | null;
}

interface AnalyzedActivity {
  fileName: string;
  error?: string;
  durationLabel?: string;
  totalKm?: string;
  best2min?: BestWindow | null;
  bestRange?: string;
  best30min?: BestWindow | null;
  best30Range?: string;
  charts?: ChartView[];
}

const CHART_W = 600;
const CHART_H = 150;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 22;

@Component({
  selector: 'app-fit-analyzer',
  templateUrl: './fit-analyzer.page.html',
  styleUrls: ['./fit-analyzer.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule]
})
export class FitAnalyzerPage {
  activities: AnalyzedActivity[] = [];
  dragActive = false;
  parsing = false;

  constructor(private router: Router) {
    addIcons({ arrowBack, cloudUploadOutline, closeOutline, flashOutline, timerOutline, alertCircleOutline });
  }

  goBack() {
    this.router.navigateByUrl('/home');
  }

  onDragOver(ev: DragEvent) {
    ev.preventDefault();
    this.dragActive = true;
  }

  onDragLeave(ev: DragEvent) {
    ev.preventDefault();
    this.dragActive = false;
  }

  onDrop(ev: DragEvent) {
    ev.preventDefault();
    this.dragActive = false;
    if (ev.dataTransfer?.files?.length) this.handleFiles(ev.dataTransfer.files);
  }

  onFileInput(ev: Event) {
    const input = ev.target as HTMLInputElement;
    if (input.files?.length) this.handleFiles(input.files);
    input.value = '';
  }

  private async handleFiles(files: FileList) {
    const supported = Array.from(files).filter(f => /\.(fit|gpx)$/i.test(f.name));
    if (!supported.length) return;
    this.parsing = true;
    for (const file of supported) {
      try {
        const isGpx = /\.gpx$/i.test(file.name);
        const parsed = isGpx
          ? parseGpxActivity(await file.text(), file.name)
          : parseFitActivity(await file.arrayBuffer(), file.name);
        this.activities.unshift(this.analyze(parsed));
      } catch (err) {
        console.error('Activity parse failed', file.name, err);
        this.activities.unshift({
          fileName: file.name,
          error: err instanceof Error ? err.message : 'Could not read this file'
        });
      }
    }
    this.parsing = false;
  }

  removeActivity(index: number) {
    this.activities.splice(index, 1);
  }

  private analyze(parsed: ParsedActivity): AnalyzedActivity {
    const charts = parsed.metrics.map(m => this.buildChart(m, parsed.durationSec, parsed.best2min));
    const best = parsed.best2min;
    const best30 = parsed.best30min;
    const range = (w: BestWindow) => `${formatClock(w.startSec)}–${formatClock(w.endSec)}`;
    return {
      fileName: parsed.fileName,
      durationLabel: formatClock(parsed.durationSec),
      totalKm: parsed.totalDistanceKm.toFixed(2),
      best2min: best,
      bestRange: best && !best.full
        ? range(best)
        : (best ? `0:00–${formatClock(best.endSec)}` : ''),
      best30min: best30,
      best30Range: best30 ? range(best30) : '',
      charts
    };
  }

  private fmtVal(v: number, unit: string): string {
    if (unit === 'km/h' || unit === 'm') return v.toFixed(1);
    return Math.round(v).toString();
  }

  private buildChart(metric: MetricSeries, durationSec: number, best: BestWindow | null): ChartView {
    const pts = this.downsample(metric.points, 300);
    const xMax = durationSec || 1;
    let yMin = metric.min, yMax = metric.max;
    if (yMin === yMax) { yMin -= 1; yMax += 1; }
    const pad = (yMax - yMin) * 0.1;
    const yLo = yMin - pad, yHi = yMax + pad;

    const X = (t: number) => PAD_L + ((t) / xMax) * (CHART_W - PAD_L - PAD_R);
    const Y = (v: number) => PAD_T + (1 - (v - yLo) / (yHi - yLo)) * (CHART_H - PAD_T - PAD_B);

    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(' ');
    const baseY = (CHART_H - PAD_B).toFixed(1);
    const area = pts.length
      ? `${path} L${X(pts[pts.length - 1].t).toFixed(1)},${baseY} L${X(pts[0].t).toFixed(1)},${baseY} Z`
      : '';

    let windowX: { x: number; w: number } | null = null;
    if (best && !best.full) {
      const x1 = X(best.startSec);
      const x2 = X(best.endSec);
      windowX = { x: x1, w: Math.max(2, x2 - x1) };
    }

    return {
      label: metric.label,
      unit: metric.unit,
      color: metric.color,
      path,
      area,
      avg: this.fmtVal(metric.avg, metric.unit),
      min: this.fmtVal(metric.min, metric.unit),
      max: this.fmtVal(metric.max, metric.unit),
      yMaxLabel: this.fmtVal(metric.max, metric.unit),
      yMinLabel: this.fmtVal(metric.min, metric.unit),
      windowX
    };
  }

  // Bucket-average down to ~target points so large activities stay light in SVG.
  private downsample(points: { t: number; v: number }[], target: number): { t: number; v: number }[] {
    if (points.length <= target) return points;
    const bucket = points.length / target;
    const out: { t: number; v: number }[] = [];
    for (let i = 0; i < target; i++) {
      const s = Math.floor(i * bucket);
      const e = Math.floor((i + 1) * bucket);
      let t = 0, v = 0, n = 0;
      for (let j = s; j < e && j < points.length; j++) { t += points[j].t; v += points[j].v; n++; }
      if (n) out.push({ t: t / n, v: v / n });
    }
    return out;
  }
}
