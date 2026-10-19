import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, query, where, Firestore, Unsubscribe
} from 'firebase/firestore';
import { FirebaseService, PendingAssessment, AssessmentInputs } from '../services/firebase.service';
import { testValue } from '../services/omni.util';
import type { ScoredTestKey } from '../services/omni.util';
import { AiModel, AiReview, MODEL_VERSION, VIDEO_TESTS, VideoTest } from './ai-review.types';
import { readVideo, hamming } from './pose-video';
import { analyze, ruleVerdict, learnVector, LEARN_FEATURES, AthleteContext } from './analyze';
import { train, predict, looAccuracy } from './learn';

// The AI reviewer. While the coach app is open it works through the video proofs on its own: first every submission
// waiting for the coach, then (to learn from) the ones the coach has already decided. For each video it records what
// it found in aiReviews/{submission}_{slot}. When the coach approves or rejects a submission, the decision is written
// next to the AI's, and the model is retrained from all of them. Nothing it does reaches an athlete.

interface Job { p: PendingAssessment; slot: number; test: VideoTest; url: string }

export interface ReviewerState {
  enabled: boolean;
  running: boolean;
  current: string | null;      // "Raymond Platteel · Deadlift"
  progress: number;            // 0 to 1 through the current video
  waiting: number;             // pending videos not yet reviewed
  learning: number;            // decided videos not yet reviewed (the training backlog)
  done: number;                // reviews written this session
  lastError: string | null;
}

const ENABLED_KEY = 'ai-review.enabled';
// A review in progress refreshes its heartbeat every 20 s; one silent for 90 s was abandoned (a closed tab) and is taken over.
const STALE_MS = 90 * 1000;

@Injectable({ providedIn: 'root' })
export class AiReviewService {
  readonly state$ = new BehaviorSubject<ReviewerState>({
    enabled: this.readEnabled(), running: false, current: null, progress: 0, waiting: 0, learning: 0, done: 0, lastError: null
  });
  // Every review, live, for the pending page and the AI page.
  readonly reviews$ = new BehaviorSubject<AiReview[]>([]);
  readonly model$ = new BehaviorSubject<AiModel | null>(null);

  private db!: Firestore;
  private runner = Math.random().toString(36).slice(2, 10);
  private started = false;
  private busy = false;
  private unsub: Unsubscribe[] = [];
  private pending: PendingAssessment[] = [];
  private decided: PendingAssessment[] = [];
  private hashIndex: Array<{ id: string; pendingId: string; nameKey: string; clientName: string; hashes: string[] }> = [];
  private retrainTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = new Map<string, number>();

  constructor(private firebase: FirebaseService, private zone: NgZone) {}

  private readEnabled(): boolean {
    try { return localStorage.getItem(ENABLED_KEY) !== 'off'; } catch { return true; }
  }

  setEnabled(on: boolean) {
    try { localStorage.setItem(ENABLED_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
    this.patch({ enabled: on });
    if (on) this.pump();
  }

  private patch(p: Partial<ReviewerState>) { this.zone.run(() => this.state$.next({ ...this.state$.value, ...p })); }

  start() {
    if (this.started) return;
    this.started = true;
    void this.firebase;   // the app is initialised by FirebaseService before this runs
    this.db = getFirestore();
    // Every review, live.
    this.unsub.push(onSnapshot(collection(this.db, 'aiReviews'), snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...(d.data() as AiReview) }));
      this.zone.run(() => this.reviews$.next(list));
      this.refreshCounts();
    }));
    this.unsub.push(onSnapshot(doc(this.db, 'aiModels', 'global'), snap => {
      this.zone.run(() => this.model$.next(snap.exists() ? (snap.data() as AiModel) : null));
    }));
    // Submissions waiting for the coach, live.
    this.unsub.push(onSnapshot(query(collection(this.db, 'pendingAssessments'), where('status', '==', 'pending')), snap => {
      this.pending = snap.docs.map(d => ({ id: d.id, ...(d.data() as PendingAssessment) }));
      this.refreshCounts();
      this.pump();
    }));
    // Decided submissions, to learn from.
    getDocs(query(collection(this.db, 'pendingAssessments'), where('status', 'in', ['approved', 'rejected']))).then(snap => {
      this.decided = snap.docs.map(d => ({ id: d.id, ...(d.data() as PendingAssessment) }))
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      this.refreshCounts();
      this.pump();
    }).catch(err => this.patch({ lastError: 'Could not read decided submissions: ' + (err?.message ?? err) }));
    // Looks again every minute, so a review abandoned elsewhere is picked up.
    setInterval(() => { this.refreshCounts(); this.pump(); }, 60000);
    getDocs(collection(this.db, 'aiHashes')).then(snap => {
      this.hashIndex = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
    }).catch(() => { /* first run: no index yet */ });
  }

  // ---------- the queue ----------

  // The video proofs on a submission, with the test each is for. Photos and imported runs are checked elsewhere.
  private jobsOf(p: PendingAssessment): Job[] {
    const out: Job[] = [];
    const slots = p.proofs?.length ?? 0;
    for (let i = 0; i < slots; i++) {
      const pr = p.proofs![i];
      const url = p.videoUrls?.['v' + i];
      if (pr.kind === 'video' && url && (VIDEO_TESTS as readonly string[]).includes(pr.test)) out.push({ p, slot: i, test: pr.test as VideoTest, url });
    }
    // Older submissions: one video, for the one test that changed.
    if (!slots && p.videoUrl) {
      const tests = VIDEO_TESTS.filter(t => (p.changed ?? []).some(k => k === t || k === t + 'Weight' || k === t + 'Reps'));
      if (tests.length === 1) out.push({ p, slot: 0, test: tests[0], url: p.videoUrl });
    }
    return out;
  }

  private reviewFor(id: string): AiReview | undefined { return this.reviews$.value.find(r => r.id === id); }

  private needsWork(j: Job): boolean {
    const id = `${j.p.id}_${j.slot}`;
    const r = this.reviewFor(id);
    if (!r) return true;
    // Reviews made by an older version of the checks are made again.
    if (r.status === 'done') return r.modelVersion !== MODEL_VERSION;
    if (r.status === 'running') return !r.startedAt || Date.now() - Date.parse(r.startedAt) > STALE_MS;
    // A video that failed is tried once more each time the app opens.
    return (this.failures.get(id) ?? 0) < 1;
  }

  private refreshCounts() {
    const jobs = (list: PendingAssessment[]) => list.reduce<Job[]>((all, p) => all.concat(this.jobsOf(p)), []);
    const waiting = jobs(this.pending).filter(j => this.needsWork(j)).length;
    const learning = jobs(this.decided).filter(j => this.needsWork(j)).length;
    this.patch({ waiting, learning });
  }

  private nextJob(): Job | null {
    for (const p of [...this.pending].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))) {
      for (const j of this.jobsOf(p)) if (this.needsWork(j) && (this.failures.get(`${p.id}_${j.slot}`) ?? 0) < 2) return j;
    }
    for (const p of this.decided) {
      for (const j of this.jobsOf(p)) if (this.needsWork(j) && (this.failures.get(`${p.id}_${j.slot}`) ?? 0) < 2) return j;
    }
    return null;
  }

  private async pump() {
    if (this.busy || !this.state$.value.enabled || !this.db) return;
    const job = this.nextJob();
    if (!job) { this.patch({ running: false, current: null, progress: 0 }); return; }
    this.busy = true;
    try {
      await this.process(job);
    } finally {
      this.busy = false;
      this.refreshCounts();
      setTimeout(() => this.pump(), 800);
    }
  }

  // ---------- one video ----------

  private async process(j: Job) {
    const p = j.p;
    const id = `${p.id}_${j.slot}`;
    const ref = doc(this.db, 'aiReviews', id);
    // Another copy of the coach app (the iPad, say) may already be on it.
    const existing = await getDoc(ref).catch(() => null);
    const ex = existing?.exists() ? (existing.data() as AiReview) : null;
    if (ex?.status === 'done' && ex.modelVersion === MODEL_VERSION) return;
    if (ex?.status === 'running' && ex.runner !== this.runner && ex.startedAt && Date.now() - Date.parse(ex.startedAt) < STALE_MS) return;

    const inputs = p.inputs as AssessmentInputs;
    const claimValue = testValue(j.test as ScoredTestKey, inputs);
    const isLift = j.test === 'deadlift' || j.test === 'squat' || j.test === 'bench';
    const base: AiReview = {
      pendingId: p.id!, slot: j.slot, test: j.test, nameKey: p.nameKey, clientName: p.clientName,
      submittedAt: p.timestamp, videoUrl: j.url, status: 'running', runner: this.runner, startedAt: new Date().toISOString(),
      modelVersion: MODEL_VERSION,
      claimed: {
        value: claimValue,
        weight: isLift ? Number((inputs as any)[j.test + 'Weight']) || null : null,
        reps: isLift ? Number((inputs as any)[j.test + 'Reps']) || 1 : null
      },
      coachDecision: p.status === 'approved' || p.status === 'rejected' ? p.status : (ex?.coachDecision ?? null),
      decidedAt: p.status === 'pending' ? (ex?.decidedAt ?? null) : (p.reviewedAt ?? null),
      coachLabels: ex?.coachLabels ?? null
    };
    this.patch({ running: true, current: `${p.clientName} · ${j.test}`, progress: 0, lastError: null });
    const beat = setInterval(() => { updateDoc(ref, { startedAt: new Date().toISOString() }).catch(() => {}); }, 20000);
    try {
      await setDoc(ref, base);
      const reading = await readVideo(j.url, f => this.patch({ progress: f }));
      const ctx = await this.context(p, j.test);

      // The same footage sent before: by another athlete is a fake; by the same athlete, worth a look.
      let duplicateOf: string | null = null, ownRepeat = false;
      if (reading.hashes.length >= 3) {
        for (const h of this.hashIndex) {
          if (h.pendingId === p.id) continue;
          const matches = reading.hashes.filter(a => h.hashes.some(b => hamming(a, b) <= 6)).length;
          if (matches >= 3) {
            if (h.nameKey === p.nameKey) ownRepeat = true;
            else { duplicateOf = h.clientName; break; }
          }
        }
      }

      const a = analyze(j.test, reading, base.claimed, ctx, duplicateOf, ownRepeat);
      const presence = a.features['presence'] ?? 0;
      const rv = ruleVerdict(a.checks, presence);
      const vector = learnVector(a.features, a.checks, rv.score);

      // The learned model, once it has seen enough of the coach's decisions to be worth hearing.
      const m = this.model$.value;
      let learned: number | null = null;
      let verdict = rv.verdict;
      if (m && m.n >= 20 && m.positives >= 5 && m.n - m.positives >= 5 && m.featureNames.join() === LEARN_FEATURES.join()) {
        learned = predict(m, vector);
        if (m.accuracy > m.ruleAccuracy && !a.checks.some(c => c.result === 'fail' && c.critical)) {
          verdict = learned >= 0.85 ? 'likely-valid' : learned <= 0.25 ? 'likely-invalid' : 'needs-review';
        }
      }

      const review: AiReview = {
        ...base,
        status: 'done',
        analyzedAt: new Date().toISOString(),
        error: null,
        video: { duration: reading.duration, width: reading.width, height: reading.height, frames: reading.frames.length, personFrames: reading.frames.filter(f => !!f.pts).length },
        checks: a.checks,
        features: Object.keys(a.features).reduce<Record<string, number>>((o, k) => { const v = a.features[k]; o[k] = isFinite(v) ? Math.round(v * 10000) / 10000 : 0; return o; }, {}),
        estimates: a.estimates,
        ruleScore: Math.round(rv.score * 1000) / 1000,
        learnedScore: learned === null ? null : Math.round(learned * 1000) / 1000,
        verdict,
        confidence: Math.round(rv.confidence * 1000) / 1000,
        hashes: reading.hashes,
        thumbs: reading.thumbs,
        duplicateOf: duplicateOf ? { pendingId: '', clientName: duplicateOf } : null
      };
      (review as any).vector = vector;
      await setDoc(ref, review);
      if (reading.hashes.length) {
        const h = { pendingId: p.id!, nameKey: p.nameKey, clientName: p.clientName, hashes: reading.hashes };
        await setDoc(doc(this.db, 'aiHashes', id), h).catch(() => {});
        this.hashIndex = [...this.hashIndex.filter(x => x.id !== id), { id, ...h }];
      }
      this.patch({ done: this.state$.value.done + 1 });
      if (review.coachDecision) this.scheduleRetrain();
    } catch (err: any) {
      this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
      const msg = String(err?.message ?? err);
      this.patch({ lastError: `${p.clientName} · ${j.test}: ${msg}` });
      await setDoc(ref, { ...base, status: 'error', error: msg }).catch(() => {});
    } finally {
      clearInterval(beat);
    }
  }

  // What the analysis needs to know about the athlete: height, body weight, sex, their last verified result in this
  // test, and their current lifts.
  private async context(p: PendingAssessment, test: VideoTest): Promise<AthleteContext> {
    const member = (await getDoc(doc(this.db, 'members', p.nameKey)).catch(() => null))?.data() as any;
    const history = await this.firebase.listAssessmentsForClient({ clientName: p.clientName }).catch(() => []);
    const before = history.filter(a => Date.parse(a.timestamp) <= Date.parse(p.timestamp) + 1000);
    let prevValue: number | null = null, prevDate: string | null = null;
    for (let i = before.length - 1; i >= 0; i--) {
      const a = before[i];
      if ((a.estimatedTests ?? []).includes(test)) continue;
      const v = testValue(test as ScoredTestKey, a.inputs);
      if (v > 0 && (a as any).selfReported !== true) { prevValue = v; prevDate = a.timestamp; break; }
    }
    const latest = before[before.length - 1]?.inputs ?? history[history.length - 1]?.inputs;
    return {
      heightIn: Number(member?.height) || Number(p.inputs?.height) || null,
      bodyWeightLb: Number(p.inputs?.bodyWeight) || Number(latest?.bodyWeight) || null,
      sex: member?.sex === 'female' ? 'female' : 'male',
      prevValue, prevDate,
      lifts: { deadlift: Number(latest?.deadlift) || 0, squat: Number(latest?.squat) || 0, bench: Number(latest?.bench) || 0 }
    };
  }

  // ---------- learning from the coach ----------

  // Called when the coach approves or rejects a submission: their decision goes next to every AI review of it.
  async recordDecision(pendingId: string, decision: 'approved' | 'rejected') {
    if (!this.db) this.db = getFirestore();
    const snap = await getDocs(query(collection(this.db, 'aiReviews'), where('pendingId', '==', pendingId))).catch(() => null);
    if (!snap) return;
    await Promise.all(snap.docs.map(d => updateDoc(d.ref, { coachDecision: decision, decidedAt: new Date().toISOString() }).catch(() => {})));
    this.scheduleRetrain();
  }

  // The coach's quick label on the weight in a video.
  async labelWeight(reviewId: string, label: 'ok' | 'doubtful') {
    if (!this.db) this.db = getFirestore();
    await updateDoc(doc(this.db, 'aiReviews', reviewId), { 'coachLabels.weight': label });
  }

  private scheduleRetrain() {
    if (this.retrainTimer) clearTimeout(this.retrainTimer);
    this.retrainTimer = setTimeout(() => this.retrain(), 3000);
  }

  async retrain(): Promise<AiModel | null> {
    const labelled = this.reviews$.value.filter(r => r.status === 'done' && r.coachDecision && Array.isArray((r as any).vector));
    if (labelled.length < 8) return null;
    const X = labelled.map(r => (r as any).vector as number[]);
    const y = labelled.map(r => (r.coachDecision === 'approved' ? 1 : 0));
    if (new Set(y).size < 2) return null;
    const m = train(X, y);
    const accuracy = looAccuracy(X, y);
    const ruleAccuracy = labelled.filter(r => ((r.verdict ?? 'needs-review') !== 'likely-invalid' ? 1 : 0) === (r.coachDecision === 'approved' ? 1 : 0)).length / labelled.length;
    const model: AiModel = {
      kind: 'logistic', featureNames: [...LEARN_FEATURES], weights: m.weights, mean: m.mean, std: m.std,
      n: labelled.length, positives: y.filter(v => v === 1).length, accuracy, ruleAccuracy, trainedAt: new Date().toISOString()
    };
    await setDoc(doc(this.db, 'aiModels', 'global'), model).catch(() => {});
    return model;
  }

  // Runs one video again (after a change to the checks, say).
  async rerun(reviewId: string) {
    this.failures.delete(reviewId);
    await updateDoc(doc(this.db, 'aiReviews', reviewId), { modelVersion: 'rerun', status: 'error' }).catch(() => {});
    setTimeout(() => this.pump(), 500);
  }
}
