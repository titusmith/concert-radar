// Spotify for Concert Radar: sign-in (Authorization Code with PKCE, no secret) and
// gathering every artist you've shown any interest in. Read-only.
// Endpoints used are the ones still open to Development Mode apps after Spotify's February 2026 changes.
(function () {
  'use strict';
  const API = 'https://api.spotify.com/v1';
  const AUTH = 'https://accounts.spotify.com/authorize';
  const TOKEN = 'https://accounts.spotify.com/api/token';
  const SCOPES = 'user-top-read user-follow-read user-library-read user-read-recently-played';
  const K = { client: 'cr.spotify.clientId', tok: 'cr.spotify.tokens', pkce: 'cr.spotify.pkce', artists: 'cr.artists' };
  const SETLIST_BUDDY_CLIENT = 'sc.spotify.clientId'; // same site, so Setlist Buddy's Client ID is readable here
  const MAX_LIKED = 10000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} }
  };

  class SpotifyError extends Error { constructor(code, message) { super(message); this.code = code; } }

  const base = () => new URL('./', location.origin + location.pathname).href;
  const redirectUri = () => base() + 'callback.html';
  const clientId = () => ls.get(K.client) || ls.get(SETLIST_BUDDY_CLIENT) || '';
  const setClientId = (id) => ls.set(K.client, id.trim());

  // ---------- PKCE ----------
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const randomString = (n = 64) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); };
  const challenge = async (v) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));

  async function login() {
    const id = clientId();
    if (!id) throw new SpotifyError('no_client', 'Add your Spotify Client ID first.');
    const verifier = randomString();
    const state = randomString(16);
    ls.set(K.pkce, { verifier, state, at: Date.now() });
    const url = new URL(AUTH);
    url.search = new URLSearchParams({
      client_id: id, response_type: 'code', redirect_uri: redirectUri(),
      code_challenge_method: 'S256', code_challenge: await challenge(verifier),
      scope: SCOPES, state
    });
    location.assign(url.href);
  }

  async function tokenRequest(params) {
    let res;
    try {
      res = await fetch(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    } catch { throw new SpotifyError('offline', 'No connection to Spotify right now.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new SpotifyError(data.error || 'token', data.error_description || data.error || `Spotify sign-in failed (${res.status})`);
    return data;
  }

  function saveTokens(t) {
    const old = ls.get(K.tok) || {};
    ls.set(K.tok, {
      access: t.access_token,
      refresh: t.refresh_token || old.refresh,
      expiresAt: Date.now() + ((t.expires_in || 3600) - 60) * 1000
    });
  }

  async function finishLogin(search) {
    const p = new URLSearchParams(search);
    const saved = ls.get(K.pkce);
    ls.del(K.pkce);
    if (p.get('error')) throw new SpotifyError(p.get('error'), p.get('error') === 'access_denied' ? 'You cancelled the Spotify sign-in.' : 'Spotify sign-in failed: ' + p.get('error'));
    if (!saved || saved.state !== p.get('state')) throw new SpotifyError('state', 'That sign-in link expired. Tap Connect Spotify again.');
    const tok = await tokenRequest({
      grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(),
      client_id: clientId(), code_verifier: saved.verifier
    });
    saveTokens(tok);
    ls.del(K.artists); // new sign-in: gather artists fresh
  }

  let refreshing = null;
  async function getToken(force) {
    const t = ls.get(K.tok);
    if (!t || (!t.access && !t.refresh)) throw new SpotifyError('not_connected', 'Connect Spotify first.');
    if (!force && t.access && Date.now() < t.expiresAt) return t.access;
    if (!t.refresh) { ls.del(K.tok); throw new SpotifyError('not_connected', 'Connect Spotify again.'); }
    refreshing = refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId() })
      .then((tok) => { saveTokens(tok); return tok.access_token; })
      .catch((e) => { if (e.code !== 'offline') ls.del(K.tok); throw e.code === 'offline' ? e : new SpotifyError('not_connected', 'Your Spotify sign-in expired. Connect again.'); })
      .finally(() => { refreshing = null; });
    return refreshing;
  }
  const isConnected = () => { const t = ls.get(K.tok); return !!(t && (t.access || t.refresh)); };
  const disconnect = () => { ls.del(K.tok); ls.del(K.artists); };

  async function api(path) {
    let retried401 = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const token = await getToken();
      let res;
      try {
        res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
      } catch { throw new SpotifyError('offline', 'No connection to Spotify right now.'); }
      if (res.status === 429) { await sleep(Math.min(30, Number(res.headers.get('Retry-After')) || 2) * 1000); continue; }
      if (res.status === 401 && !retried401) { retried401 = true; await getToken(true); continue; }
      if (!res.ok) {
        let msg = '';
        try { msg = (await res.json()).error?.message || ''; } catch {}
        if (res.status === 403) throw new SpotifyError('forbidden', 'Spotify said no. Reconnect Spotify (this app asks for new permissions), and make sure your account is listed under User Management in the Spotify developer dashboard' + (msg ? ` (${msg})` : '') + '.');
        throw new SpotifyError('api', `Spotify returned ${res.status}${msg ? ': ' + msg : ''}`);
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    throw new SpotifyError('rate', 'Spotify is rate-limiting. Try again in a minute.');
  }

  // ---------- artists ----------
  // Names are matched loosely: case, accents, "&" vs "and", a leading "The" and punctuation don't matter.
  const norm = (s) => (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the /, '');

  // Returns { at, artists: { normName: { name, top, rotation, follow, liked, recent } } }
  async function gatherArtists(onProgress = () => {}) {
    const map = {};
    const add = (a, field, n = 1) => {
      if (!a || !a.name) return;
      const k = norm(a.name);
      if (!k) return;
      const r = map[k] || (map[k] = { name: a.name, top: false, rotation: false, follow: false, liked: 0, recent: 0 });
      if (field === 'liked' || field === 'recent') r[field] += n; else r[field] = true;
    };

    onProgress('Your top artists');
    for (const range of ['short_term', 'medium_term', 'long_term']) {
      const d = await api(`/me/top/artists?time_range=${range}&limit=50`);
      (d?.items || []).forEach((a) => add(a, 'top'));
      const t = await api(`/me/top/tracks?time_range=${range}&limit=50`);
      (t?.items || []).forEach((tr) => (tr.artists || []).forEach((a) => add(a, 'rotation')));
    }

    onProgress('Artists you follow');
    let after = '';
    for (let i = 0; i < 40; i++) {
      const d = await api(`/me/following?type=artist&limit=50${after ? '&after=' + encodeURIComponent(after) : ''}`);
      const block = d?.artists;
      (block?.items || []).forEach((a) => add(a, 'follow'));
      after = block?.cursors?.after;
      if (!after) break;
    }

    onProgress('Recently played');
    const rp = await api('/me/player/recently-played?limit=50');
    (rp?.items || []).forEach((it) => (it.track?.artists || []).forEach((a) => add(a, 'recent')));

    // Liked songs: every artist on every song you've hearted, counted.
    const first = await api('/me/tracks?limit=50&offset=0');
    const total = Math.min(first?.total || 0, MAX_LIKED);
    const take = (d) => (d?.items || []).forEach((it) => (it.track?.artists || []).forEach((a) => add(a, 'liked')));
    take(first);
    const offsets = [];
    for (let o = 50; o < total; o += 50) offsets.push(o);
    for (let i = 0; i < offsets.length; i += 4) {
      onProgress(`Liked songs ${Math.min(total, offsets[i] + 50)} of ${total}`);
      const batch = await Promise.all(offsets.slice(i, i + 4).map((o) => api(`/me/tracks?limit=50&offset=${o}`)));
      batch.forEach(take);
    }

    const out = { at: Date.now(), likedTotal: total, artists: map };
    ls.set(K.artists, out);
    return out;
  }

  const cachedArtists = () => ls.get(K.artists);

  window.SPOT = { SpotifyError, redirectUri, clientId, setClientId, login, finishLogin, isConnected, disconnect,
    gatherArtists, cachedArtists, norm };
})();
