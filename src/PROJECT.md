# Alexa Broadcast Bridge — project map

> **For AI agents:** Read this file first when working on the NAS/container code.  
> **Keep fresh:** Update this file whenever you change architecture, modules, config, Docker, auth, or UDP behavior. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-07-22

---

## What this is

A **Node.js service** that connects to a personal Amazon/Alexa account (unofficially, via `alexa-remote2`), listens for household voice activity, logs matches, **UDP-broadcasts** JSON to LAN display clients, serves a **phone control page**, and maintains a **display registry** from client announces.

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
| `src/broadcast-udp.js` | UDP send (broadcast / unicast) on `:47832`; listen for `display.announce` on `:47833` (`udpBroadcast.discoveryPort`) |
| `src/display-registry.js` | Known displays from announces; persist `data/displays-registry.json`; prune after ~12 min without re-announce; resolve target → unicast host |
| `src/message-details.js` | Parse sender/destination/message for broadcast payloads |
| `src/udp-payload.js` | Build typed UDP payloads (broadcast, time, weather, indoor temperature, timer) |
| `src/voice-query-parser.js` | Detect time/weather/indoor temperature/timer voice queries from history |
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
| `src/web-server.js` | **Control web page** (`https://<NAS_IP>:47810/`): static SPA + JSON API (display picker, push Tesla/URL, close browser, reboot/poweroff, mouse/keyboard input, phone auth); self-signed TLS via `web-tls.js` |
| `src/web-tls.js` | Auto-generates/loads self-signed cert in `data/web-certs/` (camera QR needs HTTPS on iOS Chrome) |
| `src/web/` | Mobile-first control page assets: `index.html`, `app.js`, `styles.css`, vendored `jsqr.min.js` (live camera QR over HTTPS; photo fallback) |
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
| `recreate.sh` | `docker compose up -d --no-build` (use `--build` only if image rebuild works) |
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

**Voice trigger:** custom routine **"Alexa, show Tesla battery"** (Alexa may reply "Sent to Display"). Bridge matches on **user utterance** (`tesla-battery.js`), not Alexa speech. Optional `my` / `the` still match.

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

- `voice-event-gate.js` — Tesla does **not** wait for Alexa spoken response.
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
cd /share/Container/alexa-broadcast-bridge
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
| `udpBroadcast.discoveryPort` | Listen for `display.announce` (default **47833**) |
| `sessionKeepAlive.*` | Ping/refresh/liveness/proactive intervals, `failureThreshold`, `livenessProbe` |
| `voiceEvents.enabled/timeQueries/weatherQueries/indoorTemperatureQueries/airQualityQueries/teslaBatteryQueries/fetchWeather/fetchAirQuality` | Voice capture toggles |
| `voiceEvents.defaultLocation` | `{ name, latitude, longitude }` for generic/outdoor weather queries |
| `indoorTemperature.coldBelowF/hotAboveF` | Comfort bands for display (defaults 68 / 74) |
| `indoorTemperature.locations[]` | Optional override of thermostat names/aliases (empty = built-in list) |
| `airQuality.defaultMonitor` | Fallback monitor when query/response has no location (e.g. `main floor`) |
| `airQuality.monitors[]` | Optional override of air monitor names/aliases/entityId |
| `voiceEvents.eventsLogFile` | Default `data/voice-events.jsonl` — all captured events (broadcasts + voice + timers) |
| `timerSync.*` | Poll intervals, mirror file, fire-verify slack |
| `alarmSync.*` | Alarm poll/mirror; `localTimeZone` for `originalDate`/`originalTime` (default `America/Denver`) |
| `teslaFleet.*` | Fleet API region, domain, VIN, keep-alive, `minRequestIntervalSec` |
| `webServer.enabled/port` | Control web page HTTPS port (default enabled, `47810`) |
| `webServer.https` | `true` (default) — self-signed TLS; required for live camera QR on iOS |
| `webServer.httpRedirectPort` | Optional plain HTTP redirect to HTTPS (default `47811`; set `0` to disable) |
| `webServer.certDir` / `certHosts` | Cert folder (`data/web-certs`) and extra SAN hostnames/IPs (include your NAS LAN IP) |
| `webServer.controlAuth.*` | PIN unlock for mouse/keyboard/power (`enabled`, `pinDigits`, `pinDisplaySeconds` null→`defaultDisplaySeconds`, `sessionMinutes`) |
| `PROXY_OWN_IP` / `PROXY_PORT` | Auth only (env) |

Secrets and runtime files live under `data/` and are **not committed**.

---

## UDP payload (v2)

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
| `display.announce` | **Inbound** on `:47833` — client registration (`display.{id,shortId,name,port}`); id is per-machine, not name |
| `display.auth` | Control unlock PIN overlay — `auth.pin` + `displaySeconds`; after verify, `auth.status: "ok"` for ~1s green Authenticated flash |
| `input.pointer` / `input.key` | Control tab — relative mouse / key; requires unlocked `target.id` + `controlToken` |

Optional `target: { id }` or `{ all: true }` on outbound commands for unicast vs broadcast delivery (`display-registry.resolveDelivery`).

**Indoor vs outdoor routing:** Generic "what's the temperature" → outdoor (`weather.query`). Location-specific ("top floor", "bedroom echo", "Room 14") → indoor. Spoken Alexa response supplies the reading (e.g. "It's 76 degrees on the top floor"). Humidity only when explicitly asked for a named location.

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
npm test                    # bridge only (280 tests)
run_all_tests.bat           # repo root — bridge + Windows client (280 + 78)
```

Bridge tests in `test/*.test.js` — includes `tesla-fleet.test.js`, `tesla-udp-payload.test.js`, `tesla-auth-status.test.js`, `tesla-battery.test.js`, `tesla-battery-cache.test.js`, `tesla-dashboard.test.js`, `tesla-dashboard-data.test.js`, `tesla-dashboard-cache.test.js`, voice-event gate/dedup for Fleet API flow, `web-command-payloads.test.js` (web.open/web.close/system.command builders), and `web-server.test.js` (static + API routes, URL validation, Tesla phone-OAuth callback flow with mocked token endpoint).

Client tests in `alexa broadcast client/test/test_*.py` — includes `format_limit_reset_time`, Tesla fleet battery payload routing, and `test_web_overlay.py` (pre-flight, host command, command routing, error payload).

**Before commit/push:** always run `run_all_tests.bat` and fix failures first (see `.cursor/rules/project-docs.mdc`).

---

## Docker notes (QNAP)

- **`network_mode: host`** — required for UDP LAN + auth proxy on NAS IP
- **`./src:/app/src:ro`** — edit JS on host without image rebuild
- **`./data:/app/data`** — session + config persist across restarts
- Listener service name: `alexa-broadcast` (container: `alexa-broadcast-bridge`)
- Auth: `docker compose -p alexa-auth -f docker-compose.auth.yml up --no-build`

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
| `docker compose exec -it alexa-broadcast sh` | Interactive shell in listener container |

---

## Dependencies

- **Node ≥ 18**
- **`alexa-remote2`** (^8) — unofficial Alexa API; wraps `alexa-cookie2` for auth/refresh

---

## Control web page (`src/web-server.js` + `src/web/`)

Mobile-first SPA served by the listener process at **`https://<NAS_IP>:47810/`** (config `webServer.{enabled,port,https}`; zero new npm deps — plain `node:https` + auto self-signed cert in `data/web-certs/`, lives under the mounted `./src` volume so no Docker rebuild). Optional HTTP→HTTPS redirect on port **47811**. Three tabs: **Push** / **Remote** / **Settings**. Trusted-LAN, no page auth; destructive actions need an in-page confirm tap.

**iPhone / Chrome QR:** open the **https** URL once, accept the certificate warning (Advanced → Proceed), then **Scan QR Code** uses the live camera (`getUserMedia` + jsQR). Plain HTTP cannot use the camera on iOS — put your NAS IP in `webServer.certHosts` (or `PROXY_OWN_IP`) before first cert generation, or delete `data/web-certs/` and restart after updating hosts.

**JSON API:**

| Route | Effect |
|-------|--------|
| `GET /api/displays` | Known displays from `display.announce` registry (`id` unique; `label` disambiguates duplicate names) |
| `GET /api/displays/events` | SSE stream — pushes `displays` events whenever the registry changes |
| `POST /api/displays/discover` | Broadcast `display.discover` (clients re-announce to `:47833`) |
| `POST /api/displays/auth/start` | Show 4-digit PIN on selected display (`display.auth`); required before mouse/keyboard/power |
| `POST /api/displays/auth/verify` | `{targetId,pin}` → `controlToken` session for that display |
| `POST /api/displays/auth/status` | Unlock / challenge status for a display |
| `POST /api/push/tesla-dashboard` / `tesla-battery` | Synthetic event (`trigger: "web-api"`) through `listener.recordVoiceEvent`; body may include `targetId` |
| `POST /api/push/url` `{url,targetId?}` | Validate → UDP `web.open` (unicast when one display selected) |
| `POST /api/push/close-browser` | UDP `web.close` |
| `POST /api/system/reboot` / `poweroff` | UDP `system.command` |
| `POST /api/input/pointer` / `key` | Relative mouse / key injection — **requires** a single `targetId` (not All) |
| `POST /api/auth/tesla/start` | Returns Tesla authorize URL + opens one-shot local callback (default `http://0.0.0.0:4381`, 10-min timeout) → `saveTokensFromCode`. Public `TESLA_REDIRECT_URI` (e.g. `https://fleetapi…/callback`) must be proxied from the Fleet domain host to that listen port |
| `POST /api/auth/alexa/start` | Runs vendored login proxy in-process (`runAuth({exitOnComplete:false, overrides:{proxyOwnIp}})`, port 3456; `proxyOwnIp` derived from request Host); on success the bridge saves the session and **exits 0** so Docker `restart: unless-stopped` brings it back fresh |
| `GET /api/status` | Alexa/Tesla auth state, active pushed URL, uptime |

QR scanning is client-side: `<input type="file" capture>` photo → jsQR decode → confirm sheet → `POST /api/push/url`. `installAuthProxyPatch()` now runs at the top of `index.js` (before `alexa-remote2` loads) so the in-process login proxy works in listener mode.

---

## Recent changes

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
- 2026-07-11: **Cache-first Tesla + capture robustness + indoor mishear guard** — (1) Tesla battery/dashboard queries now send the cached snapshot instantly flagged `stale+refreshing` (`buildRefreshingReading`/`buildRefreshingDashboard` in the cache modules) while the live Fleet fetch runs; the live payload replaces it. The `request.processing` ack is only sent when no cache exists. (2) Listener polls history every 15s while the push channel is down (60s when up), polls immediately on `ws-disconnect`, and treats `ws-todo-change`/`ws-content-focus-change`/`ws-media-change`/`ws-unknown-command` push traffic as capture hints (debounced 2s poll) — fixes "show my shopping list" arriving up to 60s late when the interaction emitted no PUSH_ACTIVITY. (3) Indoor temperature queries naming an unmatched location (e.g. a second Echo mishearing "Room 14" as "palmyra") are no longer displayed with no data: `resolveIndoorQueryLocation` lets a matched spoken-response room override an unmatched query phrase, `voice-event-gate` defers unmatched indoor queries for the spoken-response upgrade, and the listener drops them entirely when no reading ever materializes.
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
