import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonContent, IonIcon, ToastController, AlertController } from '@ionic/angular/standalone';
import { FirebaseService, Announcement, AnnouncementAction, CompetitionEvent, EventRegistration, EventStatus, EventMinRank, EventBackdrop, EventFloat, EventAudience, EventTimeSlot, formatSlot, EventCopyKey, EVENT_COPY_DEFAULTS } from '../services/firebase.service';

// What the athlete app's World page and registration flow are built from. Create
// an event here, publish it, and it shows up in the app — no app update needed.
// The soonest published event that hasn't ended is the one the World page features.
// A neutral starting point that suits a hike or a cruise as well as a competition.
// (Edit them per event: a competition would add its judging and testing rules here.)
const DEFAULT_RULES = [
  'I will follow the event guidelines and the instructions of event staff.',
  'The details I provide are accurate and I am able to take part.'
];

// The World page hero is a tall panel (the card plus extra picture above it that
// you scroll up into), so pictures are cropped to that tall shape and always fill it.
export const IMAGE_W = 1080;
export const IMAGE_H = 1960;

type PreviewScreen = 'world' | 'intro' | 'details' | 'rules' | 'review' | 'done';

interface EventForm {
  id?: string;
  title: string;
  audience: EventAudience;
  copy: Partial<Record<EventCopyKey, string>>;
  timeSelection: boolean;
  slots: Array<{ id: string; date: string; start: string; end: string; label: string }>;
  backdrop: EventBackdrop;
  float: EventFloat;
  image: string;                // data URL, already cropped to IMAGE_W × IMAGE_H
  caption: string;
  status: EventStatus;
  description: string;
  startDate: string;
  endDate: string;
  prizePool: number | null;
  venueName: string;
  venueAddress: string;
  multiSite: boolean;           // a different venue each day
  days: Array<{ date: string; venueName: string; venueAddress: string }>;
  registrationOpen: boolean;
  minRank: EventMinRank;
  fee: number | null;
  capacity: number | null;
  guestsPerCompetitor: number | null;
  rulesText: string;
}

@Component({
  selector: 'app-events',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon],
  templateUrl: './events.page.html',
  styleUrls: ['./events.page.scss']
})
export class EventsPage implements OnInit {
  // Two tabs on one page: the events, and the announcements shown above them.
  tab: 'events' | 'announcements' | 'order' | 'testers' = 'events';

  // ---- testers (who "Testers only" shows to) ----
  members: Array<{ nameKey: string; clientName: string }> = [];
  testerKeys: string[] = [];
  testerPick = '';

  async openTesters() {
    this.tab = 'testers';
    [this.members, this.testerKeys] = await Promise.all([this.firebase.listMemberNames(), this.firebase.getTesters()]);
  }

  testerName(key: string): string { return this.members.find(m => m.nameKey === key)?.clientName ?? key; }
  get testerChoices() { return this.members.filter(m => !this.testerKeys.includes(m.nameKey)); }

  async addTester() {
    if (!this.testerPick || this.testerKeys.includes(this.testerPick)) return;
    const next = [...this.testerKeys, this.testerPick];
    await this.saveTesters(next);
    this.testerPick = '';
  }

  async removeTester(key: string) { await this.saveTesters(this.testerKeys.filter(k => k !== key)); }

  private async saveTesters(next: string[]) {
    try { await this.firebase.setTesters(next); this.testerKeys = next; this.toast('Testers saved'); }
    catch { this.toast('Could not save the testers', 'danger'); }
  }

  // ---- World page order ----
  orderItems: Array<{ kind: 'event' | 'announcement'; id: string; title: string; sub: string }> = [];
  dragFrom = -1;
  dragOver = -1;

  // The same list the athlete app builds: published events that haven't ended, plus
  // every announcement, in the saved order (anything not ordered yet goes last).
  buildOrder() {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const evs = this.events
      .filter(e => e.status === 'published' && (e.endDate || e.startDate || '9999-12-31') >= key)
      .sort((a, b) => (a.startDate || '9999').localeCompare(b.startDate || '9999'))
      .map((e, i) => ({ kind: 'event' as const, id: e.id!, title: e.title, sub: this.dates(e), order: e.order ?? 10_000 + i }));
    const anns = this.announcements
      .map((a, i) => ({ kind: 'announcement' as const, id: a.id!, title: a.title, sub: a.body.length > 70 ? a.body.slice(0, 70) + '…' : a.body, order: a.order ?? 20_000 + i }));
    this.orderItems = [...evs, ...anns].sort((x, y) => x.order - y.order);
  }

  openOrder() { this.buildOrder(); this.tab = 'order'; }

  onDragStart(i: number) { this.dragFrom = i; }
  onDragOver(ev: DragEvent, i: number) { ev.preventDefault(); this.dragOver = i; }
  onDragEnd() { this.dragFrom = -1; this.dragOver = -1; }
  async onDrop(ev: DragEvent, to: number) {
    ev.preventDefault();
    const from = this.dragFrom;
    this.onDragEnd();
    if (from >= 0 && from !== to) await this.moveOrder(from, to);
  }

  async moveOrder(from: number, to: number) {
    if (to < 0 || to >= this.orderItems.length) return;
    const [it] = this.orderItems.splice(from, 1);
    this.orderItems.splice(to, 0, it);
    try {
      await this.firebase.saveWorldOrder(this.orderItems);
      this.events.forEach(e => { const i = this.orderItems.findIndex(x => x.kind === 'event' && x.id === e.id); if (i >= 0) e.order = i; });
      this.announcements.forEach(a => { const i = this.orderItems.findIndex(x => x.kind === 'announcement' && x.id === a.id); if (i >= 0) a.order = i; });
      this.toast('Order saved');
    } catch {
      this.toast('Could not save the order', 'danger');
    }
  }

  // ---- announcements ----
  readonly titleMax = FirebaseService.ANNOUNCEMENT_TITLE_MAX;
  readonly bodyMax = FirebaseService.ANNOUNCEMENT_BODY_MAX;
  announcements: Announcement[] = [];
  annLoading = true;
  annTitle = '';
  annBody = '';
  annEditingId: string | null = null;
  annSaving = false;
  annAudience: EventAudience = 'everyone';
  annNotify = false;
  annActionType: 'none' | 'link' | 'event' | 'vote' = 'none';
  annLabel = '';
  annUrl = '';
  annEventId = '';
  annOptions: string[] = ['', ''];
  annError = '';
  readonly labelMax = 20;
  readonly optionMax = 40;
  readonly actionTypes: Array<{ value: 'none' | 'link' | 'event' | 'vote'; label: string; note: string }> = [
    { value: 'none', label: 'No button', note: 'Just the message' },
    { value: 'link', label: 'More info', note: 'Opens a web link' },
    { value: 'event', label: 'Register', note: 'Opens an event’s registration' },
    { value: 'vote', label: 'Vote now', note: 'A question with options' }
  ];
  private readonly defaultLabels = { link: 'More info', event: 'Register', vote: 'Vote now' };
  // Tally of votes per announcement id: counts for each option.
  voteCounts: Record<string, number[]> = {};

  events: Array<CompetitionEvent & { registered: number }> = [];
  isLoading = true;

  form: EventForm | null = null;
  registrations: EventRegistration[] = [];
  isSaving = false;

  readonly ranks: Array<{ value: EventMinRank; label: string }> = [
    { value: 'UNRANKED', label: 'Everyone' },
    { value: 'D-RANK', label: 'D-Rank and up' },
    { value: 'C-RANK', label: 'C-Rank and up' },
    { value: 'B-RANK', label: 'B-Rank and up' },
    { value: 'A-RANK', label: 'A-Rank and up' },
    { value: 'S-RANK', label: 'S-Rank only' }
  ];

  constructor(private firebase: FirebaseService, private toasts: ToastController, private alerts: AlertController) {}

  async ngOnInit() {
    if (new URLSearchParams(location.search).get('tab') === 'announcements') this.tab = 'announcements';
    await Promise.all([this.load(), this.loadAnnouncements()]);
  }

  private async loadAnnouncements() {
    this.annLoading = true;
    try {
      this.announcements = await this.firebase.listAnnouncements();
      // Tally each vote announcement's results.
      for (const a of this.announcements.filter(x => x.action?.type === 'vote' && x.id)) {
        const votes = await this.firebase.listVotes(a.id!);
        const counts = (a.action!.options ?? []).map(() => 0);
        votes.forEach(v => { if (counts[v.option] !== undefined) counts[v.option]++; });
        this.voteCounts[a.id!] = counts;
      }
    } finally { this.annLoading = false; }
  }

  // Picking a button type fills in its usual label (unless one was typed).
  setActionType(t: 'none' | 'link' | 'event' | 'vote') {
    const wasDefault = !this.annLabel || Object.values(this.defaultLabels).includes(this.annLabel);
    this.annActionType = t;
    if (t !== 'none' && wasDefault) this.annLabel = this.defaultLabels[t];
  }
  addOption() { if (this.annOptions.length < 6) this.annOptions.push(''); }
  removeOption(i: number) { if (this.annOptions.length > 2) this.annOptions.splice(i, 1); }
  trackIdx(i: number) { return i; }
  totalVotes(a: Announcement): number { return (this.voteCounts[a.id ?? ''] ?? []).reduce((n, c) => n + c, 0); }

  // An older announcement that's over the limit must be shortened before it can be saved.
  get canPost(): boolean {
    return !!this.annTitle.trim() && !!this.annBody.trim() && !this.annSaving
      && this.annTitle.length <= this.titleMax && this.annBody.length <= this.bodyMax
      && !this.actionProblem;
  }

  // Why the button settings can't be saved yet, if they can't.
  get actionProblem(): string {
    const t = this.annActionType;
    if (t === 'none') return '';
    if (!this.annLabel.trim()) return 'Give the button a label.';
    if (t === 'link' && !/^https?:\/\/\S+\.\S+/i.test(this.annUrl.trim())) return 'Enter a full web address starting with https://';
    if (t === 'event' && !this.annEventId) return 'Choose which event the button opens.';
    if (t === 'vote' && this.annOptions.filter(o => o.trim()).length < 2) return 'A vote needs at least two options.';
    return '';
  }

  private buildAction(): AnnouncementAction | null {
    const t = this.annActionType;
    if (t === 'none') return null;
    const label = this.annLabel.trim().slice(0, this.labelMax);
    if (t === 'link') return { type: 'link', label, url: this.annUrl.trim() };
    if (t === 'event') return { type: 'event', label, eventId: this.annEventId };
    return { type: 'vote', label, options: this.annOptions.map(o => o.trim().slice(0, this.optionMax)).filter(Boolean) };
  }

  editAnnouncement(a: Announcement) {
    this.annEditingId = a.id ?? null;
    this.annTitle = a.title;
    this.annBody = a.body;
    this.annAudience = a.audience ?? 'everyone';
    this.annNotify = !!a.notify;
    const x = a.action;
    this.annActionType = x?.type ?? 'none';
    this.annLabel = x?.label ?? '';
    this.annUrl = x?.url ?? '';
    this.annEventId = x?.eventId ?? '';
    this.annOptions = x?.options?.length ? [...x.options] : ['', ''];
    document.querySelector<HTMLIonContentElement>('app-events ion-content')?.scrollToTop(200);
  }

  cancelAnnouncementEdit() {
    this.annEditingId = null; this.annTitle = ''; this.annBody = '';
    this.annAudience = 'everyone'; this.annNotify = false; this.annActionType = 'none';
    this.annLabel = ''; this.annUrl = ''; this.annEventId = ''; this.annOptions = ['', ''];
  }

  async saveAnnouncement() {
    if (!this.canPost) return;
    this.annSaving = true;
    try {
      const draft = { title: this.annTitle, body: this.annBody, audience: this.annAudience, notify: this.annNotify, action: this.buildAction() };
      if (this.annEditingId) await this.firebase.updateAnnouncement(this.annEditingId, draft);
      else await this.firebase.addAnnouncement(draft);
      const edited = !!this.annEditingId;
      this.cancelAnnouncementEdit();
      await this.loadAnnouncements();
      this.toast(edited ? 'Announcement updated' : 'Announcement posted');
    } catch {
      this.toast('Could not save', 'danger');
    } finally {
      this.annSaving = false;
    }
  }

  async removeAnnouncement(a: Announcement) {
    if (!a.id) return;
    const alert = await this.alerts.create({
      header: 'Delete announcement?',
      message: a.title,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: async () => {
          await this.firebase.deleteAnnouncement(a.id!);
          if (this.annEditingId === a.id) this.cancelAnnouncementEdit();
          await this.loadAnnouncements();
        } }
      ]
    });
    await alert.present();
  }

  private async load() {
    this.isLoading = true;
    try {
      const list = await this.firebase.listEvents();
      this.events = await Promise.all(list.map(async e => ({ ...e, registered: await this.firebase.countEventRegistrations(e.id!) })));
    } finally {
      this.isLoading = false;
    }
  }

  // ---- list ----
  dates(e: CompetitionEvent): string {
    if (!e.startDate) return 'No date set';
    return e.endDate && e.endDate !== e.startDate ? `${e.startDate} → ${e.endDate}` : e.startDate;
  }

  // ---- editor ----
  private toForm(e: CompetitionEvent): EventForm {
    return {
      id: e.id,
      title: e.title ?? '',
      audience: e.audience ?? 'everyone',
      copy: { ...(e.copy ?? {}) },
      timeSelection: e.timeSelection !== false,
      slots: (e.timeSlots ?? []).map(t => ({ id: t.id, date: t.date ?? '', start: t.start, end: t.end ?? '', label: t.label ?? '' })),
      backdrop: e.backdrop ?? (e.image ? 'photo' : 'rank'),
      float: e.float ?? (e.ticker ? 'zeros' : 'none'),
      image: e.image ?? '',
      caption: e.caption ?? '',
      status: e.status ?? 'draft',
      description: e.description ?? '',
      startDate: e.startDate ?? '',
      endDate: e.endDate ?? '',
      prizePool: e.prizePool ?? null,
      venueName: e.venueName ?? '',
      venueAddress: e.venueAddress ?? '',
      multiSite: (e.days?.length ?? 0) > 1,
      days: (e.days ?? []).map(d => ({ date: d.date, venueName: d.venueName ?? '', venueAddress: d.venueAddress ?? '' })),
      registrationOpen: e.registrationOpen !== false,
      minRank: e.minRank ?? 'UNRANKED',
      fee: e.fee ?? null,
      capacity: e.capacity ?? null,
      guestsPerCompetitor: e.guestsPerCompetitor ?? null,
      rulesText: (e.rules ?? []).join('\n')
    };
  }

  newEvent() {
    this.registrations = [];
    this.form = this.toForm({
      title: '', status: 'draft', registrationOpen: true, minRank: 'C-RANK', fee: 55,
      guestsPerCompetitor: 2, rules: DEFAULT_RULES
    });
    this.scrollTop();
  }

  async edit(e: CompetitionEvent) {
    this.form = this.toForm(e);
    this.registrations = [];
    this.scrollTop();
    this.registrations = await this.firebase.listEventRegistrations(e.id!);
  }

  duplicate(e: CompetitionEvent) {
    this.registrations = [];
    this.form = { ...this.toForm(e), id: undefined, status: 'draft', title: `${e.title} (copy)` };
    this.scrollTop();
  }

  // Switching to per-day venues starts from what's already filled in.
  setMultiSite(on: boolean) {
    const f = this.form;
    if (!f) return;
    f.multiSite = on;
    if (on && f.days.length < 2) {
      f.days = [
        { date: f.startDate, venueName: f.venueName, venueAddress: f.venueAddress },
        { date: f.endDate, venueName: '', venueAddress: '' }
      ];
    }
  }

  addDay() { this.form?.days.push({ date: '', venueName: '', venueAddress: '' }); }
  removeDay(i: number) { if (this.form && this.form.days.length > 2) this.form.days.splice(i, 1); }

  readonly audiences: Array<{ value: EventAudience; label: string; note: string }> = [
    { value: 'everyone', label: 'Everyone', note: 'Every athlete sees it' },
    { value: 'academy', label: 'Academy', note: 'Athletes with a designation (000, 001…)' },
    { value: 'inperson', label: 'In-person clients', note: 'Only your facility’s in-person clients' },
    { value: 'testers', label: 'Testers only', note: 'Only the people on the Testers tab' }
  ];

  audienceLabel(a?: EventAudience): string { return this.audiences.find(x => x.value === (a ?? 'everyone'))!.label; }

  readonly backdrops: Array<{ value: EventBackdrop; label: string; note: string }> = [
    { value: 'rank', label: 'Rank color', note: 'Gradient in each athlete’s rank color' },
    { value: 'aurora', label: 'Aurora', note: 'Slow drifting glow in the rank color' },
    { value: 'spotlight', label: 'Spotlight', note: 'A beam from above in the rank color' },
    { value: 'chrome', label: 'Chrome', note: 'The moving S-Rank chrome' },
    { value: 'midnight', label: 'Midnight', note: 'Flat dark' },
    { value: 'dusk', label: 'Dusk', note: 'Purple to orange sunset' },
    { value: 'deep', label: 'Deep', note: 'Deep blue to teal' },
    { value: 'mountains', label: 'Mountains', note: 'Layered ridges at dusk' },
    { value: 'snowpeaks', label: 'Snowy mountains', note: 'Snow-capped peaks' },
    { value: 'foliage', label: 'Foliage mountains', note: 'Autumn-colored hills' },
    { value: 'dawn', label: 'Dawn', note: 'Soft dawn sky' },
    { value: 'day', label: 'Day', note: 'Clear blue sky' },
    { value: 'night', label: 'Night', note: 'Dark blue night sky' },
    { value: 'photo', label: 'My photo', note: 'Your picture, shown as-is' }
  ];

  // What can drift over a backdrop (not over a photo).
  readonly floats: Array<{ value: EventFloat; label: string }> = [
    { value: 'none', label: 'Nothing' },
    { value: 'zeros', label: 'Ghosted 000' },
    { value: 'dust', label: 'Dust' },
    { value: 'embers', label: 'Embers' },
    { value: 'rings', label: 'Rings' },
    { value: 'stars', label: 'Stars' },
    { value: 'bubbles', label: 'Bubbles' },
    { value: 'steam', label: 'Steam' },
    { value: 'snow', label: 'Snow' },
    { value: 'fireflies', label: 'Fireflies' }
  ];
  readonly scenes: EventBackdrop[] = ['mountains', 'snowpeaks', 'foliage', 'dawn', 'day', 'night'];
  readonly fxItems = Array.from({ length: 18 }, (_, i) => ({
    x: (i * 29 + 7) % 96, y: (i * 53 + 11) % 88, s: 2 + (i % 3), d: 10 + (i * 7) % 11, w: -((i * 5) % 13)
  }));
  // ---- wording ----
  readonly copyDefaults = EVENT_COPY_DEFAULTS;
  readonly copyFields: Array<{ key: EventCopyKey; label: string; long?: boolean; max: number; screen: PreviewScreen }> = [
    { key: 'reserveButton', label: 'World page button', max: 24, screen: 'world' },
    { key: 'prizeLabel', label: 'World page: prize pool label', max: 28, screen: 'world' },
    { key: 'participantWord', label: 'What to call attendees (Participant, Competitor, Hiker…)', max: 20, screen: 'review' },
    { key: 'guestsWord', label: 'What to call guests (Guests, Spectators, Companions…)', max: 20, screen: 'intro' },
    { key: 'feeLabel', label: 'What to call the fee (Entry fee, Ticket price, Cost…)', max: 20, screen: 'intro' },
    { key: 'introTitle', label: 'First screen: title', max: 40, screen: 'intro' },
    { key: 'startButton', label: 'First screen: button', max: 24, screen: 'intro' },
    { key: 'detailsTitle', label: 'Details screen: title', max: 40, screen: 'details' },
    { key: 'detailsLead', label: 'Details screen: description', long: true, max: 140, screen: 'details' },
    { key: 'rulesTitle', label: 'Rules screen: title', max: 40, screen: 'rules' },
    { key: 'rulesLead', label: 'Rules screen: description', long: true, max: 140, screen: 'rules' },
    { key: 'reviewTitle', label: 'Review screen: title', max: 40, screen: 'review' },
    { key: 'reviewLead', label: 'Review screen: description', long: true, max: 140, screen: 'review' },
    { key: 'continueButton', label: 'Continue button', max: 24, screen: 'details' },
    { key: 'confirmButton', label: 'Confirm button', max: 24, screen: 'review' },
    { key: 'doneTitle', label: 'Confirmation: title', max: 40, screen: 'done' },
    { key: 'receivedTitle', label: 'Confirmation, payment due: title', max: 40, screen: 'done' }
  ];

  // Only wording that was actually typed is saved; blank means "use the default".
  private cleanCopy(copy: Partial<Record<EventCopyKey, string>>): Partial<Record<EventCopyKey, string>> {
    const out: Partial<Record<EventCopyKey, string>> = {};
    (Object.keys(copy) as EventCopyKey[]).forEach(k => { const v = copy[k]?.trim(); if (v) out[k] = v; });
    return out;
  }

  // The wording shown in the preview: what's typed, or the default.
  c(key: EventCopyKey): string { return this.form?.copy[key]?.trim() || EVENT_COPY_DEFAULTS[key]; }

  // ---- phone preview (mirrors the World page's hero panel) ----
  // The preview can step through the same screens an athlete sees: tap "Reserve your
  // spot" in it to open the registration, then go through each screen.
  previewScreen: PreviewScreen = 'world';
  readonly previewScreens: Array<{ id: PreviewScreen; label: string }> = [
    { id: 'world', label: 'World' }, { id: 'intro', label: 'Event' }, { id: 'details', label: 'Details' },
    { id: 'rules', label: 'Rules' }, { id: 'review', label: 'Review' }, { id: 'done', label: 'Confirmed' }
  ];
  nextScreen() {
    const order = this.previewScreens.map(s => s.id);
    const i = order.indexOf(this.previewScreen);
    this.previewScreen = order[Math.min(order.length - 1, i + 1)];
  }
  get previewFee(): number { return this.form?.fee && this.form.fee > 0 ? Number(this.form.fee) : 0; }
  get previewRules(): string[] { return (this.form?.rulesText ?? '').split('\n').map(r => r.trim()).filter(Boolean); }
  get previewWhere(): string {
    const f = this.form;
    if (!f) return '';
    return f.multiSite ? f.days.map(d => d.venueName).filter(Boolean).join(' / ') : [f.venueName, f.venueAddress].filter(Boolean).join(', ');
  }
  get previewTimes(): string[] { return (this.form?.slots ?? []).filter(s => s.start).map(s => formatSlot({ id: s.id, date: s.date, start: s.start, end: s.end, label: s.label })); }
  previewRank: 'D' | 'C' | 'B' | 'A' | 'S' = 'D';
  readonly previewRanks: Array<'D' | 'C' | 'B' | 'A' | 'S'> = ['D', 'C', 'B', 'A', 'S'];
  private readonly rankAccent = { D: '#3ecf6e', C: '#38a8e8', B: '#a066e8', A: '#e0453a', S: '#9fd6c8' };
  readonly chromeRamp = 'linear-gradient(115deg, #ac8dcf 0%, #7fa8d8 28%, #8fd0c0 52%, #d9c98a 76%, #d79fa8 100%)';

  get previewAccent(): string { return this.rankAccent[this.previewRank]; }

  get previewDates(): string {
    const f = this.form;
    const days = f?.multiSite ? f.days.filter(d => d.date).map(d => d.date).sort() : [];
    const a = days.length ? days[0] : f?.startDate;
    const b = days.length ? days[days.length - 1] : f?.endDate;
    if (!a) return '';
    const start = new Date(a + 'T00:00:00');
    if (!isFinite(start.getTime())) return '';
    const end = b ? new Date(b + 'T00:00:00') : null;
    const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long' });
    if (end && isFinite(end.getTime()) && end.getTime() > start.getTime()) {
      return end.getMonth() === start.getMonth() && end.getFullYear() === start.getFullYear()
        ? `${month(start)} ${start.getDate()}–${end.getDate()}, ${start.getFullYear()}`
        : `${month(start)} ${start.getDate()} – ${month(end)} ${end.getDate()}, ${end.getFullYear()}`;
    }
    return `${month(start)} ${start.getDate()}, ${start.getFullYear()}`;
  }

  get previewDaysToGo(): number | null {
    const f = this.form;
    const d = (f?.multiSite ? f.days.filter(x => x.date).map(x => x.date).sort()[0] : f?.startDate) || '';
    if (!d) return null;
    const ms = new Date(d + 'T00:00:00').getTime() - Date.now();
    return isFinite(ms) ? Math.max(0, Math.ceil(ms / 86_400_000)) : null;
  }

  get previewSite(): { value: string; label: string } | null {
    const f = this.form;
    if (!f) return null;
    if (f.multiSite) {
      const sites = new Set(f.days.filter(d => d.venueName.trim() || d.venueAddress.trim()).map(d => `${d.venueName}|${d.venueAddress}`));
      if (sites.size > 1) return { value: String(sites.size), label: 'Locations' };
    }
    const addr = f.multiSite ? (f.days[0]?.venueAddress ?? '') : f.venueAddress;
    const parts = addr.split(',').map(p => p.trim()).filter(Boolean);
    return parts.length >= 3 ? { value: parts[parts.length - 2], label: 'Location' } : null;
  }

  readonly imageW = IMAGE_W;
  readonly imageH = IMAGE_H;
  imageError = '';

  // Centre-crops whatever was chosen to the hero's proportions and saves it as a
  // JPEG small enough to live on the event itself.
  async pickImage(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !this.form) return;
    this.imageError = '';
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.max(IMAGE_W / bmp.width, IMAGE_H / bmp.height);
      const w = bmp.width * scale, h = bmp.height * scale;
      const canvas = document.createElement('canvas');
      canvas.width = IMAGE_W; canvas.height = IMAGE_H;
      canvas.getContext('2d')!.drawImage(bmp, (IMAGE_W - w) / 2, (IMAGE_H - h) / 2, w, h);
      let url = '';
      for (const q of [0.85, 0.75, 0.65, 0.55]) {
        url = canvas.toDataURL('image/jpeg', q);
        if (url.length < 900_000) break;
      }
      if (url.length >= 950_000) throw new Error('too large');
      this.form.image = url;
    } catch {
      this.imageError = 'That picture couldn’t be used. Try a different JPG or PNG.';
    }
  }

  addSlot() {
    const f = this.form;
    if (!f) return;
    const last = f.slots[f.slots.length - 1];
    f.slots.push({ id: '', date: last?.date || f.startDate, start: '', end: '', label: '' });
  }
  removeSlot(i: number) { this.form?.slots.splice(i, 1); }
  slotText(s: EventTimeSlot): string { return formatSlot(s); }

  // How many registered athletes picked each block.
  slotCount(id: string): number { return this.registrations.filter(r => r.timeSlotId === id).length; }

  close() { this.form = null; this.registrations = []; }

  private scrollTop() { setTimeout(() => document.querySelector<HTMLIonContentElement>('app-events ion-content')?.scrollToTop(200), 0); }

  get canSave(): boolean { return !!this.form?.title.trim() && !this.isSaving; }

  async save() {
    const f = this.form;
    if (!f || !this.canSave) return;
    this.isSaving = true;
    try {
      // Multi-site: the dates and the headline venue come from the days list.
      // Each block keeps its id for good, so athletes' choices stay attached to it.
      f.slots.forEach((t, i) => { if (!t.id && t.start) t.id = `t${Date.now().toString(36)}${i}`; });
      const days = f.multiSite
        ? f.days.filter(d => d.date).sort((a, b) => a.date.localeCompare(b.date))
            .map(d => ({ date: d.date, venueName: d.venueName.trim() || null, venueAddress: d.venueAddress.trim() || null }))
        : [];
      const multi = days.length > 1;
      const num = (n: number | null) => (n != null && Number(n) > 0 ? Number(n) : null);
      const id = await this.firebase.saveEvent({
        id: f.id,
        title: f.title.trim(),
        audience: f.audience,
        copy: this.cleanCopy(f.copy),
        timeSelection: f.timeSelection,
        timeSlots: f.slots.filter(t => t.start).map((t): EventTimeSlot => ({
          id: t.id,
          date: t.date || null, start: t.start, end: t.end || null, label: t.label.trim() || null
        })),
        backdrop: f.backdrop === 'photo' && !f.image ? 'rank' : f.backdrop,
        float: f.backdrop === 'photo' ? 'none' : f.float,
        ticker: f.backdrop !== 'photo' && f.float === 'zeros',   // read by older app builds
        image: f.image || null,
        caption: f.prizePool ? null : f.caption.trim() || null,
        status: f.status,
        description: f.description.trim() || null,
        startDate: multi ? days[0].date : f.startDate || null,
        endDate: multi ? days[days.length - 1].date : f.endDate || null,
        days: multi ? days : [],
        prizePool: num(f.prizePool),
        venueName: (multi ? days[0].venueName : f.venueName.trim()) || null,
        venueAddress: (multi ? days[0].venueAddress : f.venueAddress.trim()) || null,
        registrationOpen: f.registrationOpen,
        minRank: f.minRank === 'UNRANKED' ? null : f.minRank,
        fee: num(f.fee) ?? 0,
        capacity: num(f.capacity),
        guestsPerCompetitor: num(f.guestsPerCompetitor),
        rules: f.rulesText.split('\n').map(r => r.trim()).filter(Boolean)
      });
      f.id = id;
      await this.load();
      this.toast(f.status === 'published' ? 'Saved — live in the app' : 'Saved');
    } catch {
      this.toast('Could not save', 'danger');
    } finally {
      this.isSaving = false;
    }
  }

  async remove() {
    const f = this.form;
    if (!f?.id) return;
    const alert = await this.alerts.create({
      header: 'Delete this event?',
      message: this.registrations.length
        ? `This also deletes its ${this.registrations.length} registration${this.registrations.length === 1 ? '' : 's'}. To keep them, set the status to Archived instead.`
        : f.title,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: async () => {
          await this.firebase.deleteEvent(f.id!);
          this.close();
          await this.load();
        } }
      ]
    });
    await alert.present();
  }

  // ---- registrations ----
  get paidCount(): number { return this.registrations.filter(r => r.feeStatus === 'paid').length; }
  get guestCount(): number { return this.registrations.reduce((n, r) => n + (r.guests || 0), 0); }

  async togglePaid(r: EventRegistration) {
    const paid = r.feeStatus !== 'paid';
    await this.firebase.setRegistrationPaid(r.eventId, r.nameKey, paid);
    r.feeStatus = paid ? 'paid' : 'unpaid';
  }

  async removeRegistration(r: EventRegistration) {
    const alert = await this.alerts.create({
      header: 'Remove registration?',
      message: `${r.clientName} will lose their spot.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Remove', role: 'destructive', handler: async () => {
          await this.firebase.removeEventRegistration(r.eventId, r.nameKey);
          this.registrations = this.registrations.filter(x => x !== r);
          await this.load();
        } }
      ]
    });
    await alert.present();
  }

  exportCsv() {
    const cols: Array<[string, (r: EventRegistration) => string | number]> = [
      ['Name', r => r.clientName], ['Rank', r => r.rank], ['Date of birth', r => r.dob], ['Phone', r => r.phone],
      ['Emergency contact', r => r.emergencyName], ['Relationship', r => r.emergencyRelation], ['Emergency phone', r => r.emergencyPhone],
      ['Guests', r => r.guests], ['Time', r => r.timeSlotText ?? ''], ['Fee', r => r.fee], ['Fee status', r => r.feeStatus], ['Medical notes', r => r.medicalNotes], ['Registered', r => r.createdAt]
    ];
    const esc = (v: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.map(c => esc(c[0])).join(','), ...this.registrations.map(r => cols.map(c => esc(c[1](r))).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${(this.form?.title || 'event').replace(/[^\w]+/g, '-').toLowerCase()}-registrations.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  private async toast(message: string, color = 'success') {
    const t = await this.toasts.create({ message, duration: 1800, color, position: 'bottom' });
    await t.present();
  }
}
