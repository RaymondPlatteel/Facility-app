// Shared workouts: one record per workout (memberWorkoutLogs), written by
// both the coach app and the athlete app. This file is kept identical in
// facility-app and Project-000 — change one, copy it to the other.
//
// While a workout is being done it is `inProgress` and both apps edit it
// live: each writes the whole workout as the person edits, and when the
// other side's write arrives it is merged three ways against the version
// both last agreed on, so an edit made here in the meantime survives
// instead of being overwritten — the athlete typing a weight while the
// coach ticks a set both stick. Exercises line up by `key`, sets by
// position. When both sides changed the very same field, this side's value
// wins and is written back; the other side then takes it, so they converge.

export interface SyncSet {
  reps: number | null;
  weight: number | null;
  rir: number | null;
  completed: boolean;
  setType: 'warmup' | 'normal';
  videoUrl: string | null;
  // Columns beyond reps/weight/RIR (Tempo, Duration…) and any load that
  // isn't a plain number ("BW"), as text keyed by column name.
  values?: { [column: string]: string };
}

export interface SyncExercise {
  key?: string;
  name: string;
  sets: SyncSet[];
  notes?: string;
  // From a coach's program: the prescription line and the columns the
  // coach's sheet tracks for this exercise.
  prescription?: string;
  attrColumns?: string[];
}

export interface WorkoutSyncState {
  title: string;
  notes: string;
  exercises: SyncExercise[];
}

// The coach app's sheet shape: free-text cells per column.
export interface SheetSet {
  values: { [column: string]: string };
  done?: boolean;
}

export interface SheetExercise {
  key?: string;
  exerciseName: string;
  prescription: string;
  attrColumns: string[];
  sets: SheetSet[];
  notes?: string;
}

// Identifies this app instance's own writes (updatedBy).
export const SYNC_CLIENT_ID = Math.random().toString(36).slice(2, 12);

// What the coach sheet shows for an exercise the athlete started.
export const DEFAULT_SHEET_COLUMNS = ['Reps', 'Load', 'RIR'];

const NUMERIC_COLUMN: { [column: string]: 'reps' | 'weight' | 'rir' } = {
  Reps: 'reps', Load: 'weight', Weight: 'weight', RIR: 'rir'
};

export function newExerciseKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Keys for exercises saved before keys existed — by position, so every
// device derives the same one.
export function ensureExerciseKeys<T extends { key?: string }>(exercises: T[]): T[] {
  return (exercises || []).map((e, i) => (e.key ? e : { ...e, key: `x${i}` }));
}

// Local YYYY-MM-DD.
export function todayKey(): string {
  return new Date().toLocaleDateString('en-CA');
}

// A workout counts as live only on the day it was started: one somebody
// walked away from without finishing is history the next day, not a
// session either app keeps offering to resume.
export function isLiveWorkout(w: { inProgress?: boolean; dateLabel?: string } | null | undefined): boolean {
  return !!w?.inProgress && w.dateLabel === todayKey();
}

export function normalizeSet(s: Partial<SyncSet>): SyncSet {
  const out: SyncSet = {
    reps: typeof s.reps === 'number' && isFinite(s.reps) ? s.reps : null,
    weight: typeof s.weight === 'number' && isFinite(s.weight) ? s.weight : null,
    rir: typeof s.rir === 'number' && isFinite(s.rir) ? s.rir : null,
    completed: !!s.completed,
    setType: s.setType === 'warmup' ? 'warmup' : 'normal',
    videoUrl: s.videoUrl ?? null
  };
  const values: { [column: string]: string } = {};
  for (const [k, v] of Object.entries(s.values || {})) {
    const text = (v ?? '').toString().trim();
    if (text) values[k] = text;
  }
  if (Object.keys(values).length) out.values = values;
  return out;
}

export function normalizeExercise(e: Partial<SyncExercise>): SyncExercise {
  const out: SyncExercise = {
    name: e.name ?? '',
    notes: e.notes ?? '',
    sets: (e.sets || []).map(normalizeSet)
  };
  if (e.key) out.key = e.key;
  if (e.prescription) out.prescription = e.prescription;
  if (e.attrColumns?.length) out.attrColumns = [...e.attrColumns];
  return out;
}

export function normalizeState(s: { title?: string; notes?: string; exercises?: Partial<SyncExercise>[] }): WorkoutSyncState {
  return {
    title: s.title ?? '',
    notes: s.notes ?? '',
    exercises: ensureExerciseKeys(s.exercises || []).map(normalizeExercise)
  };
}

// Coach sheet -> shared shape. `prev` is the same exercise as last stored,
// so what the sheet can't show (warm-up flags, set videos) is kept.
export function sheetToSync(ex: SheetExercise, prev?: SyncExercise, index = 0): SyncExercise {
  const sets = ex.sets.map((s, i) => {
    const before = prev?.sets[i];
    const out: SyncSet = {
      reps: null, weight: null, rir: null,
      completed: !!s.done,
      setType: before?.setType ?? 'normal',
      videoUrl: before?.videoUrl ?? null
    };
    const extra: { [column: string]: string } = {};
    for (const [col, raw] of Object.entries(s.values || {})) {
      const text = (raw ?? '').toString().trim();
      if (!text) continue;
      const field = NUMERIC_COLUMN[col];
      const n = Number(text);
      if (field && isFinite(n)) out[field] = n;
      else extra[col] = text;
    }
    if (Object.keys(extra).length) out.values = extra;
    return out;
  });
  // An athlete's own exercise shows on the sheet with the default columns;
  // that alone isn't an edit worth storing on it.
  const columns = prev && !prev.attrColumns && sameValue(ex.attrColumns, DEFAULT_SHEET_COLUMNS)
    ? undefined
    : ex.attrColumns;
  return normalizeExercise({
    key: ex.key || prev?.key || `x${index}`,
    name: ex.exerciseName,
    notes: ex.notes || '',
    prescription: ex.prescription,
    attrColumns: columns,
    sets
  });
}

// Shared shape -> coach sheet.
export function syncToSheet(ex: SyncExercise, index = 0): SheetExercise {
  const columns = ex.attrColumns?.length ? ex.attrColumns : DEFAULT_SHEET_COLUMNS;
  return {
    key: ex.key || `x${index}`,
    exerciseName: ex.name || 'Exercise',
    prescription: ex.prescription || '',
    attrColumns: [...columns],
    notes: ex.notes || '',
    sets: (ex.sets || []).map(s => {
      const values: { [column: string]: string } = { ...(s.values || {}) };
      for (const col of columns) {
        const field = NUMERIC_COLUMN[col];
        if (field && s[field] != null) values[col] = String(s[field]);
      }
      return { values, done: !!s.completed };
    })
  };
}

// ---------- Three-way merge ----------
function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Key order and undefined fields don't count as a difference.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v).filter(k => v[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sameValue(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

export function merge3<T>(base: T, local: T, remote: T): T {
  if (sameValue(local, base)) return remote;
  if (sameValue(remote, base) || sameValue(local, remote)) return local;
  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
    const keyed = [base, local, remote].every(list => list.every(x => isObj(x) && typeof x['key'] === 'string'));
    return (keyed ? mergeKeyed(base, local, remote) : mergePositional(base, local, remote)) as T;
  }
  if (isObj(base) && isObj(local) && isObj(remote)) {
    const out: Record<string, any> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const v = merge3(base[k], local[k], remote[k]);
      if (v !== undefined) out[k] = v;
    }
    return out as T;
  }
  return local;
}

// Sets: the side that added or removed one decides the list (the other
// side if both did), and values merge set by set where all three have it.
function mergePositional(base: any[], local: any[], remote: any[]): any[] {
  const lead = remote.length !== base.length || local.length === base.length ? remote : local;
  return lead.map((item, i) =>
    i < base.length && i < local.length && i < remote.length ? merge3(base[i], local[i], remote[i]) : item);
}

// Exercises: order and removals come from the side that changed the list;
// the other side's additions are slotted in after the exercise they
// followed, and its removals still apply.
function mergeKeyed(base: any[], local: any[], remote: any[]): any[] {
  const keyOf = (x: any) => x.key as string;
  const byKey = (list: any[]) => new Map(list.map(x => [keyOf(x), x]));
  const b = byKey(base), l = byKey(local), r = byKey(remote);
  const sameOrder = (x: any[], y: any[]) => x.map(keyOf).join('|') === y.map(keyOf).join('|');
  const lead = !sameOrder(remote, base) || sameOrder(local, base) ? remote : local;
  const other = lead === remote ? local : remote;
  const otherKeys = byKey(other);

  const order = lead.map(keyOf).filter(k => !(b.has(k) && !otherKeys.has(k)));
  other.forEach((item, i) => {
    const k = keyOf(item);
    if (b.has(k) || order.includes(k)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const idx = order.indexOf(keyOf(other[j]));
      if (idx >= 0) { at = idx + 1; break; }
    }
    order.splice(at, 0, k);
  });

  return order.map(k => {
    const [bb, ll, rr] = [b.get(k), l.get(k), r.get(k)];
    return bb && ll && rr ? merge3(bb, ll, rr) : (ll ?? rr);
  });
}

// Makes `target` read like `source` while keeping its objects (and the
// inputs bound to them) when only values changed — a live update must not
// rebuild the page under someone's thumb. Returns false when the list
// itself changed (items added, removed or reordered), and does nothing.
export function patchInPlace(target: any[], source: any[], keyOf: (x: any, i: number) => string): boolean {
  if (target.length !== source.length) return false;
  if (target.some((t, i) => keyOf(t, i) !== keyOf(source[i], i))) return false;
  target.forEach((t, i) => assignDeep(t, source[i]));
  return true;
}

function assignDeep(target: Record<string, any>, source: Record<string, any>) {
  for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
  for (const [k, v] of Object.entries(source)) {
    const cur = target[k];
    if (Array.isArray(v) && Array.isArray(cur) && cur.length === v.length && v.every(isObj) && cur.every(isObj)) {
      cur.forEach((c, i) => assignDeep(c, v[i]));
    } else if (isObj(v) && isObj(cur)) {
      assignDeep(cur, v);
    } else if (!sameValue(cur, v)) {
      target[k] = Array.isArray(v) ? v.map(x => (isObj(x) ? { ...x } : x)) : isObj(v) ? { ...v } : v;
    }
  }
}
