# Signal Bridge — project map

> **For AI agents:** Read this file first when working on the NAS/container code.  
> **Keep fresh:** Update this file whenever you change architecture, modules, config, Docker, auth, or UDP behavior. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-08-23 (Autodarts board Error status)

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
| `src/parser.js` | Detects announce/broadcast utterances; two-step prompt pairing (same- or cross-device when Alexa confirms); never treats “Announcing on all devices” TTS as the message; `historyPollStartMs` keeps a 2-min overlap after the last capture so a newer one-shot cannot hide an earlier follow-up; uses `broadcast-parse` to prefer a single ASR fragment and strip duplicated `", broadcast …"` echoes |
| `src/broadcast-parse.js` | Parse/clean broadcast utterances (`resolveBroadcastUtterance`, `cleanBroadcastMessage`) — Amazon often stores wake+repeat ASR that used to display as `"msg, broadcast msg"` or `", broadcast"` |
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
| `src/steam-*.js` | Steam Now Playing: config/session/OpenID auth (callback requires one-time `state` from admin start), Web API + store appdetails, presence allowlist, poller with interrupt-suppress, UDP builders |
| `src/psn-*.js` | PSN Now Playing (unofficial `psn-api`): NPSSO → tokens in `data/psn-session.json`, `getBasicPresence` poller, played-games/trophy enrich, fail-soft Chihiro Store Plan B (`psn-store.js` — description + real screenshots + stars), Admin NPSSO paste + manual preview, UDP `psn.now-playing` |
| `src/activity-fields.js` | Harvest summary/response/allText from all `voiceHistoryRecordItems` types (app routines often skip ASR) |
| `src/routine-index.js` | Cache `getAutomationRoutines()`; map name/trigger/action phrases → voice kinds; resolve bare “Sent to Display” |
| `src/display-voice-commands.js` | Matchers for Alexa routines that push display overlays without needing Alexa’s spoken answer: trivia, Steam/PSN library tours, Steam/PSN/YouTube now-or-last-played (`requestedMode: 'auto'`) |
| `src/upside-news-*.js` | **The Upside News** — Guardian + positive RSS archive, period selection, filters/ranking, settings, credentials (`GUARDIAN_API_KEY` / encrypted `data/guardian-credentials.json`), UDP `upside-news.round`; topic artwork under `/upside-news-artwork/` |
| `src/wiki-common-knowledge-*.js` | **Wiki Common Knowledge** — Wikimedia featured/pageviews + summary/history, day-list cache under `data/wiki-common-knowledge-cache/`, settings in `data/wiki-common-knowledge-settings.json` (required contact email for User-Agent), denylist + description→topic map, UDP `wiki-common-knowledge.round`; artwork under `/wiki-common-knowledge-artwork/` |
| `src/overhead-*.js` | **Overhead (flight radar)** — public ADS-B fetch (adsb.lol → adsb.fi → airplanes.live; the last now 403s unregistered clients), adsbdb route/type enrichment, settings in `data/overhead-settings.json`, live session poller (`overhead.round` / `overhead.update` / `overhead.close`); home lat/lon from `voiceEvents.defaultLocation`; static GeoJSON at `/overhead-geo/` |
| `src/web/overhead-geo/` | Placeholder `home-area.json` + sample `airports.json` for Overhead scope map |
| `src/web/wiki-common-knowledge-artwork/` | Topic JPEGs (20 categories) for Wiki Common Knowledge (seeded from Upside/trivia packs when missing) |
| `src/web/upside-news-artwork/` | Shipped topic JPEGs (13 × portrait/landscape) for The Upside News |
| `src/unmatched-activity-log.js` | Cap-append `data/unmatched-activities.jsonl` for unmatched history rows (debug app Runs) |
| `tools/steam-presence-reporter/` | **Optional** fallback only — normally presence is piggybacked on the theater PC’s `display.announce` (`hostname` + `steamAppId`) |
| `src/command-registry.js` | **Single source of truth for pushable pages.** `COMMANDS[]` descriptors (`id`, `title`, `group`, `route`, `icon`, `body`, `pushable`, `schedulable`, `supportsContentCheck`, `variableDuration`, `defaultDurationSeconds`, `params`); `createCommandRegistry(deps)` binds live state for `hasContent(id)` / `estimateDuration(id, params)`. Served at `GET /api/commands`; the admin Push grid renders from it and the Display Scheduler enumerates rules from it. `assertValid()` rejects duplicate ids and duration contradictions |
| `src/display-registry.js` | Known displays from announces; persist `data/displays-registry.json`; prune after ~12 min without re-announce; **discover sweep** drops silent displays after Refresh (~2.5s); resolve target → unicast host |
| `src/message-details.js` | Parse sender/destination/message for broadcast payloads |
| `src/udp-payload.js` | Build typed UDP payloads (broadcast, time, weather, indoor temperature, timer, reminder, `qr.display`, `guest.photobooth`, `input.text`, `photo.slideshow`, `route-planner.query`) |
| `src/voice-query-parser.js` | Detect time/weather/indoor temperature/timer/reminder/music/route/guest-photobooth/trivia/library-tour/platform-now-playing voice queries from history |
| `src/voice-event-dedup.js` | Suppress re-displays: activity-id + 2-min window, 30-min instants, content keys for vivint/notifications; **smart-home** keys on device+action+target so Amazon’s delayed `lights on` fragment does not replay |
| `src/guest-photobooth.js` | Match "open guest snaps" (dual-QR welcome) + "open guest snaps slideshow" (Shared Photo Slideshow; ASR "slide show" / legacy "slideshow guest snaps") + legacy "guest photobooth"; `photosToSlideshowEntries` builds absolute `/qr-images/…` URLs; resolve Wi‑Fi SSID/password + booth URL from `.env` (`GUEST_WIFI_*`, `GUEST_PHOTOBOOTH_URL`) |
| `src/guest-snaps-auth.js` | Rotating 24h 6-digit Guest Snaps booth PIN (`data/guest-snaps-pin.json`); `signal_guest` session until PIN expiry; progressive IP lockout; PIN only for UDP overlay / never in phone JSON |
| `src/route-query.js` | Detect distance/directions voice queries (`matchesRouteQuery` + incomplete-ASR `looksLikeRouteQuery`); extract `{origin, destination}` place names from the query or Alexa's spoken answer (`extractRouteLocations`, incl. incomplete "distance from PLACE" → wait for TTS; `spokenHasRouteAnswer` for orphan miles TTS; dedupe comma-joined ASR + strip query tails from place names) |
| `src/route-fetch.js` | Free/no-key route data: OSRM driving route (`fetchDrivingRoute`) with great-circle "flight" fallback (`greatCircleEstimate`) when no drivable route exists |
| `src/music-info.js` | Detect "play \<song\>" (`matchesMusicQuery`), "what song is playing" (`matchesNowPlayingQuery` — apostrophe-less ASR + TTS-only fallback including `X by Y is playing on Amazon Music` / `Here's X by Y, on Amazon Music`), and "next"/"skip" (`matchesMusicSkipQuery`); `fetchNowPlaying` / `fetchNowPlayingHousehold` / `resolveMusicQueryNowPlaying` (idle/unknown preferred like web `Signal` → skip preferred retries, scan household PLAYING then PAUSED + parse spoken "X by Y"); `fetchNowPlayingAfterSkip`; `isMusicPlayerContent` gates out flash briefing/news/Audible; `emptyNowPlaying` only when nothing is playing anywhere |
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
| `src/reminder-sync.js` | Poll Amazon notifications API; mirror active `Reminder` rows; wake at fire time; UDP `reminder.fired` |
| `src/alexa-alarms.js` | Detect show/set/cancel wake-alarm voice commands (distinct from Vivint security) |
| `src/alexa-reminders.js` | Detect reminder set/cancel/fire from ASR + TTS (`I'll remind you to…` / `Here's your reminder`) |
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
| `src/web-server.js` | **HTTPS web UI**: guest photo booth at `/`, password-gated admin SPA at `/admin/` (`ADMIN_PASSWORD`); JSON API (public: displays + photo upload/push + `/qr-images/*`; admin: status, Tesla/URL/weather/shopping/timers/slideshow, QR URL/Wi‑Fi, Slideshow Manager, remote input, auth); TLS via `web-tls.js` |
| `src/web-admin-auth.js` | Admin login sessions (HTTP-only cookie) for `/admin` + protected APIs; progressive per-IP lockout on bad passwords (in-memory; cleared on container restart) |
| `src/web-tls.js` | Loads/generates cert in `data/web-certs/` (camera QR needs HTTPS on iOS Chrome); reuses existing PEMs (e.g. Let's Encrypt from `issue-letsencrypt-cert.sh`); optional `WEB_TLS_CERT_FILE` / `WEB_TLS_KEY_FILE` |
| `src/qr-image-cache.js` | Stores "QR code → embedded photo" uploads under `data/qr-image-cache/` **indefinitely** (no automatic expiry) — serves them back at `/qr-images/<token>.<ext>`; writes compact JPEG grid thumbs at `/qr-images/thumbs/<token>.180.jpg` (on upload, startup backfill, and on-demand `ensureThumb` via `sharp`); `list()` returns every stored photo newest-first with `{token,path,thumbPath,thumbReady,createdAt}` for the Slideshow Manager tab / Shared Photo Slideshow tile; `delete(token)` removes original + thumb; `onChange(listener)` fires on every `store()`/`delete()`/thumb ready (with the fresh `list()`) so `GET /api/photos/events` (SSE) can push live camera-roll updates to every open browser tab |
| `src/slideshow-settings.js` | Persists Shared Photo Slideshow prefs — playback order (`recent` \| `oldest` \| `random`, default `recent`) and seconds per photo (5–60, default 5) — to `data/slideshow-settings.json`; getters reload from disk so admin UI and Alexa voice stay in sync |
| `src/roll-credits-store.js` | Roll Credits storage: atomic `data/roll-credits.json` CRUD, permanent induction numbers, list/filter/page, canonical-system mapping, duplicate warnings, dashboard stats, and mutation listeners used by SSE |
| `src/roll-credits-settings.js` | Roll Credits persisted media/scrape/display/size settings in `data/roll-credits-settings.json`; getters reload from disk and writes use temp-file rename |
| `src/roll-credits-systems.json` | Shipped canonical console/handheld/PC list and IGDB platform-id mapping for Roll Credits |
| `src/roll-credits-credentials.js` | Encrypted IGDB client id/secret persistence; `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` environment values take precedence and block admin replacement |
| `src/roll-credits-providers.js` | Roll Credits IGDB + Steam adapters: Twitch token caching, 4/s IGDB spacing, platform mapping, negative lookup caching, provider-order fallback, and gap-only enrichment |
| `src/roll-credits-scraper.js` | Add-from-candidate/manual flows plus scoped re-scrape modes; scraper metadata never writes difficulty and scrape replacement preserves uploads/YouTube rows |
| `src/roll-credits-media.js` | `data/roll-credits-media/` paths, 360px sharp thumbs, capped image uploads, direct/yt-dlp downloads, priority resolution, disk usage, and orphan cleanup |
| `src/roll-credits-jobs.js` | Restart-safe sequential media download queue; persists ready/failed state and exposes change listeners for later SSE wiring |
| `src/roll-credits-service.js` | Roll Credits facade joining store, settings, credentials, providers, scraper, media, and jobs; owns API-facing change events, upload/delete/retry helpers, and maintenance/status hooks |
| `src/autodarts-settings.js` | Live/dashboard/last-match/sync defaults in `data/autodarts-settings.json` |
| `src/autodarts-credentials.js` | Encrypted Autodarts tokens + board choice; `AUTODARTS_EMAIL`/`PASSWORD` env wins with 409 overwrite |
| `src/autodarts-api.js` | Read-only HTTP client (GET + `auth/v1` login / device / refresh only; Keycloak removed) |
| `src/autodarts-auth.js` | Device-link preferred + email/password fallback; refresh + re-link flag |
| `src/autodarts-archive.js` | Month-partitioned `data/autodarts-matches/*.jsonl` with matchId dedupe |
| `src/autodarts-aggregates.js` | `data/autodarts-players.json` — weighted X01 avg, ranking, rivalry, records |
| `src/autodarts-history.js` | Cloud Match History sync (`GET /as/v0/matches/filter` + per-match stats); local archive is offline cache |
| `src/autodarts-payload.js` | UDP `autodarts.match` / `.close` / `.dashboard` builders |
| `src/autodarts-live.js` | WS supervisor via `play.ws.autodarts.com` + `ws` package: board match → auto-push, interrupt-resume, inactivity, FINAL hold, archive; board-state poll backup |
| `src/autodarts-service.js` | Facade for Settings card, Test/board picker, push helpers |
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
8. **Reminder sync:** same notifications poll for `type: Reminder` → UDP `type: reminder.fired` when one comes due (also matches Alexa TTS “Here's your reminder…”)
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
| `LAN_UDP_SECRET` (`.env`) / `udpBroadcast.sharedSecret` | **Required on a real LAN.** Shared secret for AES-256-GCM on UDP; must match each client's `udpSecret`. Empty = plaintext (startup warns; forgeable reboot/input/web.open — local smoke only) |
| `udpBroadcast.discoveryPort` | Listen for `display.announce` (default **47833**) |
| `sessionKeepAlive.*` | Ping/refresh/liveness/proactive intervals, `failureThreshold`, `livenessProbe` |
| `routePlanner.displaySeconds` | Overlay dismiss for `route-planner.query` (default **max(180, 2× `udpBroadcast.defaultDisplaySeconds`)**; explicit number overrides). Separate from the standard overlay duration so map/facts tiles have time to fill in |
| `voiceEvents.enabled/timeQueries/weatherQueries/indoorTemperatureQueries/airQualityQueries/teslaBatteryQueries/fetchWeather/fetchAirQuality/routeQueries/triviaQueries/steamLibraryTourQueries/psnLibraryTourQueries/steamNowPlayingQueries/psnNowPlayingQueries/youtubeNowPlayingQueries` | Voice capture toggles (platform overlays default on) |
| `voiceEvents.defaultLocation` | `{ name, latitude, longitude }` for generic/outdoor weather queries and as the implicit "here"/"home" origin for route-planner queries |
| `indoorTemperature.coldBelowF/hotAboveF` | Comfort bands for display (defaults 68 / 74) |
| `indoorTemperature.locations[]` | Thermostat/sensor names/aliases/`entityId` (local `data/config.json`; empty = generic built-in list) |
| `airQuality.defaultMonitor` | Fallback monitor when query/response has no location (e.g. `main floor`) |
| `airQuality.monitors[]` | Air monitor names/aliases/`entityId` (local `data/config.json`; empty = generic built-in list) |
| `voiceEvents.eventsLogFile` | Default `data/voice-events.jsonl` — all captured events (broadcasts + voice + timers) |
| `timerSync.*` | Poll intervals, mirror file, fire-verify slack |
| `alarmSync.*` | Alarm poll/mirror; `localTimeZone` for `originalDate`/`originalTime` (default `America/Denver`) |
| `reminderSync.*` | Reminder poll/mirror/wake; same `localTimeZone` fallback as alarms |
| `teslaFleet.*` | Fleet API region, domain, VIN, keep-alive, `minRequestIntervalSec` |
| `webServer.enabled/port` | Control web page HTTPS port (default enabled, `47810`) |
| `webServer.https` | `true` (default) — TLS; required for live camera QR on iOS |
| `webServer.httpRedirectPort` | Optional plain HTTP redirect to HTTPS (default `47811`; set `0` to disable) |
| `webServer.certDir` / `certHosts` | Cert folder (`data/web-certs`) and extra SAN hostnames/IPs (self-signed only) |
| `WEB_TLS_CERT_FILE` / `WEB_TLS_KEY_FILE` | Optional PEM path overrides |
| `issue-letsencrypt-cert.sh` | Host wrapper: `docker exec -it` Certbot DNS-01 inside the container, then `docker restart` |
| `scripts/issue-letsencrypt-inside.sh` | In-container Certbot (state under `data/letsencrypt/`, PEMs → `data/web-certs/`) |
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

When `LAN_UDP_SECRET` is set, datagrams are a **v3 envelope** (`aes-256-gcm`); the decrypted inner JSON is still the v2 payload below. Without a secret, v2 JSON is sent plaintext (**dev/smoke only** — do not run a household install this way).

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
| `reminder.fired` | Alexa reminder coming due — `reminder.{label,device,triggerTime}`; voice TTS *or* `Reminder` notification disappearing near `fireAt`. Not a broadcast (no FROM/TO) and not the notifications inbox |
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
| `photo.slideshow` | Alexa **"open guest snaps slideshow"** (also "guest snaps slideshow" / legacy "slideshow guest snaps") **or** Push tab "Shared Photo Slideshow" — `slideshow.{photos[], secondsPerPhoto}`; `photos` is every photo in the QR image cache as `{url, uploadedAt}` (photos never expire — see `qr-image-cache.js`), ordered by the bridge per the persisted Settings-tab preference (`recent`\|`oldest`\|`random`). Guest Snaps / admin Photo QR queues of **two or more** also push this type with just that queue (`order:"queued"`). `displaySeconds` = `photos.length * secondsPerPhoto` so the whole set gets shown once. Voice path fans out to **all displays**. Client plays through the list once (does not loop). Timer/alarm **followup** polls after a prior “show timers/alarms” stay silent unless something changed (so they do not steal the slideshow); the client also ignores soft timer/alarm list refreshes while `photo.slideshow` / `guest.photobooth` is up (still yields to explicit show / fired) |
| `steam.now-playing` | Auto: persistent game card from (1) Steam profile **`gameid`**, else (2) fresh local presence `steamAppId`, else (3) OwnedGames activity that **advanced past an idle baseline** and is within `STEAM_INFER_FROM_RECENT_SEC` (default 180). Idle clock advances only on OwnedGames playtime/rtime growth; matching `gameid`/presence soft-keeps until `STEAM_RECENT_PLAY_HARD_IDLE_SEC` (default 600). Re-detecting the same app soon after an idle close **resumes** the original `startedAt` (no elapsed reset). Announce without `steamAppId` clears that host’s presence. Close via `steam.now-playing.close` |
| `psn.now-playing` | Auto: persistent card while PSN `getBasicPresence` reports `gameTitleInfoList` (PS5/PS4). Enriched with playtime/last-played from `getUserPlayedGames` + best-effort trophies by title name. Manual Auth preview / last-played is dismissible. Close via `psn.now-playing.close`. **Unofficial API** — NPSSO auth; can break if Sony changes endpoints |
| `route-planner.query` | "How far is Moab from here" / … — progressive UDP: (1) skeleton with place names (`status: loading`), (2) geocoded coords (still loading; client starts map/weather), (3) distance/duration/geometry (`status: ready`) or `failed`. Origin/destination geocode in **parallel** (≤3 lookups, 10s abort) + OSRM (12s abort → great-circle flight). `displaySeconds` = **max(180, 2× default)** (override `routePlanner.displaySeconds`). Client still fetches map/facts/weather tiles independently |

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
npm test                    # bridge only (1144 tests)
run_all_tests.bat           # repo root — bridge + Windows client (1144 + 586)
```

Bridge tests in `test/*.test.js` — includes **Autodarts** (`autodarts-settings`, `autodarts-credentials` auth/device-link/env 409, `autodarts-api` read-only guard + admin routes, `autodarts-aggregates`, `autodarts-payload` byte bounds, `autodarts-live` interrupt/inactivity/archive), **YouTube** (`youtube-api` — call counting: a first play is exactly 3 calls and a replay 0, same-channel reuse, stats-only refresh past the 6h TTL, large-channel 30d TTL, 50-id batching, 24h negative cache, degraded-not-thrown failures, image cache + 90-day prune keeping avatars, restart reuse, quota/hit-rate readout; `youtube-lounge` — NDJSON framing across chunks, restart backoff, confirm debounce, ad suppression including the explicit-`ad`-event rule and the wedge guard, `watchedSeconds` from position deltas vs pause/seek, session boundaries, multi-TV ordering, prefetch gating; `youtube-now-playing` — payload shape for playing/last-played/live/missing, display toggles, Shorts suppression, multi-device selection, manual-preview fallbacks, device linking with encrypted tokens, history cap, command registration; `secret-box` — round trip, nonce reuse, tamper detection, env-key override, legacy plaintext), **Display Scheduler** (`display-scheduler`, `display-busy` — stale AQ/Tesla refresh must not overwrite a newer Steam/PSN page, `scheduler-api`), **Trivia** (`trivia-providers`, `trivia-pool`, `trivia-payload`), **Steam poller integration** (`steam-now-playing-poller` — mocked `steam-api` tick: gameid open, OwnedGames keep-alive / quit absorb / inference, presence gate, interrupt restore re-push, immediate presence tick, manual last-played preview), **Steam API OwnedGames** (`steam-api-owned` — `rtime_last_played` → ms), **music empty/retry** (`music-empty-and-retry` — `emptyNowPlaying`, `musicQueryRetryOutcome`, companion-weather suppress), **UDP LAN round-trip** (`broadcast-udp` — seal/send/open + encrypted announce + plaintext reject), **voice orchestration** (`voice-orchestration` — Steam suppress rules, smart-home payload, guest-snaps slideshow trigger, `sentAt`≠activity timestamp, multi-ASR activity fields), plus existing: `tesla-fleet`, `tesla-udp-payload`, `tesla-auth-status`, `tesla-battery`/`tesla-battery-cache`, `tesla-dashboard`/`tesla-dashboard-data`/`tesla-dashboard-cache`, voice-event gate/dedup (smart-home wake+repeat vs delayed `lights on` fragment), `pending-voice-responses` (route TTL + cross-device reject), `parser` (legacy fingerprint migration + broadcast ASR dedupe + two-step TTS-ack / cross-device / lastRecorded overlap), `web-command-payloads` (progressive route loading/failed), `qr-image-cache`, `route-query`/`route-fetch` (OSRM AbortSignal + 12s timeout), `guest-photobooth`, `guest-snaps-auth` (24h 6-digit booth PIN + lockout), `slideshow-settings`, `lan-crypto`, `web-server`/`web-tls`/`web-admin-auth` (guest booth PIN gate; admin PIN sheet 6 digits; Guest Snaps/admin Photo QR queue — single stays `qr.display`, 2+ is `photo.slideshow` in queued order, max 20), `display-control-auth` (default 6-digit PIN), `display-registry`, `music-info` (Signal preferred skip), `activity-fields` (`customerParts`/`responseParts`).

Client tests in `alexa broadcast client/test/test_*.py` — 546 tests; see client `PROJECT.md` Testing section. Install via `requirements-test.txt` (pulls `requirements.txt`).

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

Served by the listener at **`https://<NAS_IP or hostname>:47810/`** (config `webServer.{enabled,port,https}`; TLS in `data/web-certs/` — self-signed by default, or Let's Encrypt PEMs via `./issue-letsencrypt-cert.sh` → Certbot inside the container). Optional HTTP→HTTPS redirect on **47811**.

| URL | Who | What |
|-----|-----|------|
| `/` | Guests | Photo booth — **6-digit PIN gate** (rotates every 24h; PIN shown on `guest.photobooth` overlay). After unlock: pick a display, queue one or more photos (camera or camera roll), then send — one photo is `qr.display` photo mode; two or more is `photo.slideshow` of just that queue |
| `/admin/` | Host | Full SPA (Push / Remote / Control / Slideshow / Settings), gated by `ADMIN_PASSWORD` (.env) via login form + HTTP-only session cookie |
| `/admin/login.html` | Host | Admin password form |

Public APIs: `GET /api/displays` (+ events SSE), `GET /api/guest/session`, `POST /api/guest/login|logout|request-pin`, `GET /qr-images/*`. Photo upload/push require a **guest** (`signal_guest`) or **admin** session. Everything else requires an admin session. If `ADMIN_PASSWORD` is unset, admin APIs fail closed (503).

**Reverse-proxy subpaths:** the SPA uses a dynamic `<base href>` (from `location.pathname`) plus relative asset/API URLs, so a path-stripping proxy (e.g. public `/signal/` → bridge `/`) works without hardcoding a prefix. Prefer a trailing slash on the public mount URL.

**iPhone / Chrome QR:** open the **https** URL once, accept the certificate warning (Advanced → Proceed), then **Scan QR Code** uses the live camera (`getUserMedia` + jsQR). Plain HTTP cannot use the camera on iOS — put your NAS IP in `webServer.certHosts` (or `PROXY_OWN_IP`) before first cert generation, or delete `data/web-certs/` and restart after updating hosts.

**JSON API:**

| Route | Effect |
|-------|--------|
| `GET /api/displays` | Known displays from `display.announce` registry (`id` unique; `label` disambiguates duplicate names) |
| `GET /api/displays/events` | SSE stream — pushes `displays` events whenever the registry changes |
| `POST /api/displays/discover` | Broadcast `display.discover`, wait ~2.5s for re-announces, prune silent displays; returns `{ displays, removedIds }` |
| `POST /api/displays/auth/start` | Show 6-digit PIN on selected display (`display.auth`); required before mouse/keyboard/power |
| `POST /api/displays/auth/verify` | `{targetId,pin}` → `controlToken` session for that display |
| `POST /api/displays/auth/status` | Unlock / challenge status for a display |
| `GET /api/guest/session` | Guest booth auth status (`authenticated`, `expiresAt`, `pinDigits`) — never includes the PIN |
| `POST /api/guest/login` | `{pin}` → `signal_guest` cookie until the daily PIN expires; progressive IP lockout on failures |
| `POST /api/guest/logout` | Clear guest session cookie |
| `POST /api/guest/request-pin` | Push `guest.photobooth` (with current PIN) to all displays; phone response omits the PIN |
| `POST /api/push/tesla-dashboard` / `tesla-battery` | Synthetic event (`trigger: "web-api"`) through `listener.recordVoiceEvent`; body may include `targetId` |
| `POST /api/push/weather` / `shopping-list` | Synthetic voice-query event (`trigger: "web-api"`) through `listener.recordVoiceEvent`, same as if Alexa had been asked — cached weather/shopping data is served immediately |
| `POST /api/push/air-quality` | Synthetic `air-quality` event (`show indoor air quality`) → multi-monitor indoor AQ overlay |
| `POST /api/push/indoor-temperature` | Synthetic `indoor-temperature` event for the first configured indoor sensor (or "temperature inside") |
| `POST /api/push/guest-photobooth` | Guest Snaps dual-QR welcome + booth access PIN on **all displays**; **503** if Wi‑Fi/booth URL not configured |
| `POST /api/push/timers` | Calls `listener.requestTimerPoll()` for an immediate Amazon notifications poll → UDP `timer.snapshot`; **503** if the hook isn't wired (older listener) |
| `POST /api/push/alarms` | Calls `listener.requestAlarmPoll()` for an immediate Amazon alarms poll → UDP alarm snapshot; **503** if the hook isn't wired |
| `POST /api/push/url` `{url,targetId?}` | Validate → UDP `web.open` (unicast when one display selected) |
| `POST /api/push/close-browser` | UDP `web.close` |
| `POST /api/qr/push` `{mode:"url"\|"wifi"\|"photo", url\|photos[]\|(ssid,password,security,hidden), label?, targetId?}` | URL/Wi-Fi → UDP `qr.display`. Photo mode: one URL → `qr.display` (`qrType:"photo"`); two or more (`photos`/`urls`, max 20) → `photo.slideshow` in **queued** order (not the whole camera roll) |
| `POST /api/qr/image-upload` `{imageDataUrl}` | Store a base64 photo (`qr-image-cache.js`, kept indefinitely) → `{path,token,createdAt}`; resolve `path` against `document.baseURI` client-side, then push through `/api/qr/push` (`mode:"photo"`) |
| `GET /qr-images/<token>.<ext>` | Serves a stored photo — 404s only if the token is unknown or was deleted |
| `GET /api/photos` | Lists every stored photo (newest-first) with `{token,path,createdAt}`, for the Slideshow Manager tab's camera roll and the "Shared Photo Slideshow" tile preview/count; also the manual-refresh fallback for `/api/photos/events` |
| `GET /api/photos/events` | SSE stream (same pattern as `/api/displays/events`) — pushes a `photos` event with `{reason,photos}` on connect (`reason:"hello"`) and again on every `store()`/`delete()` from *any* browser tab, so every open Slideshow Manager tab's camera roll stays live without polling |
| `POST /api/photos/delete` `{token}` or `{tokens:[]}` | Deletes one or more photos from the cache (Slideshow Manager tab, single or multi-select) → `{deleted:[],failed:[]}` |
| `GET /api/slideshow/settings` | Current Shared Photo Slideshow playback order (`{order,orders}`) |
| `GET`/`POST /api/slideshow/settings` | Read/update `{order, secondsPerPhoto}` in `data/slideshow-settings.json` (Settings tab — order segmented control + 5–60s time-per-photo slider) |
| `POST /api/push/photo-slideshow` `{photos:[{url,uploadedAt}],targetId?,order?}` | Builds UDP `photo.slideshow` from the given photos, reordered per the persisted slideshow setting unless `order:"queued"` keeps send order; 404→400 with a friendly message when there are no photos |
| `POST /api/system/reboot` / `poweroff` | UDP `system.command` |
| `POST /api/input/pointer` / `key` | Relative mouse / key injection — **requires** a single `targetId` (not All) |
| `POST /api/input/text` `{value,pressEnter?,targetId?}` | Full-string keyboard input (logins/passwords/URLs) — UDP `input.text`; same PIN/`controlToken` gate as pointer/key |
| `POST /api/auth/tesla/start` | Returns Tesla authorize URL + opens one-shot local callback (default `http://0.0.0.0:4381`, 10-min timeout) → `saveTokensFromCode`. Public `TESLA_REDIRECT_URI` (e.g. `https://fleetapi…/callback`) must be proxied from the Fleet domain host to that listen port |
| `POST /api/auth/alexa/start` | Runs vendored login proxy in-process (`runAuth({exitOnComplete:false, overrides:{proxyOwnIp}})`, port 3456; `proxyOwnIp` derived from request Host); on success the bridge saves the session and **exits 0** so Docker `restart: unless-stopped` brings it back fresh |
| `GET /api/status` | Alexa/Tesla auth state, active pushed URL, uptime |

QR scanning (reading a code with the phone) is client-side: `<input type="file" capture>` photo → jsQR decode → confirm sheet → `POST /api/push/url`. `installAuthProxyPatch()` now runs at the top of `index.js` (before `alexa-remote2` loads) so the in-process login proxy works in listener mode.

**QR generator** (Push tab, separate from scanning above) lets the phone display a QR code on the target screen, mode tabs ordered **Photo | URL | Wi-Fi**: **Photo** (queue one or more JPEGs — camera roll multi-select or add-another after a camera shot — upload each to `/api/qr/image-upload`, then `/api/qr/push` `mode:"photo"`; one photo is a hero QR, two or more is a slideshow of just that queue), **URL** (plain link), or **Wi-Fi** (SSID/password → standard `WIFI:T:...;;` string, escaped via `buildWifiQrContent`). The bridge never renders a bitmap — it only ships the content string in `qr.display`; the display client generates the QR image locally.

**Slideshow tab** — camera-roll manager for everything in the QR image cache: thumbnail grid loads compact `/qr-images/thumbs/…` JPEGs (full originals only for the lightbox / display slideshow; missing thumbs fall back until backfill finishes), kept live via `GET /api/photos` + `GET /api/photos/events` SSE plus a manual refresh icon button; tap to open a lightbox with the upload date and a Delete button (left/right arrow buttons + ←/→ keyboard keys + swipe on touch screens to step between photos, with a "Photo x of y" counter), "Select" mode for multi-select + a "Select All"/"Unselect All" toggle + bulk delete, all deletes behind a themed confirm sheet (`POST /api/photos/delete`). The grid refreshes automatically when a photo is uploaded or deleted from any browser tab/session — no manual refresh needed unless the SSE connection is blocked/dropped. Settings tab gains a "Playback order" segmented control (Newest first / Oldest first / Shuffle) and a "Time per photo" slider (5–60s) that persist to `data/slideshow-settings.json` via `GET`/`POST /api/slideshow/settings` and are applied by the bridge whenever `/api/push/photo-slideshow` builds the UDP payload.

---

## Recent changes

- 2026-08-23: **Autodarts YOUR BOARD never shows Error** — Board Manager `state.status: Error` (and failed/fault/starting) canonicalises to Stopped when connected, Offline when not; raw fault strings are not sent on the wall. Deploy: `./recreate.sh`. Tests: `test/autodarts-payload.test.js`.

- 2026-08-23: **Roll Credits cover-hero display** — when cover + screenshots are ready, cards use the cover as hero and keep screenshots in the strip (portrait no longer looks empty). Deploy: `./recreate.sh`. Tests: `test/roll-credits-payload.test.js`.

- 2026-08-23: **Autodarts last successful match + multi-player FINAL** — last-match / now-playing skips aborted and 0–0 empty shells; live empty “finished” events abort instead of FINAL; FINAL banner lists every player (not only first two). Deploy: `./recreate.sh` + portable client rebuild. Tests: `autodarts-payload`, `autodarts-live`, `test_autodarts_panel`.

- 2026-08-23: **Roll Credits re-scrape keeps title/system** — re-scrape rematches IGDB/Steam by the current title + system (including unsaved edit-sheet values), never flips the System dropdown to the first option (NES) when systems reload, and accepts admin scope arrays. Cache-bust `?v=signal75`. Deploy: `./recreate.sh`. Tests: `test/roll-credits-scraper.test.js`.

- 2026-08-23: **Autodarts board stats + dashboard spacing** — board card reads `detections`/`state.status` from GET `/bs/v0/boards` list (detail often zeros stats); status shows Running/Stopped instead of Unknown; dashboard title “AUTODARTS DASHBOARD”; looser totals/board/H2H spacing. Deploy: `./recreate.sh` + portable client rebuild.
- 2026-08-23: **Autodarts board card + live fallback** — dashboard UDP includes `board` (name, online/Running, version, up-to-date, OS, darts/corrections/accuracy from `/bs/v0/boards`); `autodarts.now` skips empty live shells and shows the last finished match with players/legs. Cache-bust not required for UDP. Deploy: `./recreate.sh` + portable client rebuild. Tests: `test/autodarts-payload.test.js`.
- 2026-08-23: **Autodarts display polish + defaults** — dashboard labels clarified (Last played, readable leaderboard lines, Head-to-head / House records); default leaderboard size 12; admin cache-bust `?v=signal74`. Cloud history Sync remains on confirmed `/as/v0/matches/filter`. Deploy: `./recreate.sh`. Portable client rebuild for panel layout.
- 2026-08-23: **Autodarts cloud history** — confirmed `GET /as/v0/matches/filter` (play Match History); Sync history + startup/6h schedule import finished matches into the local archive (stats per match; list-only fallback on 404). Local archive is the offline cache when cloud sync fails. Cache-bust `?v=signal73`. Deploy: `./recreate.sh`. Tests: `test/autodarts-history.test.js`.
- 2026-08-23: **Roll Credits Filters compact** — open Filters is a single content-sized row (system chips wrap as needed; year + “No date” sit beside chips). Removed the wide two-column stretch that left a tall empty band. Cache-bust `?v=signal72`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts OAuth UI** — Advanced override keeps aligned Client ID / Client secret fields (optional only in placeholder); dropped redundant “Use darts-caller” button. Built-in client stays `darts-caller` (required by Autodarts auth). Cache-bust `?v=signal71`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts live + denser Settings** — live WS uses `wss://play.ws.autodarts.com/ms/v0/subscribe` (ticket + `boardId.matches` topics), `ws` package for Node 20, board-state poll backup; Settings is a compact 2-col Connection | Live/On-screen grid with footer actions and OAuth under Advanced. Cache-bust `?v=signal70`. Deploy: `./recreate.sh --build` (new npm dep).
- 2026-08-23: **Tesla sticky re-auth** — Fleet refresh tokens rotate; keep-alive and API refreshes now share one single-flight lock, recover from race failures, clear `tesla-auth-status.json` on healthy session/OAuth/API success, and retry once on vehicle 401 before demanding re-auth. Deploy: `./recreate.sh`. Tests: `test/tesla-token-refresh.test.js`.
- 2026-08-23: **Autodarts board + sync UX** — auto-saves the only board after link (dropdown looked selected but Test said “no board selected”); Sync history disables until backfill is confirmed. Cache-bust `?v=signal68`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts auth migration** — Keycloak (`login.autodarts.io`) is dead; link/login/refresh now use `api.autodarts.io/auth/v1/*` with default client `darts-caller` (secret optional). Legacy `developer-darts-caller` is remapped. Device approve URL is `auth.autodarts.com/link`. Cache-bust `?v=signal67`. Deploy: `./recreate.sh`.
- 2026-08-23: **Roll Credits filters** — shared collapsible Filters panel (collapsed by default) on grid and list; active-count badge + Clear; selected systems stay visible with `· 0` after the last matching game is retagged (no silent empty list). Cache-bust `?v=signal66`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts Settings UX** — OAuth client id/secret editable in admin (Fill from helper + browser link), Device link vs Email & password mode picker (one at a time), immediate busy toasts, 15s Keycloak timeout with clearer errors. Cache-bust `?v=signal65`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts Settings spacing** — Account column separates device-link from email/password with a divider and consistent gaps so Email / Password / Sign in no longer crowd Link Autodarts. Cache-bust `?v=signal64`. Deploy: `./recreate.sh`.
- 2026-08-23: **Autodarts** — unofficial read-only Autodarts cloud integration: device-link/password auth, board picker, match archive + aggregates, dashboard / live / last-match UDP (`autodarts.*`), Settings card (cache-bust `?v=signal63`), Push group, optional voice (“show darts” / “darts dashboard”). History backfill stays off until the list endpoint is confirmed. Deploy: `./recreate.sh` + **portable client rebuild**. Tests: `test/autodarts-*.test.js`.
- 2026-08-23: **Roll Credits media reorder** — edit-sheet ↑/↓ can move video past covers/screenshots (no longer same-kind-only), list order syncs the game media-priority override, desktop drag-and-drop reorders rows, and `select.field-input` uses a centered custom chevron. Cache-bust `?v=signal62`. Deploy: `./recreate.sh`.
- 2026-08-23: **admin app.js syntax guard** — fixed a duplicate `zoomSlider` declaration from the Roll Credits mobile toolbar work that made `app.js` fail to parse (blank Push skeletons, stuck “connecting…”, Remote/Control never unhidden). Cache-bust `?v=signal61`. Test: `admin app.js parses and tab bar keeps remote/control…`. Deploy: `./recreate.sh`.
- 2026-08-23: **Roll Credits mobile admin** — phone layout stacks Add/search, puts Zoom on its own full-width row, clamps grid columns by viewport (2 on phones), and uses short bottom-tab labels (Credits / Sched / Slides) under 640px. Cache-bust `?v=signal60`. Deploy: `./recreate.sh`.
- 2026-08-23: **Roll Credits dashboard companions** — `getStats`/`computeStats` now include `beatenWith` leaderboard + `topBeatenWith` so the wall dashboard can show who games were beaten with most. Bridge deploy: `./recreate.sh`. Client fix for dashboard skip ships separately.
- 2026-08-23: **Roll Credits Arcade system** — mapped IGDB platform id `52` to a new canonical **Arcade** system so cabinets like Lucky & Wild get a system chip in search. Unmapped IGDB platforms still fall back to an **Other** chip instead of “No supported systems listed.” Deploy: `./recreate.sh`.
- 2026-08-23: **Roll Credits admin polish** — difficulty clear option is **N/A** (default); edit-sheet `#N` sits beside the title instead of overlapping the Title field; list view has its own `#` column; system filters only show systems you have recorded and wrap instead of a horizontal scrollbar; edit-sheet scrollbars use the dark theme tokens. Cache-bust `?v=signal57`. Deploy: `./recreate.sh`.
- 2026-08-23: **Roll Credits yt-dlp bump** — trailer downloads were failing with YouTube `HTTP 400` / “Precondition check failed” because the image pinned `yt-dlp==2025.1.15`. Pin is now `2026.8.19`, downloads prefer an android+web player client, and failure details are shortened for the admin media row. Cover/screenshots were never broken; Phase 1 display still skips video. Deploy: `./recreate.sh --build`, then Retry the failed video row.
- 2026-08-23: **Roll Credits Phase 1d push/scheduler + display contract** — added `credits.show`, the small `roll-credits.tour` UDP start packet, TTL playlist sessions, public playlist/card routes, image-only media resolution (video is deliberately skipped until Phase 2), manual looping vs scheduled walk-once duration, and admin Push trophy artwork. The Windows client owns dashboard/showcase rendering and must be rebuilt separately; bridge deploy with `./recreate.sh`. Tests: `test/roll-credits-payload.test.js`, command-registry and web route coverage.
- 2026-08-23: **Roll Credits Phase 1c admin UI** — added the phone-first Credits tab with grid/list views, search/filter/sort/pagination, selection and bulk actions, add/edit/media/re-scrape/delete sheets, live SSE refresh and the full-width Settings card for IGDB, media and display defaults. Admin cache-bust is `?v=signal56`; display panel and `credits.show` remain Phase 1d. Deploy with `./recreate.sh`.
- 2026-08-23: **Roll Credits Phase 1c backend APIs** — `web-server.js` now owns one shared Roll Credits service and exposes admin-gated game CRUD/bulk delete/search/re-scrape/media upload-delete-retry/jobs/stats/settings/credentials/events/systems/`prune-orphans` routes. Raw MP4/WebM PUT uploads stream through a capped temp file, media files are public with immutable caching, and SSE combines API mutations with background job changes. Deploy with `./recreate.sh`. Tests: `test/roll-credits-api.test.js`.
- 2026-08-23: **Roll Credits Phase 1b scraper + media** — added encrypted IGDB credentials, token-cached/rate-spaced IGDB and keyless Steam providers, metadata/media scraping and scoped re-scrape rules, capped uploads and 360px thumbs, media-priority resolution, disk/orphan helpers, sequential restart-safe download jobs, and the service facade. Steam app details now retain direct movie URLs. The Docker YouTube venv installs pinned yt-dlp; deploy with `./recreate.sh --build`. No admin routes/UI or display panel yet. Tests: `test/roll-credits-{credentials,providers,scraper,media,jobs}.test.js`.
- 2026-08-23: **Roll Credits Phase 1a foundation** — added the canonical 30-system/IGDB map, reload-safe atomic settings, atomic JSON game CRUD with permanent induction order and duplicate warnings, list/filter/pagination, and dashboard stats (12-month/system/decade/streak/milestone aggregates). No web-server wiring yet. Tests: `test/roll-credits-store.test.js`, `test/roll-credits-settings.test.js`.
- 2026-08-23: **“What's playing” with empty ASR now opens the music card** — Amazon often stores that ask as TTS-only (`Highlife by Cypress Hill is playing on Amazon Music` / `Here's … by …, on Amazon Music`) with no customer transcript, so the matcher never fired. Spoken-answer fallback now accepts those lines and parses song/artist from them. Deploy: `./recreate.sh`. Tests: `test/music-info.test.js`, `test/voice-query-parser.test.js`.
- 2026-08-22: **Stale indoor-AQ refresh no longer interrupts Steam/PSN** — admin Indoor Air Quality sends a cached card immediately, then a live enrich a few seconds later. Pushing Steam (or PSN) in that gap used to get yanked off by the late AQ UDP. `display-busy` now tracks a page-send generation; slow voice/admin refreshes (AQ, Tesla, music ack follow-ups) drop if a newer page already landed. Deploy: `./recreate.sh`. Tests: `test/display-busy.test.js`.
- 2026-08-22: **Delayed “lights on” no longer replaces a later photo** — Amazon writes one smart-home utterance as two history rows (~30–90s apart): `alexa lights on, lights on` then a new-id `lights on`. After trivia + an admin photo push, the fragment re-emitted and covered the QR. Smart-home dedup now keys on device + action + target (not activity id). A real repeat after the 2-min window, or lights off, still displays. Deploy: `./recreate.sh`. Tests: `test/voice-event-dedup.test.js`.
- 2026-08-22: **Rapid broadcasts after lights-off dropped two-step follow-ups** — unmatched log (16:49 lights off → 16:50:14 “Alexa, broadcast” prompt → 16:50:29 one-shot “heading to the garage”) showed completed announces never pairing. Parser fell back to `allText` (includes TTS) so “Announcing on all devices” became the card and cleared pending; history polls started at `lastRecorded+1`, so a later one-shot hid earlier follow-ups. Completion TTS is never the message; cross-device pairing works when Alexa confirms; history keeps a 2-min overlap. Deploy: `./recreate.sh`. Tests: `test/parser.test.js`.
- 2026-08-19: **Trivia “Stocking” was a stuck label, not a fetch** — the pill said Stocking whenever fewer than a round’s worth of *unplayed* questions remained (here: 4 of 464, after the 30-day no-repeat window). Per-category aim was `ceil(300/26)=12`, so **Fetch more** walked every topic, added nothing, stamped `lastRefillAt`, and looked finished. Aim is now at least 50 per category (one OpenTDB page); refill also grows when unplayed questions drop below the low watermark; Fetch more actually asks again. Admin copy distinguishes Restocking… / N ready / Stocking / N left. Cache-bust `?v=signal55`. Deploy: `./recreate.sh`. Tests: `test/trivia-pool.test.js`.
- 2026-08-19: **YouTube last-played no longer ignores the TV** — `youtube.last-played` skipped the Lounge poll and only read `youtube-history.json`, which had not gained a row since 15 Aug, so Signal aired a four-day-old video. Last-played now polls like auto and prefers whatever the Apple TV still reports (even Stopped/paused); Stopped watches past `confirmSeconds` are recorded into history without a live overlay; admin “seen” uses Lounge last video sighting, not last connect. Deploy: `./recreate.sh`. Tests: `test/youtube-lounge.test.js`, `test/youtube-now-playing.test.js`.
- 2026-08-16: **Alexa reminders display when they fire** — “remind me in an hour” / TTS “I'll remind you to check on the corn…” was unmatched; the due reminder never reached a display. New `alexa-reminders.js` + `reminder-sync.js` poll Amazon `Reminder` notifications (wake + `ws-notification-change`), and `reminder.fired` shows a dedicated overlay (label + Echo), not the broadcast FROM/TO chips. Deploy: `./recreate.sh` + portable client rebuild. Tests: `test/alexa-reminders.test.js`, `test/reminder-sync.test.js`, `test/voice-query-parser.test.js`.
- 2026-08-15: **Scheduler “Simulate next 24 hours” shows progress** — the button no longer just greys out during the 200-run forecast. A spinner and rotating status sit under it (forecast / dice rolls / scoring / averaging). Cache-bust `?v=signal54`. Deploy: `./recreate.sh`.
- 2026-08-15: **Admin Push tab no longer jumps on load** — Tesla / Quick Push tiles come from `GET /api/commands`, so Web Browser + QR Code used to paint first and get shoved down. Rows now paint matching skeleton tiles before that fetch. Cache-bust `?v=signal53`. Deploy: `./recreate.sh`.
- 2026-08-15: **Admin Photo QR upload uses one progress bar** — sending a queue no longer stacks “Uploading 1 of N…” toasts. A single in-card bar tracks upload then send; only the final success/error toast remains. Cache-bust `?v=signal52`. Deploy: `./recreate.sh`.
- 2026-08-15: **Admin Photo QR queue shows a small circular ×** — the remove control reused `.btn-icon` (48px + padding), which clipped the glyph into an empty square. It is now a 22px circle like the camera-roll select dots. Cache-bust `?v=signal51`. Deploy: `./recreate.sh`.
- 2026-08-15: **Guest Snaps + admin Photo QR can queue several pictures** — booth and Push-tab Photo picker accept multi-select (camera roll) and “Add more” after a camera shot (max 20). One photo still pushes `qr.display`; two or more push `photo.slideshow` of just that queue (`order:"queued"`). Cache-bust booth `?v=3`, admin `?v=signal51`. Deploy: `./recreate.sh`. Tests: `test/web-server.test.js` (single-item stays QR, 21 rejected, guest PIN can push a queued slideshow), `test/web-command-payloads.test.js`.
- 2026-08-15: **Overhead no longer dies on airplanes.live 403** — their public API now rejects unregistered projects (`Please contact us at contact@airplanes.live…`). The default provider tries adsb.lol, then adsb.fi, then airplanes.live, sticks to the last host that worked, and sends a SignalBridge User-Agent. Admin Test provider reports the source. Deploy: `./recreate.sh`. Tests: `test/overhead.test.js`.
- 2026-08-14: **Shopping list short remove updates the display** — “alexa remove onion almonds” never matched (only “remove X from my shopping list” did), so no overlay was sent. Short remove/delete/take now classifies as `shopping-list-remove`, strips wake+repeat ASR, drops the item if the API still has it, and pushes the current list. Long non-list “remove …” phrases stay unmatched. Deploy: `./recreate.sh`. Tests: `test/shopping-list.test.js`, `test/voice-query-parser.test.js`.
- 2026-08-14: **Shopping list no longer adds the ASR echo as a second item** — Amazon stores wake+repeat (“alexa add chocolate almonds, add chocolate almonds”); `extractAddedItem` used the whole tail, then `resolveShoppingList` merged it beside the real API item. Strip the repeated add, prefer Alexa’s “added X to your shopping list”, and sanitize leftover “X, add X” names. Regression covers the logged Snack Room query through parse → extract → resolve → UDP payload. Deploy: `./recreate.sh`. Tests: `test/shopping-list.test.js`, `test/voice-query-parser.test.js`.
- 2026-08-07: **Steam no longer resets elapsed mid-session** — false idle-close (OwnedGames playtime often does not tick for minutes) was followed by a “new launch” push with a fresh `startedAt`. Matching `gameid`/presence now soft-keeps until `STEAM_RECENT_PLAY_HARD_IDLE_SEC` (default 600); reopening the same app within the resume window restores the original `startedAt`. Deploy: `./recreate.sh`. Tests: `test/steam-now-playing-poller.test.js`.
- 2026-08-07: **Steam idle clock only trusts OwnedGames growth** — `lastActivityAt` no longer resets from bare profile `gameid` or local presence each poll. Launch handoff + presence clear kept. Deploy: `./recreate.sh`.
- 2026-08-07: **Steam idle close + launch handoff** — stagnant close no longer skipped by stuck presence; announce without `steamAppId` clears presence; closing no longer absorbs a different fresh OwnedGames launch into the idle baseline; mismatched presence loses to OwnedGames. Deploy: `./recreate.sh`.
- 2026-08-05: **Wiki CK empty-day cache** — today’s Wikimedia featured feed often omits `mostread` (and pageviews/top for “today” 404s); we were writing `articles: []` and then Push refused. Polls now walk back up to 3 days, never persist empty day lists, and selectArticles falls back to the newest non-empty cache. Deploy: `./recreate.sh`, then Refresh cache (or wait for the next poll).
- 2026-08-05: **Wiki CK hero image URLs** — UDP `imageUrl` is a bounded Wikimedia thumb (not the multi-MB original); enrich still fills missing images when the extract is already long; cache merge no longer wipes thumbs with empty feed fields. Deploy: `./recreate.sh`.
- 2026-08-05: **Wikipedia Common Knowledge rename** — Push/scheduler command title, UDP payload `title`, and admin Settings section label are consistently **Wikipedia Common Knowledge** (was “Common Knowledge”). Cache-bust `?v=signal48`. Deploy: `./recreate.sh`.
- 2026-08-05: **Slideshow thumbs unbroken without sharp** — admin grid falls back to the full original if a thumb 404s; when `sharp` isn't in the runtime, `list()` omits `thumbPath` (no invented `/thumbs/…` URLs). Real speed still needs `sharp` in the image: `./recreate.sh --build`. Cache-bust `?v=signal47`.
- 2026-08-05: **Slideshow thumbs made snappier** — grid never loads full originals (on-demand 180px JPEGs via `ensureThumb`); smaller encode; lazy-load below the first dozen cells; skip grid rebuilds when only thumb metadata changes. Cache-bust `?v=signal46`. Deploy: `./recreate.sh`.
- 2026-08-05: **Slideshow camera-roll thumbnails** — `qr-image-cache` writes 360px JPEG thumbs (`/qr-images/thumbs/<token>.jpg`) on upload and backfills existing photos at startup (`sharp`); admin Slideshow grid prefers `thumbPath` (full image stays for lightbox/display); thumbs get long-lived browser cache headers. Cache-bust `?v=signal45`. Deploy: `./recreate.sh` (npm install picks up `sharp`).
- 2026-08-05: **Overhead structured routes** — adsbdb enrichment emits `{ originCity, destCity, originIata, destIata, label }` on each aircraft (and `overhead.routes`) so the display can show origin → destination. Deploy: `./recreate.sh` + portable client rebuild.
- 2026-08-05: **Overhead + Wiki admin layout** — Wiki Common Knowledge and Overhead settings cards stretch full width (same as Upside/Trivia); Wiki refresh/backfill sit in one compact row with clearer spacing. Cache-bust `?v=signal44`. Deploy: `./recreate.sh`.

- 2026-08-05: **Overhead (flight radar)** — live ADS-B scope panel: `overhead-*.js` modules, airplanes.live provider + adsbdb enrichment, admin Settings card + Push/scheduler command `overhead.show` (Sky group), UDP `overhead.round` / `overhead.update` / `overhead.close`, home coordinates from `voiceEvents.defaultLocation`, static GeoJSON at `/overhead-geo/`. Tests: `test/overhead.test.js`. Deploy: `./recreate.sh` + portable client rebuild for the display panel.

- 2026-08-05: **Wiki Common Knowledge** — Wikipedia most-read index → article pages: `wiki-common-knowledge-*.js` modules (Wikimedia UA + contact email required, day/article cache, denylist, topic map), admin Settings card, Push/scheduler command `wiki.show` (Knowledge group), UDP `wiki-common-knowledge.round`, artwork at `/wiki-common-knowledge-artwork/`. Tests: `test/wiki-common-knowledge.test.js`. Deploy: `./recreate.sh` + portable client rebuild.

- 2026-08-04: **Upside News last-story slack** — push `displaySeconds` includes a few seconds so client timer drift does not clip the final story page. Deploy: `./recreate.sh` (+ portable client for the matching panel timing fix).

- 2026-08-04: **Upside News randomised rounds** — each push draws from a scored candidate pool and shuffles; recently aired story ids are remembered in the archive so the next push prefers different headlines. Deploy: `./recreate.sh`.

- 2026-08-06: **PSN card no longer shows trophy % as “PROGRESS”** — Sony only exposes trophy completion (Split Fiction correctly sat at 6% / 2 of 21 for hours of play), which read as stuck story progress. Footer third column is **PLAYS** (PSN `playCount` = times launched); status line says “played N times”. Trophy fetch prefers `getUserTrophiesForSpecificTitle(npTitleId)` over a single `getUserTitles` page + fuzzy name match. Deploy: `./recreate.sh` + portable client rebuild for the footer label. Tests: `test/psn-now-playing.test.js`, client `test_psn_now_playing_panel.py`.

- 2026-08-06: **YouTube detection reconnects after Lounge subscribe ends** — `pyytlounge` `subscribe()` returns when YouTube closes the long-poll; the agent used to exit the device task and never re-bind, so the TV stayed `linked` while auto-push and Now Playing/Last Played went silent (stale history only). Agent now loops refresh+connect+subscribe across normal endings; Node reconnects on hard `disconnected` with backoff, polls now-playing every 45s, and resurrects `not-connected` sessions. Deploy: `./recreate.sh` (src bind-mounted; rebuild only if the image lacks a current agent). Tests: `test/youtube-now-playing.test.js`.

- 2026-08-04: **Upside News admin** — Test uses the active `.env`/saved Guardian key unless you type a new one (ignores password autofill); clearer bridge→Guardian network errors; Refresh archive button moved under Display. Deploy: `./recreate.sh` (admin assets only).

- 2026-08-04: **The Upside News** — rotating positive-news panel (index → story pages) from Guardian Open Platform + curated RSS, local archive for daily/weekly/monthly/yearly, topic artwork pack, admin Settings + Push tile, scheduler command `goodnews.show` (variable duration). Env: `GUARDIAN_API_KEY` (or encrypted admin save). UDP `upside-news.round`. Deploy: `./recreate.sh` + portable client rebuild for the new panel/artwork. Tests: `test/upside-news.test.js`, client `test_upside_news_panel.py`.

- 2026-08-04: **Alexa routines for trivia / library tours / Now Playing** — voice + routine-index matchers (`display-voice-commands.js`) so custom routines named Trivia, Steam/PSN Library Tour, and Steam/PSN/YouTube Now Playing or Last Played push the matching overlay. NP/LP both use `requestedMode: 'auto'` (live if playing, else last played). Platform phrases run before bare music “what’s playing”. Toggles: `voiceEvents.triviaQueries` / `*LibraryTourQueries` / `*NowPlayingQueries` (default on). Deploy: `./recreate.sh` only — display client already handles these UDP types. Tests: `test/display-voice-commands.test.js`, `test/routine-index.test.js`.

- 2026-08-04: **New trivia category artwork pack** — replaced the magenta/pattern JPEGs in `src/web/trivia-artwork/` with the cinema/icon set from `dev assets/trivia-category-artwork/` (`{id}_{portrait|landscape}.png`, including `musicals-theater` → `musicals-theatre`). `/trivia-artwork/` prefers `dev assets` over the shipped pack and resolves hyphen↔underscore stems + theater/theatre aliases. Category `background` colours in `trivia-categories.json` resampled to the new art. Deploy: `./recreate.sh` + portable client rebuild; clear `trivia-artwork-cache/` on the poster PC.

- 2026-08-04: **YouTube history survives recreate; Air now declines with 409** — history was only written on Lounge `stopped`, so `./recreate.sh` (which does **not** wipe `./data`) still erased last-played by killing in-memory sessions. Confirmed watches now seed `data/youtube-history.json` immediately; stop upserts the same row; Lounge `stop()` flushes active sessions before killing the agent; an empty history is rebuilt from `youtube-cache.json` on start. Scheduler soft declines use HTTP **409** (not 502) so a reverse proxy cannot strip the JSON error into a bare "Request failed (502)". `youtube.last-played` now has a real content check. Deploy: `./recreate.sh` (src bind-mounted; history already re-seeded from cache on disk).

- 2026-08-03: **Scheduler pause banner only when paused; Air now unicasts to every display** — the Rules card always showed a bold "Paused — …" style status next to a toggle labelled "Paused" when off, which read as boilerplate rather than state. Toggle is now On/Off; the paused/quiet banner is the only place that word appears, and the educational hint hides while paused. Separately, scheduler "all displays" delivery only UDP-broadcast to `255.255.255.255`, which often never reaches the poster PC while Push-tab unicast does — `resolveDelivery('*'|'all')` now fans out `hosts` to every registered display (plus broadcast). Cache-bust `?v=signal38`. Deploy: `./recreate.sh`.

- 2026-08-03: **YouTube auto-push survives resolve races and Apple TV Buffering** — Lounge was confirming sessions (history filled) but the UDP card was dropped when `active` cleared during Data API resolve (`Skipping YouTube push — already stopped`). Push now only skips when Lounge moved on to a *different* videoId. Confirm also accepts `Buffering`/`Starting` after `confirmSeconds`, not only `Playing`. Deploy: `./recreate.sh` (src bind-mounted). Tests: `test/youtube-now-playing.test.js`, `test/youtube-lounge.test.js`.

- 2026-08-02: **Trivia artwork URLs point at the LAN bridge first** — `artworkBaseUrl()` in `src/trivia-service.js` preferred `GUEST_PHOTOBOOTH_URL` (the public Signal domain), so the display fetched category art through the public hostname and often landed on the solid colour fallback instead of the patterned field. It now prefers `https://{PROXY_OWN_IP}:{webServer.port}`, with the public origin only as a fallback when no LAN IP is configured; `config.trivia.artworkBaseUrl` still overrides both. Tests: `test/trivia-payload.test.js`. Deploy: `./recreate.sh`.

- 2026-08-02: **YouTube detection survives Apple TV Stopped flicker** — Lounge often emits `Stopped` between 60–90s Playing ticks. The old 1.5s stop grace cleared provisional/active before the 5s confirm could finish, so auto-push never started and Settings “Now Playing / Last Played” fell back to stale history. Stop grace is now 120s; confirm retries while parked in Stopped/ad; `currentPlayback` keeps provisional/active during that grace; agent polls `get_now_playing` after connect and on manual preview (`poll` / `poll-all`); ad events forward `contentVideoId`. Deploy: `./recreate.sh --build` (Python agent). Tests: `test/youtube-lounge.test.js`, `test/youtube-now-playing.test.js`.

- 2026-08-02: **Steam vs PSN library tour settings are independent** — Admin “Library tour order” / “Seconds per game” were one shared state (labels said “(shared)”), so changing Steam Shuffle flipped PSN too. Persist per platform in `data/library-tour-settings.json` as `{ steam: { sort, secondsPerGame }, psn: {…} }` (legacy shared file seeds both). API `POST /api/library-tour/settings` requires `platform`; tours/`getFor` use that platform’s prefs. Cache-bust `?v=signal37`. Tests: `test/library-tour.test.js`, `test/command-registry.test.js`. Deploy: `./recreate.sh`.

- 2026-08-02: **Trivia category artwork ships as JPEG** — portable Pillow builds often fail on `.webp`, leaving only the solid category colour (exactly what the display showed). All 52 files in `src/web/trivia-artwork/` are now `.jpg`; `trivia-categories.json` / defaults point at JPEG. `/trivia-artwork/` resolves sibling extensions (old `.webp` URLs still find the `.jpg`) and also checks `dev-assets/` (no spaces) before `dev assets/`. Client tries alternate extensions + `bridgeHosts` rewrites. Deploy: `./recreate.sh` + portable client rebuild; clear `trivia-artwork-cache/` on the poster PC if old broken webp blobs linger.

- 2026-08-02: **PSN library tour + YouTube live detection** — PSN tour used the wrong `getPurchasedGames` contract (always 0 purchased), never persisted a full library to disk, and let `example.com` fixture art overwrite PlayStation CDN URLs (blank PSN cards). Fixed GraphQL mapping, Steam-style disk warm/`setLibrary`, merge prefers real art, enrich thin-fallback. YouTube: wall-clock confirm timer (Apple TV sparse ticks), `confirmSeconds` from settings store, stuck-ad clear when content position advances, 1.5s Stopped grace, `currentPlayback()` so manual Now Playing uses provisional/live video instead of stale history; skip recording flicker sessions. Cache-bust `?v=signal36`. Tests: `test/library-tour.test.js`, `test/youtube-lounge.test.js`, `test/youtube-now-playing.test.js`. Deploy: `./recreate.sh --build` (Python agent) + portable client rebuild.

- 2026-08-02: **Steam library tour blank display + slideshow-style order** — seed cards carried epoch-ms `lastPlayedAt`, and the client's `parse_iso_timestamp` crashed on `.replace` so a successful "704 games" push painted nothing. Client now accepts epoch ms/seconds; thin seed cards convert to ISO before nesting Steam/PSN panels. Library tour sort settings match slideshow: **Newest first / Oldest first / Shuffle** (`recent`/`oldest`/`random`, default `recent`) via shared segmented controls on the Steam/PSN Settings cards (`data/library-tour-settings.json`). `cardBaseUrl` prefers `GUEST_PHOTOBOOTH_URL` like trivia artwork; the client rewrites playlist/card fetches through `bridgeHosts`. Cache-bust `?v=signal36`. Tests: `test/library-tour.test.js`, client `test_payload_utils` / `test_game_library_tour_panel`. Deploy: `./recreate.sh` + **portable client rebuild**.

- 2026-08-02: **Trivia on-screen credit is source names only; artwork prefers the public Signal origin** — provider labels drop the `(CC BY-…)` clutter (`Open Trivia DB` / `The Trivia API`; licence URLs stay on the provider object). `artworkBaseUrl` uses `GUEST_PHOTOBOOTH_URL` when set (verified HTTPS to `/trivia-artwork/`) before falling back to `PROXY_OWN_IP:47810`. Artwork serve also checks `dev assets/trivia-category-artwork/` after `data/` overrides and `src/web/trivia-artwork/`.

- 2026-08-02: **Library tours no longer ship 700 games over UDP** — stuffing the full Steam library (poster URL fan-out included) into one datagram made "Start library tour" report success while the display got nothing. New flow: warm `data/steam-library-cache.json` + in-memory PSN list; `pushTour` creates a `library-tour-sessions` playlist and sends a **tiny** `game.library-tour` start (`tourId`, `count`, `playlistPath`, seed game only); the client GETs `/api/library-tour/playlist/:tourId` then enriches each title via `/api/library-tour/card` with one-ahead prefetch. Steam CDN poster candidates are built on the client from `appId`. Tests: `test/library-tour.test.js`.

- 2026-08-02: **Steam/PSN library tours are schedulable full cards** — tours were already in the command registry, but a looping `persistent` push only held the scheduler for 15 minutes and the UDP list carried posters/names only. Scheduled airings now walk the library **once** (`loop: false`, `displaySeconds` / `holdSeconds` = count × secondsPerGame). Manual Start tour still loops. Payload gains `gameTour.cardBaseUrl`; displays enrich each title via public `GET /api/library-tour/card?platform=&id=` (same shape as now-playing: description, tags, screenshots, achievements/trophies, playtime). Command params expose **Seconds per game** on scheduler rule cards. Cache-bust `?v=signal35`. Tests: `test/library-tour.test.js`.

- 2026-08-02: **YouTube last-played no longer shows "Watched 0:00 of …"** — Lounge position ticks on Apple TV are often 60–90s apart, and the old `< 60s` delta ceiling discarded every real tick, so history stored `watchedSeconds: 0`. `youtube-lounge.js` now allows deltas up to 180s, keeps refreshing position on same-video `now-playing`, records `positionSeconds` in history, and falls back to scrubber/wall-clock when the delta total is empty. Last-played payloads prefer scrubber progress for the "Watched X of Y" line (mockup §4.3). Client mirrors the fallbacks. Tests: lounge sparse/slow-tick cases + payload preference.

- 2026-08-02: **YouTube API key survives rebuilds; Linked TVs names wrap; Slideshow tab can air; trivia uses category colours** — admin YouTube key save only mutated in-memory `config.youtube.apiKey`, so a container recreate dropped it. Keys now persist encrypted in `data/youtube-credentials.json` (secret-box), load via `resolveYoutubeConfig` / `youtube-credentials.js`, and refuse overwrite with 409 when `YOUTUBE_API_KEY` is set in `.env`. Linked TVs device rows stack name above actions (no one-character ellipsis). Slideshow tab + lightbox gain **Show on display** → `POST /api/push/photo-slideshow` (lightbox = one-photo slideshow). Trivia display: solid category `background` field + accent-derived tiles/ring (no house navy wash); correct answer uses white ink on accent (§6.4). Cache-bust `?v=signal33`. Tests: `test/youtube-credentials.test.js`.

- 2026-08-02: **Steam/PSN library poster tour** — new UDP type `game.library-tour` (`displaySeconds: 0`, `persistent: true`, `gameTour.{platform,secondsPerGame,loop,games[]}`). Bridge: `steam-api.js` `fetchOwnedGames` (full GetOwnedGames, no rtime drop), `steam-library-tour.js` / `psn-library-tour.js` push helpers, `psn-library-cache.js` (merge-by-`titleId` cache fed from PSN enrich/presence), paginated `fetchPlayedTitles` + optional `getPurchasedGames`, `library-tour-settings.js` (`secondsPerGame` 5–300, `sort`), `buildGameLibraryTourPayload`, command-registry entries `steam.library-tour` / `psn.library-tour` (variable duration + content check), admin Settings cards (library count, shared seconds slider, Start library tour), routes `GET/POST /api/library-tour/*` and `POST /api/push/*-library-tour`. Client: `game_library_tour_panel.py` loops posters with N/M + countdown until interrupted. Cache-bust `?v=signal33`. Tests: `test/library-tour.test.js`, `test_game_library_tour_panel.py`.

- 2026-08-02: **YouTube card layout, one auto push tile per connector, TV code spacing** — landscape YouTube last-played showed a truncated title, a blank description band, and "dislikes" wrapping onto the upload-date line. Root causes: (1) titles were two-line auto-fit with ellipsis; (2) `cleanDescription` *broke* on the first boilerplate marker, so a leading `SUBSCRIBE` wiped the pitch below it (Why Files etc.), and the forever-cached `descriptionClean` kept the empty result — it now skips leading banners and only stops once real copy has started, and `resolveVideo` re-cleans from the raw description on every read; (3) landscape stats used `create_text(..., width=)` which wrapped the inline sentence over the upload row. The client panel now marquees a single title line (`MarqueeLine`), scrolls the description in Steam's clipped viewport, clamps the description band above the stats, and shrinks the inline stats font instead of wrapping. **Push tab:** Steam / PSN / YouTube no longer expose separate now-playing and last-played tiles — each is one tile next to Trivia that posts with no `mode` (the handler's `auto` path, same as the Settings test buttons); last-played remains schedulable-only, and `airCommand` still forces the mode from the command id so a scheduled "now playing" rule cannot quietly air last-played. The YouTube TV code input regroups digits as `123 456 789 012` while typing. Cache-bust `?v=signal32`. Suite: **920 bridge**. Deploy: `./recreate.sh`; portable rebuild for the display client.

- 2026-08-02: **PSN cards stop opening empty** — a PS5 card could show a poster and nothing else: no blurb, no stills, no playtime, `—` trophies. Two independent causes. (1) **The card was enriched once, at the worst possible moment.** `psn-now-playing.js` returned early for the rest of the session once `session.pushed` was set, but PSN builds a title's library row (playtime, `concept.media` stills) and its trophy set *after* the game launches — seconds to minutes later. Enriching at t≈0 reliably found nothing and never looked again. The poller now re-enriches while `psnReadingIsThin()` (no blurb, no stills, no playtime, or no trophy set) on a 45s→90s→3m→5m→10m backoff, redraws only when the retry actually filled a band — a no-op re-push just restarts the card's animation — and gives up after five tries rather than polling all session. (2) **Chihiro is decaying.** It still resolves `titleId → productId`, but answers `204 No Content` for European products (The Precinct's `EP6959-…`) and `404` for older US ones, so `fetchStoreEnrichmentForTitle` cached a null for 6h and the card never got a description. `psn-store.js` now reads the body as text (a 204 is a miss, not a parse error), retries on the storefront the product id names (`EP`→GB, `UP`→US, `JP`→JP, `HP`→HK), and re-checks a miss after 30min instead of 6h. New **`src/game-lookup.js`** is Plan C: the same game on Steam, keyless, for the blurb, credits and release year, plus stills only when PlayStation supplied none — PlayStation art always wins. It rejects soundtracks/demos/DLC, requires a real name match (so "Split Fiction" cannot resolve to "Split Second"), re-checks the canonical name from `appdetails`, and caches hits 7d / misses 6h; `steam-api.js` gains `searchStoreApps`. Also: `developers`, `releaseYear` and concept `genres` were declared on the payload but hardcoded empty — now populated (genres become tags), and `formatPlaytimeHours` reports sub-hour play in minutes because a freshly launched game rendered as `0.0 h`. Verified against the live account: The Precinct now carries its blurb, three PlayStation stills, `Fallen Tree Games Ltd · Kwalee · 2025` and `0 / 40` trophies. Japan-only titles absent from both stores still degrade to poster + playtime + tags. Suite: **918 bridge**. Deploy: `./recreate.sh`.

- 2026-08-02: **YouTube linking fixed (pyytlounge 3.x), Now Playing push tiles, activity-log midnight bug** — linking a TV always answered *"The YouTube agent is not installed on this bridge"* even though `pyytlounge` was installed. The sidecar imported `State` from `pyytlounge.wrapper`, which only exists on the package root; the `try/except ImportError` around the import block turned that into `LOUNGE_AVAILABLE = False`, indistinguishable from an absent package. `src/youtube_lounge_agent.py` is rewritten against the real 3.x surface: `State` from the package root, `EventListener` callbacks taking typed event objects (`NowPlayingEvent`, `PlaybackStateEvent`, `AdPlayingEvent`/`AdStateEvent` whose `ad_state` is a `State`, `AutoplayUpNextEvent`, `DisconnectedEvent`), `YtLoungeApi` driven **inside its async context manager** (it owns an aiohttp session that does not exist outside one, so every previous call would have raised `RuntimeError`), the listener passed to the constructor rather than to `subscribe()`, `screen_name`/`screen_device_name` read through guards because they raise until linked/connected, `auth.serialize()` instead of `store_auth_state()` (only the former round-trips through `load_auth_state`), `authState` accepted as the JSON string the store actually hands over, `dial.get_screen_id_from_dial` returning a `DialResult`, and each device living in one long-lived task. `requirements-youtube.txt` is pinned `pyytlounge>=3.3,<4`. The import failure is no longer swallowed: it travels in the `ready` event and into `unavailableReason()`, so the card names the module that would not resolve rather than saying "missing". A refreshed lounge token now records its `expiry`, so `refreshTokens` stops re-refreshing tokens good for weeks. **Push tiles** for `steam.*`, `psn.*` and `youtube.*` now-playing/last-played — the descriptors were `schedulable` but `pushable: false`, so the registry rendered no tiles; they share a route and differ only by `body.mode`, and a new `Now Playing` row (`data-push-row="Steam,PSN,YouTube"`) renders them (a group may appear in exactly one row or its tiles render twice). Separately, `scheduler-activity.js` `record()` assigned `cacheKey` *before* calling `readDay()`, which short-circuits on a matching key — so the first event after local midnight inherited the previous day's buffer and every query and stat counted those events twice until restart. Cache-bust `?v=signal31`. Suite: **902 bridge**. Deploy: **`./recreate.sh --build`** (the image must reinstall `pyytlounge`).

- 2026-08-02: **Trivia pool balance, and failures that name themselves** — the settings page showed four categories with 50 questions each and twenty-two with none, and `lastRefillAt` had never been set. Two causes, both fixed. (1) OpenTDB reports "token empty" (code 4) when a *query* has no unseen questions left, and it counts asking for more than the category holds as exactly that — so the first ask for 50 from any of its smaller subjects came back as code 4, and `fetchQuestions` threw a retryable error that aborted the whole replenishment pass. It now halves the ask down to 1 before concluding anything, returns `[]` for a genuinely drained query instead of throwing, and never resets the session token on that path (a reset recycles the no-repeat history for *every* category). (2) "Full" meant nothing but total question count, so a 300-question target filled on the first six categories and stopped forever. `trivia-pool.js` gains `categoryTarget()` (`max(questionsPerSession, poolTargetSize / enabled categories)`) and `needsRefill()`; replenishment asks each category only for its shortfall, which is also far likelier to succeed. A category whose sources all come back empty is recorded in `store.exhausted` and skipped for 24h, so the handful of subjects that can never reach their share cannot pin a free API's rate limiter. Status reports `categoryTarget`. **`POST /api/trivia/pool/refill` no longer awaits the pass** — at one call per six seconds a full pass runs for minutes, which is long enough for the browser to abandon the request and report a bare failure; it returns `202 {started:true}` and the card polls `refilling`. Scheduler air-now failures now answer `502` **with an `error` string** instead of a `500` carrying only an event object, which is where "Request failed (500)" came from. The YouTube lounge supervisor tracks *why* it is down (`unavailableReason`) and says so — a missing `pyytlounge` or no Python in the image now reads "rebuild the image (`./recreate.sh --build`)" on the card and in the scan result, and discovery answers `503` rather than `502`. Admin fixes: "Credited on screen" printed `[object Object]`; the YouTube and Trivia cards now span the full settings grid and column up internally (`.settings-columns`) instead of sitting half-width and metres tall. Cache-bust `?v=signal30`. Suite: **896 bridge**. Deploy: `./recreate.sh` (`--build` if YouTube detection is wanted).

- 2026-08-02: **Scheduled slideshow airings fixed** — `handlePhotoSlideshowPush` only ever read `body.photos`, which the admin UI fills from the list already on screen. The scheduler has no such list, so every "Air now" on **Shared Photo Slideshow** failed with `No shared photos to show` and surfaced in the UI as a bare 500. The handler now falls back to `photosToSlideshowEntries(qrImageCache.list(), config)` when the body carries no list, matching what the voice path (`open guest snaps slideshow`) has always done; an explicit list still wins. The empty-state 400 now distinguishes "nothing shared yet" from "photos exist but `PROXY_OWN_IP` is unset so their URLs cannot be built", which are different fixes. Covered by three new cases in `test/scheduler-api.test.js`.

- 2026-08-02: **YouTube agent** — the poster now shows what is playing on the theatre Apple TV. Detection is a Python sidecar (`src/youtube_lounge_agent.py`, `pyytlounge`) supervised by `src/youtube-lounge.js`, which spawns and restarts it, frames NDJSON, and owns the session lifecycle: a 5s sustained-`Playing` debounce before any quota is spent, ad suppression that only an explicit `ad` event can clear (the Lounge reports `Playing` during ads too), and `watchedSeconds` from position deltas so pausing cannot inflate it. Metadata is `src/youtube-api.js`, built around the mutability split — `VideoCore` cached forever, `VideoStats` 6h, `ChannelRecord` 7d (30d above 1M subs), RYD dislikes 7d and always labelled estimated, 404s negative-cached 24h, up to 50 ids per request, thumbnails and avatars downloaded and served locally from `/youtube-images/`. A first play costs three calls; a replay costs none. `src/youtube-settings.js` persists settings, devices and history, with Lounge tokens encrypted at rest by the new `src/secret-box.js` (AES-256-GCM, key from `SIGNAL_SECRET_KEY` or `data/secret.key`). `src/youtube-now-playing.js` ties them together: Shorts suppressed by default, live streams never mistaken for Shorts, most-recent-or-preferred TV when two rooms play at once. Routes under `/api/youtube/*`; `youtube.now-playing` (content-checked) and `youtube.last-played` join the command registry as schedulable. Settings tab gains a YouTube card for linking by TV code or SSDP scan, re-link, API key test, and a quota/cache readout. `Dockerfile` gains a Python venv from `requirements-youtube.txt`. Cache-bust `?v=signal29`. Suite: **884 bridge**. Deploy: **`./recreate.sh --build`** (image rebuild required).

- 2026-08-02: **Display Scheduler** — the display now programs itself when nothing else is on. New `src/display-scheduler.js` (three-stage tick: gate → collect → select, score `(secondsSinceLastAiring / intervalSeconds) × (importance / 3)` with a never-aired rule treated as `2 × interval`, injectable clock + seeded RNG), `src/scheduler-rules.js` (normalisation, scoring, `expectedPerDay`/`gapProfile` readouts, `data/scheduler-rules.json`) and `src/scheduler-activity.js` (day-partitioned `data/scheduler-activity/YYYY-MM-DD.jsonl`, so `historyRetentionDays` is a file delete; query/stats/heatmap/`dailySeries`). Losing the dice advances a full interval; losing the tie-break sets `pending` **without** a re-roll, and pending expires after one interval so a rule never fires hours out of context. New `src/display-busy.js` is fed by every `sendUdpPayload` and holds for the payload's `displaySeconds`, or for `estimateDuration` on a `variableDuration` command, so nothing can air between trivia question 2 and 3; `lastAiringAt` is stamped at **sequence end**. Routes `/api/display-scheduler/{settings,rules,rules/:id[/air|/reset],status,activity,stats,heatmap,simulate}` dispatch through the existing push handlers via `airCommand`. New admin **Scheduler** tab: rule editor with live expected-per-day and gap-variance readouts, plus an Activity view with a hand-rolled inline-SVG swimlane (points for fixed pages, to-scale bars for variable-duration rounds, skips on by default, quiet-hours bands), a click-through event inspector that names the competing rules, per-rule expected-vs-actual bars with sparklines, and a CSS-grid heatmap. Cache-bust `?v=signal28`. Suite: **785 bridge**. Deploy: `./recreate.sh`.

- 2026-08-02: **Trivia** — new `src/trivia-categories.js` (26 canonical categories + provider mapping + artwork manifest `src/trivia-categories.json`), `src/trivia-providers.js` (OpenTDB with base64, all six response codes, persisted session tokens and 6s call spacing; The Trivia API as a second source), `src/trivia-settings.js`, `src/trivia-pool.js` (local pool, balanced replenishment with backoff, dedupe, `avoidRepeatDays`, prune, `drawSession` relaxation ladder) and `src/trivia-service.js`. `buildTriviaRoundPayload` sends the whole round as **one** `trivia.round` packet — the client sequences it, so a dropped datagram cannot strand a question without its answer. Routes `/api/trivia/{pool/status,categories,settings,pool/refill}` + `POST /api/push/trivia`; 52 artwork files served from `src/web/trivia-artwork/`. `trivia.show` is the first `variableDuration` command. Settings tab gains a Trivia card with live pool counts, per-category starvation and computed round length. Cache-bust `?v=signal27`. Suite: **711 bridge**. Deploy: `./recreate.sh`.

- 2026-08-02: **Command registry** — new `src/command-registry.js` is the single source of truth for pushable pages, exposed at `GET /api/commands`; the admin Push grid now renders tiles from it (`data-push-row` containers + `renderPushGrid`) instead of static markup, and Steam/PSN previews accept `mode: now-playing | last-played` so a scheduler rule can request one specifically. Cache-bust `?v=signal26`. Suite: **628 bridge**. Deploy: `./recreate.sh`.

- 2026-07-30: **Admin Settings layout** — Authentication cards first (filled 2-col grid); Slideshow config moved to the bottom as a full-width card with order + time side-by-side on landscape. PSN card links to account login + NPSSO cookie URL. Cache-bust `?v=signal24`. Hard-refresh admin.

- 2026-07-30: **Steam/PSN Auth push honors selected display** — manual Now Playing / Last Played used broadcast-only UDP and ignored the picker’s unicast host (other Push tiles did not). Intermittent “toast OK, nothing on poster” on flaky broadcast LANs. Deploy: `./recreate.sh`.

- 2026-07-30: **PSN Store Chihiro Plan B** — fail-soft `psn-store.js` resolves `titleId` → Full Game product for `long_desc`, real `mediaList.screenshots`, star rating, ESRB label (cached 6h; never breaks Now Playing). Concept key-art no longer used as screenshots. Client shows Store blurb when present + adaptive 1–3 gallery. Deploy: `./recreate.sh` + restart/rebuild display client.

- 2026-07-30: **PSN Now Playing enrichment + dedicated client layout** — bridge fills `statusLine`, concept-media gallery, `progressLabel`/`playCount` (no Steam store blurb / concurrent players); client panel owns PSN bands/footer. Deploy: `./recreate.sh` + restart/rebuild display client.

- 2026-07-30: **PSN Now Playing** — unofficial `psn-api` poller (`psn-config` / `psn-session` / `psn-api` / `psn-now-playing`); Admin Settings NPSSO paste + Now Playing/Last Played push; UDP `psn.now-playing` (+ close); interrupt suppress shared with Steam. Caveats: NPSSO is secret-like; enable activity sharing; PS3 limited. Suite: **599 bridge / 329 client**. Deploy: `./recreate.sh` + restart/rebuild display client.

- 2026-07-30: **Guest Snaps PIN auth** — rotating 24h 6-digit booth PIN (`guest-snaps-auth.js`, `data/guest-snaps-pin.json`); shown on `guest.photobooth` overlay; `/` login + Request PIN; photo upload/push need `signal_guest` or admin cookie; admin-style IP lockout on bad PINs. Suite: **589 bridge / 326 client**. Deploy: `./recreate.sh` + restart/rebuild display client.

- 2026-07-30: **Control/Remote unlock PIN is 6 digits** — default `webServer.controlAuth.pinDigits` is now 6 (was 4); admin PIN sheet maxlength/hint/cache-bust `?v=signal22` match. Override still via `pinDigits` (4–8). Deploy: `./recreate.sh` + hard-refresh admin.

- 2026-07-30: **Guest Snaps phone picker allows camera roll** — removed `capture="environment"` from the booth file input so mobile browsers offer Take Photo *or* choose from library (PC file picker unchanged). Suite: **579 bridge / 325 client**. Deploy: `./recreate.sh` (or reload static `/`).

- 2026-07-29: **Steam description pinned above screenshots (client)** — explicit `desc` layout band + `create_window` embedding so copy cannot wrap into the shot row. Restart/rebuild display client.

- 2026-07-29: **Tesla battery overlay shows remaining miles** — fleet readings round/normalize `battery_range`/`est`/`ideal` into both `batteryRange` and `rangeMiles` (older clients only read the latter); dashboard-cache fallback copies range too. Deploy: `./recreate.sh` + restart/rebuild display client.

- 2026-07-29: **Admin keyboard Space + press feedback** — Space was sent as `' '` and `buildInputKeyPayload` trimmed it to empty → toast "Missing key"; now sends/normalizes to `Space`. Keys flash a `.pressed` accent state on pointerdown/click (CSS `:active` alone is unreliable on phones). Cache-bust `?v=signal21`.

- 2026-07-29: **Fix Steam return leaving Auth stuck on "Checking session…"** — `applySteamReturnTab` now runs at end of admin startup (try/catch) so it cannot abort status polling / Authenticate handlers. Waiting Steam login shows a proper status + followup link; Authenticate opens Steam in a new tab. Cache-bust `?v=signal20`.

- 2026-07-29: **Steam callback lands on Settings; logo → Push** — `/admin/?steam=ok|error` opens the Settings tab (Auth card) with a toast, then strips the query. Header logo/title (`btn-app-home`) switches to the Push tab from any tab. Cache-bust `?v=signal19`.

- 2026-07-29: **Admin Shared Photo Slideshow tile → guest booth** — subtitle is now "Play every uploaded photo"; tapping **uploaded photo** opens the guest photobooth (`/`) in a new tab (same destination as the login-page link). Cache-bust `?v=signal18`.

- 2026-07-29: **Steam OpenID state + admin login lockout** — Steam link callbacks require a one-time `state` nonce created by admin `/api/auth/steam/start` (blocks unauthenticated re-link). Admin login applies progressive per-IP delays after failed passwords (in-memory; unlock via `./recreate.sh`). Docs stress **`LAN_UDP_SECRET` / `udpSecret` as required** on a real LAN. Deploy: `./recreate.sh`.

- 2026-07-29: **Music progress units + skip/route reliability** — `extractMediaProgress` coerces length/progress as a pair (early-track ms no longer read as thousands of seconds); skip falls back to household scan; softer `next please` match. Route queries emit a processing ack and geocode prefers `countryCode=US` first so distance overlays aren't silent.

- 2026-07-28: **Now Playing includes track progress** — `normalizePlayerInfo` reads Alexa `progress.mediaLength` / `mediaProgress` (ms→sec) into `music.{mediaLengthSec,mediaProgressSec,progressAt}` on `music.playing` so the display can show time left and auto-dismiss when the track ends.
- 2026-07-28: **Timer/alarm followups no longer steal Shared Photo Slideshow** — `shouldEmitSnapshot` / `shouldEmitAlarmSnapshot` only treat the *initial* `show-timers` / `show-alarms` (and set/cancel voice) as empty-list emitters; `*-followup-*` polls stay silent unless lifecycle/gained/lost. Client also protects `photo.slideshow` / `guest.photobooth` from soft refreshes.

- 2026-07-29: **Smart Home ASR dedupe** — comma-joined wake+repeat (`lights off, lights off`) made the bare on/off matcher treat `lights off, lights` as the target ("Lights Off, Lights" on the overlay). Prefer the shortest command-like clause. Deploy: `./recreate.sh`.
- 2026-07-29: **Route Planner ASR dedupe** — comma-joined wake+repeat transcripts (`… to las vegas, what's the distance …`) polluted destination names and geocode failed in ~1s (`loading`→`failed`). Dedupe repeated clauses and strip query tails from place names. Deploy: `./recreate.sh`.
- 2026-07-29: **Broadcast message dedupe** — Amazon often stores two ASR fragments (`alexa broadcast …` + `broadcast …`) that were comma-joined into `"this is a test, broadcast this is a test"` or `", broadcast"`. Prefer a single customer fragment, strip trailing broadcast echoes, and never display verb-only leftovers. Deploy: `./recreate.sh`.
- 2026-07-29: **Route Planner progressive load** — no more processing-ack failure wall: emit skeleton `route-planner.query` with names immediately, then geocoded coords, then distance/route (or `failed`). Parallel geocode (10s/3 lookups) + OSRM 12s. Dismiss **max(180, 2× default)** so the ~60s ack timeout is not the dismiss clock. Deploy: `./recreate.sh` + **restart/rebuild display client** for loading UI.
- 2026-07-29: **Route Planner faster + longer dismiss** — parallel origin/destination geocode, 6s/8s aborts on Open-Meteo/OSRM, route geocode capped at 2 lookups; processing ack timeout 50s. Overlay dismiss is now **2×** `defaultDisplaySeconds` (override `routePlanner.displaySeconds`). Deploy: `./recreate.sh` (bridge); client already bypasses `maxDisplaySeconds` for routes.
- 2026-07-29: **Signal Quick Push Now Playing** — web push used fake device `Signal`, so preferred `getPlayerInfo` always failed (~1.8s wasted) before household scan, ignored PAUSED tracks, and had no spoken fallback. Skip unknown preferred, scan household (PLAYING then PAUSED), emit `request.processing` ack for Signal `music-query`. Deploy: `./recreate.sh`.
- 2026-07-29: **Test suite catch-up** — regression coverage for broadcast/route ASR dedupe, Signal music preferred skip, progressive route payloads, OSRM AbortSignal + geocode timeouts, activity `customerParts`, route loading/failed UI copy, Steam/route dismiss footer clear, shopping list paging config. Suite: **564 bridge** + **317 client**.
- 2026-07-28: **Certbot inside the container** — Alpine image installs `certbot`; host `./issue-letsencrypt-cert.sh` runs interactive DNS-01 via `docker exec -it`, writes `data/web-certs/`, then `docker restart`. LE state under `data/letsencrypt/`. Scripts bind-mounted; fallback `apk add certbot` if image is old.
- 2026-07-28: **Manual Let's Encrypt (Certbot DNS-01)** — removed in-container Whois ACME auto-renew (API is reseller-only). Host script `issue-letsencrypt-cert.sh` runs Certbot manual TXT, installs `data/web-certs/{cert,key}.pem`, then `./recreate.sh`.
- 2026-07-28: **Steam panel mockup alignment** — hero uses same art as full-frame blurred backdrop + contained sharp poster; developer·year right-aligned; smaller tags (no overlap into description); description wraps full meta width (`center_x=0`); shorter screenshot band + compact stats footer. Portable rebuild required.
- 2026-07-28: **Full QAA test expansion** — Steam poller integration (mocked API tick/quit/infer/restore/presence), music empty-card + retry outcomes, companion-weather suppress helper, UDP AES-GCM send/receive integration, OwnedGames `rtime` mapping, voice orchestration payloads, legacy broadcast fingerprint migration, route pending TTL/cross-device. Extracted `musicQueryRetryOutcome` / `shouldSuppressCompanionWeather`; fixed Steam interrupt path that re-`beginSession`ed a matching suppressed session. Suite: **535 bridge** + **237 client**.
- 2026-07-26: **Steam OwnedGames with idle baseline** — auto detection is gameid → presence → OwnedGames only when last-played/playtime **advanced past a boot-seeded idle baseline** (quit stamps are absorbed on session end, so they cannot reopen the card). Open sessions stay alive through brief `gameid` dropouts via OwnedGames; stagnant sessions close after `STEAM_RECENT_PLAY_STAGNANT_SEC` (default 150). Fixes “never shows” after gameid-only mode and “shows again after quit.” Deploy: `./recreate.sh`.
- 2026-07-26: **Steam auto Now Playing = gameid or presence only** — removed OwnedGames `rtime_last_played` inference. That timestamp updates on quit and was reopening Boomerang Fu / other titles while idle. Overlay opens only when Steam reports `gameid` or a fresh local presence appId; closes as soon as both are gone. Manual Auth preview can still show last-played. Deploy: `./recreate.sh`.
- 2026-07-26: **Remove bridge Steam artwork cache; fix quit reopen** — bridge no longer rewrites/warms `/steam-artwork/` URLs (that path blanked screenshots by crowding out CDN fallbacks and added little speed). Display client still disk-caches CDN images locally. Quit sets a cooldown (`STEAM_QUIT_COOLDOWN_SEC`, default 90s) so Steam’s quit-time `rtime_last_played` bump cannot immediately reopen the card. Deploy: `./recreate.sh` (+ portable client rebuild for client image cache).
- 2026-07-26: **Steam quit/artwork follow-up** — after quit, OwnedGames no longer resurrects the closed title when launching something else (quit-suppress + scan next fresh games). Artwork warm no longer mid-session re-pushes LAN-only URLs that blanked the hero; CDN fallbacks are kept when cache URLs are used. Deploy: `./recreate.sh` (+ portable client rebuild for safer image cache writes).
- 2026-07-26: **Steam quit detection + artwork cache** — recent-play no longer uses a blind 15‑minute hold; sessions end after `STEAM_RECENT_PLAY_STAGNANT_SEC` (default 120) without playtime/rtime growth, and clearing profile `gameid` closes immediately (OwnedGames won’t resurrect until relaunch). Bridge caches store details + poster/screenshots under `data/steam-artwork-cache/`, serves `/steam-artwork/…`, prefers cache on push and warms in the background; Settings → Clear Steam artwork cache. Display client also disk-caches fetched images for instant re-show. Deploy: `./recreate.sh` + portable client rebuild for client cache.
- 2026-07-26: **Steam Now Playing infers launches when `gameid` is empty** — GetPlayerSummaries often omits the current game (brand-new titles, API lag) while OwnedGames `rtime_last_played` updates within seconds. Poller treats a fresh last-played title as in-game (`STEAM_INFER_FROM_RECENT_SEC` / stagnant quit window); manual Auth preview uses the same OwnedGames ordering. Deploy: `./recreate.sh`.
- 2026-07-26: **Steam Now Playing restores after Alexa interrupts** — other overlays set `session.suppressed` and never cleared it until the game quit, so a launch that got interrupted (or a long play session after any voice command) looked like "Steam didn't detect the game" even though the Web API showed in-game and manual Auth preview still worked. Suppress now schedules a restore tick (`STEAM_RESTORE_AFTER_INTERRUPT_SEC`, default 75s) and re-pushes while still playing. Deploy: `./recreate.sh`.
- 2026-07-26: **What's playing on an idle Echo no longer shows "Nothing playing"** — Alexa often answers with the track on another device while player-info for the asked Echo is IDLE. `music-query` now scans household devices for PLAYING music and falls back to parsing spoken "X by Y" before emitting an empty card. Deploy: `./recreate.sh`.
- 2026-07-26: **Indoor air quality display race** — voice matched and UDP logged, but Smart Home enrich blocked for seconds with no preview, and empty-summary temperature TTS could flash outdoor weather over the AQ card. Now: cache-first AQ preview, weather ignores IAQ answers, suppress placeholder `weather query` while AQ is pending on that device. Deploy: `./recreate.sh`.
- 2026-07-26: **Fix "alexa next" miss from duplicated ASR** — history joins wake-word + repeat (`"alexa next, next"`), which failed the whole-utterance `MUSIC_SKIP_RE` and landed in unmatched with no Now Playing push. Skip matcher accepts comma/`|`-joined skip segments. Deploy: `./recreate.sh`.
- 2026-07-26: **Indoor temp + air quality voice phrasing** — "what's the main floor temperature" was misrouted to outdoor weather (location-before-metric not extracted); "what's the indoor quality" (ASR drops "air") never matched and was marked processed before TTS. Matcher now accepts location-before-metric / `indoor` markers, and indoor-quality ASR + spoken IAQ upgrades. Deploy: `./recreate.sh`.
- 2026-07-26: **Steam last-played uses OwnedGames `rtime_last_played`** — manual "Last played" preview no longer stamps push-time as lastPlayedAt (which made the display show "just now"). Enrichment pulls Steam's last-played unix time from GetOwnedGames when recently-played omits it. Deploy: `./recreate.sh` + portable client rebuild for **LAST PLAYED** corner label.
- 2026-07-26: **Voice Guest Snaps slideshow honors admin order/seconds** — admin UI and Alexa voice each had their own in-memory `slideshow-settings` copy, so "oldest first" saved in the portal never reached `open guest snaps slideshow`. Getters now reload from `data/slideshow-settings.json` on every read. Deploy: `./recreate.sh`.
- 2026-07-26: **Admin: hide Remote on All Displays + auto-select new announces** — Remote tab joins Control in staying hidden unless a single display is selected. When a new display id appears while All Displays is selected (or the prior display was pruned), the picker jumps to that display. Cache-bust `?v=signal17`. Hard-refresh admin.
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
- 2026-07-22: **PIN UX + stale display prune** — wrong PIN shows inline error on the control sheet (`control_auth_incorrect_pin`); successful verify sends `display.auth` with `auth.status: ok` (1s Authenticated flash); registry **removes** displays that miss re-announce (~12 min / 2 heartbeats); web PIN hint omits timeout (client may differ) and locks input length to `pinDigits` (default 6).
- 2026-07-21: **Display id + PIN unlock** — duplicate `displayName` values stay unique via per-machine `display.id` / picker `label` (`Name · ab12`); mouse/keyboard/power require on-screen PIN (`display.auth`, now 6 digits by default) then a per-display `controlToken`.
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
