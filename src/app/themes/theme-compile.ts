import { darkTokens, lerpHex, STATUS } from './theme-kit';

// A theme is a small set of choices (ThemeConfig). compile() turns them into the CSS variables the athlete app
// reads: `colors` (the palette) and `style` (shape, buttons, background, shadows, fonts). Nothing here is specific
// to a page, so a new variable only needs the app's CSS to use it.

export interface ThemeConfig {
  accent: string; accent2: string; accent3: string;
  colorOverrides: Record<string, string>;
  bgType: 'solid' | 'gradient' | 'image';
  bgAngle: number; bgA: string; bgB: string; bgC: string;
  bgImage: string | null; bgDim: number;
  radius: number; borderWidth: number;
  btnRadius: number; btnPill: boolean; btnPadY: number; btnFont: number; btnWeight: number; btnLetter: number;
  btnCase: 'none' | 'uppercase'; btnGradient: boolean; btnGlow: number;
  shadow: number;
  fontDisplay: string; fontLabel: string; fontBody: string;
}

export const FONTS = ['Bebas Neue', 'Anton', 'Oswald', 'Teko', 'Rajdhani', 'Orbitron', 'Barlow Condensed', 'Barlow', 'Montserrat', 'Poppins', 'Inter', 'Space Grotesk', 'Playfair Display', 'DM Serif Display', 'Righteous'];
const DEFAULT_FONTS = ['Bebas Neue', 'Barlow Condensed', 'Barlow'];

export const BASE_STYLE: ThemeConfig = {
  accent: '#38bdf8', accent2: '#38bdf8', accent3: '#38bdf8', colorOverrides: {},
  bgType: 'solid', bgAngle: 160, bgA: '#04090d', bgB: '#03060a', bgC: '#03060a', bgImage: null, bgDim: 35,
  radius: 1, borderWidth: 1,
  btnRadius: 10, btnPill: false, btnPadY: 13, btnFont: 14, btnWeight: 600, btnLetter: 0.04, btnCase: 'none', btnGradient: false, btnGlow: 0,
  shadow: 0,
  fontDisplay: 'Bebas Neue', fontLabel: 'Barlow Condensed', fontBody: 'Barlow'
};

const NIGHT = '#05070a';
const tint = (c: string, t: number) => lerpHex(NIGHT, c, t);

// 1 to 3 colours in, a whole theme out: the first is the accent, the others tint the background and the buttons.
export function fromColors(colors: string[]): ThemeConfig {
  const [c1, c2, c3] = [colors[0], colors[1] ?? colors[0], colors[2] ?? colors[1] ?? colors[0]];
  const n = colors.length;
  const stops = n >= 3 ? [tint(c3, 0.24), tint(c2, 0.15), tint(c1, 0.07)] : n === 2 ? [tint(c2, 0.24), tint(c2, 0.1), tint(c1, 0.07)] : [tint(c1, 0.17), tint(c1, 0.09), tint(c1, 0.045)];
  return {
    ...BASE_STYLE, accent: c1, accent2: c2, accent3: c3,
    bgType: 'gradient', bgAngle: 165, bgA: stops[0], bgB: stops[1], bgC: stops[2],
    btnGradient: n >= 2, btnGlow: n >= 2 ? 14 : 0
  };
}

export interface Compiled { colors: Record<string, string>; style: Record<string, string>; fonts: string[]; swatch: string[]; accent: string }

export function compile(cfg: ThemeConfig, baseOnly = false): Compiled {
  const colors: Record<string, string> = { ...darkTokens(cfg.accent), ...STATUS.dark };
  if (cfg.bgType !== 'solid') colors['--hud-bg'] = cfg.bgB;
  colors['--hud-accent-2'] = cfg.accent2;
  colors['--hud-accent-3'] = cfg.accent3;
  Object.assign(colors, cfg.colorOverrides);

  const style: Record<string, string> = {
    '--hud-r': String(cfg.radius),
    '--hud-bw': `${cfg.borderWidth}px`,
    '--hud-btn-r': `${cfg.btnPill ? 999 : cfg.btnRadius}px`,
    '--hud-btn-py': `${cfg.btnPadY}px`,
    '--hud-btn-fs': `${cfg.btnFont}px`,
    '--hud-btn-fw': String(cfg.btnWeight),
    '--hud-btn-ls': `${cfg.btnLetter}em`,
    '--hud-btn-tt': cfg.btnCase,
    '--hud-shadow': cfg.shadow > 0 ? `0 ${Math.round(cfg.shadow / 3)}px ${cfg.shadow}px rgba(0, 0, 0, 0.45)` : 'none',
    '--hud-glow': cfg.btnGlow > 0 ? `0 0 ${cfg.btnGlow}px color-mix(in srgb, ${cfg.accent} 60%, transparent)` : 'none',
    '--font-display': `'${cfg.fontDisplay}', sans-serif`,
    '--font-label': `'${cfg.fontLabel}', sans-serif`,
    '--font-body': `'${cfg.fontBody}', sans-serif`
  };
  if (cfg.btnGradient) style['--hud-btn-bg'] = `linear-gradient(135deg, ${cfg.accent}, ${cfg.accent2})`;
  if (cfg.bgType === 'gradient') style['--hud-bg-image'] = `linear-gradient(${cfg.bgAngle}deg, ${[cfg.bgA, cfg.bgB, cfg.bgC].join(', ')})`;
  else if (cfg.bgType === 'image' && cfg.bgImage) {
    const d = (cfg.bgDim / 100).toFixed(2);
    style['--hud-bg-image'] = `linear-gradient(rgba(0, 0, 0, ${d}), rgba(0, 0, 0, ${d})), url("${cfg.bgImage}") center / cover no-repeat`;
  }

  // The base style is shape, buttons and fonts only: colours and backgrounds belong to a rank or a theme.
  if (baseOnly) {
    delete style['--hud-bg-image']; delete style['--hud-btn-bg'];
    return { colors: {}, style, fonts: fontList(cfg), swatch: [], accent: cfg.accent };
  }
  return { colors, style, fonts: fontList(cfg), swatch: [cfg.accent, cfg.accent2, cfg.accent3].filter((c, i, a) => a.indexOf(c) === i), accent: cfg.accent };
}

function fontList(cfg: ThemeConfig): string[] {
  return [cfg.fontDisplay, cfg.fontLabel, cfg.fontBody].filter((f, i, a) => !DEFAULT_FONTS.includes(f) && a.indexOf(f) === i);
}

// One editable control: where it lives in the form and how it reads and writes ThemeConfig.
export interface Control {
  group: 'colors' | 'background' | 'shape' | 'buttons' | 'cards' | 'text';
  key: keyof ThemeConfig;
  label: string;
  type: 'color' | 'range' | 'select' | 'toggle';
  min?: number; max?: number; step?: number; unit?: string;
  options?: string[];
  when?: (c: ThemeConfig) => boolean;
}

export const CONTROLS: Control[] = [
  { group: 'colors', key: 'accent', label: 'Main colour', type: 'color' },
  { group: 'colors', key: 'accent2', label: 'Second colour', type: 'color' },
  { group: 'colors', key: 'accent3', label: 'Third colour', type: 'color' },

  { group: 'background', key: 'bgType', label: 'Background', type: 'select', options: ['solid', 'gradient', 'image'] },
  { group: 'background', key: 'bgA', label: 'Top colour', type: 'color', when: c => c.bgType === 'gradient' },
  { group: 'background', key: 'bgB', label: 'Middle colour', type: 'color', when: c => c.bgType !== 'image' },
  { group: 'background', key: 'bgC', label: 'Bottom colour', type: 'color', when: c => c.bgType === 'gradient' },
  { group: 'background', key: 'bgAngle', label: 'Gradient angle', type: 'range', min: 0, max: 360, step: 5, unit: '°', when: c => c.bgType === 'gradient' },
  { group: 'background', key: 'bgDim', label: 'Darken photo', type: 'range', min: 0, max: 80, step: 5, unit: '%', when: c => c.bgType === 'image' },

  { group: 'shape', key: 'radius', label: 'Corner roundness', type: 'range', min: 0, max: 2.5, step: 0.05, unit: '×' },
  { group: 'shape', key: 'borderWidth', label: 'Border thickness', type: 'range', min: 0, max: 4, step: 0.5, unit: 'px' },

  { group: 'buttons', key: 'btnPill', label: 'Fully round buttons', type: 'toggle' },
  { group: 'buttons', key: 'btnRadius', label: 'Button corners', type: 'range', min: 0, max: 40, step: 1, unit: 'px', when: c => !c.btnPill },
  { group: 'buttons', key: 'btnPadY', label: 'Button height', type: 'range', min: 6, max: 24, step: 1, unit: 'px' },
  { group: 'buttons', key: 'btnFont', label: 'Button text size', type: 'range', min: 11, max: 20, step: 1, unit: 'px' },
  { group: 'buttons', key: 'btnWeight', label: 'Button text weight', type: 'range', min: 400, max: 800, step: 100 },
  { group: 'buttons', key: 'btnLetter', label: 'Letter spacing', type: 'range', min: 0, max: 0.2, step: 0.01, unit: 'em' },
  { group: 'buttons', key: 'btnCase', label: 'Button text case', type: 'select', options: ['none', 'uppercase'] },
  { group: 'buttons', key: 'btnGradient', label: 'Gradient buttons (main to second colour)', type: 'toggle' },
  { group: 'buttons', key: 'btnGlow', label: 'Button glow', type: 'range', min: 0, max: 40, step: 2, unit: 'px' },

  { group: 'cards', key: 'shadow', label: 'Card shadow', type: 'range', min: 0, max: 40, step: 2, unit: 'px' },

  { group: 'text', key: 'fontDisplay', label: 'Title font', type: 'select', options: FONTS },
  { group: 'text', key: 'fontLabel', label: 'Label font', type: 'select', options: FONTS },
  { group: 'text', key: 'fontBody', label: 'Body font', type: 'select', options: FONTS }
];

// What clicking each kind of component opens: the settings that change it, and the colours it is painted with.
export interface Inspect { title: string; classes: string; controls: Array<keyof ThemeConfig>; colors: string[] }
export const INSPECT: Record<string, Inspect> = {
  button: { title: 'Buttons', classes: '.hud-btn · .hud-btn-solid · .hud-btn-outline · .cmp', controls: ['btnPill', 'btnRadius', 'btnPadY', 'btnFont', 'btnWeight', 'btnLetter', 'btnCase', 'btnGradient', 'btnGlow', 'borderWidth'], colors: ['--hud-accent', '--hud-accent-2', '--hud-border', '--hud-text', '--hud-panel-a'] },
  card: { title: 'Cards, panels and rows', classes: '.hud-card · .hud-panel · .hud-row · .stat', controls: ['radius', 'borderWidth', 'shadow'], colors: ['--hud-panel-a', '--hud-panel-b', '--hud-border', '--hud-border-soft', '--hud-text', '--hud-text-mute'] },
  field: { title: 'Fields and inputs', classes: '.hud-input · .hud-scale · .hud-slider · .tile', controls: ['radius', 'borderWidth'], colors: ['--hud-panel-b', '--hud-border', '--hud-text', '--hud-placeholder', '--hud-accent', '--hud-accent-soft'] },
  text: { title: 'Text', classes: '--font-display · --font-label · --font-body', controls: ['fontDisplay', 'fontLabel', 'fontBody'], colors: ['--hud-text', '--hud-text-dim', '--hud-text-mute', '--hud-text-faint', '--hud-accent', '--hud-success', '--hud-danger'] },
  badge: { title: 'Badges, dots and progress', classes: '.badge · .hero-dot · .seg · .adherence-track', controls: ['radius', 'borderWidth'], colors: ['--hud-accent', '--hud-warn', '--hud-success', '--hud-danger', '--hud-border-soft'] },
  nav: { title: 'Navigation', classes: '.bottom-nav · .bn-tab', controls: ['borderWidth'], colors: ['--hud-panel-a', '--hud-border', '--hud-text-faint', '--hud-accent', '--hud-danger'] },
  chart: { title: 'Charts', classes: 'app-line-chart · .chart-card', controls: ['radius', 'borderWidth', 'shadow'], colors: ['--hud-accent', '--hud-panel-a', '--hud-border-soft', '--hud-text-mute'] },
  page: { title: 'Page background', classes: 'ion-content · --hud-bg-image', controls: ['bgType', 'bgA', 'bgB', 'bgC', 'bgAngle', 'bgDim'], colors: ['--hud-bg'] }
};
