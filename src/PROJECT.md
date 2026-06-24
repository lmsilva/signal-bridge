# Alexa Broadcast Bridge — project map

> **For AI agents:** Read this file first when working on the NAS/container code.  
> **Keep fresh:** Update this file whenever you change architecture, modules, config, Docker, auth, or UDP behavior. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-06-24

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
| `src/session-keepalive.js` | Ping + `refreshCookie`; persist tokens; `reauth_required` after failures |
| `src/auth.js` | One-off Amazon login via local proxy (`npm run auth`) |
| `src/auth-proxy-patch.js` | Replaces stock `alexa-cookie2` proxy with vendored version |
| `src/vendor/alexa-cookie-proxy.js` | Patched login proxy (font fixes, static assets, UI CSS injection) |
| `src/port-utils.js` | Pre-check port 3456 before auth proxy bind |
| `src/auth-status.js` | Writes `data/auth-status.json` when session expires |
| `src/broadcast-log.js` | Append tab-separated lines to broadcast log file |
| `src/broadcast-udp.js` | Send JSON to `255.255.255.255` + optional `targets[]` |
| `src/message-details.js` | Parse sender/destination/message; build UDP payload v1 |
| `src/bridge-state.js` | Dedup fingerprints + last timestamp on disk |
| `src/config.js` | Merge env + `data/config.json` (or `config.example.json`) |
| `src/logger.js` | Structured console logging |
| `src/diagnose.js` | `npm run diagnose` — quick auth/API check |
| `docker-compose.yml` | Long-running listener container |
| `docker-compose.auth.yml` | One-shot auth container (host network, port 3456) |
| `reauth.sh` | Stop listener, free port, run auth, restart listener |
| `recreate.sh` | `docker compose up -d --no-build` (use `--build` only if image rebuild works) |
| `data/` | **Runtime only** (gitignored): session, config, logs, bridge state |

---

## Runtime flow (listener)

1. `index.js` → `createListener().start()`
2. Load `data/alexa-session.json`; `buildAlexaInitOptions(..., { mode: 'listener' })`
3. `alexa.init()` — uses saved cookies; **no** login proxy in listener mode
4. **Capture paths:**
   - **Push:** `ws-device-activity` → `parser.parseActivity()` → `recordBroadcast()`
   - **History fallback:** volume-change / connect / periodic poll → `getCustomerHistoryRecords()`
5. **On match:** log line → append `broadcast.txt` → UDP JSON via `buildNetworkPayload()`
6. **Dedup:** `BroadcastParser` + `bridge-state.json` (fingerprints, timestamps)
7. **Session keep-alive:** ping every 15m, refresh every 4h, persist to disk; marks `reauth_required` after 5 failures

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
| `sessionKeepAlive.*` | Ping/refresh intervals, `failureThreshold` |
| `PROXY_OWN_IP` / `PROXY_PORT` | Auth only (env) |

Secrets and runtime files live under `data/` and are **not committed**.

---

## UDP payload (v1)

Sent by `message-details.js` / `broadcast-udp.js`:

```json
{
  "version": 1,
  "message": "dinner is ready",
  "sender": "Kitchen Echo",
  "destination": "All devices",
  "timestamp": "2026-06-24T12:00:00.000Z",
  "displaySeconds": 120,
  "trigger": "device-activity"
}
```

Default port **47832**. Use `targets: ["<windows-ip>"]` if broadcast is unreliable from Docker.

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

- 2026-06-24: Added this PROJECT.md; documented vendored auth proxy, session keep-alive, QNAP Docker patterns, UDP protocol.
- 2026-06-24: Reauth port cleanup, `src` volume mount, `--no-build` workflows, `port-utils.js`.
