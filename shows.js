// Finds upcoming music shows around your cities through the helper (which holds the Ticketmaster key).
// Runs once a day when you open the app; the list is saved on this device in between.
(function () {
  'use strict';

  // Your cities, in priority order. Radius is in miles from the center point.
  const REGIONS = [
    { id: 'lawrence', name: 'Lawrence', lat: 38.9717, lon: -95.2353, radius: 15 },
    { id: 'kc', name: 'Kansas City', lat: 39.0997, lon: -94.5786, radius: 30 },
    { id: 'topeka', name: 'Topeka', lat: 39.0473, lon: -95.6752, radius: 15 }
  ];
  // Venue calendars the helper reads (shows Ticketmaster doesn't sell). region 'drive' = worth-the-drive only.
  const VENUES = [
    { id: 'bottleneck', name: 'The Bottleneck', city: 'Lawrence', region: 'lawrence' },
    { id: 'granada', name: 'The Granada', city: 'Lawrence', region: 'lawrence' },
    { id: 'midland', name: 'The Midland', city: 'Kansas City', region: 'kc' },
    { id: 'truman', name: 'The Truman', city: 'Kansas City', region: 'kc' },
    { id: 'recordbar', name: 'recordBar', city: 'Kansas City', region: 'kc' },
    { id: 'wob', name: 'Warehouse on Broadway', city: 'Kansas City', region: 'kc' },
    { id: 'cotillion', name: 'The Cotillion', city: 'Wichita', region: 'drive', miles: 160, state: 'KS' },
    { id: 'laand', name: 'LAAND', city: 'Lawrence', region: 'lawrence' }
  ];
  const MONTHS_AHEAD = 12;
  const WINDOWS = 4;        // the year in 3-month chunks (Ticketmaster stops paging at 1,000 results per search)
  const MAX_CALLS = 60;     // well under Ticketmaster's free 5,000 a day

  // Ticketmaster lists parking, upgrades and packages as their own "events". These aren't shows.
  const NOT_A_SHOW = /\b(parking|park pass|lot pass|upgrade|vip package|vip experience|suites?|club access|premium seating|fast lane|early entry|meet ?(&|and) ?greet|merch|shuttle|camping|locker|gift card|voucher)\b/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isoNoMs = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  async function tm(helper, params) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r;
      try { r = await fetch(helper + '/events?' + new URLSearchParams(params)); }
      catch { throw new Error('Couldn’t reach the helper.'); }
      if (r.status === 429) { await sleep(1200); continue; }
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.message || (data.fault && data.fault.faultstring) || 'Ticketmaster returned ' + r.status);
      await sleep(220); // stay under 5 requests a second
      return data;
    }
    throw new Error('Ticketmaster is busy. Try again in a minute.');
  }

  // Returns { updatedAt, regions, partial, events }
  async function scan(helper, onProgress = () => {}) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const windows = [];
    for (let i = 0; i < WINDOWS; i++) {
      const a = new Date(start); a.setUTCMonth(a.getUTCMonth() + i * MONTHS_AHEAD / WINDOWS);
      const b = new Date(start); b.setUTCMonth(b.getUTCMonth() + (i + 1) * MONTHS_AHEAD / WINDOWS);
      windows.push([isoNoMs(a), isoNoMs(new Date(b.getTime() - 1000))]);
    }

    const byId = new Map();
    let calls = 0, partial = false, firstError = null;
    outer:
    for (const region of REGIONS) {
      onProgress('Checking ' + region.name);
      for (const [from, to] of windows) {
        for (let page = 0; page < 5; page++) {
          if (calls >= MAX_CALLS) { partial = true; break outer; }
          calls++;
          let data;
          try {
            data = await tm(helper, {
              classificationName: 'music', countryCode: 'US',
              geoPoint: geohash(region.lat, region.lon, 9), radius: String(region.radius), unit: 'miles',
              startDateTime: from, endDateTime: to, size: '200', page: String(page), sort: 'date,asc'
            });
          } catch (e) {
            if (/key|helper/i.test(e.message) && !byId.size) throw e; // setup problem: say so instead of an empty list
            firstError = firstError || e; partial = true; break;
          }
          for (const ev of (data._embedded && data._embedded.events) || []) {
            const s = slim(ev);
            if (s && !byId.has(s.id)) byId.set(s.id, s);
          }
          const p = data.page || {};
          if (p.number == null || p.number + 1 >= p.totalPages || (p.number + 1) * 200 >= 1000) break;
        }
      }
    }
    if (!byId.size && firstError) throw firstError;

    const tmEvents = [...byId.values()].map((e) => ({ ...e, source: 'tm', region: nearestRegion(e) })).filter((e) => e.region);

    // Venue calendars (shows sold on AXS, eTix and venues' own sites), read by the helper, all at once.
    onProgress('Checking venue calendars');
    const venueResults = await Promise.all(VENUES.map((v) => fetch(helper + '/venue?id=' + v.id)
      .then((r) => r.ok ? r.json() : r.json().then((d) => { throw new Error(d.message || r.status); }))
      .then((d) => ({ v, events: d.events || [] }))
      .catch((e) => ({ v, error: e.message || 'unreadable', events: [] }))));
    const venueEvents = [];
    const sources = {};
    for (const { v, events, error } of venueResults) {
      sources[v.id] = error ? { name: v.name, error } : { name: v.name, count: events.length };
      for (const e of events) {
        if (!e.date || NOT_A_SHOW.test(e.name)) continue;
        venueEvents.push({ ...e, id: v.id + ':' + e.id, source: v.id, venue: e.venue || v.name, city: e.city || v.city, region: v.region, miles: v.miles || null, state: v.state || '', lat: null, lon: null, onsale: null });
      }
    }
    if (Object.values(sources).some((s) => s.error)) partial = true;

    const events = mergeSources(tmEvents, venueEvents)
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    return { updatedAt: new Date().toISOString(), regions: REGIONS.map(({ id, name }) => ({ id, name })), partial, sources, events };
  }

  // The same night can show up from Ticketmaster and from the venue's own calendar. Keep one,
  // preferring Ticketmaster's (it lists every band on the bill).
  function mergeSources(primary, extra) {
    const byDate = new Map();
    const key = (e) => [e.name, ...(e.artists || [])].map(SPOT.norm).filter((s) => s.length > 2);
    for (const e of primary) { const l = byDate.get(e.date) || []; l.push({ e, k: key(e) }); byDate.set(e.date, l); }
    const out = [...primary];
    for (const e of extra) {
      const same = (byDate.get(e.date) || []).some((p) => {
        if (p.e.region !== e.region) return false;
        const k = key(e);
        return k.some((a) => p.k.some((b) => a === b || (a.length > 5 && b.includes(a)) || (b.length > 5 && a.includes(b))));
      });
      if (!same) { out.push(e); const l = byDate.get(e.date) || []; l.push({ e, k: key(e) }); byDate.set(e.date, l); }
    }
    return out;
  }

  // ---------- road trips ----------
  // For your strongest artists, look up their shows within DRIVE_MILES of Lawrence that aren't in your cities.
  const HOME = REGIONS[0];
  const DRIVE_MILES = 300;
  const DRIVE_MAX_ARTISTS = 60;

  async function driveScan(helper, artistNames, onProgress = () => {}) {
    const now = isoNoMs(new Date());
    const found = [];
    let done = 0, errors = 0;
    for (const name of artistNames.slice(0, DRIVE_MAX_ARTISTS)) {
      onProgress(`Checking road trips ${++done} of ${Math.min(artistNames.length, DRIVE_MAX_ARTISTS)}`);
      let data;
      try {
        data = await tm(helper, {
          keyword: name, classificationName: 'music', countryCode: 'US',
          geoPoint: geohash(HOME.lat, HOME.lon, 9), radius: String(DRIVE_MILES), unit: 'miles',
          startDateTime: now, size: '30', sort: 'date,asc'
        });
      } catch { if (++errors > 5) break; continue; }
      const want = SPOT.norm(name);
      for (const ev of (data._embedded && data._embedded.events) || []) {
        const s = slim(ev);
        if (!s || !s.artists.some((a) => SPOT.norm(a) === want)) continue;
        if (s.lat != null && nearestRegion(s)) continue; // in your cities: it's in the main list
        s.miles = s.lat != null ? Math.round(miles(HOME.lat, HOME.lon, s.lat, s.lon)) : null;
        s.state = (ev._embedded.venues[0].state && ev._embedded.venues[0].state.stateCode) || '';
        s.source = 'tm';
        found.push(s);
      }
    }
    return { updatedAt: new Date().toISOString(), events: found };
  }

  // Keep only what the app shows.
  function slim(ev) {
    if (!ev || !ev.id || NOT_A_SHOW.test(ev.name || '')) return null;
    const v = (ev._embedded && ev._embedded.venues && ev._embedded.venues[0]) || {};
    const lat = Number(v.location && v.location.latitude), lon = Number(v.location && v.location.longitude);
    const start = (ev.dates && ev.dates.start) || {};
    if (!start.localDate) return null;
    const status = (ev.dates && ev.dates.status && ev.dates.status.code) || '';
    if (status === 'cancelled') return null;
    const onsale = ev.sales && ev.sales.public && ev.sales.public.startDateTime;
    return {
      id: ev.id,
      name: ev.name || '',
      url: ev.url || '',
      date: start.localDate,
      time: start.timeTBA || start.noSpecificTime ? '' : (start.localTime || '').slice(0, 5),
      venue: v.name || '',
      city: (v.city && v.city.name) || '',
      lat: isFinite(lat) && v.location ? lat : null,
      lon: isFinite(lon) && v.location ? lon : null,
      artists: ((ev._embedded && ev._embedded.attractions) || []).map((a) => a.name).filter(Boolean).slice(0, 12),
      status,
      onsale: onsale && Date.parse(onsale) > Date.now() ? onsale : null
    };
  }

  function nearestRegion(e) {
    if (e.lat == null) {
      const c = (e.city || '').toLowerCase();
      const r = REGIONS.find((r) => c.includes(r.name.toLowerCase().split(' ')[0]));
      return r ? r.id : null;
    }
    let best = null;
    for (const r of REGIONS) {
      const d = miles(e.lat, e.lon, r.lat, r.lon);
      if (d <= r.radius + 3 && (!best || d < best.d)) best = { id: r.id, d };
    }
    return best && best.id;
  }

  function miles(a, b, c, d) {
    const R = 3958.8, toR = (x) => x * Math.PI / 180;
    const h = Math.sin(toR(c - a) / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(toR(d - b) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function geohash(lat, lon, precision) {
    const chars = '0123456789bcdefghjkmnpqrstuvwxyz';
    const latR = [-90, 90], lonR = [-180, 180];
    let hash = '', bit = 0, ch = 0, even = true;
    while (hash.length < precision) {
      const r = even ? lonR : latR, v = even ? lon : lat, mid = (r[0] + r[1]) / 2;
      if (v >= mid) { ch = (ch << 1) | 1; r[0] = mid; } else { ch = ch << 1; r[1] = mid; }
      even = !even;
      if (++bit === 5) { hash += chars[ch]; bit = 0; ch = 0; }
    }
    return hash;
  }

  window.SHOWS = { REGIONS, VENUES, scan, driveScan };
})();
