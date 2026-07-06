# Docker deployment (QNAP Container Station)

## Overview

| Mode | Command | When |
|------|---------|------|
| **Listener** (always on) | `docker compose up -d` | Captures broadcasts |
| **Auth** (one-time / rare) | `docker compose -f docker-compose.auth.yml up` | Creates `data/alexa-session.json` |

The listener container only needs the saved session file. It does **not** expose any web UI.

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
6. No ports required for the listener
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

## 6. UDP broadcast to Windows display client

When an Alexa announcement is captured, the bridge also sends a JSON packet over UDP to the **Alexa Broadcast Client** on your Windows PC.

Add to `data/config.json`:

```json
"udpBroadcast": {
  "enabled": true,
  "port": 47832,
  "defaultDisplaySeconds": 30,
  "targets": ["192.168.1.100"]
}
```

- `targets`: your Windows PC LAN IP (recommended for Docker reliability)
- `docker-compose.yml` uses `network_mode: host` so LAN UDP broadcast works on the NAS

See `alexa broadcast client/README.md` for the Windows side.

---

## 7. Troubleshooting

| Problem | Fix |
|---------|-----|
| `No session found` | Copy `data/alexa-session.json` or run auth compose file |
| `EISDIR` / `config.json is a directory` | Docker created a folder because the file was missing. See fix below |
| `voice-events.jsonl` is a folder | Remove it, `touch data/voice-events.jsonl`, recreate container |

### Fix `EISDIR: illegal operation on a directory`

This happens when Docker mounts `./config.json` or `./broadcast.txt` but those **files did not exist** on the NAS. Docker creates empty **directories** instead.

```bash
cd /share/Container/alexa-broadcast-bridge
docker compose down
rm -rf config.json broadcast.txt
mkdir -p data
cp /path/to/your/config.json data/config.json   # or create manually
touch data/broadcast.txt
docker compose up -d
docker compose logs -f
```
| Listener exits / auth errors | Run `./reauth.sh` or auth compose; copy fresh session from PC |
| `bind: address already in use` on port 3456 | Stop listener + `docker rm -f alexa-broadcast-auth`; use updated `docker-compose.auth.yml` with `network_mode: host` (no `ports:`) |
| `failed to read dockerfile` / `error creating zfs mount` on build | QNAP Container Station Docker graph bug — **ignore for code updates**. Run `./recreate.sh` (no `--build`); `src/` is bind-mounted. To fix builds: restart Container Station in QNAP, or `docker system prune`, or build image on a PC and `docker load` |
| No broadcasts captured | Check logs; test announce on Echo; confirm push connected |
| Re-auth on QNAP | Stop listener, run `docker-compose.auth.yml`, then `docker compose up -d` |
| Windows client not receiving | Add PC IP to `udpBroadcast.targets`; check Windows firewall on port 47832 |

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
