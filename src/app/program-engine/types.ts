import type { OmniRank, ProgramDay, ProgramExercise } from '../services/firebase.service';

// Everything the generator needs to know about one athlete.
export interface AthleteState {
  seed: string;             // keeps the small random variations repeatable (the athlete's name key)
  strengthRank: OmniRank;   // the strength category rank (bench, squat, deadlift, pull-up); sets the split and the days
  minutes: number[];        // Monday first: minutes available each day, 0 = off
  pushupMax: number;        // reps in the latest assessment
  pushupRank: OmniRank;     // the pushup TEST rank
  pullupMax: number;        // reps in the latest assessment
  pullupRank: OmniRank;     // the pull-up TEST rank
  flexibilityRanks: Record<'pike' | 'backbend' | 'straddle', OmniRank>;   // each flexibility test ranks on its own
  cardioRank: OmniRank;      // the cardio category rank (30 minute run and 800 m run)
  speed2Km: number;          // km in 2 minutes implied by the 800 m run assessment
  units: 'imperial' | 'metric';
  powerRanks: Record<'longjump' | 'sprint', OmniRank>;   // the broad jump and the 100 m sprint, each on its own
  resilienceLoads?: Partial<Record<string, number>>;   // latest resilience test resistance, when known
  bodyWeight: number;       // lb, from the latest assessment
  resilienceDays?: boolean[];   // the days (Monday first) the athlete chose for resilience; absent = the program picks one
  dailyCardio: boolean[];   // the days (Monday first) the athlete chose for an easy daily run on days with no cardio
}

export interface EngineOptions {
  weeks: number;            // length of the cycle that repeats: weekly patterns (leg-day alternation, max tests) play out across it
  ending?: boolean;         // the athlete cancelled: the final week finishes with a test
}

// One day of one week while the program is being assembled. Modules add to it in order,
// so a module can look at what earlier ones placed (the pushup rule needs to know which
// days have bench press).
export interface PlanDay {
  index: number;            // 0 = Monday
  minutes: number;
  exercises: ProgramExercise[];
  hasBench: boolean;
  reserved: boolean;        // taken whole by one session (resilience); other modules skip it
}

export type EngineModule = (state: AthleteState, week: PlanDay[], weekIndex: number, opts: EngineOptions) => void;

export type { ProgramDay, ProgramExercise };
