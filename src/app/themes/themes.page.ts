import { Component, ElementRef, HostListener, OnDestroy, OnInit, QueryList, ViewChildren } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { globeOutline, barbellOutline, personCircleOutline, trophy, chevronForward, copyOutline, checkmark, addOutline, trashOutline, lockClosedOutline, closeOutline } from 'ionicons/icons';
import { AUDIT, RANKS, RankKey, STATUS, TOKEN_NOTES, Tokens, chromaticGlare, chromaticGradient, darkTokens, lerpHex, rankAccent } from './theme-kit';
import { BASE_STYLE, CONTROLS, Compiled, Control, INSPECT, Inspect, ThemeConfig, compile, fromColors } from './theme-compile';
import { FirebaseService, ThemeDoc } from '../services/firebase.service';
import { ThemeService } from '../services/theme.service';
import { SafeUrlPipe } from './safe-url.pipe';

const PREVIEW_NAME = 'Raymond Platteel';
const BASE_ID = '__base';

interface Screen { id: string; label: string; path: string }

// Make a theme, see it on the real screens of the athlete app (as Raymond), and publish it. A theme is a few
// choices (colours, background, shape, buttons, text) that compile to CSS variables; the app reads them from the
// database, so a new theme needs no app update.
@Component({
  selector: 'app-themes',
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule, SafeUrlPipe],
  templateUrl: './themes.page.html',
  styleUrls: ['./themes.page.scss']
})
export class ThemesPage implements OnInit, OnDestroy {
  // ---- the editor ----
  saved: ThemeDoc[] = [];
  base: ThemeDoc | null = null;
  rankDocs: ThemeDoc[] = [];
  editing: ThemeDoc | null = null;
  cfg: ThemeConfig = { ...BASE_STYLE };
  quick: string[] = ['#38bdf8'];
  out: Compiled = compile(BASE_STYLE);
  busy = false;
  message = '';
  unlockChoices = ['NONE', 'D-RANK', 'C-RANK', 'B-RANK', 'A-RANK', 'S-RANK'];
  groups: Array<{ id: Control['group']; title: string; hint: string }> = [
    { id: 'colors', title: 'Colours', hint: 'The main colour drives the whole palette.' },
    { id: 'background', title: 'Background', hint: 'Behind every page.' },
    { id: 'shape', title: 'Shape', hint: 'Corners and borders across the app.' },
    { id: 'buttons', title: 'Buttons', hint: 'The shared buttons (Save workout, Continue).' },
    { id: 'cards', title: 'Cards', hint: '' },
    { id: 'text', title: 'Text', hint: '' }
  ];

  // ---- click a component in the reference to edit it ----
  inspecting: string | null = null;
  inspectInfo: Inspect | null = null;
  inspectCtl: Control[] = [];
  inspectColors: Array<{ name: string; value: string; use: string }> = [];
  trackKey = (_: number, c: Control) => c.key;
  trackName = (_: number, r: { name: string }) => r.name;
  trackIndex = (i: number) => i;

  inspect(kind: string, force = false) {
    if (this.inspecting === kind && !force) { this.inspecting = null; this.inspectInfo = null; return; }
    this.inspecting = kind;
    this.inspectInfo = INSPECT[kind] ?? null;
    this.refresh();
  }
  needTheme() { this.message = 'Open or create a theme first, then click anything to change it.'; window.scrollTo?.({ top: 0 }); }

  // ---- the real app, in frames ----
  screens: Screen[] = [
    { id: 'world', label: 'World', path: '/home' }, { id: 'training', label: 'Training', path: '/training' },
    { id: 'profile', label: 'Profile', path: '/assessment' }, { id: 'settings', label: 'Settings', path: '/settings' },
    { id: 'leaders', label: 'Leaderboard', path: '/leaderboard' }
  ];
  on = new Set<string>(['world', 'training', 'profile']);
  previewBase = 'http://localhost:4200';
  @ViewChildren('frame') frames!: QueryList<ElementRef<HTMLIFrameElement>>;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- component reference (colours only) ----
  ranks = RANKS;
  rank: RankKey = 'C-RANK';
  position = 40;
  audit = AUDIT;
  notes = TOKEN_NOTES;
  copied = '';
  scale = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  scaleOn = 7;
  private angle = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  grad = chromaticGradient(0);
  glare = chromaticGlare(0);

  constructor(private firebase: FirebaseService, public coachTheme: ThemeService) {
    addIcons({ globeOutline, barbellOutline, personCircleOutline, trophy, chevronForward, copyOutline, checkmark, addOutline, trashOutline, lockClosedOutline, closeOutline });
  }

  async ngOnInit() {
    try { this.previewBase = localStorage.getItem('fa.previewBase') || this.previewBase; } catch { /* storage unavailable */ }
    this.timer = setInterval(() => {
      if (!this.isS) return;
      this.angle = (this.angle + 1.5) % 360;
      this.grad = chromaticGradient(this.angle);
      this.glare = chromaticGlare(this.angle);
    }, 80);
    this.refresh();
    await this.loadSaved();
  }
  ngOnDestroy() { if (this.timer) clearInterval(this.timer); if (this.pushTimer) clearTimeout(this.pushTimer); }

  private async loadSaved() {
    const all = await this.firebase.getThemes().catch(() => []);
    this.base = all.find(t => t.kind === 'base') ?? null;
    this.rankDocs = all.filter(t => t.kind === 'rank');
    this.saved = all.filter(t => !t.kind);
  }

  get isBase(): boolean { return this.editing?.kind === 'base'; }
  get isRank(): boolean { return this.editing?.kind === 'rank'; }
  rankEdited(key: string): boolean { return this.rankDocs.some(d => d.rank === key); }
  rankSwatch(key: RankKey): string { const d = this.rankDocs.find(x => x.rank === key); return d?.accent ?? (key === 'S-RANK' ? '#dbe2ec' : this.shade(key, 'mid')); }

  // ---- ready-made starting points ----
  colorPresets: Array<{ name: string; colors: string[] }> = [
    { name: 'Sunset', colors: ['#ff7a1a', '#ff2d6f', '#7a1fff'] }, { name: 'Deep Ocean', colors: ['#38bdf8', '#0ea5a5', '#1e3a8a'] },
    { name: 'Fire Red', colors: ['#ff3b30', '#ff9500'] }, { name: 'Forest', colors: ['#4ade80', '#166534', '#a3e635'] },
    { name: 'Neon', colors: ['#22d3ee', '#e879f9', '#facc15'] }, { name: 'Gold', colors: ['#f5b942', '#b45309'] },
    { name: 'Candy', colors: ['#f472b6', '#a78bfa', '#60a5fa'] }, { name: 'Mono', colors: ['#e5e5e5'] }
  ];
  shapePresets: Array<{ name: string; set: Partial<ThemeConfig> }> = [
    { name: 'Sharp', set: { radius: 0.25, btnRadius: 3, btnPill: false } },
    { name: 'Soft', set: { radius: 1.3, btnRadius: 14, btnPill: false } },
    { name: 'Round', set: { radius: 1.8, btnPill: true } }
  ];
  fontPresets: Array<{ name: string; d: string; l: string; b: string }> = [
    { name: 'Sports', d: 'Bebas Neue', l: 'Barlow Condensed', b: 'Barlow' }, { name: 'Bold', d: 'Anton', l: 'Oswald', b: 'Inter' },
    { name: 'Modern', d: 'Montserrat', l: 'Montserrat', b: 'Inter' }, { name: 'Elegant', d: 'Playfair Display', l: 'Montserrat', b: 'Inter' },
    { name: 'Tech', d: 'Orbitron', l: 'Rajdhani', b: 'Inter' }
  ];
  applyPreset(colors: string[]) { this.quick = [...colors]; this.rebuild(); }
  applyShape(set: Partial<ThemeConfig>) { Object.assign(this.cfg, set); this.touch(); }
  applyFonts(f: { d: string; l: string; b: string }) { Object.assign(this.cfg, { fontDisplay: f.d, fontLabel: f.l, fontBody: f.b }); this.touch(); }
  sameShape(set: Partial<ThemeConfig>): boolean { return Object.entries(set).every(([k, v]) => (this.cfg as any)[k] === v); }
  sameFonts(f: { d: string; l: string; b: string }): boolean { return this.cfg.fontDisplay === f.d && this.cfg.fontLabel === f.l && this.cfg.fontBody === f.b; }

  // ---- opening, building, tweaking ----
  newTheme() {
    this.quick = ['#38bdf8'];
    this.cfg = fromColors(this.quick);
    this.editing = { name: 'New theme', accent: this.cfg.accent, unlockRank: 'NONE', mode: 'dark', published: false };
    this.touch();
  }

  edit(t: ThemeDoc) {
    this.cfg = { ...BASE_STYLE, ...(t.config ?? fromColors([t.accent])) };
    this.quick = (t.swatch?.length ? t.swatch : [t.accent]).slice(0, 3);
    this.editing = { ...t };
    this.touch();
  }

  openBase() {
    this.cfg = { ...BASE_STYLE, ...(this.base?.config ?? {}) };
    this.editing = { id: BASE_ID, kind: 'base', name: 'Base style', accent: BASE_STYLE.accent, unlockRank: 'NONE', mode: 'dark', published: true };
    this.touch();
  }

  newFromPreset(p: { name: string; colors: string[] }) {
    this.quick = [...p.colors];
    this.cfg = fromColors(this.quick);
    this.editing = { name: p.name, accent: this.cfg.accent, unlockRank: 'NONE', mode: 'dark', published: false };
    this.touch();
  }

  openRank(key: RankKey) {
    const d = this.rankDocs.find(x => x.rank === key);
    const accent = key === 'S-RANK' ? '#dbe2ec' : this.shade(key, 'mid');
    this.cfg = { ...BASE_STYLE, ...(d?.config ?? { accent, accent2: accent, accent3: accent }) };
    this.quick = [this.cfg.accent];
    this.editing = { id: `rank-${key}`, kind: 'rank', rank: key, name: d?.name ?? key.replace('-RANK', '-Rank'), accent: this.cfg.accent, unlockRank: 'NONE', mode: 'dark', published: true };
    this.message = '';
    this.touch();
  }

  async resetRank() {
    if (!this.isRank || !this.editing?.id || this.busy || !confirm('Put this rank colour back to the app default?')) return;
    this.busy = true;
    try { await this.firebase.deleteTheme(this.editing.id); await this.loadSaved(); this.close(); } catch { this.message = 'Could not reset.'; }
    this.busy = false;
  }



  close() { this.editing = null; this.message = ''; this.touch(); }

  // Changing the quick colours rebuilds the whole theme from them; tweak after.
  setQuick(i: number, v: string) { this.quick = this.quick.map((c, j) => (j === i ? v : c)); this.rebuild(); }
  addQuick() { if (this.quick.length < 3) { this.quick = [...this.quick, this.quick.length === 1 ? '#ff7a1a' : '#a855f7']; this.rebuild(); } }
  removeQuick() { if (this.quick.length > 1) { this.quick = this.quick.slice(0, -1); this.rebuild(); } }
  private rebuild() {
    const keep = { ...this.cfg };
    this.cfg = fromColors(this.quick);
    // shape, button and text choices survive a recolour
    Object.assign(this.cfg, { radius: keep.radius, borderWidth: keep.borderWidth, btnRadius: keep.btnRadius, btnPill: keep.btnPill, btnPadY: keep.btnPadY, btnFont: keep.btnFont, btnWeight: keep.btnWeight, btnLetter: keep.btnLetter, btnCase: keep.btnCase, shadow: keep.shadow, fontDisplay: keep.fontDisplay, fontLabel: keep.fontLabel, fontBody: keep.fontBody });
    if (this.editing) this.editing.accent = this.cfg.accent;
    this.touch();
  }

  // Lists the template loops over are rebuilt only when something changes (a fresh array every pass breaks change detection).
  ctl: Record<string, Control[]> = {};
  paletteRows: Array<{ name: string; use: string; value: string }> = [];
  shown: Screen[] = [];
  private refresh() {
    for (const g of this.groups) this.ctl[g.id] = CONTROLS.filter(c => c.group === g.id && (!c.when || c.when(this.cfg)));
    const t = this.out.colors;
    this.paletteRows = TOKEN_NOTES.map(n => ({ ...n, value: t[n.name] })).filter(r => /^#[0-9a-f]{6}$/i.test(r.value ?? ''));
    this.shown = this.screens.filter(s => this.on.has(s.id));
    const ins = this.inspectInfo;
    this.inspectCtl = ins ? CONTROLS.filter(c => ins.controls.includes(c.key) && (!c.when || c.when(this.cfg))) : [];
    this.inspectColors = ins && !this.isBase ? ins.colors.map(n => ({ name: n, value: t[n], use: TOKEN_NOTES.find(x => x.name === n)?.use ?? '' })).filter(r => /^#[0-9a-f]{6}$/i.test(r.value ?? '')) : [];
  }
  val(c: Control): any { return this.cfg[c.key]; }
  set(c: Control, v: any) {
    const next: any = c.type === 'range' ? Number(v) : v;
    (this.cfg as any)[c.key] = next;
    if (c.key === 'accent' && this.editing) this.editing.accent = next;
    if (c.key === 'accent') this.quick = [next, ...this.quick.slice(1)];
    this.touch();
  }
  show(c: Control): string { const v = this.val(c); return c.type === 'range' ? `${v}${c.unit ?? ''}` : String(v); }

  isOverridden(name: string): boolean { return !!this.cfg.colorOverrides[name]; }
  setColor(name: string, v: string) { this.cfg.colorOverrides = { ...this.cfg.colorOverrides, [name]: v }; this.touch(); }
  resetColor(name: string) { const { [name]: _x, ...rest } = this.cfg.colorOverrides; this.cfg.colorOverrides = rest; this.touch(); }

  pickImage(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, 1000 / img.width, 1900 / img.height);
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
      this.cfg.bgImage = cv.toDataURL('image/jpeg', 0.8);
      this.cfg.bgType = 'image';
      URL.revokeObjectURL(img.src);
      this.touch();
    };
    img.src = URL.createObjectURL(file);
  }

  // ---- saving ----
  async save() {
    if (!this.editing || this.busy) return;
    if (!this.editing.name.trim()) { this.message = 'Give the theme a name.'; return; }
    this.busy = true;
    try {
      const c = compile(this.cfg, this.isBase);
      const doc: ThemeDoc = {
        ...this.editing, published: this.isRank ? true : this.editing.published, name: this.editing.name.trim(), accent: this.cfg.accent, config: this.cfg,
        colors: c.colors, style: c.style, fonts: c.fonts, swatch: c.swatch,
        order: this.editing.order ?? this.saved.length
      };
      const id = await this.firebase.saveTheme(doc);
      this.editing = { ...doc, id };
      await this.loadSaved();
      this.message = this.isRank ? 'Saved. This rank colour is live in the app.' : this.isBase ? 'Base style saved. It is live under every theme.' : doc.published ? 'Saved and live in the app.' : 'Saved as a draft. Turn on Published to put it in the app.';
    } catch { this.message = 'Could not save.'; }
    this.busy = false;
  }

  async remove() {
    if (!this.editing?.id || this.isBase || this.isRank || this.busy || !confirm(`Delete the theme "${this.editing.name}"? Athletes using it go back to automatic.`)) return;
    this.busy = true;
    try { await this.firebase.deleteTheme(this.editing.id); this.close(); await this.loadSaved(); } catch { this.message = 'Could not delete.'; }
    this.busy = false;
  }

  useInCoachApp() {
    this.coachTheme.apply(this.out.colors);
    this.message = 'The coach app now uses this theme.';
  }
  resetCoachApp() { this.coachTheme.reset(); this.message = 'The coach app is back to its default look.'; }

  // ---- the frames ----
  src(s: Screen): string { return `${this.previewBase.replace(/\/$/, '')}${s.path}?preview=${encodeURIComponent(PREVIEW_NAME)}`; }
  toggleScreen(id: string) { this.on.has(id) ? this.on.delete(id) : this.on.add(id); this.on = new Set(this.on); this.refresh(); }
  setBase(v: string) { this.previewBase = v; try { localStorage.setItem('fa.previewBase', v); } catch { /* storage unavailable */ } }

  private touch() {
    this.out = compile(this.cfg, this.isBase);
    this.loadFonts();
    this.refresh();
    this.schedulePush();
  }
  private loadFonts() {
    for (const f of this.out.fonts) {
      if (document.getElementById('font-' + f)) continue;
      const l = document.createElement('link');
      l.id = 'font-' + f; l.rel = 'stylesheet';
      l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@300;400;500;600;700&display=swap`;
      document.head.appendChild(l);
    }
  }
  // A frame may finish starting up after the first push, so ask again a couple of times.
  onFrameLoad() { [300, 1500, 4000].forEach(ms => setTimeout(() => this.frames?.forEach(f => this.push(f.nativeElement.contentWindow)), ms)); }
  private schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.frames?.forEach(f => this.push(f.nativeElement.contentWindow)), 60);
  }
  private push(w: Window | null | undefined) {
    if (!w) return;
    const msg = this.editing
      ? { type: 'p000-theme', colors: this.isBase ? {} : this.out.colors, style: this.out.style, fonts: this.out.fonts, sRank: this.isRank && this.editing?.rank === 'S-RANK' }
      : { type: 'p000-theme', clear: true };
    w.postMessage(msg, '*');
  }
  @HostListener('window:message', ['$event'])
  onMessage(e: MessageEvent) {
    if (e.data?.type === 'p000-ready') this.push(e.source as Window);
    else if (e.data?.type === 'p000-pick' && Array.isArray(e.data.path)) this.inspect(this.kindOf(e.data.path), true);
  }

  // What a tap in the real app was on, from the element and its parents.
  private kindOf(path: Array<{ tag: string; cls: string }>): string {
    const found = new Set<string>();
    for (const { tag, cls } of path.slice(0, 5)) {
      if (tag === 'button' || tag === 'ion-button' || /btn|button|cta|pill|chip|cmp\b/.test(cls)) found.add('button');
      if (['input', 'textarea', 'select'].includes(tag) || /input|tile|scale|slider|field/.test(cls)) found.add('field');
      if (/bottom-nav|bn-tab/.test(cls) || tag === 'app-bottom-nav') found.add('nav');
      if (/badge|hero-dot|\bseg\b|progress|track|adherence/.test(cls)) found.add('badge');
      if (tag === 'svg' || /chart/.test(cls)) found.add('chart');
      if (/card|panel|row|stat|rank-tile|banner|w-shop|plan|list|tr-|due-payment/.test(cls)) found.add('card');
      if (/^(h[1-6]|p|span|b|strong|em|small|label)$/.test(tag)) found.add('text');
    }
    for (const k of ['button', 'field', 'nav', 'badge', 'chart', 'card', 'text']) if (found.has(k)) return k;
    return 'page';
  }

  // ---- component reference ----
  get isS(): boolean { return (!this.editing && this.rank === 'S-RANK') || (this.isRank && this.editing?.rank === 'S-RANK'); }
  pickRank(k: RankKey) { this.rank = k; if (this.editing) this.close(); }
  shade(key: RankKey, which: 'light' | 'dark' | 'mid'): string {
    const r = RANKS.find(x => x.key === key)!;
    return which === 'mid' ? lerpHex(r.light, r.dark, 0.5) : r[which];
  }
  private refCache: { key: string; tokens: Tokens; rows: Array<{ name: string; value: string; use: string }> } | null = null;
  private refDerived() {
    const accent = this.editing && !this.isBase ? this.cfg.accent : rankAccent(this.rank, this.position);
    const key = accent + JSON.stringify(this.editing && !this.isBase ? this.cfg.colorOverrides : {});
    if (this.refCache?.key === key) return this.refCache;
    const tokens: Tokens = { ...darkTokens(accent), ...STATUS.dark, ...(this.editing && !this.isBase ? this.cfg.colorOverrides : {}) };
    this.refCache = { key, tokens, rows: TOKEN_NOTES.map(n => ({ ...n, value: tokens[n.name] })) };
    return this.refCache;
  }
  get tokenRows() { return this.refDerived().rows; }
  get vars(): Record<string, string> {
    const t = this.refDerived().tokens, a = t['--hud-accent'];
    return { ...t, ...(this.editing ? this.out.style : {}), '--hud-accent-grad': this.isS ? this.grad : `linear-gradient(${a}, ${a})`, '--hud-glare': this.isS ? this.glare : 'none' };
  }
  async copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); this.copied = label; setTimeout(() => (this.copied = ''), 1400); } catch { /* clipboard unavailable */ }
  }
  copyCss() {
    const lines = this.tokenRows.map(r => `  ${r.name}: ${r.value};`).join('\n');
    this.copy(`:root {\n${lines}\n}`, 'css');
  }
}
