// S-Rank's living colour, ported from Project 000 so a rank-up on the coach
// screen looks identical to the one on the athlete's phone.
//
// Deliberately does NOT redefine levelColor/levelBgColor — this app already
// has those in omni.util, and two copies of a colour ramp is exactly how the
// two screens end up disagreeing about what level 47 looks like.

import { getOmniRank } from './omni.util';
import type { Sex } from './firebase.service';

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const mix = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return '#' + [mix(0), mix(1), mix(2)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// S-RANK (level 100) doesn't get a fixed hex like every rank below it — it
// gets a live, shifting one. ChromaMotionService owns the angle (time plus
// device tilt); everything below is the pure color math it calls each tick.
export function isSRank(level: number, sex: Sex = 'male'): boolean {
  return getOmniRank(level, sex) === 'S-RANK';
}

// The chromatic ramp: thin-film interference on metal, which is what
// "chromatic" actually means here — anodised titanium, tempered steel, oil
// on water. Deliberately NOT a hue wheel. A full-saturation HSL sweep walks
// through pure red and pure green and reads as RGB keyboard lighting; those
// colors do not appear in thin-film interference at all. The real sequence
// is straw gold -> bronze -> magenta -> violet -> steel blue -> cyan ->
// pale seafoam, and it cycles back round to gold. Every entry is held at
// high lightness and mid saturation so it reads as a sheen ON metal rather
// than as a colored light, which is the other half of what separates
// iridescence from RGB.
const CHROMA_RAMP = [
  '#e6d9a8', // straw gold
  '#d4a373', // bronze
  '#c98bc0', // magenta
  '#9a8fd8', // violet
  '#6fa5dc', // steel blue
  '#68cfd4', // cyan
  '#a9dcc0'  // pale seafoam
];

// Position on the ramp as a continuous ring, so the sequence wraps from
// seafoam back into gold with no seam.
function rampAt(pos: number): string {
  const n = CHROMA_RAMP.length;
  const p = ((pos % n) + n) % n;
  const i = Math.floor(p);
  return lerpHex(CHROMA_RAMP[i], CHROMA_RAMP[(i + 1) % n], p - i);
}

// A single point on the ramp. Used where only one color can go — a border,
// a glow, an SVG stroke.
export function chromaticHex(angleDeg: number): string {
  return rampAt((angleDeg / 360) * CHROMA_RAMP.length);
}

// The whole ramp laid across the element at once, which is the part a
// single rotating hex can never do. Real iridescence shows several bands
// simultaneously and slides them as the viewing angle changes; rotating
// `angleDeg` slides these. One full turn of the ring spans the element, so
// the first and last stop meet on the same color and the band pattern is
// continuous however it is rotated.
export function chromaticGradient(angleDeg: number): string {
  const n = CHROMA_RAMP.length;
  const start = (angleDeg / 360) * n;
  const steps = n * 2; // two samples per segment — smooth, since each is a lerp
  const stops: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const pct = (s / steps) * 100;
    stops.push(`${rampAt(start + (s / steps) * n)} ${pct.toFixed(1)}%`);
  }
  return `linear-gradient(115deg, ${stops.join(', ')})`;
}

// The same ramp as a translucent wash, for the card grounds behind all of
// the above. Two deliberate differences from chromaticGradient:
//
// 1. It's rgba, and it layers as a background-IMAGE over the dark --rbc-bg
//    background-COLOR. Backgrounds always paint behind content, so this can
//    never wash out the text sitting on the card — which a pseudo-element
//    overlay would have needed z-index juggling to avoid.
// 2. It sweeps only part of the ring across a much larger surface, so a
//    card shows two or three broad bands instead of the tight seven a badge
//    gets, and the alpha travels with the angle so the bright part reads as
//    a glare crossing the metal rather than a static tint.
export function chromaticGlare(angleDeg: number): string {
  const n = CHROMA_RAMP.length;
  const start = (angleDeg / 360) * n;
  const phase = (angleDeg / 360) * Math.PI * 2;
  const steps = 12;
  const stops: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const [r, g, b] = hexToRgb(rampAt(start + f * n * 0.55));
    const a = 0.08 + 0.19 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * f * 0.8 + phase));
    stops.push(`rgba(${r}, ${g}, ${b}, ${a.toFixed(3)}) ${(f * 100).toFixed(1)}%`);
  }
  return `linear-gradient(115deg, ${stops.join(', ')})`;
}

// ---------------------------------------------------------------------
// Whole-app theming.
//
// The HUD's own palette (--hud-accent, --hud-bg, the panels and borders)
// was a fixed cyan, so a Level 12 subject and a Level 95 one saw the same
// blue app with only their badge differing. These derive the entire palette
// from the rank color instead, so the room itself changes as they climb.
//
// Everything is mixed against a near-black neutral rather than pure black:
// pure black flattens the tint out of the dark end, and the original theme
// always had a slight lift in its panels.
// ---------------------------------------------------------------------

const THEME_BASE = '#05070a';

// S-Rank's app-wide accent is a fixed platinum, NOT a sample off the
// chromatic ramp.
//
// Feeding the moving ramp into --hud-accent meant every icon, chip and
// border in the app was one flat colour that hue-shifted in unison — the
// whole UI strobing gold, then green, then violet. Iridescence is a surface
// treatment, not a global hue: it belongs on the rank-tinted cards, which
// paint it as a gradient, while the app around them holds a stable chrome.
export const S_RANK_ACCENT = '#dbe2ec';

export interface HudTheme {
  '--hud-bg': string;
  '--hud-panel-a': string;
  '--hud-panel-b': string;
  '--hud-border': string;
  '--hud-border-soft': string;
  '--hud-text': string;
  '--hud-text-dim': string;
  '--hud-text-mute': string;
  '--hud-text-faint': string;
  '--hud-placeholder': string;
  '--hud-accent': string;
  '--hud-accent-soft': string;
}

// Builds the full HUD palette around one accent color. Taken as a color
// rather than a level so S-Rank can feed its live chromatic hex straight in
// and have the whole app drift with it.
export function hudThemeFor(accent: string): HudTheme {
  const [r, g, b] = hexToRgb(accent);
  return {
    // Dark structure: the accent hue mixed down into near-black, at the
    // same lightness steps the fixed cyan theme used.
    '--hud-bg': lerpHex(THEME_BASE, accent, 0.05),
    '--hud-panel-a': lerpHex(THEME_BASE, accent, 0.10),
    '--hud-panel-b': lerpHex(THEME_BASE, accent, 0.15),
    '--hud-border': lerpHex(THEME_BASE, accent, 0.32),
    '--hud-border-soft': lerpHex(THEME_BASE, accent, 0.17),

    // Text keeps its original lightness ladder and only takes a hue cast,
    // so contrast against the panels above stays where it was. Tinting
    // these fully to the accent would have wrecked legibility at the
    // darker ranks.
    '--hud-text': lerpHex('#ffffff', accent, 0.12),
    '--hud-text-dim': lerpHex('#9fb0bd', accent, 0.22),
    '--hud-text-mute': lerpHex('#79899a', accent, 0.18),
    '--hud-text-faint': lerpHex('#556978', accent, 0.18),
    '--hud-placeholder': lerpHex('#3b4b5a', accent, 0.15),

    '--hud-accent': accent,
    '--hud-accent-soft': `rgba(${r}, ${g}, ${b}, 0.16)`
  };
}
