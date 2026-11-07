// Concert Radar helper: a Cloudflare Worker that keeps your Ticketmaster key out of the app.
//
// What it does
//   GET /events?...   Passes a Ticketmaster event search through, adding your key. Only event searches are allowed.
//   GET /health       Quick check that the key is set up.
//
// It passes Ticketmaster's answer straight back without reading it, so it stays well inside the free plan.
// Your Spotify listening never comes here; the app matches shows to your artists on your own device.
//
// Setup (Cloudflare dashboard)
//   1. Workers & Pages → Create → Worker → name it concert-radar → Deploy → Edit code → paste this file → Deploy.
//   2. Settings → Variables and Secrets → add a Secret named TICKETMASTER_KEY (your Ticketmaster Consumer Key).

const APP_ORIGINS = ['https://titusmith.github.io'];
const TM = 'https://app.ticketmaster.com/discovery/v2/events.json';
// The only search settings the app may pass along.
const ALLOWED = ['classificationName', 'countryCode', 'geoPoint', 'radius', 'unit', 'startDateTime', 'endDateTime', 'size', 'page', 'sort', 'keyword'];

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Only the app may use this helper (keeps your Ticketmaster quota yours).
    if (origin && !APP_ORIGINS.includes(origin)) return json({ error: 'not_allowed' }, 403, cors);
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, ticketmasterKey: !!env.TICKETMASTER_KEY }, 200, cors);
    }
    if (url.pathname === '/events' && req.method === 'GET') {
      if (!env.TICKETMASTER_KEY) return json({ error: 'no_ticketmaster_key', message: 'Add your Ticketmaster Consumer Key as the secret TICKETMASTER_KEY.' }, 500, cors);
      const q = new URLSearchParams();
      for (const k of ALLOWED) { const v = url.searchParams.get(k); if (v != null) q.set(k, v.slice(0, 120)); }
      q.set('apikey', env.TICKETMASTER_KEY);
      let r;
      try { r = await fetch(TM + '?' + q, { headers: { Accept: 'application/json' } }); }
      catch { return json({ error: 'ticketmaster_unreachable', message: 'Couldn’t reach Ticketmaster.' }, 502, cors); }
      if (r.status === 401) return json({ error: 'bad_ticketmaster_key', message: 'Ticketmaster didn’t accept the key. Check TICKETMASTER_KEY.' }, 502, cors);
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return json({ error: 'not_found' }, 404, cors);
  }
};

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}
