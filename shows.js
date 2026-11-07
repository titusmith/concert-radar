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

    const events = [...byId.values()].map((e) => ({ ...e, region: nearestRegion(e) })).filter((e) => e.region)
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    return { updatedAt: new Date().toISOString(), regions: REGIONS.map(({ id, name }) => ({ id, name })), partial, events };
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

  window.SHOWS = { REGIONS, scan };
})();
