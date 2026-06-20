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

Create an empty log file (avoids Docker creating a folder by mistake):

```bash
touch broadcast.txt
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
  - `broadcast.txt` (empty file)

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

Broadcasts append to `broadcast.txt` on the host (same folder as compose file).

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

Use this if you did **not** copy a session from your PC, or refresh fails.

1. Find your QNAP LAN IP (e.g. `192.168.1.50`)
2. SSH to the NAS:

```bash
cd /share/Container/alexa-broadcast-bridge
PROXY_OWN_IP=192.168.1.50 docker compose -f docker-compose.auth.yml up
```

3. On your PC/phone browser, open: `http://192.168.1.50:3456/`
4. Log in to Amazon; wait for **Authentication complete**
5. Stop the auth container (Ctrl+C)
6. Start the listener: `docker compose up -d`

**Important:** `PROXY_OWN_IP` must be the IP you use in the browser, not `127.0.0.1`, when logging in from another device.

---

## 5. Updates

```bash
cd /share/Container/alexa-broadcast-bridge
git pull   # if using git
docker compose build
docker compose up -d
```

Session and `broadcast.txt` are on mounted volumes and are preserved.

---

## 7. UDP broadcast to Windows display client

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

## 8. Troubleshooting

| Problem | Fix |
|---------|-----|
| `No session found` | Copy `data/alexa-session.json` or run auth compose file |
| `EISDIR` / `config.json is a directory` | Docker created a folder because the file was missing. See fix below |
| `broadcast.txt` is a folder | Remove it, `touch data/broadcast.txt`, recreate container |

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
| Listener exits / auth errors | Run auth again; copy fresh session from PC |
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
