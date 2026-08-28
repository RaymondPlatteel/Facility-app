import { Decoder, Stream } from '@garmin/fitsdk';

// One time-series metric extracted from a .fit activity.
export interface MetricSeries {
  key: string;
  label: string;
  unit: string;
  color: string;
  points: { t: number; v: number }[];   // t = seconds from activity start
  min: number;
  max: number;
  avg: number;
}

export interface BestWindow {
  startSec: number;
  endSec: number;
  km: number;
  full: boolean;         // true when the activity is shorter than the window
}

export interface ParsedActivity {
  fileName: string;
  durationSec: number;
  totalDistanceKm: number;
  startTime: Date | null;
  metrics: MetricSeries[];
  best2min: BestWindow | null;
  best30min: BestWindow | null;   // only when the activity is longer than 30 min
}

interface RawRecord {
  t: number;             // seconds from start
  distance?: number;     // cumulative meters
  speed?: number;        // m/s
  heartRate?: number;
  cadence?: number;
  power?: number;
  altitude?: number;
  temperature?: number;  // °C
}

const METRIC_DEFS: Array<{
  key: keyof RawRecord;
  label: string;
  unit: string;
  color: string;
  transform?: (v: number) => number;
}> = [
  { key: 'speed', label: 'Speed', unit: 'km/h', color: '#f5b942', transform: v => v * 3.6 },
  { key: 'heartRate', label: 'Heart Rate', unit: 'bpm', color: '#ff5a6a' },
  { key: 'power', label: 'Power', unit: 'W', color: '#00d4ff' },
  { key: 'cadence', label: 'Cadence', unit: 'rpm', color: '#2dd36f' },
  { key: 'altitude', label: 'Altitude', unit: 'm', color: '#a05ad4' },
  { key: 'temperature', label: 'Temperature', unit: '°C', color: '#5e9cc4' }
];

// Parse a .fit file buffer into charts + the best 2-minute distance window.
export function parseFitActivity(buffer: ArrayBuffer, fileName: string): ParsedActivity {
  const stream = Stream.fromArrayBuffer(buffer);
  if (!Decoder.isFIT(stream)) {
    throw new Error('Not a valid .fit file');
  }
  const decoder = new Decoder(stream);
  const { messages } = decoder.read({
    // Keep numeric enums out of our way; we only read scalar fields.
    convertDateTimesToDates: true,
    mergeHeartRates: true
  });

  const recordMesgs: any[] = messages?.recordMesgs ?? [];
  const timed = recordMesgs
    .filter(r => r?.timestamp != null)
    .map(r => ({ ts: new Date(r.timestamp).getTime(), r }))
    .filter(x => isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);

  if (!timed.length) {
    throw new Error('No timestamped records found in file');
  }

  const t0 = timed[0].ts;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && isFinite(v) ? v : undefined;

  const records: RawRecord[] = timed.map(({ ts, r }) => ({
    t: (ts - t0) / 1000,
    distance: num(r.distance),
    speed: num(r.enhancedSpeed) ?? num(r.speed),
    heartRate: num(r.heartRate),
    cadence: num(r.cadence),
    power: num(r.power),
    altitude: num(r.enhancedAltitude) ?? num(r.altitude),
    temperature: num(r.temperature)
  }));

  return finalizeActivity(records, fileName, new Date(t0));
}

// Shared analysis: turn a normalized record stream (from FIT or GPX) into
// per-metric charts, total distance, and the best 2-minute window.
function finalizeActivity(records: RawRecord[], fileName: string, startTime: Date | null): ParsedActivity {
  const durationSec = records[records.length - 1].t - records[0].t;

  const metrics: MetricSeries[] = [];
  for (const def of METRIC_DEFS) {
    const points: { t: number; v: number }[] = [];
    let sum = 0, min = Infinity, max = -Infinity;
    for (const rec of records) {
      const raw = rec[def.key];
      if (typeof raw !== 'number' || !isFinite(raw)) continue;
      const v = def.transform ? def.transform(raw) : raw;
      points.push({ t: rec.t, v });
      sum += v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // Ignore metrics that are all-zero or nearly empty (e.g. power on a device
    // that reported a constant 0).
    if (points.length < 2 || max === min) continue;
    metrics.push({
      key: def.key as string,
      label: def.label,
      unit: def.unit,
      color: def.color,
      points,
      min,
      max,
      avg: sum / points.length
    });
  }

  const distSeries = buildDistanceSeries(records);
  const totalDistanceKm = distSeries.length
    ? (distSeries[distSeries.length - 1].d - distSeries[0].d) / 1000
    : 0;
  const best2min = distSeries.length >= 2 ? bestWindow(distSeries, 120) : null;
  // Only meaningful for longer efforts, so gate on >30 min of data.
  const best30min = distSeries.length >= 2 && durationSec > 1800
    ? bestWindow(distSeries, 1800)
    : null;

  return { fileName, durationSec, totalDistanceKm, startTime, metrics, best2min, best30min };
}

// ---------- GPX ----------

// Great-circle distance between two lat/lon points, in meters.
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Parse a GPX track into charts + the best 2-minute window. Distance and speed
// are derived from GPS coordinates; HR/cadence/power/temperature come from the
// Garmin TrackPointExtension when present.
export function parseGpxActivity(xml: string, fileName: string): ParsedActivity {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement?.nodeName === 'parsererror') {
    throw new Error('Could not parse GPX (invalid XML)');
  }

  const trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!trkpts.length) {
    throw new Error('No track points found in GPX');
  }

  // First descendant of `el` whose local (namespace-stripped) name matches.
  const localVal = (el: Element, name: string): string | null => {
    const hit = el.getElementsByTagNameNS('*', name)[0];
    return hit ? hit.textContent : null;
  };
  const numOf = (s: string | null): number | undefined => {
    if (s == null) return undefined;
    const n = parseFloat(s);
    return isFinite(n) ? n : undefined;
  };

  interface GpxPt {
    lat: number; lon: number; tMs: number;
    ele?: number; hr?: number; cad?: number; power?: number; temp?: number;
  }

  const pts: GpxPt[] = [];
  for (const p of trkpts) {
    const lat = parseFloat(p.getAttribute('lat') || '');
    const lon = parseFloat(p.getAttribute('lon') || '');
    const timeStr = localVal(p, 'time');
    const tMs = timeStr ? new Date(timeStr).getTime() : NaN;
    if (!isFinite(lat) || !isFinite(lon) || !isFinite(tMs)) continue;
    pts.push({
      lat, lon, tMs,
      ele: numOf(localVal(p, 'ele')),
      hr: numOf(localVal(p, 'hr')),
      cad: numOf(localVal(p, 'cad')),
      // Power may appear as <power> or Garmin's <PowerInWatts>.
      power: numOf(localVal(p, 'power')) ?? numOf(localVal(p, 'PowerInWatts')),
      temp: numOf(localVal(p, 'atemp')) ?? numOf(localVal(p, 'temp'))
    });
  }

  if (pts.length < 2) {
    throw new Error('GPX has no timestamped track points to analyze');
  }
  pts.sort((a, b) => a.tMs - b.tMs);

  const t0 = pts[0].tMs;
  // Build records: cumulative distance via haversine, then a smoothed speed.
  const rawSpeed: number[] = new Array(pts.length).fill(0);
  let cum = 0;
  const records: RawRecord[] = pts.map((p, i) => {
    if (i > 0) {
      const prev = pts[i - 1];
      const d = haversine(prev.lat, prev.lon, p.lat, p.lon);
      const dt = (p.tMs - prev.tMs) / 1000;
      cum += d;
      rawSpeed[i] = dt > 0 ? d / dt : 0;
    }
    return {
      t: (p.tMs - t0) / 1000,
      distance: cum,
      heartRate: p.hr,
      cadence: p.cad,
      power: p.power,
      altitude: p.ele,
      temperature: p.temp
    } as RawRecord;
  });

  // Smooth GPS-derived speed (5-sample moving average) to tame jitter.
  const half = 2;
  for (let i = 0; i < records.length; i++) {
    let sum = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < rawSpeed.length) { sum += rawSpeed[j]; n++; }
    }
    records[i].speed = n ? sum / n : rawSpeed[i];
  }

  return finalizeActivity(records, fileName, new Date(t0));
}

// (t, cumulative meters). Uses recorded distance when present, otherwise
// integrates speed over time so speed-only devices still work.
function buildDistanceSeries(records: RawRecord[]): Array<{ t: number; d: number }> {
  const hasDistance = records.some(r => typeof r.distance === 'number');
  if (hasDistance) {
    const out: Array<{ t: number; d: number }> = [];
    let last = 0;
    for (const r of records) {
      if (typeof r.distance === 'number') last = r.distance;
      out.push({ t: r.t, d: last });
    }
    return out;
  }
  // Integrate speed (m/s) across the gaps between samples.
  const out: Array<{ t: number; d: number }> = [];
  let cum = 0;
  for (let i = 0; i < records.length; i++) {
    if (i > 0) {
      const dt = records[i].t - records[i - 1].t;
      const v = records[i].speed ?? records[i - 1].speed ?? 0;
      cum += v * dt;
    }
    out.push({ t: records[i].t, d: cum });
  }
  return out;
}

// Cumulative distance at an arbitrary time (linear interpolation).
function distanceAt(pts: Array<{ t: number; d: number }>, te: number): number {
  if (te <= pts[0].t) return pts[0].d;
  const lastPt = pts[pts.length - 1];
  if (te >= lastPt.t) return lastPt.d;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= te) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const span = b.t - a.t || 1;
  return a.d + ((te - a.t) / span) * (b.d - a.d);
}

// The window of `windowSec` covering the most distance. Anchors the window at
// each sample start and interpolates the far edge, so it is accurate to the
// sample rate regardless of total activity length.
export function bestWindow(pts: Array<{ t: number; d: number }>, windowSec: number): BestWindow {
  const total = pts[pts.length - 1].t - pts[0].t;
  if (total <= windowSec) {
    return {
      startSec: 0,
      endSec: total,
      km: (pts[pts.length - 1].d - pts[0].d) / 1000,
      full: true
    };
  }
  let best = { meters: -1, startSec: 0, endSec: windowSec };
  const lastT = pts[pts.length - 1].t;
  for (const p of pts) {
    const start = p.t;
    const end = start + windowSec;
    if (end > lastT) break;
    const meters = distanceAt(pts, end) - p.d;
    if (meters > best.meters) best = { meters, startSec: start, endSec: end };
  }
  return { startSec: best.startSec, endSec: best.endSec, km: best.meters / 1000, full: false };
}

// Elapsed seconds → m:ss.
export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
