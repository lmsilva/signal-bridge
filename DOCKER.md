# Docker deployment (QNAP Container Station)

## Overview

| Mode | Command | When |
|------|---------|------|
| **Listener** (always on) | `docker compose up -d` | Captures broadcasts |
| **Auth** (one-time / rare) | `docker compose -f docker-compose.auth.yml up` | Creates `data/alexa-session.json` |

The listener container needs the saved session file. With **`network_mode: host`** it also serves the **Signal** control UI on the NAS LAN:

| Service | Address |
|---------|---------|
| Signal UI (HTTPS) | `https://<NAS_IP>:47810/` |
| Optional HTTP→HTTPS | `http://<NAS_IP>:47811/` |
| Overlay / commands UDP | `:47832` (outbound to displays) |
| Display announce UDP | `:47833` (inbound from displays) |

No `ports:` mapping is required — host networking shares the NAS stack. See the [main README](README.md) for display discovery and the phone UI.

---

## Recommended: authenticate on your PC, run listener on QNAP

You already logged in on Windows. Copy these files to the NAS project folder:

```
data/alexa-session.json
data/formerDataStore.json
config.json
```

Create an empty events log file (avoids Docker creating a folder by mistake):

```bash
touch data/voice-events.jsonl
```

---

## 1. Put the project on your QNAP

SSH into the NAS or use File Station:

```bash
mkdir -p /share/Container/alexa-broadcast-bridge
cd /share/Container/alexa-broadcast-bridge
```

Copy the whole project there (or `git clone`), including:

- `Dockerfile`
- `docker-compose.yml`
- `package.json` / `package-lock.json`
- `src/`
- `data/` containing:
  - `alexa-session.json`
  - `formerDataStore.json`
  - `config.json`
  - `voice-events.jsonl` (empty file, optional — created automatically on first capture)

---

## 2. Build and start (SSH)

```bash
cd /share/Container/alexa-broadcast-bridge
docker compose build
docker compose up -d
```

Check logs:

```bash
docker compose logs -f
```

Attach to the live process (see output in your terminal):

```bash
docker attach alexa-broadcast-bridge
```

Detach without stopping the container: **Ctrl+P**, then **Ctrl+Q**  
(Do not use Ctrl+C — that stops the Node process.)

You should see:

```
Alexa bridge ready
Connected to Alexa push channel
Listening for broadcast/announcement activity
```

Captured events append to `data/voice-events.jsonl` on the host (JSON lines: broadcasts, voice queries, timers).

---

## 3. QNAP Container Station (GUI)

1. Open **Container Station** → **Create** → **Create application**
2. Choose **Import** → **Upload** `docker-compose.yml` (or create from the UI using the same settings)
3. Set **project path** to the folder on the NAS (e.g. `/share/Container/alexa-broadcast-bridge`)
4. Under **Volumes**, map only:
   - Host `./data` → Container `/app/data`
5. **Restart policy**: Unless stopped
6. **Network:** use host networking (as in `docker-compose.yml`) so UDP discovery and the control page work on the LAN — do not rely on published port maps for UDP
7. Deploy / Start

View logs in Container Station → your container → **Logs**.

---

## 4. Auth on the NAS (only if needed)

Use this if the session expired or refresh fails.

**Your NAS IP:** `192.168.1.10` (use this as `PROXY_OWN_IP`)

1. Stop the listener and free port 3456:

```bash
cd /share/Container/alexa-broadcast-bridge
docker compose stop alexa-broadcast-bridge
docker rm -f alexa-broadcast-auth
```

2. Make sure `docker-compose.auth.yml` uses **`network_mode: host`** and has **no `ports:` section**.  
   (Old compose files map `3456:3456` and fail with "address already in use" on QNAP.)

3. Run auth (easiest):

```bash
PROXY_OWN_IP=192.168.1.10 ./reauth.sh
```

Or manually:

```bash
PROXY_OWN_IP=192.168.1.10 docker compose -p alexa-auth -f docker-compose.auth.yml up
```

4. Browser: **http://192.168.1.10:3456/** → Amazon login → wait for **Authentication complete** → **Ctrl+C**

5. Start listener:

```bash
docker compose up -d --force-recreate
docker compose logs -f
```

If port 3456 is still busy, use another port:

```bash
PROXY_PORT=3457 PROXY_OWN_IP=192.168.1.10 ./reauth.sh
# then open http://192.168.1.10:3457/
```

---

## 5. Updates

The NAS has no git. The shared folder **is** the working copy — code edited on the
PC is already on the NAS. **`./src` is bind-mounted** into the container, so JavaScript
changes apply on restart **without** rebuilding the image:

```bash
cd /share/Container/alexa-broadcast-bridge
./recreate.sh
```

Only use `./recreate.sh --build` when you changed `Dockerfile` or `package.json`
(and only if Container Station build works). If build fails with a ZFS/graph error,
`recreate.sh` falls back to restart with the existing image — your `src/` changes
still load.

Session and `data/voice-events.jsonl` are on mounted volumes and are preserved.

---

## 6. UDP + displays + control page

When an Alexa announcement is captured, the bridge sends JSON over UDP to the **Alexa Broadcast Client** on your Windows PC(s).

Add to `data/config.json` (defaults are in `config.example.json`):

```json
"udpBroadcast": {
  "enabled": true,
  "port": 47832,
  "discoveryPort": 47833,
  "defaultDisplaySeconds": 120,
  "targets": ["192.168.1.100"]
},
"webServer": {
  "enabled": true,
  "port": 47810,
  "https": true,
  "httpRedirectPort": 47811,
  "certHosts": ["192.168.1.10"]
}
```

- `targets`: optional Windows PC LAN IP(s) if overlay broadcast is unreliable
- `discoveryPort`: bridge listens here for `display.announce` from clients (not the same as overlay port)
- On each display PC set `bridgeHosts: ["<NAS_IP>"]` and `discoveryPort: 47833` so announces reach the NAS
- `certHosts`: include the NAS LAN IP so phones can accept the self-signed cert for QR camera
- `docker-compose.yml` uses `network_mode: host` — required for LAN UDP and the control page

See `alexa broadcast client/README.md` and the [main README](README.md) (Control web page / Display discovery).

---

## 7. Troubleshooting

| Problem | Fix |
|---------|-----|
| `No session found` | Copy `data/alexa-session.json` or run auth compose file |
| `EISDIR` / `config.json is a directory` | Docker created a folder because the file was missing. See fix below |
| `voice-events.jsonl` is a folder | Remove it, `touch data/voice-events.jsonl`, recreate container |

### Fix `EISDIR: illegal operation on a directory`

This happens when Docker mounts `./config.json` but that **file did not exist** on the NAS. Docker creates an empty **directory** instead.

```bash
cd /share/Container/alexa-broadcast-bridge
docker compose down
rm -rf config.json
mkdir -p data
cp /path/to/your/config.json data/config.json   # or create manually
touch data/voice-events.jsonl
docker compose up -d
docker compose logs -f
```

| Listener exits / auth errors | Run `./reauth.sh` or auth compose; copy fresh session from PC |
| Tesla battery shows error / no data | `./tesla-status.sh`; re-run `tesla-auth-pc.bat` on PC; pair virtual key `https://www.tesla.com/_ak/DOMAIN` |
| `tesla-register` "Other update in progress" | Wait 5–15 min; `./tesla-verify-register.sh` |
| `bind: address already in use` on port 3456 | Stop listener + `docker rm -f alexa-broadcast-auth`; use updated `docker-compose.auth.yml` with `network_mode: host` (no `ports:`) |
| `failed to read dockerfile` / `error creating zfs mount` on build | QNAP Container Station Docker graph bug — **ignore for code updates**. Run `./recreate.sh` (no `--build`); `src/` is bind-mounted. To fix builds: restart Container Station in QNAP, or `docker system prune`, or build image on a PC and `docker load` |
| No broadcasts captured | Check logs; test announce on Echo; confirm push connected |
| Re-auth on QNAP | Stop listener, run `docker-compose.auth.yml`, then `docker compose up -d` |
| Windows client not receiving overlays | Add PC IP to `udpBroadcast.targets`; check Windows firewall on port **47832** |
| Control page shows no displays | Client needs `bridgeHosts: ["<NAS_IP>"]` + restart; bridge must listen on **47833** (check logs for “UDP display discovery listening”); tap refresh on the control page |
| Control page / QR camera blocked | Use **https://** `:47810`, accept cert once; put NAS IP in `webServer.certHosts`, delete `data/web-certs/` and recreate if SAN was wrong |
| Pushed URL does nothing | Client needs WebView2; check client logs; try `send_test.py --type web-open` |

---

## Environment variables (optional)

Set in Container Station or a `.env` file next to `docker-compose.yml`:

```env
TZ=America/New_York
AMAZON_PAGE=amazon.com
ACCEPT_LANGUAGE=en-US
DEBUG=0
```

For auth only:

```env
PROXY_OWN_IP=192.168.1.50
PROXY_PORT=3456
```

For Tesla Fleet API (listener + register scripts):

```env
TESLA_CLIENT_ID=...
TESLA_CLIENT_SECRET=...
TESLA_FLEET_DOMAIN=fleetapi.example.com
TESLA_FLEET_REGION=na
TESLA_VIN=...                 # optional
```

`docker-compose.yml` loads `.env` via `env_file`. After editing `.env`:

```bash
docker compose up -d --force-recreate
```

### Tesla setup on NAS

| Script | Purpose |
|--------|---------|
| `./tesla-register.sh` | Register partner domain (once) |
| `./tesla-verify-register.sh` | Confirm registration + public key |
| `./tesla-status.sh` | Check `data/tesla-session.json` |
| `./recreate.sh` | Restart listener after `.env` / code changes |

**OAuth:** run on your **Windows PC** — `tesla-auth-pc.bat` or `npm run tesla-auth` (Tesla only allows `http://localhost` for HTTP redirects). Session saves to `data/tesla-session.json` on the NAS share.

`./tesla-auth.sh` on NAS is for SSH-tunnel advanced use only; see script output.
