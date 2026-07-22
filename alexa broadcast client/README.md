# Alexa Broadcast Client (Windows)

System-tray app for Windows that listens for UDP JSON from [**Signal Bridge**](../README.md) and shows fullscreen overlays on your display PC (movie poster, kitchen screen, etc.). It can also open a pushed URL in a fullscreen browser and accept remote mouse/keyboard from the **Signal** phone UI.

The client does **not** talk to Amazon. The NAS bridge does that; this app only receives UDP and renders UI / runs commands.

---

## Features

- Runs minimized in the system tray
- Listens on `0.0.0.0:47832` for overlays and commands
- **Advertises to the bridge** (`display.announce` → NAS `:47833`) so the Signal UI can list and target this PC
- Fullscreen tinted overlays with fade in/out (portrait or landscape)
- Voice-driven panels: broadcasts, time, weather, indoor temp, air quality, timers, alarms, shopping list, music, smart home, Tesla, Vivint, notifications
- **Web browser mode:** `web.open` → frameless Edge WebView2 fullscreen until `web.close`
- **Remote control:** `input.pointer` / `input.key` from the bridge Control tab (touchpad + keyboard)
- Caps overlay duration with `maxDisplaySeconds` (timers use full payload duration)

---

## How it fits together

```
Phone control page  →  Bridge (NAS)  →  UDP :47832  →  This client
                              ↑                            │
                              └──── display.announce ──────┘
                                    (UDP :47833)
```

1. On start (and every 5 minutes), the client unicasts `display.announce` to `bridgeHosts` on `discoveryPort` (default **47833**).
2. Bridge overlays and control commands arrive on `listenPort` (default **47832**).
3. Targeted payloads include `target.id`; this client ignores commands meant for another display.
4. `web.open` spawns `webview-host` (WebView2); `system.command` can reboot/power off.

---

## Portable build (no Python on target PC)

**On your dev PC** (Python 3.10+ installed):

```powershell
cd "alexa broadcast client"
.\build_portable.bat
```

The build uses `%LOCALAPPDATA%\alexa-broadcast-client-build-venv` (not a NAS `.venv`) so pip/PyInstaller stay reliable on network shares.

Output:

```
dist\alexa broadcast client\
  Run Alexa Broadcast Client.bat   ← double-click on the poster PC
  alexa-broadcast-client.exe
  webview-host.exe                 ← browser overlay helper
  config.json                      ← edit settings here
  _internal\
```

Or use the zip: `dist\alexa broadcast client.zip`.

1. Extract / copy to the poster PC  
2. Edit `config.json` — set `displayName` and `bridgeHosts` to your NAS IP  
3. Double-click `Run Alexa Broadcast Client.bat`  
4. Allow Windows Firewall (private network) for UDP  
5. On your phone open `https://<NAS_IP>:47810/` and confirm this display appears  

Auto-start: shortcut to `Run Alexa Broadcast Client.bat` in `shell:startup`.

---

## Setup (development)

1. Install [Python 3.10+](https://www.python.org/downloads/) and the [Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (usually already on Win10/11)
2. Double-click `run.bat` or:

```powershell
cd "alexa broadcast client"
py -3 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python src\main.py
```

3. Allow through Windows Firewall when prompted (private network)

### Python requirements (`requirements.txt`)

| Package | Used for |
|---------|----------|
| `pystray` | System tray icon |
| `Pillow` | Tray / image helpers |
| `pywebview` | Edge WebView2 host for pushed URLs |
| `pynput` | Remote keyboard + mouse clicks (moves use Win32 `SendInput`) |

Build extras: `requirements-build.txt` (adds PyInstaller).

---

## Configuration (`config.json`)

| Setting | Default | Description |
|---------|---------|-------------|
| `listenPort` | 47832 | UDP listen port (must match bridge `udpBroadcast.port`) |
| `listenAddress` | `0.0.0.0` | Bind address |
| `displayName` | hostname | Friendly name in the bridge control page |
| `bridgeHosts` | `["192.168.1.10"]` | NAS IP(s) for `display.announce` unicasts |
| `discoveryPort` | 47833 | Bridge discovery listen port |
| `maxDisplaySeconds` | 30 | Hard cap on most overlay durations |
| `defaultDisplaySeconds` | 30 | Used if payload omits duration |
| `fadeInMs` / `fadeOutMs` | 400 / 600 | Fade animation |
| `webOverlayOpacity` | 0.88 | WebView2 window opacity |

Example for a poster PC talking to NAS `192.168.1.10`:

```json
{
  "listenPort": 47832,
  "displayName": "Poster Display",
  "bridgeHosts": ["192.168.1.10"],
  "discoveryPort": 47833,
  "maxDisplaySeconds": 120,
  "defaultDisplaySeconds": 60
}
```

---

## Test locally

**Unit tests** (no client running):

```powershell
cd test
.\run_tests.bat
```

**UDP smoke tests** (client must be running):

```powershell
python send_test.py --type broadcast
python send_test.py --type web-open --url https://example.com
python send_test.py --type web-close
python send_test.py --type display-discover
python send_test.py --type tesla-battery --percent 78 --seconds 30
```

Or `.\run_test.bat` for a simple broadcast.

---

## Bridge integration

1. Bridge running on the NAS with `network_mode: host` and a valid Alexa session  
2. `udpBroadcast.enabled: true` (and usually `discoveryPort: 47833`)  
3. This PC’s `bridgeHosts` includes the NAS IP  
4. Windows Firewall allows inbound UDP **47832**  
5. Optional: add this PC to bridge `udpBroadcast.targets` if overlay broadcast is flaky  
6. Open the control page → refresh displays → select this PC  

See the [main README](../README.md) for the control page, discovery ports, and Tesla setup. Architecture notes: [src/PROJECT.md](src/PROJECT.md).
