// The Cloudflare Worker that handles Stripe payments and subscription
// billing. Same deployment the athlete app talks to — see
// Project-000/stripe-webhook/README.md for setup; this URL is what
// `npx wrangler deploy` prints once it's live.
export const PAYMENTS_WORKER_URL = 'https://REPLACE_ME.workers.dev';

// Sent as X-Coach-Secret on coach-only Worker endpoints (postponing an
// athlete's billing after an excused absence).
//
// IMPORTANT, and deliberately not hidden: this is a browser app, so this
// value ships in the JavaScript bundle and can be read by anyone who can
// load the app. It is a speed bump, NOT authentication. It's acceptable
// only because the endpoint it guards delays a charge rather than moving
// money — see requireCoachAuth() in the Worker for the full reasoning and
// what would need to change before trusting it with anything more.
//
// Must match the COACH_API_SECRET secret set on the Worker.
export const COACH_API_SECRET = 'REPLACE_ME';

// Leave the URL at its placeholder to disable every payments call cleanly
// (no failed requests, no error toasts) until the Worker is actually
// deployed — the app is fully usable without it.
export function paymentsConfigured(): boolean {
  return !PAYMENTS_WORKER_URL.includes('REPLACE_ME');
}

// "They weren't here and they don't get charged for it" — an excused
// absence slides the package's next subscription charge by one session's
// worth. Resolves to the days postponed, or null when nothing moved (not
// configured, not on a subscription, or the Worker failed — none of which
// should ever undo or error the attendance that triggered it).
export async function postponeBillingForExcuse(packageId: string): Promise<number | null> {
  if (!paymentsConfigured()) return null;
  try {
    const res = await fetch(`${PAYMENTS_WORKER_URL}/postpone-billing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Coach-Secret': COACH_API_SECRET },
      body: JSON.stringify({ packageId, sessions: 1 })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('postpone-billing failed', res.status, data);
      return null;
    }
    return data.postponedDays || null;
  } catch (err) {
    console.error('postpone-billing request failed', err);
    return null;
  }
}
