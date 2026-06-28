# Alexa Broadcast Client (Windows)

Lightweight system-tray app for Windows that listens for UDP broadcast messages from the Alexa bridge container and shows a fullscreen overlay on your display.

## Features

- Runs minimized in the system tray (near the clock)
- Listens on all interfaces (`0.0.0.0:47832` by default)
- Fullscreen tinted overlay with fade in/out
- Adapts layout for portrait or landscape based on screen resolution
- Shows sender, destination, timestamp, and message
- Caps display duration at `maxDisplaySeconds` from config

## Portable build (no Python on target PC)

Use this for your movie poster / display PC where Python and pip are not installed.

**On your dev PC** (where Python is installed), run once:

```powershell
cd "alexa broadcast client"
.\build_portable.bat
```

The build uses a local virtual environment at `%LOCALAPPDATA%\alexa-broadcast-client-build-venv` (not the NAS `.venv`) so pip and PyInstaller stay reliable when the project lives on a network share.

This creates a self-contained folder:

```
dist\alexa-broadcast-client\
  Run Alexa Broadcast Client.bat   ← double-click this on the poster PC
  alexa-broadcast-client.exe
  config.json                      ← edit settings here
  _internal\                       ← bundled runtime (leave intact)
  test\
    send-test.exe
    run_test.bat
```

**Copy the entire `alexa-broadcast-client` folder** to the poster PC (USB, network share, etc.). No Python, pip, or venv required.

1. Double-click `Run Alexa Broadcast Client.bat`
2. Allow through Windows Firewall when prompted (private network)
3. Look for the tray icon near the clock
4. Test with `test\run_test.bat`

For auto-start on the poster PC, put a shortcut to `Run Alexa Broadcast Client.bat` in `shell:startup`.

## Setup (development)

1. Install [Python 3.10+](https://www.python.org/downloads/)
2. Double-click `run.bat` or:

```powershell
cd "alexa broadcast client"
py -3 -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python src\main.py
```

3. Allow through Windows Firewall when prompted (private network)

## Configuration (`config.json`)

| Setting | Default | Description |
|---------|---------|-------------|
| `listenPort` | 47832 | UDP port (must match bridge) |
| `maxDisplaySeconds` | 30 | Maximum overlay duration |
| `defaultDisplaySeconds` | 30 | Used if message omits duration |
| `fadeInMs` / `fadeOutMs` | 400 / 600 | Fade animation timing |

If a broadcast requests 60 seconds but `maxDisplaySeconds` is 30, the overlay shows for 30 seconds.

## Test locally

**Unit tests** (no client running):

```powershell
cd test
.\run_tests.bat
```

**UDP smoke test** (client must be running):

```powershell
cd test
.\run_test.bat
```

Or with custom text:

```powershell
.\run_test.bat --message "Dinner is ready" --sender "Kitchen Echo" --destination "All devices" --seconds 15
```

## Auto-start with Windows

Create a shortcut to `run.bat` in:

```
shell:startup
```

Or use Task Scheduler to run `run.bat` at logon (hidden if desired).

## Bridge integration

The NAS/container bridge sends JSON over UDP when it intercepts an Alexa announcement. Add your Windows PC IP to `data/config.json` on the NAS if LAN broadcast from Docker is unreliable:

```json
"udpBroadcast": {
  "enabled": true,
  "port": 47832,
  "defaultDisplaySeconds": 30,
  "targets": ["192.168.1.100"]
}
```

The bridge uses `network_mode: host` on the NAS so UDP broadcast reaches your LAN.
