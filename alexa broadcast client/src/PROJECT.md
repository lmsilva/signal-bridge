# Alexa Broadcast Client — project map

> **For AI agents:** Read this file first when working on the Windows display client.  
> **Keep fresh:** Update this file whenever you change modules, config, UDP handling, overlay UI, or packaging. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-07-26

---

## What this is

A **Windows system-tray app** (Python + Tkinter) that listens for **UDP JSON** from [Signal Bridge](../../src/PROJECT.md), shows **fullscreen overlays**, opens pushed URLs in **WebView2**, **announces** itself for the Signal display picker, and applies **remote mouse/keyboard** from the Signal phone UI.

Pair project: **Signal Bridge** (Node, Docker on QNAP; GitHub: `signal-bridge`). User guide: [README.md](../README.md).

---

## System context

```
Alexa / Signal UI  →  Signal Bridge (NAS)  →  UDP :47832  →  This client
                                ↑                            │
                                └──── display.announce ──────┘
                                      (UDP :47833 → bridgeHosts)

Client paths: Tk overlay panels | webview-host (WebView2) | input_control (SendInput/pynput)
```

The client does **not** talk to Amazon. Weather may be **fetched client-side** (Open-Meteo) when the bridge payload lacks `weather` or coordinates look wrong for the requested city.

---

## Repository layout (client)

| Path | Role |
|------|------|
| `src/main.py` | Entry: UDP listener + tray + Tk main loop; timer in-place updates + local fire handler; reconfigures `stdout`/`stderr` to UTF-8 (`errors="backslashreplace"`) at startup so a stray non-ASCII character in any `print()`/log call can't silently kill a background thread (Windows consoles often default to `cp1252`) |
| `src/listener.py` | `UdpListener` — background thread, JSON decode, `on_message` callback |
| `src/overlay.py` | Fullscreen shell: fade, dismiss countdown label (bottom), routes payloads to panels; rounded backdrop frame behind all panels |
| `src/display_panels.py` | All overlay panels; `BasePanel` has shared dark palette + `_round_rect`/`_pill`/`_panel_card` helpers; `TeslaDashboardPanel` fetches live OSM map tiles (via `map_tiles.py`); `QrPanel` renders a QR code locally via `qrcode` from the bridge's `qr.content` string (URL or Wi-Fi); `PhotoSlideshowPanel` plays through every stored photo once, newest-first (fetched off-thread, SSL-tolerant, centered for portrait/landscape), stopping on the last photo instead of looping, with a "Photo x of y" counter, a "Shared <date>" label, and a small corner QR code (via `QrPanel._build_qr_image`) linking to the current photo for viewing on a phone; `RoutePlannerPanel` renders `route-planner.query` instantly (header/distance/duration/mode badge) then independently fetches 5 tiles (map, 2× place facts, 2× weather) off-thread, each swapping its own spinner for content as it lands, plus a local-times strip once both weather fetches land; `MusicPanel`'s song/artist/album/detail lines are single-line only — each renders via `text_marquee.MarqueeLine`, so a title too wide for its column scrolls horizontally instead of wrapping (which could overflow the fixed vertical space reserved for the stacked lines) |
| `src/map_tiles.py` | Shared OSM tile fetch/stitch/cache/SSL-fallback + Web Mercator pixel math (`latlon_to_global_px`/`global_px_to_latlon`); `zoom_to_fit` picks the tightest zoom that fits two points in a box (Route Planner); `project_points_to_pixels` maps a route polyline onto the stitched tile image. Extracted from `TeslaDashboardPanel` (still its only single-point caller) so `RoutePlannerPanel` can reuse the same plumbing for a two-point map |
| `src/place_facts.py` | `fetch_place_summary(name)` — free Wikipedia REST summary lookup for the Route Planner facts tiles; falls back to MediaWiki search when the geocoded name (e.g. "Home, US") doesn't match a real article title verbatim (real article: "Saratoga Springs, Utah") |
| `src/payload_utils.py` | Type detection; timer helpers; `format_limit_reset_time` for Tesla rate limits; `format_route_distance`/`format_route_duration`/`format_local_time_at_offset` for the Route Planner panel |
| `src/weather_fetch.py` | Client geocode + Open-Meteo fetch; spoken-response location extraction; forecast dict includes `utcOffsetSeconds` (drives Route Planner's "local time there right now" strip without needing an IANA tzdata database) |
| `src/message_scroll.py` | Long broadcast message scroll animation (vertical) |
| `src/text_marquee.py` | `MarqueeLine` — single-line horizontal marquee for text that doesn't fit its column (Now Playing song/artist/album/detail); static+centered if it fits, otherwise loops pause → scroll-left → pause → reset indefinitely, same cadence as `message_scroll.py`'s vertical scroller |
| `src/tray_app.py` | pystray icon; exit triggers shutdown |
| `src/web_overlay.py` | `WebOverlayManager` — pre-flights pushed URLs, spawns/kills the WebView2 host; `build_web_error_payload` for the friendly failure message |
| `src/webview_host.py` | Standalone WebView2 (pywebview) host: frameless fullscreen always-on-top; persistent profile (`private_mode=False`) for saved passwords |
| `src/display_identity.py` | Stable `display.id` + `displayName` (hostname fallback) for bridge registration |
| `src/display_announce.py` | UDP `display.announce` to `bridgeHosts` + broadcast on `discoveryPort` (default 47833); responds to `display.discover`; log messages are ASCII-only (no `→`) so they can't raise `UnicodeEncodeError` on a `cp1252` console and silently kill the background announce thread |
| `src/input_control.py` | Apply `input.pointer` / `input.key` / `input.text` — absolute Win32 `SendInput` (tracked tip); clicks aimed at tip; `pynput` for keys; `handle_text()` types a whole string in one call (`Controller.type()`, Unicode-safe) instead of one keystroke per key, with optional trailing Enter. Keeps the process DPI-*unaware* so Tk overlay layouts match font metrics. |
| `src/remote_cursor.py` | Click-through software arrow at the remote tip; blanks system cursors while active; restores on idle or physical (non-injected) mouse move |
| `src/config.py` | Load `config.json`; `effective_display_seconds` (timers and `photo.slideshow` use the payload's full requested duration, bypassing `maxDisplaySeconds`) |
| `src/paths.py` | Resolve config path for dev vs portable build |
| `config.json` | User settings (port, fade, display caps, colors) |
| `run.bat` | Dev: venv + `python src/main.py` |
| `build_portable.bat` | PyInstaller → `dist/alexa broadcast client/` (uses `%LOCALAPPDATA%` venv on NAS shares) |
| `alexa-broadcast-client.spec` | PyInstaller spec + hidden imports |
| `requirements-build.txt` | PyInstaller + runtime deps for portable build |
| `test/send_test.py` | Manual UDP smoke tests (`--type … air-quality|air-quality-poor|input-text|photo-slideshow|route-planner|route-planner-flight …`) |
| `test/run_tests.bat` | Python `unittest` for `test_*.py` |
| `test/test_*.py` | Unit tests — payload utils, config, weather fetch, main timer routing, `QrPanel`, `PhotoSlideshowPanel`, `map_tiles` (incl. `zoom_to_fit`), `place_facts`, `RoutePlannerPanel` layout math + formatting helpers, `input_control`/display remote, `text_marquee` (`MarqueeLine` fit-vs-overflow, tick/pause/reset cycle, `stop()`) |
| `README.md` | User-facing setup / portable build guide |

---

## Runtime flow

1. `BroadcastClientApp.start()` binds UDP (`0.0.0.0:47832` by default)
2. `DisplayAnnouncer` starts — immediate + every 5 min `display.announce` to `bridgeHosts`:`discoveryPort`
3. `run_tray()` — background tray icon
4. Hidden `tk.Tk` root; `OverlayWindow` created but not shown until message
5. `_poll_messages()` every 100ms — drains queue from UDP thread
6. **Commands first:** `web.open` / `web.close` / `system.command` / `input.*` / `display.discover` (re-announce)
7. **Non-timer display payloads:** `_enqueue_display()` queues when overlay active
8. **`timer.snapshot`:** in-place update via `_handle_timer_display()`
9. **Local timer fire:** overlay countdown hits 0 → fired alert with full `displaySeconds`
10. Target filter: ignore payloads whose `target.id` is not this display
11. Click dismisses current overlay or advances queue (timers excluded from queue)

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
| `music.playing` | Large album art + track info — sized from available space (not a fixed cap) so it fills portrait; two-column art-left/text-right layout in landscape |
| `smart-home.command` | Device on/off panel |
| `tesla-battery.query` | Model Y image + battery % bar; Fleet API data with error/rate-limit states; **stale cache** shows last known % with amber legend |
| `tesla-dashboard.query` | Mission-control dashboard — live OSM map (from `map.latitude`/`longitude`, dark-tinted tiles, pulsing pin + heading arrow), car render with security pills, battery bar, climate/TPMS/odo/software 2×2 grid, media strip |
| `vivint-alarm.query` | Lock icon + armed/disarmed status (Vivint stay/away) |
| `alexa-notifications.query` | Amber notification banner + parsed notification cards |
| `request.processing` | Animated spinner + staged "working on it" messages while bridge fetches slow external data (Tesla); timeout failure state after `request.timeoutSeconds` |
| `web.open` | **Command (no overlay):** pre-flight `web.url`; success → spawn `webview-host` (persistent frameless browser, stays until `web.close`); failure → "Cannot display content at this time" broadcast with `web.errorDisplaySeconds` timeout |
| `web.close` | **Command:** kill the WebView2 host |
| `system.command` | **Command:** `system.action` `reboot`/`poweroff` → Windows `shutdown /r|/s /t 5` (closes browser overlay first) |
| `display.discover` | **Command:** remember bridge host from packet `_rinfo` + re-announce |
| `display.auth` | Overlay: unlock PIN, or green **Authenticated** for ~1s when `auth.status` is `ok` |
| `input.pointer` / `input.key` | **Command:** remote mouse — move/click/wheel all via Win32 `SendInput` (`pynput` only as fallback) / keyboard (`pynput`) |
| `input.text` | **Command:** full-string keyboard input — `text.{value, pressEnter}` typed in one shot via `pynput` `Controller.type()` (Unicode-safe), optional trailing Enter key |
| `qr.display` | `QrPanel` — renders a QR code (locally generated with `qrcode`, no bitmap sent over UDP) from `qr.{qrType: "url"\|"wifi", content, label}`; heading changes for URL vs Wi-Fi |
| `photo.slideshow` | `PhotoSlideshowPanel` — plays through `slideshow.photos[]` (bridge's shared-photo cache — kept indefinitely until deleted from the web Slideshow tab; each entry `{url, uploadedAt}`, ordered by the bridge per the persisted playback-order setting) once at `slideshow.secondsPerPhoto` (default 5) each, stopping after the last photo rather than looping; each photo fetched off the Tk thread and centered to fit portrait or landscape, with a "Photo x of y" counter, "Shared <date>" label, and small corner QR code linking to the current photo; no "Dismisses in…" countdown text is shown (the overlay suppresses it for this payload) though the auto-dismiss timer still fires once the pass completes; immediately replaced/interrupted like any other overlay when a new UDP payload of any kind arrives |
| `route-planner.query` | `RoutePlannerPanel` — draws its own full-size container (shared chrome title/backdrop hidden, same convention as `tesla-dashboard.query`); instant header (origin → destination, distance, duration, "Driving Estimate"/"Flight-Path Estimate" badge) from the payload's `origin`/`destination`/`distanceMiles`/`durationMin`/`mode`/`route.geometry`; 5 tiles start as spinners and fill in independently off-thread: map (OSM tiles zoomed to fit both points + route line/dashed great-circle + pins), 2× Wikipedia place-facts, 2× current weather; a "Local Times" strip (now at origin, now at destination, est. arrival) renders once both weather fetches land (uses `utcOffsetSeconds`) |


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
python test/send_test.py --type qr-url --url https://example.com
python test/send_test.py --type qr-wifi
python test/send_test.py --type input-text --text "hunter2" --press-enter
python test/send_test.py --type photo-slideshow
python test/send_test.py --type music              # check bigger album art, portrait + landscape
python test/send_test.py --type route-planner         # driving mode: map, facts, weather, local times
python test/send_test.py --type route-planner-flight   # flight fallback: dashed great-circle line
```

---

## Configuration (`config.json`)

| Key | Default | Notes |
|-----|---------|-------|
| `listenPort` | 47832 | Must match bridge `udpBroadcast.port` |
| `listenAddress` | `0.0.0.0` | All interfaces |
| `displayName` | hostname | Shown in bridge control page picker |
| `bridgeHosts` | `["192.168.1.10"]` | NAS IP(s) for announce unicasts |
| `discoveryPort` | 47833 | Must match bridge `udpBroadcast.discoveryPort` |
| `maxDisplaySeconds` | 30 | Hard cap on overlay duration |
| `defaultDisplaySeconds` | 30 | If payload omits `displaySeconds` |
| `fadeInMs` / `fadeOutMs` | 400 / 600 | Animation |
| `overlayBackground` | dark rgba | Fullscreen tint |
| `webOverlayOpacity` | 0.88 | WebView2 browser overlay opacity (matches `overlayOpacity`) |
| Font / layout keys | — | See `config.py` + `overlay.py` |

Timer and fired-timer overlays use the payload's full `displaySeconds` (not shortened to remaining time). Set `bridgeHosts` so discovery works; optionally list this PC in bridge `udpBroadcast.targets` if overlay broadcast is flaky.

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

**Portable build:** run `build_portable.bat` only when the user asks — do not build automatically after display edits. Do not launch the portable exe unless asked to test locally. Success exits immediately; `--pause` keeps the window open.

**Requirements:** Python 3.10+, `pystray`, `Pillow`, `pywebview`, `qrcode` (pure Python, uses Pillow — see `requirements.txt`). The web display mode needs the **Edge WebView2 runtime** on the poster PC (preinstalled on Win10/11); if missing, the client shows the friendly error instead.

**Multi-exe layout:** `alexa-broadcast-client.exe` + `webview-host.exe` share the `dist/alexa broadcast client/` folder (one `COLLECT`); `send-test.exe` stays a separate onefile helper.

---

## Testing

```powershell
test\run_tests.bat              # client unit tests only (161 tests)
```

From repo root (bridge + client):

```powershell
..\run_all_tests.bat            # 396 bridge + 161 client
```

**Unit tests:** `test/test_payload_utils.py` (incl. Tesla fleet + `format_limit_reset_time`, `qr.display`/`photo.slideshow`/`route-planner.query` display types, `input.text` command type), `test_config.py` (incl. `photo.slideshow` bypassing `maxDisplaySeconds`), `test_weather_fetch.py`, `test_main.py` (timer routing, fired payload build, display seconds, `qr.display`/`photo.slideshow` visibility), `test_web_overlay.py` (URL pre-flight, host command build, web/system command routing, friendly error payload), `test_qr_panel.py` (`QrPanel._build_qr_image` sizing vs target, empty-content fallback — skipped if `qrcode` isn't installed), `test_photo_slideshow_panel.py` (`PhotoSlideshowPanel._fetch_photo` download/thumbnail sizing, SSL-verify-failure fallback + memoization, `_is_ssl_failure`, `show()` normalizing `{url,uploadedAt}`/bare-string photo entries, `_advance()` stopping after the last photo instead of wrapping), `test_text_marquee.py` (`MarqueeLine` — fits-statically vs. overflows-and-scrolls branch, full pause/scroll/pause/reset tick cycle, `stop()` cancels the pending tick), `test_map_fetch.py` (`map_tiles` tile/SSL helpers + `zoom_to_fit`/pixel projection), `test_place_facts.py` (`fetch_place_summary` incl. MediaWiki search fallback + disambiguation/blank-extract/SSL-fallback handling), `test_route_planner_panel.py` (`RoutePlannerPanel._compute_tile_boxes` portrait/landscape layout math incl. the leftover-space-goes-to-facts sizing, `_apply_facts` header + scroll-vs-static branching + `hide()` stopping active scrollers, `format_route_distance`/`format_route_duration`/`format_local_time_at_offset`), `test_display_remote.py` (incl. `handle_text` full-string typing, optional Enter, broken-pynput survival).

**Manual smoke:** `test/send_test.py` with client running; Windows Firewall must allow UDP on the listen port.

**Before commit/push:** run full suite from repo root (`run_all_tests.bat`).

---

## UI behavior notes

- **Portrait vs landscape:** chosen from screen dimensions in `overlay.py`
- **Queue:** rapid announcements stack; user dismiss skips to next (timer snapshots bypass queue)
- **Timers:** show immediately when set; list updates in-place when another timer arrives or one is cancelled; empty list shows "No active timers"
- **Fired timer:** focused alert with timer name, device, duration; uses full dismiss timeout unless replaced by new active timer list
- **Weather dismiss:** "Dismisses in X" shown as bottom label (always visible above content)
- **Photo slideshow:** no "Dismisses in X" countdown — stays up until every photo has shown once or a new payload interrupts it
- **Tray:** app stays resident; no main window until a message arrives

---

## Bridge integration checklist

1. Bridge running on NAS with valid `alexa-session.json` and `network_mode: host`
2. `udpBroadcast.enabled: true` + `discoveryPort: 47833` in bridge `data/config.json`
3. This client: `bridgeHosts: ["<NAS_IP>"]`, matching `discoveryPort`, friendly `displayName`
4. Control page `https://<NAS_IP>:47810/` lists this display after announce / refresh
5. `voiceEvents` + `timerSync` enabled for weather/time/timer overlays
6. **Tesla:** `.env` + `data/tesla-session.json` on NAS; virtual key paired
7. Same overlay UDP port both sides (**47832**); firewall allows inbound UDP
8. WebView2 installed for URL push; optional `targets: ["<this-pc-ip>"]` on bridge for overlays

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

- Privacy history rewrite: example LAN IP/fleet domain placeholders; portable zip untracked; household dumps/config removed from git history.
- 2026-07-26: **Scan-QR inside photo frame** — Shared Photos / photo-push corner QR no longer sits in a right gutter beside the image. It overlays the **lower-right of the hero photo** (both orientations), is a bit larger (168/188px), caption is **"Scan for photo"** (bold, soft shadow for readability on bright regions), and the font is fitted so the label width matches the QR exactly.
- 2026-07-26: **Privacy — no personal client config in git** — `config.json` is gitignored; ship `config.example.json` with placeholder bridge IP / display name / home coords. First-run `ensure_config_file` copies the example (PyInstaller packs the example, not a machine-specific config). Portable zip configs sanitized to the same placeholders.
- 2026-07-26: **Scan-QR badge stays on-canvas (portrait + landscape)** — the slideshow / shared-photo badge was anchored to raw `screen_w`/`screen_h` and clipped off-screen; both panels share `BasePanel._photo_stage_geometry` / `_draw_scan_qr_badge` so placement stays inside layout bounds (later revised to sit on the photo itself — see "Scan-QR inside photo frame" above).
- 2026-07-26: **Fix Shared Photo Slideshow stuck on "Loading photo…" + photo QR hero layout** — `PhotoSlideshowPanel._draw_chrome` was reading `layout.screen_w` / `layout.screen_h`, which don't exist on `OverlayLayout` (those live on the overlay, reachable via `OverlayShell.__getattr__`). The resulting `AttributeError` aborted `_render_current` *before* the photo-fetch thread started, so the panel stayed forever on "Loading photo…" while a leftover "Dismisses in Xs" label from the previous overlay (or a countdown that never got blanked) kept ticking. Fixed by reading `shell.screen_w`/`screen_h` (with root fallbacks), starting the fetch *before* chrome, and wrapping chrome so a QR glitch can never block the photo. Overlay now blanks the dismiss clock immediately for `photo.slideshow` (and clears it in `_stop_timers`) so the slideshow never shows a countdown — it stays up for the full single pass or until a new command arrives. `QrPanel` now treats `qrType: "photo"` (and any `/qr-images/` URL) as a hero-photo layout with a small corner QR — same composition as the slideshow — instead of a giant QR with no preview of the picture.
- 2026-07-26: **Now Playing empty state for failed "what's playing" queries** — when the bridge's `music-query` path gives up after player-info retries it now sends `music.empty: true` (song null) instead of nothing; `MusicPanel` renders a centered "Nothing playing" card (with the Echo that asked) so the display always reacts to the voice command. Also added `src.text_marquee` to the PyInstaller hiddenimports list so portable builds don't miss the Now Playing marquee module.
- 2026-07-26: **Route Planner facts overlap fix — per-tile scrolling + rebalanced tile sizing** — `RoutePlannerPanel._apply_facts` used to draw the Wikipedia extract as a plain unbounded `create_text` starting inside the tile with no height clamp, so any facts text taller than the small tile it landed in simply overflowed straight through the tile card and drew on top of the weather tile below it (visible as "63°F" and the weather label getting overlapped by trailing lines of the destination's facts). Facts tiles now draw a small header (the place name — previously discarded once facts landed) followed by a clipped nested `tk.Canvas` viewport reusing `message_scroll.MessageScrollController` (the same pause/scroll/pause controller `BroadcastPanel` uses for long messages) with `on_finish` a no-op so it loops forever instead of tying into the display's dismiss timer — short facts render once, centered, no ticking; long facts scroll continuously in place and can never bleed into another tile. New `RoutePlannerPanel.hide()`/`_clear_tile()` cleanup stops any active fact scrollers so no stray `root.after` ticks survive a panel switch. Also fixed `_compute_tile_boxes`: landscape's leftover-height formula for the time strip was accidentally subtracting `facts_h` twice (`available_h - facts_h*2 - weather_h - gap*3` for what is actually only 3 stacked rows with 2 gaps), starving the time strip and wasting space at the bottom of the column; both portrait and landscape now give weather/time compact fixed-ish shares of the available height and hand whatever's left over to the facts tiles (the ones actually needing the room), and the local-times strip's two lines are now vertically centered in their box instead of pinned near the top. Covered by new `test_route_planner_panel.py::ApplyFactsTests`.
- 2026-07-26: **Now Playing marquee for long titles + Unicode console-encoding fix** — `MusicPanel`'s song/artist/album/detail lines used to be drawn with Tk's `create_text(..., width=...)` word-wrap, which could silently blow past the fixed vertical space reserved for the stacked lines whenever a title was long (and never actually revealed a title that was still too wide for one wrapped line). New `src/text_marquee.py` (`MarqueeLine`) renders each of those lines as a single, non-wrapping line: if it fits its column it's centered and static; if it doesn't, it loops horizontally — pause at the start (readable), scroll left until the tail is visible, pause there, snap back to the start, repeat — the same cadence `message_scroll.py` already uses for the vertical broadcast-message scroll, just sideways and looping forever (no dismiss timer to sync with). Implemented as a small nested `tk.Canvas` viewport per line (same clipping trick `BroadcastPanel` already uses), tracked in `MusicPanel._marquees` and stopped in a new `hide()` override so no stray `root.after` ticks survive a panel switch. Also fixed a real (if rare) bug while testing this: `display_announce.py` logged the announce line with a `→` arrow, which raises `UnicodeEncodeError` on a Windows console defaulting to `cp1252` and silently kills the background `display-announce` thread (so the display stops re-announcing itself every 5 minutes) — the log message is now ASCII-only, and `main.py` additionally reconfigures `stdout`/`stderr` to UTF-8 with `errors="backslashreplace"` at startup as a blanket guard against the same class of bug anywhere else.
- 2026-07-26: **Slideshow Manager (client side) — single-pass playback, photo counter/date, corner QR** — the bridge no longer auto-expires shared photos after 7 days (managed instead from a new web "Slideshow" tab), so `PhotoSlideshowPanel` (`display_panels.py`) changed to match: `show()` now accepts richer `{url, uploadedAt}` photo entries (still tolerates bare URL strings) already pre-sorted by the bridge per its persisted playback-order setting, and `_advance()` stops after the last photo instead of wrapping back to the first — the slideshow is a single pass through whatever was pushed, not an infinite loop. Every frame now draws a small chrome overlay via `_draw_chrome()`: a "Photo x of y" counter, a "Shared <date>" label (reusing `format_chip_timestamp`), and a small QR code in the corner (reusing `QrPanel._build_qr_image`) linking to the current photo so a viewer can pull it up on their own phone. `overlay.py`'s `_update_countdown` now blanks the "Dismisses in X" text specifically for `photo.slideshow` (the timer itself is untouched, so auto-dismiss still fires once the single pass finishes) since a ticking countdown made no sense for a display meant to stay up until the set finishes or a new command interrupts it. `send_test.py`'s `photo-slideshow` payload and `test_photo_slideshow_panel.py` updated for the new entry shape.
- 2026-07-26: **Route Planner voice feature (client side)** — new `RoutePlannerPanel` (`display_panels.py`) renders the bridge's `route-planner.query` payload: instant header (origin → destination, distance, duration, driving/flight-estimate badge) that draws its own full-size container (shared chrome title + backdrop hidden for this type in `overlay.py`, same convention as `tesla-dashboard.query` — forgetting this caused the generic "Alexa / Route Planner" title to render on top of the panel's own header), then 5 tiles start as per-tile arc spinners and fill in independently off-thread as each finishes: map (new shared `map_tiles.py`, extracted from `TeslaDashboardPanel`'s previously-private tile fetch/stitch/SSL-fallback code — adds `zoom_to_fit` for two-point framing and `project_points_to_pixels` to draw the route line/dashed great-circle + start/end pins), 2× Wikipedia place-facts (new `place_facts.py`; falls back to MediaWiki search when the geocoded "City, ST, US" name doesn't match a real Wikipedia title verbatim), 2× current weather (reuses `weather_fetch.fetch_weather_forecast`, now also returning `utcOffsetSeconds`). A "Local Times" strip (now at origin, now at destination, est. arrival) renders once both weather tiles land, via new `format_route_distance`/`format_route_duration`/`format_local_time_at_offset` helpers in `payload_utils.py`. Each async fetch is fenced by a monotonic request id (same pattern as `MusicPanel`'s album-art fetch) so a stale result can't render after the panel moves on. Registered in `overlay.py`/`payload_utils.py`/`main.py`; smoke via `send_test.py --type route-planner` / `route-planner-flight`.
- 2026-07-25: **Bigger, better-laid-out album art** — `MusicPanel`'s art was capped at a flat `ART_SIZE = 510` px regardless of screen size, leaving 600-800+ px of unused space on most portrait screens and roughly half the screen unused in landscape (single centered column both orientations). Portrait now sizes the art from actual available width/height (soft cap raised to 900) instead of the old fixed cap, so it fills the screen; landscape (`_render_landscape`) is now a genuine two-column layout — art on the left sized from the full message-area height, track info vertically centered in the remaining column on the right — instead of the same cramped centered-stack used for portrait.
- 2026-07-25: **Full-string text input + Shared Photo Slideshow** — `input_control.py` gained `handle_text()` for the new `input.text` UDP command: types an entire string in one `pynput` `Controller.type()` call (Unicode-safe) instead of one keystroke per key event, with an optional trailing Enter — makes pushing logins/passwords/URLs from the phone's own keyboard far faster than the on-screen remote keyboard. New `PhotoSlideshowPanel` (`display_panels.py`) handles the `photo.slideshow` UDP payload: cycles every photo in `slideshow.photos[]` (the bridge's last-7-days shared-photo cache) at `slideshow.secondsPerPhoto` (5s default) each, fetching each photo off the Tk main thread (SSL-verify failures against the bridge's self-signed cert fall back to an unverified context and that fallback is remembered for the session) and centering it to fit both portrait and landscape. `config.py::effective_display_seconds` now lets `photo.slideshow` bypass `maxDisplaySeconds` so a long slideshow isn't cut short — like the existing timer exception, the whole point of `displaySeconds` here is "however long it takes to show everything." Like every other overlay, any new incoming UDP payload immediately replaces/interrupts the slideshow. Registered in `overlay.py` + `DISPLAY_TYPES`/`COMMAND_TYPES` (`main.py`, `payload_utils.py`).
- 2026-07-25: **QR code overlay** — new `QrPanel` (`display_panels.py`) renders a locally-generated QR code (via new `qrcode` dependency) for the bridge's `qr.display` payload; bridge sends only a content string (`qr.{qrType,content,label}` — a URL or a `WIFI:T:...;;` string), never a bitmap. Registered in `overlay.py` + `DISPLAY_TYPES` (`main.py`, `payload_utils.py`); PyInstaller spec bundles `qrcode`'s hidden imports (lazy PIL image factory).
- 2026-07-25: **Timer panel spacing** — the active-timer row showed the set duration ("5:00") right above the live countdown with almost no gap, plus a cramped "left" caption below it — the subtitle line already reads "{device} · {duration} timer" so the duplicate top label was dropped, and the countdown + "left"/"Finished!" caption are now centered as one block sized from real font metrics (`countdown_gap`) so they never touch regardless of portrait/landscape font sizing (`display_panels.py::TimerPanel._render`).
- 2026-07-25: **Fix broadcast message covering FROM/TO/TIME chips** — `overlay.py`'s shared `message_area_top` starts right under the title for panels without chips, but `BroadcastPanel` still draws the chip row and was placing its scrolling message viewport at that same y, drawing over the chips in both orientations. `BroadcastPanel` now computes its own content top (`chip_y + chip_height + gap`) and viewport height from those same layout fields, so the message area always starts below the chips. Smoke: `test/send_test.py --type broadcast` (check portrait and landscape).
- 2026-07-23: **Tesla battery landscape layout** — landscape uses a car | status two-column layout; portrait still stacks but reserves height for cache/rate-limit blocks so "Tesla" / "Tesla Battery" are never clipped.
- 2026-07-23: **Portable build quiet on Windows** — PyInstaller spec freezes only Windows `webview`/`pynput` backends (no android ModuleNotFoundError), overrides stale `pycparser.lextab` hooks, and `build_portable.bat` exits immediately on success (`--pause` to keep the window open).
- 2026-07-23: **Fix overlay stacking / bleed** — removed process-wide `SetProcessDpiAwareness` (it inflated Tk font pixels while cards used fixed offsets, stacking Tesla dashboard sections). All display overlays force full opacity so movie posters no longer show through; shell message area no longer reserves unused chip rows; battery card + media strip lay out from font metrics; portrait dashboard packs media under the stat grid with section floors.
- 2026-07-23: **Hide OS cursor during remote control** — while the software pointer is active, system cursors are replaced with a blank cursor (`SetSystemCursor`); a `WH_MOUSE_LL` hook restores them on the first physical (non-injected) mouse move, and idle timeout restores them too. Software arrow shrunk to 18px.
- 2026-07-23: **Remote cursor click-through** — overlay was eating clicks/scrolls (Tk canvas child kept hit-testing; `SetWindowLong` also cleared the chroma-key → opaque black block). Now hardens `WS_EX_TRANSPARENT` on toplevel+children, restores `SetLayeredWindowAttributes` color key, and ducks the overlay for the instant of each click/wheel.
- 2026-07-23: **Software remote cursor + aimed clicks** — `remote_cursor.py` paints a click-through topmost arrow at the tracked remote tip (RDP/kiosk often freeze the system pointer while hover still tracks). Moves/clicks/wheel inject absolute `SendInput` batches aimed at that tip so clicks land where the overlay is, not at the frozen system arrow.
- 2026-07-23: **Absolute cursor moves** — pointer moves are injected as `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` SendInput events (delta applied to `GetCursorPos`, normalized to the virtual desktop). Relative injected moves are discarded under RDP, and `SetCursorPos` only moves the logical position (hover tracks but the drawn arrow freezes over RDP); absolute injection moves both. `SetCursorPos` kept as last-resort fallback (`input_control.py`).
- 2026-07-23: **Remote mouse hardening** — clicks/wheel now injected via Win32 `SendInput` like moves (`input_control.py`), so mouse control no longer depends on `pynput` loading; `_poll_messages` (`main.py`) wraps payload handling so a failing command can't kill the UDP loop (this previously made all input silently stop); PyInstaller spec bundles all `pynput` submodules (`collect_submodules`) — the dynamic `_win32` backends were missing from the freeze; `SendInput` rejections log a hint that an elevated foreground app requires running the client as admin.
- 2026-07-22: **Signal Bridge branding** — docs/UI refer to Signal Bridge / Signal phone UI (logo on bridge README + web header).
- 2026-07-22: **PIN Authenticated flash** — `display.auth` with `auth.status: ok` replaces the PIN with green “Authenticated” (~1s) then dismisses; overlay chrome title follows.
- 2026-07-21: **Stable display id + PIN overlay** — `display.id` is per-machine (name can duplicate); announce includes `shortId`; new `display.auth` panel shows unlock PIN from the control page.
- 2026-07-21: **Docs — client README + requirements** — user guide covers announce/`bridgeHosts`, control page targeting, WebView2 browser, remote input; `requirements.txt` annotated.
- 2026-07-21: **Mouse move via SendInput** — relative Win32 `SendInput` instead of pynput `SetCursorPos` so touchpad deltas work (including while an RDP session is watching the poster PC).
- 2026-07-21: **Announce unicast to NAS** — `bridgeHosts` + `discoveryPort` (default example `192.168.1.10:47833`) so announces reach the bridge when `255.255.255.255` is dropped; learn bridge IP from `display.discover` sender.
- 2026-07-21: **Display discovery + remote input** — `displayName` / stable id, announce heartbeat, target filter on UDP commands, `pynput` mouse/keyboard injection, WebView2 persistent profile (`private_mode=False`) for password save. Smoke: `display-discover`, `input-click`, `input-key`.
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
