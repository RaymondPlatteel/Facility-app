import type { PlateReading } from './ai-review.types';

// Reads the plates on the bar from three stills of the video, by sending them to the plate-reader worker (see
// workers/plate-reader). The worker's address is kept in the database (config/ai.plateReaderUrl), so switching plate
// reading on, or moving the worker, needs no app update. With no address set, plates are simply not read.
export async function readPlates(url: string, stills: string[], test: string, claimedLb: number | null): Promise<PlateReading | null> {
  if (!url || !stills.length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test, claimedLb, images: stills }),
      signal: ctl.signal
    });
    if (!res.ok) return null;
    const j = await res.json();
    const total = typeof j.totalLb === 'number' && isFinite(j.totalLb) && j.totalLb > 0 ? j.totalLb : null;
    const conf = j.confidence === 'high' || j.confidence === 'medium' ? j.confidence : 'low';
    return { totalLb: total, confidence: conf, notes: String(j.notes ?? '').slice(0, 400) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
