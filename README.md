# Alexa Broadcast Bridge

A Node.js service that connects to your personal Alexa account (unofficially, via `alexa-remote2`), listens for household voice activity, and **UDP-broadcasts JSON** to LAN display clients. The companion [**Windows display client**](alexa%20broadcast%20client/README.md) shows fullscreen overlays on a poster PC, movie screen, or kitchen display.

There is **no supported Amazon API** for passive listening. The bridge uses Alexa **push events** plus **voice history polling** and heuristics to detect what happened.

---

## What it captures

| Category | Example voice commands | UDP `type` | Logged to |
|----------|------------------------|------------|-----------|
| **Broadcasts / announcements** | "Alexa, announce dinner is ready" | `broadcast` | `broadcast.txt` |
| **Time** | "Alexa, what time is it?" | `time.query` | `data/voice-events.jsonl` |
| **Outdoor weather** | "Alexa, what's the weather?" / "what's the temperature?" | `weather.query` | `data/voice-events.jsonl` |
| **Indoor temperature** | "Alexa, what's the temperature on the top floor?" | `indoor-temperature.query` | `data/voice-events.jsonl` |
| **Air quality** | "Alexa, what is the air quality?" | `air-quality.query` | `data/voice-events.jsonl` |
| **Timers** | Set, cancel, "show my timers", timer fired | `timer.snapshot` | `data/voice-events.jsonl` |
| **Shopping list** | "Alexa, show my shopping list" / "add milk to my shopping list" | `shopping-list.snapshot` | `data/voice-events.jsonl` |
| **Music** | "Alexa, play …" (now playing from device) | `music.playing` | `data/voice-events.jsonl` |
| **Smart home** | "Alexa, turn the kitchen lights on" | `smart-home.command` | `data/voice-events.jsonl` |
| **Tesla battery** | Custom routine: "Alexa, show my Tesla battery" | `tesla-battery.query` | `data/voice-events.jsonl` |
| **Vivint alarm** | "Alexa, ask Vivint to arm" | `vivint-alarm.query` | `data/voice-events.jsonl` |
| **Notifications** | "Alexa, show my notifications" | `alexa-notifications.query` | `data/voice-events.jsonl` |

Each category can be toggled in `config.json` under `voiceEvents` (see [Configuration](#configuration)). Timer sync runs independently and still emits `timer.snapshot` even when other voice events are disabled.

---

## How it works

```
Echo / Alexa app  →  Amazon cloud  →  Bridge (NAS or PC)
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
      broadcast.txt              data/voice-events.jsonl         UDP :47832
   (announcements only)         (voice + timer events)              │
                                                                     ▼
                                                        Windows display client
                                                        (fullscreen overlays)
```

1. **Push path:** Amazon sends device-activity WebSocket events → bridge parses them immediately.
2. **History fallback:** Volume changes, reconnects, and periodic polls call `getCustomerHistoryRecords()` for anything missed.
3. **Broadcasts:** Matched announce/broadcast utterances are appended to **`broadcast.txt`** and sent as UDP `type: broadcast`.
4. **Voice queries:** Time, weather, shopping list, etc. are **not** written to `broadcast.txt`. They are sent over UDP and summarized in **`data/voice-events.jsonl`** (one JSON object per line: type, device, query).
5. **Timers:** Amazon's notifications API is polled; active timer lists and fire events emit `timer.snapshot` UDP payloads.

**Important:** `broadcast.txt` captures **only** broadcast/announcement messages — not weather, timers, shopping list, or other voice overlays. Use `data/voice-events.jsonl` to audit those.

---

## Repository layout

| Path | Role |
|------|------|
| `src/` | Bridge source (listener, parsers, UDP payloads, session keep-alive) |
| `alexa broadcast client/` | Windows tray app + fullscreen overlay (Python/Tkinter) |
| `config.example.json` | Default settings template |
| `data/` | Runtime files (session, config, logs) — gitignored |
| `DOCKER.md` | QNAP / Docker deployment guide |
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
| `broadcastLogFile` | Tab-separated log for **broadcasts only** (default `broadcast.txt`) |
| `udpBroadcast.port` | UDP port (default **47832**) |
| `udpBroadcast.targets` | Optional unicast IPs if LAN broadcast is unreliable |
| `voiceEvents.enabled` | Master switch for voice query capture |
| `voiceEvents.*Queries` | Per-feature toggles (`timeQueries`, `weatherQueries`, `shoppingListQueries`, `teslaBatteryQueries`, `vivintAlarmQueries`, `notificationQueries`, …) |
| `voiceEvents.defaultLocation` | Lat/lon for generic outdoor weather |
| `voiceEvents.eventsLogFile` | JSONL audit log for voice/timer UDP events (default `data/voice-events.jsonl`) |
| `timerSync.enabled` | Poll Amazon for active timers |
| `sessionKeepAlive.*` | Token refresh and session health |

Secrets and runtime data live under `data/` and are not committed.

---

## Log files

### `broadcast.txt` (announcements only)

Tab-separated fields:

```
timestamp    message    device    source    trigger
```

Example: a broadcast from the Kitchen Echo appears here. A weather question does **not**.

### `data/voice-events.jsonl`

Append-only JSON lines for voice queries and timer snapshots:

```json
{"type":"weather.query","device":"Kitchen Echo","query":"what's the weather"}
{"type":"timer.snapshot","trigger":"sync-poll","timerCount":2,"event":{"kind":"list"}}
```

### Other runtime files

| File | Purpose |
|------|---------|
| `data/alexa-session.json` | Saved Amazon session (from `npm run auth`) |
| `data/bridge-state.json` | Dedup fingerprints and last-seen timestamps |
| `data/timer-mirror.json` | Local mirror of active Amazon timers |
| `data/shopping-list-cache.json` | Shopping list cache across add/show commands |
| `data/session-auth-journal.jsonl` | Auth refresh and session health events |
| `data/auth-status.json` | Re-auth recommended/required signal |

---

## UDP protocol (v2)

All payloads include `"version": 2` and a `"type"` field. Legacy clients that only read `message` still work for broadcasts.

Default port: **47832**. Payloads include `displaySeconds` (how long the overlay should stay up).

See `src/PROJECT.md` and `alexa broadcast client/src/PROJECT.md` for field-level details and overlay behavior.

---

## Testing

```bash
npm test                  # bridge unit tests (Node built-in runner)
run_all_tests.bat         # bridge + Windows client tests (from repo root)
```

Manual UDP smoke tests (display client):

```bash
cd "alexa broadcast client"
python test/send_test.py --type broadcast
python test/send_test.py --type weather --seconds 45
python test/send_test.py --type timers --seconds 45
python test/send_test.py --type vivint-alarm --seconds 30
python test/send_test.py --type notifications --seconds 45
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
