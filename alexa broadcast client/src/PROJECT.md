# Alexa Broadcast Client — project map

> **For AI agents:** Read this file first when working on the Windows display client.  
> **Keep fresh:** Update this file whenever you change modules, config, UDP handling, overlay UI, or packaging. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-07-06

---

## What this is

A **Windows system-tray app** (Python + Tkinter) that listens for **UDP JSON** messages from the [NAS bridge](../../src/PROJECT.md) and shows a **fullscreen overlay** with the announcement text (e.g. on a movie-poster display PC).

Pair project: **alexa-broadcast-bridge** (Node, Docker on QNAP).

---

## System context

```
Alexa "announce …"  →  Bridge (NAS)  →  UDP JSON :47832  →  This client  →  Fullscreen overlay
```

The client does **not** talk to Amazon. It receives UDP and renders UI. Weather may be **fetched client-side** (Open-Meteo) when the bridge payload lacks `weather` or coordinates look wrong for the requested city.

---

## Repository layout (client)

| Path | Role |
|------|------|
| `src/main.py` | Entry: UDP listener + tray + Tk main loop; timer in-place updates + local fire handler |
| `src/listener.py` | `UdpListener` — background thread, JSON decode, `on_message` callback |
| `src/overlay.py` | Fullscreen shell: fade, dismiss countdown label (bottom), routes payloads to panels |
| `src/display_panels.py` | Broadcast, time, weather, indoor temperature, timer overlays |
| `src/payload_utils.py` | Type detection; `timer_label_name`, `timer_title`, `timer_detail_line` |
| `src/weather_fetch.py` | Client geocode + Open-Meteo fetch; spoken-response location extraction |
| `src/message_scroll.py` | Long broadcast message scroll animation |
| `src/tray_app.py` | pystray icon; exit triggers shutdown |
| `src/config.py` | Load `config.json`; `effective_display_seconds` (timers use full duration) |
| `src/paths.py` | Resolve config path for dev vs portable build |
| `config.json` | User settings (port, fade, display caps, colors) |
| `run.bat` | Dev: venv + `python src/main.py` |
| `build_portable.bat` | PyInstaller → `dist/alexa broadcast client/` (uses `%LOCALAPPDATA%` venv on NAS shares) |
| `alexa-broadcast-client.spec` | PyInstaller spec + hidden imports |
| `requirements-build.txt` | PyInstaller + runtime deps for portable build |
| `test/send_test.py` | Manual UDP smoke tests (`--type … air-quality|air-quality-poor …`) |
| `test/run_tests.bat` | Python `unittest` for `test_*.py` |
| `test/test_*.py` | Unit tests — payload utils, config, weather fetch, main timer routing |
| `README.md` | User-facing setup / portable build guide |

---

## Runtime flow

1. `BroadcastClientApp.start()` binds UDP (`0.0.0.0:47832` by default)
2. `run_tray()` — background tray icon
3. Hidden `tk.Tk` root; `OverlayWindow` created but not shown until message
4. `_poll_messages()` every 100ms — drains queue from UDP thread
5. **Non-timer payloads:** `_enqueue_display()` queues when overlay active
6. **`timer.snapshot` payloads:** update in-place via `_handle_timer_display()` — not queued; replaces pending timer snapshots
7. **Local timer fire:** overlay countdown hits 0 → `on_local_timer_fired` → fired alert with full `displaySeconds`
8. `overlay.show()` / `advance()` — routes by `type`; fade in/out unchanged
9. Click dismisses current overlay or advances queue (timers excluded from queue)

---

## Expected UDP payloads (v2)

All payloads include `version: 2` and `type`. Legacy broadcasts with only `message` still work.

| `type` | Overlay |
|--------|---------|
| `broadcast` | FROM / TO / TIME chips + scrolling message |
| `time.query` | Analog clock + digital time + full date |
| `weather.query` | Outdoor conditions, 24h strip, 7-day cards; larger weather icons |
| `indoor-temperature.query` | Indoor thermostat reading — location label, temp/humidity, cold/comfort/hot icon |
| `air-quality.query` | IAQ score ring + sensor tiles (temp, humidity, PM2.5, CO, VOC) |
| `timer.snapshot` | Active timers with **names**, device, remaining, duration; fired alert names timer + device |
| `shopping-list.snapshot` | Shopping list items with paging |
| `music.playing` | Large centered album art + track info |
| `smart-home.command` | Device on/off panel |
| `tesla-battery.query` | Model Y image + battery % bar from custom routine |
| `vivint-alarm.query` | Lock icon + armed/disarmed status (Vivint stay/away) |
| `alexa-notifications.query` | Amber notification banner + parsed notification cards |


`event.kind` on timers: `started`, `list`, `fired`. Empty timer lists (`event.kind: list`, `timers: []`) are ignored.

Test locally:

```bash
python test/send_test.py --type broadcast
python test/send_test.py --type tesla-battery --percent 78 --seconds 30
python test/send_test.py --type vivint-alarm --seconds 30
python test/send_test.py --type notifications --seconds 45
python test/send_test.py --type weather --seconds 45
python test/send_test.py --type indoor --seconds 45
python test/send_test.py --type indoor-humidity --seconds 45
python test/send_test.py --type air-quality --seconds 45
python test/send_test.py --type air-quality-poor --seconds 45
python test/send_test.py --type timers --seconds 45
python test/send_test.py --type timer-fired --seconds 120
```

---

## Configuration (`config.json`)

| Key | Default | Notes |
|-----|---------|-------|
| `listenPort` | 47832 | Must match bridge `udpBroadcast.port` |
| `listenAddress` | `0.0.0.0` | All interfaces |
| `maxDisplaySeconds` | 30 | Hard cap on overlay duration |
| `defaultDisplaySeconds` | 30 | If payload omits `displaySeconds` |
| `fadeInMs` / `fadeOutMs` | 400 / 600 | Animation |
| `overlayBackground` | dark rgba | Fullscreen tint |
| Font / layout keys | — | See `config.py` + `overlay.py` |

Timer and fired-timer overlays use the payload's full `displaySeconds` (not shortened to remaining time). Bridge `data/config.json` should list this PC in `udpBroadcast.targets` if LAN broadcast is flaky.

---

## Packaging

- **Dev:** `run.bat` → `.venv`, `pip install -r requirements.txt`, `python src/main.py`
- **Portable:** `build_portable.bat` → output folder **`dist/alexa broadcast client/`** (not `dist/` root)
  - Run **`Run Alexa Broadcast Client.bat`** inside that folder (same level as `alexa-broadcast-client.exe`)
  - Build venv: `%LOCALAPPDATA%\alexa-broadcast-client-build-venv` (avoids broken pip on NAS `.venv`)
  - Includes weather/timer test batch files in output
- **Distributable zip:** `build_portable.bat` also writes **`dist/alexa broadcast client.zip`**
  - Contains the `alexa broadcast client/` folder; extract on the display PC and run the launcher bat
- **Auto-start:** shortcut in `shell:startup` on Windows

**Portable build:** run `build_portable.bat --no-pause` only when the user asks — do not build automatically after display edits. Do not launch the portable exe unless asked to test locally.

**Requirements:** Python 3.10+, `pystray`, `Pillow` (see `requirements.txt`).

---

## Testing

```powershell
test\run_tests.bat              # client unit tests only
```

From repo root (bridge + client):

```powershell
..\run_all_tests.bat
```

**Unit tests:** `test/test_payload_utils.py`, `test_config.py`, `test_weather_fetch.py`, `test_main.py` (timer routing, fired payload build, display seconds).

**Manual smoke:** `test/send_test.py` with client running; Windows Firewall must allow UDP on the listen port.

**Before commit/push:** run full suite from repo root (`run_all_tests.bat`).

---

## UI behavior notes

- **Portrait vs landscape:** chosen from screen dimensions in `overlay.py`
- **Queue:** rapid announcements stack; user dismiss skips to next (timer snapshots bypass queue)
- **Timers:** show immediately when set; list updates in-place when another timer arrives or one is cancelled; empty list shows "No active timers"
- **Fired timer:** focused alert with timer name, device, duration; uses full dismiss timeout unless replaced by new active timer list
- **Weather dismiss:** "Dismisses in X" shown as bottom label (always visible above content)
- **Tray:** app stays resident; no main window until a message arrives

---

## Bridge integration checklist

1. Bridge running on NAS with valid `alexa-session.json`
2. `udpBroadcast.enabled: true` in bridge `data/config.json`
3. `voiceEvents` + `timerSync` enabled for weather/time/timer overlays
4. Same UDP port both sides
5. Windows firewall allows inbound UDP
6. Optional: `targets: ["<this-pc-ip>"]` on bridge

---

## Recent changes

- 2026-07-06: **Now Playing album art** — placeholder frame hidden while art loads; cover replaces chip/♪ without misaligned accent border.
- 2026-07-06: **Air quality overlay** — VOC/PM2.5/CO/temp/humidity tiles show alongside per-monitor rows (not either/or); extra spacing between "Indoor Air Quality" label and scale bar.
- 2026-07-06: **Vivint alarm + notifications panels** — `vivint-alarm.query` shows lock icon + armed stay/away headline (green secure theme); `alexa-notifications.query` uses amber banner/cards (Echo notification LED color) with parsed notification text.
- 2026-07-06: Empty notifications show **0 notifications** and "You're all caught up" when Alexa says there are none (including "no new notifications at the moment").
- 2026-07-06: Shopping list rows are compact, left-aligned, body font (20px landscape), thin accent stripe (no bullets).
- 2026-07-06: Tesla battery bar lowered below car image; repeat voice commands show again after dedup fix on bridge.
- 2026-07-06: Tesla battery panel shows colorized 0–100% bar (red→green) with centered percent; portable build prefers `assets/` next to exe over bundled copy.
- 2026-07-05: No display queue — new UDP payloads replace the active overlay. VOC tile shows human band (Low/Elevated/High). Weather hourly strip samples across full 24h. Shopping list, now playing, and smart-home panels (paginated list with dot indicator, 15s/page).
- 2026-07-05: `build_portable.bat` kills any running `alexa-broadcast-client.exe`/`send-test.exe` before building, zips with `tar` (Compress-Archive choked on locked files), and fails loudly if the zip can't be written.
- 2026-07-04: Weather fixes — Alexa's spoken current temperature wins the hero number; `clear-night` condition + crescent moon icon after dark (`is_day` from Open-Meteo); hourly "Now"/daily "Today" highlighted cards; hourly labels shown in the forecast location's local time; "Feels like" detail. Removed leftover files (`Run Portable.bat`, `run_long_test.bat`, `run_weather_timer_test.bat` — use `run_test.bat` with args).
- 2026-07-04: Portable build is on user request only — agents do not auto-run `build_portable.bat` after display edits.
- 2026-07-03: Air quality dashboard overlay (`air-quality.query`) — IAQ ring + PM/CO/VOC/temp/humidity tiles.
- 2026-07-03: Indoor temperature overlay (`indoor-temperature.query`) — cold/comfort/hot graphic; interrupts active overlay like weather.
- 2026-06-23: Timer cancel updates display (empty or remaining list); removed Active Timers counter from headline.
- 2026-06-23: Timer in-place updates, local fire handler, timer names on set/fire, weather client fetch + location from spoken response, dismiss countdown label, portable build venv fix, `test_main.py`, `run_tests.bat`, full-suite workflow.
- 2026-06-28: `OverlayShell` font refs from `OverlayWindow` (fixes startup crash).
- 2026-06-27: UDP v2 display modes — time clock, weather dashboard, timer list; typed payload routing in overlay.
- 2026-06-24: Added this PROJECT.md documenting architecture, UDP contract, and bridge pairing.
