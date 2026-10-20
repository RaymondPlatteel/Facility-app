import type { PoseLandmarker } from '@mediapipe/tasks-vision';

// Reads a proof video frame by frame: the body's 33 landmarks in each sampled frame (Google's MediaPipe pose model,
// run here in the browser), a tiny grey copy of each frame to spot cuts, fingerprints of a few frames to spot a
// video sent twice, and three small stills for the coach.

export interface Point { x: number; y: number; v: number }   // pixels in the video, and the model's visibility 0-1
// seconds; null when no person was found. `bar` is where the coloured plates are in the frame (their centre, in video pixels,
// and how many plate pixels there were): a direct measure of where the bar is, whatever the pose model makes of the hands.
export interface PoseFrame { t: number; pts: Point[] | null; bar?: { x: number; y: number; n: number } | null }

export interface VideoReading {
  duration: number;
  width: number;
  height: number;
  frames: PoseFrame[];
  // Mean change between consecutive sampled frames (0-255), one per frame after the first. A spike is a cut.
  diffs: number[];
  hashes: string[];
  thumbs: string[];
  // What the plates looked like, averaged over three frames: the share of the frame that is strongly coloured plate
  // (bumper plates are bright red, blue, yellow, green or white), in total and by colour, and how many separate
  // coloured blobs there were. Kept as features for the weight model; they are only useful once it has been taught
  // what this gym's plates weigh.
  plates: { sat: number; red: number; blue: number; yellow: number; green: number; blobs: number } | null;
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
    const bcan = document.createElement('canvas'); bcan.width = 96; bcan.height = Math.max(1, Math.round((96 * height) / width));
    const bctx = bcan.getContext('2d', { willReadFrequently: true })!;
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
          // The plates: the centre of the strongly coloured pixels (red, yellow, green, blue).
          bctx.drawImage(video, 0, 0, bcan.width, bcan.height);
          const bd = bctx.getImageData(0, 0, bcan.width, bcan.height).data;
          let bn = 0, bx = 0, by = 0;
          for (let q = 0; q < bcan.width * bcan.height; q++) {
            const r = bd[q * 4] / 255, g = bd[q * 4 + 1] / 255, b = bd[q * 4 + 2] / 255;
            const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
            if (mx < 0.3 || d / (mx || 1) < 0.55) continue;
            let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
            h = (h * 60 + 360) % 360;
            // Red, yellow and blue only: green is the grass outside a window far more often than a plate.
            if (!((h < 20 || h >= 340) || (h >= 40 && h < 70) || (h >= 190 && h < 260))) continue;
            bn++; bx += q % bcan.width; by += Math.floor(q / bcan.width);
          }
          frames[frames.length - 1].bar = bn >= 6 ? { x: (bx / bn) * (width / bcan.width), y: (by / bn) * (height / bcan.height), n: bn } : null;
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
    let plates: VideoReading['plates'] = null;
    if (canRead) {
      const pc = document.createElement('canvas'); pc.width = 160; pc.height = Math.round((160 * height) / width);
      const pctx = pc.getContext('2d', { willReadFrequently: true })!;
      const tot = { sat: 0, red: 0, blue: 0, yellow: 0, green: 0, blobs: 0 };
      let nF = 0;
      for (const f of [0.04, 0.5, 0.96]) {
        video.currentTime = f * duration;
        await once(video, 'seeked', 15000);
        pctx.drawImage(video, 0, 0, pc.width, pc.height);
        const img = pctx.getImageData(0, 0, pc.width, pc.height).data;
        const W = pc.width, H = pc.height, mask = new Uint8Array(W * H);
        let sat = 0, red = 0, blue = 0, yellow = 0, green = 0;
        for (let i = 0; i < W * H; i++) {
          const r = img[i * 4] / 255, g = img[i * 4 + 1] / 255, b = img[i * 4 + 2] / 255;
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
          if (mx < 0.3 || d / (mx || 1) < 0.55) continue;
          let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
          h = (h * 60 + 360) % 360;
          const k = h < 20 || h >= 340 ? 'red' : h >= 40 && h < 70 ? 'yellow' : h >= 90 && h < 165 ? 'green' : h >= 190 && h < 260 ? 'blue' : '';
          if (!k) continue;
          mask[i] = 1; sat++;
          if (k === 'red') red++; else if (k === 'yellow') yellow++; else if (k === 'green') green++; else blue++;
        }
        // Blobs of 12 or more connected coloured pixels.
        const seen = new Uint8Array(W * H);
        let blobs = 0;
        for (let i = 0; i < W * H; i++) {
          if (!mask[i] || seen[i]) continue;
          let n = 0; const stack = [i]; seen[i] = 1;
          while (stack.length) {
            const q = stack.pop()!; n++;
            const x = q % W, y = (q / W) | 0;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = x + dx, ny = y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              const ni = ny * W + nx;
              if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
            }
          }
          if (n >= 12) blobs++;
        }
        const area = W * H;
        tot.sat += sat / area; tot.red += red / area; tot.blue += blue / area; tot.yellow += yellow / area; tot.green += green / area; tot.blobs += blobs;
        nF++;
      }
      plates = { sat: tot.sat / nF, red: tot.red / nF, blue: tot.blue / nF, yellow: tot.yellow / nF, green: tot.green / nF, blobs: tot.blobs / nF };
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
    return { duration, width, height, frames, diffs, hashes, thumbs, plates };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}
