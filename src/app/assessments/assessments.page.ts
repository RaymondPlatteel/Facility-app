import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowBack,
  chevronDownOutline,
  closeOutline,
  trashOutline,
  documentTextOutline,
  downloadOutline,
  trendingUpOutline
} from 'ionicons/icons';
import { getOmniRank, levelColor, levelBgColor, SpeedUnit, kmToSpeedDisplay, speedDisplayToKm } from '../services/omni.util';
import { isSRank } from '../services/level-color.util';
import { ChromaMotionService } from '../services/chroma-motion.service';
import { LevelUpComponent } from '../shared/level-up/level-up.component';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import {
  FirebaseService,
  AssessmentInputs,
  FitnessAssessment,
  OmniRank,
  ClientProfile,
  Member,
  localDateString, Sex, AssessmentGoal } from '../services/firebase.service';

// Live result of an Omni Method computation.
interface OmniResult {
  H: number; K: number; N: number; Q: number; U: number;
  raw: number; exact: number; lvl: number; xpPct: number;
}

interface SubCard {
  label: string;
  value: number;
  pct: number;          // bar fill 0-100
  deltaText: string;
  deltaColor: string;
}

// One dot on the mini level-progression sparkline.
interface ChartPoint {
  x: number;
  y: number;
  value: number;
  current: boolean;
  radius: number;
  // Value label above the dot is thinned out (see pickLabelIndices) once
  // there are more assessments than fit legibly — the point itself still
  // always plots on the line either way.
  showValue: boolean;
}

interface MiniChart {
  path: string;
  points: ChartPoint[];
  xLabels: Array<{ x: number; label: string }>;
}

// Per-axis display ranges for the "adjusted" radar view. The scoring formula
// runs hot on power/flexibility and cold on endurance, so the adjusted view
// rescales those axes. Display only — scores and the algorithm are untouched.
const RADAR_AXES = [
  { label: 'Strength', min: 0, max: 100 },
  { label: 'Power', min: 30, max: 100 },
  { label: 'Endurance', min: 0, max: 70 },
  { label: 'Cardio', min: 0, max: 100 },
  { label: 'Flexibility', min: 30, max: 100 }
] as const;

// Raw category values feeding the radar (kept so the view can re-scale
// without recomputing scores).
interface RadarValues {
  current: number[];
  prev: number[] | null;
  prevLabel: string;
}

// Pentagon of the 5 category scores (current vs previous assessment).
interface RadarChart {
  rings: string[];                                   // grid polygons at 25/50/75/100
  axes: Array<{ x2: number; y2: number }>;           // spokes from center
  labels: Array<{ x: number; y: number; text: string; anchor: string }>;
  currentPts: string;
  currentDots: Array<{ x: number; y: number }>;
  prevPts: string | null;
  prevLabel: string;
  zoom: number;                 // fit-mode magnification (1 = true scale)
}

// On-page rendering of a "highest level impact" recommendation.
interface Opportunity {
  label: string;
  detail: string;
  gain: string;
  projectedLvl: number;
}

interface StrengthLift {
  key: 'deadlift' | 'squat' | 'bench' | 'pullup1rm';
  label: string;
  weightField: keyof AssessForm;
  repsField: keyof AssessForm;
  weightUnit: string;
  oneRmId: string;
}

// All raw form fields (numbers, nullable for empty inputs).
interface AssessForm {
  bodyWeight: number | null;
  height: number | null;
  deadliftWeight: number | null;
  deadliftReps: number | null;
  squatWeight: number | null;
  squatReps: number | null;
  benchWeight: number | null;
  benchReps: number | null;
  pullup1rmWeight: number | null;
  pullup1rmReps: number | null;
  longjump: number | null;
  sprint: number | null;
  pushups: number | null;
  pullups: number | null;
  run30: number | null;
  run30Unit: SpeedUnit;
  run30Display: number | null;
  speed2: number | null;
  speed2Unit: SpeedUnit;
  speed2Display: number | null;
  pike: number | null;
  backbend: number | null;
  straddle: number | null;
}

// One full, independent assessment editor (the page shows 1 in single mode,
// 2 side-by-side in compare mode — each can enter, calculate, save and export).
interface Panel {
  athleteName: string;
  // Which rank threshold table this athlete is scored against. Loaded with
  // their history; 'male' until a member record says otherwise.
  sex: Sex;
  // The athlete's single goal record — the same assessmentGoals/{nameKey}
  // document the mobile app reads, not a coach-side copy.
  // All of this athlete's saved goals, oldest target date first (see
  // AssessmentGoal.id's comment — one athlete can have several now).
  goals: AssessmentGoal[];
  // Which one is loaded into the form right now — '' means "unsaved new
  // goal, not yet in the list."
  selectedGoalId: string;
  goal: AssessmentGoal | null;
  goalSaving: boolean;
  // Goals-tab only: when they're aiming to hit it (YYYY-MM-DD), editable
  // alongside the same thirteen-field form.
  goalTargetDate: string;
  // Current/Goals tab, mirroring Project 000's toggle exactly: same form,
  // same result display, switched by what it's reading from and saving to.
  view: 'current' | 'goals';
  assessmentDate: string;              // datetime-local value
  form: AssessForm;
  history: FitnessAssessment[];        // oldest → newest, for the loaded athlete
  selectedHistoryTs: string;
  showResult: boolean;
  result: OmniResult | null;
  resultName: string;
  rank: OmniRank;
  rankColor: string;
  // Card background anchor — deliberately separate from rankColor. See
  // rankGradientBgColor's comment for why the vibrant badge/graph color
  // can't just be reused here.
  rankBgColor: string;
  // S-Rank chromium sweep. isChroma gates the .chroma-text class (and
  // whether the badge/level-number border shows the moving gradient at
  // all); rankGrad is that gradient, ticked by the chroma sync timer.
  // Below S-Rank isChroma stays false and rankColor/rankBgColor alone
  // carry the (flat) rank color, same as before.
  isChroma: boolean;
  rankGrad: string;
  // Translucent S-Rank wash for the card grounds (result-hero/sub-card),
  // same var Project 000's cards use — `none` at every other rank.
  rankGlare: string;
  barWidth: number;
  barSnap: boolean;             // momentarily disables the bar transition (level-up wrap)
  barAnimToken: number;         // cancels stale bar-animation timeouts
  subCards: SubCard[];
  levelDelta: { text: string; color: string } | null;   // % change vs baseline
  compareTs: string;            // chosen comparison baseline timestamp ('' = auto previous)
  compareOptions: FitnessAssessment[];   // cached baseline choices (stable ref)
  chart: MiniChart | null;
  radar: RadarChart | null;
  radarValues: RadarValues | null;
  radarNormalized: boolean;     // adjusted per-axis scale vs raw 0-100
  radarFit: boolean;            // zoom the shape so its max axis reads ~90%
  backdateOpen: boolean;        // "log a past date" mode
  backdate: string;             // YYYY-MM-DD target for a backdated save
  loadingHistory: boolean;      // fetching previous assessments
  opportunities: Opportunity[];
  saving: boolean;
  errorMsg: boolean;
  nameOpen: boolean;           // client dropdown expanded
  filteredNames: string[];     // cached (stable ref) dropdown options
  loadedNameKey: string;       // dedupes history load + latest-result display
}

const RANK_COLORS: Record<OmniRank, string> = {
  'UNRANKED': '#737373',
  'D-RANK': '#4ade80',
  'C-RANK': '#38bdf8',
  'B-RANK': '#c084fc',
  'A-RANK': '#d9695f',
  'S-RANK': '#ffffff'
};

// Ordinal position of each rank tier, low to high — lets a mixed-sex group
// get one shared "average rank" without ever re-running a level through a
// sex-specific threshold table. A boy and a girl at the same OMPAR level can
// land in different ranks (their threshold floors differ), so averaging raw
// levels and re-deriving a rank from that average would silently pick
// whichever sex's table happens to apply — there's no single correct one
// for a mixed group. Averaging the already-resolved rank ordinals sidesteps
// that entirely: each person's own rank already accounted for their sex,
// so this only ever blends outcomes that are already apples-to-apples.
const RANK_ORDER: OmniRank[] = ['UNRANKED', 'D-RANK', 'C-RANK', 'B-RANK', 'A-RANK', 'S-RANK'];
const RANK_ORDINAL: Record<OmniRank, number> = {
  'UNRANKED': 0, 'D-RANK': 1, 'C-RANK': 2, 'B-RANK': 3, 'A-RANK': 4, 'S-RANK': 5
};

// Level → color, one distinct hue per rank tier (grey/green/sky-blue/purple/
// amber-red/white) — like a game's item-rarity ladder — rather than a
// continuous rainbow sweep. A rainbow sweep makes adjacent levels near a
// rank boundary look almost identical (top-of-B and bottom-of-A both landing
// in yellow-green), which buries the moment that actually matters: ranking
// up. Color only blends *within* a band now (see rankGradientColor);
// crossing a floor always snaps to a new hue. Picks are chosen for both hue
// AND lightness separation (not hue alone) so neighboring ranks read as
// clearly different even at small badge sizes — verified pairwise RGB
// distance stays above 100 at every boundary. Level 99 (top of A-RANK, one
// point short of S) lands exactly on blood red — the last color before the
// final white breakthrough.
const LEVEL_COLOR_BANDS: Array<{ floor: number; ceil: number; light: string; dark: string }> = [
  { floor: 0, ceil: 19, light: '#737373', dark: '#404040' },   // UNRANKED — neutral grey (no blue tint)
  { floor: 20, ceil: 39, light: '#4ade80', dark: '#15803d' },  // D-RANK — green
  { floor: 40, ceil: 59, light: '#38bdf8', dark: '#0369a1' },  // C-RANK — sky blue
  { floor: 60, ceil: 79, light: '#c084fc', dark: '#6b21a8' },  // B-RANK — purple
  { floor: 80, ceil: 99, light: '#d9695f', dark: '#c1121f' },  // A-RANK — washed red heating to blood red
  { floor: 100, ceil: 100, light: '#ffffff', dark: '#ffffff' } // S-RANK — pure white
];

// Toggle to flip the within-band direction for every rank at once. true
// (current): climbs light -> dark as level rises within a rank — a deeper,
// more saturated shade the closer you are to the next rank-up. Mirrors how
// A-RANK always worked (amber -> blood red). false: the previous dark ->
// light climb. Kept as a single flag specifically so this is a one-line
// revert if the darker-as-you-climb look doesn't stick.
const DARKEN_AS_LEVEL_CLIMBS = true;

// Card background per rank — deliberately NOT derived from rankGradientColor
// above. Mixing the bright badge/graph color straight into a card's
// background blows the lightness way past "dark" (a vivid mid-blue or
// mid-green card, not a moody dark one) and it wanders per-level as a bonus
// bug. These are hand-picked instead: same hue family as the rank, held at
// the same low lightness (~8%) the original fixed navy cards (#04070c/
// #070b12, ~L6-8%) always sat at, and constant across the whole rank rather
// than shifting with level — the vibrant badge/graph/border already carries
// the "climbing within a rank" feeling, so the backdrop can stay calm.
const RANK_BG_ANCHORS: Array<{ floor: number; ceil: number; bg: string }> = [
  { floor: 0, ceil: 19, bg: '#070809' },   // UNRANKED — neutral, barely tinted
  { floor: 20, ceil: 39, bg: '#030c07' },  // D-RANK — dark green
  { floor: 40, ceil: 59, bg: '#03090c' },  // C-RANK — dark blue
  { floor: 60, ceil: 79, bg: '#08030c' },  // B-RANK — dark purple
  { floor: 80, ceil: 99, bg: '#0c0304' },  // A-RANK — dark blood red
  { floor: 100, ceil: 100, bg: '#0a0a0a' } // S-RANK — neutral dark (badge/graph carry the white)
];

// Per-test metadata used by the "highest level impact" recommendations.
const ASSESSMENT_META = [
  { key: 'deadlift', label: 'Deadlift', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'squat', label: 'Squat', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'bench', label: 'Bench', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'pullup1rm', label: 'Pull-up 1RM', unit: 'lbs', step: 20, min: 0, max: 2000, decimals: 0 },
  { key: 'longjump', label: 'Long Jump', unit: 'in', step: 3, min: 0, max: 300, decimals: 0 },
  { key: 'sprint', label: '100m Sprint', unit: 'sec', step: 0.1, min: 0, max: 60, decimals: 2 },
  { key: 'pushups', label: 'Pushups', unit: 'reps', step: 5, min: 0, max: 1000, decimals: 0 },
  { key: 'pullups', label: 'Pull-ups', unit: 'reps', step: 3, min: 0, max: 1000, decimals: 0 },
  { key: 'run30', label: '30 Min Run', unit: 'km', step: 0.32, min: 0, max: 50, decimals: 2 },
  { key: 'speed2', label: '2 Min Speed', unit: 'km', step: 0.016, min: 0, max: 0.805, decimals: 3 },
  { key: 'pike', label: 'Pike', unit: '', step: 1, min: 0, max: 10, decimals: 0 },
  { key: 'backbend', label: 'Backbend', unit: '', step: 1, min: 0, max: 10, decimals: 0 },
  { key: 'straddle', label: 'Straddle', unit: 'deg', step: 10, min: 0, max: 180, decimals: 0 }
] as const;

@Component({
  selector: 'app-assessments',
  templateUrl: './assessments.page.html',
  styleUrls: ['./assessments.page.scss'],
  standalone: true,
  imports: [IonContent, IonIcon, CommonModule, FormsModule, LevelUpComponent]
})
export class AssessmentsPage implements OnInit, OnDestroy {
  // The rank-up takeover. Driven directly rather than by a watcher: a coach
  // app has no "my level" to watch, so the save calls it.
  @ViewChild(LevelUpComponent) levelUp?: LevelUpComponent;
  @ViewChild('pdfPage') pdfPage?: ElementRef<HTMLDivElement>;
  @ViewChild('pdfScaleWrap') pdfScaleWrap?: ElementRef<HTMLDivElement>;
  @ViewChild('pdfScroll') pdfScroll?: ElementRef<HTMLDivElement>;

  // ---- shared ----
  clients: ClientProfile[] = [];
  // Stable array (built once when clients load). A getter returning a fresh array
  // each change-detection rebuilt the datalist <option>s, closing the native
  // autocomplete popup on any mouse move.
  clientNames: string[] = [];

  // 1 = single; 2/3/4 = compare N athletes side by side.
  panelCount = 1;
  panels: Panel[] = [this.blankPanel()];

  get compare(): boolean {
    return this.panelCount > 1;
  }

  // Category labels abbreviate in the 3/4-wide compare layout so all 5 stay on one row.
  private static readonly CATEGORY_ABBREV: Record<string, string> = {
    Strength: 'STR',
    Power: 'PWR',
    Endurance: 'END',
    Cardio: 'CRD',
    Flexibility: 'FLX'
  };

  subCardLabel(label: string): string {
    return this.panelCount >= 3 ? (AssessmentsPage.CATEGORY_ABBREV[label] ?? label) : label;
  }

  // ---- PDF (single shared modal for whichever panel requested it) ----
  pdfOpen = false;
  private pdfPanel: Panel | null = null;

  // ---- group lookup (cell/generation/cohort "000" code) ----
  groupCode = '';
  groupResults: Member[] = [];
  groupSearching = false;
  groupSearched = false;

  // The 3-digit code is literally [cell, generation, cohort] — one digit
  // each — so the header can label them individually instead of repeating
  // the same 3-digit string three times.
  get groupCell(): string { return this.groupCode[0] ?? '—'; }
  get groupGeneration(): string { return this.groupCode[1] ?? '—'; }
  get groupCohort(): string { return this.groupCode[2] ?? '—'; }

  // Average rank across the panels actually populated by the group search
  // (see searchGroupAndPopulate) — see RANK_ORDINAL's comment for why this
  // averages ranks, not raw levels, to stay correct for a mixed-sex group.
  get groupAverageRank(): OmniRank {
    const n = Math.min(this.groupResults.length, this.panels.length, 4);
    if (n === 0) return 'UNRANKED';
    const sum = this.panels.slice(0, n).reduce((acc, p) => acc + RANK_ORDINAL[p.rank], 0);
    const ordinal = Math.max(0, Math.min(5, Math.round(sum / n)));
    return RANK_ORDER[ordinal];
  }

  get groupAverageColor(): string {
    return this.groupIsChroma ? '#ffffff' : RANK_COLORS[this.groupAverageRank];
  }

  get groupIsChroma(): boolean {
    return this.groupAverageRank === 'S-RANK';
  }

  get groupAverageGrad(): string {
    if (this.groupIsChroma) return this.chroma.gradient;
    const c = RANK_COLORS[this.groupAverageRank];
    return `linear-gradient(${c}, ${c})`;
  }

  // Dark card ground for the banner — RANK_BG_ANCHORS is in the same
  // low-to-high order as RANK_ORDER, so the ordinal doubles as the index.
  get groupAverageBg(): string {
    const ordinal = RANK_ORDINAL[this.groupAverageRank];
    return RANK_BG_ANCHORS[ordinal]?.bg ?? RANK_BG_ANCHORS[0].bg;
  }

  get groupAverageGlare(): string {
    return this.groupIsChroma ? this.chroma.glare : 'none';
  }

  strengthLifts: StrengthLift[] = [
    { key: 'deadlift', label: 'Deadlift', weightField: 'deadliftWeight', repsField: 'deadliftReps', weightUnit: 'LBS', oneRmId: 'deadlift' },
    { key: 'squat', label: 'Squat', weightField: 'squatWeight', repsField: 'squatReps', weightUnit: 'LBS', oneRmId: 'squat' },
    { key: 'bench', label: 'Bench', weightField: 'benchWeight', repsField: 'benchReps', weightUnit: 'LBS', oneRmId: 'bench' },
    { key: 'pullup1rm', label: 'Pull-up', weightField: 'pullup1rmWeight', repsField: 'pullup1rmReps', weightUnit: 'ADDED LBS', oneRmId: 'pullup1rm' }
  ];

  constructor(
    private firebase: FirebaseService,
    private router: Router,
    private route: ActivatedRoute,
    private toastController: ToastController,
    private alertController: AlertController,
    private chroma: ChromaMotionService
  ) {
    addIcons({ arrowBack, chevronDownOutline, closeOutline, trashOutline, documentTextOutline, downloadOutline, trendingUpOutline });
    // rankColor/rankBgColor stay flat once set at render time — S-Rank's
    // levelColor() already returns a static white, same as every other
    // rank returns its static hue. The moving chromium sweep lives only in
    // panel.rankGrad (text/border gradient) and panel.isChroma, refreshed
    // here off the shared chroma service tick so every S-Rank panel's
    // gradient stays in sync instead of drifting apart.
    this.chromaSyncTimer = setInterval(() => {
      for (const panel of this.panels) {
        panel.isChroma = !!(panel.result && isSRank(panel.result.lvl, panel.sex));
        if (panel.isChroma) {
          panel.rankGrad = this.chroma.gradient;
          panel.rankGlare = this.chroma.glare;
        }
      }
    }, 80);
  }

  private chromaSyncTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy() {
    if (this.chromaSyncTimer) clearInterval(this.chromaSyncTimer);
  }

  async ngOnInit() {
    await this.refreshClients();

    // Allow deep-linking from the clients page: /assessments?client=Name
    const preset = this.route.snapshot.queryParamMap.get('client');
    if (preset) {
      this.panels[0].athleteName = preset;
      await this.commitAthleteName(this.panels[0]);
    }
  }

  // Ionic caches this page's component across navigations, so ngOnInit only
  // runs once — without this, a client created elsewhere (e.g. the Clients
  // page) wouldn't show up in the athlete dropdown until a full app reload.
  async ionViewWillEnter() {
    await this.refreshClients();
  }

  private async refreshClients() {
    try {
      this.clients = await this.firebase.listClientProfiles();
      this.clientNames = this.orderByRecent(this.clients.map(c => c.fullName));
      this.panels.forEach(p => p.filteredNames = this.clientNames);
    } catch (err) {
      console.error('Assessments: failed to load clients', err);
    }
  }

  // ---------- recently-viewed ordering ----------
  // Most-recently-looked-at athletes float to the top of the dropdown.
  // Persisted per-browser in localStorage (not per-coach account, but this
  // app has no per-user auth split for coaches, so that's fine).
  private static readonly RECENT_KEY = 'facility_recent_clients';
  private static readonly RECENT_MAX = 50;

  private loadRecentNames(): string[] {
    try {
      const raw = localStorage.getItem(AssessmentsPage.RECENT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  private markRecent(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const recent = this.loadRecentNames().filter(n => n.toLowerCase() !== trimmed.toLowerCase());
      recent.unshift(trimmed);
      localStorage.setItem(AssessmentsPage.RECENT_KEY, JSON.stringify(recent.slice(0, AssessmentsPage.RECENT_MAX)));
    } catch {
      // ignore (private browsing / storage disabled)
    }
    this.clientNames = this.orderByRecent(this.clientNames);
    this.panels.forEach(p => { if (!p.nameOpen) p.filteredNames = this.clientNames; });
  }

  // Recently-viewed names first (most recent first), then everyone else in
  // their existing order.
  private orderByRecent(names: string[]): string[] {
    const recent = this.loadRecentNames();
    const rank = new Map(recent.map((n, i) => [n.toLowerCase(), i]));
    return [...names].sort((a, b) => {
      const ra = rank.has(a.toLowerCase()) ? rank.get(a.toLowerCase())! : Infinity;
      const rb = rank.has(b.toLowerCase()) ? rank.get(b.toLowerCase())! : Infinity;
      return ra - rb;
    });
  }

  // ---------- client dropdown (combobox) ----------
  openNames(panel: Panel) {
    panel.filteredNames = this.orderByRecent(this.clientNames);
    panel.nameOpen = true;
  }

  toggleNames(panel: Panel) {
    if (panel.nameOpen) {
      panel.nameOpen = false;
    } else {
      this.openNames(panel);
    }
  }

  filterNames(panel: Panel) {
    const q = panel.athleteName.trim().toLowerCase();
    panel.filteredNames = q
      ? this.clientNames.filter(n => n.toLowerCase().includes(q))
      : this.clientNames;
    panel.nameOpen = true;
  }

  async selectClient(panel: Panel, name: string, ev: Event) {
    // mousedown (not click) so the pick lands before the input's blur.
    ev.preventDefault();
    panel.athleteName = name;
    panel.nameOpen = false;
    panel.filteredNames = this.clientNames;
    await this.commitAthleteName(panel);
  }

  // Loads history for the entered name and shows the latest saved result.
  async commitAthleteName(panel: Panel) {
    const key = panel.athleteName.trim().toLowerCase();
    if (!key) return;
    // Dedupe change+select double-fires, but only when a load actually
    // succeeded — an empty history is retried so a failed/slow fetch can't
    // permanently wedge this client.
    if (key === panel.loadedNameKey && panel.history.length) return;
    panel.loadedNameKey = key;
    panel.loadingHistory = true;
    this.markRecent(panel.athleteName);
    try {
      // Read before the history renders — every rank and colour below is
      // computed against this athlete's threshold table.
      panel.sex = (await this.firebase.getMember(key).catch(() => null))?.sex ?? 'male';
      panel.goals = await this.firebase.listGoalsForClient(key).catch(() => []);
      panel.goal = panel.goals.length
        ? panel.goals.reduce((a, b) => (a.updatedAt || '') >= (b.updatedAt || '') ? a : b)
        : null;
      panel.selectedGoalId = panel.goal?.id || '';
      // Picking a new athlete always lands on Current — switching people
      // shouldn't leave a stale Goals tab open on the wrong person's target.
      panel.view = 'current';
      await this.loadHistory(panel);
    } finally {
      panel.loadingHistory = false;
    }
    this.showLatest(panel);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(ev: Event) {
    if (!(ev.target as HTMLElement).closest?.('.combo')) {
      this.panels.forEach(p => p.nameOpen = false);
    }
  }

  private nowLocal(): string {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    return now.toISOString().slice(0, 16);
  }

  // Same local calendar day (timestamps are datetime-local strings).
  private sameDay(a: string, b: string): boolean {
    return !!a && !!b && a.slice(0, 10) === b.slice(0, 10);
  }

  // ---------- backdating (log an assessment for a past date) ----------
  get todayStr(): string {
    return localDateString();
  }

  toggleBackdate(panel: Panel, open: boolean) {
    panel.backdateOpen = open;
    if (!open) panel.backdate = '';
  }

  // The backdate target if one is validly set (past date only), else null.
  private backdateTarget(panel: Panel): string | null {
    return panel.backdateOpen && panel.backdate && panel.backdate < this.todayStr
      ? panel.backdate
      : null;
  }

  backdateLabel(panel: Panel): string {
    if (!panel.backdate) return '';
    const d = new Date(panel.backdate + 'T12:00');
    return isNaN(d.getTime())
      ? panel.backdate
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  hasEntryOn(panel: Panel, day: string): boolean {
    return !!day && panel.history.some(e => (e.timestamp || '').slice(0, 10) === day);
  }

  private blankForm(): AssessForm {
    return {
      bodyWeight: null, height: null,
      deadliftWeight: null, deadliftReps: null,
      squatWeight: null, squatReps: null,
      benchWeight: null, benchReps: null,
      pullup1rmWeight: null, pullup1rmReps: null,
      longjump: null, sprint: null,
      pushups: null, pullups: null,
      run30: null, run30Unit: 'mph', run30Display: null,
      speed2: null, speed2Unit: 'mph', speed2Display: null,
      pike: null, backbend: null, straddle: null
    };
  }

  private blankPanel(): Panel {
    return {
      athleteName: '', sex: 'male', goals: [], selectedGoalId: '', goal: null, goalSaving: false, goalTargetDate: '', view: 'current', assessmentDate: this.nowLocal(), form: this.blankForm(),
      history: [], selectedHistoryTs: '', showResult: false, result: null,
      resultName: '', rank: 'UNRANKED', rankColor: RANK_COLORS['UNRANKED'], rankBgColor: RANK_BG_ANCHORS[0].bg,
      isChroma: false, rankGrad: 'linear-gradient(#737373, #737373)', rankGlare: 'none',
      barWidth: 0, barSnap: false, barAnimToken: 0,
      subCards: [], levelDelta: null, compareTs: '', compareOptions: [], chart: null, radar: null,
      radarValues: null, radarNormalized: true, radarFit: false,
      backdateOpen: false, backdate: '', loadingHistory: false, opportunities: [],
      saving: false, errorMsg: false,
      nameOpen: false, filteredNames: this.clientNames, loadedNameKey: ''
    };
  }

  // Set how many athletes to compare (1–4). Adds/trims independent editors.
  setCount(n: number) {
    this.panelCount = n;
    while (this.panels.length < n) this.panels.push(this.blankPanel());
    if (this.panels.length > n) this.panels = this.panels.slice(0, n);
  }

  trackPanel = (i: number) => i;
  trackName = (_: number, name: string) => name;

  goBack() {
    this.router.navigateByUrl('/home');
  }

  // ---------- group lookup ----------
  // Only digits, capped at 3 — same "000" cell/generation/cohort code as
  // mobile Settings.
  onGroupCodeInput(value: string) {
    this.groupCode = value.replace(/\D/g, '').slice(0, 3);
    if (this.groupCode.length < 3) {
      this.groupResults = [];
      this.groupSearched = false;
    }
  }

  // Enter searches AND switches straight into the N-person compare view —
  // one editor per member found (lowest level first), capped at 4 since
  // that's as many as the compare layout supports.
  async searchGroupAndPopulate() {
    const digits = this.groupCode.split('').map(Number);
    if (digits.length !== 3 || digits.some(d => !isFinite(d))) return;
    const [cell, generation, cohort] = digits;
    this.groupSearching = true;
    try {
      this.groupResults = await this.firebase.listMembersByGroup(cell, generation, cohort);
      if (this.groupResults.length) {
        const shown = this.groupResults.slice(0, 4);
        this.setCount(shown.length);
        await Promise.all(shown.map((m, i) => {
          this.panels[i].athleteName = m.clientName;
          return this.commitAthleteName(this.panels[i]);
        }));
      }
    } catch (err) {
      console.error('Assessments: group search failed', err);
      this.groupResults = [];
    } finally {
      this.groupSearching = false;
      this.groupSearched = true;
    }
  }

  // ---------- math (ported verbatim from OMPAR) ----------
  private n(v: number | null | undefined): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  private brzycki(weight: number, reps: number): number {
    if (!weight || reps < 1) return weight || 0;
    if (reps === 1) return weight;
    return weight * (1 + reps / 30);
  }

  private get1RM(form: AssessForm, key: StrengthLift['key']): number {
    if (key === 'pullup1rm') {
      const bw = this.n(form.bodyWeight);
      const added = this.n(form.pullup1rmWeight);
      const r = this.n(form.pullup1rmReps) || 1;
      return this.brzycki(bw + added, r);
    }
    const w = this.n(form[(key + 'Weight') as keyof AssessForm] as number | null);
    const r = this.n(form[(key + 'Reps') as keyof AssessForm] as number | null) || 1;
    return this.brzycki(w, r);
  }

  // Live "1RM ≈ x lbs" hint shown under each strength lift.
  oneRmLabel(panel: Panel, lift: StrengthLift): string {
    const form = panel.form;
    let w: number, r: number;
    if (lift.key === 'pullup1rm') {
      const bw = this.n(form.bodyWeight);
      const added = this.n(form.pullup1rmWeight);
      w = bw + added;
      r = this.n(form.pullup1rmReps) || 1;
    } else {
      w = this.n(form[lift.weightField] as number | null);
      r = this.n(form[lift.repsField] as number | null) || 1;
    }
    if (w > 0 && r > 1) return '1RM ≈ ' + this.brzycki(w, r).toFixed(1) + ' lbs';
    if (w > 0) return '1RM = ' + w.toFixed(0) + ' lbs (1 rep)';
    return '';
  }

  private calcStrength(dl: number, sq: number, bn: number, pu: number): number {
    return ((dl / 939 * 100) + (sq / 800 * 100) + (bn / 600 * 100) + (pu / 500 * 100)) / 4;
  }
  private calcPower(lj: number, sp: number): number {
    return (lj / 147 * 100 + (Math.sqrt((sp - 9.58) / 0.125) * -1 + 10) * 10) / 2;
  }
  private calcEndurance(pu: number, pulls: number): number {
    return (((pu / 150) * 100) + ((pulls / 49) * 100)) / 2;
  }
  private calcCardio(r30: number, s2: number): number {
    const rs = r30 < 4.02336
      ? (Math.sqrt((11.265408 - r30) / 0.11265408) * -1 + 10) * 10
      : r30 / 11.265408 * 100;
    return (rs + (Math.sqrt((0.804672 - s2) / 0.00804672) * -1 + 10) * 10) / 2;
  }
  private calcFlex(pike: number, bb: number, str: number): number {
    const s = str < 80 ? 0 : str > 180 ? 100 : str - 80;
    // Pike/backbend are entered on a 0-10 scale; clamp so an out-of-range
    // value (old 0-100 data, a typo) can't inflate the score past a
    // perfect 10.
    const p = Math.max(0, Math.min(10, pike));
    const b = Math.max(0, Math.min(10, bb));
    return ((p * 10) + (b * 10) + s) / 3;
  }

  // Display-only floor: a computed level of 0 (or below) reads as "Level 1"
  // everywhere it's shown. Doesn't touch the underlying score/xp/storage —
  // getRank, deltas, and the saved lvl field all keep using the real value.
  dispLvl(lvl: number | null | undefined): number {
    return Math.max(1, Math.round(lvl ?? 0));
  }

  // Delegates rather than re-implementing. This page used to carry its own
  // copy of the threshold ladder, which meant sex-specific floors would
  // have applied everywhere EXCEPT the screen coaches actually enter
  // assessments on — the worst possible place for the two to disagree.
  private getRank(level: number, sex: Sex = 'male'): OmniRank {
    return getOmniRank(level, sex);
  }

  // Splits 'D-RANK' into a big glyph ('D') + tiny caption ('RANK') for the
  // rank badge display. UNRANKED has no letter to show, so an em dash stands
  // in as the glyph instead of leaving it blank. Public so the template can
  // call them directly.
  rankLetter(rank: OmniRank): string {
    return rank === 'UNRANKED' ? '—' : rank.split('-')[0];
  }

  rankLabel(rank: OmniRank): string {
    return rank === 'UNRANKED' ? 'UNRANKED' : 'RANK';
  }

  // Color for a level along the rank-band ramp (LEVEL_COLOR_BANDS). Uses the
  // continuous level so shading within a band still moves smoothly between
  // whole-level ticks, even though crossing a band's floor always snaps.

  // The two timed-distance tests (30 Min Run, 2 Min Speed) let the coach
  // pick whichever unit they think in — mph, raw km, or min/km pace — and
  // enter ONE number; the canonical km value that actually drives scoring
  // is derived from it via omni.util's conversions. windowMinutes is what
  // tells the conversion "this distance was covered in how long."
  private speedWindow(field: 'run30' | 'speed2'): number {
    return field === 'run30' ? 30 : 2;
  }

  // Typing in the display field (whatever unit is currently selected)
  // recomputes the canonical km value that's actually saved/scored.
  onSpeedDisplayChanged(panel: Panel, field: 'run30' | 'speed2', val: number | null) {
    const unitField = field === 'run30' ? 'run30Unit' : 'speed2Unit';
    const displayField = field === 'run30' ? 'run30Display' : 'speed2Display';
    panel.form[displayField] = val;
    panel.form[field] = val != null && val >= 0
      ? Math.round(speedDisplayToKm(val, panel.form[unitField], this.speedWindow(field)) * 1000) / 1000
      : null;
  }

  // Switching units re-derives the display value from the unchanged
  // canonical km — the underlying test result doesn't move, only how it's
  // shown.
  onSpeedUnitChanged(panel: Panel, field: 'run30' | 'speed2', unit: SpeedUnit) {
    const displayField = field === 'run30' ? 'run30Display' : 'speed2Display';
    panel.form[field === 'run30' ? 'run30Unit' : 'speed2Unit'] = unit;
    const km = panel.form[field];
    panel.form[displayField] = km != null
      ? Math.round(kmToSpeedDisplay(km, unit, this.speedWindow(field)) * 1000) / 1000
      : null;
  }

  private rankGradientColor(level: number, sex: Sex = 'male'): string {
    return levelColor(level, sex);
  }

  private rankGradientBgColor(level: number, sex: Sex = 'male'): string {
    return levelBgColor(level, sex);
  }

  private hexToRgb(h: string): [number, number, number] {
    const s = h.replace('#', '');
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  private lerpHex(a: string, b: string, t: number): string {
    const pa = this.hexToRgb(a), pb = this.hexToRgb(b);
    const mix = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
    return '#' + [mix(0), mix(1), mix(2)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  private fmt(v: number, d = 1): string {
    return isFinite(v) ? v.toFixed(d) : '—';
  }

  private computeOmni(i: AssessmentInputs): OmniResult {
    const H = this.calcStrength(i.deadlift, i.squat, i.bench, i.pullup1rm);
    const K = this.calcPower(i.longjump, i.sprint);
    const N = this.calcEndurance(i.pushups, i.pullups);
    const Q = this.calcCardio(i.run30, i.speed2);
    const U = this.calcFlex(i.pike, i.backbend, i.straddle);
    const raw = H + K + N + Q + U;
    const exact = Math.pow(raw / 1000, 2) * 1000;
    const lvl = Math.floor(exact);
    const xpPct = (exact - lvl) * 100;
    return { H, K, N, Q, U, raw, exact, lvl, xpPct };
  }

  // Build the full AssessmentInputs object (raw entries + derived 1RMs).
  private buildInputs(form: AssessForm): AssessmentInputs {
    return {
      bodyWeight: this.n(form.bodyWeight),
      height: this.n(form.height),
      deadlift: this.get1RM(form, 'deadlift'),
      deadliftWeight: this.n(form.deadliftWeight),
      deadliftReps: this.n(form.deadliftReps) || 1,
      squat: this.get1RM(form, 'squat'),
      squatWeight: this.n(form.squatWeight),
      squatReps: this.n(form.squatReps) || 1,
      bench: this.get1RM(form, 'bench'),
      benchWeight: this.n(form.benchWeight),
      benchReps: this.n(form.benchReps) || 1,
      pullup1rm: this.get1RM(form, 'pullup1rm'),
      pullup1rmWeight: this.n(form.pullup1rmWeight),
      pullup1rmReps: this.n(form.pullup1rmReps) || 1,
      longjump: this.n(form.longjump),
      sprint: this.n(form.sprint),
      pushups: this.n(form.pushups),
      pullups: this.n(form.pullups),
      run30: this.n(form.run30),
      speed2: this.n(form.speed2),
      pike: this.n(form.pike),
      backbend: this.n(form.backbend),
      straddle: this.n(form.straddle)
    };
  }

  // ---------- history (Firestore-backed, mirrors OMPAR's localStorage DB) ----------
  async loadHistory(panel: Panel) {
    const name = panel.athleteName.trim();
    if (!name) {
      panel.history = [];
      panel.selectedHistoryTs = '';
      return;
    }
    const match = this.clients.find(c => c.fullName.trim().toLowerCase() === name.toLowerCase());
    try {
      panel.history = await this.firebase.listAssessmentsForClient({
        clientId: match?.id ?? null,
        clientName: name
      });
    } catch (err) {
      console.error('Assessments: history load failed', err);
      panel.history = [];
    }
    panel.selectedHistoryTs = '';
  }

  // History dropdown options, newest first.
  historyOptions(panel: Panel): FitnessAssessment[] {
    return panel.history.slice().reverse();
  }

  // Label for one entry in the Goals dropdown — the target date if they set
  // one, otherwise "No date" so a dateless goal doesn't render blank.
  goalOptionLabel(goal: AssessmentGoal): string {
    const dateLabel = goal.targetDate
      ? new Date(goal.targetDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : 'No date';
    return `${dateLabel} — Lvl ${this.dispLvl(goal.lvl)}`;
  }

  // Load a past assessment into the form AND show its result immediately
  // (display only — nothing is saved until Calculate is pressed).
  loadSelectedHistory(panel: Panel) {
    const ts = panel.selectedHistoryTs;
    if (!ts) return;
    const entry = panel.history.find(e => e.timestamp === ts);
    if (!entry) return;
    panel.assessmentDate = entry.timestamp;
    const i = entry.inputs;
    this.applyInputsToForm(panel, i);
    // Render from the STORED inputs (not re-derived from the form) so legacy
    // entries display their true saved scores.
    const totals = this.computeOmni(i);
    this.renderResult(panel, panel.athleteName.trim() || 'Athlete', i, totals);
  }

  // Fills the thirteen form fields from a stored AssessmentInputs.
  //
  // Extracted so loading a GOAL back in for editing shares this exact
  // logic — including the legacy back-fill below, which a second copy would
  // inevitably drift away from.
  private applyInputsToForm(panel: Panel, i: AssessmentInputs) {
    // Legacy entries (OMPAR-era / PR snapshots) store only the derived 1RMs,
    // not the raw weight×reps fields — back-fill lifts as "1RM @ 1 rep" so the
    // form doesn't show zeros for data that exists.
    const liftW = (raw: number | undefined, oneRm: number | undefined) =>
      this.orNull(raw ?? oneRm);
    const liftR = (raw: number | undefined, oneRm: number | undefined) =>
      this.orNull(raw ?? (oneRm != null ? 1 : undefined));
    panel.form = {
      bodyWeight: this.orNull(i.bodyWeight), height: this.orNull(i.height),
      deadliftWeight: liftW(i.deadliftWeight, i.deadlift), deadliftReps: liftR(i.deadliftReps, i.deadlift),
      squatWeight: liftW(i.squatWeight, i.squat), squatReps: liftR(i.squatReps, i.squat),
      benchWeight: liftW(i.benchWeight, i.bench), benchReps: liftR(i.benchReps, i.bench),
      // pullup1rm is stored as bodyweight + added; without a stored bodyweight
      // the whole 1RM goes in the "added" field (bw counts as 0 in the calc).
      pullup1rmWeight: liftW(
        i.pullup1rmWeight,
        i.pullup1rm != null ? i.pullup1rm - (i.bodyWeight ?? 0) : undefined
      ),
      pullup1rmReps: liftR(i.pullup1rmReps, i.pullup1rm),
      longjump: this.orNull(i.longjump), sprint: this.orNull(i.sprint),
      pushups: this.orNull(i.pushups), pullups: this.orNull(i.pullups),
      run30: this.orNull(i.run30), run30Unit: 'mph', run30Display: null,
      speed2: this.orNull(i.speed2), speed2Unit: 'mph', speed2Display: null,
      pike: this.orNull(i.pike), backbend: this.orNull(i.backbend), straddle: this.orNull(i.straddle)
    };
    // Derive the mph display from the stored km for both timed-distance
    // tests — defaults to mph on every load, same as a blank form.
    panel.form.run30Display = panel.form.run30 != null
      ? Math.round(kmToSpeedDisplay(panel.form.run30, 'mph', this.speedWindow('run30')) * 1000) / 1000
      : null;
    panel.form.speed2Display = panel.form.speed2 != null
      ? Math.round(kmToSpeedDisplay(panel.form.speed2, 'mph', this.speedWindow('speed2')) * 1000) / 1000
      : null;
  }

  private orNull(v: number | undefined): number | null {
    return v === undefined || v === null ? null : v;
  }

  async deleteSelectedHistory(panel: Panel) {
    const ts = panel.selectedHistoryTs;
    const entry = panel.history.find(e => e.timestamp === ts);
    if (!entry?.id) return;
    const alert = await this.alertController.create({
      header: 'Delete assessment?',
      message: `${entry.dateLabel} — Lvl ${this.dispLvl(entry.lvl)} will be permanently removed.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: async () => {
            await this.firebase.deleteAssessment(entry.id!);
            panel.showResult = false;
            await this.loadHistory(panel);
            this.toast('Assessment deleted');
          }
        }
      ]
    });
    await alert.present();
  }

  // ---------- calculate ----------
  async calculate(panel: Panel) {
    panel.errorMsg = false;
    // Saves as today (one snapshot per athlete per day; same-day recalcs
    // overwrite) — unless a past date was picked via "log a past date".
    const backdate = this.backdateTarget(panel);
    panel.assessmentDate = backdate ? `${backdate}T12:00` : this.nowLocal();
    const nameInput = panel.athleteName.trim();
    const name = nameInput || 'Athlete';
    const inputs = this.buildInputs(panel.form);
    const totals = this.computeOmni(inputs);
    // Captured BEFORE the save and before loadHistory replaces it — this is
    // the level the athlete walked in with, and the animation needs both
    // ends of the climb.
    const priorExact = this.latestExactFor(panel);
    this.renderResult(panel, name, inputs, totals);

    // Persist (only when a real name was entered).
    if (nameInput) {
      panel.saving = true;
      try {
        const match = this.clients.find(c => c.fullName.trim().toLowerCase() === nameInput.toLowerCase());
        await this.firebase.saveAssessment({
          clientId: match?.id ?? null,
          clientName: name,
          nameKey: nameInput.toLowerCase(),
          timestamp: panel.assessmentDate,
          dateLabel: new Date(panel.assessmentDate).toLocaleString([], {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
          }),
          inputs,
          lvl: totals.lvl,
          rank: panel.rank
        });
        await this.loadHistory(panel);
        // Only for a live entry. Backdating is correcting the record, not
        // an achievement happening in the room, and a rank-up takeover for
        // a number from three weeks ago would be a lie about the moment.
        if (!backdate && priorExact !== null) {
          this.levelUp?.playFor(priorExact, totals.exact, panel.sex);
        }
        // Snap back to today-mode so the next calc doesn't keep writing
        // into the past.
        if (backdate) this.toggleBackdate(panel, false);
      } catch (err) {
        console.error('Assessments: save failed', err);
        this.toast('Could not save assessment', 'danger');
      } finally {
        panel.saving = false;
      }
    }
  }

  // Saves whatever is currently in the form as this athlete's goal.
  //
  // Deliberately reuses the assessment form rather than adding a second
  // thirteen-field editor: a goal IS an AssessmentInputs, which is exactly
  // why the mobile app shares its form too. The coach types the numbers
  // they're aiming the athlete at and saves them as a target instead of a
  // result.
  // Switches a panel between Current and Goals — same form, same result
  // display, just what it's reading from and (on Calculate) saving to.
  // Mirrors Project 000's view toggle exactly, including that switching
  // tabs re-renders from whichever record actually exists rather than
  // leaving stale numbers in the form from the other tab.
  setView(panel: Panel, view: 'current' | 'goals') {
    if (panel.view === view) return;
    panel.view = view;
    if (view === 'goals') {
      this.showGoal(panel);
    } else {
      this.showLatest(panel);
    }
  }

  // Goals equivalent of showLatest(panel): renders the most-recently-touched
  // saved goal if any exist, or a blank starting card if not — same
  // "nothing entered yet" treatment resetToFreshAthlete already gives a
  // brand-new athlete. Picking a SPECIFIC one of several goals is
  // selectGoal(), below.
  private showGoal(panel: Panel) {
    if (panel.goal) {
      this.loadGoalIntoForm(panel, panel.goal);
      return;
    }

    panel.goalTargetDate = '';

    // No goal yet: start from where they actually ARE, not a blank form.
    // A coach setting someone's first goal usually wants to nudge a couple
    // of numbers up, not recall all thirteen of their current stats from
    // memory — the whole point of this screen is that the coach shouldn't
    // have to know those by heart.
    const latest = panel.history[panel.history.length - 1];
    if (latest) {
      this.applyInputsToForm(panel, latest.inputs);
      const totals = this.computeOmni(latest.inputs);
      this.renderResult(panel, panel.athleteName.trim() || 'Athlete', latest.inputs, totals);
      return;
    }

    // Genuinely nothing on file for this athlete either way.
    this.resetToFreshAthlete(panel);
  }

  private loadGoalIntoForm(panel: Panel, goal: AssessmentGoal) {
    panel.goalTargetDate = goal.targetDate || '';
    this.applyInputsToForm(panel, goal.inputs);
    const totals = this.computeOmni(goal.inputs);
    this.renderResult(panel, panel.athleteName.trim() || 'Athlete', goal.inputs, totals);
  }

  // Bound to the Goals dropdown (mirrors loadSelectedHistory) — switches
  // which of the athlete's several goals is loaded into the form.
  selectGoal(panel: Panel) {
    const id = panel.selectedGoalId;
    if (!id) { this.startNewGoal(panel); return; }
    const goal = panel.goals.find(g => g.id === id);
    if (!goal) return;
    panel.goal = goal;
    this.loadGoalIntoForm(panel, goal);
  }

  // Deletes whichever goal is currently selected in the dropdown (mirrors
  // deleteSelectedHistory).
  async deleteSelectedGoal(panel: Panel) {
    const id = panel.selectedGoalId;
    if (!id) return;
    try {
      await this.firebase.clearGoal(id);
      panel.goals = panel.goals.filter(g => g.id !== id);
      panel.selectedGoalId = '';
      panel.goal = panel.goals.length
        ? panel.goals.reduce((a, b) => (a.updatedAt || '') >= (b.updatedAt || '') ? a : b)
        : null;
      panel.selectedGoalId = panel.goal?.id || '';
      this.showGoal(panel);
      this.toast('Goal deleted');
    } catch (err) {
      console.error('Assessments: failed to delete goal', err);
      this.toast('Could not delete goal', 'danger');
    }
  }

  // Overwrite whatever's currently typed in the Goals tab with the
  // athlete's most recent real assessment — re-baselining a stale target
  // without deleting it and starting over.
  resetGoalToCurrent(panel: Panel) {
    const latest = panel.history[panel.history.length - 1];
    if (!latest) {
      this.toast('No assessment on record yet', 'warning');
      return;
    }
    this.applyInputsToForm(panel, latest.inputs);
    const totals = this.computeOmni(latest.inputs);
    this.renderResult(panel, panel.athleteName.trim() || 'Athlete', latest.inputs, totals);
    this.toast('Reset to current stats — set a target date and Save Goal');
  }

  // Clears the form to a fresh, unsaved goal starting from current stats —
  // for adding ANOTHER goal (a different target date) without touching any
  // goal already saved. Calculate Goal afterward creates it as a new entry
  // rather than overwriting whichever one was loaded.
  startNewGoal(panel: Panel) {
    panel.selectedGoalId = '';
    panel.goal = null;
    panel.goalTargetDate = '';
    const latest = panel.history[panel.history.length - 1];
    if (latest) {
      this.applyInputsToForm(panel, latest.inputs);
      const totals = this.computeOmni(latest.inputs);
      this.renderResult(panel, panel.athleteName.trim() || 'Athlete', latest.inputs, totals);
    } else {
      this.resetToFreshAthlete(panel);
    }
    this.toast('Set a target date to start a new goal');
  }

  // The Goals-tab Calculate button. Writes to assessmentGoals — one doc per
  // (athlete, target date) — instead of a dated assessment row: no history
  // entry, no backdate, no rank-up takeover, a goal is a target someone
  // chose, not a thing that just happened.
  async calculateGoal(panel: Panel) {
    const nameInput = panel.athleteName.trim();
    if (!nameInput) {
      this.toast('Enter an athlete first', 'warning');
      return;
    }
    const inputs = this.buildInputs(panel.form);
    const totals = this.computeOmni(inputs);
    this.renderResult(panel, nameInput, inputs, totals);

    panel.saving = true;
    try {
      const key = nameInput.toLowerCase();
      const id = await this.firebase.setGoal(key, nameInput, inputs, 'coach', panel.goalTargetDate || undefined);
      panel.goals = await this.firebase.listGoalsForClient(key);
      panel.goal = panel.goals.find(g => g.id === id) || null;
      panel.selectedGoalId = id;
      this.toast('Goal saved');
    } catch (err) {
      console.error('Assessments: goal save failed', err);
      this.toast('Could not save goal', 'danger');
    } finally {
      panel.saving = false;
    }
  }

  // The athlete's current level as a fraction, from whatever is already on
  // file. null when they have no history, in which case a first assessment
  // is a starting point rather than a climb and nothing should fire.
  private latestExactFor(panel: Panel): number | null {
    const prior = panel.history.length ? panel.history[panel.history.length - 1] : null;
    if (!prior) return null;
    return this.computeOmni(prior.inputs).exact;
  }

  // Show the latest saved assessment (display only, no save) — used on client pick.
  private showLatest(panel: Panel) {
    const latest = panel.history[panel.history.length - 1];
    if (!latest) {
      // No assessments for this athlete yet: blank the form (was otherwise
      // left showing whichever client's numbers were entered previously)
      // and present a clean starting card instead of computing anything.
      this.resetToFreshAthlete(panel);
      return;
    }
    panel.selectedHistoryTs = latest.timestamp;
    this.loadSelectedHistory(panel);
  }

  // A brand-new athlete with zero saved assessments. Shows a "Level 1"
  // starting card without running the scoring formulas against blank
  // inputs (some of them are only valid for real, nonzero entries).
  private resetToFreshAthlete(panel: Panel) {
    panel.form = this.blankForm();
    panel.selectedHistoryTs = '';

    panel.result = { H: 0, K: 0, N: 0, Q: 0, U: 0, raw: 0, exact: 0, lvl: 0, xpPct: 0 };
    panel.resultName = (panel.athleteName.trim() || 'Athlete').toUpperCase();
    panel.rank = 'UNRANKED';
    panel.rankColor = this.rankGradientColor(0, panel.sex);
    panel.rankBgColor = this.rankGradientBgColor(0, panel.sex);
    panel.isChroma = isSRank(0, panel.sex);
    panel.rankGrad = panel.isChroma ? this.chroma.gradient : `linear-gradient(${panel.rankColor}, ${panel.rankColor})`;
    panel.rankGlare = panel.isChroma ? this.chroma.glare : 'none';
    panel.showResult = true;
    panel.barSnap = false;
    panel.barWidth = 0;

    panel.subCards = ['Strength', 'Power', 'Endurance', 'Cardio', 'Flexibility'].map(label => ({
      label, value: 0, pct: 0, deltaText: '—', deltaColor: '#4a6378'
    }));
    panel.levelDelta = null;
    panel.compareOptions = [];
    panel.compareTs = '';
    panel.chart = null;
    panel.radarValues = { current: [0, 0, 0, 0, 0], prev: null, prevLabel: '' };
    panel.radar = this.buildRadar(panel);
    panel.opportunities = [];
  }

  // XP bar: grow/shrink from where it currently is instead of resetting to 0.
  // On a level-up, fill to 100, snap back, then grow into the new level.
  private animateBar(panel: Panel, prevShown: { lvl: number; xp: number } | null, totals: OmniResult) {
    const token = ++panel.barAnimToken;
    const alive = () => panel.barAnimToken === token;
    const target = totals.xpPct;

    if (!prevShown) {
      panel.barWidth = 0;
      setTimeout(() => { if (alive()) panel.barWidth = target; }, 50);
      return;
    }
    if (totals.lvl > prevShown.lvl) {
      panel.barWidth = 100;
      setTimeout(() => {
        if (!alive()) return;
        panel.barSnap = true;
        panel.barWidth = 0;
        setTimeout(() => {
          if (!alive()) return;
          panel.barSnap = false;
          panel.barWidth = target;
        }, 60);
      }, 900);
      return;
    }
    // Same or lower level: ease straight from the current width.
    panel.barWidth = target;
  }

  // Everything the result panel shows: hero, sub-cards, chart, recommendations.
  private renderResult(panel: Panel, name: string, inputs: AssessmentInputs, totals: OmniResult) {
    // What the bar is showing right now, so it can grow from there.
    const prevShown = panel.showResult && panel.result
      ? { lvl: panel.result.lvl, xp: panel.barWidth }
      : null;

    panel.result = totals;
    panel.resultName = name.toUpperCase();
    panel.rank = this.getRank(totals.lvl, panel.sex);
    // Same integer level drives both the rank label and its color — using the
    // fractional `totals.exact` here let the color cross a band boundary
    // before the label did (e.g. level 59 showing B-RANK's purple, or 39/40
    // rendering identically), since exact keeps climbing within a level
    // while the displayed label stays put until the next whole number.
    panel.rankColor = this.rankGradientColor(totals.lvl, panel.sex);
    panel.rankBgColor = this.rankGradientBgColor(totals.lvl, panel.sex);
    panel.isChroma = isSRank(totals.lvl, panel.sex);
    panel.rankGrad = panel.isChroma ? this.chroma.gradient : `linear-gradient(${panel.rankColor}, ${panel.rankColor})`;
    panel.rankGlare = panel.isChroma ? this.chroma.glare : 'none';
    panel.showResult = true;
    this.animateBar(panel, prevShown, totals);

    panel.chart = this.buildMiniChart(panel, totals);
    panel.opportunities = this.buildOpportunities(inputs);

    // Comparison baselines = every other saved day, newest first. Reset the
    // chosen baseline to the auto previous whenever a fresh result renders.
    panel.compareOptions = panel.history
      .filter(e => !this.sameDay(e.timestamp, panel.assessmentDate))
      .slice()
      .reverse();
    panel.compareTs = '';
    this.applyComparison(panel);
  }

  // The default baseline: the very first assessment on record (the original).
  private autoPrevEntry(panel: Panel): FitnessAssessment | null {
    if (panel.history.length === 0) return null;
    const currentIdx = panel.history.findIndex(e => this.sameDay(e.timestamp, panel.assessmentDate));
    // Nothing earlier to compare against when the current one IS the first entry.
    if (currentIdx === 0) return null;
    return panel.history[0];
  }

  // The baseline actually compared against (user choice, else auto = original).
  private resolveBaseline(panel: Panel): FitnessAssessment | null {
    if (panel.compareTs) {
      const chosen = panel.history.find(e => e.timestamp === panel.compareTs);
      if (chosen && !this.sameDay(chosen.timestamp, panel.assessmentDate)) return chosen;
    }
    return this.autoPrevEntry(panel);
  }

  // User picked a different comparison date from the radar legend.
  setComparison(panel: Panel, ts: string) {
    panel.compareTs = ts;
    this.applyComparison(panel);
  }

  // Recompute everything that depends on the comparison baseline: category
  // deltas, overall-level delta, and the radar's previous overlay.
  private applyComparison(panel: Panel) {
    const totals = panel.result;
    if (!totals) return;
    const baseline = this.resolveBaseline(panel);
    // Keep the selector in sync with what's actually shown (reflects the auto pick).
    panel.compareTs = baseline ? baseline.timestamp : '';

    panel.subCards = ([
      { l: 'Strength', v: totals.H, t: 'H' as const },
      { l: 'Power', v: totals.K, t: 'K' as const },
      { l: 'Endurance', v: totals.N, t: 'N' as const },
      { l: 'Cardio', v: totals.Q, t: 'Q' as const },
      { l: 'Flexibility', v: totals.U, t: 'U' as const }
    ]).map(s => {
      const delta = this.categoryDelta(s.v, s.t, baseline);
      return {
        label: s.l,
        value: s.v,
        pct: Math.min(Math.max(s.v, 0), 100),
        deltaText: delta.text,
        deltaColor: delta.color
      };
    });

    panel.levelDelta = this.pctDelta(totals.lvl, baseline ? baseline.lvl : null);
    panel.radarValues = this.buildRadarValues(totals, baseline);
    panel.radar = this.buildRadar(panel);
  }

  // Signed percent-change badge (green up / red down / grey flat).
  private pctDelta(curr: number, prev: number | null): { text: string; color: string } | null {
    if (prev == null) return null;
    const diff = curr - prev;
    const pct = (diff / (prev || 1)) * 100;
    const color = diff > 0 ? '#2dd36f' : diff < 0 ? '#ff5a6a' : '#4a6378';
    return { text: `${diff > 0 ? '+' : ''}${pct.toFixed(1)}%`, color };
  }

  // ---------- mini level-progression sparkline ----------
  // Plots every assessment on file — no recent-N cap. Some clients already
  // have 15+ and that count only grows, so date/value labels are thinned to
  // an evenly-spaced subset (see pickLabelIndices) rather than one per
  // point; the line and dots still cover the full history regardless.
  private buildMiniChart(panel: Panel, totals: OmniResult): MiniChart | null {
    // History entries plus the currently shown result (fresh result wins over a
    // stale history doc when re-calculating the same day).
    const entries = panel.history
      .filter(e => !this.sameDay(e.timestamp, panel.assessmentDate))
      .map(e => ({ timestamp: e.timestamp, lvl: e.lvl, current: false }));
    entries.push({ timestamp: panel.assessmentDate, lvl: totals.lvl, current: true });
    entries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    if (entries.length < 2) return null;

    const width = 600, height = 100;
    const padL = 26, padR = 24, padT = 20, padB = 24;
    const usableW = width - padL - padR;
    const usableH = height - padT - padB;

    const lvls = entries.map(e => e.lvl);
    let min = Math.min(...lvls), max = Math.max(...lvls);
    if (min === max) { min -= 2; max += 2; }
    const range = max - min;
    const step = usableW / (entries.length - 1);

    // Dots shrink as they get packed tighter, so a long history reads as a
    // clean line instead of a smear of overlapping circles.
    const dotRadius = entries.length > 40 ? 2 : entries.length > 20 ? 2.5 : entries.length > 12 ? 3 : 3.5;

    const MAX_LABELS = 8;
    const labeledIdx = new Set(this.pickLabelIndices(entries.length, MAX_LABELS));

    const points: ChartPoint[] = entries.map((e, i) => ({
      x: padL + i * step,
      y: padT + (1 - (e.lvl - min) / range) * usableH,
      value: e.lvl,
      current: e.current,
      radius: e.current ? dotRadius + 1.5 : dotRadius,
      showValue: e.current || labeledIdx.has(i)
    }));

    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const xLabels = [...labeledIdx].sort((a, b) => a - b).map(i => {
      const d = new Date(entries[i].timestamp);
      return {
        x: points[i].x,
        label: isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      };
    });

    return { path, points, xLabels };
  }

  // Evenly-spaced indices across [0, count-1], always including both ends,
  // capped at `max` regardless of how large count grows.
  private pickLabelIndices(count: number, max: number): number[] {
    if (count <= max) return Array.from({ length: count }, (_, i) => i);
    const idx = new Set<number>();
    for (let i = 0; i < max; i++) {
      idx.add(Math.round((i * (count - 1)) / (max - 1)));
    }
    return [...idx];
  }

  // ---------- category balance radar (current vs previous) ----------
  private buildRadarValues(totals: OmniResult, prevEntry: FitnessAssessment | null): RadarValues {
    let prev: number[] | null = null;
    let prevLabel = '';
    if (prevEntry) {
      const i = prevEntry.inputs;
      prev = [
        this.calcStrength(i.deadlift, i.squat, i.bench, i.pullup1rm),
        this.calcPower(i.longjump, i.sprint),
        this.calcEndurance(i.pushups, i.pullups),
        this.calcCardio(i.run30, i.speed2),
        this.calcFlex(i.pike, i.backbend, i.straddle)
      ];
      const d = new Date(prevEntry.timestamp);
      prevLabel = isNaN(d.getTime())
        ? 'Previous'
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return { current: [totals.H, totals.K, totals.N, totals.Q, totals.U], prev, prevLabel };
  }

  // View-only toggle between raw 0-100 axes and the adjusted per-axis scale.
  setRadarScale(panel: Panel, normalized: boolean) {
    panel.radarNormalized = normalized;
    panel.radar = this.buildRadar(panel);
  }

  // View-only zoom so small shapes read at ~90% of the radius (never shrinks).
  setRadarFit(panel: Panel, fit: boolean) {
    panel.radarFit = fit;
    panel.radar = this.buildRadar(panel);
  }

  private buildRadar(panel: Panel): RadarChart | null {
    const data = panel.radarValues;
    if (!data) return null;

    const cx = 160, cy = 120, R = 84;
    const angle = (i: number) => ((-90 + i * 72) * Math.PI) / 180;
    const at = (i: number, radius: number) => ({
      x: cx + radius * Math.cos(angle(i)),
      y: cy + radius * Math.sin(angle(i))
    });
    // Fraction of the axis for a value, honoring the per-axis adjusted range.
    const rawFrac = (v: number, i: number) => {
      const min = panel.radarNormalized ? RADAR_AXES[i].min : 0;
      const max = panel.radarNormalized ? RADAR_AXES[i].max : 100;
      const f = ((isFinite(v) ? v : 0) - min) / (max - min);
      return Math.min(Math.max(f, 0), 1);
    };

    // Fit mode: magnify (never shrink) so the biggest axis reads ~90%.
    // Current and previous share the factor so the comparison stays honest.
    let zoom = 1;
    if (panel.radarFit) {
      const fracs = [
        ...data.current.map((v, i) => rawFrac(v, i)),
        ...(data.prev ? data.prev.map((v, i) => rawFrac(v, i)) : [])
      ];
      const maxF = Math.max(...fracs);
      if (maxF > 0 && maxF < 0.9) zoom = 0.9 / maxF;
    }

    const frac = (v: number, i: number) => Math.min(rawFrac(v, i) * zoom, 1);
    const poly = (vals: number[]) =>
      vals.map((v, i) => {
        const p = at(i, frac(v, i) * R);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }).join(' ');

    const labels = RADAR_AXES.map((axis, i) => {
      const p = at(i, R + 14);
      return {
        text: axis.label,
        x: p.x,
        y: p.y + (p.y > cy ? 8 : p.y < cy - R ? 0 : 4),
        anchor: Math.abs(p.x - cx) < 10 ? 'middle' : p.x > cx ? 'start' : 'end'
      };
    });

    return {
      rings: [0.25, 0.5, 0.75, 1].map(t =>
        [0, 1, 2, 3, 4].map(i => { const p = at(i, t * R); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ')
      ),
      axes: [0, 1, 2, 3, 4].map(i => { const p = at(i, R); return { x2: p.x, y2: p.y }; }),
      labels,
      currentPts: poly(data.current),
      currentDots: data.current.map((v, i) => at(i, frac(v, i) * R)),
      prevPts: data.prev ? poly(data.prev) : null,
      prevLabel: data.prevLabel,
      zoom
    };
  }

  private buildOpportunities(inputs: AssessmentInputs): Opportunity[] {
    return this.getTopProgressOpportunities(inputs, ASSESSMENT_META.length).map(o => {
      const direction = o.nextVal > o.current ? 'Increase' : 'Decrease';
      const stepSize = Math.abs(o.nextVal - o.current).toFixed(o.decimals);
      const unitSuffix = o.unit ? ` ${o.unit}` : '';
      return {
        label: o.label,
        detail: `${direction} by ${stepSize}${unitSuffix} (${o.current.toFixed(o.decimals)} → ${o.nextVal.toFixed(o.decimals)})`,
        gain: `${o.gain >= 0 ? '+' : ''}${o.gain.toFixed(2)}`,
        projectedLvl: o.projectedLvl
      };
    });
  }

  trackPoint = (_: number, p: ChartPoint) => p.x;
  trackOpp = (_: number, o: Opportunity) => o.label;
  trackCompare = (_: number, o: FitnessAssessment) => o.timestamp;

  private categoryDelta(curr: number, type: 'H' | 'K' | 'N' | 'Q' | 'U', prevEntry: FitnessAssessment | null): { text: string; color: string } {
    if (!prevEntry) return { text: '—', color: '#4a6378' };
    const i = prevEntry.inputs;
    let prev = 0;
    if (type === 'H') prev = this.calcStrength(i.deadlift, i.squat, i.bench, i.pullup1rm);
    else if (type === 'K') prev = this.calcPower(i.longjump, i.sprint);
    else if (type === 'N') prev = this.calcEndurance(i.pushups, i.pullups);
    else if (type === 'Q') prev = this.calcCardio(i.run30, i.speed2);
    else if (type === 'U') prev = this.calcFlex(i.pike, i.backbend, i.straddle);
    const diff = curr - prev;
    const pct = (diff / (prev || 1)) * 100;
    const color = diff > 0 ? '#2dd36f' : diff < 0 ? '#ff5a6a' : '#4a6378';
    return { text: `${diff > 0 ? '+' : ''}${pct.toFixed(1)}%`, color };
  }

  // ---------- "estimated progression" projections (one step of improvement per test) ----------
  private getTopProgressOpportunities(inputs: AssessmentInputs, limit: number = ASSESSMENT_META.length) {
    const base = this.computeOmni(inputs);
    const best: Array<{ label: string; unit: string; current: number; nextVal: number; gain: number; projectedLvl: number; decimals: number }> = [];

    ASSESSMENT_META.forEach(test => {
      const current = Number((inputs as any)[test.key] || 0);
      const candidates = [current + test.step, current - test.step].filter(v => v >= test.min && v <= test.max);
      let bestForTest: typeof best[number] | null = null;
      candidates.forEach(nextVal => {
        const trialInputs = { ...inputs, [test.key]: nextVal } as AssessmentInputs;
        const trial = this.computeOmni(trialInputs);
        const gain = trial.exact - base.exact;
        if (!bestForTest || gain > bestForTest.gain) {
          bestForTest = { label: test.label, unit: test.unit, current, nextVal, gain, projectedLvl: trial.lvl, decimals: test.decimals };
        }
      });
      // Every test gets an entry unless both step directions fall outside its valid range.
      if (bestForTest) best.push(bestForTest);
    });
    return best.sort((a, b) => b.gain - a.gain).slice(0, limit);
  }

  // ---------- PDF report ----------
  private sparklineRelative(data: (number | null)[], color: string): string {
    const width = 80, height = 24, pad = 4;
    const usableH = height - pad * 2;
    const step = width / 4;
    const validPoints = data.map((v, i) => v === null ? null : { val: v, x: i * step });
    const scores = data.filter((v): v is number => v !== null);
    if (scores.length === 0) return `<svg width="${width}" height="${height}"></svg>`;
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = (max - min) || 1;
    const getTop = (v: number) => height - pad - ((v - min) / range * usableH);
    const pts = validPoints.filter((p): p is { val: number; x: number } => p !== null);
    const polyline = pts.map(p => `${p.x},${getTop(p.val)}`).join(' ');
    return `<svg width="${width}" height="${height}" style="overflow:visible">
      ${[0, 1, 2, 3, 4].map(i => `<line x1="${i * step}" y1="0" x2="${i * step}" y2="${height}" stroke="#f0f0f0" stroke-width="1"/>`).join('')}
      <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
      ${pts.map(p => `<circle cx="${p.x}" cy="${getTop(p.val)}" r="2" fill="${color}" />`).join('')}
    </svg>`;
  }

  private formatWithUnit(value: number, decimals: number, unit: string): string {
    const val = Number(value || 0).toFixed(decimals);
    return unit ? `${val}${unit}` : val;
  }

  private assessmentGraphRow(label: string, current: number, history: (number | null)[], unit: string, color: string, decimals = 1): string {
    const prevVal = history.length > 1 ? history[history.length - 2] : null;
    let changeStr = '—', changeColor = '#aaaaaa';
    if (prevVal !== null && prevVal !== 0) {
      const diff = current - prevVal;
      const pct = (diff / prevVal) * 100;
      const sign = diff > 0 ? '+' : '';
      changeStr = `${sign}${Number(diff).toFixed(decimals)}${unit} (${sign}${this.fmt(pct, 1)}%)`;
      if (diff > 0) changeColor = '#2d8a4e';
      if (diff < 0) changeColor = '#c86e6e';
      if (label.toLowerCase().includes('100m sprint')) {
        if (diff < 0) changeColor = '#2d8a4e';
        else if (diff > 0) changeColor = '#c86e6e';
        else changeColor = '#aaaaaa';
      }
    }
    return `<div style="display:flex; align-items:center; justify-content:space-between; padding:6px 0; border-bottom:1px solid #f2f2f2;">
      <div style="flex:1;">
        <div style="font-family:'Barlow Condensed',sans-serif; font-size:8.5px; font-weight:600; letter-spacing:0.12em; text-transform:uppercase; color:#888888; margin-bottom:1px;">${label}</div>
        <div style="font-family:'Barlow Condensed',sans-serif; font-size:16px; font-weight:600; color:#111114;">${this.formatWithUnit(current, decimals, unit)}</div>
        <div style="font-family:'Barlow Condensed',sans-serif; font-size:9px; color:${changeColor}; font-weight:600; letter-spacing:0.02em;">${changeStr}</div>
      </div>
      <div style="text-align:right;">${this.sparklineRelative(history, color)}</div>
    </div>`;
  }

  private categoryHistoryRow(label: string, currentVal: number, historyArray: (number | null)[], color: string): string {
    const scores = historyArray.filter((v): v is number => v !== null);
    const prevVal = scores.length > 1 ? scores[scores.length - 2] : null;
    let deltaStr = '—', deltaColor = '#aaaaaa';
    if (prevVal !== null && prevVal !== 0) {
      const diff = currentVal - prevVal;
      const pct = (diff / prevVal) * 100;
      deltaStr = `${diff > 0 ? '+' : ''}${this.fmt(diff, 1)} (${diff > 0 ? '+' : ''}${pct.toFixed(1)}%)`;
      deltaColor = diff > 0 ? '#2d8a4e' : diff < 0 ? '#c86e6e' : '#aaaaaa';
    }
    return `<div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-bottom:1px solid #eeeeee">
      <div style="flex:1">
        <div style="font-family:'Barlow Condensed',sans-serif; font-size:10px; font-weight:600; letter-spacing:0.15em; text-transform:uppercase; color:#666666; margin-bottom:1px;">${label}</div>
        <div style="font-family:'Bebas Neue',sans-serif; font-size:22px; color:${color}; letter-spacing:0.05em; line-height:1">${this.fmt(currentVal)}</div>
        <div style="font-family:'Barlow Condensed',sans-serif; font-size:9px; color:${deltaColor}; font-weight:600; letter-spacing:0.02em;">${deltaStr}</div>
      </div>
      <div style="margin-left:20px; text-align:right">${this.sparklineRelative(historyArray, color)}</div>
    </div>`;
  }

  private getProjectedGrowth(history: FitnessAssessment[], currentLvl: number): { m1: string; m6: string; y1: string } {
    if (history.length < 2) return { m1: '—', m6: '—', y1: '—' };
    const relevant = history.slice(-5);
    const first = relevant[0];
    const last = relevant[relevant.length - 1];
    const daysDiff = (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / (1000 * 60 * 60 * 24);
    if (daysDiff <= 0) return { m1: '—', m6: '—', y1: '—' };
    const dailyRate = (last.lvl - first.lvl) / daysDiff;
    const formatProjected = (days: number) => {
      const val = Math.max(0, currentLvl + dailyRate * days).toFixed(0);
      return `<span style="font-size:10px; color:#aaa; margin-right:2px; vertical-align:middle">lvl</span>${val}`;
    };
    return { m1: formatProjected(30), m6: formatProjected(182), y1: formatProjected(365) };
  }

  openPdf(panel: Panel) {
    if (!panel.result) return;
    const r = panel.result;
    const c = panel.rankColor;
    const name = panel.resultName;
    const lastFive = panel.history.slice(-5);

    const getTestHistory = (key: string): (number | null)[] => {
      const vals = lastFive.map(e => (e.inputs as any)[key] || 0);
      return [...Array(5 - vals.length).fill(null), ...vals];
    };
    const getCatHistory = (type: 'H' | 'K' | 'N' | 'Q' | 'U'): (number | null)[] =>
      lastFive.map(e => {
        const i = e.inputs;
        if (type === 'H') return this.calcStrength(i.deadlift, i.squat, i.bench, i.pullup1rm);
        if (type === 'K') return this.calcPower(i.longjump, i.sprint);
        if (type === 'N') return this.calcEndurance(i.pushups, i.pullups);
        if (type === 'Q') return this.calcCardio(i.run30, i.speed2);
        return this.calcFlex(i.pike, i.backbend, i.straddle);
      });

    const catHist = { H: getCatHistory('H'), K: getCatHistory('K'), N: getCatHistory('N'), Q: getCatHistory('Q'), U: getCatHistory('U') };
    const projections = this.getProjectedGrowth(panel.history, r.lvl);
    const inputs = this.buildInputs(panel.form);
    const topOpportunities = this.getTopProgressOpportunities(inputs, 5);
    const topOpportunitiesHtml = topOpportunities.length
      ? topOpportunities.map((o, idx) => {
          const direction = o.nextVal > o.current ? 'Increase' : 'Decrease';
          const stepSize = Math.abs(o.nextVal - o.current).toFixed(o.decimals);
          const currentVal = o.current.toFixed(o.decimals);
          const nextVal = o.nextVal.toFixed(o.decimals);
          const unitSuffix = o.unit ? ` ${o.unit}` : '';
          return `<div style="display:grid;grid-template-columns:18px 1fr auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #ededed;">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:12px;color:#999999;line-height:1;">${idx + 1}</div>
            <div>
              <div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#666666;">${o.label}</div>
              <div style="font-family:'Barlow Condensed',sans-serif;font-size:9px;color:#999999;">${direction} by ${stepSize}${unitSuffix} (${currentVal} → ${nextVal})</div>
            </div>
            <div style="text-align:right;">
              <div style="font-family:'Bebas Neue',sans-serif;font-size:16px;line-height:1;color:${c};">+${o.gain.toFixed(2)}</div>
              <div style="font-family:'Barlow Condensed',sans-serif;font-size:8px;color:#999999;letter-spacing:0.08em;text-transform:uppercase;">to lvl ${o.projectedLvl}</div>
            </div>
          </div>`;
        }).join('')
      : `<div style="font-family:'Barlow Condensed',sans-serif;font-size:10px;color:#999999;">Add another assessment to generate top impact recommendations.</div>`;

    const testBreakdown = [
      { l: 'Deadlift', k: 'deadlift', u: ' lbs', d: 0 }, { l: 'Squat', k: 'squat', u: ' lbs', d: 0 }, { l: 'Bench', k: 'bench', u: ' lbs', d: 0 }, { l: 'Pull-up 1RM', k: 'pullup1rm', u: ' lbs', d: 0 },
      { l: 'Long Jump', k: 'longjump', u: ' in', d: 0 }, { l: '100m Sprint', k: 'sprint', u: ' sec', d: 2 }, { l: 'Pushups', k: 'pushups', u: ' reps', d: 0 }, { l: 'Pull-ups', k: 'pullups', u: ' reps', d: 0 },
      { l: '30 Min Run', k: 'run30', u: ' km', d: 2 }, { l: '2 Min Speed', k: 'speed2', u: ' km', d: 3 }, { l: 'Pike', k: 'pike', u: '', d: 0 }, { l: 'Backbend', k: 'backbend', u: '', d: 0 }, { l: 'Straddle', k: 'straddle', u: ' deg', d: 0 }
    ].map(t => this.assessmentGraphRow(t.l, (inputs as any)[t.k], getTestHistory(t.k), t.u, c, t.d)).join('');

    const dateLabel = new Date(panel.assessmentDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const html = `
      <div style="display:flex;align-items:baseline;justify-content:space-between;border-bottom:1px solid #e0e0e0;padding-bottom:14px;margin-bottom:24px">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:26px;letter-spacing:0.1em;color:#00d4ff">ASSESSMENTS</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.25em;text-transform:uppercase;color:#888888">Performance Assessment Report</div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:42px;letter-spacing:0.04em;line-height:1;color:#111114">${name}</div>
        <div style="font-family:'Bebas Neue',sans-serif;font-size:11px;letter-spacing:0.25em;padding:4px 12px;border:1px solid ${c};color:${c}">${panel.rank}</div>
      </div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:6px">
        <span style="font-family:'Barlow Condensed',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.25em;text-transform:uppercase;color:#666666">CURRENT LEVEL</span>
        <span style="font-family:'Bebas Neue',sans-serif;font-size:46px;line-height:1;color:${c}">${this.dispLvl(r.lvl)}</span>
      </div>
      <div style="height:3px;background:#e0e0e0;margin-top:4px;margin-bottom:18px">
        <div style="height:100%;width:${r.xpPct.toFixed(1)}%;background:${c}"></div>
      </div>
      <div style="display:grid;grid-template-columns: 1fr 1.3fr; gap:35px; flex:1">
        <div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:0.16em;color:#888888;margin-bottom:10px;border-bottom:1px solid #eeeeee;padding-bottom:5px">CATEGORY PERFORMANCE</div>
          ${this.categoryHistoryRow('Strength', r.H, catHist.H, c)}
          ${this.categoryHistoryRow('Power', r.K, catHist.K, c)}
          ${this.categoryHistoryRow('Endurance', r.N, catHist.N, c)}
          ${this.categoryHistoryRow('Cardio', r.Q, catHist.Q, c)}
          ${this.categoryHistoryRow('Flexibility', r.U, catHist.U, c)}
          <div style="margin-top:16px; padding:12px; background:#f9f9f9; border-left:3px solid ${c};">
            <div style="font-family:'Bebas Neue',sans-serif; font-size:12px; letter-spacing:0.16em; color:#888888; margin-bottom:12px;">PROJECTED GROWTH</div>
            <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:15px;">
              <div><div style="font-family:'Barlow Condensed',sans-serif; font-size:9px; font-weight:600; color:#aaaaaa;">1 MO</div><div style="font-family:'Bebas Neue',sans-serif; font-size:22px; color:#111114;">${projections.m1}</div></div>
              <div><div style="font-family:'Barlow Condensed',sans-serif; font-size:9px; font-weight:600; color:#aaaaaa;">6 MO</div><div style="font-family:'Bebas Neue',sans-serif; font-size:22px; color:#111114;">${projections.m6}</div></div>
              <div><div style="font-family:'Barlow Condensed',sans-serif; font-size:9px; font-weight:600; color:#aaaaaa;">1 YR</div><div style="font-family:'Bebas Neue',sans-serif; font-size:22px; color:${c};">${projections.y1}</div></div>
            </div>
          </div>
          <div style="margin-top:12px; padding:12px; background:#f9f9f9; border-left:3px solid ${c};">
            <div style="font-family:'Bebas Neue',sans-serif; font-size:12px; letter-spacing:0.16em; color:#888888; margin-bottom:8px;">HIGHEST LEVEL IMPACT (TOP 5)</div>
            ${topOpportunitiesHtml}
          </div>
        </div>
        <div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:12px;letter-spacing:0.16em;color:#888888;margin-bottom:10px;border-bottom:1px solid #eeeeee;padding-bottom:5px">INDIVIDUAL PROGRESSION</div>
          ${testBreakdown}
        </div>
      </div>
      <div style="margin-top:auto;padding-top:12px;border-top:1px solid #eeeeee;font-family:'Barlow Condensed',sans-serif;font-size:9px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#aaaaaa;text-align:center">
        ASSESSMENTS &nbsp;·&nbsp; ${dateLabel} &nbsp;·&nbsp; Project [000]
      </div>`;

    this.pdfPanel = panel;
    this.pdfOpen = true;
    // Inject after the modal renders (ViewChild exists) and the layout has a real
    // size — two rAFs so the flex container is measured, not zero.
    requestAnimationFrame(() => {
      if (this.pdfPage) this.pdfPage.nativeElement.innerHTML = html;
      requestAnimationFrame(() => this.scaleToFit());
    });
  }

  private scaleToFit() {
    const wrap = this.pdfScaleWrap?.nativeElement;
    const scroll = this.pdfScroll?.nativeElement;
    if (!wrap || !scroll || scroll.clientWidth < 50 || scroll.clientHeight < 50) return;
    const scaleX = (scroll.clientWidth - 40) / 794;
    const scaleY = (scroll.clientHeight - 40) / 1123;
    const scale = Math.min(scaleX, scaleY, 1);
    wrap.style.transform = `scale(${scale})`;
    wrap.style.transformOrigin = 'top center';
    wrap.style.marginBottom = -(1123 - 1123 * scale) + 'px';
  }

  closePdf() {
    this.pdfOpen = false;
  }

  async downloadPdf() {
    const page = this.pdfPage?.nativeElement;
    const panel = this.pdfPanel;
    if (!page || !panel?.result) return;
    try {
      const canvas = await html2canvas(page, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
      const pdf = new jsPDF({ unit: 'px', format: [794, 1123], orientation: 'portrait' });
      pdf.addImage(canvas.toDataURL('image/jpeg', 1), 'JPEG', 0, 0, 794, 1123);
      const safeName = (panel.resultName || 'athlete')
        .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
      pdf.save(`omni_report_${safeName || 'athlete'}_${this.dispLvl(panel.result.lvl)}.pdf`);
    } catch (err) {
      console.error('Assessments: PDF export failed', err);
      this.toast('PDF export failed', 'danger');
    }
  }

  private async toast(message: string, color: 'success' | 'warning' | 'danger' = 'success') {
    const t = await this.toastController.create({ message, duration: 1800, position: 'bottom', color });
    await t.present();
  }
}
