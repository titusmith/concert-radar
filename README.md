# Concert Radar

A quick-glance list of upcoming shows near you by artists you actually listen to, even ones you've only hearted a song or two from.

- **Cities, in priority order:** Lawrence, Kansas City, Topeka. Edit `REGIONS` in `shows.js` to change them or their radius.
- **Your artists:** read from Spotify: top artists and songs, artists you follow, recently played, and every artist on your Liked Songs (counted). Each show says why it's there: *Top artist*, *Following*, *Liked 3 songs*, *On repeat*, *Played recently*.
- **Everything:** every music show in your cities, with yours highlighted.
- **New** marks shows that appeared since you last looked. **On sale …** shows when tickets aren't on sale yet.
- Tap a show to open it on Ticketmaster.

Once a day (when you open it) the app checks Ticketmaster for the next 12 months and re-reads your Spotify. The refresh button does both now. Your listening stays on your device; nothing about it goes to the helper.

Live at https://titusmith.github.io/concert-radar/ once GitHub Pages is on (Settings → Pages → Deploy from a branch → main → / (root)). Add it to your phone's home screen for an app icon.

## Setup

### 1. The helper (Cloudflare Worker)

It holds your Ticketmaster key so it isn't in the app. The free plan is enough.

1. Get a Ticketmaster key: https://developer.ticketmaster.com → My Apps → copy the **Consumer Key**.
2. In Cloudflare: **Workers & Pages → Create → Worker**, name it `concert-radar`, **Deploy**, then **Edit code**, replace everything with `helper/worker.js`, and **Deploy** again.
3. In the worker: **Settings → Variables and Secrets → Add**, type **Secret**, name `TICKETMASTER_KEY`, value your Consumer Key.
4. Copy the worker's address (like `https://concert-radar.yourname.workers.dev`).

### 2. Spotify

Reuses the Spotify developer app from Setlist Buddy.

1. In the Spotify developer dashboard, open that app → **Edit settings** → add this Redirect URI exactly: `https://titusmith.github.io/concert-radar/callback.html` → Save.
2. Open Concert Radar, paste the helper address, tap **Test the helper**. The Client ID is filled in from Setlist Buddy if you've used it on this device; otherwise paste it.
3. Tap **Connect Spotify** and approve. Do this once on each device you use.

Sign-in uses Authorization Code with PKCE (no client secret). Spotify's 2026 Development Mode rules apply: the app owner needs Premium, and every Spotify account using it must be listed under the app's User Management.

## What it doesn't catch (yet)

Only shows sold through Ticketmaster (and its partners) are listed, so some small-venue shows on other ticketing sites won't appear. A second source can be added in `shows.js` later.
