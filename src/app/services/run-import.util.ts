// The 30-Minute Run, scored from a recorded run instead of a video. A run comes from a .fit file (any watch that
// exports one) or from Apple Health (Apple Watch, and anything that syncs into it). Both become the same three series,
// and the score is the distance covered in the fastest 30:00 of it, so a slow warm-up or a longer run does not count
// against the athlete. Time is elapsed time: a pause inside the 30:00 counts as time with no distance.
//
// facility-app has the same file: it re-reads the proof file with it for the coach's automatic check (run-check.util.ts).

import { Decoder, Stream } from '@garmin/fitsdk';

export const WINDOW_SEC = 30 * 60;

export interface RunSeries {
  dist: Array<{ t: number; m: number }>;                  // seconds from the start, cumulative metres
  route: Array<{ t: number; lat: number; lon: number }>;
  hr: Array<{ t: number; bpm: number }>;
  cadence?: Array<{ t: number; spm: number }>;           // steps per minute, from .fit files
  alt?: Array<{ t: number; m: number }>;                 // elevation in metres, from .fit files
}

export interface RunMeta {
  source: 'fit' | 'health' | 'gpx';
  device: string;            // what recorded it, as best known, e.g. "Garmin Forerunner 265", "Apple Watch"
  maker?: string;            // the .fit file's manufacturer as written, e.g. "garmin"; "development" means a tool made it
  key: string;               // the same run gives the same key, so it cannot be submitted twice
  startedAt: string;         // ISO
  indoor: boolean;           // treadmill or indoor run
  userEntered: boolean;      // typed into Apple Health by hand
}

// Saved on the submission as `run`, with `slot`: the proof slot holding the original file.
export interface RunSummary extends RunMeta {
  slot?: number;
  totalSec: number;
  totalM: number;
  windowStart: number;       // seconds into the run where the scored 30:00 begins
  km: number;                // distance in that 30:00, the score
  splits: number[];          // metres in each 5 minutes of it
  hrAvg: number | null;
  hrMax: number | null;
  route: Array<{ lat: number; lon: number }>;   // positions of the scored 30:00, at most ROUTE_POINTS
  minutes?: RunMinutes;      // the scored 30:00 minute by minute, for the graph
  flags: string[];           // reasons for the coach to look closer
}

// One value for each minute of the scored 30:00; null where nothing was recorded.
export interface RunMinutes {
  pace: Array<number | null>;   // seconds per km
  hr: Array<number | null>;     // bpm
  alt: Array<number | null>;    // metres above sea level
}

export class RunImportError extends Error {}

const ROUTE_POINTS = 400;
const SEMI = 180 / 2 ** 31;   // FIT positions are semicircles

// ── .fit ──
export function parseFit(bytes: Uint8Array): { meta: RunMeta; series: RunSeries } {
  const stream = Stream.fromByteArray(Array.from(bytes));
  if (!Decoder.isFIT(stream)) throw new RunImportError('This is not a .fit file.');
  const decoder = new Decoder(stream);
  const { messages } = decoder.read({ convertTypesToStrings: true, convertDateTimesToDates: true });
  const records = (messages.recordMesgs ?? []) as Array<Record<string, any>>;
  const fileId = (messages.fileIdMesgs?.[0] ?? {}) as Record<string, any>;
  const session = (messages.sessionMesgs?.[0] ?? {}) as Record<string, any>;
  if (fileId['type'] && fileId['type'] !== 'activity') throw new RunImportError('This .fit file is not an activity.');
  if (!records.length) throw new RunImportError('This .fit file has no recorded data.');

  const t0 = (records[0]['timestamp'] as Date).getTime();
  const series: RunSeries = { dist: [], route: [], hr: [], cadence: [], alt: [] };
  for (const r of records) {
    const t = ((r['timestamp'] as Date).getTime() - t0) / 1000;
    if (typeof r['distance'] === 'number') series.dist.push({ t, m: r['distance'] });
    if (typeof r['positionLat'] === 'number' && typeof r['positionLong'] === 'number') {
      series.route.push({ t, lat: r['positionLat'] * SEMI, lon: r['positionLong'] * SEMI });
    }
    if (typeof r['heartRate'] === 'number' && r['heartRate'] > 0) series.hr.push({ t, bpm: r['heartRate'] });
    // Running cadence is stored per leg: strides per minute, plus a fraction.
    if (typeof r['cadence'] === 'number') series.cadence!.push({ t, spm: (r['cadence'] + (r['fractionalCadence'] ?? 0)) * 2 });
    const alt = r['enhancedAltitude'] ?? r['altitude'];
    if (typeof alt === 'number') series.alt!.push({ t, m: alt });
  }
  // A file with positions but no distance field: distance from the track.
  if (!series.dist.length && series.route.length) series.dist = distanceFromRoute(series.route);

  const sport = String(session['sport'] ?? '');
  const subSport = String(session['subSport'] ?? '');
  if (sport && sport !== 'running') throw new RunImportError('This .fit file is not a run.');
  const maker = titleCase(String(fileId['manufacturer'] ?? ''));
  const product = String(fileId['garminProduct'] ?? fileId['productName'] ?? fileId['product'] ?? '');
  const created = fileId['timeCreated'] instanceof Date ? fileId['timeCreated'] as Date : new Date(t0);
  return {
    meta: {
      source: 'fit',
      device: [maker, productName(product)].filter(Boolean).join(' ') || 'Unknown device',
      maker: String(fileId['manufacturer'] ?? ''),
      key: `fit:${fileId['serialNumber'] ?? maker}:${created.getTime()}`,
      startedAt: new Date(t0).toISOString(),
      indoor: subSport === 'treadmill' || subSport === 'indoorRunning' || !series.route.length,
      userEntered: false
    },
    series
  };
}

// ── .gpx (Strava's Export GPX, and most other apps) ──
// Positions, elevation and time, with heart rate and cadence in the Garmin extension. Distance is worked out from the track.
export function parseGpx(text: string): { meta: RunMeta; series: RunSeries } {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('gpx').length) throw new RunImportError('This is not a .gpx file.');
  const pts = Array.from(doc.getElementsByTagName('trkpt'));
  const num = (el: Element, tag: string): number | null => {
    const found = Array.from(el.getElementsByTagName('*')).find(e => e.localName === tag);
    const v = found ? parseFloat(found.textContent ?? '') : NaN;
    return isFinite(v) ? v : null;
  };
  const rows = pts.map(el => {
    const time = Array.from(el.getElementsByTagName('time'))[0]?.textContent;
    return { el, ms: time ? Date.parse(time) : NaN };
  }).filter(r => isFinite(r.ms));
  if (rows.length < 2) throw new RunImportError('This .gpx file has no timed track points.');
  const t0 = rows[0].ms;
  const series: RunSeries = { dist: [], route: [], hr: [], cadence: [], alt: [] };
  for (const { el, ms } of rows) {
    const t = (ms - t0) / 1000;
    const lat = parseFloat(el.getAttribute('lat') ?? ''), lon = parseFloat(el.getAttribute('lon') ?? '');
    if (isFinite(lat) && isFinite(lon)) series.route.push({ t, lat, lon });
    const ele = num(el, 'ele'); if (ele != null) series.alt!.push({ t, m: ele });
    const hr = num(el, 'hr'); if (hr != null && hr > 0) series.hr.push({ t, bpm: hr });
    const cad = num(el, 'cad'); if (cad != null) series.cadence!.push({ t, spm: cad * 2 });
  }
  if (series.route.length < 2) throw new RunImportError('This .gpx file has no positions.');
  series.dist = distanceFromRoute(series.route);
  const creator = doc.getElementsByTagName('gpx')[0].getAttribute('creator') ?? '';
  const type = (doc.getElementsByTagName('type')[0]?.textContent ?? '').toLowerCase();
  if (type && !/run|jog/.test(type)) throw new RunImportError('This .gpx file is not a run.');
  return {
    meta: {
      source: 'gpx',
      device: creator.replace(/^StravaGPX\s*/i, 'Strava ').trim() || 'GPX file',
      key: `gpx:${t0}:${series.route[0].lat.toFixed(5)}:${series.route[0].lon.toFixed(5)}`,
      startedAt: new Date(t0).toISOString(),
      indoor: false,
      userEntered: false
    },
    series
  };
}

// ── Scoring ──
export function summarize(meta: RunMeta, s: RunSeries): RunSummary {
  let dist = monotonic(s.dist);
  // A run whose distance came as only a few samples would split evenly; the GPS track is better then.
  if (s.route.length > 30 && dist.length < Math.max(30, s.route.length / 10)) {
    const fromRoute = monotonic(distanceFromRoute(s.route));
    if (fromRoute.length > dist.length) dist = fromRoute;
  }
  if (dist.length < 2) throw new RunImportError('No distance was recorded on this run.');
  const totalSec = dist[dist.length - 1].t - dist[0].t;
  if (totalSec < WINDOW_SEC) throw new RunImportError(`This run is ${clock(totalSec)} long. It needs to be at least 30:00.`);

  const start = bestWindow(dist);
  const end = start + WINDOW_SEC;
  const at = (t: number) => distAt(dist, t);
  const metres = at(end) - at(start);
  const splits = Array.from({ length: 6 }, (_, i) => Math.round(at(start + (i + 1) * 300) - at(start + i * 300)));
  const hr = s.hr.filter(h => h.t >= start && h.t <= end).map(h => h.bpm);
  const pts = s.route.filter(p => p.t >= start && p.t <= end);
  const step = Math.max(1, Math.ceil(pts.length / ROUTE_POINTS));
  const route = pts.filter((_, i) => i % step === 0).map(p => ({ lat: round6(p.lat), lon: round6(p.lon) }));

  const flags: string[] = [];
  if (meta.userEntered) flags.push('Entered by hand in Apple Health.');
  if (meta.indoor) flags.push('An indoor or treadmill run.');
  else if (!s.route.length) flags.push('No GPS route was recorded.');
  if (!hr.length) flags.push('No heart rate was recorded.');
  if (fastestMinute(dist, start, end) > 7) flags.push('One minute is faster than 7 m/s.');
  const gap = longestGap(s.route.length ? s.route : dist, start, end);
  if (gap > 30) flags.push(`Recording stops for ${clock(gap)} inside the scored 30:00.`);

  return {
    ...meta,
    totalSec: Math.round(totalSec),
    totalM: Math.round(dist[dist.length - 1].m - dist[0].m),
    windowStart: Math.round(start - dist[0].t),
    km: Math.round(metres) / 1000,
    splits,
    hrAvg: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
    hrMax: hr.length ? Math.max(...hr) : null,
    route,
    minutes: minutesOf(dist, s, start),
    flags
  };
}

function minutesOf(dist: Array<{ t: number; m: number }>, s: RunSeries, start: number): RunMinutes {
  const avg = (v: number[]) => v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  const within = <T extends { t: number }>(a: T[] | undefined, i: number) => (a ?? []).filter(p => p.t >= start + i * 60 && p.t < start + (i + 1) * 60);
  const pace: Array<number | null> = [], hr: Array<number | null> = [], alt: Array<number | null> = [];
  for (let i = 0; i < 30; i++) {
    const m = distAt(dist, start + (i + 1) * 60) - distAt(dist, start + i * 60);
    pace.push(m > 1 ? Math.round(60 / (m / 1000)) : null);
    hr.push(avg(within(s.hr, i).map(p => p.bpm)));
    alt.push(avg(within(s.alt, i).map(p => p.m)));
  }
  return { pace, hr, alt };
}

// Start of the 30:00 that covers the most distance. Distance is linear between samples, so the best window starts or
// ends on a sample; every sample is tried both ways.
export function bestWindow(dist: Array<{ t: number; m: number }>): number {
  const t0 = dist[0].t, tn = dist[dist.length - 1].t;
  let best = t0, bestM = -1;
  const tryStart = (s: number) => {
    if (s < t0 || s + WINDOW_SEC > tn) return;
    const m = distAt(dist, s + WINDOW_SEC) - distAt(dist, s);
    if (m > bestM + 1e-9) { bestM = m; best = s; }
  };
  for (const p of dist) { tryStart(p.t); tryStart(p.t - WINDOW_SEC); }
  return best;
}

export function distAt(dist: Array<{ t: number; m: number }>, t: number): number {
  if (t <= dist[0].t) return dist[0].m;
  if (t >= dist[dist.length - 1].t) return dist[dist.length - 1].m;
  let lo = 0, hi = dist.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (dist[mid].t <= t) lo = mid; else hi = mid; }
  const a = dist[lo], b = dist[hi];
  return b.t === a.t ? b.m : a.m + (b.m - a.m) * (t - a.t) / (b.t - a.t);
}

export function clock(sec: number): string {
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

// Sorted by time, one sample per moment, and never going backwards (a watch's distance can dip by a metre).
function monotonic(dist: Array<{ t: number; m: number }>) {
  const out: Array<{ t: number; m: number }> = [];
  for (const p of [...dist].sort((a, b) => a.t - b.t)) {
    const last = out[out.length - 1];
    const m = last ? Math.max(last.m, p.m) : p.m;
    if (last && p.t === last.t) last.m = m; else out.push({ t: p.t, m });
  }
  return out;
}

function distanceFromRoute(route: RunSeries['route']) {
  let m = 0;
  return route.map((p, i) => {
    if (i) m += haversine(route[i - 1], p);
    return { t: p.t, m };
  });
}

function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fastestMinute(dist: Array<{ t: number; m: number }>, start: number, end: number): number {
  let best = 0;
  for (let t = start; t + 60 <= end; t += 10) best = Math.max(best, (distAt(dist, t + 60) - distAt(dist, t)) / 60);
  return best;
}

function longestGap(pts: Array<{ t: number }>, start: number, end: number): number {
  const ts = pts.map(p => p.t).filter(t => t >= start && t <= end);
  let gap = 0;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return gap;
}

function titleCase(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
// "fr265" → "FR265", "fenix7" → "Fenix7": readable enough for the coach, without a table of every model.
function productName(p: string): string {
  if (!p || /^\d+$/.test(p)) return '';
  return /^[a-z]{1,3}\d/.test(p) ? p.toUpperCase() : titleCase(p.replace(/([a-z])([A-Z])/g, '$1 $2'));
}
function round6(v: number): number { return Math.round(v * 1e6) / 1e6; }
