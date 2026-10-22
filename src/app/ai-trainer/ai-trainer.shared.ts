import { AiReview, TEST_LABELS, VIDEO_TESTS, VideoTest, decisionOf, actualWeightOf } from '../ai/ai-review.types';
import { weightScores } from './ai-trainer.components';

export type Area = VideoTest | 'weight' | 'integrity';
export const LIFTS: readonly VideoTest[] = ['deadlift', 'squat', 'bench'];
export const INTEGRITY_CHECKS = ['uncut', 'original', 'movement', 'visible'];

export function isArea(a: string): a is Area { return a === 'weight' || a === 'integrity' || (VIDEO_TESTS as readonly string[]).includes(a); }

export function areaTitle(a: Area): string {
  return a === 'weight' ? 'Weight' : a === 'integrity' ? 'Video Integrity' : TEST_LABELS[a];
}

export interface AreaStats {
  examples: number;       // reviewed videos
  taught: number;         // with a decision (the coach's or the trainer's)
  agree: number | null;   // share of those the AI agreed with, 0 to 1
  attention: number;      // reviewed videos nobody has judged that the AI was unsure about
  status: 'empty' | 'few' | 'learning' | 'reliable';
  extra?: string;
}

const agrees = (r: AiReview) => (r.verdict === 'likely-invalid') === (decisionOf(r) === 'rejected');

export function statsFor(area: Area, reviews: AiReview[]): AreaStats {
  const done = reviews.filter(r => r.status === 'done');
  if (area === 'weight') {
    const lifts = done.filter(r => (LIFTS as readonly string[]).includes(r.test) && r.weight);
    const w = weightScores(done);
    const err = w.plates.error;
    return { examples: lifts.length, taught: w.labelled, agree: w.labelled && err !== null ? Math.max(0, 1 - err) * (w.plates.estimated / w.labelled) : w.labelled ? 0 : null,
      attention: lifts.filter(r => !actualWeightOf(r)).length,
      status: w.labelled === 0 ? 'empty' : w.labelled < 8 ? 'few' : w.labelled < 30 ? 'learning' : 'reliable',
      extra: err === null ? (w.labelled ? 'Plates not read on the videos with a real weight' : 'No real weights entered yet') : `Plate reading off by ${Math.round(err * 100)}% on average` };
  }
  if (area === 'integrity') {
    const flagged = done.filter(r => (r.checks ?? []).some(c => INTEGRITY_CHECKS.includes(c.id) && c.result !== 'pass'));
    const judged = flagged.filter(r => Object.keys(r.trainer?.checks ?? {}).some(k => INTEGRITY_CHECKS.includes(k)));
    const right = judged.reduce((s, r) => s + Object.keys(r.trainer!.checks!).filter(k => INTEGRITY_CHECKS.includes(k) && r.trainer!.checks![k] === 'right').length, 0);
    const all = judged.reduce((s, r) => s + Object.keys(r.trainer!.checks!).filter(k => INTEGRITY_CHECKS.includes(k)).length, 0);
    return { examples: done.length, taught: judged.length, agree: all ? right / all : null, attention: flagged.length - judged.length,
      status: judged.length === 0 ? 'empty' : judged.length < 10 ? 'few' : judged.length < 30 ? 'learning' : 'reliable',
      extra: `${flagged.length} video${flagged.length === 1 ? '' : 's'} flagged` };
  }
  const list = done.filter(r => r.test === area);
  const taught = list.filter(r => decisionOf(r));
  const ag = taught.length ? taught.filter(agrees).length / taught.length : null;
  return { examples: list.length, taught: taught.length, agree: ag,
    attention: list.filter(r => !decisionOf(r) && r.verdict !== 'likely-valid').length,
    status: taught.length === 0 ? 'empty' : taught.length < 10 ? 'few' : taught.length < 30 || (ag ?? 0) < 0.85 ? 'learning' : 'reliable' };
}

export const STATUS_TEXT: Record<AreaStats['status'], string> = {
  empty: 'Needs examples', few: 'Just started', learning: 'Learning', reliable: 'Reliable'
};
