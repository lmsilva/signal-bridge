# Alexa Broadcast Client — project map

> **For AI agents:** Read this file first when working on the Windows display client.  
> **Keep fresh:** Update this file whenever you change modules, config, UDP handling, overlay UI, or packaging. Bump **Last updated** and add a line under **Recent changes**.

**Last updated:** 2026-06-28

---

## Recent changes

- **2026-06-28:** `OverlayShell` exposes font refs from `OverlayWindow` so display panels can access `message_font` etc. at init (fixes startup crash).

## What this is

A **Windows system-tray app** (Python + Tkinter) that listens for **UDP JSON** messages from the [NAS bridge](../../src/PROJECT.md) and shows a **fullscreen overlay** with the announcement text (e.g. on a movie-poster display PC).

Pair project: **alexa-broadcast-bridge** (Node, Docker on QNAP).

---

## System context

```
Alexa "announce …"  →  Bridge (NAS)  →  UDP JSON :47832  →  This client  →  Fullscreen overlay
```

The client does **not** talk to Amazon. It only receives UDP and renders UI.

---

## Repository layout (client)

| Path | Role |
|------|------|
| `src/main.py` | Entry: UDP listener + tray + Tk main loop + message queue |
| `src/listener.py` | `UdpListener` — background thread, JSON decode, `on_message` callback |
| `src/overlay.py` | Fullscreen shell: fade, countdown, routes payloads to display panels |
| `src/display_panels.py` | Broadcast, time, weather, and timer overlay renderers |
| `src/payload_utils.py` | UDP payload type detection and formatting helpers |
| `src/message_scroll.py` | Long broadcast message scroll animation |
| `src/tray_app.py` | pystray icon; exit triggers shutdown |
| `src/config.py` | Load `config.json` next to exe / project root |
| `src/paths.py` | Resolve config path for dev vs portable build |
| `config.json` | User settings (port, fade, display caps, colors) |
| `run.bat` | Dev: venv + `python src/main.py` |
| `build_portable.bat` | PyInstaller → `dist/alexa-broadcast-client/` |
| `alexa-broadcast-client.spec` | PyInstaller spec |
| `test/send_test.py` | Send sample UDP packet |
| `README.md` | User-facing setup / portable build guide |

---

## Runtime flow

1. `BroadcastClientApp.start()` binds UDP (`0.0.0.0:47832` by default)
2. `run_tray()` — background tray icon
3. Hidden `tk.Tk` root; `OverlayWindow` created but not shown until message
4. `_poll_messages()` every 100ms — drains queue from UDP thread
5. `_enqueue_display()` — one overlay at a time; queue additional messages
6. `overlay.show(payload, seconds)` — routes by `type` to the correct panel; fade in/out unchanged
7. Click dismisses current overlay or advances queue

---

## Expected UDP payloads (v2)

All payloads include `version: 2` and `type`. Legacy broadcasts with only `message` still work.

| `type` | Overlay |
|--------|---------|
| `broadcast` | FROM / TO / TIME chips + scrolling message (unchanged UX) |
| `time.query` | Analog clock + digital time + full date |
| `weather.query` | Current conditions, 24h strip, 7-day cards |
| `timer.snapshot` | All active timers with device, remaining, duration |

`listener.py` accepts any recognized display payload via `is_display_payload()`.

Example time payload:

```json
{
  "version": 2,
  "type": "time.query",
  "device": "Kitchen Echo",
  "parsedTime": { "timeLabel": "3:45 PM", "dateLabel": "Friday, June 27, 2026" },
  "displaySeconds": 120
}
```

Test locally:

```bash
python test/send_test.py --type broadcast
python test/send_test.py --type time --seconds 30
python test/send_test.py --type weather --seconds 45
python test/send_test.py --type timers --seconds 45
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

Bridge `data/config.json` should list this PC in `udpBroadcast.targets` if LAN broadcast is flaky.

---

## Packaging

- **Dev:** `run.bat` → venv, `pip install -r requirements.txt`, `python src/main.py`
- **Portable:** `build_portable.bat` → copy `dist/alexa-broadcast-client/` to display PC; run `Run Alexa Broadcast Client.bat`
- **Auto-start:** shortcut in `shell:startup` on Windows

**Requirements:** Python 3.10+, `pystray`, `Pillow` (see `requirements.txt`).

---

## Testing

```powershell
cd test
.\run_test.bat
.\run_test.bat --message "Dinner is ready" --seconds 15
```

Client must be running; Windows Firewall must allow UDP on the listen port (private network).

---

## UI behavior notes

- **Portrait vs landscape:** chosen from screen dimensions in `overlay.py`
- **Queue:** rapid announcements stack; user dismiss skips to next
- **Tray:** app stays resident; no main window until a message arrives

---

## Bridge integration checklist

1. Bridge running on NAS with valid `alexa-session.json`
2. `udpBroadcast.enabled: true` in bridge `data/config.json`
3. Same UDP port both sides
4. Windows firewall allows inbound UDP
5. Optional: `targets: ["<this-pc-ip>"]` on bridge

---

## Recent changes

- 2026-06-27: UDP v2 display modes — time clock, weather dashboard, timer list; typed payload routing in overlay.
- 2026-06-24: Added this PROJECT.md documenting architecture, UDP contract, and bridge pairing.
