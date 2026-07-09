# Alexa Broadcast Bridge

A Node.js service that connects to your personal Alexa account (unofficially, via `alexa-remote2`), listens for household voice activity, and **UDP-broadcasts JSON** to LAN display clients. The companion [**Windows display client**](alexa%20broadcast%20client/README.md) shows fullscreen overlays on a poster PC, movie screen, or kitchen display.

There is **no supported Amazon API** for passive listening. The bridge uses Alexa **push events** plus **voice history polling** and heuristics to detect what happened.

---

## What it captures

| Category | Example voice commands | UDP `type` |
|----------|------------------------|------------|
| **Broadcasts / announcements** | "Alexa, announce dinner is ready" | `broadcast` |
| **Time** | "Alexa, what time is it?" | `time.query` |
| **Outdoor weather** | "Alexa, what's the weather?" / "what's the temperature?" | `weather.query` |
| **Indoor temperature** | "Alexa, what's the temperature on the top floor?" | `indoor-temperature.query` |
| **Air quality** | "Alexa, what is the air quality?" | `air-quality.query` |
| **Timers** | Set, cancel, "show my timers", timer fired | `timer.snapshot` |
| **Shopping list** | "Alexa, show my shopping list" / "add milk to my shopping list" | `shopping-list.snapshot` |
| **Music** | "Alexa, play …" (now playing from device) | `music.playing` |
| **Smart home** | "Alexa, turn the kitchen lights on" | `smart-home.command` |
| **Tesla battery** | Custom routine: "Alexa, show my Tesla battery" | `tesla-battery.query` (Fleet API when configured) |
| **Tesla dashboard** | Custom routine: "Alexa, show Tesla dashboard" | `tesla-dashboard.query` (Fleet API `vehicle_data`) |
| **Vivint alarm** | "Alexa, ask Vivint to arm" | `vivint-alarm.query` |
| **Notifications** | "Alexa, show my notifications" | `alexa-notifications.query` |

All captured events are logged to **`data/voice-events.jsonl`** and sent over UDP. Voice categories can be toggled in `config.json` under `voiceEvents` (see [Configuration](#configuration)). Timer sync runs independently and still emits `timer.snapshot` even when other voice events are disabled.

---

## How it works

```
Echo / Alexa app  →  Amazon cloud  →  Bridge (NAS or PC)
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
         data/voice-events.jsonl   data/bridge-state.json   UDP :47832
              (all events)              (dedup state)              │
                                                                   ▼
                                                      Windows display client
                                                      (fullscreen overlays)
```

1. **Push path:** Amazon sends device-activity WebSocket events → bridge parses them immediately.
2. **History fallback:** Volume changes, reconnects, and periodic polls call `getCustomerHistoryRecords()` for anything missed.
3. **On match:** Build typed UDP payload → append one JSON line to **`data/voice-events.jsonl`** → send UDP to the display client.
4. **Timers:** Amazon's notifications API is polled; active timer lists and fire events emit `timer.snapshot` UDP payloads.

On startup, the bridge rebuilds broadcast dedup fingerprints from **`data/voice-events.jsonl`**. Legacy **`broadcast.txt`** files (if present from older installs) are still read once for dedup migration but are no longer written.

---

## Repository layout

| Path | Role |
|------|------|
| `src/` | Bridge source (listener, parsers, UDP payloads, session keep-alive) |
| `alexa broadcast client/` | Windows tray app + fullscreen overlay (Python/Tkinter) |
| `config.example.json` | Default settings template |
| `data/` | Runtime files (session, config, logs) — gitignored |
| `tesla-auth-pc.bat` | Windows OAuth helper (use from NAS share; handles UNC via `pushd`) |
| `scripts/tesla-common.sh` | Shared helpers for `tesla-*.sh` NAS scripts |
| `src/PROJECT.md` | Bridge architecture reference (for developers) |
| `alexa broadcast client/src/PROJECT.md` | Display client architecture reference |

---

## Prerequisites

- **Bridge:** Node.js 18+, Amazon account with Alexa devices
- **Display client:** Windows 10+, same LAN as the bridge (UDP port 47832)

---

## Quick start (development)

```bash
npm install
cp config.example.json data/config.json   # or config.json at repo root for local dev
npm run auth                              # one-time Amazon login → data/alexa-session.json
npm start
```

Enable verbose logging:

```bash
DEBUG=1 npm start
```

### Test a broadcast

On an Echo:

- "Alexa, announce dinner is ready"
- "Alexa, announce" → wait for prompt → "the movie is starting"

You can also send an announcement from the Alexa mobile app.

---

## Production deployment (QNAP NAS)

Typical setup: bridge in Docker on the NAS, display client on a Windows poster PC.

```bash
./recreate.sh          # restart listener (src/ is bind-mounted; no rebuild needed for code changes)
./reauth.sh            # re-authenticate when session expires
```

See **[DOCKER.md](DOCKER.md)** for full QNAP Container Station instructions, auth workflow, and troubleshooting.

**Display PC:** build the portable client on a Windows machine with Python 3.10+:

```bat
cd "alexa broadcast client"
build_portable.bat --no-pause
```

Copy `dist\alexa-broadcast-client-portable.zip` to the poster PC and run `Run Alexa Broadcast Client.bat`.

---

## Configuration

Copy `config.example.json` to `data/config.json` (Docker) or `config.json` (local). Key sections:

| Key | Purpose |
|-----|---------|
| `udpBroadcast.port` | UDP port (default **47832**) |
| `udpBroadcast.targets` | Optional unicast IPs if LAN broadcast is unreliable |
| `voiceEvents.enabled` | Master switch for voice query capture |
| `voiceEvents.*Queries` | Per-feature toggles (`timeQueries`, `weatherQueries`, `shoppingListQueries`, `teslaBatteryQueries`, `vivintAlarmQueries`, `notificationQueries`, …) |
| `voiceEvents.defaultLocation` | Lat/lon for generic outdoor weather |
| `voiceEvents.eventsLogFile` | JSONL audit log for all captured events (default `data/voice-events.jsonl`) |
| `timerSync.enabled` | Poll Amazon for active timers |
| `sessionKeepAlive.*` | Token refresh and session health |
| `teslaFleet.*` | Tesla Fleet API (domain, region, VIN, keep-alive) — secrets in `.env` |

Secrets and runtime data live under `data/` and are not committed.

### Tesla battery (Fleet API)

1. Host your EC public key at `https://YOUR-DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem`
2. Copy `.env.example` → `.env` and set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_FLEET_DOMAIN`, optional `TESLA_VIN`
3. `./tesla-register.sh` on NAS (or `npm run tesla-register` on PC) — register domain with Tesla (once per region)
4. **On your Windows PC:** `npm run tesla-auth` or `tesla-auth-pc.bat`  
   - Tesla portal redirect URI: `http://localhost:4381/callback` only (`http://` LAN IPs are **not** allowed)  
   - Saves `data/tesla-session.json` on the NAS share (even when run from `\\nas\...`)
5. Pair virtual key on phone: `https://www.tesla.com/_ak/YOUR-DOMAIN`
6. Recreate Docker listener after `.env` changes: `docker compose up -d --force-recreate`

Voice routine **"Alexa, show my Tesla battery"** fetches live `battery_level` from Fleet API (Alexa can reply "Sent to Display"). Without Tesla credentials, the bridge falls back to parsing Alexa's spoken answer.

**"Alexa, show Tesla dashboard"** fetches full `vehicle_data` (location, security, climate, TPMS, software, media) and shows the mission-control overlay. Requires Fleet API credentials. If the car is asleep or unreachable, the bridge serves the last successful snapshot (`data/tesla-dashboard-cache.json`) and the overlay shows an amber "cached" pill with the snapshot time instead of an empty error screen.

---

## Log files

### `data/voice-events.jsonl`

Append-only JSON lines for **all** captured events — broadcasts, voice queries, and timer snapshots. Each line includes a `ts` timestamp plus event fields:

```json
{"ts":"2026-07-06T18:00:00.000Z","type":"broadcast","device":"Kitchen Echo","message":"Dinner is ready","source":"voice-history","trigger":"history-poll"}
{"ts":"2026-07-06T18:01:00.000Z","type":"weather.query","device":"Kitchen Echo","query":"what's the weather"}
{"ts":"2026-07-06T18:02:00.000Z","type":"timer.snapshot","trigger":"sync-poll","timerCount":2,"event":{"kind":"list"}}
```

Path is configurable via `voiceEvents.eventsLogFile`.

### Other runtime files

| File | Purpose |
|------|---------|
| `data/alexa-session.json` | Saved Amazon session (from `npm run auth`) |
| `data/bridge-state.json` | Dedup fingerprints and last-seen timestamps |
| `data/timer-mirror.json` | Local mirror of active Amazon timers |
| `data/shopping-list-cache.json` | Shopping list cache across add/show commands |
| `data/session-auth-journal.jsonl` | Auth refresh and session health events |
| `data/auth-status.json` | Re-auth recommended/required signal |
| `data/tesla-session.json` | Tesla OAuth tokens (from `npm run tesla-auth`) |
| `data/tesla-auth-status.json` | Tesla re-auth signal |

**Legacy:** Older installs may still have `broadcast.txt` (tab-separated announcements). The bridge no longer writes this file; dedup state is migrated from it automatically on first startup after upgrade.

---

## UDP protocol (v2)

All payloads include `"version": 2` and a `"type"` field. Legacy clients that only read `message` still work for broadcasts.

Default port: **47832**. Payloads include `displaySeconds` (how long the overlay should stay up).

See `src/PROJECT.md` and `alexa broadcast client/src/PROJECT.md` for field-level details and overlay behavior.

---

## Testing

```bash
npm test                  # bridge unit tests (205)
run_all_tests.bat         # bridge + Windows client tests (205 + 44, from repo root)
```

Bridge Tesla tests: `test/tesla-fleet.test.js`, `test/tesla-udp-payload.test.js`, `test/tesla-auth-status.test.js`, `test/tesla-battery.test.js`, `test/tesla-dashboard.test.js`, `test/tesla-dashboard-data.test.js`, `test/tesla-dashboard-cache.test.js`, plus voice gate/dedup updates.

Manual UDP smoke tests (display client):

```bash
cd "alexa broadcast client"
python test/send_test.py --type broadcast
python test/send_test.py --type tesla-battery --percent 78 --seconds 30
python test/send_test.py --type tesla-dashboard --seconds 120
python test/send_test.py --type tesla-dashboard-stale --seconds 120
python test/send_test.py --type tesla-battery-limited --seconds 30
python test/send_test.py --type weather --seconds 45
```

---

## Diagnostics

```bash
npm run diagnose              # quick auth/API check
npm run diagnose-indoor       # list Smart Home thermostat entities
./scripts/dump-auth-diagnostics.sh   # on NAS: auth journal + status snapshot
```

If auth breaks after an Amazon change, run `npm run auth` (or `./reauth.sh` on the NAS).

---

## Notes

- Uses the unofficial [`alexa-remote2`](https://www.npmjs.com/package/alexa-remote2) library (same approach as Home Assistant / Node-RED integrations).
- Announcements sent **only** from the Alexa app may not always appear in voice history.
- Generic "what's the temperature" routes to **outdoor weather**; location-specific phrases ("top floor", "bedroom echo") route to **indoor temperature**.
- Indoor locations, air monitor names, and device aliases can be customized in `config.json` — see `src/PROJECT.md`.

---

## License

Private / household use. Not affiliated with Amazon.
