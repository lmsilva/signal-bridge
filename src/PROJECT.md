# Alexa Broadcast Bridge — project map

> **For AI agents:** Read this file first when working on the NAS/container code.  
> **Keep fresh:** Update this file whenever you change architecture, modules, config, Docker, auth, or UDP behavior. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-06-23

---

## What this is

A **Node.js service** that connects to a personal Amazon/Alexa account (unofficially, via `alexa-remote2`), listens for **broadcast/announcement** voice activity, logs matches, and **UDP-broadcasts** JSON to LAN clients (e.g. the Windows display app).

There is **no supported Amazon API** for passive broadcast listening. Detection uses Alexa **push events** + **voice history polling** and heuristics in `parser.js`.

---

## System context

```
Echo / Alexa app  →  Amazon cloud  →  alexa-remote2 (this bridge)
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
            data/broadcast.txt        data/alexa-session.json    UDP :47832
            data/bridge-state.json                              (JSON payload)
                                                                        │
                                                                        ▼
                                                          Windows client (see
                                                          alexa broadcast client/src/PROJECT.md)
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
| `src/session-auth-journal.js` | Append-only JSONL auth event log with failure classification |
| `src/session-meta.js` | Token age / session metadata helpers |
| `src/error-format.js` | Unwrap AggregateError and nested causes for clearer logs |
| `src/auth.js` | One-off Amazon login via local proxy (`npm run auth`) |
| `src/auth-proxy-patch.js` | Replaces stock `alexa-cookie2` proxy with vendored version |
| `src/vendor/alexa-cookie-proxy.js` | Patched login proxy (font fixes, static assets, UI CSS injection) |
| `src/port-utils.js` | Pre-check port 3456 before auth proxy bind |
| `src/auth-status.js` | Writes `data/auth-status.json` when session expires |
| `src/broadcast-log.js` | Append tab-separated lines to broadcast log file |
| `src/broadcast-udp.js` | Send JSON to `255.255.255.255` + optional `targets[]` |
| `src/message-details.js` | Parse sender/destination/message for broadcast payloads |
| `src/udp-payload.js` | Build typed UDP payloads (broadcast, time, weather, timer) |
| `src/voice-query-parser.js` | Detect time/weather/timer voice queries from history |
| `src/time-parse.js` | Parse spoken time from Alexa `alexaResponse` text |
| `src/weather-location.js` | Extract local vs named location from weather questions |
| `src/weather-fetch.js` | Open-Meteo geocode + forecast fetch (no API key) |
| `src/timer-sync.js` | Poll Amazon notifications API; mirror active timers; fire verify |
| `src/events-log.js` | Append-only JSONL log for voice/timer UDP events |
| `test/*.test.js` | Node built-in test suite (`npm test`) |
| `src/bridge-state.js` | Dedup fingerprints + last timestamp on disk |
| `src/config.js` | Merge env + `data/config.json` (or `config.example.json`) |
| `src/logger.js` | Structured console logging |
| `src/diagnose.js` | `npm run diagnose` — quick auth/API check |
| `docker-compose.yml` | Long-running listener container |
| `docker-compose.auth.yml` | One-shot auth container (host network, port 3456) |
| `reauth.sh` | Stop listener, free port, run auth, restart listener |
| `recreate.sh` | `docker compose up -d --no-build` (use `--build` only if image rebuild works) |
| `data/` | **Runtime only** (gitignored): session, config, logs, bridge state, auth journal |

---

## Session keep-alive & auth diagnostics

Every **15 minutes** the bridge runs a single **ping cycle** (no separate refresh timer):

1. `checkAuthentication()` — lightweight auth check
2. **Optional** `refreshCookie()` — only when token age ≥ **12h** and last attempt was ≥ **3h** ago (or when auth is invalid / proactive threshold hit)
3. `getDevices()` — liveness probe (proves API works)
4. Reconnects push if disconnected

**Refresh failure handling:** `No tokens in Register response` is logged as `token_refresh_noop` (benign). Other refresh failures verify auth + liveness before marking `session_degraded` — a failed refresh alone no longer triggers false alarms.

**Auth journal:** `data/session-auth-journal.jsonl` — one JSON object per line with `type`, `category`, `likelyCause`, `sessionMeta`. Includes `token_refresh_noop`, `token_refresh_failed_but_live`, ping failures, history auth errors, push disconnects, and `reauth_required`.

**Re-auth signal:** `data/auth-status.json` includes `likelyCause` + last journal entries when threshold hit (5 consecutive failures).

**Debug after auth loss:** `docker compose logs -f` + `tail data/session-auth-journal.jsonl` + `cat data/auth-status.json`

---

## Runtime flow (listener)

1. `index.js` → `createListener().start()`
2. Load `data/alexa-session.json`; `buildAlexaInitOptions(..., { mode: 'listener' })`
3. `alexa.init()` — uses saved cookies; **no** login proxy in listener mode
4. **Capture paths:**
   - **Push:** `ws-device-activity` → broadcast parser + voice query parser
   - **History fallback:** volume-change / connect / periodic poll → `getCustomerHistoryRecords()`
5. **On broadcast match:** log → `broadcast.txt` → UDP `type: broadcast`
6. **On voice match:** time/weather → UDP + `data/voice-events.jsonl`; timer voice → immediate timer sync poll
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
| `broadcastLogFile` | Tab-separated capture log |
| `udpBroadcast.enabled/port/targets/defaultDisplaySeconds` | LAN UDP to Windows client |
| `sessionKeepAlive.*` | Ping/refresh/liveness/proactive intervals, `failureThreshold`, `livenessProbe` |
| `voiceEvents.enabled/timeQueries/weatherQueries/fetchWeather` | Voice capture toggles |
| `voiceEvents.defaultLocation` | `{ name, latitude, longitude }` for "weather outside" queries |
| `voiceEvents.eventsLogFile` | Default `data/voice-events.jsonl` |
| `timerSync.*` | Poll intervals, mirror file, fire-verify slack |
| `PROXY_OWN_IP` / `PROXY_PORT` | Auth only (env) |

Secrets and runtime files live under `data/` and are **not committed**.

---

## UDP payload (v2)

All payloads include `version: 2` and a `type` field. **Broadcast payloads keep `message`** so existing clients still work until updated.

| `type` | When emitted |
|--------|----------------|
| `broadcast` | Announce/broadcast captured (unchanged fields: `message`, `sender`, `destination`, …) |
| `time.query` | "What time is it" — includes `parsedTime`, `spokenResponse`, `device` |
| `weather.query` | Weather question — includes `location`, optional `weather` (Open-Meteo), `spokenResponse` |
| `timer.snapshot` | Timer set/list/change/fire — includes `timers[]` (all active), `event.kind` (`started`, `list`, `fired`) |

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

Default port **47832**. Use `targets: ["<windows-ip>"]` if broadcast is unreliable from Docker.

---

## Testing

```bash
npm test                    # bridge only (7 files)
run_all_tests.bat           # repo root — bridge + Windows client
```

Bridge: **44** unit tests in `test/*.test.js` — broadcast parser, UDP payloads, voice query detection, timer sync diff/fire logic, weather location parsing (query + spoken response), and helpers.

Client: **25** unit tests in `alexa broadcast client/test/test_*.py` — payload utils, config, weather fetch, main timer routing.

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

---

## Dependencies

- **Node ≥ 18**
- **`alexa-remote2`** (^8) — unofficial Alexa API; wraps `alexa-cookie2` for auth/refresh

---

## Recent changes

- 2026-06-23: Timer sync emits on new timer set (count increase); fire priority over started; broader timer-set detection; weather location from spoken response; named-location geocoding; `run_all_tests.bat` + 44 bridge / 25 client tests; `--test-force-exit` on npm test.
- 2026-06-27: Voice events (time/weather queries) + timer sync with UDP v2 typed payloads; `npm test` suite.
- 2026-06-27: Smarter refresh handling — noop classification, verify-before-degrade, refresh folded into ping cycle.
- 2026-06-26: Fix liveness probe parsing (`getDevices` returns `{ devices: [] }`); stop false session_degraded/recovered churn.
- 2026-06-24: Added this PROJECT.md; documented vendored auth proxy, session keep-alive, QNAP Docker patterns, UDP protocol.
- 2026-06-24: Reauth port cleanup, `src` volume mount, `--no-build` workflows, `port-utils.js`.
