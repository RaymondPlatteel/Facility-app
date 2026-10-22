import { AiCheck, AiReview, AiTrainingVideo, VideoTest, actualWeightOf, plateEstimateOf, speedEstimateOf } from '../ai/ai-review.types';

// A test is a checklist. Each item on it is a component: one thing the AI looks for in the video (the weight on the bar,
// the lockout, the depth, a continuous take). A video passes only when every component passes. Each component is trained
// on its own: it has its own videos, its own settings and its own accuracy.
//
// `id` is the id of the check the analysis produces, so a coach's judgement of a check and a video uploaded to teach the
// component land in the same place.

export interface Component {
  id: string;
  label: string;
  // What it looks at, in a sentence the coach can read.
  what: string;
  // The numbers (see thresholds.ts) that make this component strict or lenient.
  tunables: string[];
  // The tests it applies to. A component that is the same check in several tests is trained once, on all their videos.
  tests: readonly VideoTest[];
  // The kind of answer a training video gives it.
  kind: 'result' | 'weight';
  // The number the coach gives for it when they review a video, if it measures one.
  measure?: { label: string; unit: string };
}

export const LIFT_TESTS: readonly VideoTest[] = ['deadlift', 'squat', 'bench'];

const ALL: readonly VideoTest[] = ['deadlift', 'squat', 'bench', 'longjump', 'sprint', 'pushups', 'pullups', 'run400', 'pike', 'backbend'];

export const COMPONENTS: Component[] = [
  // Shared by the three lifts: one component, trained on every lift video that shows a weight.
  { id: 'weight', label: 'Weight on the bar', what: 'The weight on the bar, read from the plates (how many on each end and how big), against the weight claimed. Bar speed is a secondary check.',
    tunables: ['weightSpread', 'speedPass'], tests: LIFT_TESTS, kind: 'weight', measure: { label: 'Real weight on the bar', unit: 'lb' } },

  // Lifts
  { id: 'movement', label: 'Right exercise', what: 'The video shows this exercise and not another movement.', tunables: ['handsUp', 'upright'], tests: LIFT_TESTS, kind: 'result' },
  { id: 'reps', label: 'Reps', what: 'The number of reps seen matches the number claimed.', tunables: [], tests: ['deadlift', 'squat', 'bench', 'pushups', 'pullups'], kind: 'result', measure: { label: 'Reps you count', unit: 'reps' } },
  { id: 'lockout', label: 'Lockout', what: 'The top of each rep: joints fully extended.', tunables: ['lockout', 'knee'], tests: ['deadlift', 'squat', 'bench', 'pushups'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'depth', label: 'Depth', what: 'The bottom of each rep: the bar from the floor, hip crease below the knee, or the bar to the chest.', tunables: ['floor', 'depth'], tests: ['deadlift', 'squat', 'bench', 'pike'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'bench-contact', label: 'Hips on the bench', what: 'The hips stay down on the bench.', tunables: ['hipRise'], tests: ['bench'], kind: 'result' },
  { id: 'bar-speed', label: 'Bar speed', what: 'A new best looks like a max effort from how fast the bar moves.', tunables: ['speedPass'], tests: LIFT_TESTS, kind: 'result' },
  { id: 'fatigue', label: 'Reps slow down', what: 'Later reps are slower, as in a set taken to its limit.', tunables: [], tests: LIFT_TESTS, kind: 'result' },

  // Push-ups and pull-ups
  { id: 'bend', label: 'Elbow bend', what: 'The elbows bend to 90 degrees at the bottom.', tunables: ['bend', 'passShare'], tests: ['pushups'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'line', label: 'Straight body', what: 'The shoulders, hips and ankles stay in one line.', tunables: ['line', 'passShare'], tests: ['pushups'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'hang', label: 'Full hang', what: 'The arms straighten between reps.', tunables: ['hang', 'passShare'], tests: ['pullups'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'chin', label: 'Chin over the bar', what: 'The chin clears the bar on every rep.', tunables: ['passShare'], tests: ['pullups'], kind: 'result', measure: { label: 'Reps that passed', unit: 'reps' } },
  { id: 'kip', label: 'No kipping', what: 'The hips do not swing to help the pull.', tunables: ['kip'], tests: ['pullups'], kind: 'result' },
  { id: 'continuous', label: 'No pauses', what: 'The reps follow one another without long rests.', tunables: [], tests: ['pushups', 'pullups'], kind: 'result' },

  // Jump
  { id: 'jump', label: 'Jump seen', what: 'A clear take-off and landing can be followed.', tunables: [], tests: ['longjump'], kind: 'result' },
  { id: 'two-feet', label: 'Two-footed jump', what: 'Both feet leave and land together.', tunables: [], tests: ['longjump'], kind: 'result' },
  { id: 'distance', label: 'Distance', what: 'The measured distance matches the distance claimed.', tunables: ['distance'], tests: ['longjump'], kind: 'result', measure: { label: 'Distance jumped', unit: 'in' } },

  // Runs
  { id: 'length', label: 'Whole run on video', what: 'The video is as long as the claimed time.', tunables: ['length'], tests: ['sprint', 'run400'], kind: 'result' },
  { id: 'running', label: 'Running seen', what: 'A runner can be followed through the video.', tunables: [], tests: ['sprint', 'run400'], kind: 'result' },

  // Flexibility
  { id: 'hold', label: 'Hold time', what: 'The position is held for the required time.', tunables: ['hold'], tests: ['pike', 'backbend'], kind: 'result', measure: { label: 'Hold time', unit: 's' } },
  { id: 'reach', label: 'Reach', what: 'The reach matches the score claimed.', tunables: [], tests: ['pike', 'backbend'], kind: 'result' },

  // Every test: whether the video can be trusted
  { id: 'visible', label: 'Athlete in frame', what: 'The athlete is visible for enough of the video.', tunables: ['visible'], tests: ALL, kind: 'result' },
  { id: 'uncut', label: 'One continuous take', what: 'The video has no cuts or edits.', tunables: ['cut'], tests: ALL, kind: 'result' },
  { id: 'original', label: 'Not sent before', what: 'The footage has not been sent before, by this athlete or another.', tunables: ['duplicate'], tests: ALL, kind: 'result' },
];

// The components that are about the video itself rather than the test, in the order the checklist shows them.
export const VIDEO_COMPONENTS = ['visible', 'uncut', 'original'];

// Checks the AI makes from what it knows about the athlete rather than from the video (their past results, their other lifts).
// They cannot be judged by watching one video, so they are not on the checklist you fill out.
export const NOT_ON_CHECKLIST = ['progress', 'bodyweight', 'balance'];
export const checklistOf = (r: AiReview): AiCheck[] => (r.checks ?? []).filter(c => !NOT_ON_CHECKLIST.includes(c.id));

export function componentById(id: string): Component | undefined { return COMPONENTS.find(c => c.id === id); }

// A test's checklist: the components that apply to it.
export function componentsOf(test: VideoTest): Component[] {
  return COMPONENTS.filter(c => c.tests.includes(test));
}

// The tests whose videos a component is trained on.
export function testsOf(c: Component): readonly VideoTest[] { return c.tests; }

// How well one component is doing, from the coach's judgements of it. A judged video is one where the coach said whether the
// AI's result for this component was right or wrong, or a training video the AI was then marked against automatically.
export interface ComponentStats {
  seen: number;            // videos this component was checked on
  judged: number;          // of those, ones where the coach (or a training video) said whether the AI was right
  right: number;
  accuracy: number | null; // right / judged, 0 to 1
  status: 'empty' | 'few' | 'learning' | 'reliable';
  extra?: string;
  weight?: WeightScores;   // the weight component only: the plate reading beside the bar-speed estimate
}

// How one way of estimating the weight did on the videos where the real weight is known.
export interface WeightScore {
  label: string;
  estimated: number;       // labelled videos it gave an estimate for
  error: number | null;    // average error as a share of the real weight, 0 to 1
  within10: number;        // estimates within 10% of the real weight
  inRange: number;         // real weight inside the range it gave
}
export interface WeightScores {
  labelled: number;        // lift videos with a real weight
  plates: WeightScore;
  speed: WeightScore;
  // Both on the same videos (those where the plates were read), so the two errors can be compared fairly.
  commonN: number;
  commonPlates: number | null;
  commonSpeed: number | null;
}

export function weightScores(reviews: AiReview[], scope?: VideoTest): WeightScores {
  const lifts = reviews.filter(r => r.status === 'done' && r.weight && LIFT_TESTS.includes(r.test) && (!scope || r.test === scope));
  const known = lifts.filter(r => actualWeightOf(r));
  const score = (label: string, est: (r: AiReview) => number | null, range: (r: AiReview) => [number, number] | null): WeightScore => {
    const rows = known.filter(r => est(r) !== null);
    const errs = rows.map(r => Math.abs((est(r) as number) - (actualWeightOf(r) as number)) / (actualWeightOf(r) as number));
    return {
      label, estimated: rows.length, error: rows.length ? errs.reduce((a, b) => a + b, 0) / rows.length : null,
      within10: errs.filter(e => e <= 0.1).length,
      inRange: rows.filter(r => { const g = range(r), a = actualWeightOf(r) as number; return !!g && a >= g[0] && a <= g[1]; }).length
    };
  };
  const plates = score('Plate reading', r => plateEstimateOf(r.weight), r => (r.weight!.low !== null && r.weight!.high !== null ? [r.weight!.low, r.weight!.high] : null));
  const speed = score('Bar speed', r => speedEstimateOf(r.weight), r => {
    const sp = r.weight!.speed ?? (r.weight!.method === 'speed' || r.weight!.method === 'learned' ? r.weight : null);
    return sp && sp.low !== null && sp.high !== null ? [sp.low, sp.high] : null;
  });
  const both = known.filter(r => plateEstimateOf(r.weight) !== null && speedEstimateOf(r.weight) !== null);
  const meanErr = (f: (r: AiReview) => number) => both.length ? both.reduce((s, r) => s + Math.abs(f(r) - (actualWeightOf(r) as number)) / (actualWeightOf(r) as number), 0) / both.length : null;
  return { labelled: known.length, plates, speed, commonN: both.length,
    commonPlates: meanErr(r => plateEstimateOf(r.weight) as number), commonSpeed: meanErr(r => speedEstimateOf(r.weight) as number) };
}

export function componentStats(c: Component, reviews: AiReview[], scope?: VideoTest): ComponentStats {
  const done = reviews.filter(r => r.status === 'done' && c.tests.includes(r.test) && (!scope || r.test === scope));
  if (c.kind === 'weight') {
    const lifts = done.filter(r => r.weight);
    const w = weightScores(reviews, scope);
    const err = w.plates.error;
    const missed = w.labelled - w.plates.estimated;
    return { seen: lifts.length, judged: w.labelled, right: w.plates.within10, weight: w,
      // A video whose plates could not be read counts against it: it gave no weight.
      accuracy: w.labelled ? (err === null ? 0 : Math.max(0, 1 - err) * (w.plates.estimated / w.labelled)) : null,
      status: w.labelled === 0 ? 'empty' : w.labelled < 8 ? 'few' : w.labelled < 30 ? 'learning' : 'reliable',
      extra: w.labelled === 0 ? 'No real weights entered yet'
        : err === null ? 'The plates could not be read on any of the videos with a real weight'
        : `Off by ${Math.round(err * 100)}% on average where the plates were read${missed ? `; not read on ${missed} of ${w.labelled}` : ''}` };
  }
  const withCheck = done.filter(r => (r.checks ?? []).some(k => k.id === c.id));
  const judged = withCheck.filter(r => r.trainer?.checks?.[c.id]);
  const right = judged.filter(r => r.trainer!.checks![c.id] === 'right').length;
  const accuracy = judged.length ? right / judged.length : null;
  return { seen: withCheck.length, judged: judged.length, right, accuracy,
    status: judged.length === 0 ? 'empty' : judged.length < 10 ? 'few' : judged.length < 30 || (accuracy ?? 0) < 0.85 ? 'learning' : 'reliable' };
}

export const COMPONENT_STATUS: Record<ComponentStats['status'], string> = {
  empty: 'Needs examples', few: 'Just started', learning: 'Learning', reliable: 'Reliable'
};

// ---- the AI's result beside the coach's ----
export type Answer = 'pass' | 'fail';

// What the coach says this check should have found: what they chose, else worked out from marking the AI right or wrong.
export function answerOf(r: AiReview, check: AiCheck): Answer | undefined {
  const given = r.trainer?.answers?.[check.id];
  if (given) return given;
  const mark = r.trainer?.checks?.[check.id];
  if (!mark || check.result === 'unclear') return undefined;
  return mark === 'right' ? check.result : check.result === 'pass' ? 'fail' : 'pass';
}

// Whether the AI and the coach agree: undefined until the coach has answered, or when the AI did not commit to a result.
export function agreement(r: AiReview, check: AiCheck): 'match' | 'differ' | 'unsure' | undefined {
  const a = answerOf(r, check);
  if (!a) return undefined;
  if (check.result === 'unclear') return 'unsure';
  return a === check.result ? 'match' : 'differ';
}

// The marks to save for the coach's answer to one check: the answer, and right or wrong when the AI committed to a result.
export function feedbackFor(check: AiCheck, answer: Answer): { answers: Record<string, Answer>; checks?: Record<string, 'right' | 'wrong'> } {
  return {
    answers: { [check.id]: answer },
    ...(check.result === 'unclear' ? {} : { checks: { [check.id]: check.result === answer ? 'right' as const : 'wrong' as const } })
  };
}

// ---- the submissions list ----
// Every video the AI has looked at, the athletes' own and the ones you added to teach it, in one list.
export interface SubmissionRow {
  id: string | null;       // the review's id; null for a training video not yet analysed
  name: string;
  test: VideoTest;
  date: string;
  source: 'Training video' | 'Athlete submission';
  status: 'done' | 'running' | 'error' | 'waiting';
  verdict?: AiReview['verdict'];
  judged: number;          // checklist items you have answered
  completed: boolean;      // you pressed Complete
  total: number;           // items on the checklist
  thumb: string;
  weight?: { estimate: number | null; real: number | null };
}

export function submissionRows(reviews: AiReview[], videos: AiTrainingVideo[], keep: (r: AiReview) => boolean): SubmissionRow[] {
  const rows: SubmissionRow[] = reviews.filter(keep).map(r => {
    const checks = checklistOf(r);
    return {
      id: r.id ?? null, name: r.id?.startsWith('tv_') ? (r.clientName || 'Training video') : r.clientName, test: r.test,
      date: r.analyzedAt ?? r.submittedAt, source: r.id?.startsWith('tv_') ? 'Training video' as const : 'Athlete submission' as const,
      status: r.status, verdict: r.verdict, judged: checks.filter(c => answerOf(r, c)).length, total: checks.length, completed: !!r.trainer?.completedAt,
      thumb: r.thumbs?.[1] ?? r.thumbs?.[0] ?? '',
      weight: r.weight ? { estimate: r.weight.estimate, real: r.trainer?.actualWeight ?? r.coachLabels?.actualWeight ?? null } : undefined
    };
  });
  // A training video the AI has not reached yet.
  for (const v of videos) {
    if (reviews.some(r => r.id === `tv_${v.id}_0`)) continue;
    if (!keep({ test: v.test, status: 'running' } as AiReview)) continue;
    rows.push({ id: null, name: v.name || 'Training video', test: v.test, date: v.createdAt, source: 'Training video', status: 'waiting', judged: 0, total: 0, completed: false, thumb: '' });
  }
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

// How often the AI matched you on the videos you have completed: each answered item where the AI gave a pass or a fail counts once.
export interface AiAccuracy { matched: number; answered: number; accuracy: number | null; missed: string[] }

export function accuracyOf(reviews: AiReview[]): AiAccuracy {
  let matched = 0, answered = 0;
  const missed: string[] = [];
  for (const r of reviews) for (const c of checklistOf(r)) {
    const a = agreement(r, c);
    if (a !== 'match' && a !== 'differ') continue;
    answered++;
    if (a === 'match') matched++; else if (!missed.includes(c.label)) missed.push(c.label);
  }
  return { matched, answered, accuracy: answered ? matched / answered : null, missed };
}
