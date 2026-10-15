import { Component, HostBinding, Input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import type { OmniRank } from '../../services/firebase.service';
import { ChromaMotionService } from '../../services/chroma-motion.service';

const NUMERALS = ['I', 'II', 'III', 'IV'];

// How strong each rank's glow is, as a percentage of its colour. The higher ranks glow more.
const GLOW: Record<string, number> = { D: 40, C: 45, B: 50, A: 55, S: 42 };

// Each badge's markup, fetched once. The files are our own (assets/ranks/, built by Project 000's scripts/rank-badges.mjs).
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function load(url: string): Promise<string> {
  let p = pending.get(url);
  if (!p) {
    p = fetch(url).then(r => r.text()).then(t => {
      // Drop the default colour and fixed size, so the badge takes the colour of its parent and the width it is given.
      const svg = t.replace(/ (width|height)="[^"]*"/g, '').replace(/ style="color:[^"]*"/, '');
      cache.set(url, svg);
      return svg;
    });
    pending.set(url, p);
  }
  return p;
}

// The rank emblem: one SVG per rank and tier in assets/ranks/, the same artwork as Project 000.
// D, C, B and A carry their tier as a small roman numeral (I to IV); S and Unranked have none.
// The artwork is drawn in `currentColor`: set `color` on the badge or any parent to the athlete's level colour.
// S-Rank is the app's chrome, an animated gradient, so it is the dark ground with the live chrome showing through a
// stencil of the badge, and ignores `color`. The parent sets the width; the height follows the artwork.
@Component({
  selector: 'app-rank-badge',
  standalone: true,
  template: `
    @if (isS) {
      <span class="art chrome" role="img" [attr.aria-label]="alt">
        <img src="assets/ranks/rank-s-ground.svg" alt="" draggable="false">
        <span class="fill" [style.background]="chroma.gradient"></span>
      </span>
    } @else {
      <span class="art" role="img" [attr.aria-label]="alt" [innerHTML]="html"></span>
    }`,
  styles: [`
    /* The glow is a drop-shadow on the badge, sized to its width, so no clipping box inside the badge can cut it off. */
    :host { display: inline-block; line-height: 0; container-type: inline-size; }
    .art { display: block; width: 100%; pointer-events: none; user-select: none;
      filter: drop-shadow(0 0 3cqw color-mix(in srgb, currentColor var(--rb-glow, 0%), transparent)); }
    .art ::ng-deep svg { display: block; width: 100%; height: auto; }
    /* S-Rank's glow sits on the static ground, in a fixed silver, and never on the moving chrome: a filter over a
       fill that changes every frame is redrawn every frame. */
    .chrome { position: relative; filter: none; }
    .chrome img { display: block; width: 100%; height: auto; filter: drop-shadow(0 0 3cqw rgba(205, 216, 235, .42)); }
    .chrome .fill {
      position: absolute; inset: 0;
      -webkit-mask: url(/assets/ranks/rank-s-mask.svg) center / 100% 100% no-repeat;
      mask: url(/assets/ranks/rank-s-mask.svg) center / 100% 100% no-repeat;
    }
  `]
})
export class RankBadgeComponent {
  @Input() rank: OmniRank | null | undefined = null;
  // 'I' to 'IV' (from tierNumeral); empty for a rank without tiers.
  @Input() numeral: string | null | undefined = '';

  constructor(private sanitizer: DomSanitizer, public chroma: ChromaMotionService) {}

  @HostBinding('style.--rb-glow') get glow(): string {
    const r = this.rank;
    return `${r && r !== 'UNRANKED' ? GLOW[r[0]] ?? 0 : 0}%`;
  }

  get isS(): boolean { return this.rank === 'S-RANK'; }

  private get tier(): number {
    const r = this.rank;
    return r && r !== 'UNRANKED' && r !== 'S-RANK' ? NUMERALS.indexOf(this.numeral ?? '') + 1 : 0;
  }

  private get url(): string {
    const r = this.rank;
    const letter = !r || r === 'UNRANKED' ? 'unranked' : r[0].toLowerCase();
    // A tiered rank asked for without a tier shows its lowest.
    const tier = letter === 'unranked' || letter === 's' ? 0 : this.tier || 1;
    return `assets/ranks/rank-${letter}${tier ? '-' + tier : ''}.svg`;
  }

  get alt(): string {
    const r = this.rank;
    if (!r || r === 'UNRANKED') return 'Unranked';
    return `${r[0]}-Rank${this.tier ? ' ' + NUMERALS[this.tier - 1] : ''}`;
  }

  private shownUrl = '';
  private shown: SafeHtml = '';

  // Cached markup is used at once; otherwise the badge appears when its file arrives.
  get html(): SafeHtml {
    const url = this.url;
    if (url !== this.shownUrl) {
      const hit = cache.get(url);
      if (hit !== undefined) {
        this.shownUrl = url;
        this.shown = this.sanitizer.bypassSecurityTrustHtml(hit);
      } else {
        load(url).catch(() => '');
      }
    }
    return this.shown;
  }
}
