// Plate reader: a Cloudflare Worker that looks at stills from a lift and reads the weight on the bar with a vision
// model. The coach app posts { test, claimedLb, images: [data URLs] } and gets back { totalLb, confidence, notes }.
//
// Deploy:
//   cd workers/plate-reader
//   npx wrangler secret put ANTHROPIC_API_KEY
//   npx wrangler deploy
// Then set the worker's address in the database, so the coach app starts using it with no update:
//   Firestore > config > ai  (create the document)  field plateReaderUrl = "https://<your-worker>.workers.dev"

const MODEL = 'claude-opus-5-5';

const PROMPT = `You are reading the weight on a barbell from photos of a lift.
Look at both ends of the bar in the photos. Identify each plate: its colour, its size, and any weight printed or stamped on it (for example "45 LB", "25", "20 KG"). Count the plates on each side, including plates stacked behind others when the stack's thickness shows they are there.
Convert kilograms to pounds (1 kg = 2.2046 lb). Assume a 45 lb (20 kg) bar unless the photos show otherwise. Collars add nothing.
If the plates cannot be read (too far, too blurry, hidden, unmarked colours you cannot map to a weight), say so and use low confidence: do not guess a total.
Reply with JSON only, no other text:
{"leftLb": [numbers], "rightLb": [numbers], "barLb": number, "totalLb": number or null, "confidence": "low" | "medium" | "high", "notes": "one or two short sentences saying what you saw"}
Use "high" only when the plate weights are printed and legible or the colours are unambiguous and the counts on both sides agree.`;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });
    let body;
    try { body = await request.json(); } catch { return new Response('Bad request', { status: 400, headers: cors }); }
    const images = (body.images || []).slice(0, 4).filter(x => typeof x === 'string' && x.startsWith('data:image/jpeg;base64,'));
    if (!images.length) return new Response('No images', { status: 400, headers: cors });

    const content = images.map(d => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d.split(',')[1] } }));
    content.push({ type: 'text', text: `${PROMPT}\nThe lift is a ${String(body.test || 'barbell lift')}.` });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content }] })
    });
    if (!res.ok) return new Response(JSON.stringify({ totalLb: null, confidence: 'low', notes: 'The reader was unavailable.' }), { headers: { ...cors, 'content-type': 'application/json' } });
    const out = await res.json();
    const text = (out.content || []).map(c => c.text || '').join('');
    let j = { totalLb: null, confidence: 'low', notes: 'The reader gave no answer.' };
    try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { /* keep the default */ }
    return new Response(JSON.stringify({ totalLb: j.totalLb ?? null, confidence: j.confidence ?? 'low', notes: j.notes ?? '' }), { headers: { ...cors, 'content-type': 'application/json' } });
  }
};
