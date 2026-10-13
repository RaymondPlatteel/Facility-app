import type { AthleteState, EngineModule, PlanDay } from './types';
import type { ProgramExercise } from '../services/firebase.service';
import { attr } from './pushups';

// ---------- Strength: bench, squat, deadlift and pull-up ----------
//
//  Who trains how, by the athlete's strength rank (the strength category, not the overall level):
//    Unranked   up to 3 full-body days. 4 rounds (bench, squat, pull-up, deadlift), one main lift each plus
//               2 accessories, as a circuit.
//    D          up to 3 full-body days. 3 rounds (bench, squat OR deadlift, pull-up), one main lift each plus
//               1 accessory, as pairs. A lower-body day is the one lift.
//    C          up to 3 full-body days: bench, pull-up, and squat OR deadlift. One exercise at a time.
//    B          3 full-body days to 4 training days. 5 or more days: 4 upper/lower days (2 upper, 2 lower).
//    A and S    3 or 4 training days: 3 full-body days. 5 or 6 days: 4 upper/lower days (two on, one off, two on).
//               7 days: 6 upper/lower days. 2 sets.
//  With fewer days than the rank's target, the athlete trains full body on the days they have. Exactly two
//  back-to-back days are an upper day and a lower day instead. Upper
//  days hold bench and pull-up; lower days alternate squat and deadlift (ABA, then BAB, week to week),
//  and squat and deadlift share a day only for Unranked.
//
//  Loads are set by RIR. Rep scheme rotates across the days: 5s at 3 RIR, 3s at 3 RIR, 3s at 1 RIR
//  (a two-day week skips the middle one). Pull-ups are always at 1 RIR.
//  Pull-ups follow the pull-up test rank (endurance reps), not the strength rank:
//    Unranked   assisted pull-ups, 3 sets of 8.
//    D          bodyweight pull-ups, 3 sets to the most reps possible.
//    C and B    weighted pull-ups, 3 sets of 8.
//    A and S    weighted pull-ups at the day's rep count, with bench's sets.
//  Accessories are not defined yet; the slots are in place.

const BENCH = 'Barbell Bench Press';
const SQUAT = 'Barbell Squat';
const DEADLIFT = 'Barbell Deadlift';

interface Scheme { reps: number; rir: number; }
const SCHEMES: Scheme[] = [{ reps: 5, rir: 3 }, { reps: 3, rir: 3 }, { reps: 3, rir: 1 }];

// The scheme for the i-th day of n days of one kind in a week.
export function schemeFor(i: number, n: number): Scheme {
  if (n <= 1) return SCHEMES[0];
  if (n === 2) return i === 0 ? SCHEMES[0] : SCHEMES[2];
  return SCHEMES[Math.min(i, 2)];
}

// Accessory exercises, filled in once they are defined.
export const ACCESSORIES: Record<'bench' | 'squat' | 'deadlift' | 'pullup', ProgramExercise[]> = {
  bench: [], squat: [], deadlift: [], pullup: []
};

type Kind = 'full' | 'upper' | 'lower';
type Lift = 'bench' | 'squat' | 'deadlift' | 'pullup';
const NAMES: Record<Exclude<Lift, 'pullup'>, string> = { bench: BENCH, squat: SQUAT, deadlift: DEADLIFT };

// The k training days that sit furthest apart, counting Sunday into Monday; the most even spacing, then the earliest, breaks a tie.
export function spreadDays(training: number[], k: number): number[] {
  if (k >= training.length) return [...training];
  let best: number[] = [];
  let bestGap = -1;
  let bestSpread = Infinity;
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === k) {
      const gaps = chosen.map((d, i) => (i === k - 1 ? chosen[0] + 7 - d : chosen[i + 1] - d));
      const g = Math.min(...gaps);
      const spread = gaps.reduce((a, x) => a + (x - 7 / k) ** 2, 0);   // evenness breaks ties
      if (g > bestGap || (g === bestGap && spread < bestSpread - 1e-9)) { bestGap = g; bestSpread = spread; best = [...chosen]; }
      return;
    }
    for (let i = start; i < training.length; i++) pick(i + 1, [...chosen, training[i]]);
  };
  pick(0, []);
  return best;
}

// Four upper/lower days run two on, one off, two on, two off: Monday and Tuesday, then Thursday and Friday.
// Looks for that pattern on the athlete's days, starting as early in the week as it fits.
export function pairedDays(training: number[]): number[] | null {
  for (let s = 0; s < 7; s++) {
    const four = [s, (s + 1) % 7, (s + 3) % 7, (s + 4) % 7];
    if (four.every(d => training.includes(d))) return four.sort((a, b) => a - b);
  }
  return null;
}

interface Layout { kinds: Kind[]; fullBody: 'all' | 'one-lower'; }

// What the athlete's week looks like, from their rank and how many days they have.
export function layoutFor(rank: AthleteState['strengthRank'], days: number): Layout {
  const upperLower = (n: number): Layout => ({ kinds: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 'upper' : 'lower')), fullBody: 'one-lower' });
  const full = (n: number, mode: Layout['fullBody']): Layout => ({ kinds: Array.from({ length: n }, () => 'full' as Kind), fullBody: mode });
  if (rank === 'UNRANKED') return full(Math.min(3, days), 'all');
  if (rank === 'D-RANK' || rank === 'C-RANK') return full(Math.min(3, days), 'one-lower');
  if (rank === 'B-RANK') return days <= 4 ? full(Math.min(3, days), 'one-lower') : upperLower(4);
  // A and S: full body to four days, four upper/lower days at five and six, six at seven
  if (days <= 4) return full(Math.min(3, days), 'one-lower');
  return upperLower(days >= 7 ? 6 : 4);
}

function mainLift(lift: Exclude<Lift, 'pullup'>, s: Scheme, sets: number, round?: string): ProgramExercise {
  return {
    name: NAMES[lift],
    attributes: [attr('Sets', 'Fixed', String(sets)), attr('Reps', 'Fixed', String(s.reps)), attr('Load', 'User Input', ''), attr('RIR', 'Fixed', String(s.rir))],
    ...(round ? { instructions: round } : {})
  };
}

// Pull-ups follow the pull-up test rank. Always 1 RIR; A and S take bench's sets and the day's reps.
function pullup(rank: AthleteState['strengthRank'], bench: Scheme, sets: number, round?: string): ProgramExercise {
  const base = (name: string, reps: ReturnType<typeof attr>, note?: string): ProgramExercise => ({
    name,
    attributes: [attr('Sets', 'Fixed', String(rank === 'A-RANK' || rank === 'S-RANK' ? sets : 3)), reps, attr('Load', 'User Input', ''), attr('RIR', 'Fixed', '1')].filter(a => a.type !== 'Load' || name.startsWith('Weighted')),
    instructions: [round, note].filter(Boolean).join(' ')
  });
  if (rank === 'UNRANKED') {
    return base('Assisted pull-up', attr('Reps', 'Fixed', '8'),
      'Use a band or an assisted pull-up machine. Controlled negatives, lowering slowly from the top, also count. A single-arm cable row is an alternative.');
  }
  if (rank === 'D-RANK') return base('Pull-up', attr('Reps', 'AMRAP', ''), 'Bodyweight. Stop each set one repetition short of failure.');
  if (rank === 'C-RANK' || rank === 'B-RANK') return base('Weighted pull-up', attr('Reps', 'Fixed', '8'));
  return base('Weighted pull-up', attr('Reps', 'Fixed', String(bench.reps)));
}

export const strengthModule: EngineModule = (state: AthleteState, week: PlanDay[], weekIndex) => {
  const training = week.filter(d => d.minutes > 0 && !d.reserved).map(d => d.index);
  if (!training.length) return;
  let layout = layoutFor(state.strengthRank, training.length);
  let days = (layout.kinds.length === 4 && layout.kinds[0] === 'upper' && pairedDays(training)) || spreadDays(training, layout.kinds.length);

  // Three full-body days in a row: the first and third train, and the middle day is left for the other work.
  if (layout.kinds.every(k => k === 'full')) {
    const middle = days.find(d => days.includes((d + 6) % 7) && days.includes((d + 1) % 7));
    if (middle !== undefined) {
      days = days.filter(d => d !== middle);
      layout = { ...layout, kinds: layout.kinds.slice(0, days.length) };
    }
  }

  // Exactly two days, back to back (counting Sunday into Monday): one upper day and one lower day.
  const backToBack = days.length === 2 && Math.min(days[1] - days[0], days[0] + 7 - days[1]) === 1;
  if (backToBack) layout = { kinds: ['upper', 'lower'], fullBody: 'one-lower' };

  const sets = state.strengthRank === 'A-RANK' || state.strengthRank === 'S-RANK' ? 2 : 3;
  // The endurance programs need five training days; with fewer, an A or S pull-up rank trains as C.
  const pullupRank = (state.pullupRank === 'A-RANK' || state.pullupRank === 'S-RANK') && training.length < 5 ? 'C-RANK' : state.pullupRank;
  const rounds = state.strengthRank === 'UNRANKED' || state.strengthRank === 'D-RANK';

  const count = (k: Kind) => layout.kinds.filter(x => x === k).length;
  const seen: Record<Kind, number> = { full: 0, upper: 0, lower: 0 };
  const lowerPerWeek = count('lower') + (layout.fullBody === 'one-lower' ? count('full') : 0);
  let lowerInWeek = 0;

  days.forEach((dayIndex, n) => {
    const kind = layout.kinds[n];
    const day = week.find(d => d.index === dayIndex)!;
    // Two back-to-back days rotate their scheme across the two days; otherwise by day of each kind.
    const scheme = backToBack ? schemeFor(n, 2) : schemeFor(seen[kind], count(kind));
    seen[kind]++;

    // squat and deadlift alternate on every lower-body slot, continuing across weeks
    const lowerLift = (): 'squat' | 'deadlift' => ((weekIndex * lowerPerWeek + lowerInWeek++) % 2 === 0 ? 'squat' : 'deadlift');

    if (rounds) {
      // Unranked circuits (3 exercises a round) and D pairs (2): one main lift per round. Unranked trains squat and
      // deadlift on the same day; D trains one of them, alternating like the ranks above.
      const unranked = state.strengthRank === 'UNRANKED';
      const accessories = unranked ? 2 : 1;
      const order: Lift[] = unranked
        ? (kind === 'upper' ? ['bench', 'pullup'] : kind === 'lower' ? ['squat', 'deadlift'] : ['bench', 'squat', 'pullup', 'deadlift'])
        : (kind === 'upper' ? ['bench', 'pullup'] : kind === 'lower' ? [lowerLift()] : ['bench', lowerLift(), 'pullup']);
      order.forEach((lift, r) => {
        const label = `Round ${r + 1} of ${order.length}.`;
        const main = lift === 'pullup' ? pullup(pullupRank, scheme, sets) : mainLift(lift, scheme, sets);
        const extra = ACCESSORIES[lift].slice(0, accessories);
        const group = extra.length ? `${label} Alternate sets with the other exercises in this round.` : label;
        day.exercises.push({ ...main, instructions: [group, main.instructions].filter(Boolean).join(' ') });
        extra.forEach(e => day.exercises.push({ ...e, instructions: [group, e.instructions].filter(Boolean).join(' ') }));
      });
      if (kind !== 'lower') day.hasBench = true;
      return;
    }

    if (kind === 'upper' || kind === 'full') {
      day.exercises.push(mainLift('bench', scheme, sets));
      day.exercises.push(pullup(pullupRank, scheme, sets));
      day.hasBench = true;
    }
    if (kind === 'lower' || kind === 'full') day.exercises.push(mainLift(lowerLift(), scheme, sets));
  });
};
