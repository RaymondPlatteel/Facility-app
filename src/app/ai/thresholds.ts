import type { VideoTest } from './ai-review.types';

// The numbers each check judges by, in one place so the AI Trainer can show them and the coach can tune them. A value the
// coach has changed (aiConfig/thresholds in the database) replaces the default; everything else keeps the default.

export interface Tunable {
  key: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const t = (key: string, label: string, hint: string, value: number, min: number, max: number, step: number, unit = ''): Tunable =>
  ({ key, label, hint, value, min, max, step, unit });

const WEIGHT = t('weightSpread', 'Weight estimate range', 'How far either side of its estimate the weight can be before a claim is doubted. Smaller is stricter.', 14, 5, 40, 1, '%');
const SPEED = t('speedPass', 'Bar speed for a best lift', 'A new best should look at least this close to a max effort from the bar speed. Higher is stricter.', 72, 40, 100, 1, '%');
const PROGRESS = t('progress', 'Allowed progress', 'How fast results usually improve. 100% is the usual rate; lower flags big jumps sooner.', 100, 40, 300, 5, '%');
const VISIBLE_STD = t('visible', 'Athlete in frame', 'The share of the video the athlete must be visible for.', 70, 20, 100, 5, '%');

export const TUNABLES: Record<VideoTest, Tunable[]> = {
  deadlift: [
    t('lockout', 'Hip lockout', 'The hip angle at the top of a rep. 180 is fully upright.', 160, 140, 180, 1, '°'),
    t('knee', 'Knee lockout', 'The knee angle at the top of a rep.', 155, 140, 180, 1, '°'),
    t('floor', 'Start from the floor', 'The hips must start bent at least this much (a smaller angle is more bent).', 120, 80, 160, 1, '°'),
    SPEED, WEIGHT, PROGRESS, VISIBLE_STD
  ],
  squat: [
    t('lockout', 'Standing at the top', 'The knee angle at the top of a rep.', 155, 140, 180, 1, '°'),
    t('depth', 'Depth', 'The knee must bend at least this much at the bottom (smaller is deeper).', 95, 60, 130, 1, '°'),
    SPEED, WEIGHT, PROGRESS, VISIBLE_STD
  ],
  bench: [
    t('lockout', 'Arm lockout', 'The elbow angle at the top of a rep.', 155, 140, 180, 1, '°'),
    t('depth', 'Bar to the chest', 'The elbow must bend at least this much at the bottom.', 95, 50, 130, 1, '°'),
    t('hipRise', 'Hips on the bench', 'How much of an arm length the hips may rise before it is a problem.', 18, 5, 60, 1, '%'),
    SPEED, WEIGHT, PROGRESS, VISIBLE_STD
  ],
  pushups: [
    t('bend', 'Elbow bend', 'The elbow must bend at least this much at the bottom.', 100, 70, 130, 1, '°'),
    t('lockout', 'Arm lockout', 'The elbow angle at the top.', 150, 130, 180, 1, '°'),
    t('line', 'Straight body', 'The shoulder, hip and ankle angle; 180 is a straight line.', 150, 120, 180, 1, '°'),
    t('passShare', 'Reps that must pass', 'The share of reps that must meet a rule for the check to pass.', 90, 50, 100, 5, '%'),
    PROGRESS, VISIBLE_STD
  ],
  pullups: [
    t('hang', 'Full hang', 'The elbow angle at the bottom; 180 is a dead hang.', 145, 120, 180, 1, '°'),
    t('kip', 'Kipping', 'How far the hips may swing, as a share of the torso length.', 35, 10, 100, 5, '%'),
    t('passShare', 'Reps that must pass', 'The share of reps that must meet a rule for the check to pass.', 90, 50, 100, 5, '%'),
    PROGRESS, VISIBLE_STD
  ],
  longjump: [
    t('distance', 'Distance match', 'The measured distance must be at least this share of the claim. The camera angle can shorten it.', 85, 50, 100, 5, '%'),
    PROGRESS, VISIBLE_STD
  ],
  sprint: [
    t('length', 'Video length slack', 'How many seconds shorter than the claimed time the video may be.', 0.4, 0, 3, 0.1, ' s'),
    PROGRESS, t('visible', 'Athlete in frame', 'The share of the video the athlete must be visible for. Runners often leave the frame.', 30, 10, 100, 5, '%')
  ],
  run400: [
    t('length', 'Video length slack', 'How many seconds shorter than the claimed time the video may be.', 1.5, 0, 10, 0.5, ' s'),
    PROGRESS, t('visible', 'Athlete in frame', 'The share of the video the athlete must be visible for. Runners often leave the frame.', 30, 10, 100, 5, '%')
  ],
  pike: [
    t('hold', 'Hold time', 'How long the position must be held, in seconds.', 4.5, 2, 8, 0.5, ' s'),
    PROGRESS, VISIBLE_STD
  ],
  backbend: [
    t('hold', 'Hold time', 'How long the position must be held, in seconds.', 4.5, 2, 8, 0.5, ' s'),
    PROGRESS, VISIBLE_STD
  ]
};

// Settings that apply to every video, edited on the Video Integrity trainer.
export const GLOBAL_TUNABLES: Tunable[] = [
  t('cut', 'Cut sensitivity', 'A frame that changes this many times more than its neighbours counts as a cut. Lower finds more cuts.', 6, 2, 20, 1, '×'),
  t('duplicate', 'Same-video distance', 'How different two fingerprints may be and still count as the same footage (out of 64). Higher catches edited copies.', 6, 0, 16, 1, ' bits'),
  t('handsUp', 'Hands above the head', 'The share of the video the hands may be above the head before a deadlift or squat looks like a pull-up.', 30, 5, 80, 5, '%'),
  t('upright', 'Upright bench', 'The share of the video the lifter may be upright before a bench press looks like something else.', 60, 20, 95, 5, '%')
];

type Overrides = Record<string, Record<string, number>>;
let overrides: Overrides = {};

export function setThresholds(o: Overrides | null | undefined) { overrides = o ?? {}; }
export function getOverrides(): Overrides { return overrides; }

export function defaultOf(test: VideoTest | '*', key: string): number {
  const list = test === '*' ? GLOBAL_TUNABLES : TUNABLES[test];
  return list.find(x => x.key === key)?.value ?? 0;
}

// The value in force for a check: the coach's setting, else the default.
export function thr(test: VideoTest | '*', key: string): number {
  const v = overrides[test]?.[key];
  return typeof v === 'number' && isFinite(v) ? v : defaultOf(test, key);
}
