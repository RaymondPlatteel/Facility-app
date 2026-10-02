// The prescription attributes a coach can track on an exercise. One catalog
// for every page that touches them: the coach app's program creator says what
// to do, its workout log and this app's session record what happened — so a
// column added in one exists in the others. This file is kept identical in
// facility-app and Project-000 — change one, copy it to the other.
import type { ProgramAttribute } from './firebase.service';

export const DISTANCE_UNITS = ['Feet', 'Yards', 'Meters', 'Miles', 'Kilometers'];
export const SPEED_UNITS = ['mph', 'kph'];
export const PACE_UNITS = ['min/mile', 'min/km'];

export const ATTRIBUTE_TYPES = [
  'Sets', 'Reps', 'Load', 'Duration', 'RIR', 'RPE', 'Tempo',
  ...DISTANCE_UNITS, ...SPEED_UNITS, ...PACE_UNITS,
  'Watts', 'SPM', 'RPM', 'Incline', 'Drag Factor', 'Gear', 'HR'
];

// The log tracks per-set columns; how many sets there are isn't one.
export const LOG_ATTRIBUTE_TYPES = ATTRIBUTE_TYPES.filter(t => t !== 'Sets');

// Some attributes rule each other out (reps or a duration, RIR or RPE, one
// unit of distance/speed/pace). `existing` is what the exercise already has.
export function isAttributeLocked(existing: string[], type: string): boolean {
  if (existing.includes(type)) return false;
  if (type === 'RIR' && existing.includes('RPE')) return true;
  if (type === 'RPE' && existing.includes('RIR')) return true;
  if (type === 'Tempo' && existing.includes('Duration')) return true;
  if (type === 'Duration' && (existing.includes('Tempo') || existing.includes('Reps'))) return true;
  if (type === 'Reps' && existing.includes('Duration')) return true;
  if (DISTANCE_UNITS.includes(type)) return existing.some(t => DISTANCE_UNITS.includes(t));
  if (SPEED_UNITS.includes(type)) return existing.some(t => SPEED_UNITS.includes(t));
  if (PACE_UNITS.includes(type)) return existing.some(t => PACE_UNITS.includes(t));
  return false;
}

// Why an attribute is greyed out, for the tooltip.
export function lockReason(existing: string[], type: string): string {
  if (!isAttributeLocked(existing, type)) return '';
  if (type === 'RIR' || type === 'RPE') return 'Use RIR or RPE, not both';
  if (type === 'Tempo' || type === 'Duration' || type === 'Reps') return 'Reps, Tempo and Duration don\'t go together';
  if (DISTANCE_UNITS.includes(type)) return 'One distance unit per exercise';
  if (SPEED_UNITS.includes(type)) return 'One speed unit per exercise';
  return 'One pace unit per exercise';
}

// ---------- How each attribute is entered in the log ----------
export type AttrKind = 'number' | 'duration' | 'tempo';

export interface AttrMeta {
  kind: AttrKind;
  header: string;        // column heading
  unit?: string;         // suffix inside the field
  mode: 'decimal' | 'numeric';
  width: number;         // px, minimum column width
}

const META: { [type: string]: Partial<AttrMeta> } = {
  Reps: { mode: 'numeric', width: 72 },
  Load: { unit: 'lb', width: 96 },
  RIR: { mode: 'numeric', width: 68 },
  RPE: { width: 68 },
  Duration: { kind: 'duration', header: 'Time', width: 96 },
  Tempo: { kind: 'tempo', width: 156 },
  Feet: { unit: 'ft', width: 92 },
  Yards: { unit: 'yd', width: 92 },
  Meters: { unit: 'm', width: 92 },
  Miles: { unit: 'mi', width: 92 },
  Kilometers: { header: 'Km', unit: 'km', width: 92 },
  mph: { unit: 'mph', width: 92 },
  kph: { unit: 'kph', width: 92 },
  'min/mile': { header: 'Pace', unit: '/mi', width: 92 },
  'min/km': { header: 'Pace', unit: '/km', width: 92 },
  Watts: { unit: 'W', width: 88 },
  SPM: { unit: 'spm', mode: 'numeric', width: 92 },
  RPM: { unit: 'rpm', mode: 'numeric', width: 92 },
  Incline: { unit: '%', width: 84 },
  'Drag Factor': { header: 'Drag', mode: 'numeric', width: 76 },
  Gear: { mode: 'numeric', width: 68 },
  HR: { unit: 'bpm', mode: 'numeric', width: 92 }
};

export function attrMeta(type: string): AttrMeta {
  const m = META[type] || {};
  return { kind: 'number', header: type, mode: 'decimal', width: 84, ...m };
}

// ---------- Prescription text ----------
// 'hh:mm:ss' (or plain seconds) as 'm:ss' / 'h:mm:ss'; '' for none.
export function fmtDuration(v: string): string {
  const raw = (v || '').trim();
  if (!raw) return '';
  const p = raw.split(':').map(n => parseInt(n, 10) || 0);
  let s = p.length === 1 ? p[0] : p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2];
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// A duration typed as a stream of digits: they shift in from the right, the
// way a kitchen timer takes them (1 3 0 → 1:30, 1 3 0 0 0 → 1:30:00).
export function durationFromDigits(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '').replace(/^0+/, '').slice(-6);
  if (!digits) return '';
  const d = digits.padStart(digits.length > 4 ? 6 : 3, '0');
  const sec = d.slice(-2);
  const min = d.slice(-4, -2);
  const hrs = d.slice(0, -4);
  return hrs ? `${parseInt(hrs, 10)}:${min}:${sec}` : `${parseInt(min, 10)}:${sec}`;
}

export function durationSeconds(text: string): number {
  const p = (text || '').split(':').map(n => parseInt(n, 10));
  if (!p.length || p.some(n => !isFinite(n))) return 0;
  return p.reduce((t, n) => t * 60 + n, 0);
}

// What the coach prescribed for one attribute, as the short text shown
// above a column and on the exercise's chips. '' when it's left to the
// athlete ("User Input").
export function formatTarget(a: ProgramAttribute): string {
  switch (a.strategy) {
    case 'User Input': return '';
    case 'Bodyweight': return 'BW';
    case 'AMRAP': return 'AMRAP';
    case '%1RM': return a.val ? `${a.val}% 1RM` : '';
    default: break;
  }
  if (!a.val) return '';
  if (a.type === 'Duration') {
    const parts = a.val.includes('-') && a.val.includes(':') ? a.val.split('-') : [a.val];
    return parts.map(fmtDuration).filter(Boolean).join('–');
  }
  if (a.type === 'Tempo') return a.val;
  return a.val.replace(/\s*-\s*/g, '–');
}

// The prescription as the one-line summary saved with a logged exercise.
export function prescriptionText(attrs: ProgramAttribute[]): string {
  return attrs.map(a => `${a.type}: ${formatTarget(a) || '—'}`).join(' · ');
}

// The reverse: chips from a saved summary, for exercises whose program
// isn't at hand.
export function parsePrescription(text: string): { type: string; value: string }[] {
  return (text || '').split(' · ').map(part => {
    const i = part.indexOf(': ');
    if (i < 0) return null;
    const value = part.slice(i + 2).trim();
    return { type: part.slice(0, i).trim(), value: value === '—' ? '' : value };
  }).filter((x): x is { type: string; value: string } => !!x && !!x.type);
}

// ---------- Starting points for an exercise made on the spot ----------
export interface ExercisePreset {
  id: string;
  label: string;
  hint: string;
  columns: string[];
  sets: number;
}

export const EXERCISE_PRESETS: ExercisePreset[] = [
  { id: 'strength', label: 'Strength', hint: 'Reps · Load · RIR', columns: ['Reps', 'Load', 'RIR'], sets: 3 },
  { id: 'tempo', label: 'Tempo Lift', hint: 'Reps · Load · Tempo · RIR', columns: ['Reps', 'Load', 'Tempo', 'RIR'], sets: 3 },
  { id: 'bodyweight', label: 'Bodyweight', hint: 'Reps · RIR', columns: ['Reps', 'RIR'], sets: 3 },
  { id: 'hold', label: 'Timed Hold', hint: 'Duration · RPE', columns: ['Duration', 'RPE'], sets: 3 },
  { id: 'row', label: 'Row / Erg', hint: 'Meters · Time · Watts · SPM', columns: ['Meters', 'Duration', 'Watts', 'SPM'], sets: 1 },
  { id: 'run', label: 'Run', hint: 'Miles · Time · Pace · HR', columns: ['Miles', 'Duration', 'min/mile', 'HR'], sets: 1 },
  { id: 'bike', label: 'Bike', hint: 'Time · Watts · RPM · HR', columns: ['Duration', 'Watts', 'RPM', 'HR'], sets: 1 }
];
