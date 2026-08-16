# Signal Bridge

<p align="center">
  <img src="docs/signal-bridge-logo.png" alt="Signal Bridge logo" width="160" height="160">
</p>

**Signal Bridge** connects household services to smart displays: it monitors Alexa (and other integrations), bridges events across the LAN, and gives you a phone UI — **Signal** — to push content, unlock remote control, and manage displays.

The companion [**Windows display client**](alexa%20broadcast%20client/README.md) shows fullscreen overlays on a poster PC, movie screen, or kitchen display. Alexa voice capture still uses `alexa-remote2` (unofficial); there is **no supported Amazon API** for passive listening.

> **Required for any real LAN deploy:** set a shared **LAN UDP secret** (`LAN_UDP_SECRET` on the bridge, matching `udpSecret` on every display). Without it, overlays, remote keyboard/mouse, reboot, and `web.open` travel as **plaintext UDP** — anyone on the LAN can forge them. See [LAN UDP encryption](#lan-udp-encryption). Generate with `openssl rand -base64 32`.

---

## Features at a glance

| Area | What you get |
|------|----------------|
| **Voice → display** | Announcements, time, weather, indoor temp, air quality, timers, reminders, alarms, shopping list, music, smart home, Tesla, Vivint, notifications |
| **Signal (web UI)** | Guest photo booth at `https://<NAS_IP>:47810/` — PIN-gated (6-digit code rotates every 24h; shown on the Guest Snaps display overlay; Request PIN pushes that overlay). Full admin UI at `https://<NAS_IP>:47810/admin/` (password from `ADMIN_PASSWORD` in `.env`) — push Tesla/URL, close browser, reboot/power off, touchpad + keyboard, Alexa/Tesla re-auth, Slideshow Manager |
| **Display discovery** | Each Windows client **advertises** itself (`display.announce` on UDP `:47833`); Signal lists them live and can target one or all. Duplicate names are OK — each PC has a unique id; the picker shows `Name · ab12` when names collide |
| **In-browser on the display** | Push any URL → fullscreen **WebView2** browser on the poster PC until you close it |
| **Remote input (PIN unlock)** | Mouse / keyboard / reboot / power-off require unlocking the selected display: a 6-digit PIN appears on that screen; enter it on the phone to unlock for ~1 hour |

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
| **Reminders** | "Remind me in an hour" / reminder coming due | `reminder.fired` |
| **Alarms** | "Alexa, show my alarms" / set / cancel | `alarm.snapshot` |
| **Shopping list** | "Alexa, show my shopping list" / "add milk to my shopping list" | `shopping-list.snapshot` |
| **Music** | "Alexa, play …", "what's playing", or "next"/"skip" (music only — not news/briefing) | `music.playing` |
| **Smart home** | "Alexa, turn the kitchen lights on" | `smart-home.command` |
| **Tesla battery** | Custom routine: "Alexa, show Tesla battery" | `tesla-battery.query` (Fleet API when configured) |
| **Tesla dashboard** | Custom routine: "Alexa, show Tesla dashboard" | `tesla-dashboard.query` (Fleet API `vehicle_data`) |
| **Vivint alarm** | "Alexa, ask Vivint to arm" | `vivint-alarm.query` |
| **Notifications** | "Alexa, show my notifications" | `alexa-notifications.query` |

All captured events are logged to **`data/voice-events.jsonl`** and sent over UDP. Voice categories can be toggled in `config.json` under `voiceEvents` (see [Configuration](#configuration)). Timer sync runs independently and still emits `timer.snapshot` even when other voice events are disabled.

---

## How it works

```
Echo / Alexa app  →  Amazon cloud  →  Bridge (NAS Docker, host network)
                                          │
          ┌───────────────────────────────┼───────────────────────────────┐
          ▼                               ▼                               ▼
 data/voice-events.jsonl          HTTPS :47810                     UDP :47832
 (audit log)                      Signal (control UI)              overlays / commands
                                          │                               │
                                          │                    ┌──────────┴──────────┐
                                          │                    ▼                     ▼
                                          │           Windows display client   (optional more PCs)
                                          │                    │
                                          │         ┌──────────┼──────────┐
                                          │         ▼          ▼          ▼
                                          │    Tk overlay  WebView2   mouse/key
                                          │                 browser
                                          │
                                          └──── display.announce ←── UDP :47833
                                                (client → bridge registry)
```

1. **Push path:** Amazon sends device-activity WebSocket events → bridge parses them immediately.
2. **History fallback:** Volume changes, reconnects, and periodic polls call `getCustomerHistoryRecords()` for anything missed.
3. **On match:** Build typed UDP payload → append one JSON line to **`data/voice-events.jsonl`** → send UDP to display client(s) on **`:47832`**.
4. **Timers / alarms:** Amazon's notifications API is polled; lists and fire/set events emit snapshot UDP payloads.
5. **Display discovery:** Each client periodically unicasts `display.announce` to the NAS on **`:47833`** (and replies to `display.discover`). The bridge keeps `data/displays-registry.json` and Signal updates live (SSE).
6. **Signal UI:** Trusted-LAN HTTPS UI can push overlays, open/close a browser URL, reboot/power off, and inject mouse/keyboard to a **selected** display (unicast).

On startup, the bridge rebuilds broadcast dedup fingerprints from **`data/voice-events.jsonl`**. Legacy **`broadcast.txt`** files (if present from older installs) are still read once for dedup migration but are no longer written.

---

## Signal (web UI)

Accept the self-signed certificate once. Optional HTTP redirect: `:47811` → HTTPS.

| URL | Who | What |
|-----|-----|------|
| `https://<NAS_IP>:47810/` | Guests | Photo booth — pick a display and share a photo (saved to the party slideshow) |
| `https://<NAS_IP>:47810/admin/` | Host | Full control UI (password from `ADMIN_PASSWORD` in `.env`) |

**Alexa “Guest Snaps”:** say *Alexa, open guest snaps* to put a dual-QR welcome on every display (join home Wi‑Fi, then open the booth). Say *Alexa, open guest snaps slideshow* to play every stored guest photo on all displays. Prefer these over “photobooth” — Alexa reserves that word. Set `GUEST_WIFI_SSID` / `GUEST_WIFI_PASSWORD` in `.env` (booth URL defaults to `https://<PROXY_OWN_IP>:47810/`).

Admin tabs after login:

| Tab | Actions |
|-----|---------|
| **Push** | Tesla dashboard / battery, open URL (type or scan QR), close browser, Shared Photo Slideshow |
| **Remote** | Reboot / power off the selected display PC |
| **Control** | Touchpad + on-screen keyboard (single display only) |
| **Slideshow** | Manage shared photos |
| **Settings** | Slideshow order/timing, re-authenticate Amazon Alexa / Tesla Fleet |

**Display picker** (admin, sticky at the top): lists clients that have announced. Default is the first display; **All Displays** is last. Refresh asks every client to re-announce. New displays appear without reloading the page.

**Requirements:** Bridge `webServer.enabled` (default on), `ADMIN_PASSWORD` set for `/admin`, Docker `network_mode: host`, and at least one display client with `bridgeHosts` pointing at the NAS (see [Display discovery](#display-discovery)).

iPhone camera QR needs HTTPS + accepting the cert. Put your NAS LAN IP in `webServer.certHosts` (or `PROXY_OWN_IP`) before the first cert is generated, or delete `data/web-certs/` and restart after updating hosts.

---

## Display discovery

Displays **advertise to the bridge** so Signal knows who is online and can target them.

| Direction | Port | Payload |
|-----------|------|---------|
| Client → bridge | **47833** (`discoveryPort`) | `display.announce` — id, name, listen port |
| Bridge → clients | **47832** | `display.discover` — asks clients to announce now |
| Bridge → clients | **47832** | overlays + `web.*` / `system.*` / `input.*` (optionally `target.id`) |

### LAN UDP encryption (required on a real network)

UDP carries overlays **and** dangerous commands (`system.command` reboot/power-off, `input.*` remote keyboard/mouse, `web.open`). Those are **plaintext unless you set a shared secret**. Leaving the secret empty is for local smoke tests only — **not** a trusted home LAN.

**Do this before relying on Signal in production:**

1. Generate a long random value: `openssl rand -base64 32`
2. Bridge `.env`: `LAN_UDP_SECRET=...` (see [`.env.example`](.env.example))
3. Each display `config.json`: `"udpSecret": "..."` (same value)
4. `./recreate.sh` on the NAS, then restart/redeploy every display client

When set, traffic uses AES-256-GCM (protocol v3 envelope), including `display.announce`. Mismatched or missing secrets drop packets (check bridge/client logs). Anyone who knows the secret is trusted like the bridge — keep it out of git and guest machines.

Clients should also set in their `config.json`:

```json
"displayName": "Poster Display",
"bridgeHosts": ["192.168.1.10"],
"discoveryPort": 47833
```

Unicast to `bridgeHosts` is important: LAN broadcast to `255.255.255.255` often never reaches a NAS. Host-network Docker does **not** need a published UDP port map for discovery.

---

## Browser on the display (WebView2)

From **Signal → Push → Open URL** (or QR scan):

1. Bridge validates the URL and sends UDP `web.open` (unicast if one display is selected).
2. The Windows client pre-flights the URL, then launches a frameless fullscreen **Edge WebView2** window (persistent profile for saved passwords).
3. The browser stays up until **Close Browser** (`web.close`) or a power command.

Needs the **WebView2 runtime** on the display PC (included on modern Windows 10/11). Failures show a short “Cannot display content at this time” overlay.

---

## Repository layout

| Path | Role |
|------|------|
| `src/` | Bridge source (listener, parsers, UDP, display registry, control web server) |
| `src/web/` | Signal UI (HTML/JS/CSS + logo) |
| `alexa broadcast client/` | Windows tray app + overlays + WebView2 host (Python) |
| `config.example.json` | Default settings template |
| `data/` | Runtime files (session, config, logs, certs, display registry) — gitignored |
| `tesla-auth-pc.bat` | Windows OAuth helper (use from NAS share; handles UNC via `pushd`) |
| `scripts/tesla-common.sh` | Shared helpers for `tesla-*.sh` NAS scripts |
| `src/PROJECT.md` | Bridge architecture reference (for developers / agents) |
| `alexa broadcast client/src/PROJECT.md` | Display client architecture reference |

---

## Prerequisites

- **Bridge:** Node.js 18+, Amazon account with Alexa devices
- **Display client:** Windows 10+, same LAN as the bridge
  - UDP **47832** (overlays / commands)
  - Outbound UDP **47833** to the NAS (display announce)
  - Edge **WebView2** for pushed URLs
  - Matching **`udpSecret`** / bridge **`LAN_UDP_SECRET`** (required on a real LAN — see [LAN UDP encryption](#lan-udp-encryption))
- **Phone control:** browser that can reach `https://<NAS_IP>:47810/`

---

## Quick start (development)

```bash
npm install
cp config.example.json data/config.json   # or config.json at repo root for local dev
cp .env.example .env                      # set ADMIN_PASSWORD; set LAN_UDP_SECRET for any real LAN
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

Typical setup: bridge in Docker on the NAS (`network_mode: host`), display client on a Windows poster PC.

```bash
./recreate.sh          # restart listener (src/ is bind-mounted; no rebuild needed for code changes)
./reauth.sh            # re-authenticate when session expires
```

See **[DOCKER.md](DOCKER.md)** for full QNAP Container Station instructions, auth workflow, control-page ports, and troubleshooting.

**Display PC:** build the portable client on a Windows machine with Python 3.10+:

```bat
cd "alexa broadcast client"
build_portable.bat --no-pause
```

Copy `dist\alexa broadcast client.zip` to the poster PC, extract, set `bridgeHosts` / `displayName` / `udpSecret` (match `LAN_UDP_SECRET`) in `config.json`, then run `Run Alexa Broadcast Client.bat`.

---

## Configuration

Copy `config.example.json` to `data/config.json` (Docker) or `config.json` (local). Key sections:

| Key | Purpose |
|-----|---------|
| `udpBroadcast.port` | Overlay/command UDP port (default **47832**) |
| `udpBroadcast.discoveryPort` | Listen for `display.announce` (default **47833**) |
| `udpBroadcast.targets` | Optional unicast IPs if LAN broadcast of overlays is unreliable |
| `webServer.enabled/port` | Signal UI HTTPS (default **47810**) |
| `webServer.httpRedirectPort` | Optional HTTP→HTTPS redirect (default **47811**; `0` = off) |
| `webServer.certHosts` | Extra SAN names/IPs for the self-signed cert (include NAS LAN IP) |
| `voiceEvents.enabled` | Master switch for voice query capture |
| `voiceEvents.*Queries` | Per-feature toggles (`timeQueries`, `weatherQueries`, `shoppingListQueries`, `teslaBatteryQueries`, …) |
| `voiceEvents.defaultLocation` | Lat/lon for generic outdoor weather |
| `voiceEvents.eventsLogFile` | JSONL audit log (default `data/voice-events.jsonl`) |
| `timerSync.enabled` | Poll Amazon for active timers |
| `sessionKeepAlive.*` | Token refresh and session health |
| `teslaFleet.*` | Tesla Fleet API (domain, region, VIN, keep-alive) — secrets in `.env` |

Secrets and runtime data live under `data/` and are not committed.

### Tesla battery (Fleet API)

1. Host your EC public key at `https://YOUR-DOMAIN/.well-known/appspecific/com.tesla.3p.public-key.pem`
2. Copy `.env.example` → `.env` and set `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET`, `TESLA_FLEET_DOMAIN`, optional `TESLA_VIN`
3. `./tesla-register.sh` on NAS (or `npm run tesla-register` on PC) — register domain with Tesla (once per region)
4. **OAuth (pick one):**
   - **Windows PC:** `npm run tesla-auth` or `tesla-auth-pc.bat` — Tesla portal redirect URI `http://localhost:4381/callback` (`http://` is only allowed for localhost)
   - **Phone (Signal):** Settings → Authenticate Tesla — Tesla requires a public CA domain (not a LAN IP). Add `https://fleetapi.YOURDOMAIN/callback` in the Tesla developer app and `.env`, and reverse-proxy that path on the host that serves the Fleet domain to `http://<NAS_IP>:4381/callback`
   - Saves `data/tesla-session.json` on the NAS share
5. Pair virtual key on phone: `https://www.tesla.com/_ak/YOUR-DOMAIN`
6. Recreate Docker listener after `.env` changes: `docker compose up -d --force-recreate`

Voice routine **"Alexa, show Tesla battery"** fetches live `battery_level` from Fleet API (Alexa can reply "Sent to Display"). Without Tesla credentials, the bridge falls back to parsing Alexa's spoken answer.

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
| `data/displays-registry.json` | Known display clients from `display.announce` |
| `data/web-certs/` | Self-signed TLS for the Signal UI |
| `data/timer-mirror.json` | Local mirror of active Amazon timers |
| `data/shopping-list-cache.json` | Shopping list cache across add/show commands |
| `data/session-auth-journal.jsonl` | Auth refresh and session health events |
| `data/auth-status.json` | Re-auth recommended/required signal |
| `data/tesla-session.json` | Tesla OAuth tokens (from `npm run tesla-auth`) |
| `data/tesla-auth-status.json` | Tesla re-auth signal |

**Legacy:** Older installs may still have `broadcast.txt` (tab-separated announcements). The bridge no longer writes this file; dedup state is migrated from it automatically on first startup after upgrade.

---

## UDP protocol (v2 payloads; optional v3 encrypted wire)

All payloads include `"version": 2` and a `"type"` field. Legacy clients that only read `message` still work for broadcasts.

| Port | Use |
|------|-----|
| **47832** | Bridge → clients: overlays, `web.open` / `web.close`, `system.command`, `input.*`, `display.discover` |
| **47833** | Clients → bridge: `display.announce` |

Payloads may include `displaySeconds`, and optionally `target: { id }` or `target: { all: true }` for directed delivery.

See `src/PROJECT.md` and `alexa broadcast client/src/PROJECT.md` for field-level details and overlay behavior.

---

## Testing

```bash
npm test                  # bridge unit tests
run_all_tests.bat         # bridge + Windows client tests (from repo root)
```

Manual UDP smoke tests (display client):

```bash
cd "alexa broadcast client"
python test/send_test.py --type broadcast
python test/send_test.py --type tesla-battery --percent 78 --seconds 30
python test/send_test.py --type tesla-dashboard --seconds 120
python test/send_test.py --type web-open --url https://example.com
python test/send_test.py --type display-discover
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
- **Always set `LAN_UDP_SECRET` + matching client `udpSecret` on a real network.** Empty secret = forgeable reboot / remote input / WebView over UDP. See [LAN UDP encryption](#lan-udp-encryption).
- Announcements sent **only** from the Alexa app may not always appear in voice history.
- Routines **Run from the Alexa app** (pick a device) are best-effort: the bridge has no Amazon “routine executed” webhook. Capture uses richer history fields, more push poll hints, and your automation catalog (`getAutomationRoutines`). If a Run still does nothing, check `data/unmatched-activities.jsonl` after the attempt.
- Generic "what's the temperature" routes to **outdoor weather**; location-specific phrases ("top floor", "bedroom echo") route to **indoor temperature**.
- Indoor locations, air monitor names, and device aliases can be customized in `config.json` — see `src/PROJECT.md`.
- The Signal guest booth is intentionally public on a **trusted LAN**; admin UI requires `ADMIN_PASSWORD`. Do not expose control ports to the internet without understanding that trade-off.

---

## License

Private / household use. Not affiliated with Amazon.
