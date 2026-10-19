import type { PoseLandmarker } from '@mediapipe/tasks-vision';

// Reads a proof video frame by frame: the body's 33 landmarks in each sampled frame (Google's MediaPipe pose model,
// run here in the browser), a tiny grey copy of each frame to spot cuts, fingerprints of a few frames to spot a
// video sent twice, and three small stills for the coach.

export interface Point { x: number; y: number; v: number }   // pixels in the video, and the model's visibility 0-1
export interface PoseFrame { t: number; pts: Point[] | null }  // seconds; null when no person was found

export interface VideoReading {
  duration: number;
  width: number;
  height: number;
  frames: PoseFrame[];
  // Mean change between consecutive sampled frames (0-255), one per frame after the first. A spike is a cut.
  diffs: number[];
  hashes: string[];
  thumbs: string[];
}

let landmarker: Promise<PoseLandmarker> | null = null;
// The model in video mode needs every timestamp to be later than the last one it saw, across all videos, so each
// video continues this clock rather than starting again at zero.
let clock = 0;

function base(): string {
  // The model and its runtime ship with the app (assets/), so this works the same in a browser and on the iPad.
  return new URL('assets/', document.baseURI).href;
}

export function loadLandmarker(): Promise<PoseLandmarker> {
  if (!landmarker) {
    landmarker = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const files = await FilesetResolver.forVisionTasks(base() + 'mediapipe');
      return PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: base() + 'ai/pose_landmarker_full.task', delegate: 'CPU' },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4
      });
    })();
    landmarker.catch(() => { landmarker = null; });
  }
  return landmarker;
}

function once(el: HTMLVideoElement, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { el.removeEventListener(event, ok); reject(new Error(`video ${event} timed out`)); }, ms);
    const ok = () => { clearTimeout(timer); el.removeEventListener(event, ok); resolve(); };
    el.addEventListener(event, ok);
  });
}

// A 64-bit difference hash of a frame, as hex: robust to re-encoding and small size changes, so the same footage sent
// again matches even after the phone has compressed it differently.
function dhash(ctx: CanvasRenderingContext2D, video: HTMLVideoElement): string {
  ctx.drawImage(video, 0, 0, 9, 8);
  const d = ctx.getImageData(0, 0, 9, 8).data;
  let bits = '';
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 9 + x) * 4, j = (y * 9 + x + 1) * 4;
      const a = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const b = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11;
      bits += a > b ? '1' : '0';
    }
  }
  let hex = '';
  for (let k = 0; k < 64; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { n += x & 1; x >>= 1; }
  }
  return n;
}

export async function readVideo(url: string, onProgress?: (f: number) => void): Promise<VideoReading> {
  const pose = await loadLandmarker();
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata', 60000);
    const duration = isFinite(video.duration) ? video.duration : 0;
    const width = video.videoWidth, height = video.videoHeight;
    if (!duration || !width || !height) throw new Error('The video could not be read.');

    // About 10 frames a second, never more than 360 in all (a long run is sampled more thinly).
    const fps = Math.max(2, Math.min(10, 360 / duration));
    const step = 1 / fps;
    const small = document.createElement('canvas'); small.width = 32; small.height = 18;
    const sctx = small.getContext('2d', { willReadFrequently: true })!;
    const hcan = document.createElement('canvas'); hcan.width = 9; hcan.height = 8;
    const hctx = hcan.getContext('2d', { willReadFrequently: true })!;
    const frames: PoseFrame[] = [];
    const diffs: number[] = [];
    const hashes: string[] = [];
    let prev: Uint8ClampedArray | null = null;
    let canRead = true;
    const hashAt = new Set([0.1, 0.3, 0.5, 0.7, 0.9].map(f => Math.round((f * duration) / step)));

    let i = 0;
    const start = clock;
    for (let t = 0; t < duration - 0.02; t += step, i++) {
      video.currentTime = t;
      await once(video, 'seeked', 15000);
      const ts = Math.max(clock + 1, start + Math.round(t * 1000));
      const res = pose.detectForVideo(video, ts);
      clock = ts;
      const lm = res.landmarks?.[0];
      frames.push({
        t,
        pts: lm ? lm.map(p => ({ x: p.x * width, y: p.y * height, v: p.visibility ?? 0 })) : null
      });
      if (canRead) {
        try {
          sctx.drawImage(video, 0, 0, 32, 18);
          const d = sctx.getImageData(0, 0, 32, 18).data;
          if (prev) {
            let sum = 0;
            for (let k = 0; k < d.length; k += 4) sum += Math.abs(d[k] - prev[k]) + Math.abs(d[k + 1] - prev[k + 1]) + Math.abs(d[k + 2] - prev[k + 2]);
            diffs.push(sum / (d.length / 4) / 3);
          }
          prev = new Uint8ClampedArray(d);
          if (hashAt.has(i)) hashes.push(dhash(hctx, video));
        } catch {
          canRead = false;   // the file's host does not allow reading pixels; poses still work
        }
      }
      onProgress?.(t / duration);
    }
    clock += 1000;

    // Three stills, 240 px wide, for checking the plates and the setting at a glance.
    const thumbs: string[] = [];
    if (canRead) {
      const tw = 240, th = Math.round((240 * height) / width);
      const tc = document.createElement('canvas'); tc.width = tw; tc.height = th;
      const tctx = tc.getContext('2d')!;
      for (const f of [0.04, 0.5, 0.96]) {
        video.currentTime = f * duration;
        await once(video, 'seeked', 15000);
        tctx.drawImage(video, 0, 0, tw, th);
        thumbs.push(tc.toDataURL('image/jpeg', 0.6));
      }
    }
    return { duration, width, height, frames, diffs, hashes, thumbs };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
