// The athlete app's rank palette, mirrored for the Themes page.
// Source of truth: Project-000/src/app/services/level-color.util.ts (rank shades, rank grounds, hudThemeFor, the chroma ramp)
// and Project-000/src/global.scss (the .hud-* classes). Keep them in step; the light palette below exists only here for now.

export type RankKey = 'UNRANKED' | 'D-RANK' | 'C-RANK' | 'B-RANK' | 'A-RANK' | 'S-RANK';
export type Mode = 'dark' | 'light';

export const RANKS: Array<{ key: RankKey; letter: string; light: string; dark: string; ground: string }> = [
  { key: 'UNRANKED', letter: '–', light: '#737373', dark: '#404040', ground: '#070809' },
  { key: 'D-RANK', letter: 'D', light: '#4ade80', dark: '#15803d', ground: '#030c07' },
  { key: 'C-RANK', letter: 'C', light: '#38bdf8', dark: '#0369a1', ground: '#03090c' },
  { key: 'B-RANK', letter: 'B', light: '#c084fc', dark: '#6b21a8', ground: '#08030c' },
  { key: 'A-RANK', letter: 'A', light: '#d9695f', dark: '#c1121f', ground: '#0c0304' },
  { key: 'S-RANK', letter: 'S', light: '#ffffff', dark: '#ffffff', ground: '#0a0a0a' }
];

export const S_RANK_ACCENT = '#dbe2ec';
const THEME_BASE = '#05070a';

const CHROMA_RAMP = ['#e6d9a8', '#d4a373', '#c98bc0', '#9a8fd8', '#6fa5dc', '#68cfd4', '#a9dcc0'];

function hexToRgb(h: string): [number, number, number] {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const mix = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return '#' + [mix(0), mix(1), mix(2)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function rampAt(pos: number): string {
  const n = CHROMA_RAMP.length;
  const p = ((pos % n) + n) % n;
  const i = Math.floor(p);
  return lerpHex(CHROMA_RAMP[i], CHROMA_RAMP[(i + 1) % n], p - i);
}
export function chromaticGradient(angleDeg: number): string {
  const n = CHROMA_RAMP.length, start = (angleDeg / 360) * n, steps = n * 2, stops: string[] = [];
  for (let s = 0; s <= steps; s++) stops.push(`${rampAt(start + (s / steps) * n)} ${((s / steps) * 100).toFixed(1)}%`);
  return `linear-gradient(115deg, ${stops.join(', ')})`;
}
export function chromaticGlare(angleDeg: number): string {
  const n = CHROMA_RAMP.length, start = (angleDeg / 360) * n, phase = (angleDeg / 360) * Math.PI * 2, steps = 12, stops: string[] = [];
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const [r, g, b] = hexToRgb(rampAt(start + f * n * 0.55));
    const a = 0.08 + 0.19 * (0.5 + 0.5 * Math.sin(Math.PI * 2 * f * 0.8 + phase));
    stops.push(`rgba(${r}, ${g}, ${b}, ${a.toFixed(3)}) ${(f * 100).toFixed(1)}%`);
  }
  return `linear-gradient(115deg, ${stops.join(', ')})`;
}

// Where the athlete sits inside a rank (0 = just ranked up, 100 = about to rank up) moves the accent light -> dark.
export function rankAccent(rank: RankKey, position: number): string {
  if (rank === 'S-RANK') return S_RANK_ACCENT;
  const r = RANKS.find(x => x.key === rank)!;
  return lerpHex(r.light, r.dark, position / 100);
}

export type Tokens = Record<string, string>;

// Dark: exactly hudThemeFor() from the app.
export function darkTokens(accent: string): Tokens {
  const [r, g, b] = hexToRgb(accent);
  return {
    '--hud-bg': lerpHex(THEME_BASE, accent, 0.05),
    '--hud-panel-a': lerpHex(THEME_BASE, accent, 0.10),
    '--hud-panel-b': lerpHex(THEME_BASE, accent, 0.15),
    '--hud-border': lerpHex(THEME_BASE, accent, 0.32),
    '--hud-border-soft': lerpHex(THEME_BASE, accent, 0.17),
    '--hud-text': lerpHex('#ffffff', accent, 0.12),
    '--hud-text-dim': lerpHex('#9fb0bd', accent, 0.22),
    '--hud-text-mute': lerpHex('#79899a', accent, 0.18),
    '--hud-text-faint': lerpHex('#556978', accent, 0.18),
    '--hud-placeholder': lerpHex('#3b4b5a', accent, 0.15),
    '--hud-accent': accent,
    '--hud-accent-soft': `rgba(${r}, ${g}, ${b}, 0.16)`,
    '--hud-on-accent': lerpHex(THEME_BASE, accent, 0.05)
  };
}

// Light: a DRAFT — the app has no light mode yet. Same structure, mirrored: tinted near-white surfaces, dark text,
// and an accent deepened enough to read on white.
export function lightTokens(accent: string, rank: RankKey): Tokens {
  const deep = rank === 'S-RANK' ? '#3d4757' : rank === 'UNRANKED' ? '#525252' : lerpHex(accent, '#000000', 0.32);
  const [r, g, b] = hexToRgb(deep);
  return {
    '--hud-bg': lerpHex('#f7f9fb', deep, 0.04),
    '--hud-panel-a': lerpHex('#ffffff', deep, 0.02),
    '--hud-panel-b': lerpHex('#f1f4f7', deep, 0.05),
    '--hud-border': lerpHex('#cfd8e1', deep, 0.28),
    '--hud-border-soft': lerpHex('#e3e9ef', deep, 0.14),
    '--hud-text': lerpHex('#0b1520', deep, 0.12),
    '--hud-text-dim': lerpHex('#3f5163', deep, 0.15),
    '--hud-text-mute': lerpHex('#64768a', deep, 0.12),
    '--hud-text-faint': lerpHex('#8ea0b2', deep, 0.12),
    '--hud-placeholder': lerpHex('#aab8c6', deep, 0.1),
    '--hud-accent': deep,
    '--hud-accent-soft': `rgba(${r}, ${g}, ${b}, 0.12)`,
    '--hud-on-accent': '#ffffff'
  };
}

// Status colours are shared by every rank; light mode gets deeper versions.
export const STATUS: Record<Mode, Tokens> = {
  dark: { '--hud-success': '#2dd36f', '--hud-danger': '#ff5a6a', '--hud-warn': '#f5b942' },
  light: { '--hud-success': '#168a45', '--hud-danger': '#d6293b', '--hud-warn': '#b9780a' }
};

export const TOKEN_NOTES: Array<{ name: string; use: string }> = [
  { name: '--hud-bg', use: 'Page background' },
  { name: '--hud-panel-a', use: 'Flat panels, nav bar, cards (start)' },
  { name: '--hud-panel-b', use: 'Inputs, rows, tiles, cards (end)' },
  { name: '--hud-border', use: 'Borders and dividers' },
  { name: '--hud-border-soft', use: 'Quiet dividers, empty bar tracks' },
  { name: '--hud-text', use: 'Primary text' },
  { name: '--hud-text-dim', use: 'Labels, secondary text' },
  { name: '--hud-text-mute', use: 'Helper text, meta lines' },
  { name: '--hud-text-faint', use: 'Inactive icons, hints' },
  { name: '--hud-placeholder', use: 'Placeholder text' },
  { name: '--hud-accent', use: 'The rank colour: active states, fills, links' },
  { name: '--hud-accent-soft', use: 'Selected backgrounds (accent at 16%)' },
  { name: '--hud-on-accent', use: 'Text on a solid accent fill (NEW token — the app uses --hud-bg today)' },
  { name: '--hud-success', use: 'Saved, done, positive change' },
  { name: '--hud-danger', use: 'Errors, delete' },
  { name: '--hud-warn', use: 'Warnings, PR gold' }
];

// How far each page strays from the shared kit, measured from the athlete app's component SCSS (snapshot of Oct 2026).
export const AUDIT = {
  files: 37, tokenUses: 1283, hardcodedColours: 173, sRankMixinUses: 192, buttonLikeClasses: 85,
  worst: [
    { page: 'World (home)', hardcoded: 63 }, { page: 'Schedule', hardcoded: 26 }, { page: 'Membership', hardcoded: 17 },
    { page: 'Settings', hardcoded: 14 }, { page: 'Workout session', hardcoded: 14 }
  ]
};
