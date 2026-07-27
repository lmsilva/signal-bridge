# Signal Bridge — project map

> **For AI agents:** Read this file first when working on the NAS/container code.  
> **Keep fresh:** Update this file whenever you change architecture, modules, config, Docker, auth, or UDP behavior. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-07-26 (Route wait for miles TTS)

---

## What this is

A **Node.js service (Signal Bridge)** that bridges household services to smart displays: Alexa voice (via `alexa-remote2`), Tesla/Vivint and more, **UDP** overlays to LAN clients, the **Signal** phone UI (`src/web/`), and a **display registry** from client announces.

There is **no supported Amazon API** for passive broadcast listening. Detection uses Alexa **push events** + **voice history polling** and heuristics in `parser.js`.

User-facing overview: repo root `README.md`. Docker: `DOCKER.md`.

---

## System context

```
Echo / Alexa app  →  Amazon cloud  →  alexa-remote2 (this bridge)
                                              │
        ┌─────────────────────────────────────┼─────────────────────────────────────┐
        ▼                                     ▼                                     ▼
 data/voice-events.jsonl              HTTPS :47810                           UDP :47832
 data/alexa-session.json              control web (src/web/)                 overlays / commands
 data/displays-registry.json                  │                                     │
                                              │                                     ▼
                                              │                           Windows client(s)
                                              │                           (overlays, WebView2,
                                              │                            remote input)
                                              │                                     │
                                              └──── UDP :47833 ◄── display.announce ─┘
```

**Typical deployment:** QNAP NAS, Docker, `network_mode: host`, `./data` volume for session + config.

---

## Repository layout (bridge)

| Path | Role |
|------|------|
| `src/index.js` | Entry: loads config, starts listener, auth-error backoff |
| `src/listener.js` | Core orchestrator: Alexa init, events, history polls, health, keep-alive |
| `src/parser.js` | Detects announce/broadcast utterances; two-step prompt pairing; dedup |
| `src/session.js` | Load/save `alexa-session.json`; `buildAlexaInitOptions` for listener vs auth |
| `src/session-keepalive.js` | Auth ping, token refresh (via ping cycle), liveness probe, proactive refresh |
| `src/auth-refresh-patch.js` | Replaces broken `alexa-cookie2` refresh with vendored skip-register version |
| `src/vendor/alexa-cookie-refresh.js` | Patched cookie refresh: no `/auth/register` during refresh (fixes 24h auth loss) |
| `src/session-auth-journal.js` | Append-only JSONL auth event log with failure classification |
| `src/session-meta.js` | Token age / session metadata helpers |
| `src/error-format.js` | Unwrap AggregateError and nested causes for clearer logs |
| `src/auth.js` | One-off Amazon login via local proxy (`npm run auth`) |
| `src/auth-proxy-patch.js` | Replaces stock `alexa-cookie2` proxy with vendored version |
| `src/vendor/alexa-cookie-proxy.js` | Patched login proxy (font fixes, static assets, UI CSS injection) |
| `src/port-utils.js` | Pre-check port 3456 before auth proxy bind |
| `src/auth-status.js` | Writes `data/auth-status.json` when session expires |
| `src/broadcast-udp.js` | UDP send (broadcast / unicast) on `:47832`; listen for `display.announce` on `:47833` (`udpBroadcast.discoveryPort`); seals/opens via `lan-crypto` when `LAN_UDP_SECRET` is set |
| `src/lan-crypto.js` | Shared-secret **AES-256-GCM** for bridge↔display UDP (`LAN_UDP_SECRET` / `udpBroadcast.sharedSecret`); protocol v3 envelope `{v,alg,n,c}`; SHA-256 key derive; stamps `sentAt` at seal; ±120s freshness on `sentAt` (not Alexa activity `timestamp`) |
| `src/steam-*.js` | Steam Now Playing: config/session/OpenID auth, Web API + store appdetails, presence allowlist, poller with interrupt-suppress, UDP builders |
| `src/activity-fields.js` | Harvest summary/response/allText from all `voiceHistoryRecordItems` types (app routines often skip ASR) |
| `src/routine-index.js` | Cache `getAutomationRoutines()`; map name/trigger/action phrases → voice kinds; resolve bare “Sent to Display” |
| `src/unmatched-activity-log.js` | Cap-append `data/unmatched-activities.jsonl` for unmatched history rows (debug app Runs) |
| `tools/steam-presence-reporter/` | **Optional** fallback only — normally presence is piggybacked on the theater PC’s `display.announce` (`hostname` + `steamAppId`) |
| `src/display-registry.js` | Known displays from announces; persist `data/displays-registry.json`; prune after ~12 min without re-announce; **discover sweep** drops silent displays after Refresh (~2.5s); resolve target → unicast host |
| `src/message-details.js` | Parse sender/destination/message for broadcast payloads |
| `src/udp-payload.js` | Build typed UDP payloads (broadcast, time, weather, indoor temperature, timer, `qr.display`, `guest.photobooth`, `input.text`, `photo.slideshow`, `route-planner.query`) |
| `src/voice-query-parser.js` | Detect time/weather/indoor temperature/timer/music/route/guest-photobooth voice queries from history |
| `src/guest-photobooth.js` | Match "open guest snaps" (dual-QR welcome) + "open guest snaps slideshow" (Shared Photo Slideshow; ASR "slide show" / legacy "slideshow guest snaps") + legacy "guest photobooth"; `photosToSlideshowEntries` builds absolute `/qr-images/…` URLs; resolve Wi‑Fi SSID/password + booth URL from `.env` (`GUEST_WIFI_*`, `GUEST_PHOTOBOOTH_URL`) |
| `src/route-query.js` | Detect distance/directions voice queries (`matchesRouteQuery` + incomplete-ASR `looksLikeRouteQuery`); extract `{origin, destination}` place names from the query or Alexa's spoken answer (`extractRouteLocations`, incl. incomplete "distance from PLACE" → home→PLACE; `spokenHasRouteAnswer` for orphan miles TTS; mirrors `weather-location.js`) |
| `src/route-fetch.js` | Free/no-key route data: OSRM driving route (`fetchDrivingRoute`) with great-circle "flight" fallback (`greatCircleEstimate`) when no drivable route exists |
| `src/music-info.js` | Detect "play \<song\>" (`matchesMusicQuery`), "what song is playing" (`matchesNowPlayingQuery` — apostrophe-less ASR + spoken-answer fallback), and "next"/"skip" (`matchesMusicSkipQuery`); `fetchNowPlaying` / `fetchNowPlayingAfterSkip` (prefer title change after skip); `isMusicPlayerContent` gates out flash briefing/news/Audible so bare "next" does not open the song card; `emptyNowPlaying` for failed what's-playing queries |
| `src/indoor-locations.js` | Thermostat/sensor names + alias resolution (bedroom echo → Room 7, etc.) |
| `src/indoor-reading-parse.js` | Parse spoken indoor temp/humidity; comfort bands (<68 cold, >74 hot) |
| `src/indoor-temperature.js` | Indoor vs outdoor routing; location phrase extraction |
| `src/air-quality-locations.js` | Air monitor names + alias resolution |
| `src/air-quality-parse.js` | Parse spoken IAQ score/location; band thresholds |
| `src/air-quality-fetch.js` | Smart Home query for PM/CO/VOC/temp/humidity enrich |
| `src/air-quality.js` | Air quality voice query detection + payload helpers |
| `src/time-parse.js` | Parse spoken time from Alexa `alexaResponse` text |
| `src/weather-location.js` | Extract local vs named location from weather questions |
| `src/weather-fetch.js` | Open-Meteo geocode + forecast fetch (no API key) |
| `src/timer-sync.js` | Poll Amazon notifications API; mirror active timers; fire verify |
| `src/alarm-sync.js` | Poll Amazon notifications API; mirror active wake alarms (`Alarm`/`MusicAlarm`) |
| `src/alexa-alarms.js` | Detect show/set/cancel wake-alarm voice commands (distinct from Vivint security) |
| `src/tesla-battery.js` | Voice match for "show tesla battery"; speech-parse fallback |
| `src/tesla-dashboard.js` | Voice match for "show tesla dashboard" |
| `src/tesla-dashboard-data.js` | Map Fleet `vehicle_data` → dashboard UDP object |
| `src/tesla-dashboard-cache.js` | Persist last good dashboard (`data/tesla-dashboard-cache.json`); stale fallback when fetch fails |
| `src/tesla-battery-cache.js` | Persist last good battery reading (`data/tesla-battery-cache.json`); stale fallback (also reads dashboard cache) |
| `src/weather-cache.js` | Persist default-location Open-Meteo forecast (`data/weather-cache.json`) |
| `src/air-quality-cache.js` | Persist indoor air-quality monitors (`data/air-quality-cache.json`) |
| `src/background-cache-refresh.js` | Hourly background refresh: weather, shopping list, air quality, Tesla (online-only / never wakes) |
| `src/tesla-config.js` | `.env` + `config.teslaFleet` → Fleet API settings |
| `src/tesla-session.js` | Load/save `data/tesla-session.json` (access + refresh tokens) |
| `src/tesla-token-refresh.js` | OAuth code exchange, partner token, refresh rotation |
| `src/tesla-fleet-client.js` | `vehicle_data` fetch, wake fallback; `fetchTeslaBattery`, `fetchTeslaDashboard` |
| `src/tesla-session-keepalive.js` | Proactive Tesla token refresh (listener startup) |
| `src/tesla-auth-status.js` | `data/tesla-auth-status.json` when Tesla re-auth needed |
| `src/tesla-auth.js` | One-shot OAuth (`npm run tesla-auth`, `tesla-auth-pc.bat`) |
| `src/tesla-register.js` | Partner domain register + `--verify-only` |
| `src/tesla-http.js` | Form POST helper + `Retry-After` / rate-limit header parsing |
| `src/web-server.js` | **HTTPS web UI**: guest photo booth at `/`, password-gated admin SPA at `/admin/` (`ADMIN_PASSWORD`); JSON API (public: displays + photo upload/push + `/qr-images/*`; admin: status, Tesla/URL/weather/shopping/timers/slideshow, QR URL/Wi‑Fi, Slideshow Manager, remote input, auth); self-signed TLS via `web-tls.js` |
| `src/web-admin-auth.js` | Admin login sessions (HTTP-only cookie) for `/admin` + protected APIs |
| `src/web-tls.js` | Auto-generates/loads self-signed cert in `data/web-certs/` (camera QR needs HTTPS on iOS Chrome) |
| `src/qr-image-cache.js` | Stores "QR code → embedded photo" uploads under `data/qr-image-cache/` **indefinitely** (no automatic expiry) — serves them back at `/qr-images/<token>.<ext>`; `list()` returns every stored photo newest-first (with its `token`) for the Slideshow Manager tab / Shared Photo Slideshow tile; `delete(token)` removes a photo (file + index entry) on request; `onChange(listener)` fires on every `store()`/`delete()` (with the fresh `list()`) so `GET /api/photos/events` (SSE) can push live camera-roll updates to every open browser tab |
| `src/slideshow-settings.js` | Persists Shared Photo Slideshow prefs — playback order (`recent` \| `oldest` \| `random`, default `recent`) and seconds per photo (5–60, default 5) — to `data/slideshow-settings.json`, set from the web Settings tab |
| `src/web/` | **Signal** UI assets: `index.html`, `app.js`, `styles.css`, `logo.svg` / `favicon.svg` / `logo.png`, vendored `jsqr.min.js` |
| `src/events-log.js` | Append-only JSONL log for voice/timer UDP events |
| `test/*.test.js` | Node built-in test suite (`npm test`) |
| `src/bridge-state.js` | Dedup fingerprints + last timestamp on disk |
| `src/config.js` | Merge env + `data/config.json` (or `config.example.json`) |
| `src/logger.js` | Structured console logging |
| `src/diagnose.js` | `npm run diagnose` — quick auth/API check |
| `src/diagnose-indoor.js` | `npm run diagnose-indoor` — list Smart Home thermostat entities (optional) |
| `docker-compose.yml` | Long-running listener container |
| `docker-compose.auth.yml` | One-shot auth container (host network, port 3456) |
| `reauth.sh` | Stop listener, free port, run auth, restart listener |
| `recreate.sh` | Restart `signal-bridge` (`--force-recreate --remove-orphans`); clears ephemeral auth containers (use `--build` only if image rebuild works) |
| `docker-compose.tesla-auth.yml` | One-off Tesla OAuth container (host network, port 4381) |
| `tesla-register.sh` | Register Fleet partner domain (exec or one-off container) |
| `tesla-verify-register.sh` | Verify partner registration |
| `tesla-auth.sh` | Tesla OAuth on NAS (SSH tunnel only — see script); use `tesla-auth-pc.bat` on PC |
| `tesla-auth-pc.bat` | Tesla OAuth on Windows PC (recommended) |
| `tesla-status.sh` | Show Tesla session / auth-status summary |
| `.env` | Tesla secrets (`TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, …) — gitignored; loaded by `config.js` |
| `data/` | **Runtime only** (gitignored): session, config, logs, bridge state, auth journal |

---

## Tesla Fleet API (battery)

**Voice trigger:** custom routine **"Alexa, show Tesla battery"** (Alexa may reply "Sent to Display"). Matches utterance text and battery-flavored speech; bare app-run “Sent to Display” is resolved via `routine-index` (battery vs dashboard). Optional `my` / `the` still match.

**Dashboard trigger:** **"Alexa, show Tesla dashboard"** → `tesla-dashboard.query` with full Fleet `vehicle_data` (map, security, battery, climate, TPMS, software, media). Requires Fleet API credentials (no speech fallback).

**Dashboard cache fallback:** Every successful fetch is saved to `data/tesla-dashboard-cache.json`. If a later fetch fails (vehicle asleep/unreachable/rate limited), the listener serves the cached snapshot with `stale: true`, `staleReason`, `cachedAt`, and recomputed `freshnessSec`, so the display never goes empty; the client shows an amber "cached" pill + legend.

**Battery cache fallback:** Same pattern for `tesla-battery.query` — `data/tesla-battery-cache.json` (falls back to dashboard cache if no dedicated battery cache). Throttled/rate-limited/offline fetches serve the last known % with `stale: true` instead of a blank error bar.

**Hourly background cache refresh** (`background-cache-refresh.js`, started from `listener.js`): every hour (configurable via `backgroundCache` in config) the bridge quietly refreshes disk caches for:

| Source | Cache file | Notes |
|--------|------------|-------|
| Weather (default location) | `data/weather-cache.json` | Open-Meteo — free, no key |
| Shopping list | `data/shopping-list-cache.json` | Amazon lists API via alexa-remote2 |
| Indoor air quality | `data/air-quality-cache.json` | Smart Home sensor query |
| Tesla battery + dashboard | existing Tesla cache files | **Online-only** — checks vehicle state first and **never sends `wake_up`**. Sleeping cars keep the prior cache. Hourly wakes would burn Fleet free-tier credit (~$0.02/wake) and are intentionally avoided. |

Voice queries still fetch live data when possible; caches are used for Tesla cache-first previews and as fallbacks when a live weather/air-quality fetch fails.

**Data source:** When `.env` has `TESLA_CLIENT_ID` + `TESLA_CLIENT_SECRET` and `data/tesla-session.json` exists, `listener.js` calls `fetchTeslaBattery()` → UDP `tesla-battery.query` with live Fleet API data. Without credentials, falls back to parsing Alexa's spoken battery %.

```
Voice "show tesla battery"  →  listener  →  tesla-fleet-client (OAuth token)
                                              →  GET /api/1/vehicles/{vin}/vehicle_data
                                              →  UDP tesla-battery.query  →  display client
```

### One-time setup

| Step | Where | Command / action |
|------|--------|------------------|
| 1. Host PEM | Your domain | `https://DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem` |
| 2. Secrets | Repo `.env` | `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_FLEET_DOMAIN`, optional `TESLA_VIN` |
| 3. Register domain | NAS | `./tesla-register.sh` then `./tesla-verify-register.sh` |
| 4. OAuth | **Windows PC** | `tesla-auth-pc.bat` or `npm run tesla-auth` — includes `vehicle_location` scope for dashboard map |
| 4b. OAuth (phone) | Control page | Settings → **Authenticate Tesla** — Tesla requires a **public CA domain** redirect (LAN IPs are rejected). Use `TESLA_REDIRECT_URI=https://fleetapi.YOURDOMAIN/callback`, register that URI in the Tesla app, and reverse-proxy `/callback` on the Pi/host that serves the Fleet domain → `http://<NAS_IP>:4381/callback`. Bridge auto-binds plain HTTP `:4381` when redirect host is not localhost |
| 5. Virtual key | Phone (Tesla app) | `https://www.tesla.com/_ak/DOMAIN` |
| 6. Restart listener | NAS | `./recreate.sh` after `.env` changes |

**OAuth on PC:** repo on NAS share (`\\nas\...`) — `tesla-auth-pc.bat` uses `pushd` for UNC paths; saves session to `data/tesla-session.json` on the share.

**NAS `./tesla-auth.sh`:** SSH tunnel only (`TESLA_USE_LOCALHOST_REDIRECT=1`); PC auth is the normal path.

### Runtime files

| File | Purpose |
|------|---------|
| `data/tesla-session.json` | OAuth access + refresh tokens |
| `data/tesla-auth-status.json` | `reauth_required` / `reauth_recommended` |
| `data/tesla-rate-limit.json` | Short-lived rate-limit state (optional) |

### Config

**`.env`:** `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_FLEET_DOMAIN`, `TESLA_FLEET_REGION` (default `na`), `TESLA_VIN` (optional), `TESLA_REDIRECT_URI` (public URI Tesla sees; PC can use `http://localhost:4381/callback`), optional `TESLA_CALLBACK_LISTEN` (local bind override; default `http://0.0.0.0:4381` when redirect is a non-loopback host).

**`config.teslaFleet`:** `enabled`, `region`, `domain`, `vin`, `sessionFile`, `minRequestIntervalSec`, `keepAlive.*` — see `config.example.json`.

Docker listener passes Tesla vars via `env_file: .env` in `docker-compose.yml`.

### Voice pipeline notes

- `voice-event-gate.js` — Tesla does **not** wait for Alexa spoken response. Route waits when origin/destination cannot be extracted from the query alone (incomplete distance ASR).
- `pending-voice-responses.js` — no Tesla pending/correlation.
- `tesla-session-keepalive.js` — started with listener; refreshes tokens before expiry.

### UDP `battery` object (`tesla-battery.query`)

| Field | Success | Error |
|-------|---------|-------|
| `percent` | 0–100 | `null` |
| `model` | e.g. `Model Y` | same |
| `source` | `fleet-api` | `fleet-api` |
| `status` | `ok` | `rate_limited`, `auth_required`, `vehicle_offline`, … |
| `error` | — | Human-readable message |
| `limitResetAt` | — | ISO timestamp when rate limited |
| `chargingLabel` | e.g. `Charging` | — |
| `stale` | — | `true` when serving cached reading after fetch failure |
| `staleReason` | — | Original error (e.g. `Request throttled`) |
| `cachedAt` | — | ISO timestamp of cached reading |
| `freshnessSec` | — | Age of cached reading in seconds |

---

## Session keep-alive & auth diagnostics

**Refresh patch (critical):** stock `alexa-cookie2@5.0.3` re-registers the app via `POST /auth/register` on every refresh; Amazon now rejects that (`InvalidToken / Auth time of the token is expired`), so every refresh ended in `No tokens in Register response`, tokenDate never rotated, and the session died after ~24–36h. `src/auth-refresh-patch.js` (installed at startup in `index.js` and `diagnose.js`) swaps in `src/vendor/alexa-cookie-refresh.js`, which follows upstream PR Apollon77/alexa-cookie#191: exchange refresh token at `/auth/token`, **skip `/auth/register`**, re-register capabilities with the new access token, refresh marketplace cookies + CSRF, advance `tokenDate`. Keeps `refreshToken`/`deviceSerial`/`macDms` untouched.

Every **15 minutes** the bridge runs a single **ping cycle** (no separate refresh timer):

1. `checkAuthentication()` — lightweight auth check
2. **Optional** `refreshCookie()` — first attempt after token age ≥ **2h**, then every **2h**; proactive refresh at **8h**; **forced** refresh every ping once token age ≥ **18h** (stale-token watchdog)
3. `getDevices()` — liveness probe (proves API works)
4. Reconnects push if disconnected

**Refresh failure handling:** `No tokens in Register response` is logged as `token_refresh_noop` (benign). When `tokenDate` does not advance after refresh/cookie save, the bridge tracks **token rotation stalled** and writes `reauth_recommended` to `auth-status.json` at **16h** (before APIs die). At **22h** with repeated noops it escalates to `reauth_required`. `Cookie invalid, Renew unsuccessful` is classified and no longer spams false `session_degraded` via `refresh already in flight`.

**Auth journal:** `data/session-auth-journal.jsonl` — one JSON object per line with `type`, `category`, `likelyCause`, `sessionMeta`. Includes `token_refresh_noop`, `token_refresh_failed_but_live`, ping failures, history auth errors, push disconnects, and `reauth_required`.

**Re-auth signal:** `data/auth-status.json` includes `likelyCause` + last journal entries when threshold hit (5 consecutive failures).

**Debug after auth loss:** `docker compose logs -f` + `tail data/session-auth-journal.jsonl` + `cat data/auth-status.json`

**Dump auth diagnostics to a file (run on NAS):**

```bash
cd /share/Container/signal-bridge
./scripts/dump-auth-diagnostics.sh
# or: cat data/diagnostics/auth-dump-*.txt
```

---

## Runtime flow (listener)

1. `index.js` → `createListener().start()`
2. Load `data/alexa-session.json`; `buildAlexaInitOptions(..., { mode: 'listener' })`
3. `alexa.init()` — uses saved cookies; **no** login proxy in listener mode
4. **Capture paths:**
   - **Push:** `ws-device-activity` → broadcast parser + voice query parser
   - **History fallback:** volume-change / connect / periodic poll → `getCustomerHistoryRecords()`
5. **On broadcast match:** log → `data/voice-events.jsonl` → UDP `type: broadcast`
6. **On voice match:** time/weather/indoor/air quality/tesla-battery/shopping/… → UDP + `data/voice-events.jsonl`; timer/alarm voice → immediate sync poll
7. **Timer sync:** periodic `getNotifications()` diff → UDP `type: timer.snapshot` with full active timer list
8. **Dedup:** `BroadcastParser` + voice query processed-id set + `bridge-state.json`

---

## Auth flow

1. `PROXY_OWN_IP=<NAS_LAN_IP> ./reauth.sh` (or `docker compose -f docker-compose.auth.yml up`)
2. `auth.js` installs vendored proxy **before** loading `alexa-remote2`
3. Browser → `http://<NAS_IP>:3456/` → Amazon login proxy catches OAuth → `cookie-success`
4. Session saved to `data/alexa-session.json` (+ `formerDataStore.json` for device registration data)

**Known issues:** Amazon changes login URLs; proxy may show spinner then redirect to storefront if success detection misses. Port 3456 must be free (`reauth.sh` kills stale listeners). QNAP `docker compose build` often fails (ZFS); code updates apply via **`./src` volume mount** without rebuild.

---

## Configuration

Priority: env vars → `data/config.json` → `config.example.json`

| Key | Purpose |
|-----|---------|
| `amazonPage` / `acceptLanguage` | Region (e.g. `amazon.com`, `en-US`) |
| `sessionFile` | Default `data/alexa-session.json` |
| `udpBroadcast.enabled/port/targets/defaultDisplaySeconds` | LAN UDP overlays/commands to Windows clients (`:47832`) |
| `LAN_UDP_SECRET` (`.env`) / `udpBroadcast.sharedSecret` | Shared secret for AES-256-GCM on UDP; must match each client's `udpSecret`. Empty = plaintext (warned at startup) |
| `udpBroadcast.discoveryPort` | Listen for `display.announce` (default **47833**) |
| `sessionKeepAlive.*` | Ping/refresh/liveness/proactive intervals, `failureThreshold`, `livenessProbe` |
| `voiceEvents.enabled/timeQueries/weatherQueries/indoorTemperatureQueries/airQualityQueries/teslaBatteryQueries/fetchWeather/fetchAirQuality/routeQueries` | Voice capture toggles |
| `voiceEvents.defaultLocation` | `{ name, latitude, longitude }` for generic/outdoor weather queries and as the implicit "here"/"home" origin for route-planner queries |
| `indoorTemperature.coldBelowF/hotAboveF` | Comfort bands for display (defaults 68 / 74) |
| `indoorTemperature.locations[]` | Thermostat/sensor names/aliases/`entityId` (local `data/config.json`; empty = generic built-in list) |
| `airQuality.defaultMonitor` | Fallback monitor when query/response has no location (e.g. `main floor`) |
| `airQuality.monitors[]` | Air monitor names/aliases/`entityId` (local `data/config.json`; empty = generic built-in list) |
| `voiceEvents.eventsLogFile` | Default `data/voice-events.jsonl` — all captured events (broadcasts + voice + timers) |
| `timerSync.*` | Poll intervals, mirror file, fire-verify slack |
| `alarmSync.*` | Alarm poll/mirror; `localTimeZone` for `originalDate`/`originalTime` (default `America/Denver`) |
| `teslaFleet.*` | Fleet API region, domain, VIN, keep-alive, `minRequestIntervalSec` |
| `webServer.enabled/port` | Control web page HTTPS port (default enabled, `47810`) |
| `webServer.https` | `true` (default) — self-signed TLS; required for live camera QR on iOS |
| `webServer.httpRedirectPort` | Optional plain HTTP redirect to HTTPS (default `47811`; set `0` to disable) |
| `webServer.certDir` / `certHosts` | Cert folder (`data/web-certs`) and extra SAN hostnames/IPs (include your NAS LAN IP) |
| `webServer.controlAuth.*` | PIN unlock for mouse/keyboard/power (`enabled`, `pinDigits`, `pinDisplaySeconds` null→`defaultDisplaySeconds`, `sessionMinutes` default 60 — mirrors the 1h client-side lock) |
| `qrImage.cacheDir` | Folder for "QR → embedded photo" uploads (default `data/qr-image-cache`); photos are kept **indefinitely** — delete them from the web page's Slideshow tab |
| `qrImage.maxBytes` | Max decoded photo size accepted by `/api/qr/image-upload` (default 6MB) |
| `qrImage.defaultDisplaySeconds` | Fallback `displaySeconds` for `qr.display` payloads (default 60) |
| `slideshow.settingsFile` | Path to the persisted Shared Photo Slideshow order setting (default `data/slideshow-settings.json`) |
| *(none)* | Shared Photo Slideshow draws from every photo in the QR image cache (any photo uploaded via QR "Photo" mode, or from the Slideshow tab) — ordered per the persisted `slideshow` setting (`recent`/`oldest`/`random`, default `recent`) |
| `PROXY_OWN_IP` / `PROXY_PORT` | Auth only (env) |

Secrets and runtime files live under `data/` and are **not committed**.

---

## UDP payload (v2 inner / v3 wire)

When `LAN_UDP_SECRET` is set, datagrams are a **v3 envelope** (`aes-256-gcm`); the decrypted inner JSON is still the v2 payload below. Without a secret, v2 JSON is sent plaintext (dev only).

## UDP payload types (v2)

All payloads include `version: 2` and a `type` field. **Broadcast payloads keep `message`** so existing clients still work until updated.

| `type` | When emitted |
|--------|----------------|
| `broadcast` | Announce/broadcast captured (unchanged fields: `message`, `sender`, `destination`, …) |
| `time.query` | "What time is it" — includes `parsedTime`, `spokenResponse`, `device` |
| `weather.query` | Outdoor weather — generic "what's the temperature" or explicit outside/weather |
| `indoor-temperature.query` | Indoor thermostat — "temperature on/at/in \<location\>" or "humidity of \<location\>" |
| `air-quality.query` | Air quality monitor — IAQ score + sensor metrics (temp, humidity, PM2.5, CO, VOC) |
| `timer.snapshot` | Timer set/list/change/fire — includes `timers[]` (all active), `event.kind` (`started`, `list`, `fired`) |
| `tesla-battery.query` | "Show tesla battery" — `battery` object from Fleet API or speech fallback |
| `tesla-dashboard.query` | "Show Tesla dashboard" — `dashboard` object from Fleet API (`vehicle_data` + `location_data`) |
| `request.processing` | Instant ack for slow external-API commands (Tesla) when **no cache exists** — `request.{title,source,timeoutSeconds,stages[]}`; when a cached snapshot exists the bridge sends it instead, flagged `stale+refreshing`. Either is replaced by the real payload when the fetch completes |
| `alarm.snapshot` | Wake alarms list / newly set alarm highlight |
| `web.open` | Control page pushes a URL — `web.{url,errorDisplaySeconds}`, `persistent: true`; client opens it in a WebView2 overlay that stays until `web.close` |
| `web.close` | Control page "Close Browser" — client kills the WebView2 overlay |
| `system.command` | Control page Remote tab — `system.action` = `reboot` \| `poweroff`; client runs Windows `shutdown` |
| `display.discover` | Control page refresh — clients re-announce; payload may include `discovery.port` |
| `display.announce` | **Inbound** on `:47833` — client registration (`display.{id,shortId,name,port,hostname,steamAppId?}`); `steamAppId` is Steam presence when a game is running on that PC |
| `display.auth` | Control unlock PIN overlay — `auth.pin` + `displaySeconds`; after verify, `auth.status: "ok"` for ~1s green Authenticated flash |
| `input.pointer` / `input.key` | Control tab — relative mouse / key; requires unlocked `target.id` + `controlToken` |
| `input.text` | Control tab "Send Text" card — `text.{value, pressEnter}`; client types the whole string in one shot (`pynput` `Controller.type()`, Unicode-safe) instead of one keystroke per key event; requires unlocked `target.id` + `controlToken` |
| `qr.display` | Push tab QR generator — `qr.{qrType: "url"\|"wifi", content, label}`; client renders the QR bitmap locally (`qrcode` lib) from `content` (a URL, or a `WIFI:T:...;;` string built by `buildWifiQrContent`) |
| `guest.photobooth` | Alexa **"open guest snaps"** (legacy: guest photobooth) — dual-QR **Guest Snaps** welcome on **all displays**: `guestPhotobooth.{wifi,booth}` with Wi‑Fi `WIFI:T:…` + booth URL; client owns chrome (no duplicate shell title), portrait stack with a dedicated "then" band between cards |
| `photo.slideshow` | Alexa **"open guest snaps slideshow"** (also "guest snaps slideshow" / legacy "slideshow guest snaps") **or** Push tab "Shared Photo Slideshow" — `slideshow.{photos[], secondsPerPhoto}`; `photos` is every photo in the QR image cache as `{url, uploadedAt}` (photos never expire — see `qr-image-cache.js`), ordered by the bridge per the persisted Settings-tab preference (`recent`\|`oldest`\|`random`); `displaySeconds` = `photos.length * secondsPerPhoto` so the whole set gets shown once. Voice path fans out to **all displays**. Client plays through the list once (does not loop), shows "Photo x of y" + a "Shared …" date label + a small corner QR linking to that photo, and suppresses the usual "Dismisses in…" countdown text (the underlying auto-dismiss timer still fires when the pass completes) — interrupted immediately if any new UDP payload arrives |
| `steam.now-playing` | Auto: persistent game card when the linked Steam account is in-game on **any PC** (`STEAM_REQUIRE_PRESENCE=0`, default — Steam’s API cannot name the machine). Optional host gate: `STEAM_REQUIRE_PRESENCE=1` + `STEAM_ALLOWED_HOSTS` + display.announce/`steamAppId`. Manual admin test skips host gate, dismissible, last-played fallback. API key: `.env` `STEAM_API_KEY` only. Interrupted by other display UDP → suppressed until game stops/restarts. Close via `steam.now-playing.close` |
| `route-planner.query` | "How far is Moab from here" / "distance between X and Y" / "how long to drive to X" / "directions to X" — `origin`/`destination` (`{name,latitude,longitude}`), `mode` (`"driving"` \| `"flight"`), `distanceMiles`, `durationMin`, `route.geometry` (simplified `[[lat,lon],...]` polyline, or just the two endpoints for flight mode). Bridge only geocodes both places + calls OSRM (fast, ~1-2 API calls) — map tiles, place facts and weather are fetched **client-side** afterwards so the fast facts show immediately while the rest fills in |

Optional `target: { id }` or `{ all: true }` on outbound commands for unicast vs broadcast delivery (`display-registry.resolveDelivery`).

**Indoor vs outdoor routing:** Generic "what's the temperature" → outdoor (`weather.query`). Location-specific ("top floor", "bedroom echo", "guest bedroom") → indoor. Spoken Alexa response supplies the reading (e.g. "It's 76 degrees on the top floor"). Humidity only when explicitly asked for a named location. Household room names / Alexa `entityId`s belong in local `data/config.json` (`indoorTemperature.locations`, `airQuality.monitors`), not in git.

Timer sync emits when active timer **count increases** (new timer set), on list changes, and on fire verification. Timer voice hints trigger sync even when `voiceEvents.enabled` is false. Location for weather uses query text **and** Alexa spoken response (`weather-location.js`).

Example timer snapshot:

```json
{
  "version": 2,
  "type": "timer.snapshot",
  "device": "Kitchen Echo",
  "timers": [
    {
      "amazonId": "abc",
      "device": "Kitchen Echo",
      "label": "Pizza",
      "durationSec": 300,
      "remainingSec": 240,
      "status": "ON",
      "fireAt": "2026-06-27T16:04:00.000Z"
    }
  ],
  "event": { "kind": "list" },
  "displaySeconds": 120
}
```

Default overlay port **47832**; discovery listen **47833**. Use `targets: ["<windows-ip>"]` if overlay broadcast is unreliable from Docker. Clients must unicast announces to the NAS via `bridgeHosts`.

**Display PC deploy:** user runs `alexa broadcast client\build_portable.bat` when ready; output is **`alexa broadcast client/dist/alexa broadcast client.zip`** (see client `src/PROJECT.md`). Agents build only when explicitly asked.

---

## Testing

```bash
npm test                    # bridge only (399 tests)
run_all_tests.bat           # repo root — bridge + Windows client
```

Bridge tests in `test/*.test.js` — includes `tesla-fleet.test.js`, `tesla-udp-payload.test.js`, `tesla-auth-status.test.js`, `tesla-battery.test.js`, `tesla-battery-cache.test.js`, `tesla-dashboard.test.js`, `tesla-dashboard-data.test.js`, `tesla-dashboard-cache.test.js`, voice-event gate/dedup for Fleet API flow, `web-command-payloads.test.js` (web.open/web.close/system.command builders + `buildWifiQrContent`/`buildQrDisplayPayload`/`buildInputTextPayload`/`buildPhotoSlideshowPayload` incl. `{url,uploadedAt}` object photos + `recent`/`oldest`/`random` ordering/`buildRoutePlannerPayload`), `qr-image-cache.test.js` (store/get/`delete()`, no auto-expiry, oversized/invalid rejection, `list()` newest-first with tokens, `onChange` notifies on store/delete and tolerates a throwing/non-function listener), `route-query.test.js` (distance/directions phrasing detection + origin/destination extraction, incl. "from here"/"from home" and Alexa's own spoken distance answer), `route-fetch.test.js` (haversine math, great-circle fallback, mocked-`fetch` OSRM success/`NoRoute`/HTTP-error/throw paths), and `web-server.test.js` (static + API routes, URL validation, Tesla phone-OAuth callback flow with mocked token endpoint, QR push + photo upload/serve, weather/shopping-list/timers quick-push tiles, full-string text input, photo-slideshow list + push, photo delete single/bulk, slideshow order setting get/set/validation + applied-on-push, Slideshow Manager tab + Photo\|URL\|Wi-Fi QR order markup, `/api/photos/events` SSE hello + live store/delete pushes).

Client tests in `alexa broadcast client/test/test_*.py` — includes `format_limit_reset_time`, Tesla fleet battery payload routing, `test_web_overlay.py` (pre-flight, host command, command routing, error payload), `test_qr_panel.py` (`QrPanel._build_qr_image` sizing, empty-content fallback), `test_photo_slideshow_panel.py` (`PhotoSlideshowPanel._fetch_photo` download/thumbnail/SSL-fallback, `_is_ssl_failure`, `show()` normalizing `{url,uploadedAt}`/bare-string photo entries, `_advance()` stopping after the last photo instead of wrapping), and `test_display_remote.py` (`handle_text` full-string typing, optional Enter press, broken-pynput survival).

**Before commit/push:** always run `run_all_tests.bat` and fix failures first (see `.cursor/rules/project-docs.mdc`).

---

## Docker notes (QNAP)

- **`network_mode: host`** — required for UDP LAN + auth proxy on NAS IP
- **`./src:/app/src:ro`** — edit JS on host without image rebuild
- **`./data:/app/data`** — session + config persist across restarts
- Listener service name: `signal-bridge` (container/image: `signal-bridge`)
- Auth: `docker compose -p signal-auth -f docker-compose.auth.yml up --no-build`

---

## Commands

| Command | When |
|---------|------|
| `docker compose up -d` | Start listener |
| `./recreate.sh` | Restart listener (no build) |
| `PROXY_OWN_IP=x.x.x.x ./reauth.sh` | Re-authenticate Amazon |
| `docker compose logs -f` | Tail logs |
| `npm run diagnose` | Test session inside container |
| `npm run tesla-register` | Register `TESLA_FLEET_DOMAIN` with Tesla (run once; PEM must be hosted) |
| `npm run tesla-verify-register` | Confirm domain registration |
| `npm run tesla-auth` | Tesla OAuth on **PC** (`http://localhost:4381/callback`); saves `data/tesla-session.json` |
| `tesla-auth-pc.bat` | Same as npm tesla-auth (Windows; `pushd` for UNC NAS paths) |
| `./tesla-register.sh` | Register Fleet domain on NAS |
| `./tesla-verify-register.sh` | Verify Fleet registration |
| `./tesla-status.sh` | Tesla session / auth-status summary |
| `docker compose exec -it signal-bridge sh` | Interactive shell in listener container |

---

## Dependencies

- **Node ≥ 18**
- **`alexa-remote2`** (^8) — unofficial Alexa API; wraps `alexa-cookie2` for auth/refresh

---

## Control web page (`src/web-server.js` + `src/web/`)

Served by the listener at **`https://<NAS_IP>:47810/`** (config `webServer.{enabled,port,https}`; self-signed TLS in `data/web-certs/`). Optional HTTP→HTTPS redirect on **47811**.

| URL | Who | What |
|-----|-----|------|
| `/` | Guests | Photo booth — pick a display (or all), take/choose a photo, push `qr.display` photo mode; upload also saves to the shared photo cache |
| `/admin/` | Host | Full SPA (Push / Remote / Control / Slideshow / Settings), gated by `ADMIN_PASSWORD` (.env) via login form + HTTP-only session cookie |
| `/admin/login.html` | Host | Admin password form |

Public APIs: `GET /api/displays` (+ events SSE), `POST /api/qr/image-upload`, `POST /api/qr/push` (**photo mode only**), `GET /qr-images/*`. Everything else requires an admin session. If `ADMIN_PASSWORD` is unset, admin APIs fail closed (503).

**Reverse-proxy subpaths:** the SPA uses a dynamic `<base href>` (from `location.pathname`) plus relative asset/API URLs, so a path-stripping proxy (e.g. public `/signal/` → bridge `/`) works without hardcoding a prefix. Prefer a trailing slash on the public mount URL.

**iPhone / Chrome QR:** open the **https** URL once, accept the certificate warning (Advanced → Proceed), then **Scan QR Code** uses the live camera (`getUserMedia` + jsQR). Plain HTTP cannot use the camera on iOS — put your NAS IP in `webServer.certHosts` (or `PROXY_OWN_IP`) before first cert generation, or delete `data/web-certs/` and restart after updating hosts.

**JSON API:**

| Route | Effect |
|-------|--------|
| `GET /api/displays` | Known displays from `display.announce` registry (`id` unique; `label` disambiguates duplicate names) |
| `GET /api/displays/events` | SSE stream — pushes `displays` events whenever the registry changes |
| `POST /api/displays/discover` | Broadcast `display.discover`, wait ~2.5s for re-announces, prune silent displays; returns `{ displays, removedIds }` |
| `POST /api/displays/auth/start` | Show 4-digit PIN on selected display (`display.auth`); required before mouse/keyboard/power |
| `POST /api/displays/auth/verify` | `{targetId,pin}` → `controlToken` session for that display |
| `POST /api/displays/auth/status` | Unlock / challenge status for a display |
| `POST /api/push/tesla-dashboard` / `tesla-battery` | Synthetic event (`trigger: "web-api"`) through `listener.recordVoiceEvent`; body may include `targetId` |
| `POST /api/push/weather` / `shopping-list` | Synthetic voice-query event (`trigger: "web-api"`) through `listener.recordVoiceEvent`, same as if Alexa had been asked — cached weather/shopping data is served immediately |
| `POST /api/push/air-quality` | Synthetic `air-quality` event (`show indoor air quality`) → multi-monitor indoor AQ overlay |
| `POST /api/push/indoor-temperature` | Synthetic `indoor-temperature` event for the first configured indoor sensor (or "temperature inside") |
| `POST /api/push/guest-photobooth` | Guest Snaps dual-QR welcome on **all displays**; **503** if Wi‑Fi/booth URL not configured |
| `POST /api/push/timers` | Calls `listener.requestTimerPoll()` for an immediate Amazon notifications poll → UDP `timer.snapshot`; **503** if the hook isn't wired (older listener) |
| `POST /api/push/alarms` | Calls `listener.requestAlarmPoll()` for an immediate Amazon alarms poll → UDP alarm snapshot; **503** if the hook isn't wired |
| `POST /api/push/url` `{url,targetId?}` | Validate → UDP `web.open` (unicast when one display selected) |
| `POST /api/push/close-browser` | UDP `web.close` |
| `POST /api/qr/push` `{mode:"url"\|"wifi", url\|(ssid,password,security,hidden), label?, targetId?}` | Build content string → UDP `qr.display` |
| `POST /api/qr/image-upload` `{imageDataUrl}` | Store a base64 photo (`qr-image-cache.js`, kept indefinitely) → `{path,token,createdAt}`; resolve `path` against `document.baseURI` client-side, then push it through `/api/qr/push` (`mode:"url"`) |
| `GET /qr-images/<token>.<ext>` | Serves a stored photo — 404s only if the token is unknown or was deleted |
| `GET /api/photos` | Lists every stored photo (newest-first) with `{token,path,createdAt}`, for the Slideshow Manager tab's camera roll and the "Shared Photo Slideshow" tile preview/count; also the manual-refresh fallback for `/api/photos/events` |
| `GET /api/photos/events` | SSE stream (same pattern as `/api/displays/events`) — pushes a `photos` event with `{reason,photos}` on connect (`reason:"hello"`) and again on every `store()`/`delete()` from *any* browser tab, so every open Slideshow Manager tab's camera roll stays live without polling |
| `POST /api/photos/delete` `{token}` or `{tokens:[]}` | Deletes one or more photos from the cache (Slideshow Manager tab, single or multi-select) → `{deleted:[],failed:[]}` |
| `GET /api/slideshow/settings` | Current Shared Photo Slideshow playback order (`{order,orders}`) |
| `GET`/`POST /api/slideshow/settings` | Read/update `{order, secondsPerPhoto}` in `data/slideshow-settings.json` (Settings tab — order segmented control + 5–60s time-per-photo slider) |
| `POST /api/push/photo-slideshow` `{photos:[{url,uploadedAt}],targetId?}` | Builds UDP `photo.slideshow` from the given photos, reordered per the persisted slideshow setting; 404→400 with a friendly message when there are no photos |
| `POST /api/system/reboot` / `poweroff` | UDP `system.command` |
| `POST /api/input/pointer` / `key` | Relative mouse / key injection — **requires** a single `targetId` (not All) |
| `POST /api/input/text` `{value,pressEnter?,targetId?}` | Full-string keyboard input (logins/passwords/URLs) — UDP `input.text`; same PIN/`controlToken` gate as pointer/key |
| `POST /api/auth/tesla/start` | Returns Tesla authorize URL + opens one-shot local callback (default `http://0.0.0.0:4381`, 10-min timeout) → `saveTokensFromCode`. Public `TESLA_REDIRECT_URI` (e.g. `https://fleetapi…/callback`) must be proxied from the Fleet domain host to that listen port |
| `POST /api/auth/alexa/start` | Runs vendored login proxy in-process (`runAuth({exitOnComplete:false, overrides:{proxyOwnIp}})`, port 3456; `proxyOwnIp` derived from request Host); on success the bridge saves the session and **exits 0** so Docker `restart: unless-stopped` brings it back fresh |
| `GET /api/status` | Alexa/Tesla auth state, active pushed URL, uptime |

QR scanning (reading a code with the phone) is client-side: `<input type="file" capture>` photo → jsQR decode → confirm sheet → `POST /api/push/url`. `installAuthProxyPatch()` now runs at the top of `index.js` (before `alexa-remote2` loads) so the in-process login proxy works in listener mode.

**QR generator** (Push tab, separate from scanning above) lets the phone display a QR code on the target screen, mode tabs ordered **Photo | URL | Wi-Fi**: **Photo** (client resizes/re-encodes to JPEG via canvas, uploads to `/api/qr/image-upload`, then pushes the resolved URL through `mode:"url"`), **URL** (plain link), or **Wi-Fi** (SSID/password → standard `WIFI:T:...;;` string, escaped via `buildWifiQrContent`). The bridge never renders a bitmap — it only ships the content string in `qr.display`; the display client generates the QR image locally.

**Slideshow tab** — camera-roll manager for everything in the QR image cache: thumbnail grid (`GET /api/photos`, kept live via `GET /api/photos/events` SSE plus a manual refresh icon button), tap to open a lightbox with the upload date and a Delete button (left/right arrow buttons + ←/→ keyboard keys + swipe on touch screens to step between photos, with a "Photo x of y" counter), "Select" mode for multi-select + a "Select All"/"Unselect All" toggle + bulk delete, all deletes behind a themed confirm sheet (`POST /api/photos/delete`). The grid refreshes automatically when a photo is uploaded or deleted from any browser tab/session — no manual refresh needed unless the SSE connection is blocked/dropped. Settings tab gains a "Playback order" segmented control (Newest first / Oldest first / Shuffle) and a "Time per photo" slider (5–60s) that persist to `data/slideshow-settings.json` via `GET`/`POST /api/slideshow/settings` and are applied by the bridge whenever `/api/push/photo-slideshow` builds the UDP payload.

---

## Recent changes

- 2026-07-26: **Route Planner waits for miles TTS (no home→home flash)** — incomplete "distance from Saratoga Springs Utah" must not invent a pair from `defaultLocation` (that skipped pending pairing and could emit a useless near-zero route). Gate always waits when the ASR looks like distance but isn't a full two-place query; orphan miles TTS on a later activity id completes via `pending-voice-responses`. Deploy: `./recreate.sh`.
- 2026-07-26: **Route split-activity miles TTS pairing** — incomplete distance ASR on one activity id + Alexa's miles answer on another: `spokenHasRouteAnswer` + `pending-voice-responses` remember orphan route queries and `tryComplete` attaches miles TTS; listener schedules follow-up polls and forgets on emit. Deploy: `./recreate.sh`.
- 2026-07-26: **Admin desktop tab bar clearance** — body reserves space for the fixed bottom tabs so Control/Slideshow actions aren’t covered on Chrome PC; wide screens center the tab strip under the content column (no full-bleed stretch). Cache-bust `?v=signal16`. Hard-refresh admin.
- 2026-07-26: **Route Planner incomplete ASR no longer drops TTS** — "distance from Saratoga Springs Utah" (no destination yet) was marked processed / dedup-consumed before Alexa's miles answer landed on the same activity id. Now `looksLikeRouteQuery` keeps it as `route`, `voice-event-gate` waits when extract fails, listener skips dedup until upgrade, and dedup allows empty→spoken / spoken-signature upgrades. Deploy: `./recreate.sh`.
- 2026-07-26: **Revert admin desktop side rail** — moving the tab bar left did not address the reported overlap (wrong diagnosis). Bottom tab bar restored on desktop; tab panels stay force-hidden via `[hidden]` beating `.active`.
- 2026-07-26: **Route ASR "difference"→"distance" + admin tab paint fix** — Alexa often hears "what's the difference from here to …"; normalize to distance. Admin: one sticky chrome stack + inactive `.tab-panel` force-hidden. Deploy: `./recreate.sh` for route matcher.
- 2026-07-26: **Route Planner matches Alexa TTS distance answers** — real history rows for distance skills often have empty ASR (`NO_TEXT_OR_AUDIO_STORED`) and only TTS like "Los Angeles is about 564 miles from Saratoga Springs, Utah as the crow flies…". Prior matcher only knew "N miles from X to Y", so events landed in `unmatched-activities.jsonl` with no UDP. Now match/extract `Y is about N miles from X` and `it's about N miles to Y (from X)`. Deploy: `./recreate.sh`.
- 2026-07-26: **Route Planner "here"/distance fix** — production `data/config.json` was missing `voiceEvents.defaultLocation`, so "distance from here to …" resolved to a null-coord local stub, skipped geocode (`scope === 'local'`), then aborted with no UDP. Named A→B queries were fine in unit tests but the same silent path hurt debugging. Now: require a real default for "here"/"home"; geocode any place still missing coords; warn clearly when extract fails. Deploy: `./recreate.sh` (config is volume-mounted — restart picks up `defaultLocation`).
- 2026-07-26: **Steam Now Playing = any PC by default** — Steam cannot report which machine launched a game; `STEAM_REQUIRE_PRESENCE=0` (default) shows the overlay whenever the linked account is in-game. Household split: games on **MOVIETHEATERPC** (no display client), overlays on **MOVIETHEATERPOSTER**. No software needed on the gaming PC. Optional host gate via `STEAM_REQUIRE_PRESENCE=1`. Removed admin Steam API-key Save UI. Deploy: `./recreate.sh`.
- 2026-07-26: **Steam display.announce presence (optional)** — client can still send `hostname` + `steamAppId` for snappier/host-gated detection when desired.
- 2026-07-26: **Now Playing Quick Push** — Push tab Indoor Temperature tile replaced with **Now Playing** (`POST /api/push/now-playing` → `music-query`).
- 2026-07-26: **Steam Now Playing launch snappiness** — presence heartbeat triggers an immediate tick (not wait for poll); trust theater-PC `RunningAppID` when Steam `gameid` lags; default poll 15s. Larger NOW PLAYING / LAST PLAYED badge on client. Deploy: `./recreate.sh` + presence reporter on the gaming PC + portable client rebuild for badge.
- 2026-07-26: **App-launched Alexa Routines** — best-effort capture when Run-from-app leaves no ASR transcript: harvest all history item types (`activity-fields`), poll on `ws-notification-change` + raw `command`, map automations via `getAutomationRoutines` (`routine-index`), resolve bare “Sent to Display”, sample misses to `data/unmatched-activities.jsonl`. Deploy: `./recreate.sh`.
- 2026-07-26: **Slideshow camera-roll thumbs** — opening the tab no longer races `GET /api/photos` against SSE `hello` (identical lists skip re-render so in-flight `<img>` fetches aren't aborted); thumbs load eagerly with a one-shot cache-bust retry. Deploy: refresh admin UI / `./recreate.sh` if static files aren't volume-mounted.
- 2026-07-26: **Steam auth test push + key precedence** — `.env` `STEAM_API_KEY` always wins; admin Save key only writes `data/steam-session.json` (blocked with 409 when `.env` is set). Auth card **Test: push Now Playing** → `POST /api/push/steam-now-playing` (skips presence allowlist; last-played fallback, dismissible). Deploy: `./recreate.sh` + portable client rebuild for last-played chrome.
- 2026-07-26: **Steam Now Playing** — poller + OpenID auth card; presence allowlist (default `MOVIETHEATERPC`); persistent `steam.now-playing` overlay suppressed on other Alexa/display pushes until a new Steam session.
- 2026-07-26: **Quick Push second row** — admin Push tab adds **Guest Snaps**, **Indoor Air Quality**, **Indoor Temperature**, and **Show Alarms** (8 tiles / two rows of four). APIs: existing `POST /api/push/guest-photobooth` plus `air-quality`, `indoor-temperature`, `alarms` (`requestAlarmPoll` → `show-alarms`). Deploy: bridge `./recreate.sh` (static admin UI is volume-mounted).
- 2026-07-26: **Guest snaps slideshow phrase + UDP `sentAt`** — preferred Alexa command is **"open guest snaps slideshow"** (welcome remains **"open guest snaps"**); ASR normalizes "slide show". LAN crypto freshness uses seal-time `sentAt` so delayed Alexa history timestamps no longer drop overlays. Deploy: bridge `./recreate.sh` + redeploy portable client.
- 2026-07-26: **LAN UDP AES-GCM encryption** — optional shared secret (`.env` `LAN_UDP_SECRET`, client `udpSecret`) encrypts all bridge↔display UDP (`:47832` / `:47833`) with AES-256-GCM (v3 envelope). No handshake; pointer stays one datagram. Empty secret keeps plaintext for local smoke. Deploy: set the same secret both sides, `./recreate.sh`, rebuild/redeploy portable client (`cryptography` dep).
- 2026-07-26: **Alexa Guest Snaps slideshow voice** — voice command pushes Shared Photo Slideshow (`photo.slideshow`) of every stored QR-cache photo to **all displays** (order + seconds-per-photo from Settings). Distinct from **"open guest snaps"** (dual-QR welcome). Needs `PROXY_OWN_IP` (or booth URL host) so photo URLs are absolute. Deploy: bridge `./recreate.sh`.
- 2026-07-26: **Auto Now Playing after next/skip** — voice `next` / `skip` / `next song` etc. (`music-skip`) fetch player-info (prefer title change), then push `music.playing`. Bare next/skip is gated by `isMusicPlayerContent` so flash briefing/news/Audible advances stay silent; explicit "… song/track" still shows. No empty card on skip failure. Deploy: bridge `./recreate.sh`.
- 2026-07-26: **Guest Snaps rebrand + layout polish** — primary Alexa phrase is **open guest snaps** (photobooth is legacy; Alexa steals bare "photobooth"). Overlay title once, no nested outer frame, dedicated "then" band so text never overlaps; Smart Home on/off portrait stack redistributes empty space into gaps under the button. Web booth header says Guest Snaps.
- 2026-07-26: **Alexa Guest Snaps dual-QR welcome** — pushes `guest.photobooth` to **all displays** (Wi‑Fi QR + booth URL). Settings from `.env` / mounted `.env` / `data/guest-photobooth.json`; admin smoke via `POST /api/push/guest-photobooth`. Needs bridge `./recreate.sh` after deploy and a client build that includes `GuestPhotoboothPanel`.
- 2026-07-26: **Guest photo booth + password-protected `/admin`** — public `/` is a phone photo booth (display picker + camera/upload → photo QR push); the full Signal SPA moved to `/admin/` behind `ADMIN_PASSWORD` (HTTP-only session cookie, login at `/admin/login.html`). Non-photo QR push and all other APIs require admin; photo upload/push + displays + `/qr-images/*` stay public.
- 2026-07-26: **Slideshow time-per-photo setting** — Settings tab gains a **Time per photo** slider (5–60s) beside Playback order; persisted in `data/slideshow-settings.json` as `secondsPerPhoto` and applied to `photo.slideshow` UDP pushes (`displaySeconds` = count × seconds). `GET`/`POST /api/slideshow/settings` now return/accept both `order` and `secondsPerPhoto`.
- 2026-07-26: **Route Planner / weather geocode city+state** — Open-Meteo often returns nothing for phrases like "Las Vegas Nevada" / "Saratoga Springs Utah", so voice distance queries aborted silently before UDP. `geocodeLocation` now parses a trailing US state (full name or abbrev), searches the city with `count=10`, and picks the hit whose `admin1` matches (so Utah wins over New York for Saratoga Springs). Placeholder names `Home`/`here`/`local` are never geocoded.
- Privacy history rewrite: example LAN IP/fleet domain placeholders; portable zip untracked; household dumps/config removed from git history.
- 2026-07-26: **Photo QR push shows the picture (not just the code)** — `buildQrDisplayPayload` / `POST /api/qr/push` now accept `qrType`/`mode: "photo"` (Signal's Photo picker uses it). The display client's `QrPanel` renders those as a large photo with a small corner QR (slideshow-style) so viewers see the image they're about to save, while URL/Wi-Fi QRs keep the classic full-size code layout. Also fixed the Shared Photo Slideshow client bug that left it stuck on "Loading photo…" (see client PROJECT.md).
- 2026-07-26: **Privacy — stop committing runtime/household data** — `data/**` is gitignored except `data/.gitkeep` (diagnose dumps, shopping-list cache, sessions, certs stay local only). Household indoor/air-quality room names and Alexa `entityId`s moved out of source defaults into local `data/config.json`; code keeps generic sample rooms/monitors without personal names or real entity IDs. Sensor lookup now passes config so local `entityId`s still resolve.
- 2026-07-26: **Fix "what's playing" / "what's this song" silent miss + Slideshow lightbox prev/next** — `matchesNowPlayingQuery` now normalizes apostrophe-less ASR (`whats playing` / `whats this song`), accepts a few more phrasings (`identify this song`), and falls back to Alexa's spoken now-playing answer when `description.summary` is empty on the first history poll. `voice-event-gate` no longer stalls `music-query` waiting for a spoken-response upgrade (only `music-play` still does). When player-info stays empty after retries, `scheduleMusicQueryRetry` now emits an explicit empty `music.playing` payload (`emptyNowPlaying`) instead of returning silently — client `MusicPanel` renders a clear "Nothing playing" card for that case. Slideshow Manager lightbox gained left/right arrow buttons, ←/→ keyboard navigation, and swipe-left/swipe-right on touch screens, plus a "Photo x of y" counter.
- 2026-07-26: **Slideshow Manager: live updates, Unselect All, and dialog polish** — `qr-image-cache.js` gained an `onChange(listener)` pub-sub (mirrors `display-registry.js`'s), fired after every `store()`/`delete()`; a new `GET /api/photos/events` SSE endpoint (`handlePhotoEvents`, same shape as `handleDisplaysEvents`) streams the fresh photo list on every change so **every open Slideshow Manager tab updates live** — a photo uploaded via QR or deleted from another browser session now shows up (or disappears) without any manual action. Added a manual refresh icon button to the toolbar as a fallback for browsers that block/drop the SSE connection. "Select All" is now a toggle — relabels to "Unselect All" once every visible photo is selected, and clicking it then clears the whole selection in one tap. Fixed the lightbox's close (×) button overlapping the top edge of the photo (moved inside the image with proper inset + a translucent backdrop) and gave the "Uploaded …" caption more breathing room above the Close/Delete buttons; the "Delete this photo?" confirm sheet was using the same 1fr/1.4fr button-width ratio as the asymmetric-label QR/URL sheets, which made a plain "Delete" button look oversized next to "Cancel" — new `.sheet-confirm`/`.sheet-subtext`/`.sheet-actions-confirm` styles give it equal-width buttons, a readable subtext size, and a compact, centered dialog layout instead of a full-width sheet.
- 2026-07-26: **Slideshow Manager (replaces 7-day photo auto-expiry) + client slideshow polish** — `qr-image-cache.js` no longer expires photos automatically (removed `cacheDays`/hourly sweep entirely); photos now live until deleted via new `delete(token)` + `POST /api/photos/delete` (single or multi-select). New web "Slideshow" tab (between Control and Settings) is a camera-roll thumbnail grid with a lightbox (shows upload date, per-photo delete) and a "Select" mode for bulk delete, all behind themed confirm sheets. New `src/slideshow-settings.js` persists a playback-order preference (`recent`/`oldest`/`random`, Settings tab segmented control, `GET`/`POST /api/slideshow/settings`) that the bridge applies whenever it builds the `photo.slideshow` UDP payload — `buildPhotoSlideshowPayload` now takes `{url,uploadedAt}` photo objects (still accepts bare URL strings) and sorts them per that setting. QR generator mode tabs reordered to **Photo | URL | Wi-Fi**. Client `PhotoSlideshowPanel` plays through the set once (no more wrap-around), shows "Photo x of y" + a "Shared …" date label + a small corner QR linking to the current photo, and the overlay now hides the "Dismisses in…" countdown text specifically for `photo.slideshow` (the underlying timer still auto-dismisses once the pass completes).

- 2026-07-25: **Route Planner voice feature (bridge side)** — new voice-triggered "how far is X from here" / "distance between X and Y" / "how long to drive to X" / "directions to X" queries. New `src/route-query.js` (`matchesRouteQuery`/`extractRouteLocations`, mirrors `weather-location.js`; "here"/"home" resolve to `voiceEvents.defaultLocation`) and `src/route-fetch.js` (`fetchDrivingRoute` — OSRM public demo, no key; `greatCircleEstimate` haversine + flat cruise-speed "flight" fallback when OSRM has no route, e.g. overseas). `listener.js` geocodes both places (`weather-fetch.js`'s `geocodeLocation`, reused), tries the driving route, falls back to the great-circle estimate, then sends a single lean `route-planner.query` UDP payload (`buildRoutePlannerPayload` in `udp-payload.js`) — deliberately fast (≤2 geocode calls + 1 OSRM call) and containing only names/coords/mode/distance/duration/route line. New `voiceEvents.routeQueries` config toggle (default true). Map tiles, place facts and weather for the display client are intentionally **not** in this payload — see client-side plan for the async per-tile fill-in approach.
- 2026-07-25: **Fix first "what's playing" ask after "next"/"skip" not displaying** — `fetchNowPlaying`'s `music-query` fetch budget (`{attempts: 2, delayMs: 800}`) was too tight: right after "Alexa, next" the player-info API can stay mid-transition (old track fading, new one not yet reporting `PLAYING` + title) for a couple seconds, so the fetch gave up and `listener.js`'s music branch just `return`ed with no fallback — unlike every other kind (Tesla battery, shopping list, Vivint, notifications) which schedule a follow-up. Bumped the initial budget to `{attempts: 3, delayMs: 900}` and added `scheduleMusicQueryRetry()` (`listener.js`): when the first attempt still comes up empty, it retries the live player-info fetch directly (not a history re-poll — the activity/response are already complete, only Amazon's separate player API hadn't settled) at +2.5s and +4s, sending the `music.playing` payload the moment a track shows up. Previously the user had to manually ask "what's playing" a second time to get a fresh attempt at a moment the track had stabilized.
- 2026-07-25: **Larger keyboard, full-string text input, Shared Photo Slideshow + 3 more Quick Push tiles** — Control tab's on-screen keyboard keys are bigger (taller, more padding/gap, larger font) and easier to hit on a phone. Added a "Send Text" card (Control tab) that types a whole string in one shot via new `input.text` UDP payload (`buildInputTextPayload`) → `POST /api/input/text` → client `handle_text()` (`pynput` `Controller.type()`, optional Enter press) — makes pushing logins/passwords/URLs far faster than the on-screen keyboard. Push tab gained a "Quick Push" row of 4 tiles under the Tesla cards: **Shared Photo Slideshow** (new `photo.slideshow` UDP payload/`PhotoSlideshowPanel` — cycles every non-expired QR-cache photo from the last 7 days, 5s each by default, sized/centered for portrait or landscape, and is immediately interrupted by any other incoming payload since the panel owns no exclusive lock), **Weather Forecast**, **Shopping List**, and **Active Timers** (weather/shopping-list synthesize a voice-query event through the existing pipeline; timers call a new `listener.requestTimerPoll()` for an immediate Amazon notifications poll). New endpoints: `GET /api/photos`, `POST /api/push/photo-slideshow`, `POST /api/push/weather`, `POST /api/push/shopping-list`, `POST /api/push/timers`, `POST /api/input/text`.
- 2026-07-25: **Fix permanently-blocked repeat broadcasts + "what song is playing" display** — `BroadcastParser`'s content dedup (`parser.js`/`bridge-state.js`) fingerprinted `device|message` in a plain `Set` with **no expiry**, persisted forever via `data/bridge-state.json` and rebuilt from the entire `data/voice-events.jsonl` history on every restart. A common test phrase like "this is a test" broadcast once would silently never display again — the whole point of the fingerprint check is only to catch the *same* utterance being reported twice (push event + history poll, normally seconds apart), not to block a deliberate repeat sent later. `recordedFingerprints` now stores `{fp, ts}` (last-seen timestamp) and `BroadcastParser.isDuplicateContent()` only treats it as a duplicate within `DUPLICATE_CONTENT_WINDOW_MS` (2 min); legacy plain-string entries from old state files migrate as already-expired so previously-stuck messages unblock immediately on upgrade. Also added `matchesNowPlayingQuery` (`music-info.js`) so asking **"what song is playing"** / "which song is playing" / "what is this song" / "what's playing" now surfaces the existing `music.playing` overlay (album art + track info) via a new `music-query` trigger — same payload/panel as the "play \<song\>" flow, just without waiting ~6s for playback to start (`fetchNowPlaying` uses fewer/faster retries for this trigger since the track is presumably already playing).
- 2026-07-25: **Desktop-width Push tab layout + lock-screen spacing** — Web Browser and QR Code cards were each their own grid "section" (label + card), so on a wide desktop browser window the 2-column grid gave each section its own full-width row with the second column sitting empty. Wrapped both in `.push-columns`/`.push-column` (flex) so they sit side-by-side above `min-width: 860px` (width-based, not orientation-gated, so it also engages on wide portrait/tablet windows) while staying stacked on mobile. `.control-lock` ("Display locked" on the Remote/Control tabs) gained a 22px top margin so it no longer crowds the sticky display-bar divider — it had no section-label above it to supply that gap like every other tab's first card does.
- 2026-07-25: **QR code generator (Push tab)** — new `qr.display` UDP payload (`udp-payload.js`: `buildQrDisplayPayload`, `buildWifiQrContent`); phone UI adds a mode-tabbed card (URL / Wi-Fi / Photo). Photo mode uploads a client-resized JPEG to `POST /api/qr/image-upload`, stored by new `src/qr-image-cache.js` under `data/qr-image-cache/` and served at `/qr-images/<token>.<ext>` until it expires (`qrImage.cacheDays`, default 7 — hourly sweep + immediate on-access expiry); the resolved URL is then pushed like any other URL QR via `POST /api/qr/push`. The bridge only ever ships a content string — the display client renders the QR bitmap locally with the new `qrcode` Python dependency (`QrPanel` in `display_panels.py`).
- 2026-07-25: **Timer cancel voice detection hardened** — `TIMER_CANCEL_RE` in `voice-query-parser.js` only tested `description.summary`; some Alexa activity records leave that blank for bare command utterances and only populate the spoken confirmation, so cancel commands could be silently dropped. Added `TIMER_CANCEL_RESPONSE_RE` to also match the confirmation text ("Cancelling your timer." / "Your timer has been cancelled.", either word order) as a fallback. Also extended `timer-sync.js`'s post-voice-hint followup polls from 5 tries (up to 15s) to 7 tries (up to 25s, `VOICE_HINT_FOLLOWUP_DELAYS_MS`) so a slow-to-propagate Amazon cancellation is still caught before the next routine 30s background poll.
- 2026-07-24: **Control UI works under reverse-proxy prefixes** — `index.html` sets `<base href>` from the browser path and loads CSS/JS/logo relatively; `app.js` resolves `/api/...` via `appUrl()` so fetch/SSE stay under the mount (path-stripping proxies to `:47810`).
- 2026-07-23: **Discover refresh prunes offline displays** — `POST /api/displays/discover` waits ~2.5s for re-announces then removes anyone who stayed silent (`scheduleDiscoverSweep` in `display-registry.js`); Signal UI Refresh uses the pruned list and toasts when offline displays were dropped.
- 2026-07-23: **Signal-only Docker containers** — listener is `signal-bridge`; one-shot auth is `signal-alexa-auth` / `signal-tesla-auth`. `recreate.sh` restarts the listener with `--remove-orphans` and removes any leftover auth/pre-rename containers (they are never needed again).
- 2026-07-23: **GitHub/repo rename to `signal-bridge`** — GitHub repo, npm package name, Docker image/container/service, and docs use Signal Bridge; old `alexa-broadcast-bridge` image is auto-tagged when present. Local NAS folder may still be named `alexa-broadcast-bridge` until renamed on disk.
- 2026-07-23: **PIN sheet above keyboard** — PIN unlock sheet is centered (not bottom-docked) and tracks `visualViewport` `--keyboard-inset` so the phone keyboard cannot cover the PIN field; viewport uses `interactive-widget=resizes-content`.
- 2026-07-23: **Consistent lock + standard touchpad** — Remote tab hides power actions behind the same "Display locked" panel as Control; unlock expires 1h after PIN entry on both sides (`CONTROL_TOKEN_TTL_MS` in `app.js`, `sessionMinutes` default 60) and the header lock icon now locks on tap when unlocked; touchpad gains standard two-finger gestures — tap = right click, slide = scroll (wheel via `input.pointer`) — nudge arrow buttons removed.
- 2026-07-22: **Signal Bridge branding** — product renamed from Alexa Broadcast Bridge; phone UI title **Signal** with logo/favicon; README hero uses `docs/signal-bridge-logo.png`.
- 2026-07-22: **PIN UX + stale display prune** — wrong PIN shows inline error on the control sheet (`control_auth_incorrect_pin`); successful verify sends `display.auth` with `auth.status: ok` (1s Authenticated flash); registry **removes** displays that miss re-announce (~12 min / 2 heartbeats); web PIN hint omits timeout (client may differ) and locks input to 4 digits.
- 2026-07-21: **Display id + PIN unlock** — duplicate `displayName` values stay unique via per-machine `display.id` / picker `label` (`Name · ab12`); mouse/keyboard/power require on-screen 4-digit PIN (`display.auth`) then a per-display `controlToken`.
- 2026-07-21: **Control keyboard Shift vs Caps** — Shift one-shots the next key; Caps latches letters only; SPA JS/CSS served `no-store` + mtime cache-bust (phones were caching sticky-Shift keyboard logic).
- 2026-07-21: **Docs — full feature map** — root `README.md` / `DOCKER.md` / client `README.md` cover display announce, control page, WebView2 browser, remote input; `package.json` description updated.
- 2026-07-21: **Control tab iPhone layout** — solid sticky display bar (no hint bleed), always-visible touchpad + nudge arrows, CSS-grid keyboard that stays aligned on narrow screens, scroll-to-top on tab switch.
- 2026-07-21: **Display announce reachability + live picker** — announces use dedicated `:47833` (not overlay `:47832`); clients unicast to `bridgeHosts` (LAN broadcast often never hits the NAS). Control page listens via `GET /api/displays/events` SSE so new displays appear without refresh. Host-network Docker does not need UDP port publish.
- 2026-07-21: **Display discovery + remote mouse/keyboard** — clients announce `display.announce` (start + every 5 min); bridge registry + control-page picker (default first display, All last). Targeted push/remote via `target.id` + unicast; `input.pointer` / `input.key` only for a single display (touchpad + full on-screen keyboard). Refresh = `display.discover` broadcast.
- 2026-07-21: **Persistent Tesla callback on :4381** — when `TESLA_REDIRECT_URI` is a public domain, the bridge binds the local callback at web-server startup (Apache proxy no longer gets connection refused between logins). Idle `/callback` returns a “start Authenticate Tesla” page.
- 2026-07-21: **Tesla phone OAuth via Fleet domain proxy** — Tesla rejects LAN IP redirect URIs. Phone flow uses `https://fleetapi…/callback` (CA cert on Pi) proxied to NAS `:4381`; `resolveCallbackListen` separates public redirect URI from local HTTP bind. LAN-IP HTTPS self-signed callback kept only for loopback/dev.
- 2026-07-21: **Tesla phone OAuth HTTPS callback** — local callback can use TLS via `web-tls.js` when redirect/listen is https loopback.
- 2026-07-21: **Control page HTTPS + live camera QR** — self-signed TLS via `web-tls.js` (`https://<NAS_IP>:47810/`, optional HTTP redirect `:47811`). Scan QR uses `getUserMedia` + jsQR/BarcodeDetector (iOS Chrome needs the secure context + accepted cert). Photo capture remains as fallback.
- 2026-07-21: **Mobile control page + web browser display** — new `src/web-server.js` + `src/web/` SPA (Push / Remote / Settings; QR photo decode via vendored jsQR). New UDP payloads `web.open` / `web.close` / `system.command` (`udp-payload.js`). Listener exposes `recordVoiceEvent`/`sendUdpPayload`; `index.js` starts the web server after the listener and installs the auth-proxy patch at startup. Phone-based Tesla OAuth (on-demand :4381 callback) and in-process Alexa re-auth with restart-on-success. Config: `webServer.{enabled,port:47810}`. Client side: WebView2 overlay host (see client `PROJECT.md`).
- 2026-07-12: **Duplicate re-display fix (timestamp-aware dedup)** — `voice-event-dedup.js` now remembers each emitted activity *instant* (fingerprint + `creationTimestamp`, 30-min retention) in addition to the 2-min rolling fingerprint window. History polls re-read the same records for the whole 15-min lookback; after the 2-min window expired those re-reads re-displayed the command (e.g. "ask vivint to arm" showing again minutes later). Re-reads carry the *same* creation timestamp and are now suppressed indefinitely, while a genuinely repeated command produces a new record/timestamp and still displays. Late spoken-response upgrades of an already-shown record (>2 min) are also suppressed.
- 2026-07-12: **Hourly background cache refresh** — new `background-cache-refresh.js` (started from listener) refreshes weather (default location), shopping list, indoor air quality, and Tesla battery/dashboard caches every hour. Tesla uses `fetchTeslaDashboardIfOnline` (never wakes a sleeping vehicle — protects Fleet free-tier credit). New `weather-cache.js` / `air-quality-cache.js`; voice weather/air-quality paths save on success and fall back to cache on failure. Config: `backgroundCache` in `config.example.json`.
- 2026-07-11: **Weather location: warning-idiom guard** — `extractWeatherLocation` (`weather-location.js`) no longer mines the spoken response for a city when the query has a local marker ("outside"/"here"/"my area"/…); those default to the configured location. A new `LOCATION_STOPWORD_RE` rejects non-place phrases (effect/warning/until/degrees/weekdays/…) so Alexa answers like "a warning is in effect until Tuesday morning" can't be parsed as a location. Spoken-response mining still applies to truly generic queries ("what's the weather"). Mirrored client-side in `weather_fetch.py` (`_LOCAL_SCOPE_RE`, `_LOCATION_STOPWORD_RE`, gated `resolve_location_for_fetch`).
- 2026-07-11: **Cache-first Tesla + capture robustness + indoor mishear guard** — (1) Tesla battery/dashboard queries now send the cached snapshot instantly flagged `stale+refreshing` (`buildRefreshingReading`/`buildRefreshingDashboard` in the cache modules) while the live Fleet fetch runs; the live payload replaces it. The `request.processing` ack is only sent when no cache exists. (2) Listener polls history every 15s while the push channel is down (60s when up), polls immediately on `ws-disconnect`, and treats `ws-todo-change`/`ws-content-focus-change`/`ws-media-change`/`ws-unknown-command` push traffic as capture hints (debounced 2s poll) — fixes "show my shopping list" arriving up to 60s late when the interaction emitted no PUSH_ACTIVITY. (3) Indoor temperature queries naming an unmatched location (e.g. a second Echo mishearing a room name as "palmyra") are no longer displayed with no data: `resolveIndoorQueryLocation` lets a matched spoken-response room override an unmatched query phrase, `voice-event-gate` defers unmatched indoor queries for the spoken-response upgrade, and the listener drops them entirely when no reading ever materializes.
- 2026-07-11: **Processing acknowledgment for slow requests** — `buildProcessingAckPayload` (`udp-payload.js`) sends an instant `request.processing` UDP payload for Tesla battery/dashboard queries (Fleet API configured only) before the slow fetch starts. Payload carries `request.title/source/timeoutSeconds(45)/stages[]` (staged reassurance messages at 0/5/12/25s). The real data payload replaces the placeholder; on failure the existing error payload does. Fast kinds (weather, shopping list, music, …) intentionally get no ack — sub-3s loading states hurt UX.
- 2026-07-09: **Time display flicker** — `resolve_time_display_datetime` prefers parsed hour/minute over ISO/activity timestamp (UTC activity time showed as wrong local hour, e.g. 4:15 PM before 10:15 PM); bridge `parseSpokenTime` builds ISO in `alarmSync.localTimeZone`.
- 2026-07-09: **Media volume display** — `formatMediaVolumePercent` converts Tesla cabin volume (0–11 scale) to `volumePercent` on dashboard `media`; client shows e.g. `21% volume` instead of raw `vol 2.3333`.
- 2026-07-09: **Tesla battery voice phrase** — canonical routine trigger is **"show tesla battery"** (optional `my`/`the` still match); tests and smoke payloads updated.
- 2026-07-09: **Charge time to full** — `estimateTimeToFullChargeMin` in `tesla-dashboard-data.js` computes remaining range at the current `charge_rate` (mi/hr) instead of treating Tesla's `time_to_full_charge` (hours) as minutes; falls back to `minutes_to_full_charge` or `time_to_full_charge * 60`. Dashboard battery exposes `timeToFullChargeMin`. — `voice-event-dedup.js` fingerprints `vivint-alarm`/`alexa-notifications` by kind|device|query (not activity id) so push/history/response records of one command dedupe together; spoken-response upgrades that render identical content are suppressed; `pending-voice-responses.tryComplete` returns `sourceActivityId` and the listener retires the original query activity. `parseAlarmStatusFromSpeech` now reads stay/away mode from the query so the initial display is complete.
- 2026-07-08: **Battery cache fallback** — new `src/tesla-battery-cache.js` persists last good `tesla-battery.query` reading; throttled/rate-limited/offline fetches serve cached % with `stale`, `staleReason`, `cachedAt`, `freshnessSec` (also reads dashboard cache when no dedicated battery cache).
- 2026-07-08: **Dashboard wake retry** — after `wake_up`, `fetchTeslaVehicleData` polls `vehicle_data` up to 3 times (4/6/8s backoff) before giving up, so a sleeping car recovers instead of returning "Vehicle unavailable". FSD mileage note: Fleet API only exposes it via Fleet Telemetry streaming (`SelfDrivingMilesSinceReset`, HW4 + fw 2025.44.25.5+), not `vehicle_data`, so `odometer.fsdMilesPercent` stays null on live fetches.
- 2026-07-08: **Dashboard cache fallback** — new `src/tesla-dashboard-cache.js` persists the last good dashboard; failed fetches serve the cached snapshot marked `stale` instead of an empty error screen. Software tile mapping fixed: idle cars (`software_update.status === ''`) report `updateAvailable: false`, `downloadPercent: null`, "Up to date" (no more "downloaded 0%").
- 2026-07-08: Dashboard data enrichments — `media.source` maps opaque numeric firmware codes to friendly names (Bluetooth device name / station fallback, else null); `odometer` adds `lastChargeAddedMiles`, `serviceDueInMiles` (tire-rotation countdown, 6,250 mi interval), `serviceIntervalMiles`.
- 2026-07-08: Dashboard `map.locationLabel` is `null` (instead of "Location unavailable") when geodata missing, so the display client falls back to raw GPS coordinates on its live map.
- 2026-07-08: **Tesla dashboard location scope** — added `vehicle_location` to OAuth scopes; dashboard retries without `location_data` when scope missing (map shows re-auth hint).
- 2026-07-08: **Alarm time fix** — `alarm-sync.js` parses `originalDate` + `originalTime` when `triggerTime`/`alarmTime` are zero; `remainingTime` fallback.
- 2026-07-08: NAS Tesla helper scripts — `tesla-register.sh`, `tesla-verify-register.sh`, `tesla-auth.sh`, `tesla-status.sh`, `docker-compose.tesla-auth.yml`.
- 2026-07-08: **Tesla Fleet API battery** — live fetch via `tesla-fleet-client.js`; OAuth (`tesla-auth`), register (`tesla-register`), token keepalive; error/rate-limit payloads; display shows charging label + retry time.
- 2026-07-06: **Wake alarms** — `"show my alarms"` / `"set alarm for 7 am"` poll Amazon `Alarm`/`MusicAlarm` notifications across all devices; UDP `alarm.snapshot` highlights the newly added alarm.
- 2026-07-06: **Indoor air quality multi-monitor** — `summarizeMonitorReadings` merges VOC/PM2.5/CO/temp/humidity from the richest monitor reading into the top-level payload reading.
- 2026-07-06: **Indoor air quality multi-monitor** — `"show indoor air quality"` parses qualitative bands ("pretty good") and per-monitor summaries (main floor, dome, machine room); no longer mislabels "Well, the" as a location.
- 2026-07-06: **Unified event log** — broadcasts/announcements now append to `data/voice-events.jsonl` (same JSONL as voice queries and timers). Legacy `broadcast.txt` is read on startup for dedup migration only; no longer written.
- 2026-07-06: **Vivint alarm + Alexa notifications** — `"ask Vivint to arm"` / disarm → `vivint-alarm.query` with parsed stay/away status; `"show my notifications"` → `alexa-notifications.query` with parsed notification items. Config toggles: `vivintAlarmQueries`, `notificationQueries`. Pending response correlation when command/response split across activities.
- 2026-07-06: Empty notifications fix — phrases like "you have no new notifications at the moment" show **0 notifications** instead of treating the sentence as one notification.
- 2026-07-06: Shopping list show uses API as source of truth; filters Alexa narration ("first 3", "all of them") from speech/cache merge.
- 2026-07-06: **Fix Tesla battery + shopping list show** — defer `markProcessed` until emit (push events without Alexa response no longer block history retry); `voice-event-gate.js` waits for spoken response on shopping show too; broader speech parse for item lists.
- 2026-07-06: Tesla/music events wait for Alexa spoken response before display; dedup allows upgrade when response arrives after empty push event.
- 2026-07-05: Custom routine **"show my tesla battery"** → `tesla-battery.query` UDP payload with parsed battery % from Alexa's spoken answer. Config toggle: `teslaBatteryQueries`.
- 2026-07-05: Shopping list finds Amazon `SHOPLIST` type (was missing items); persistent `data/shopping-list-cache.json` merges adds across commands; speech fallback on show when API empty.
- 2026-07-04: DOCKER.md update flow — NAS has no git; the share is the working copy, so updates are just `./recreate.sh --build` (git push/pull happens on the PC only).
- 2026-07-04: **Weather accuracy fix** — Open-Meteo `is_day` requested; clear skies at night map to `clear-night` (not sunny); hourly window converts location-local API times via `utc_offset_seconds` (Docker/UTC-safe) and starts at the in-progress hour. Removed stale `readme.txt` (DOCKER.md covers ops).
- 2026-07-04: **Token keep-alive fix** — vendored patched cookie refresh that skips `/auth/register` (Amazon rejects it during refresh); tokenDate now rotates instead of dying at ~24h. New `src/auth-refresh-patch.js` + `src/vendor/alexa-cookie-refresh.js` + tests.
- 2026-07-04: Voice routing — generic “what’s the temperature” + spoken “degrees in [room]” routes to indoor, not weather; outdoor only when explicitly outside/weather.
- 2026-07-03: Air quality overlay — intercept "what is the air quality"; parse IAQ score + monitor location from Alexa response; optional Smart Home enrich for PM/CO/VOC/temp/humidity; `air-quality.query` UDP type.
- 2026-07-03: Indoor temperature overlay — location-specific thermostat queries vs generic outdoor weather; alias map; comfort bands; `indoor-temperature.query` UDP type; `npm run diagnose-indoor`.
- 2026-07-03: Token rotation tracking — detect stale tokenDate, reauth_recommended at 16h, fix refresh-in-flight false failures; weather parser unicode apostrophe fix.
- 2026-06-23: Aggressive token refresh (2h min age, 8h proactive, 18h stale watchdog + noop retries); `scripts/dump-auth-diagnostics.sh`.
- 2026-06-23: Timer cancel detection — diff against API snapshot; emit empty/updated list on cancel; cancel-voice followup polls.
- 2026-06-23: Timer sync emits on new timer set (count increase); fire priority over started; broader timer-set detection; weather location from spoken response; named-location geocoding; `run_all_tests.bat` + 44 bridge / 25 client tests; `--test-force-exit` on npm test.
- 2026-06-27: Voice events (time/weather queries) + timer sync with UDP v2 typed payloads; `npm test` suite.
- 2026-06-27: Smarter refresh handling — noop classification, verify-before-degrade, refresh folded into ping cycle.
- 2026-06-26: Fix liveness probe parsing (`getDevices` returns `{ devices: [] }`); stop false session_degraded/recovered churn.
- 2026-06-24: Added this PROJECT.md; documented vendored auth proxy, session keep-alive, QNAP Docker patterns, UDP protocol.
- 2026-06-24: Reauth port cleanup, `src` volume mount, `--no-build` workflows, `port-utils.js`.
