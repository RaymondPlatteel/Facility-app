import { Injectable } from '@angular/core';
import { chromaticHex, chromaticGradient, chromaticGlare } from './level-color.util';

// Whether this device can feed tilt into the chromatic effect, and whether
// it has agreed to. 'prompt' means the sensor exists but iOS is holding it
// behind a permission sheet that only a real user tap can open — which is
// what the button in Settings is for.
export type MotionState = 'unsupported' | 'prompt' | 'granted' | 'denied';

const GRANT_KEY = 'chromaMotionGranted';

// Drives the S-Rank chromatic color: a slow constant drift of the thin-film
// ramp, plus an extra offset pulled from the phone's own tilt, so the bands
// visibly slide when the subject turns the device in their hand. One shared
// loop for the whole app — every S-Rank badge, bar, and card ground just
// reads off this singleton, instead of each place running its own animation
// and drifting out of sync with the others.
@Injectable({ providedIn: 'root' })
export class ChromaMotionService {
  // Read these directly wherever a level-100 color is needed. They're plain
  // fields, not Observables — the setInterval tick below is what nudges
  // Angular's change detection, so any getter that returns `chroma.hex`
  // repaints on its own with no subscription required.
  //
  // `hex` is one point on the ramp, for anywhere only a single color fits:
  // a border, a glow, an SVG stroke. `gradient` is the whole ramp at once,
  // for the surfaces that should show several bands — the level number, the
  // rank badge, the XP bars. `glare` is the translucent version that layers
  // over a card's dark ground.
  hex = '#e6d9a8';
  gradient = chromaticGradient(0);
  glare = chromaticGlare(0);

  motionState: MotionState = 'unsupported';

  private baseAngle = 0;
  // Degrees added on top of the base drift from device tilt. Stays 0 on
  // anything without an orientation sensor, or where permission was never
  // granted — the drift still runs, it just doesn't react to the hand.
  private tilt = 0;
  private attached = false;

  constructor() {
    this.init();
    // ~12fps: plenty smooth for a slow band drift, cheap enough to leave
    // running for the life of the app.
    setInterval(() => this.tick(), 80);
  }

  private tick() {
    // Slow: the bands are what carry the effect, so this only has to drift
    // them, not race a single color round a wheel.
    this.baseAngle = (this.baseAngle + 1.4) % 360;
    const a = this.baseAngle + this.tilt;
    this.hex = chromaticHex(a);
    this.gradient = chromaticGradient(a);
    this.glare = chromaticGlare(a);
  }

  private init() {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      this.motionState = 'unsupported';
      return;
    }

    // Anything that isn't iOS 13+ hands the sensor over without asking.
    if (!this.isGated()) {
      this.attach();
      this.motionState = 'granted';
      return;
    }

    this.motionState = 'prompt';
    // If they've granted it before, iOS will often honour that without
    // showing the sheet again, so it's worth one silent attempt at startup.
    // If it rejects — which it will when iOS insists on a fresh gesture —
    // the state stays 'prompt' and the Settings button is there to fix it.
    if (this.rememberedGrant()) {
      this.requestMotion().catch(() => {});
    }
  }

  private isGated(): boolean {
    const ctor = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    return typeof ctor.requestPermission === 'function';
  }

  private rememberedGrant(): boolean {
    try {
      return localStorage.getItem(GRANT_KEY) === '1';
    } catch {
      return false;
    }
  }

  // Call this from a real user tap — iOS only opens the permission sheet
  // when the request originates in a gesture, which is the whole reason
  // this can't just be done at startup.
  async requestMotion(): Promise<MotionState> {
    if (this.motionState === 'unsupported') return this.motionState;
    if (!this.isGated()) {
      this.attach();
      this.motionState = 'granted';
      return this.motionState;
    }

    const ctor = DeviceOrientationEvent as unknown as { requestPermission: () => Promise<string> };
    const state = await ctor.requestPermission();
    if (state === 'granted') {
      this.attach();
      this.motionState = 'granted';
      try { localStorage.setItem(GRANT_KEY, '1'); } catch { /* private mode — effect still works, just re-asks */ }
    } else {
      this.motionState = 'denied';
    }
    return this.motionState;
  }

  private attach() {
    // Guarded because requestMotion can legitimately be called more than
    // once (the silent startup attempt, then the Settings button), and two
    // listeners would double every tilt reading.
    if (this.attached) return;
    this.attached = true;
    window.addEventListener('deviceorientation', (e: DeviceOrientationEvent) => {
      // gamma is left/right tilt (-90..90), beta front/back. Both feed in,
      // weighted so the left/right roll dominates — that's the axis a hand
      // naturally moves when someone tilts a phone to catch the light,
      // which is exactly the gesture real iridescence rewards.
      this.tilt = (e.gamma ?? 0) * 2.2 + (e.beta ?? 0) * 0.6;
    });
  }
}
