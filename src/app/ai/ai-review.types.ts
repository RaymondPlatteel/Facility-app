// The AI reviewer's records. It watches every video proof the athletes send, scores it, and keeps what it found next
// to the coach's own decision, so it can be measured against the coach and learn from every review. It never decides
// anything an athlete sees: the coach still approves or rejects every submission.

// The tests whose proof is a video. The 30-minute run (an imported recording) and the middle split (a measured
// photo) are checked elsewhere.
export type VideoTest = 'deadlift' | 'squat' | 'bench' | 'longjump' | 'sprint' | 'pushups' | 'pullups' | 'run400' | 'pike' | 'backbend';
export const VIDEO_TESTS: readonly VideoTest[] = ['deadlift', 'squat', 'bench', 'longjump', 'sprint', 'pushups', 'pullups', 'run400', 'pike', 'backbend'];

export const TEST_LABELS: Record<VideoTest, string> = {
  deadlift: 'Deadlift', squat: 'Squat', bench: 'Bench Press', longjump: 'Long Jump', sprint: '100 m Sprint',
  pushups: 'Push-ups', pullups: 'Pull-ups', run400: '400 m Run', pike: 'Pike', backbend: 'Backbend'
};

// pass: the video shows it. fail: the video shows something else. unclear: the video cannot settle it (camera angle,
// lighting, a body part out of frame); those go to the coach without counting against the athlete.
export type CheckResult = 'pass' | 'fail' | 'unclear';

export interface AiCheck {
  id: string;
  label: string;
  result: CheckResult;
  detail: string;
  // A failed critical check makes the whole verdict "likely invalid" on its own.
  critical?: boolean;
}

export type AiVerdict = 'likely-valid' | 'needs-review' | 'likely-invalid';

export interface AiReview {
  id?: string;                 // `${pendingId}_${slot}`
  pendingId: string;
  slot: number;
  test: VideoTest;
  nameKey: string;
  clientName: string;
  submittedAt: string;
  videoUrl: string;
  status: 'running' | 'done' | 'error';
  runner?: string;
  startedAt?: string;
  error?: string | null;
  modelVersion: string;
  analyzedAt?: string;
  // What the athlete claimed: the score, and for lifts the weight (lb) and reps behind it.
  claimed: { value: number; weight?: number | null; reps?: number | null };
  video?: { duration: number; width: number; height: number; frames: number; personFrames: number };
  checks?: AiCheck[];
  // Every number the analysis measured, kept so later models can learn from them.
  features?: Record<string, number>;
  // Readable estimates for the coach (reps seen, bar speed, a velocity-based 1RM, a measured jump distance).
  estimates?: Record<string, number | string>;
  ruleScore?: number;          // 0 to 1, from the checks
  learnedScore?: number | null; // 0 to 1, from the model trained on the coach's past decisions
  verdict?: AiVerdict;
  confidence?: number;         // 0 to 1
  hashes?: string[];           // fingerprints of a few frames, to catch a video sent twice
  thumbs?: string[];           // small stills (start, middle, end) for checking the plates at a glance
  duplicateOf?: { pendingId: string; clientName: string } | null;
  // The coach's decision on the submission, recorded when they approve or reject it. null until then.
  coachDecision: 'approved' | 'rejected' | null;
  decidedAt?: string | null;
  // Optional quick labels the coach can add while reviewing, the first being whether the weight looked right.
  coachLabels?: { weight?: 'ok' | 'doubtful'; actualWeight?: number | null } | null;
  // The weight check: what the video suggests the bar held, against what was claimed. Made before any other check.
  weight?: WeightEstimate | null;
  plateReading?: PlateReading | null;
}

export interface WeightEstimate {
  claimed: number | null;
  estimate: number | null;     // lb; null when the video cannot support one
  low: number | null;
  high: number | null;
  ratio: number | null;        // claimed / estimate
  method: 'speed' | 'learned' | 'plates' | 'none';
  basis: string;               // how it was worked out, in words
  reference: number | null;    // the athlete's best verified result in this test, the estimate's anchor
}

// What a vision model made of the plates on the bar, when plate reading is switched on (config/ai.plateReaderUrl).
export interface PlateReading {
  totalLb: number | null;      // bar plus plates, in lb
  confidence: 'low' | 'medium' | 'high';
  notes: string;               // e.g. "Left: 45 + 25. Right: 45 + 25. 45 lb bar."
}

export interface AiModel {
  id?: string;
  kind: 'logistic' | 'weight';
  featureNames: string[];
  weights: number[];           // bias first
  mean: number[];
  std: number[];
  n: number;
  positives: number;
  accuracy: number;            // leave-one-out accuracy on the labelled reviews
  ruleAccuracy: number;        // how often the rules alone agreed with the coach on the same reviews (for the weight model: the error of the plain speed estimate)
  trainedAt: string;
}

export const MODEL_VERSION = 'v8';
