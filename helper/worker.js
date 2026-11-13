// Concert Radar helper: a Cloudflare Worker that keeps your Ticketmaster key out of the app
// and reads the show calendars of venues that don't sell through Ticketmaster.
//
// What it does
//   GET /events?...      Passes a Ticketmaster event search through, adding your key. Only event searches are allowed.
//   GET /venue?id=...    Reads one venue's calendar (from the list below) and returns its shows.
//   GET/POST /favorites  Your Favorites list, so phone and computer share it.
//   GET/POST /hidden     Shows you've hidden and artists you're not interested in.
//   GET/POST /going      Shows you have tickets for (past ones become "Seen live").
//   GET /ics?...         A calendar file for one show, so "Add to calendar" opens your phone's calendar.
//   GET/POST /history    Play counts per artist from your Spotify listening-history file.
//   GET /health          Quick check that the key and storage are set up.
//
// Your Spotify listening never comes here; the app matches shows to your artists on your own device.
//
// Setup (Cloudflare dashboard)
//   1. Workers & Pages → Create → Worker → name it concert-radar → Deploy → Edit code → paste this file → Deploy.
//   2. Settings → Variables and Secrets → add a Secret named TICKETMASTER_KEY (your Ticketmaster Consumer Key).
//   Storage (Favorites, history) is the KV namespace bound as CR; wrangler.toml creates it on deploy.
//   Deploys run automatically from GitHub (Settings → Builds). The secret stays.

const APP_ORIGINS = ['https://titusmith.github.io'];
const TM = 'https://app.ticketmaster.com/discovery/v2/events.json';
// The only search settings the app may pass along.
const ALLOWED = ['classificationName', 'countryCode', 'geoPoint', 'radius', 'unit', 'startDateTime', 'endDateTime', 'size', 'page', 'sort', 'keyword'];

// Venues whose calendars the helper reads. Only these addresses can be fetched.
// kind = which kind of website it is (each kind has its own reader below).
const VENUES = {
  bottleneck: { name: 'The Bottleneck', city: 'Lawrence', kind: 'tribe', url: 'https://thebottlenecklive.com' },
  granada:    { name: 'The Granada', city: 'Lawrence', kind: 'tribe', url: 'https://thegranada.com' },
  midland:    { name: 'The Midland', city: 'Kansas City', kind: 'aeg', url: 'https://www.midlandkc.com/events/all' },
  truman:     { name: 'The Truman', city: 'Kansas City', kind: 'aeg', url: 'https://www.thetrumankc.com/events/all' },
  recordbar:  { name: 'recordBar', city: 'Kansas City', kind: 'recordbar', url: 'https://www.therecordbar.com/shows' },
  wob:        { name: 'Warehouse on Broadway', city: 'Kansas City', kind: 'wob', url: 'https://www.warehouseonbroadway.com/events' },
  cotillion:  { name: 'The Cotillion', city: 'Wichita', kind: 'rhp', url: 'https://thecotillion.com/events/' },
  // LAAND (Lawrence All-Ages Noise Destination) books shows at several rooms (White Schoolhouse, Liberty Hall…).
  laand:      { name: 'LAAND', city: 'Lawrence', kind: 'squarespace', url: 'https://www.laand.org/shows' }
};

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': APP_ORIGINS.includes(origin) ? origin : APP_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    // Only the app may use this helper (keeps your Ticketmaster quota yours).
    if (origin && !APP_ORIGINS.includes(origin)) return json({ error: 'not_allowed' }, 403, cors);
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      // storageSince: when this storage was first used. If it ever changes, saved Favorites were lost.
      let storageSince = null;
      if (env.CR) { storageSince = await env.CR.get('since'); if (!storageSince) { storageSince = new Date().toISOString(); await env.CR.put('since', storageSince); } }
      return json({ ok: true, ticketmasterKey: !!env.TICKETMASTER_KEY, storage: !!env.CR, storageSince, venues: Object.keys(VENUES) }, 200, cors);
    }

    // Small saved things: your Favorites, shows and artists you've hidden, and your listening-history summary.
    if (url.pathname === '/ics' && req.method === 'GET') return ics(url);

    if (url.pathname === '/favorites' || url.pathname === '/history' || url.pathname === '/hidden' || url.pathname === '/going') {
      if (!env.CR) return json({ error: 'no_storage', message: 'The helper has no storage yet.' }, 500, cors);
      const key = url.pathname.slice(1);
      if (req.method === 'GET') {
        const v = await env.CR.get(key, 'json');
        return json(v || (key === 'favorites' ? { artists: [], updatedAt: null } : key === 'hidden' ? { shows: {}, artists: {}, updatedAt: null } : key === 'going' ? { shows: {}, updatedAt: null } : { artists: {}, updatedAt: null }), 200, cors);
      }
      if (req.method === 'POST') {
        // Only from the app itself (a browser always sends Origin on POST).
        if (!APP_ORIGINS.includes(origin)) return json({ error: 'not_allowed' }, 403, cors);
        const body = await req.text();
        if (body.length > (key === 'history' ? 5000000 : 300000)) return json({ error: 'too_big' }, 413, cors);
        let data;
        try { data = JSON.parse(body); } catch { return json({ error: 'bad_json' }, 400, cors); }
        if (key === 'favorites') {
          if (!Array.isArray(data.artists)) return json({ error: 'bad_list' }, 400, cors);
          data = { artists: data.artists.slice(0, 1000).map((a) => ({ name: String(a.name || '').slice(0, 120), id: a.id ? String(a.id).slice(0, 40) : undefined })).filter((a) => a.name), updatedAt: new Date().toISOString() };
        } else if (key === 'going') {
          const str = (v, n) => (v == null ? '' : String(v).slice(0, n));
          const shows = {};
          for (const [id, e] of Object.entries(data.shows && typeof data.shows === 'object' ? data.shows : {}).slice(-2000)) {
            if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) continue;
            shows[str(id, 200)] = {
              id: str(id, 200), name: str(e.name, 200), date: e.date, time: str(e.time, 5), venue: str(e.venue, 120), city: str(e.city, 80),
              state: str(e.state, 4), url: str(e.url, 500), artists: (Array.isArray(e.artists) ? e.artists : []).slice(0, 12).map((a) => str(a, 120)),
              keys: (Array.isArray(e.keys) ? e.keys : []).slice(0, 12).map((a) => str(a, 120)), added: str(e.added, 30)
            };
          }
          data = { shows, updatedAt: new Date().toISOString() };
        } else if (key === 'hidden') {
          const obj = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
          const trim = (o) => Object.fromEntries(Object.entries(obj(o)).slice(-3000).map(([k, v]) => [String(k).slice(0, 200), typeof v === 'string' ? v.slice(0, 200) : true]));
          data = { shows: trim(data.shows), artists: trim(data.artists), updatedAt: new Date().toISOString() };
        } else {
          if (!data.artists || typeof data.artists !== 'object') return json({ error: 'bad_history' }, 400, cors);
          data = { artists: data.artists, from: data.from || null, to: data.to || null, updatedAt: new Date().toISOString() };
        }
        await env.CR.put(key, JSON.stringify(data));
        return json(key !== 'history' ? data : { ok: true, updatedAt: data.updatedAt, count: Object.keys(data.artists).length }, 200, cors);
      }
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

    if (url.pathname === '/venue' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      const v = VENUES[id];
      if (!v) return json({ error: 'unknown_venue' }, 404, cors);
      // Cloudflare's cache keeps each venue's answer for 6 hours, so phone and computer share one read.
      const cache = caches.default;
      const key = new Request('https://concert-radar.cache/venue/' + id + '/v1');
      const hit = await cache.match(key);
      if (hit) return new Response(hit.body, { headers: { ...cors, 'Content-Type': 'application/json', 'X-Cache': 'hit' } });
      try {
        const events = await readVenue(v);
        const body = JSON.stringify({ id, name: v.name, city: v.city, events });
        if (events.length) ctx.waitUntil(cache.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=21600' } })));
        return new Response(body, { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return json({ error: 'venue_unreadable', message: `Couldn’t read ${v.name}’s calendar (${e.message}).` }, 502, cors);
      }
    }
    return json({ error: 'not_found' }, 404, cors);
  }
};

// One show as a calendar file. Times are local to the venue (Central), written without a time zone so the
// calendar takes them as-is. No time listed: an all-day event.
function ics(url) {
  const q = (k, n) => (url.searchParams.get(k) || '').slice(0, n);
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/([,;])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const d = q('d', 10), h = q('h', 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Response('bad date', { status: 400 });
  const ymd = d.replace(/-/g, '');
  let when;
  if (/^\d{2}:\d{2}$/.test(h)) {
    const start = new Date(`${d}T${h}:00Z`), end = new Date(start.getTime() + 3 * 3600000);
    const f = (t) => t.toISOString().slice(0, 16).replace(/[-:]/g, '') + '00';
    when = [`DTSTART:${f(start)}`, `DTEND:${f(end)}`];
  } else {
    const next = new Date(`${d}T00:00:00Z`); next.setUTCDate(next.getUTCDate() + 1);
    when = [`DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${next.toISOString().slice(0, 10).replace(/-/g, '')}`];
  }
  const body = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Concert Radar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${ymd}-${crypto.randomUUID()}@concert-radar`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    ...when,
    `SUMMARY:${esc(q('t', 200) || 'Concert')}`,
    q('loc', 200) ? `LOCATION:${esc(q('loc', 200))}` : '',
    q('u', 500) ? `URL:${q('u', 500).replace(/[\r\n]/g, '')}` : '',
    q('u', 500) ? `DESCRIPTION:${esc('Tickets: ' + q('u', 500))}` : '',
    'END:VEVENT', 'END:VCALENDAR', ''
  ].filter((l) => l !== '').join('\r\n') + '\r\n';
  return new Response(body, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="concert-${ymd}.ics"`, 'Cache-Control': 'no-store' } });
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

// ---------- reading venue calendars ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
async function get(url, type) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : 'text/html' } });
  if (!r.ok) throw new Error('status ' + r.status);
  return type === 'json' ? r.json() : r.text();
}

async function readVenue(v) {
  if (v.kind === 'tribe') {
    const today = new Date().toISOString().slice(0, 10);
    const out = [];
    for (let page = 1; page <= 4; page++) {
      const d = await get(`${v.url}/wp-json/tribe/events/v1/events?per_page=50&page=${page}&start_date=${today}`, 'json');
      out.push(...parseTribe(d.events || []));
      if (!d.next_rest_url) break;
    }
    return out;
  }
  if (v.kind === 'squarespace') return parseSquarespace(await get(v.url + '?format=json', 'json'), v.url);
  const html = await get(v.url, 'html');
  if (v.kind === 'aeg') return parseAeg(html);
  if (v.kind === 'recordbar') return parseRecordbar(html, v.url);
  if (v.kind === 'wob') return parseWob(html, v.url);
  if (v.kind === 'rhp') return parseRhp(html);
  return [];
}

// --- text helpers (no DOM in Workers, so these are small and forgiving) ---
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
function decode(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const text = (s) => decode(String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim();
const one = (s, re) => { const m = re.exec(s); return m ? m[1] : ''; };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');

// "Nov 12, 2026" / "November 23, 2026" / "Dec 11" (no year: the next one from today)
function parseDate(s) {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/.exec(s || '');
  if (!m) return '';
  const mo = MONTHS[m[1].toLowerCase().slice(0, m[1].length >= 4 && m[1].toLowerCase().startsWith('sept') ? 4 : 3)];
  if (!mo) return '';
  const d = +m[2];
  let y = m[3] ? +m[3] : null;
  if (!y) {
    const now = new Date(Date.now() - 6 * 3600000); // Central time, roughly
    y = now.getUTCFullYear();
    const candidate = Date.UTC(y, mo - 1, d);
    if (candidate < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 3 * 86400000) y++;
  }
  return `${y}-${pad(mo)}-${pad(d)}`;
}
// "8:00 PM" → "20:00"
function parseTime(s) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(s || '');
  if (!m) return '';
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  return `${pad(h)}:${m[2] || '00'}`;
}
// Strip the bits around a band's name that aren't the band.
function cleanTitle(t) {
  return decode(t)
    .replace(/\*?\s*(sold out|cancelled|canceled|postponed|rescheduled|moved to [^*]+)\s*\*?\s*[:\-–]?/gi, '')
    .replace(/^.*?\bpresents?\s*:\s*/i, '')
    .replace(/^.*?\bpresents?\s+/i, (m) => (m.length < 60 ? '' : m))
    .replace(/\s+/g, ' ')
    .trim();
}
// "Katie Pruitt – Fools for the Fleeting Tour" → "Katie Pruitt"
const headliner = (t) => cleanTitle(t).split(/\s+[–—-]\s+|\s*:\s+(?=.*\btour\b)/i)[0].trim();
// "with Sausha" / "With Golf on Television and students from…" → ["Sausha"]
function supportList(s) {
  const line = (s || '').split('\n').map((x) => x.trim()).find((x) => /^(with|w\/)\s/i.test(x)) || '';
  if (!line) return [];
  return line.replace(/^(with|w\/)\s+/i, '').replace(/^(very )?special guests?:?\s+/i, '').split(/\s*,\s*|\s+(?:&|and)\s+(?=[A-Z])/).map((x) => x.trim()).filter((x) => x && x.length < 60).slice(0, 6);
}
const status = (t) => /sold out/i.test(t) ? 'soldout' : /postponed/i.test(t) ? 'postponed' : /cancel/i.test(t) ? 'cancelled' : '';

function parseTribe(list) {
  return list.map((e) => {
    const title = decode(e.title);
    const desc = text(e.description);
    return {
      id: 'tribe-' + e.id,
      name: cleanTitle(title),
      artists: [headliner(title), ...supportList(desc)].filter(Boolean),
      date: (e.start_date || '').slice(0, 10),
      time: e.all_day ? parseTime(one(desc, /show(?:\s+at)?\s+(\d{1,2}(?::\d{2})?\s*[ap]\.?m)/i)) : (e.start_date || '').slice(11, 16),
      url: e.website || e.url,
      status: status(title)
    };
  }).filter((e) => e.date && e.status !== 'cancelled');
}

function parseAeg(html) {
  return html.split(/<div class="entry[\s"]/).slice(1).map((b) => {
    const id = one(b, /events\/detail\/(\d+)/);
    const head = text(one(b, /<h3[^>]*>([\s\S]*?)<\/h3>/));
    const sup = text(one(b, /<h4[^>]*>([\s\S]*?)<\/h4>/));
    const date = parseDate(text(one(b, /<span class="date">[\s\S]*?<\/span>([^<]*)<\/span>/)));
    const time = parseTime(text(one(b, /<span class="time">[\s\S]*?<\/span>([^<]*)<\/span>/)));
    const tix = one(b, /href="(https:\/\/www\.axs\.com\/events\/[^"]+)"/);
    return {
      id: 'aeg-' + id,
      name: head,
      artists: [head, ...supportList(/^with\s/i.test(sup) ? sup : sup ? 'with ' + sup : '')].filter(Boolean),
      date, time,
      url: decode(tix) || one(b, /href="([^"]*events\/detail\/\d+)"/),
      status: /sold.?out/i.test(b) ? 'soldout' : ''
    };
  }).filter((e) => e.date && e.name);
}

function parseRecordbar(html, base) {
  const origin = new URL(base).origin;
  return html.split('w-dyn-item').slice(1).map((b) => {
    const href = one(b, /href="(\/shows\/[^"]+)"/);
    const name = text(one(b, /<h2[^>]*class="name"[^>]*>([\s\S]*?)<\/h2>/));
    const mon = text(one(b, /class="event-month"[^>]*>([\s\S]*?)<\/div>/));
    const day = text(one(b, /class="event-day"[^>]*>([\s\S]*?)<\/div>/));
    const tm = text(one(b, /class="event-time[^"]*"[^>]*>([\s\S]*?)<\/div>/));
    const title = cleanTitle(name);
    const parts = title.split(/\s+featuring\s+|\s*,\s*|\s+w\/\s+/i).map((x) => x.trim()).filter(Boolean);
    return {
      id: 'rb-' + href.split('/').pop(),
      name: title,
      artists: parts.slice(0, 8),
      date: parseDate(`${mon} ${day}`),
      time: parseTime(tm),
      url: href ? origin + href : base,
      status: /alt="Sold out"[^>]*class="event-tag"/.test(b) ? 'soldout' : ''
    };
  }).filter((e) => e.name && e.date);
}

function parseWob(html, base) {
  const origin = new URL(base).origin;
  return html.split(/class="event-item w-dyn-item/).slice(1).map((b) => {
    const names = [...b.matchAll(/<h3 class="event-name([^"]*)"[^>]*>([\s\S]*?)<\/h3>/g)];
    const main = names.find((m) => !/presenter/.test(m[1])) || names[0];
    const name = main ? cleanTitle(text(main[2])) : '';
    const when = text(one(b, /class="event-date"[^>]*>([\s\S]*?)<\/div>/));
    const href = one(b, /href="(\/events\/[^"]+)"/);
    const tix = one(b, /href="(https:\/\/www\.etix\.com\/[^"]+)"/);
    return {
      id: 'wob-' + href.split('/').pop(),
      name,
      artists: name.split(/\s*\/\s*|\s*,\s*|\s+w\/\s+/).map((x) => x.trim()).filter(Boolean).slice(0, 8),
      date: parseDate(when),
      time: parseTime(when),
      url: decode(tix) || (href ? origin + href : base),
      status: ''
    };
  }).filter((e) => e.name && e.date);
}

// Squarespace event pages (?format=json). Titles look like "Porcelain at White Schoolhouse";
// the openers are in the write-up ("Support from ZASTAVA (Detroit) and NIGHTOSPHERE (KCMO).").
const TICKET_HOSTS = /(eventbrite|ticketmaster|etix|dice\.fm|axs|tixr|seetickets|ticketweb|prekindle|holdmyticket|freshtix|showclix|ticketsauce|universe)\./i;
function centralParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
function parseSquarespace(d, base) {
  const origin = new URL(base).origin;
  return (d.upcoming || d.items || []).map((i) => {
    const title = decode(i.title || '');
    const venue = decode((i.location && i.location.addressTitle) || '');
    const head = cleanTitle(title.replace(/\s+(?:at|@)\s+(?:the\s+)?[^,]+$/i, (m) => (venue && m.toLowerCase().includes(venue.toLowerCase().replace(/^the /, '').split(' ')[0]) ? '' : m)));
    const body = text(i.body || '').replace(/#block-[\s\S]*$/, '');
    const sup = one(body, /(?:with support from|support from|supported by|with special guests?|with)\s+([^.]+?)(?:\.|\n|$)/i)
      .replace(/\([^)]*\)/g, '')
      .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i).map((x) => x.trim()).filter((x) => x && x.length < 50 && !/^(former|tickets?|doors)/i.test(x)).slice(0, 6);
    const tix = [...String(i.body || '').matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1])).find((h) => TICKET_HOSTS.test(h));
    const when = i.startDate ? centralParts(i.startDate) : { date: '', time: '' };
    return {
      id: 'sq-' + (i.id || i.urlId || i.fullUrl),
      name: head,
      artists: [head, ...sup].filter(Boolean),
      date: when.date,
      time: when.time,
      venue,
      city: decode((i.location && i.location.addressLine2) || '').split(',')[0].trim(),
      url: tix || (i.fullUrl ? origin + i.fullUrl : base),
      status: status(title)
    };
  }).filter((e) => e.name && e.date && e.status !== 'cancelled');
}

// RHP Events (Rockhouse/eTix's WordPress calendar), used by many eTix venues.
function parseRhp(html) {
  return html.split(/class\s*=\s*"col-12 eventWrapper/).slice(1).map((b) => {
    const href = one(b, /href="(https?:\/\/[^"]+\/event\/[^"]+)"/);
    const title = decode(one(b, /class="url"[^>]*title="([^"]+)"/) || one(b, /<h2[^>]*>([\s\S]*?)<\/h2>/));
    const when = text(one(b, /id="eventDate"[^>]*>([\s\S]*?)<\/div>/));
    const sup = text(one(b, /class="[^"]*eventSubHeader[^"]*"[^>]*>([\s\S]*?)<\/div>|class="[^"]*rhp-event__opening-act[^"]*"[^>]*>([\s\S]*?)<\/div>/));
    const tm = text(one(b, /class="[^"]*rhp-event__time-text[^"]*"[^>]*>([\s\S]*?)<\//) || one(b, /(?:Show|Doors)[^<]{0,12}(\d{1,2}(?::\d{2})?\s*[ap]m)/i));
    const tix = one(b, /href="(https:\/\/www\.etix\.com\/[^"]+)"/);
    const name = cleanTitle(text(title));
    return {
      id: 'rhp-' + (href.split('/event/')[1] || name).split('/')[0],
      name,
      artists: [headliner(name), ...name.split(/\s+x\s+|\s*,\s*|\s+&\s+/i).slice(1), ...supportList(sup ? (/^with/i.test(sup) ? sup : 'with ' + sup) : '')].map((x) => x.trim()).filter(Boolean).slice(0, 8),
      date: parseDate(when),
      time: parseTime(tm),
      url: decode(tix) || href,
      status: status(title)
    };
  }).filter((e) => e.name && e.date && e.status !== 'cancelled');
}

