import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, getDocs, doc, updateDoc, deleteDoc, query, orderBy, where, deleteField, setDoc, getDoc, writeBatch, limit } from 'firebase/firestore';
import { environment } from '../../environments/environment';
import { describeAssessmentChange, computeOmni, getOmniRank } from './omni.util';

// Local calendar date (YYYY-MM-DD). toISOString() would shift evening check-ins to the next UTC day.
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface Student {
  id?: string;
  name: string;
  email?: string;
  phone?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface Session {
  id?: string;
  date: Date;
  name: string;
  participants: string[];
  attendance?: AttendanceRecord[];
  wellness?: WellnessData[];
  workoutId?: string; // Link to a workout
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AttendanceRecord {
  sessionId: string;
  studentName: string;
  checkInTime: string;
  date: string;
  present: boolean;
}

// One gym visit recorded from the kiosk. Source of truth for attendance + session usage.
export interface CheckIn {
  id?: string;
  clientId: string | null;     // clientProfiles doc id (null if profile missing)
  clientName: string;
  date: string;                // local YYYY-MM-DD
  checkInTime: string;         // ISO timestamp
  packageId: string | null;    // package the session was deducted from
  packageName?: string;
  sessionType?: string;
  decremented: boolean;        // false when client had no active package / no sessions left
  status?: AttendanceStatus;   // present (default for kiosk check-ins) | excused | unexcused
  sessionsRemainingAfter?: number | null;
  packageTotalSessions?: number | null;
  createdAt?: string;
}

// Attendance state a trainer can set per client, per session, from the schedule.
//  - present:   attended; deducts one session
//  - excused:   absence with notice; no deduction
//  - unexcused: no-show; deducts one session
export type AttendanceStatus = 'present' | 'excused' | 'unexcused';

// A per-occurrence reschedule of a recurring session. Identified by the package
// plus the ORIGINAL recurring date, so editing a package never loses overrides.
export interface SessionOverride {
  id?: string;
  packageId: string;
  originalDate: string;  // YYYY-MM-DD of the recurring occurrence being changed
  newDate: string;       // rescheduled date (YYYY-MM-DD)
  newTime: string;       // rescheduled time ('HH:mm')
  createdAt?: string;
}

// A one-off session that isn't tied to any recurring package — e.g. a trial,
// a single extra session, or a one-time meeting. Rendered on the Schedule
// page alongside package-generated occurrences (see schedule.util.ts,
// which folds these into the same ScheduleEntry shape with a synthetic
// `single:<id>` packageId), but lives in its own collection since it has no
// package to belong to and nothing to decrement.
export interface SingleSession {
  id?: string;
  date: string;               // YYYY-MM-DD
  time: string;                // 'HH:mm', '' if unset
  durationMinutes: number;
  sessionType: 'Private' | 'Semi' | 'Group';
  title: string;                // shown as the session name on the card
  clientIds: string[];
  clientNames: string[];
  notes?: string;
  trainerId?: string; // which trainer runs it (see TRAINERS in auth.service)
  createdAt?: string;
  updatedAt?: string;
}

// An athlete's self-service request to move one of their own sessions to a
// different day/time — the mobile app (Project 000) creates these directly
// against this same collection; a coach approves or denies from Schedule.
// Approving applies the exact same mechanism a coach's own manual
// reschedule uses (a SessionOverride, or a direct SingleSession edit) so
// an approved swap is indistinguishable from one the coach made themselves.
export interface SwapRequest {
  id?: string;
  // 'swap' (default, for older records with no kind stored): move one of
  // the athlete's own existing sessions. 'openGym': not tied to any
  // existing session — a fresh self-directed slot request. originalDateKey/
  // originalTime/packageId/isSingle/singleSessionId are all meaningless for
  // an openGym request and stay blank/false.
  kind?: 'swap' | 'openGym';
  clientId: string;         // best-effort; clientName is the reliable key
  clientName: string;
  packageId: string;        // '' when isSingle or kind === 'openGym'
  isSingle: boolean;
  singleSessionId?: string; // set when isSingle
  originalDateKey: string;  // YYYY-MM-DD of the occurrence being moved; '' for openGym
  originalTime: string;
  requestedDateKey: string;
  requestedTime: string;
  sessionType: string;
  durationMinutes: number;
  status: 'pending' | 'approved' | 'denied';
  note?: string;
  createdAt: string;
  respondedAt?: string;
}

export interface FeedbackData {
  id?: string;
  studentName: string;
  feedback: string;
  submittedDate: string;
  sessionName?: string;
  rating?: number;
}

export interface StudentStats {
  studentName: string;
  totalSessions: number;
  attendedSessions: number;
  missedSessions: number;
  makeUpSessionsRemaining: number;
}

// CRM Client Profile stored separately for editable fields
export interface ClientProfile {
  id?: string; // Firestore doc id (clientId)
  clientId: string; // human-friendly id like CL-0001
  nameKey: string; // normalized key to join by name if no id yet
  fullName: string;
  email?: string;
  phone?: string;
  birthdate?: string; // ISO string
  referralSource?: string;
  onboardDate: string; // ISO string when created
  currentStatus?: 'prospect' | 'active' | 'paused' | 'inactive';
  linkedPackages?: number;
  totalPackages?: number;
  totalRevenue?: number;
  // Job Request Board: hours entered by hand once a client finishes a job
  // they accepted in Project-000 — not derived/summed automatically.
  totalHours?: number;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Job Request Board ----------
// Posted here, browsed/accepted in Project-000 (shared Firestore project).
// quantityAvailable is decremented atomically by Project-000's acceptJob
// transaction, never written directly from this app once a job is live.
export interface JobPosting {
  id?: string;
  jobId: string;
  title: string;
  description: string;
  hours: number;
  quantityTotal: number;
  quantityAvailable: number;
  // How many times one client may accept THIS job PER WEEK (e.g. a recurring
  // chore can be taken more than once) — null means no limit. Resets every
  // Monday at 6am Eastern. Enforced atomically in Project-000's acceptJob
  // transaction, not just a UI hint.
  maxPerClient: number | null;
  // Whether the whole pool (quantityAvailable) automatically refills back up
  // to quantityTotal on a schedule — null means it never auto-refills and
  // only changes via accept/undo/coach edits. Reset is lazy (no cron job):
  // the next accept/undo/read in Project-000 after the period rolls over
  // just treats the pool as full again.
  quantityResetCadence: 'weekly' | 'monthly' | null;
  // The period (week-of or month-of key) that quantityAvailable currently
  // reflects.
  quantityPeriodKey: string | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt?: string;
}

// A client can hold more than one of these for the same job (up to its
// maxPerClient).
export interface JobAcceptance {
  id?: string;
  jobId: string;
  jobTitle: string;
  jobHours: number;
  clientName: string;
  nameKey: string;
  acceptedAt: string;
}

// Denormalized per-athlete record (members/{nameKey}), shared with the
// mobile client app: cell/generation/cohort is the "000"-style group code
// self-reported in mobile Settings (now also coach-settable here), plus a
// cached snapshot of latest level/rank/activity kept current by
// touchMemberActivity() on every assessment save.
// The athlete's single target assessment (assessmentGoals/{nameKey}).
//
// Mirrors the mobile app's interface exactly — same collection, same
// nameKey-derived doc id — so a goal a coach sets here IS the goal the
// athlete sees in Project 000, not a parallel copy. One doc per athlete,
// which is what enforces "you only have one set of goals": a second save
// overwrites by construction rather than by convention.
export interface AssessmentGoal {
  // Doc id: `${nameKey}::${targetDate || '_notarget'}` — one athlete can
  // have several goals now, one per distinct target date (or one dateless
  // "someday" goal), instead of a single target that saving again replaced.
  id?: string;
  nameKey: string;
  clientName: string;
  inputs: AssessmentInputs;
  lvl: number;
  rank: OmniRank;
  updatedAt: string;
  // 'athlete', 'coach', or a Story Mode character's name, so the athlete
  // can tell where a target came from.
  updatedBy: string;
  // When they're aiming to hit it — optional, YYYY-MM-DD. Also what
  // distinguishes one of an athlete's goals from another — see id.
  targetDate?: string;
}

export interface Member {
  nameKey: string;
  clientName: string;
  // Absent on every record written before rank thresholds became
  // sex-specific; treated as 'male' wherever it is read.
  sex?: Sex;
  cell: number | null;
  generation: number | null;
  cohort: number | null;
  latestLvl: number | null;
  latestRank: OmniRank | null;
  lastActivityAt: string | null;
  lastActivityLabel: string | null;
}

export interface PaymentRecord {
  id?: string;
  studentName: string;
  amount: number;
  date: string;
  sessionType: 'private' | 'semi-private' | 'group';
  numSessions: number;
  discountPercent: number;
  paymentMethod: 'cash' | 'venmo' | 'zelle' | 'other';
  paymentStatus: 'paid' | 'planning';
  notes?: string;
  createdAt?: string;
}
// One linked client's price on a package, and how much of it they've paid.
export interface ClientPayment {
  amount: number;       // this client's price for the package (can differ per client)
  paid: boolean;        // fully paid checkbox
  amountPaid?: number;  // running partial amount, relevant only while !paid
  // Coach has approved this client to pay later / in installments. While
  // true, the client is treated as cleared to schedule even though `paid`
  // is false — suppresses the "unpaid" flag instead of just leaving them
  // flagged as if payment were simply forgotten.
  paymentPlan?: boolean;
}

// Packages CRM
export interface PackageRecord {
  id?: string; // Firestore doc id
  packageId: string; // human-friendly e.g., PKG-0001
  packageName: string;
  linkedClientIds: string[]; // references to clientProfiles doc ids
  linkedClientNames?: string[]; // denormalized for display
  sessionType: 'Private' | 'Semi' | 'Group';
  sessionDurationMinutes: number; // 60 default
  sessionsPerWeek: number;
  packageDuration: number; // months, user-typed
  totalSessions: number;
  sessionsRemaining?: number;
  daysOfWeek: string[]; // ['Mon','Wed']
  dayTimes?: { [day: string]: string }; // e.g., { Tue: "17:00", Thu: "18:30" }
  // A flat pack of sessions with no recurring weekly slot — daysOfWeek stays
  // empty (so it never shows up on the recurring Schedule calendar) and
  // totalSessions is coach-entered directly instead of derived from
  // daysOfWeek.length x weeks. Each session gets logged ad hoc as it
  // happens rather than being pre-scheduled.
  perSessionPack?: boolean;
  cost: number; // derived: sum of clientPayments amounts
  clientPayments?: { [clientId: string]: ClientPayment };
  trainerId?: string; // which trainer runs these sessions (see TRAINERS in auth.service)
  purchaseDate?: string; // ISO
  expirationDate?: string; // ISO (auto-calculated)
  status: 'active' | 'completed' | 'prospect';
  // Set by the payments Worker when an athlete starts an auto-renewing
  // monthly membership; cleared (and subscriptionCanceledAt stamped) when
  // it's cancelled. Read-only from this app — billing state belongs to
  // Stripe, and the Worker is what reconciles it.
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  subscriptionCanceledAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WaiverData {
  id?: string;
  waiverType: 'adult' | 'child';
  studentName: string;
  signedDate: string;
  signatureDataUrl: string;
  clientId?: string | null; // linked clientProfiles doc id, if selected from an existing client
  // Adult waiver fields
  fullName?: string;
  phone?: string;
  email?: string;
  // Child waiver fields
  childName?: string;
  guardianName?: string;
  guardianPhone?: string;
  guardianEmail?: string;
  // Timestamps
  createdAt?: string;
}

export interface WellnessData {
  id?: string;
  studentName: string;
  sessionId: string;
  date: string;
  checkInTime: string;
  sleepQuality: number; // 1-10
  energyLevel: number; // 1-10
  stressLevel: number; // 1-10 (1 = low stress, 10 = high stress)
  ateHealthy: boolean; // Yes/No
  drankWater: boolean; // Yes/No
}

export interface Exercise {
  id?: string;
  name: string;
  sets: number;
  reps: string; // Can be ranges like "8-12" or specific like "10"
  percent?: string; // Percentage of max effort, weight, etc. - customizable per student (optional)
  rir?: number; // Rate of Perceived Exertion (0-10)
  notes?: string;
  restTime?: string; // Rest between sets
  tempo?: string; // e.g., "2-1-2-1" (eccentric-pause-concentric-pause)
}

export interface WorkoutSection {
  id?: string;
  name: string; // warm-up, strength, endurance, cardio, speed, power, flexibility, cooldown, other
  exercises: Exercise[];
  duration?: number; // Total time for section in minutes
  notes?: string;
}

export interface Workout {
  id?: string;
  name: string;
  description?: string;
  sections: WorkoutSection[];
  totalDuration?: number; // Total workout time in minutes
  equipment?: string[]; // List of required equipment
  tags?: string[]; // Categories like "Upper Body", "HIIT", "Strength", etc.
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string; // Who created the workout
}

// ---------- Training programs (program creator) ----------
// A prescription attribute on an exercise, e.g. { type: 'Reps', strategy: 'Range', val: '8-12' }.
export interface ProgramAttribute {
  id: string;
  type: string;     // 'Sets' | 'Reps' | 'Load' | 'RIR' | 'RPE' | 'Tempo' | 'Duration' | distance/speed/pace units...
  strategy: string; // 'Fixed' | 'Range' | '%1RM' | 'AMRAP' | 'Bodyweight' | 'User Input'
  val: string;
}

export interface ProgramExercise {
  name: string;
  attributes: ProgramAttribute[];
}

export interface ProgramDay {
  id: number;            // index within the schedule
  name: string;
  notes: string;
  isRestDay: boolean;
  repeat: string;        // 'Never' | 'Repeat every cycle' | 'Custom'
  repeatEndAfter?: number;
  repeatCustomDays?: number[];
  exercises: ProgramExercise[];
}

export interface Program {
  id?: string;
  name: string;
  description?: string;
  goals?: string;
  fitnessLevel?: string;
  cycles: number;          // weeks when isStandardWeek
  daysPerCycle: number;
  isStandardWeek: boolean;
  durationPerDayMinutes?: number;
  equipment?: string[];
  schedule: ProgramDay[];  // length = cycles * daysPerCycle
  assignedClientIds?: string[];
  assignedClientNames?: string[];
  // Optional. When set, the client app computes "today's" day (schedule
  // index) from calendar days elapsed since this date rather than from how
  // many workouts the client has actually completed — the program marches
  // forward on the calendar whether or not sessions are done on time. Local
  // YYYY-MM-DD, no time component. null/absent = no fixed calendar position;
  // position is based on completed workouts, same as before this existed.
  startDate?: string | null;
  status?: 'draft' | 'active' | 'archived';
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Workout logs (actual training data, recorded per client per session) ----------
export interface SetLog {
  values: { [attrType: string]: string }; // e.g. { Reps: '8', Load: '135' }
  done?: boolean;
}

export interface LoggedExercise {
  exerciseName: string;
  prescription: string;   // human-readable summary captured at logging time
  attrColumns: string[];  // attribute types tracked per set (order = column order)
  sets: SetLog[];
  notes?: string;
}

export interface WorkoutLog {
  id?: string;
  programId: string | null;
  programName?: string;
  dayIndex: number | null; // index into program.schedule
  dayName?: string;
  clientId: string | null;
  clientName: string;
  date: string;            // local YYYY-MM-DD
  exercises: LoggedExercise[];
  sessionNotes?: string;
  // false while a live session is mid-workout (so it resumes instead of
  // duplicating); true once the coach taps Finish (so the next session advances
  // to the following day). Absent on logs recorded via the manual Workout Log.
  completed?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Omni Method fitness assessments (ported from the OMPAR tool) ----------
// Raw benchmark inputs for one assessment. Strength fields store BOTH the entered
// weight/reps AND the derived Brzycki 1RM (the key without a suffix) so historical
// category math stays stable even if the 1RM formula changes later.
export interface AssessmentInputs {
  bodyWeight: number;
  height: number;
  deadlift: number;        // estimated 1RM (lbs)
  deadliftWeight: number;
  deadliftReps: number;
  squat: number;           // estimated 1RM
  squatWeight: number;
  squatReps: number;
  bench: number;           // estimated 1RM
  benchWeight: number;
  benchReps: number;
  pullup1rm: number;       // estimated 1RM (bodyweight + added)
  pullup1rmWeight: number; // added lbs
  pullup1rmReps: number;
  longjump: number;
  sprint: number;
  pushups: number;
  pullups: number;
  run30: number;
  speed2: number;
  pike: number;
  backbend: number;
  straddle: number;
}

export type OmniRank = 'UNRANKED' | 'D-RANK' | 'C-RANK' | 'B-RANK' | 'A-RANK' | 'S-RANK';

// Which rank threshold table an athlete is scored against. Absent means
// male — see getOmniRank for why there is no back-fill migration.
export type Sex = 'male' | 'female';

// A client-submitted assessment from Project-000's "New Assessment" form,
// waiting in its own `pendingAssessments` collection for a coach to review
// here before it becomes a real FitnessAssessment and affects the client's
// level/rank. Every self-submitted score change goes through this queue —
// mobile no longer writes to `assessments` directly. Kept separate from
// `assessments` rather than a status flag on it, so saveAssessment()'s
// per-day upsert/diff baseline never has to filter pending docs out.
export interface PendingAssessment {
  id?: string;
  nameKey: string;
  clientName: string;
  timestamp: string;
  dateLabel: string;
  inputs: AssessmentInputs;
  lvl: number;
  rank: OmniRank;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
  reviewedAt?: string;
  videoUrl?: string | null;
}

// A Project-000 account's request to link itself to an athlete profile —
// doc id is the requesting account's uid (one pending/most-recent request
// per account; resubmitting after a rejection overwrites the old request
// rather than piling up). Sits pending until approved/rejected here; only
// approving writes clientLinks/{uid}, which is what actually grants that
// account access to the named athlete's data in Project-000. Previously
// Project-000 let an account self-link to any name on the roster with zero
// verification — this queue is the fix.
export interface LinkRequest {
  id?: string; // == uid
  uid: string;
  requestedName: string;
  nameKey: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
}

// One Omni Method assessment for a client, keyed by client + timestamp.
export interface FitnessAssessment {
  id?: string;
  clientId: string | null;     // clientProfiles doc id when matched (null otherwise)
  clientName: string;
  nameKey: string;             // normalized name for joins
  timestamp: string;           // datetime-local string (assessment date & time) — unique per client
  dateLabel: string;           // pretty label for the history dropdown
  inputs: AssessmentInputs;
  lvl: number;
  rank: OmniRank;
  createdAt?: string;
  updatedAt?: string;
}

// ---------- Job Request Board period-key helpers ----------
// Mirrors the same logic in Project-000's firebase.service.ts (kept as
// plain, duplicated functions rather than a shared package since these are
// two separate apps/repos) — weekly caps and quantity resets both key off
// Monday 6am Eastern; monthly resets key off the 1st at 6am Eastern. DST-safe
// via Intl (reads Eastern wall-clock time directly instead of manual offset
// math).
function jobWeekKeyFor(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false, weekday: 'short'
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;
  const weekdayIndex: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = weekdayIndex[get('weekday')] ?? 0;
  const daysSinceMonday = (dow + 6) % 7;

  const monday = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  if (daysSinceMonday === 0 && hour < 6) {
    monday.setUTCDate(monday.getUTCDate() - 7);
  }

  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const d = String(monday.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function jobMonthKeyFor(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  let hour = Number(get('hour'));
  if (hour === 24) hour = 0;

  let y = year, m = month;
  if (day === 1 && hour < 6) {
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

function jobPeriodKeyFor(date: Date, cadence: 'weekly' | 'monthly'): string {
  return cadence === 'weekly' ? jobWeekKeyFor(date) : jobMonthKeyFor(date);
}

@Injectable({
  providedIn: 'root'
})
export class FirebaseService {
  private app;
  private db;

  // Fires whenever anything that shapes the training schedule is written —
  // packages, reschedule overrides, one-off sessions. CalendarSyncService
  // subscribes to this, so the device calendar re-syncs after every such
  // change no matter which page made it. Emitting from here (rather than
  // each call site remembering to kick off a sync) is what makes that
  // guarantee hold: several package writes used to slip through unsynced.
  private readonly scheduleDataChangedSubject = new Subject<void>();
  readonly scheduleDataChanged$ = this.scheduleDataChangedSubject.asObservable();

  private emitScheduleDataChanged(): void {
    this.scheduleDataChangedSubject.next();
  }

  constructor() {
    this.app = initializeApp(environment.firebase);
    this.db = getFirestore(this.app);
    
    console.log('Firebase initialized successfully', {
      projectId: environment.firebase.projectId
    });
  }

  // ---------- Client Profiles (CRM) ----------
  private profilesCollection() { return collection(this.db, 'clientProfiles'); }
  private packagesCollection() { return collection(this.db, 'packages'); }

  private normalizeNameKey(name: string): string {
    return (name || '').trim().toLowerCase();
  }

  async getClientProfileByName(name: string): Promise<ClientProfile | null> {
    const key = this.normalizeNameKey(name);
    const qProfile = query(this.profilesCollection(), where('nameKey', '==', key));
    const snap = await getDocs(qProfile);
    if (snap.empty) return null;
    const d = snap.docs[0];
    const data = d.data() as any;
    return {
      id: d.id,
      clientId: data['clientId'],
      nameKey: data['nameKey'],
      fullName: data['fullName'],
      email: data['email'],
      phone: data['phone'],
      birthdate: data['birthdate'],
      referralSource: data['referralSource'],
      onboardDate: data['onboardDate'],
      currentStatus: data['currentStatus'],
      linkedPackages: data['linkedPackages'],
      totalPackages: data['totalPackages'],
      totalRevenue: data['totalRevenue'],
      totalHours: data['totalHours'],
      createdAt: data['createdAt'],
      updatedAt: data['updatedAt']
    };
  }

  async upsertClientProfile(partial: Partial<ClientProfile> & { fullName: string }): Promise<string> {
    const now = new Date().toISOString();
    const nameKey = this.normalizeNameKey(partial.fullName);
    const existing = await this.getClientProfileByName(partial.fullName);
    if (existing?.id) {
      const ref = doc(this.db, 'clientProfiles', existing.id);
      await updateDoc(ref, {
        ...partial,
        nameKey,
        updatedAt: now
      } as any);
      return existing.id;
    }
    // Create new
    const clientId = partial.clientId || `CL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const docRef = await addDoc(this.profilesCollection(), {
      clientId,
      nameKey,
      fullName: partial.fullName,
      email: partial.email || '',
      phone: partial.phone || '',
      birthdate: partial.birthdate || '',
      referralSource: partial.referralSource || '',
      onboardDate: partial.onboardDate || now,
      currentStatus: partial.currentStatus || 'active',
      linkedPackages: partial.linkedPackages ?? 0,
      totalPackages: partial.totalPackages ?? 0,
      totalRevenue: partial.totalRevenue ?? 0,
      totalHours: partial.totalHours ?? 0,
      createdAt: now,
      updatedAt: now
    } as any);
    return docRef.id;
  }

  async listClientProfiles(): Promise<ClientProfile[]> {
    const snap = await getDocs(this.profilesCollection());
    return snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        clientId: data['clientId'],
        nameKey: data['nameKey'],
        fullName: data['fullName'],
        email: data['email'],
        phone: data['phone'],
        birthdate: data['birthdate'],
        referralSource: data['referralSource'],
        onboardDate: data['onboardDate'],
        currentStatus: data['currentStatus'],
        linkedPackages: data['linkedPackages'],
        totalPackages: data['totalPackages'],
        totalRevenue: data['totalRevenue'],
        createdAt: data['createdAt'],
        updatedAt: data['updatedAt']
      } as ClientProfile;
    });
  }

  // ---------- Packages ----------
  private generatePackageId(): string {
    return `PKG-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  async listPackages(): Promise<PackageRecord[]> {
    const snap = await getDocs(this.packagesCollection());
    const packages: PackageRecord[] = [];
    for (const d of snap.docs) {
      const pkg = { id: d.id, ...(d.data() as any) } as PackageRecord;
      if (!Array.isArray(pkg.daysOfWeek)) {
        pkg.daysOfWeek = pkg.daysOfWeek ? Object.values(pkg.daysOfWeek as any) : [];
      }
      // Legacy packageDuration was a string ('1 Month', '3 Months', 'Custom', ...);
      // normalize to a plain number of months (falls back to 1 for 'Custom').
      if (typeof pkg.packageDuration !== 'number') {
        const match = /^(\d+)/.exec(String(pkg.packageDuration || ''));
        pkg.packageDuration = match ? parseInt(match[1], 10) : 1;
      }
      // These are typed non-optional but come straight off a raw Firestore
      // cast above, so a doc written before the field existed (or by the
      // payments Worker, which only sets what it knows) yields undefined
      // and makes the type a lie. Anything downstream doing arithmetic on
      // them then produces NaN — which renders as a blank or "NaN" in the
      // table rather than failing loudly. Normalize once, here, so the
      // declared types are actually true everywhere else.
      if (typeof pkg.totalSessions !== 'number' || !isFinite(pkg.totalSessions)) {
        pkg.totalSessions = 0;
      }
      if (typeof pkg.sessionsPerWeek !== 'number' || !isFinite(pkg.sessionsPerWeek)) {
        pkg.sessionsPerWeek = Array.isArray(pkg.daysOfWeek) ? pkg.daysOfWeek.length : 0;
      }
      if (typeof pkg.cost !== 'number' || !isFinite(pkg.cost)) {
        pkg.cost = 0;
      }
      if (typeof pkg.sessionDurationMinutes !== 'number' || !isFinite(pkg.sessionDurationMinutes)) {
        pkg.sessionDurationMinutes = 60;
      }
      // Packages with training days are schedulable — treat legacy prospect rows as active.
      // This best-effort migration write must never be able to sink the whole
      // read: if it fails (permissions, offline, whatever), the in-memory
      // `pkg.status` is already corrected above, so the caller still gets a
      // usable list — it just tries the persist again next load.
      if (pkg.status === 'prospect' && pkg.daysOfWeek.length > 0) {
        pkg.status = 'active';
        try {
          await updateDoc(doc(this.db, 'packages', d.id), {
            status: 'active',
            updatedAt: new Date().toISOString()
          });
        } catch (err) {
          console.error(`listPackages: failed to persist legacy prospect->active migration for ${d.id}`, err);
        }
      }
      packages.push(pkg);
    }
    return packages;
  }

  async upsertPackage(pkg: Partial<PackageRecord> & { packageName: string }): Promise<string> {
    const now = new Date().toISOString();
    if (pkg.id) {
      const ref = doc(this.db, 'packages', pkg.id);
      // Firestore's updateDoc rejects the ENTIRE write if any field is undefined
      // (e.g. an optional field that was never set) — drop those keys rather than
      // let one silently-failed field kill every other change (like status).
      const clean: Record<string, unknown> = { updatedAt: now };
      for (const [key, value] of Object.entries(pkg)) {
        if (value !== undefined) clean[key] = value;
      }
      await updateDoc(ref, clean as any);
      this.emitScheduleDataChanged();
      return pkg.id;
    }
    const packageId = pkg.packageId || this.generatePackageId();
    const docRef = await addDoc(this.packagesCollection(), {
      packageId,
      packageName: pkg.packageName,
      linkedClientIds: pkg.linkedClientIds || [],
      linkedClientNames: pkg.linkedClientNames || [],
      sessionType: pkg.sessionType || 'Private',
      sessionDurationMinutes: pkg.sessionDurationMinutes ?? 60,
      sessionsPerWeek: pkg.sessionsPerWeek ?? 1,
      packageDuration: pkg.packageDuration ?? 1,
      totalSessions: pkg.totalSessions ?? 0,
      sessionsRemaining: pkg.sessionsRemaining ?? pkg.totalSessions ?? 0,
      daysOfWeek: pkg.daysOfWeek || [],
      dayTimes: pkg.dayTimes || {},
      perSessionPack: pkg.perSessionPack ?? false,
      cost: pkg.cost ?? 0,
      clientPayments: pkg.clientPayments || {},
      trainerId: pkg.trainerId || '',
      purchaseDate: pkg.purchaseDate || '',
      expirationDate: pkg.expirationDate || '',
      status: pkg.status || 'active',
      createdAt: now,
      updatedAt: now
    } as any);
    this.emitScheduleDataChanged();
    return docRef.id;
  }

  async deletePackage(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'packages', id));
    this.emitScheduleDataChanged();
  }

  // ---------- Job Request Board ----------
  private jobPostingsCollection() { return collection(this.db, 'jobPostings'); }
  private jobAcceptancesCollection() { return collection(this.db, 'jobAcceptances'); }

  private generateJobId(): string {
    return `JOB-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  }

  async listJobPostings(): Promise<JobPosting[]> {
    const snap = await getDocs(this.jobPostingsCollection());
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as JobPosting));
  }

  // Create (no id) or update (id present) — same clean-write pattern as
  // upsertPackage. quantityAvailable is whatever the caller passes; the Jobs
  // page is responsible for shifting it by the right delta when quantityTotal
  // changes on an existing posting (already-accepted spots must stay claimed).
  async upsertJobPosting(job: Partial<JobPosting> & { title: string }): Promise<string> {
    const now = new Date().toISOString();
    if (job.id) {
      const clean: Record<string, unknown> = { updatedAt: now };
      for (const [key, value] of Object.entries(job)) {
        if (value !== undefined) clean[key] = value;
      }
      await updateDoc(doc(this.db, 'jobPostings', job.id), clean as any);
      return job.id;
    }
    const jobId = job.jobId || this.generateJobId();
    const quantityTotal = job.quantityTotal ?? 0;
    const docRef = await addDoc(this.jobPostingsCollection(), {
      jobId,
      title: job.title,
      description: job.description || '',
      hours: job.hours ?? 0,
      quantityTotal,
      quantityAvailable: job.quantityAvailable ?? quantityTotal,
      maxPerClient: job.maxPerClient ?? null,
      quantityResetCadence: job.quantityResetCadence ?? null,
      quantityPeriodKey: job.quantityPeriodKey ?? null,
      status: job.status || 'active',
      createdAt: now,
      updatedAt: now
    } as any);
    return docRef.id;
  }

  async deleteJobPosting(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'jobPostings', id));
  }

  // The period key for "right now" (or an arbitrary date) under a given
  // cadence — the Jobs page uses this when saving so a new/edited posting's
  // quantityPeriodKey always matches the period its quantityAvailable value
  // is actually for.
  computeQuantityPeriodKey(cadence: 'weekly' | 'monthly' | null, date: Date = new Date()): string | null {
    return cadence ? jobPeriodKeyFor(date, cadence) : null;
  }

  // What a job's pool actually shows as available right now — a job's
  // quantityAvailable field can be stale until Project-000's next accept/
  // undo lazily rolls it into a new week/month, so this page reads through
  // it instead of the raw field when displaying or computing edit deltas.
  effectiveQuantityAvailable(job: JobPosting): number {
    if (!job.quantityResetCadence) return job.quantityAvailable ?? 0;
    const currentPeriodKey = jobPeriodKeyFor(new Date(), job.quantityResetCadence);
    return job.quantityPeriodKey === currentPeriodKey ? (job.quantityAvailable ?? 0) : (job.quantityTotal ?? 0);
  }

  // All acceptances across every posting — the Jobs page groups these
  // client-side per job so the coach can see who to credit hours to, without
  // one query per posting.
  async listJobAcceptances(): Promise<JobAcceptance[]> {
    const snap = await getDocs(this.jobAcceptancesCollection());
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) } as JobAcceptance));
  }

  // Update by doc id — safe when the client's name itself is being edited.
  async updateClientProfile(id: string, partial: Partial<ClientProfile>): Promise<void> {
    const ref = doc(this.db, 'clientProfiles', id);
    const data: any = { ...partial, updatedAt: new Date().toISOString() };
    delete data.id;
    if (partial.fullName) {
      data.nameKey = this.normalizeNameKey(partial.fullName);
    }
    await updateDoc(ref, data);
  }

  async deleteClientProfile(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'clientProfiles', id));
  }

  async deleteClientProfileByName(fullName: string): Promise<void> {
    const key = this.normalizeNameKey(fullName);
    const qProfile = query(this.profilesCollection(), where('nameKey', '==', key));
    const snap = await getDocs(qProfile);
    const deletions: Promise<void>[] = [];
    snap.forEach(d => deletions.push(deleteDoc(d.ref)));
    await Promise.all(deletions);
  }

  // ---------- Check-ins (kiosk attendance) ----------
  private checkInsCollection() { return collection(this.db, 'checkins'); }

  private mapCheckIn(id: string, data: any): CheckIn {
    return {
      id,
      clientId: data['clientId'] ?? null,
      clientName: data['clientName'],
      date: data['date'],
      checkInTime: data['checkInTime'],
      packageId: data['packageId'] ?? null,
      packageName: data['packageName'],
      sessionType: data['sessionType'],
      decremented: !!data['decremented'],
      status: data['status'] ?? 'present',
      sessionsRemainingAfter: data['sessionsRemainingAfter'] ?? null,
      packageTotalSessions: data['packageTotalSessions'] ?? null,
      createdAt: data['createdAt']
    };
  }

  // A package consumes ONE session per distinct occurrence date that had
  // attendance — regardless of how many clients attended (shared/semi packages
  // count a session once, not once per person).
  private async usedOccurrenceCount(packageId: string): Promise<number> {
    const snap = await getDocs(query(
      this.checkInsCollection(),
      where('packageId', '==', packageId),
      where('decremented', '==', true)
    ));
    const dates = new Set<string>();
    snap.forEach(d => dates.add(d.data()['date']));
    return dates.size;
  }

  // Derive and persist sessionsRemaining from occurrence usage. Idempotent —
  // the single source of truth, so no path can double-count. Returns new value.
  async recomputePackageSessions(packageId: string): Promise<number | null> {
    const ref = doc(this.db, 'packages', packageId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const total = snap.data()['totalSessions'] ?? 0;
    const remaining = Math.max(0, total - await this.usedOccurrenceCount(packageId));
    await updateDoc(ref, { sessionsRemaining: remaining, updatedAt: new Date().toISOString() });
    return remaining;
  }

  // Records the visit, then reconciles the package's remaining sessions.
  async checkInClient(client: { id?: string | null; fullName: string }, pkg: PackageRecord | null): Promise<CheckIn> {
    const now = new Date();
    const record: Omit<CheckIn, 'id'> = {
      clientId: client.id ?? null,
      clientName: client.fullName,
      date: localDateString(now),
      checkInTime: now.toISOString(),
      packageId: pkg?.id ?? null,
      packageName: pkg?.packageName ?? '',
      sessionType: pkg?.sessionType ?? '',
      decremented: !!pkg?.id,
      status: 'present',
      sessionsRemainingAfter: null,
      packageTotalSessions: pkg?.totalSessions ?? null,
      createdAt: now.toISOString()
    };
    const docRef = await addDoc(this.checkInsCollection(), record as any);
    if (pkg?.id) {
      const remaining = await this.recomputePackageSessions(pkg.id);
      record.sessionsRemainingAfter = remaining;
      pkg.sessionsRemaining = remaining ?? pkg.sessionsRemaining;
      await updateDoc(doc(this.db, 'checkins', docRef.id), { sessionsRemainingAfter: remaining });
    }
    return { id: docRef.id, ...record };
  }

  // Removes the visit and reconciles the package (restores a session only if the
  // occurrence no longer has any remaining attendance). Returns the recomputed
  // sessionsRemaining so callers can patch their in-memory package without a
  // full refetch.
  async undoCheckIn(checkIn: CheckIn): Promise<number | null> {
    if (checkIn.id) {
      await deleteDoc(doc(this.db, 'checkins', checkIn.id));
    }
    if (checkIn.packageId) {
      return this.recomputePackageSessions(checkIn.packageId);
    }
    return null;
  }

  // Sets a client's attendance for a specific session date (may be in the past).
  // Creates or updates a single check-in record and reconciles the package's
  // sessionsRemaining: present & unexcused deduct a session, excused does not.
  async setAttendance(opts: {
    existing?: CheckIn | null;
    client: { id?: string | null; fullName: string };
    pkg: PackageRecord | null;
    date: string;                 // session date, YYYY-MM-DD
    status: AttendanceStatus;
  }): Promise<CheckIn> {
    const { existing, client, pkg, date, status } = opts;
    const now = new Date();

    const record: Omit<CheckIn, 'id'> = {
      clientId: client.id ?? null,
      clientName: client.fullName,
      date,
      checkInTime: existing?.checkInTime ?? now.toISOString(),
      packageId: pkg?.id ?? null,
      packageName: pkg?.packageName ?? '',
      sessionType: pkg?.sessionType ?? '',
      decremented: status !== 'excused',   // present & no-show occupy the occurrence
      status,
      sessionsRemainingAfter: existing?.sessionsRemainingAfter ?? null,
      packageTotalSessions: pkg?.totalSessions ?? null,
      createdAt: existing?.createdAt ?? now.toISOString()
    };

    const id = existing?.id ?? (await addDoc(this.checkInsCollection(), record as any)).id;
    if (existing?.id) {
      await updateDoc(doc(this.db, 'checkins', existing.id), record as any);
    }

    // Reconcile the package from distinct occurrences (counts a session once per
    // date even if multiple clients are marked).
    if (pkg?.id) {
      const remaining = await this.recomputePackageSessions(pkg.id);
      record.sessionsRemainingAfter = remaining;
      pkg.sessionsRemaining = remaining ?? pkg.sessionsRemaining;
      await updateDoc(doc(this.db, 'checkins', id), { sessionsRemainingAfter: remaining });
    }
    return { id, ...record };
  }

  async getCheckInsForDate(date: string): Promise<CheckIn[]> {
    const snap = await getDocs(query(this.checkInsCollection(), where('date', '==', date)));
    const result = snap.docs.map(d => this.mapCheckIn(d.id, d.data()));
    return result.sort((a, b) => b.checkInTime.localeCompare(a.checkInTime));
  }

  // ---------- Session reschedule overrides ----------
  private overridesCollection() { return collection(this.db, 'sessionOverrides'); }

  private mapOverride(id: string, data: any): SessionOverride {
    return {
      id,
      packageId: data['packageId'],
      originalDate: data['originalDate'],
      newDate: data['newDate'],
      newTime: data['newTime'] ?? '',
      createdAt: data['createdAt']
    };
  }

  // All overrides (facility-scale: a handful of records). Caller filters by range.
  async listSessionOverrides(): Promise<SessionOverride[]> {
    const snap = await getDocs(this.overridesCollection());
    return snap.docs.map(d => this.mapOverride(d.id, d.data()));
  }

  // Create or update the override for a specific recurring occurrence.
  async setSessionOverride(o: SessionOverride): Promise<SessionOverride> {
    const payload = {
      packageId: o.packageId,
      originalDate: o.originalDate,
      newDate: o.newDate,
      newTime: o.newTime ?? '',
      createdAt: o.createdAt ?? new Date().toISOString()
    };
    if (o.id) {
      await updateDoc(doc(this.db, 'sessionOverrides', o.id), payload as any);
      this.emitScheduleDataChanged();
      return { id: o.id, ...payload };
    }
    const docRef = await addDoc(this.overridesCollection(), payload as any);
    this.emitScheduleDataChanged();
    return { id: docRef.id, ...payload };
  }

  // Remove an override, restoring the session to its original recurring slot.
  async deleteSessionOverride(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'sessionOverrides', id));
    this.emitScheduleDataChanged();
  }

  private singleSessionsCollection() { return collection(this.db, 'singleSessions'); }

  private mapSingleSession(id: string, data: any): SingleSession {
    return {
      id,
      date: data['date'],
      time: data['time'] ?? '',
      durationMinutes: data['durationMinutes'] ?? 60,
      sessionType: data['sessionType'] ?? 'Private',
      title: data['title'] ?? '',
      clientIds: data['clientIds'] ?? [],
      clientNames: data['clientNames'] ?? [],
      notes: data['notes'] ?? '',
      trainerId: data['trainerId'] ?? '',
      createdAt: data['createdAt'],
      updatedAt: data['updatedAt']
    };
  }

  // All one-off sessions (facility-scale: caller filters by range same as overrides).
  async listSingleSessions(): Promise<SingleSession[]> {
    const snap = await getDocs(this.singleSessionsCollection());
    return snap.docs.map(d => this.mapSingleSession(d.id, d.data()));
  }

  async saveSingleSession(session: SingleSession): Promise<string> {
    const now = new Date().toISOString();
    const payload = {
      date: session.date,
      time: session.time || '',
      durationMinutes: session.durationMinutes,
      sessionType: session.sessionType,
      title: session.title,
      clientIds: session.clientIds,
      clientNames: session.clientNames,
      notes: session.notes || '',
      trainerId: session.trainerId || '',
      createdAt: session.createdAt ?? now,
      updatedAt: now
    };
    if (session.id) {
      await updateDoc(doc(this.db, 'singleSessions', session.id), payload as any);
      this.emitScheduleDataChanged();
      return session.id;
    }
    const ref = await addDoc(this.singleSessionsCollection(), payload as any);
    this.emitScheduleDataChanged();
    return ref.id;
  }

  async deleteSingleSession(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'singleSessions', id));
    this.emitScheduleDataChanged();
  }

  // ---------- Swap requests (athlete self-service reschedule) ----------
  private swapRequestsCollection() { return collection(this.db, 'swapRequests'); }

  private mapSwapRequest(id: string, data: any): SwapRequest {
    return {
      id,
      kind: data['kind'] === 'openGym' ? 'openGym' : 'swap',
      clientId: data['clientId'] ?? '',
      clientName: data['clientName'] ?? '',
      packageId: data['packageId'] ?? '',
      isSingle: !!data['isSingle'],
      singleSessionId: data['singleSessionId'] ?? undefined,
      originalDateKey: data['originalDateKey'] ?? '',
      originalTime: data['originalTime'] ?? '',
      requestedDateKey: data['requestedDateKey'] ?? '',
      requestedTime: data['requestedTime'] ?? '',
      sessionType: data['sessionType'] ?? '',
      durationMinutes: data['durationMinutes'] ?? 60,
      status: data['status'] ?? 'pending',
      note: data['note'] ?? '',
      createdAt: data['createdAt'],
      respondedAt: data['respondedAt'] ?? undefined
    };
  }

  // Facility-scale (a handful of live requests at once) — caller filters by status.
  async listSwapRequests(): Promise<SwapRequest[]> {
    const snap = await getDocs(this.swapRequestsCollection());
    return snap.docs.map(d => this.mapSwapRequest(d.id, d.data()))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }

  // Approve a swap: apply it exactly the way a coach's own manual
  // reschedule would (setSessionOverride for a package occurrence, or a
  // direct SingleSession date/time edit), then mark the request approved.
  // Deny just marks it denied — nothing about the session changes.
  async respondToSwapRequest(req: SwapRequest, approve: boolean): Promise<void> {
    if (!req.id) return;
    if (approve) {
      if (req.kind === 'openGym') {
        // Not moving anything — this creates a brand new one-off session,
        // same as a coach adding a single session by hand, just initiated
        // by the athlete.
        await this.saveSingleSession({
          date: req.requestedDateKey,
          time: req.requestedTime || '',
          durationMinutes: req.durationMinutes || 60,
          sessionType: 'Private',
          title: 'Open Gym',
          clientIds: req.clientId ? [req.clientId] : [],
          clientNames: [req.clientName]
        });
      } else if (req.isSingle && req.singleSessionId) {
        await updateDoc(doc(this.db, 'singleSessions', req.singleSessionId), {
          date: req.requestedDateKey,
          time: req.requestedTime || '',
          updatedAt: new Date().toISOString()
        } as any);
      } else if (req.packageId) {
        await this.setSessionOverride({
          packageId: req.packageId,
          originalDate: req.originalDateKey,
          newDate: req.requestedDateKey,
          newTime: req.requestedTime || ''
        });
      }
    }
    await updateDoc(doc(this.db, 'swapRequests', req.id), {
      status: approve ? 'approved' : 'denied',
      respondedAt: new Date().toISOString()
    } as any);
    this.emitScheduleDataChanged();
  }

  // Up to 10 dates per Firestore 'in' query; chunked to stay safe.
  async getCheckInsForDates(dates: string[]): Promise<CheckIn[]> {
    const result: CheckIn[] = [];
    for (let i = 0; i < dates.length; i += 10) {
      const chunk = dates.slice(i, i + 10);
      const snap = await getDocs(query(this.checkInsCollection(), where('date', 'in', chunk)));
      snap.forEach(d => result.push(this.mapCheckIn(d.id, d.data())));
    }
    return result.sort((a, b) => b.checkInTime.localeCompare(a.checkInTime));
  }

  // Sessions used = distinct occurrence dates with attendance (shared packages
  // count a session once per date, not once per client).
  async getDecrementedSessionCount(packageId: string): Promise<number> {
    return this.usedOccurrenceCount(packageId);
  }

  async getDecrementedCountsByPackage(): Promise<Map<string, number>> {
    const snap = await getDocs(query(this.checkInsCollection(), where('decremented', '==', true)));
    const datesByPackage = new Map<string, Set<string>>();
    snap.forEach(d => {
      const packageId = d.data()['packageId'] as string | undefined;
      if (!packageId) return;
      const date = d.data()['date'] as string;
      if (!datesByPackage.has(packageId)) datesByPackage.set(packageId, new Set());
      datesByPackage.get(packageId)!.add(date);
    });
    const counts = new Map<string, number>();
    datesByPackage.forEach((dates, packageId) => counts.set(packageId, dates.size));
    return counts;
  }

  // An excused occurrence doesn't deduct a session, but it did occupy a
  // calendar slot — the package's final-session projection needs to know
  // how many of these have happened so it can extend the recurring pattern
  // by that many extra occurrences (otherwise the last real session gets
  // cut off the calendar even though sessionsRemaining says it's owed).
  // Same distinct-date-per-package shape as getDecrementedCountsByPackage.
  async getExcusedCountsByPackage(): Promise<Map<string, number>> {
    const snap = await getDocs(query(this.checkInsCollection(), where('status', '==', 'excused')));
    const datesByPackage = new Map<string, Set<string>>();
    snap.forEach(d => {
      const packageId = d.data()['packageId'] as string | undefined;
      if (!packageId) return;
      const date = d.data()['date'] as string;
      if (!datesByPackage.has(packageId)) datesByPackage.set(packageId, new Set());
      datesByPackage.get(packageId)!.add(date);
    });
    const counts = new Map<string, number>();
    datesByPackage.forEach((dates, packageId) => counts.set(packageId, dates.size));
    return counts;
  }

  async getExcusedSessionCount(packageId: string): Promise<number> {
    const snap = await getDocs(query(
      this.checkInsCollection(),
      where('packageId', '==', packageId),
      where('status', '==', 'excused')
    ));
    const dates = new Set<string>();
    snap.forEach(d => dates.add(d.data()['date']));
    return dates.size;
  }

  // Newest first. Sorted client-side per query field to avoid composite indexes.
  async getRecentCheckIns(max = 500): Promise<CheckIn[]> {
    const snap = await getDocs(query(this.checkInsCollection(), orderBy('checkInTime', 'desc'), limit(max)));
    return snap.docs.map(d => this.mapCheckIn(d.id, d.data()));
  }

  async getCheckInsForClient(opts: { clientId?: string | null; clientName?: string }): Promise<CheckIn[]> {
    const byId = new Map<string, CheckIn>();
    if (opts.clientId) {
      const snap = await getDocs(query(this.checkInsCollection(), where('clientId', '==', opts.clientId)));
      snap.forEach(d => byId.set(d.id, this.mapCheckIn(d.id, d.data())));
    }
    if (opts.clientName) {
      const snap = await getDocs(query(this.checkInsCollection(), where('clientName', '==', opts.clientName)));
      snap.forEach(d => byId.set(d.id, this.mapCheckIn(d.id, d.data())));
    }
    return Array.from(byId.values()).sort((a, b) => b.checkInTime.localeCompare(a.checkInTime));
  }

  // Manual correction from the clients page (comp a session, fix a mistake).
  async adjustPackageSessions(packageId: string, delta: number): Promise<number> {
    const pkgRef = doc(this.db, 'packages', packageId);
    const snap = await getDoc(pkgRef);
    if (!snap.exists()) throw new Error('Package not found');
    const data = snap.data() as any;
    const next = Math.max(0, (data['sessionsRemaining'] ?? 0) + delta);
    await updateDoc(pkgRef, { sessionsRemaining: next, updatedAt: new Date().toISOString() });
    return next;
  }

  // Payments by client without orderBy (no composite index needed); sorted client-side.
  async getPaymentsForClient(studentName: string): Promise<PaymentRecord[]> {
    const snap = await getDocs(query(collection(this.db, 'payments'), where('studentName', '==', studentName)));
    const payments = snap.docs.map(d => ({ id: d.id, ...(d.data() as any) })) as PaymentRecord[];
    return payments.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  // Save a new session
  async saveSession(session: Omit<Session, 'id'>): Promise<string> {
    try {
      const sessionData = {
        ...session,
        date: session.date.toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      const docRef = await addDoc(collection(this.db, 'sessions'), sessionData);
      console.log('Session saved with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving session: ', error);
      throw error;
    }
  }

  // Get all sessions
  async getSessions(): Promise<Session[]> {
    try {
      const q = query(collection(this.db, 'sessions'), orderBy('date'));
      const querySnapshot = await getDocs(q);
      
      const sessions: Session[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        sessions.push({
          id: doc.id,
          name: data['name'],
          participants: data['participants'],
          date: new Date(data['date']),
          workoutId: data['workoutId'],
          createdAt: data['createdAt'] ? new Date(data['createdAt']) : undefined,
          updatedAt: data['updatedAt'] ? new Date(data['updatedAt']) : undefined
        });
      });
      
      return sessions;
    } catch (error) {
      console.error('Error getting sessions: ', error);
      throw error;
    }
  }

  // Get sessions within a date range (inclusive)
  async getSessionsInRange(start: Date, end: Date): Promise<Session[]> {
    try {
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const qSessions = query(
        collection(this.db, 'sessions'),
        where('date', '>=', startIso),
        where('date', '<=', endIso),
        orderBy('date')
      );
      const snapshot = await getDocs(qSessions);
      const sessions: Session[] = [];
      snapshot.forEach((d) => {
        const data = d.data();
        sessions.push({
          id: d.id,
          name: data['name'],
          participants: data['participants'],
          date: new Date(data['date']),
          workoutId: data['workoutId'],
          createdAt: data['createdAt'] ? new Date(data['createdAt']) : undefined,
          updatedAt: data['updatedAt'] ? new Date(data['updatedAt']) : undefined
        });
      });
      return sessions;
    } catch (error) {
      console.error('Error getting sessions in range: ', error);
      throw error;
    }
  }

  // Update a session
  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    try {
      const sessionRef = doc(this.db, 'sessions', id);
      const updateData: any = {
        updatedAt: new Date().toISOString()
      };
      
      // Only include defined values in the update
      Object.keys(updates).forEach(key => {
        const value = (updates as any)[key];
        if (value !== undefined) {
          if (key === 'date' && value instanceof Date) {
            updateData[key] = value.toISOString();
          } else {
            updateData[key] = value;
          }
        }
      });
      
      // Special case: if we're updating a session but workoutId is not included,
      // and we want to remove it, we need to handle this explicitly
      // This will be handled by the calling code using a special flag or by omitting workoutId completely
      
      await updateDoc(sessionRef, updateData);
      console.log('Session updated successfully');
    } catch (error) {
      console.error('Error updating session: ', error);
      throw error;
    }
  }

  // New method specifically for unlinking workouts from sessions
  async unlinkWorkoutFromSession(sessionId: string): Promise<void> {
    try {
      const sessionRef = doc(this.db, 'sessions', sessionId);
      const updateData = {
        workoutId: deleteField(),
        updatedAt: new Date().toISOString()
      };
      
      await updateDoc(sessionRef, updateData);
      console.log('Workout unlinked from session successfully');
    } catch (error) {
      console.error('Error unlinking workout from session: ', error);
      throw error;
    }
  }

  // Delete a session
  async deleteSession(id: string): Promise<void> {
    try {
      await deleteDoc(doc(this.db, 'sessions', id));
      console.log('Session deleted successfully');
    } catch (error) {
      console.error('Error deleting session: ', error);
      throw error;
    }
  }

  // Save waiver data directly to Firestore
  async saveWaiver(waiver: WaiverData): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'waivers'), waiver);
      console.log('Waiver saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving waiver: ', error);
      throw error;
    }
  }

  // Get all waivers for a specific student
  async getStudentWaivers(studentName: string): Promise<WaiverData[]> {
    try {
      const waivers: WaiverData[] = [];
      const querySnapshot = await getDocs(collection(this.db, 'waivers'));
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        if (data['studentName'].toLowerCase() === studentName.toLowerCase()) {
          waivers.push({
            id: doc.id,
            waiverType: data['waiverType'],
            studentName: data['studentName'],
            signedDate: data['signedDate'],
            signatureDataUrl: data['signatureDataUrl'],
            clientId: data['clientId'] ?? null,
            fullName: data['fullName'],
            phone: data['phone'],
            email: data['email'],
            childName: data['childName'],
            guardianName: data['guardianName'],
            guardianPhone: data['guardianPhone'],
            guardianEmail: data['guardianEmail'],
            createdAt: data['createdAt']
          });
        }
      });
      
      return waivers.sort((a, b) => new Date(b.signedDate).getTime() - new Date(a.signedDate).getTime());
    } catch (error) {
      console.error('Error getting student waivers: ', error);
      throw error;
    }
  }

  // Get all waivers (for admin view)
  async getAllWaivers(): Promise<WaiverData[]> {
    try {
      const waivers: WaiverData[] = [];
      const querySnapshot = await getDocs(query(collection(this.db, 'waivers'), orderBy('signedDate', 'desc')));
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        waivers.push({
          id: doc.id,
          waiverType: data['waiverType'],
          studentName: data['studentName'],
          signedDate: data['signedDate'],
          signatureDataUrl: data['signatureDataUrl'],
          fullName: data['fullName'],
          phone: data['phone'],
          email: data['email'],
          childName: data['childName'],
          guardianName: data['guardianName'],
          guardianPhone: data['guardianPhone'],
          guardianEmail: data['guardianEmail'],
          createdAt: data['createdAt']
        });
      });
      
      return waivers;
    } catch (error) {
      console.error('Error getting all waivers: ', error);
      throw error;
    }
  }

  // Save feedback
  async saveFeedback(feedback: FeedbackData): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'feedback'), feedback);
      console.log('Feedback saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving feedback: ', error);
      throw error;
    }
  }

  // Get all feedback, newest first
  async getFeedback(): Promise<FeedbackData[]> {
    try {
      const q = query(collection(this.db, 'feedback'), orderBy('submittedDate', 'desc'));
      const querySnapshot = await getDocs(q);
      return querySnapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...(docSnap.data() as Omit<FeedbackData, 'id'>),
      }));
    } catch (error) {
      console.error('Error getting feedback: ', error);
      throw error;
    }
  }

  // Delete a feedback entry
  async deleteFeedback(id: string): Promise<void> {
    try {
      await deleteDoc(doc(this.db, 'feedback', id));
    } catch (error) {
      console.error('Error deleting feedback: ', error);
      throw error;
    }
  }

  // Save attendance record
  async saveAttendance(attendance: AttendanceRecord): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'attendance'), attendance);
      console.log('Attendance saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving attendance: ', error);
      throw error;
    }
  }

  // Delete attendance record
  async deleteAttendance(sessionId: string, studentName: string): Promise<void> {
    try {
      // Find the attendance record to delete
      const q = query(
        collection(this.db, 'attendance'),
        where('sessionId', '==', sessionId),
        where('studentName', '==', studentName),
        where('present', '==', true)
      );
      const querySnapshot = await getDocs(q);
      
      // Delete all matching records (there should only be one, but just in case)
      const deletePromises = querySnapshot.docs.map(doc => deleteDoc(doc.ref));
      await Promise.all(deletePromises);
      
      console.log('Attendance deleted successfully');
    } catch (error) {
      console.error('Error deleting attendance: ', error);
      throw error;
    }
  }

  // Get attendance for a specific session
  async getSessionAttendance(sessionId: string): Promise<AttendanceRecord[]> {
    try {
      const attendance: AttendanceRecord[] = [];
      const q = query(collection(this.db, 'attendance'), where('sessionId', '==', sessionId));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        attendance.push({
          sessionId: data['sessionId'],
          studentName: data['studentName'],
          checkInTime: data['checkInTime'],
          date: data['date'],
          present: data['present']
        });
      });
      
      return attendance;
    } catch (error) {
      console.error('Error getting session attendance: ', error);
      throw error;
    }
  }

  // Get student attendance across all sessions
  async getStudentAttendance(studentName: string): Promise<AttendanceRecord[]> {
    try {
      const attendance: AttendanceRecord[] = [];
      const q = query(collection(this.db, 'attendance'), where('studentName', '==', studentName));
      const querySnapshot = await getDocs(q);
      
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        attendance.push({
          sessionId: data['sessionId'],
          studentName: data['studentName'],
          checkInTime: data['checkInTime'],
          date: data['date'],
          present: data['present']
        });
      });
      
      return attendance.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } catch (error) {
      console.error('Error getting student attendance: ', error);
      throw error;
    }
  }

  // Calculate student statistics including make-up sessions
  async getStudentStats(studentName: string): Promise<StudentStats> {
    try {
      // Get all sessions where student is a participant
      const sessions = await this.getSessions();
      const studentSessions = sessions.filter(session => 
        session.participants.some(participant => participant.toLowerCase() === studentName.toLowerCase())
      );

      // Only count sessions that have already occurred (past sessions)
      const now = new Date();
      const pastSessions = studentSessions.filter(session => {
        const sessionDate = new Date(session.date);
        return sessionDate < now;
      });

      // Get attendance records for this student
      const attendanceRecords = await this.getStudentAttendance(studentName);
      
      const totalSessions = pastSessions.length;
      const attendedSessions = attendanceRecords.filter(record => record.present).length;
      let missedSessions = totalSessions - attendedSessions;
      
      // Calculate make-up sessions remaining (1 make-up per missed session)
      let makeUpSessionsRemaining = Math.max(0, missedSessions);

      // Check if there's a manual override for make-up sessions
      const override = await this.getStudentStatsOverride(studentName);
      if (override && override.makeUpSessionsRemaining !== undefined) {
        makeUpSessionsRemaining = override.makeUpSessionsRemaining;
      }
      
      // Check if there's a manual override for missed sessions
      if (override && override.missedSessions !== undefined) {
        missedSessions = override.missedSessions;
      }

      return {
        studentName,
        totalSessions,
        attendedSessions,
        missedSessions,
        makeUpSessionsRemaining
      };
    } catch (error) {
      console.error('Error calculating student stats: ', error);
      throw error;
    }
  }

  // Check if student is already checked in for a session
  async isStudentCheckedIn(studentName: string, sessionId: string): Promise<boolean> {
    try {
      const q = query(
        collection(this.db, 'attendance'), 
        where('studentName', '==', studentName),
        where('sessionId', '==', sessionId),
        where('present', '==', true)
      );
      const querySnapshot = await getDocs(q);
      return !querySnapshot.empty;
    } catch (error) {
      console.error('Error checking student attendance: ', error);
      return false;
    }
  }

  // Save wellness data
  async saveWellnessData(wellnessData: WellnessData): Promise<string> {
    try {
      const docRef = await addDoc(collection(this.db, 'wellness'), wellnessData);
      console.log('Wellness data saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving wellness data: ', error);
      throw error;
    }
  }

  // Get wellness data for a student
  async getStudentWellnessData(studentName: string): Promise<WellnessData[]> {
    try {
      const q = query(
        collection(this.db, 'wellness'), 
        where('studentName', '==', studentName),
        orderBy('date', 'desc')
      );
      const querySnapshot = await getDocs(q);
      
      const wellnessData: WellnessData[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        wellnessData.push({
          id: doc.id,
          studentName: data['studentName'],
          sessionId: data['sessionId'],
          date: data['date'],
          checkInTime: data['checkInTime'],
          sleepQuality: data['sleepQuality'],
          energyLevel: data['energyLevel'],
          stressLevel: data['stressLevel'],
          ateHealthy: data['ateHealthy'],
          drankWater: data['drankWater']
        });
      });
      
      return wellnessData;
    } catch (error) {
      console.error('Error getting wellness data: ', error);
      throw error;
    }
  }

  // ---------- Training programs ----------
  private programsCollection() { return collection(this.db, 'programs'); }

  // Strips undefined values (Firestore rejects them) without losing structure.
  private cleanForFirestore<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
  }

  async listPrograms(): Promise<Program[]> {
    const snap = await getDocs(this.programsCollection());
    const programs = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<Program, 'id'>) }));
    return programs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  async getProgram(id: string): Promise<Program | null> {
    const snap = await getDoc(doc(this.db, 'programs', id));
    if (!snap.exists()) return null;
    return { id: snap.id, ...(snap.data() as Omit<Program, 'id'>) };
  }

  async saveProgram(program: Program): Promise<string> {
    const now = new Date().toISOString();
    const { id, ...data } = program;
    const payload = this.cleanForFirestore({
      ...data,
      createdAt: program.createdAt ?? now,
      updatedAt: now
    });
    if (id) {
      await setDoc(doc(this.db, 'programs', id), payload);
      return id;
    }
    const ref = await addDoc(this.programsCollection(), payload);
    return ref.id;
  }

  async deleteProgram(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'programs', id));
  }

  // ---------- Workout logs ----------
  private workoutLogsCollection() { return collection(this.db, 'workoutLogs'); }

  // One where-clause max to avoid composite indexes; sorted client-side, newest first.
  // ---------- Program progression (shared by workout-log and live-session) ----------
  // Schedule indices of the program's real training days (non-rest, has exercises), in order.
  programTrainingDays(p: Program): number[] {
    return (p.schedule || [])
      .map((day, index) => ({ day, index }))
      .filter(x => !x.day.isRestDay && x.day.exercises.length > 0)
      .map(x => x.index);
  }

  // Where a client sits in a program, derived from their logged history.
  // Returns the next training day they haven't done yet (null when complete).
  async clientProgramPosition(p: Program, clientId: string): Promise<{
    order: number[];
    nextDayIndex: number | null;
    lastDayIndex: number | null;
    lastDate: string | null;
    complete: boolean;
  }> {
    const order = this.programTrainingDays(p);
    const empty = { order, nextDayIndex: null, lastDayIndex: null, lastDate: null, complete: false };
    if (!order.length || !clientId || !p.id) return empty;

    const logs = await this.listWorkoutLogs({ clientId, programId: p.id });
    const last = logs.find(l => l.dayIndex !== null && order.includes(l.dayIndex!)); // logs are date-desc
    if (!last) return { ...empty, nextDayIndex: order[0] };

    const pos = order.indexOf(last.dayIndex!);
    const nextPos = pos + 1;
    const complete = nextPos >= order.length;
    return {
      order,
      nextDayIndex: complete ? null : order[nextPos],
      lastDayIndex: last.dayIndex!,
      lastDate: last.date,
      complete
    };
  }

  // Build blank logging entries (prescription + empty sets) for one program day.
  buildSessionExercises(p: Program, dayIndex: number): LoggedExercise[] {
    const day = p.schedule?.[dayIndex];
    if (!day) return [];
    return day.exercises.map(ex => {
      const attrMap = new Map(ex.attributes.map(a => [a.type, a] as const));
      const columns = ex.attributes.filter(a => a.type !== 'Sets').map(a => a.type);
      const setsAttr = attrMap.get('Sets');
      let setCount = 3;
      if (setsAttr) {
        if (setsAttr.strategy === 'Fixed') setCount = Math.max(1, parseInt(setsAttr.val, 10) || 3);
        else if (setsAttr.strategy === 'Range') setCount = Math.max(1, parseInt(setsAttr.val.split('-')[0], 10) || 3);
      }
      return {
        exerciseName: ex.name || 'Exercise',
        prescription: ex.attributes.map(a =>
          `${a.type}: ${a.strategy === 'User Input' ? '—' : a.strategy === 'Bodyweight' ? 'BW' : a.val || '—'}`
        ).join(' · '),
        attrColumns: columns,
        sets: Array.from({ length: setCount }, () => ({ values: {}, done: false }))
      };
    });
  }

  async listWorkoutLogs(opts: { programId?: string; clientId?: string; max?: number } = {}): Promise<WorkoutLog[]> {
    let q;
    if (opts.clientId) {
      q = query(this.workoutLogsCollection(), where('clientId', '==', opts.clientId));
    } else if (opts.programId) {
      q = query(this.workoutLogsCollection(), where('programId', '==', opts.programId));
    } else {
      q = query(this.workoutLogsCollection(), orderBy('date', 'desc'), limit(opts.max ?? 200));
    }
    const snap = await getDocs(q);
    let logs = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<WorkoutLog, 'id'>) }));
    if (opts.programId && opts.clientId) {
      logs = logs.filter(l => l.programId === opts.programId);
    }
    logs.sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
    return opts.max ? logs.slice(0, opts.max) : logs;
  }

  async saveWorkoutLog(log: WorkoutLog): Promise<string> {
    const now = new Date().toISOString();
    const { id, ...data } = log;
    const payload = this.cleanForFirestore({
      ...data,
      createdAt: log.createdAt ?? now,
      updatedAt: now
    });
    if (id) {
      await setDoc(doc(this.db, 'workoutLogs', id), payload);
      return id;
    }
    const ref = await addDoc(this.workoutLogsCollection(), payload);
    return ref.id;
  }

  async deleteWorkoutLog(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'workoutLogs', id));
  }

  // Save workout
  async saveWorkout(workout: Workout): Promise<string> {
    try {
      console.log('🔥 Firebase saveWorkout() called');
      console.log('📊 Input workout data:', JSON.stringify(workout, null, 2));
      
      const workoutData = {
        ...workout,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      console.log('📝 Final workout data to save:', JSON.stringify(workoutData, null, 2));
      console.log('🌐 Firebase database instance:', this.db ? 'Available' : 'Not available');
      
      const docRef = await addDoc(collection(this.db, 'workouts'), workoutData);
      console.log('✅ Workout saved successfully with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('💥 Firebase Error saving workout: ', error);
      const errorObj = error as any;
      console.error('📄 Firebase Error details:', {
        message: errorObj?.message || 'Unknown error',
        code: errorObj?.code || 'No error code',
        stack: errorObj?.stack || 'No stack trace',
        name: errorObj?.name || 'No error name'
      });
      throw error;
    }
  }

  // Get all workouts
  async getWorkouts(): Promise<Workout[]> {
    try {
      const q = query(collection(this.db, 'workouts'), orderBy('createdAt', 'desc'));
      const querySnapshot = await getDocs(q);
      
      const workouts: Workout[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        workouts.push({
          id: doc.id,
          name: data['name'],
          description: data['description'],
          // Typed non-optional, so several callers index straight into it
          // (session-workout-view does `workout?.sections[i]`, which throws
          // if sections is undefined rather than just returning undefined).
          // A workout doc saved without sections would crash the live
          // session view — default here so the declared type is true.
          sections: data['sections'] ?? [],
          totalDuration: data['totalDuration'],
          equipment: data['equipment'],
          tags: data['tags'],
          createdAt: data['createdAt'],
          updatedAt: data['updatedAt'],
          createdBy: data['createdBy']
        });
      });
      
      return workouts;
    } catch (error) {
      console.error('Error getting workouts: ', error);
      throw error;
    }
  }

  // Update workout
  async updateWorkout(id: string, updates: Partial<Workout>): Promise<void> {
    try {
      const workoutRef = doc(this.db, 'workouts', id);
      const updateData = {
        ...updates,
        updatedAt: new Date().toISOString()
      };
      
      await updateDoc(workoutRef, updateData);
      console.log('Workout updated successfully');
    } catch (error) {
      console.error('Error updating workout: ', error);
      throw error;
    }
  }

  // Delete workout
  async deleteWorkout(id: string): Promise<void> {
    try {
      await deleteDoc(doc(this.db, 'workouts', id));
      console.log('Workout deleted successfully');
    } catch (error) {
      console.error('Error deleting workout: ', error);
      throw error;
    }
  }

  // Update student stats (make-up sessions remaining and missed sessions)
  async updateStudentStats(studentName: string, updates: { makeUpSessionsRemaining?: number; missedSessions?: number }): Promise<void> {
    try {
      // Since student stats are calculated dynamically, we need to store the override
      // We'll create a separate collection for manual overrides
      const overrideRef = doc(this.db, 'studentStatsOverrides', studentName);
      
      const updateData: any = {
        studentName,
        updatedAt: new Date().toISOString()
      };
      
      if (updates.makeUpSessionsRemaining !== undefined) {
        updateData.makeUpSessionsRemaining = updates.makeUpSessionsRemaining;
      }
      
      if (updates.missedSessions !== undefined) {
        updateData.missedSessions = updates.missedSessions;
      }
      
      await setDoc(overrideRef, updateData, { merge: true });
      
      console.log(`Updated student stats for ${studentName}:`, updates);
    } catch (error) {
      console.error('Error updating student stats: ', error);
      throw error;
    }
  }

  // Get student stats override if it exists
  async getStudentStatsOverride(studentName: string): Promise<{ makeUpSessionsRemaining?: number; missedSessions?: number } | null> {
    try {
      const overrideRef = doc(this.db, 'studentStatsOverrides', studentName);
      const overrideDoc = await getDoc(overrideRef);
      
      if (overrideDoc.exists()) {
        const data = overrideDoc.data();
        return {
          makeUpSessionsRemaining: data['makeUpSessionsRemaining'],
          missedSessions: data['missedSessions']
        };
      }
      
      return null;
    } catch (error) {
      console.error('Error getting student stats override: ', error);
      return null;
    }
  }

  // Payment methods
  async savePayment(payment: PaymentRecord): Promise<string> {
    try {
      const paymentData = {
        ...payment,
        createdAt: new Date().toISOString()
      };
      
      const docRef = await addDoc(collection(this.db, 'payments'), paymentData);
      console.log('Payment saved with ID: ', docRef.id);
      return docRef.id;
    } catch (error) {
      console.error('Error saving payment: ', error);
      throw error;
    }
  }

  async getStudentPayments(studentName: string): Promise<PaymentRecord[]> {
    try {
      const q = query(
        collection(this.db, 'payments'), 
        where('studentName', '==', studentName),
        orderBy('date', 'desc')
      );
      const querySnapshot = await getDocs(q);
      
      const payments: PaymentRecord[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        payments.push({
          id: doc.id,
          studentName: data['studentName'],
          amount: data['amount'],
          date: data['date'],
          sessionType: data['sessionType'],
          numSessions: data['numSessions'],
          discountPercent: data['discountPercent'],
          paymentMethod: data['paymentMethod'],
          paymentStatus: data['paymentStatus'],
          notes: data['notes'],
          createdAt: data['createdAt']
        });
      });
      
      return payments;
    } catch (error) {
      console.error('Error getting student payments: ', error);
      throw error;
    }
  }

  async getTotalPayments(studentName: string): Promise<number> {
    try {
      const payments = await this.getStudentPayments(studentName);
      return payments.reduce((total, payment) => total + payment.amount, 0);
    } catch (error) {
      console.error('Error calculating total payments: ', error);
      return 0;
    }
  }

  async updatePayment(paymentId: string, updates: Partial<PaymentRecord>): Promise<void> {
    try {
      const paymentRef = doc(this.db, 'payments', paymentId);
      await updateDoc(paymentRef, updates);
      console.log('Payment updated successfully');
    } catch (error) {
      console.error('Error updating payment: ', error);
      throw error;
    }
  }

  async deletePayment(paymentId: string): Promise<void> {
    try {
      await deleteDoc(doc(this.db, 'payments', paymentId));
      console.log('Payment deleted successfully');
    } catch (error) {
      console.error('Error deleting payment: ', error);
      throw error;
    }
  }

  // ---------- Omni Method fitness assessments ----------
  private assessmentsCollection() { return collection(this.db, 'assessments'); }

  private mapAssessment(id: string, data: any): FitnessAssessment {
    return {
      id,
      clientId: data['clientId'] ?? null,
      clientName: data['clientName'],
      nameKey: data['nameKey'],
      timestamp: data['timestamp'],
      dateLabel: data['dateLabel'],
      inputs: data['inputs'],
      lvl: data['lvl'],
      rank: data['rank'],
      createdAt: data['createdAt'],
      updatedAt: data['updatedAt']
    };
  }

  // All assessments for one athlete, oldest → newest (the order the report math
  // and history dropdown expect). Joined by normalized name (and clientId if set).
  async listAssessmentsForClient(opts: { clientId?: string | null; clientName: string }): Promise<FitnessAssessment[]> {
    const byId = new Map<string, FitnessAssessment>();
    const key = this.normalizeNameKey(opts.clientName);
    if (key) {
      const snap = await getDocs(query(this.assessmentsCollection(), where('nameKey', '==', key)));
      snap.forEach(d => byId.set(d.id, this.mapAssessment(d.id, d.data())));
    }
    if (opts.clientId) {
      const snap = await getDocs(query(this.assessmentsCollection(), where('clientId', '==', opts.clientId)));
      snap.forEach(d => byId.set(d.id, this.mapAssessment(d.id, d.data())));
    }
    return Array.from(byId.values()).sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  }

  // Every assessment (facility-scale). Used to surface each client's latest level.
  async listAllAssessments(): Promise<FitnessAssessment[]> {
    const snap = await getDocs(this.assessmentsCollection());
    return snap.docs.map(d => this.mapAssessment(d.id, d.data()));
  }

  // Upsert keyed by athlete + calendar day: at most one assessment per athlete
  // per day. Re-saving the same day overwrites that day's snapshot (timestamp
  // moves to the latest save); a new day creates a new entry.
  async saveAssessment(a: Omit<FitnessAssessment, 'id'>): Promise<string> {
    const now = new Date().toISOString();
    const nameKey = this.normalizeNameKey(a.clientName);
    const dayKey = (a.timestamp || '').slice(0, 10);
    // Same-day match is filtered client-side (per-athlete counts are small and
    // a range+equality query would need a composite index).
    const existing = await getDocs(query(
      this.assessmentsCollection(),
      where('nameKey', '==', nameKey)
    ));
    const sameDay = existing.docs.find(
      d => ((d.data() as { timestamp?: string }).timestamp || '').slice(0, 10) === dayKey
    );
    const payload = this.cleanForFirestore({
      clientId: a.clientId ?? null,
      clientName: a.clientName,
      nameKey,
      timestamp: a.timestamp,
      dateLabel: a.dateLabel,
      inputs: a.inputs,
      lvl: a.lvl,
      rank: a.rank,
      createdAt: sameDay
        ? ((sameDay.data() as { createdAt?: string }).createdAt ?? now)
        : (a.createdAt ?? now),
      updatedAt: now
    });
    // Baseline for the recent-activity headline: if overwriting today's entry,
    // diff against what it held before this save; otherwise diff against the
    // most recent prior day's entry.
    const previousInputs: AssessmentInputs | null = sameDay
      ? ((sameDay.data() as { inputs?: AssessmentInputs }).inputs ?? null)
      : existing.docs.reduce<{ timestamp?: string; inputs?: AssessmentInputs } | null>((latest, d) => {
          const data = d.data() as { timestamp?: string; inputs?: AssessmentInputs };
          return !latest || (data.timestamp || '') > (latest.timestamp || '') ? data : latest;
        }, null)?.inputs ?? null;

    let id: string;
    if (sameDay) {
      await setDoc(sameDay.ref, payload);
      id = sameDay.id;
    } else {
      const docRef = await addDoc(this.assessmentsCollection(), payload);
      id = docRef.id;
    }
    const change = describeAssessmentChange(previousInputs, a.inputs);
    await this.touchMemberActivity(nameKey, a.clientName, change.text, a.lvl, a.rank);
    return id;
  }

  async deleteAssessment(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'assessments', id));
  }

  // ---------- Pending assessments (mobile self-submit review queue) ----------
  // Docs stick around after review (status flips to approved/rejected)
  // rather than being deleted — the mobile app shows that outcome to the
  // client as a small banner until they dismiss it themselves.
  private pendingAssessmentsCollection() { return collection(this.db, 'pendingAssessments'); }

  async listPendingAssessments(): Promise<PendingAssessment[]> {
    const q = query(this.pendingAssessmentsCollection(), where('status', '==', 'pending'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<PendingAssessment, 'id'>) }));
  }

  async setPendingAssessmentStatus(id: string, status: 'approved' | 'rejected'): Promise<void> {
    await updateDoc(doc(this.db, 'pendingAssessments', id), { status, reviewedAt: new Date().toISOString() });
  }

  // ---------- Link requests (Project-000 "link my account" review queue) ----------
  private linkRequestsCollection() { return collection(this.db, 'linkRequests'); }

  async listPendingLinkRequests(): Promise<LinkRequest[]> {
    const q = query(this.linkRequestsCollection(), where('status', '==', 'pending'));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<LinkRequest, 'id'>) }));
  }

  // Approving is the only path that ever writes clientLinks/{uid} from this
  // app's side — Project-000 no longer writes it directly at all.
  async approveLinkRequest(req: LinkRequest): Promise<void> {
    if (!req.id) return;
    await setDoc(doc(this.db, 'clientLinks', req.id), {
      nameKey: req.nameKey,
      clientName: req.requestedName,
      linkedAt: new Date().toISOString()
    });
    await updateDoc(doc(this.db, 'linkRequests', req.id), { status: 'approved', reviewedAt: new Date().toISOString() });
  }

  async rejectLinkRequest(id: string): Promise<void> {
    await updateDoc(doc(this.db, 'linkRequests', id), { status: 'rejected', reviewedAt: new Date().toISOString() });
  }

  // Keeps members/{nameKey} current for the client app's directory (top
  // performers + recent-activity feed) every time a coach saves an
  // assessment here. Best-effort — must never block the actual save.
  private async touchMemberActivity(
    nameKey: string, clientName: string, label: string, lvl: number, rank: OmniRank
  ): Promise<void> {
    try {
      const ref = doc(this.db, 'members', nameKey);
      await setDoc(ref, {
        nameKey,
        clientName: (clientName || '').trim(),
        latestLvl: lvl,
        latestRank: rank,
        lastActivityAt: new Date().toISOString(),
        lastActivityLabel: label
      }, { merge: true });
    } catch {
      // best-effort cache — the real assessment already saved
    }
  }

  // ---------- Group designation (cell/generation/cohort — the mobile app's "000" code) ----------
  // Lives on the same members/{nameKey} doc the client app's Settings page
  // already reads/writes (getMember/setMemberDesignation there) — a coach
  // setting it here and a client setting it in mobile are the same field,
  // not two parallel copies.
  async getMember(nameKey: string): Promise<Member | null> {
    const snap = await getDoc(doc(this.db, 'members', nameKey));
    return snap.exists() ? (snap.data() as Member) : null;
  }

  async setMemberDesignation(
    nameKey: string, clientName: string,
    designation: { cell: number | null; generation: number | null; cohort: number | null }
  ): Promise<void> {
    await setDoc(doc(this.db, 'members', nameKey), { nameKey, clientName, ...designation }, { merge: true });
  }

  // Which rank threshold table this athlete is scored against.
  //
  // merge:true so this can be set on an athlete whose member doc does not
  // exist yet — a client with assessments but no directory activity has no
  // members row until something touches it, and a coach shouldn't have to
  // make one first just to record a sex.
  // ---------- goals ----------
  // An athlete can have several goals at once, one per target date (plus at
  // most one dateless "someday" goal) — see AssessmentGoal.id's comment for
  // the doc-id scheme. Pre-existing single-goal docs (id === nameKey, from
  // before this) still show up in listGoalsForClient: the query filters on
  // the nameKey FIELD, not the doc id, so nothing needed migrating.

  private goalDocId(nameKey: string, targetDate?: string): string {
    return `${nameKey}::${targetDate || '_notarget'}`;
  }

  // "The" goal, for callers that only ever showed one — the most recently
  // touched of however many the athlete now has.
  async getGoal(nameKey: string): Promise<AssessmentGoal | null> {
    const goals = await this.listGoalsForClient(nameKey);
    if (!goals.length) return null;
    return goals.reduce((a, b) => (a.updatedAt || '') >= (b.updatedAt || '') ? a : b);
  }

  async listGoalsForClient(nameKey: string): Promise<AssessmentGoal[]> {
    const snap = await getDocs(query(collection(this.db, 'assessmentGoals'), where('nameKey', '==', nameKey)));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as AssessmentGoal) }))
      .sort((a, b) => (a.targetDate || '9999-99-99').localeCompare(b.targetDate || '9999-99-99'));
  }

  async setGoal(nameKey: string, clientName: string, inputs: AssessmentInputs, updatedBy: string, targetDate?: string): Promise<string> {
    const totals = computeOmni(inputs);
    const sex = (await this.getMember(nameKey))?.sex ?? 'male';
    const id = this.goalDocId(nameKey, targetDate);
    await setDoc(doc(this.db, 'assessmentGoals', id), {
      nameKey,
      clientName,
      inputs,
      lvl: totals.lvl,
      rank: getOmniRank(totals.lvl, sex),
      updatedAt: new Date().toISOString(),
      updatedBy,
      targetDate: targetDate || ''
    } as AssessmentGoal);
    return id;
  }

  async clearGoal(id: string): Promise<void> {
    await deleteDoc(doc(this.db, 'assessmentGoals', id));
  }

  async setMemberSex(nameKey: string, clientName: string, sex: Sex): Promise<void> {
    await setDoc(doc(this.db, 'members', nameKey), { nameKey, clientName, sex }, { merge: true });
  }

  // Every member in a given cell/generation/cohort group, lowest level
  // first. Pure-equality filters on three different fields don't need a
  // composite index; the level ordering is done client-side so one isn't
  // required for that either.
  async listMembersByGroup(cell: number, generation: number, cohort: number): Promise<Member[]> {
    const snap = await getDocs(query(
      collection(this.db, 'members'),
      where('cell', '==', cell), where('generation', '==', generation), where('cohort', '==', cohort)
    ));
    return snap.docs.map(d => d.data() as Member).sort((a, b) => (a.latestLvl ?? 0) - (b.latestLvl ?? 0));
  }
} 