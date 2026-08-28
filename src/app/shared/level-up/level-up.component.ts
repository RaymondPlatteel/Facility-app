import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ChromaMotionService } from '../../services/chroma-motion.service';
import { isSRank } from '../../services/level-color.util';
import { levelColor, rankLetter, getOmniRank } from '../../services/omni.util';
import type { OmniRank, Sex } from '../../services/firebase.service';

export interface LevelUpEvent {
  // Fractional levels — the fraction IS the XP, and the bar needs it to
  // animate at all.
  fromExact: number;
  toExact: number;
  fromLvl: number;
  toLvl: number;
  fromRank: OmniRank;
  toRank: OmniRank;
  isRankUp: boolean;
  sex: Sex;
}

// Ported from Project 000 unchanged in behaviour, so a rank-up looks the
// same whichever screen the athlete is standing in front of.
//
// The one real difference is how it starts. In the athlete's app a service
// watches their own level and fires whenever it rises. A coach app has no
// "my level" to watch — it shows whoever is loaded — so this is driven
// directly: the assessments page calls play() after a save that raised the
// athlete's level, and passes that athlete's sex with it.
@Component({
  selector: 'app-level-up',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './level-up.component.html',
  styleUrl: './level-up.component.scss'
})
export class LevelUpComponent implements OnDestroy {
  event: LevelUpEvent | null = null;
  step = 0;
  rollFlash = 0;

  private displayExact = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private raf: number | null = null;

  constructor(private chroma: ChromaMotionService) {}

  ngOnDestroy() {
    this.clearTimers();
  }

  // Builds the event from a before/after pair and plays it. Returns false
  // when nothing actually rose, so the caller can just hand over two
  // numbers without deciding whether they're worth celebrating.
  playFor(fromExact: number, toExact: number, sex: Sex): boolean {
    if (!isFinite(fromExact) || !isFinite(toExact) || toExact <= fromExact) return false;
    const fromLvl = Math.floor(fromExact);
    const toLvl = Math.floor(toExact);
    const fromRank = getOmniRank(fromLvl, sex);
    const toRank = getOmniRank(toLvl, sex);
    this.play({
      fromExact, toExact, fromLvl, toLvl, fromRank, toRank,
      isRankUp: fromRank !== toRank,
      sex
    });
    return true;
  }

  get isRankUp(): boolean {
    return !!this.event?.isRankUp;
  }

  get shownLvl(): number {
    return Math.floor(this.displayExact);
  }

  get xpPct(): number {
    return (this.displayExact - Math.floor(this.displayExact)) * 100;
  }

  get isXpOnly(): boolean {
    return !!this.event && this.event.toLvl === this.event.fromLvl;
  }

  get newLetter(): string {
    return this.event ? rankLetter(this.event.toRank) : '';
  }

  get oldLetter(): string {
    return this.event ? rankLetter(this.event.fromRank) : '';
  }

  get accent(): string {
    if (!this.event) return '#ffffff';
    return isSRank(this.event.toLvl, this.event.sex)
      ? this.chroma.hex
      : levelColor(this.event.toLvl, this.event.sex);
  }

  get accentGradient(): string {
    if (!this.event) return 'none';
    return isSRank(this.event.toLvl, this.event.sex)
      ? this.chroma.gradient
      : `linear-gradient(${this.accent}, ${this.accent})`;
  }

  private play(e: LevelUpEvent) {
    this.clearTimers();
    this.event = e;
    this.step = 0;
    this.displayExact = e.fromExact;
    this.rollFlash = 0;

    const beats = e.isRankUp ? [250, 900, 1700, 2600] : (this.isXpOnly ? [150, 500, 1500] : [200, 700, 1400]);
    beats.forEach((delay, i) => {
      this.timers.push(setTimeout(() => { this.step = i + 1; }, delay));
    });

    const fillAt = e.isRankUp ? 1700 : 450;
    this.timers.push(setTimeout(() => this.runXpFill(e), fillAt));
  }

  // requestAnimationFrame rather than a timer: this drives a width, and a
  // timer that drifts off the frame boundary shows up immediately as a bar
  // that stutters.
  private runXpFill(e: LevelUpEvent) {
    const span = e.toExact - e.fromExact;
    const duration = Math.min(3200, 900 + Math.sqrt(span) * 900);
    const start = performance.now();
    let lastFloor = Math.floor(e.fromExact);

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      this.displayExact = e.fromExact + span * eased;

      const floor = Math.floor(this.displayExact);
      if (floor > lastFloor) {
        lastFloor = floor;
        this.rollFlash++;
      }

      if (t < 1) {
        this.raf = requestAnimationFrame(tick);
      } else {
        this.displayExact = e.toExact;
        this.raf = null;
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  dismiss() {
    if (this.step < 1) return;
    this.clearTimers();
    this.event = null;
    this.step = 0;
  }

  private clearTimers() {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }
}
