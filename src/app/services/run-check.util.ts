// The automatic check on a submitted 30-Minute Run. The coach app reads the original proof file itself (the .fit, or
// the Apple Health data), scores it again and tests it, so nothing the athlete's phone reported is taken on trust.
// Every check passes, warns or fails; the run passes only when nothing fails. Warnings are for the coach to look at.

import { RunMeta, RunSeries, RunSummary, WINDOW_SEC, clock, distAt, parseFit, parseGpx, summarize } from './run-import.util';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface RunCheck { label: string; status: CheckStatus; detail: string; }

export interface RunMetrics {
  km: number;
  paceSecPerKm: number;
  totalSec: number;
  totalKm: number;
  hrAvg: number | null; hrMin: number | null; hrMax: number | null;
  cadenceAvg: number | null;        // steps per minute
  climbM: number | null;            // elevation gained in the scored 30:00
  gpsKm: number | null;             // distance along the GPS track in the scored 30:00
  paceByMinute: number[];           // seconds per km, one per minute of the scored 30:00 (0 when standing)
  hrByMinute: Array<number | null>; // average bpm, one per minute
}

export interface RunCheckResult {
  verdict: 'pass' | 'fail';
  checks: RunCheck[];
  metrics: RunMetrics;
  summary: RunSummary;              // the run as scored here, from the file
}

const WORLD_30_MIN_KM = 11.265408;   // the 30-Minute Run's world record (omni.util)

export function readRunFile(source: RunSummary['source'], bytes: ArrayBuffer): { meta: RunMeta; series: RunSeries } {
  if (source === 'fit') return parseFit(new Uint8Array(bytes));
  if (source === 'gpx') return parseGpx(new TextDecoder().decode(bytes));
  const data = JSON.parse(new TextDecoder().decode(bytes));
  const { dist, route, hr, cadence, alt, ...meta } = data;
  return { meta: meta as RunMeta, series: { dist: dist ?? [], route: route ?? [], hr: hr ?? [], cadence, alt } };
}

export function checkRun(
  meta: RunMeta, series: RunSeries,
  submitted: { km: number; at: string; duplicateOf: string | null }
): RunCheckResult {
  const summary = summarize(meta, series);
  const dist = [...series.dist].sort((a, b) => a.t - b.t);
  const s0 = dist[0].t + summary.windowStart, s1 = s0 + WINDOW_SEC;
  const inWin = <T extends { t: number }>(a: T[] | undefined) => (a ?? []).filter(p => p.t >= s0 && p.t <= s1);
  const at = (t: number) => distAt(dist, t);

  // ── Metrics ──
  const hr = inWin(series.hr).map(h => h.bpm);
  const cad = inWin(series.cadence).map(c => c.spm).filter(v => v > 0);
  const route = inWin(series.route);
  const alt = inWin(series.alt);
  let gpsM = 0;
  for (let i = 1; i < route.length; i++) gpsM += haversine(route[i - 1], route[i]);
  let climb = 0, base = alt[0]?.m;
  for (const a of alt) {   // climbs of under 2 m are GPS and barometer noise
    if (base == null) { base = a.m; continue; }
    if (a.m - base >= 2) { climb += a.m - base; base = a.m; } else if (a.m < base) base = a.m;
  }
  const paceByMinute: number[] = [], hrByMinute: Array<number | null> = [];
  for (let i = 0; i < 30; i++) {
    const m = at(s0 + (i + 1) * 60) - at(s0 + i * 60);
    paceByMinute.push(m > 1 ? Math.round(60 / (m / 1000)) : 0);
    const h = (series.hr ?? []).filter(p => p.t >= s0 + i * 60 && p.t < s0 + (i + 1) * 60).map(p => p.bpm);
    hrByMinute.push(h.length ? Math.round(avg(h)) : null);
  }
  const metrics: RunMetrics = {
    km: summary.km,
    paceSecPerKm: summary.km ? Math.round(WINDOW_SEC / summary.km) : 0,
    totalSec: summary.totalSec,
    totalKm: summary.totalM / 1000,
    hrAvg: hr.length ? Math.round(avg(hr)) : null,
    hrMin: hr.length ? Math.min(...hr) : null,
    hrMax: hr.length ? Math.max(...hr) : null,
    cadenceAvg: cad.length ? Math.round(avg(cad)) : null,
    climbM: alt.length ? Math.round(climb) : null,
    gpsKm: route.length > 1 ? gpsM / 1000 : null,
    paceByMinute, hrByMinute
  };

  // ── Checks ──
  const checks: RunCheck[] = [];
  const add = (label: string, status: CheckStatus, detail: string) => checks.push({ label, status, detail });

  const diff = Math.abs(summary.km - submitted.km);
  add('Score matches the file', diff <= 0.01 ? 'pass' : 'fail',
    diff <= 0.01 ? `${summary.km.toFixed(2)} km in the fastest 30:00.` : `Submitted ${submitted.km.toFixed(2)} km; the file gives ${summary.km.toFixed(2)} km.`);

  if (meta.userEntered) add('Recorded by a watch', 'fail', 'The run was typed into Apple Health by hand.');
  else if (meta.source === 'fit' && meta.maker === 'development') add('Recorded by a watch', 'fail', 'The file was made by a file tool, not recorded by a watch.');
  else if (meta.source === 'fit' && !meta.maker) add('Recorded by a watch', 'warn', 'The file does not say what recorded it.');
  else if (meta.source === 'gpx') add('Recorded by a watch', 'warn', `A .gpx export from ${meta.device}. A .gpx file can be edited, so check the route and heart rate.`);
  else add('Recorded by a watch', 'pass', meta.device);

  add('Not submitted before', submitted.duplicateOf ? 'fail' : 'pass',
    submitted.duplicateOf ? `This run was already approved for ${submitted.duplicateOf}.` : 'This run has not been approved before.');

  const ran = new Date(summary.startedAt).getTime(), sent = new Date(submitted.at).getTime();
  const days = (sent - ran) / 86400000;
  if (days < -0.01) add('Recorded before submitting', 'fail', 'The run is dated after the submission.');
  else {
    const n = Math.max(0, Math.round(days));
    add('Recorded before submitting', days <= 30 ? 'pass' : 'warn',
      n === 0 ? 'The same day as the submission.' : `${n} day${n === 1 ? '' : 's'} before the submission.`);
  }

  if (!route.length) {
    add('GPS route', 'warn', 'No GPS: an indoor or treadmill run. Distance is the watch\'s estimate.');
  } else {
    add('GPS route', 'pass', `${route.length} points in the scored 30:00.`);
    const ratio = metrics.gpsKm! / Math.max(summary.km, 0.001);
    const off = Math.abs(1 - ratio) * 100;
    add('GPS matches distance', off <= 7 ? 'pass' : off <= 15 ? 'warn' : 'fail',
      `The GPS track is ${metrics.gpsKm!.toFixed(2)} km against ${summary.km.toFixed(2)} km recorded (${off.toFixed(0)}% apart).`);
  }

  if (!hr.length) {
    add('Heart rate recorded', 'fail', 'No heart rate in the scored 30:00.');
  } else {
    const covered = hrByMinute.filter(v => v != null).length;
    add('Heart rate recorded', covered >= 24 ? 'pass' : 'warn', `Heart rate in ${covered} of 30 minutes.`);
    const perMin = hrByMinute.filter((v): v is number => v != null);
    const spread = stdev(perMin);
    if (metrics.hrMax! > 230) add('Heart rate fits running', 'fail', `A reading of ${metrics.hrMax} bpm is not possible.`);
    else if (perMin.length >= 5 && spread < 1.5) add('Heart rate fits running', 'fail', 'Heart rate barely changes for the whole run, as if generated.');
    else if (metrics.hrAvg! < 100) add('Heart rate fits running', 'fail', `An average of ${metrics.hrAvg} bpm is too low for a hard 30-minute run.`);
    else if (metrics.hrAvg! < 120) add('Heart rate fits running', 'warn', `An average of ${metrics.hrAvg} bpm is low for a hard 30-minute run.`);
    else add('Heart rate fits running', 'pass', `${metrics.hrAvg} average, ${metrics.hrMin}–${metrics.hrMax} bpm.`);
  }

  let fastest = 0;
  for (let t = s0; t + 60 <= s1; t += 10) fastest = Math.max(fastest, (at(t + 60) - at(t)) / 60);
  if (summary.km > WORLD_30_MIN_KM) add('Speed', 'fail', `${summary.km.toFixed(2)} km is beyond the world record for 30 minutes.`);
  else if (fastest > 7) add('Speed', 'fail', `One minute is at ${(fastest * 3.6).toFixed(1)} km/h, faster than running.`);
  else if (fastest > 6.5) add('Speed', 'warn', `Fastest minute ${(fastest * 3.6).toFixed(1)} km/h.`);
  else add('Speed', 'pass', `Fastest minute ${(fastest * 3.6).toFixed(1)} km/h.`);

  const times = (route.length ? route : inWin(dist)).map(p => p.t);
  let gap = 0;
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, times[i] - times[i - 1]);
  add('Recording without gaps', gap <= 30 ? 'pass' : 'warn',
    gap <= 30 ? 'No gap longer than 30 seconds.' : `Recording stops for ${clock(gap)}.`);

  if (metrics.cadenceAvg != null) {
    const fast = metrics.paceSecPerKm > 0 && metrics.paceSecPerKm < 360;
    if (metrics.cadenceAvg < 120 && fast) add('Cadence fits running', 'fail', `${metrics.cadenceAvg} steps per minute at ${clock(metrics.paceSecPerKm)} /km: moving without running steps.`);
    else if (metrics.cadenceAvg < 140 || metrics.cadenceAvg > 220) add('Cadence fits running', 'warn', `${metrics.cadenceAvg} steps per minute.`);
    else add('Cadence fits running', 'pass', `${metrics.cadenceAvg} steps per minute.`);
  }

  return { verdict: checks.some(c => c.status === 'fail') ? 'fail' : 'pass', checks, metrics, summary };
}

function avg(v: number[]): number { return v.reduce((a, b) => a + b, 0) / v.length; }
function stdev(v: number[]): number {
  if (v.length < 2) return 0;
  const m = avg(v);
  return Math.sqrt(avg(v.map(x => (x - m) ** 2)));
}
function haversine(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
