import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, onSnapshot, query, where, Firestore, Unsubscribe
} from 'firebase/firestore';
import { FirebaseService, PendingAssessment, AssessmentInputs } from '../services/firebase.service';
import { testValue } from '../services/omni.util';
import type { ScoredTestKey } from '../services/omni.util';
import { AiModel, AiReview, AiTrainingVideo, MODEL_VERSION, TrainerFeedback, VIDEO_TESTS, VideoTest, decisionOf, actualWeightOf } from './ai-review.types';
import { readVideo, hamming } from './pose-video';
import { setThresholds, getOverrides, thr } from './thresholds';
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

// 'v10' -> 10. A review marked for a re-run ('rerun') is older than every version.
function versionOf(v: string | undefined): number { const n = parseInt((v ?? '').replace(/^v/, ''), 10); return isFinite(n) ? n : 0; }

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
  private trainingDecided: PendingAssessment[] = [];
  readonly trainingVideos$ = new BehaviorSubject<AiTrainingVideo[]>([]);
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
    // The coach's tuned thresholds (AI Trainer), applied to every review made after they change.
    this.unsub.push(onSnapshot(doc(this.db, 'aiConfig', 'thresholds'), snap => {
      setThresholds((snap.data() as any)?.values ?? {});
    }, () => { /* defaults */ }));
    // Submissions waiting for the coach, live.
    this.unsub.push(onSnapshot(query(collection(this.db, 'pendingAssessments'), where('status', '==', 'pending')), snap => {
      this.pending = snap.docs.map(d => ({ id: d.id, ...(d.data() as PendingAssessment) }));
      this.refreshCounts();
      this.pump();
    }));
    // Videos the coach added in the AI Trainer, learned from like decided submissions.
    this.unsub.push(onSnapshot(collection(this.db, 'aiTrainingVideos'), snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...(d.data() as AiTrainingVideo) }));
      this.zone.run(() => this.trainingVideos$.next(list));
      this.trainingDecided = list.map(v => this.pseudoSubmission(v));
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

  // A training video, shaped like a decided submission so the same review pipeline handles it.
  private pseudoSubmission(v: AiTrainingVideo): PendingAssessment {
    const inputs: any = { bodyWeight: v.bodyWeightLb ?? 0, height: v.heightIn ?? 0 };
    inputs[v.test] = v.claimed.value;
    if (v.test === 'deadlift' || v.test === 'squat' || v.test === 'bench') { inputs[v.test + 'Weight'] = v.claimed.weight ?? 0; inputs[v.test + 'Reps'] = v.claimed.reps ?? 1; }
    return {
      id: 'tv_' + v.id, nameKey: 'ai-training', clientName: v.name || 'Training video', timestamp: v.createdAt, dateLabel: v.createdAt.slice(0, 10),
      inputs, lvl: 0, rank: 'UNRANKED', createdAt: v.createdAt, status: v.label === 'valid' ? 'approved' : v.label === 'invalid' ? 'rejected' : 'pending',
      reviewedAt: v.createdAt, proofs: [{ test: v.test, kind: 'video' }], videoUrls: { v0: v.url }, changed: [v.test]
    } as unknown as PendingAssessment;
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
    if (r.status === 'done') return versionOf(r.modelVersion) < versionOf(MODEL_VERSION);
    if (r.status === 'running') return !r.startedAt || Date.now() - Date.parse(r.startedAt) > STALE_MS;
    // A video that failed is tried once more each time the app opens.
    return (this.failures.get(id) ?? 0) < 1;
  }

  private refreshCounts() {
    const jobs = (list: PendingAssessment[]) => list.reduce<Job[]>((all, p) => all.concat(this.jobsOf(p)), []);
    const waiting = jobs(this.pending).filter(j => this.needsWork(j)).length;
    const learning = jobs(this.decided.concat(this.trainingDecided)).filter(j => this.needsWork(j)).length;
    this.patch({ waiting, learning });
  }

  private nextJob(): Job | null {
    for (const p of [...this.pending].sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))) {
      for (const j of this.jobsOf(p)) if (this.needsWork(j) && (this.failures.get(`${p.id}_${j.slot}`) ?? 0) < 2) return j;
    }
    for (const p of this.trainingDecided.concat(this.decided)) {
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
    // Never redo a review made by a newer version of the checks: two copies of the app on different versions would otherwise
    // keep analysing each other's results again, each blanking the review while it works.
    if (ex?.status === 'done' && versionOf(ex.modelVersion) >= versionOf(MODEL_VERSION)) return;
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
      coachLabels: ex?.coachLabels ?? null,
      trainer: ex?.trainer ?? null
    };
    this.patch({ running: true, current: `${p.clientName} · ${j.test}`, progress: 0, lastError: null });
    const beat = setInterval(() => { updateDoc(ref, { startedAt: new Date().toISOString() }).catch(() => {}); }, 20000);
    try {
      await setDoc(ref, base);
      const ctx = await this.context(p, j.test);
      const reading = await readVideo(j.url, f => this.patch({ progress: f }), { test: j.test, heightM: ctx.heightIn ? ctx.heightIn * 0.0254 : null });

      // The same footage sent before: by another athlete is a fake; by the same athlete, worth a look.
      let duplicateOf: string | null = null, ownRepeat = false;
      if (reading.hashes.length >= 3) {
        for (const h of this.hashIndex) {
          if (h.pendingId === p.id) continue;
          const matches = reading.hashes.filter(a => h.hashes.some(b => hamming(a, b) <= thr('*', 'duplicate'))).length;
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
        weight: a.weight ?? null,
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
      // What the coach has saved while this was being analysed is read again now, so finishing never overwrites it.
      const fresh = (await getDoc(ref).catch(() => null))?.data() as AiReview | undefined;
      if (fresh) {
        review.trainer = fresh.trainer ?? review.trainer ?? null;
        review.coachLabels = fresh.coachLabels ?? review.coachLabels ?? null;
        review.coachDecision = fresh.coachDecision ?? review.coachDecision;
        review.decidedAt = fresh.decidedAt ?? review.decidedAt;
      }
      review.trainer = this.judgeTrainingVideo(p.id!, review) ?? review.trainer ?? null;
      await setDoc(ref, JSON.parse(JSON.stringify(review)));
      if (reading.hashes.length) {
        const h = { pendingId: p.id!, nameKey: p.nameKey, clientName: p.clientName, hashes: reading.hashes };
        await setDoc(doc(this.db, 'aiHashes', id), h).catch(() => {});
        this.hashIndex = [...this.hashIndex.filter(x => x.id !== id), { id, ...h }];
      }
      this.patch({ done: this.state$.value.done + 1 });
      if (decisionOf(review)) this.scheduleRetrain();
    } catch (err: any) {
      this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
      const msg = String(err?.message ?? err);
      this.patch({ lastError: `${p.clientName} · ${j.test}: ${msg}` });
      await setDoc(ref, { ...base, status: 'error', error: msg }).catch(() => {});
    } finally {
      clearInterval(beat);
    }
  }

  // A video added to teach one component carries the answer. Once it is analysed, the AI's result for that component is
  // marked right or wrong against the answer, exactly as if the coach had judged it, so the component's accuracy and its
  // learning both come from it. A result of "unclear" is left unjudged: the AI did not claim to know.
  private judgeTrainingVideo(pendingId: string, review: AiReview): TrainerFeedback | null {
    if (!pendingId.startsWith('tv_')) return null;
    const v = this.trainingVideos$.value.find(x => 'tv_' + x.id === pendingId);
    if (!v?.component) return null;
    const next: TrainerFeedback = { ...(review.trainer ?? {}), checks: { ...(review.trainer?.checks ?? {}) }, answers: { ...(review.trainer?.answers ?? {}) }, at: new Date().toISOString() };
    if (v.component === 'weight') {
      if (v.actualWeight) next.actualWeight = v.actualWeight;
    } else {
      const c = (review.checks ?? []).find(k => k.id === v.component);
      if (v.expected) next.answers![v.component] = v.expected;
      if (c && c.result !== 'unclear' && v.expected) next.checks![v.component] = c.result === v.expected ? 'right' : 'wrong';
    }
    return next;
  }

  // What the analysis needs to know about the athlete: height, body weight, sex, their last verified result in this
  // test, and their current lifts.
  private async context(p: PendingAssessment, test: VideoTest): Promise<AthleteContext> {
    const member = (await getDoc(doc(this.db, 'members', p.nameKey)).catch(() => null))?.data() as any;
    const history = await this.firebase.listAssessmentsForClient({ clientName: p.clientName }).catch(() => []);
    const before = history.filter(a => Date.parse(a.timestamp) <= Date.parse(p.timestamp) + 1000);
    let prevValue: number | null = null, prevDate: string | null = null, refMax: number | null = null;
    for (let i = before.length - 1; i >= 0; i--) {
      const a = before[i];
      if ((a.estimatedTests ?? []).includes(test)) continue;
      const v = testValue(test as ScoredTestKey, a.inputs);
      if (v > 0 && (a as any).selfReported !== true) {
        if (prevValue === null) { prevValue = v; prevDate = a.timestamp; }
        refMax = Math.max(refMax ?? 0, v);
      }
    }
    const latest = before[before.length - 1]?.inputs ?? history[history.length - 1]?.inputs;
    return {
      heightIn: Number(member?.height) || Number(p.inputs?.height) || null,
      bodyWeightLb: Number(p.inputs?.bodyWeight) || Number(latest?.bodyWeight) || null,
      sex: member?.sex === 'female' ? 'female' : 'male',
      prevValue, prevDate, refMax,
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

  // ---------- the AI Trainer ----------

  // What the coach taught on one review: its label, which checks were right, the real weight. Merged, never replaced.
  async saveTrainer(reviewId: string, fb: Partial<TrainerFeedback>) {
    if (!this.db) this.db = getFirestore();
    const cur = this.reviewFor(reviewId)?.trainer ?? ({ at: '' } as TrainerFeedback);
    const next: TrainerFeedback = { ...cur, ...fb, checks: { ...(cur.checks ?? {}), ...(fb.checks ?? {}) }, answers: { ...(cur.answers ?? {}), ...(fb.answers ?? {}) }, values: { ...(cur.values ?? {}), ...(fb.values ?? {}) }, at: new Date().toISOString() };
    await updateDoc(doc(this.db, 'aiReviews', reviewId), { trainer: JSON.parse(JSON.stringify(next)) });
    // The AI learns when the coach presses Complete (see completeReview), not on every edit.
    
  }

  // The coach is done with a video: it is marked complete and the AI is updated from everything judged so far.
  async completeReview(reviewId: string) {
    await this.saveTrainer(reviewId, { completedAt: new Date().toISOString() });
    if (this.retrainTimer) clearTimeout(this.retrainTimer);
    await this.retrain().catch(() => null);
  }

  // The thresholds the coach has tuned for one test ('*' for the settings every video shares).
  async saveThresholds(test: string, values: Record<string, number>) {
    if (!this.db) this.db = getFirestore();
    const all = { ...getOverrides(), [test]: values };
    for (const k of Object.keys(all)) if (!Object.keys(all[k]).length) delete all[k];
    await setDoc(doc(this.db, 'aiConfig', 'thresholds'), { values: all, updatedAt: new Date().toISOString() });
  }

  // Analyses every video of one test again with the thresholds now in force.
  async rerunTest(test: VideoTest | 'all') {
    if (!this.db) this.db = getFirestore();
    const list = this.reviews$.value.filter(r => (test === 'all' || r.test === test) && r.status !== 'running');
    for (const r of list) {
      this.failures.delete(r.id!);
      await updateDoc(doc(this.db, 'aiReviews', r.id!), { modelVersion: 'rerun' }).catch(() => {});
    }
    setTimeout(() => { this.refreshCounts(); this.pump(); }, 800);
    return list.length;
  }

  // A video the coach adds to teach a test directly.
  async addTrainingVideo(file: File, meta: Omit<AiTrainingVideo, 'id' | 'url' | 'path' | 'createdAt' | 'name'>, name: string): Promise<void> {
    if (!this.db) this.db = getFirestore();
    const { getStorage, ref, uploadBytes, getDownloadURL } = await import('firebase/storage');
    // Under appVideos/, the folder this app is already allowed to write videos to.
    const path = `appVideos/ai-training-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.name.replace(/[^\w.-]+/g, '_')}`;
    const r = ref(getStorage(), path);
    await uploadBytes(r, file, { contentType: file.type || 'video/mp4' });
    const url = await getDownloadURL(r);
    const doc0: Omit<AiTrainingVideo, 'id'> = { ...meta, url, path, name, createdAt: new Date().toISOString() };
    await setDoc(doc(this.db, 'aiTrainingVideos', Math.random().toString(36).slice(2, 12)), JSON.parse(JSON.stringify(doc0)));
  }

  async deleteTrainingVideo(id: string) {
    if (!this.db) this.db = getFirestore();
    const { deleteDoc } = await import('firebase/firestore');
    await deleteDoc(doc(this.db, 'aiTrainingVideos', id));
    const rv = this.reviews$.value.find(r => r.id === `tv_${id}_0`);
    if (rv) await deleteDoc(doc(this.db, 'aiReviews', rv.id!)).catch(() => {});
  }

  // The weight that was really on the bar, as the coach confirms it. This is what teaches the weight estimate.
  async labelActualWeight(reviewId: string, lb: number | null) {
    if (!this.db) this.db = getFirestore();
    await updateDoc(doc(this.db, 'aiReviews', reviewId), { 'coachLabels.actualWeight': lb });
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
    const labelled = this.reviews$.value.filter(r => r.status === 'done' && decisionOf(r) && Array.isArray((r as any).vector));
    if (labelled.length < 8) return null;
    const X = labelled.map(r => (r as any).vector as number[]);
    const y = labelled.map(r => (decisionOf(r) === 'approved' ? 1 : 0));
    if (new Set(y).size < 2) return null;
    const m = train(X, y);
    const accuracy = looAccuracy(X, y);
    const ruleAccuracy = labelled.filter(r => ((r.verdict ?? 'needs-review') !== 'likely-invalid' ? 1 : 0) === (decisionOf(r) === 'approved' ? 1 : 0)).length / labelled.length;
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
