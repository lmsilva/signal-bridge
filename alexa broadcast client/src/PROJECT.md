# Alexa Broadcast Client — project map

> **For AI agents:** Read this file first when working on the Windows display client.  
> **Keep fresh:** Update this file whenever you change modules, config, UDP handling, overlay UI, or packaging. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-07-21

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
| `src/overlay.py` | Fullscreen shell: fade, dismiss countdown label (bottom), routes payloads to panels; rounded backdrop frame behind all panels |
| `src/display_panels.py` | All overlay panels; `BasePanel` has shared dark palette + `_round_rect`/`_pill`/`_panel_card` helpers; `TeslaDashboardPanel` fetches live OSM map tiles |
| `src/payload_utils.py` | Type detection; timer helpers; `format_limit_reset_time` for Tesla rate limits |
| `src/weather_fetch.py` | Client geocode + Open-Meteo fetch; spoken-response location extraction |
| `src/message_scroll.py` | Long broadcast message scroll animation |
| `src/tray_app.py` | pystray icon; exit triggers shutdown |
| `src/web_overlay.py` | `WebOverlayManager` — pre-flights pushed URLs, spawns/kills the WebView2 host; `build_web_error_payload` for the friendly failure message |
| `src/webview_host.py` | Standalone WebView2 (pywebview) host: frameless fullscreen always-on-top browser with layered-window opacity (`webview-host.exe` in portable build) |
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
| `alarm.snapshot` | Active wake alarms across devices — time, location, optional label; highlights newly set alarm |
| `shopping-list.snapshot` | Shopping list items with paging |
| `music.playing` | Large centered album art + track info |
| `smart-home.command` | Device on/off panel |
| `tesla-battery.query` | Model Y image + battery % bar; Fleet API data with error/rate-limit states; **stale cache** shows last known % with amber legend |
| `tesla-dashboard.query` | Mission-control dashboard — live OSM map (from `map.latitude`/`longitude`, dark-tinted tiles, pulsing pin + heading arrow), car render with security pills, battery bar, climate/TPMS/odo/software 2×2 grid, media strip |
| `vivint-alarm.query` | Lock icon + armed/disarmed status (Vivint stay/away) |
| `alexa-notifications.query` | Amber notification banner + parsed notification cards |
| `request.processing` | Animated spinner + staged "working on it" messages while bridge fetches slow external data (Tesla); timeout failure state after `request.timeoutSeconds` |
| `web.open` | **Command (no overlay):** pre-flight `web.url`; success → spawn `webview-host` (persistent frameless browser, stays until `web.close`); failure → "Cannot display content at this time" broadcast with `web.errorDisplaySeconds` timeout |
| `web.close` | **Command:** kill the WebView2 host |
| `system.command` | **Command:** `system.action` `reboot`/`poweroff` → Windows `shutdown /r|/s /t 5` (closes browser overlay first) |


`event.kind` on timers: `started`, `list`, `fired`. Empty timer lists (`event.kind: list`, `timers: []`) are ignored.

Test locally:

```bash
python test/send_test.py --type broadcast
python test/send_test.py --type tesla-battery --percent 78 --seconds 30
python test/send_test.py --type tesla-dashboard --seconds 120
python test/send_test.py --type tesla-dashboard-stale --seconds 120
python test/send_test.py --type tesla-battery-limited --seconds 30
python test/send_test.py --type tesla-battery-stale --seconds 30
python test/send_test.py --type vivint-alarm --seconds 30
python test/send_test.py --type notifications --seconds 45
python test/send_test.py --type weather --seconds 45
python test/send_test.py --type indoor --seconds 45
python test/send_test.py --type indoor-humidity --seconds 45
python test/send_test.py --type air-quality --seconds 45
python test/send_test.py --type air-quality-poor --seconds 45
python test/send_test.py --type timers --seconds 45
python test/send_test.py --type timer-fired --seconds 120
python test/send_test.py --type alarms --seconds 45
python test/send_test.py --type alarm-set --seconds 45
python test/send_test.py --type web-open --url https://example.com
python test/send_test.py --type web-open-bad          # friendly error path
python test/send_test.py --type web-close
python test/send_test.py --type system-reboot         # careful: actually reboots
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
| `webOverlayOpacity` | 0.88 | WebView2 browser overlay opacity (matches `overlayOpacity`) |
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
- **Tracked deploy artifacts (git):** `.gitignore` keeps the unpacked `dist/alexa broadcast client/` tree out of git, but tracks:
  - `dist/Deploy Alexa Broadcast Client.bat` — one-click deploy on the poster PC (`C:\MoviePoster`)
  - `dist/alexa broadcast client.zip` — packaged client
  - `dist/send-test.exe` — UDP smoke-test helper
- **Auto-start:** shortcut in `shell:startup` on Windows

**Portable build:** run `build_portable.bat --no-pause` only when the user asks — do not build automatically after display edits. Do not launch the portable exe unless asked to test locally.

**Requirements:** Python 3.10+, `pystray`, `Pillow`, `pywebview` (see `requirements.txt`). The web display mode needs the **Edge WebView2 runtime** on the poster PC (preinstalled on Win10/11); if missing, the client shows the friendly error instead.

**Multi-exe layout:** `alexa-broadcast-client.exe` + `webview-host.exe` share the `dist/alexa broadcast client/` folder (one `COLLECT`); `send-test.exe` stays a separate onefile helper.

---

## Testing

```powershell
test\run_tests.bat              # client unit tests only (78 tests)
```

From repo root (bridge + client):

```powershell
..\run_all_tests.bat            # 280 bridge + 78 client
```

**Unit tests:** `test/test_payload_utils.py` (incl. Tesla fleet + `format_limit_reset_time`), `test_config.py`, `test_weather_fetch.py`, `test_main.py` (timer routing, fired payload build, display seconds), `test_web_overlay.py` (URL pre-flight, host command build, web/system command routing, friendly error payload).

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
4. **Tesla battery:** `.env` + `data/tesla-session.json` on NAS; virtual key paired; `teslaBatteryQueries` enabled
5. Same UDP port both sides
6. Windows firewall allows inbound UDP
7. Optional: `targets: ["<this-pc-ip>"]` on bridge

### Tesla `battery` object (display)

| Field | UI use |
|-------|--------|
| `percent` | Bar fill + centered % |
| `chargingLabel` | Subtitle below bar when `status: ok` |
| `status` / `error` | Error headline when not `ok` |
| `limitResetAt` | `format_limit_reset_time()` → "Try again at …" |

Smoke: `python test/send_test.py --type tesla-battery-limited --seconds 30`

---

## Recent changes

- 2026-07-21: **Web browser display + remote commands** — new `web_overlay.py` (URL pre-flight with SSL fallback, spawn/kill of the host, early-death watch) and `webview_host.py` (pywebview/Edge WebView2, frameless fullscreen on-top). `main.py` intercepts `COMMAND_TYPES` (`web.open`/`web.close`/`system.command`) before the display path; failures show "Cannot display content at this time" through the normal overlay. **UDP listener fix:** `listener.py` previously dropped non-display types via `is_display_payload`, so `web.open` never reached the app (Tesla still worked). Now accepts commands via `is_accepted_payload` / `COMMAND_TYPES` in `payload_utils.py`. WebView2 layered-window alpha removed (blank window). Smoke types: `web-open`, `web-open-bad`, `web-close`, `system-reboot`, `system-poweroff`.
- 2026-07-11: **Track deploy artifacts in git** — `.gitignore` now allows `dist/Deploy Alexa Broadcast Client.bat`, `dist/alexa broadcast client.zip`, and `dist/send-test.exe` while still ignoring the unpacked PyInstaller folder. Deploy bat kills the running client, replaces `C:\MoviePoster\alexa broadcast client` from the NAS zip, and launches it.
- 2026-07-11: **Weather location: warning-idiom guard** — `resolve_location_for_fetch`/`extract_named_location` (`weather_fetch.py`) reject weather-warning idioms as cities via `_LOCATION_STOPWORD_RE` and only mine Alexa's spoken answer for a location when the query has no local marker (`_LOCAL_SCOPE_RE`). Fixes "what's the weather outside" showing "effect until Tuesday morning" as the location instead of the configured default. Matches the bridge fix in `weather-location.js`.
- 2026-07-11: **Refreshing cache legend** — Tesla battery panel and dashboard header render `stale+refreshing` payloads (bridge cache preview while the live fetch runs) with a calm accent "⟳ updating · cached Xm ago" pill and "Showing saved data from {time} — fetching live update…" legend instead of the amber unreachable styling; the live payload replaces the preview. Smoke: `send_test.py --type tesla-battery-refreshing` / `--type tesla-dashboard-refreshing`.
- 2026-07-11: **Processing placeholder panel** — new `ProcessingPanel` (`request.processing`) shows an animated spinner, staged reassurance messages from the payload (`processing_stage_message` in `payload_utils.py`), an elapsed-seconds pill after 5s, and a timeout/failure state ("… unavailable / try again") after `request.timeoutSeconds` (45s default). Real data payload replaces it via the normal advance path. Smoke: `send_test.py --type processing` / `--type processing-timeout`.
- 2026-07-09: **Time panel flicker fix** — `resolve_time_display_datetime` in `payload_utils.py` uses parsed hour/minute or current local time instead of the UDP activity timestamp (which caused a wrong hour flash before the tick corrected it).
- 2026-07-09: **Media volume label** — Tesla dashboard media tile shows `21% volume` via `format_tesla_media_volume_label` (accepts bridge `volumePercent` or legacy raw 0–11 `volume`).
- 2026-07-09: **Charge time to full** — Tesla battery card uses `format_charge_time_to_full()` on `timeToFullChargeMin` (e.g. `6h 34m to full` instead of misreading API hours as minutes). — SSL cert failures are now detected inside `URLError` wrappers (frozen builds without a CA bundle silently failed before); once the unverified-context fallback succeeds it sticks for the session. Tiles are disk-cached in `map-tiles/` next to the app so the home area renders instantly and offline. All failures append to `map-errors.log` (visible even for the windowed exe) and the map card shows "⚠ map offline — see map-errors.log" when every fetch attempt fails. Manual smoke: `.venv\Scripts\python.exe test\smoke_map_fetch.py [lat] [lon]`; unit tests in `test/test_map_fetch.py`.
- 2026-07-08: **Portrait overlap fixes** — climate tile lays out bottom-up (pills, temp scale, then adaptive temp block: outside temp moves inline next to "cabin" on short tiles, scale drops when there's no room); odometer value anchors below the tile title, detail rows stop before colliding, FSD donut skipped under 56px; software tile value clamps below its title; portrait stat tiles get taller (map shrinks first, 168px tile minimum). Vivint alarm panel flows top-down with bbox-measured cursors (wrapped headline can't overlap "House Secured") and auto-downsizes the headline font to fit one line. Map tiles now fetch in parallel with per-tile retry, SSL-fallback, stderr logging, partial stitches, and one delayed retry on total failure.
- 2026-07-08: **Battery stale-cache legend** — `TeslaBatteryPanel` shows last cached % with amber "⚠ cached · Xm ago" pill + "{reason} — data from {time}" when `battery.stale`; `format_freshness_sec` / `format_cached_time_label` in `payload_utils.py`. Smoke: `send_test.py --type tesla-battery-stale`.
- 2026-07-08: **Dashboard polish round 4** — shared backdrop frame is hidden while the Tesla dashboard is active (its own container was rendering as a double box); map heading indicator is now a compass-needle chevron riding the pulse ring (was a cursor-like arrow); odometer tile draws an FSD donut chart (accent arc + % in center + FSD/Manual legend) when `odometer.fsdMilesPercent` is present — note Tesla only exposes FSD mileage via Fleet Telemetry streaming (`SelfDrivingMilesSinceReset`, HW4 + fw 2025.44.25.5+), not the polled `vehicle_data` endpoint, so live payloads currently omit it.
- 2026-07-08: **Dashboard polish round 3** — tires tile now uses the real top-down Model Y render (`assets/tesla-top-down.png`, transparent background) with psi labels aligned to the wheel positions and blue/amber wheel markers; climate pills auto-shorten ("☀ Protect") and never bleed past the tile edge; odometer/software footer lines truncate with "…" via `_fit_text`; software tile only mentions download % when an update actually exists (else shows current firmware); **stale-cache legend** — when the bridge serves a cached dashboard (`dashboard.stale`), header shows an amber "⚠ cached · Xm ago" pill plus "Tesla unreachable — data from {time}" legend (freshness label now supports h/d).
- 2026-07-08: **Dashboard polish round 2** — map tiles rendered much brighter (light tint instead of heavy navy blend) and the dashboard shows fully opaque (opacity override, no desktop bleed); tires tile draws a top-down car with psi beside each wheel (amber wheel + ⚠ on warnings); climate tile has color-coded cabin/outside temps, a 30–110°F gradient scale with both markers, and AC/Heat/HVAC-off + cabin-protect pills; odometer tile adds FSD-vs-manual split bar, tire-rotation countdown, and range added last charge; media strip hides opaque numeric source codes (bridge maps to friendly names / Bluetooth device).
- 2026-07-08: **Mission-control restyle for every panel** — shared rounded-card/pill helpers on `BasePanel` (`_round_rect`, `_panel_card`, `_pill`, dark palette constants); rounded backdrop frame in `overlay.py`; rounded chips/rows/bars across broadcast, weather, air quality, timers, alarms, shopping list, music (rounded album art), Tesla battery, smart home + Vivint (halo icons, pill footers), notifications.
- 2026-07-08: **Tesla dashboard v2** — live OpenStreetMap tiles centered on GPS coords (dark navy tint, cached, background-fetched), pulsing pin ring animation, heading arrow, dashed car card with security pills, wheel-position TPMS grid, charging expands battery card; logo white matte stripped at load time; falls back to street-grid placeholder + coordinates text when offline/no label.
- 2026-07-08: **Tesla mission control dashboard** — `TeslaDashboardPanel` card layout (portrait stack / landscape 3-col); logo + car render; charging expands battery card.
- 2026-07-08: **Alarm time fix** — bridge parses Amazon `originalDate` + `originalTime` (v4 alarms often have `triggerTime: 0`); display falls back to `remainingSec` when `triggerTime` missing.
- 2026-07-06: **Wake alarms overlay** — `alarm.snapshot` lists alarms by device/time; newly set alarm row gets accent outline + NEW badge.
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
