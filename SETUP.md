# Signal Bridge — setup guide

This is the step-by-step install for a new machine. It covers a laptop for development, a NAS Docker deploy, the Windows display client, and every environment variable the bridge actually reads.

Feature descriptions, the skills catalog, and day-to-day use live in [README.md](README.md). Container Station, QNAP quirks, and Let's Encrypt live in [DOCKER.md](DOCKER.md). Architecture for agents lives in [`src/PROJECT.md`](src/PROJECT.md).

**Do not commit `.env`, session files, or `data/secret.key`.** `.env` is gitignored. Copy [`.env.example`](.env.example) and fill in *your* values. Examples below use placeholders (`your-nas.example`, `192.168.1.10`) — never paste a real password, token, VIN, or mailbox into this file.

---

## What you are installing

| Piece | Role |
|-------|------|
| **Bridge** (this repo) | Node service. Talks to Alexa and other household APIs, serves the Signal web UI, sends UDP overlays, drives Vestaboards. |
| **Windows display client** | Optional. Fullscreen overlays on a poster / kitchen / theater PC. Receives UDP; does not talk to Amazon. |
| **Vestaboard** | Optional. Split-flap boards over the Local API. A built-in **simulator** on port 7000 stands in if you have no hardware. |

Typical household: bridge in Docker on a NAS (`network_mode: host`), one Windows poster PC, zero or more real Vestaboards.

```
Echo / Alexa  뿯↽  Amazon  뿯↽  Bridge (NAS)
                               │
          ┌────────────────────┼─────────────────┬──────────────────┐
          뿯▽                    뿯▽                 뿯▽                  뿯▽
   HTTPS :47810          UDP :47832         HTTP :7000        HTTP 뿯↽ board
   Signal (phone)        overlays           simulator         Local API
                               뿯▽
                               └── display.announce :47833
```

---

## Prerequisites

| Role | Need |
|------|------|
| **Bridge (local)** | [Node.js 18+](https://nodejs.org/) (the Docker image is Node 20 Alpine), an Amazon account with Alexa devices |
| **Bridge (Docker / NAS)** | Docker Compose, **host networking**, a project folder the container can bind-mount (`./data`, `./src`, `./.env`) |
| **Display client** | Windows 10+, Python 3.10+ *or* a portable zip built on a Windows machine, Edge WebView2 (usually already installed), same LAN as the bridge |
| **Phone UI** | A browser that can reach `https://<bridge-host>:47810/` |
| **Vestaboard (optional)** | Local API enabled, **static IP** (mDNS from a container is unreliable), reachable at `http://<board-ip>:7000` |
| **Huupe Mini (optional)** | The hoop on the LAN with wireless ADB (typically port **5555**). The container image already includes `adb`. |

Amazon, PSN, and Autodarts use unofficial clients. They can break when those services change.

---

## Ports

Host networking shares the NAS (or laptop) stack. Do not rely on published `ports:` maps for UDP.

| Port | Protocol | Direction | What |
|------|----------|-----------|------|
| **47810** | HTTPS | In | Signal web UI (landing, `/admin/`, `/user/`, `/games/`, `/guestbook/`, `/guestsnaps/`) |
| **47811** | HTTP | In | Optional redirect to HTTPS (`0` disables it) |
| **47832** | UDP | Out (and listen on clients) | Overlays and commands: `web.open`, remote input, reboot |
| **47833** | UDP | In | `display.announce` from Windows clients |
| **7000** | HTTP | In (sim) / out (hardware) | Vestaboard Local API |
| **3456** | HTTP | In | One-off Amazon login proxy (`npm run auth` / `./reauth.sh`) |
| **4381** | HTTP | In | Tesla OAuth callback when the redirect host is not localhost |

Windows Firewall on each display PC must allow UDP **47832** (inbound) and outbound **47833** to the NAS.

---

## 1. Get the code

```bash
git clone <your-fork-or-this-repo>
cd alexa-broadcast-bridge
```

On a QNAP, the shared folder *is* the working copy (File Station or SSH). A typical path is `/share/Container/signal-bridge`. The NAS often has no `git`; copy or sync the tree there.

Create the runtime directory **before** the first container start so Docker does not turn missing files into empty folders:

```bash
mkdir -p data
touch data/voice-events.jsonl
```

---

## 2. Config file

The bridge loads the first existing file, in this order:

1. `data/config.json` — use this for Docker (the container only mounts `./data`)
2. `config.json` at the repo root — convenient for local `npm start`
3. `config.example.json` — fallback defaults if neither file exists

```bash
cp config.example.json data/config.json
```

For a NAS, put the NAS LAN IP in `webServer.certHosts` so phones can accept the self-signed cert:

```json
"webServer": {
  "enabled": true,
  "port": 47810,
  "https": true,
  "httpRedirectPort": 47811,
  "certHosts": ["192.168.1.10"]
}
```

House city, timezone, units, and the implicit "here" for weather/routes are meant to be set later in **Settings 뿯↽ Global**. Do not copy someone else's coordinates from `config.example.json`.

Optional but useful on a NAS if LAN broadcast of overlays is flaky — unicast to each display PC:

```json
"udpBroadcast": {
  "enabled": true,
  "port": 47832,
  "discoveryPort": 47833,
  "targets": ["192.168.1.100"]
}
```

---

## 3. Environment file

`docker-compose.yml` lists `env_file: .env`. Compose **fails if that file is missing**. Create it even if you only fill the required rows:

```bash
cp .env.example .env
```

Then edit `.env`. See [Environment variables](#environment-variables) for every key the bridge actually reads.

**Minimum for a real home LAN:**

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-long-unique-password
LAN_UDP_SECRET=
TZ=America/Denver
```

Generate the UDP secret (do **not** reuse an example string):

```bash
openssl rand -base64 32
```

Put the **same** value in every display client `config.json` as `"udpSecret"`. Empty secret = plaintext UDP. Anyone on the LAN can then forge overlays, remote keyboard/mouse, reboot, and `web.open`. That is for local smoke tests only.

**After any `.env` change on Docker:** recreate the container. Compose injects `env_file` at **create** time; a plain restart keeps the old process environment.

```bash
./recreate.sh
# same as: docker compose up -d --force-recreate --remove-orphans
```

The file is also bind-mounted at `/app/.env` so a process restart can pick up *new* keys that were not already in `process.env`. Existing keys still need a recreate.

---

## 4A. Local development (laptop)

```bash
npm install
cp config.example.json data/config.json
cp .env.example .env
npm run auth
npm start
```

Set `ADMIN_PASSWORD` and `LAN_UDP_SECRET` in `.env` before `npm start`.

Open `https://localhost:47810/` and sign in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`. The Vestaboard simulator listens on `http://localhost:7000` and is already registered, so **Push 뿯↽ any board page** works immediately.

Verbose logs:

```bash
DEBUG=1 npm start
```

`npm run auth` starts a login proxy on **http://127.0.0.1:3456/** (or `PROXY_PORT`). Complete Amazon login in the browser and wait for **Authentication complete**.

---

## 4B. Production (NAS + Docker)

`network_mode: host` is required. UDP discovery and the phone UI will not work reliably through published port maps.

```bash
cd /share/Container/signal-bridge
cp .env.example .env
cp config.example.json data/config.json
mkdir -p data
touch data/voice-events.jsonl

docker compose build
docker compose up -d
docker compose logs -f signal-bridge
```

Edit `.env` before `up` (section 3). You want logs like:

```
Alexa bridge ready
Connected to Alexa push channel
Listening for broadcast/announcement activity
```

Helpers:

| Script | When |
|--------|------|
| `./recreate.sh` | Restart after JS or `.env` edits (`src/` is bind-mounted; no rebuild) |
| `./recreate.sh --build` | `Dockerfile` or `package.json` changed |
| `./reauth.sh` | Amazon session expired (`PROXY_OWN_IP=<NAS-LAN-IP> ./reauth.sh`) |

**Amazon session on the NAS.** Easiest path: authenticate on a PC (`npm run auth`), then copy `data/alexa-session.json` (and `data/formerDataStore.json` if present) onto the NAS share.

Or run auth on the NAS (stop the listener first so port 3456 is free):

```bash
PROXY_OWN_IP=192.168.1.10 ./reauth.sh
# browser: http://192.168.1.10:3456/
```

Then `docker compose up -d --force-recreate --remove-orphans`.

QNAP Container Station steps, ZFS build failures, and the `EISDIR` "Docker created a folder instead of a file" fix are in [DOCKER.md](DOCKER.md).

---

## 5. Sign in to Signal

1. Browse `https://<NAS-or-laptop-IP>:47810/`
2. Accept the self-signed certificate once (or issue a real one — [DOCKER.md 뿯↽ Let's Encrypt](DOCKER.md#lets-encrypt-certbot-inside-the-container))
3. Sign in with the bootstrap admin from `.env`

Without `ADMIN_PASSWORD`, `/admin` and `/user` APIs stay locked.

Create other household accounts from **Settings 뿯↽ Accounts**. Gmail for password-reset mail is optional (see [Gmail](#gmail-password-mail)).

---

## 6. Windows display client

Build the portable zip on a **Windows** machine with Python 3.10+ (UNC `\\nas\...` often breaks `cmd`; `subst Z:` the share if needed):

```bat
cd "alexa broadcast client"
build_portable.bat --no-pause
```

Copy `dist\alexa broadcast client.zip` to the poster PC, extract, and edit `config.json`:

```json
{
  "listenPort": 47832,
  "displayName": "Poster Display",
  "bridgeHosts": ["192.168.1.10"],
  "udpSecret": "<same value as LAN_UDP_SECRET>",
  "discoveryPort": 47833
}
```

`bridgeHosts` must be the NAS LAN IP. Broadcast to `255.255.255.255` often never reaches a NAS.

Run `Run Alexa Broadcast Client.bat`, allow the private-network firewall prompt, then confirm the display appears in Signal's picker. Full client notes: [`alexa broadcast client/README.md`](alexa%20broadcast%20client/README.md).

---

## 7. Vestaboard

No hardware needed to start: the simulator is enabled by default (`vestaboardSimulator.enabled`, port **7000**).

**Real board:**

1. Enable the **Local API** on the Vestaboard and give it a static DHCP reservation
2. Signal 뿯↽ **Settings 뿯↽ Media 뿯↽ Vestaboards** 뿯↽ add name, `http://<board-ip>:7000`, and the Local API key
3. Keys are encrypted into `data/vestaboard-settings.json` with `data/secret.key`. They are **not** env vars unless you set a board's `tokenEnv` and put that variable in `.env`
4. **Test flip** should walk the flaps. **Key refused** = wrong key. **Not answering** = unreachable from the container (almost always mDNS — use the IP)

House dwell, jump/hold priorities, and quiet hours are under the same Settings page.

---

## 8. Prove the pipe

On an Echo: *"Alexa, announce dinner is ready."*

You should get a line in `data/voice-events.jsonl`, a UDP overlay on any announced display, and (if a board is holding nothing else) a Vestaboard page.

From a Windows machine on the LAN:

```bat
cd "alexa broadcast client"
python test/send_test.py --type broadcast
```

Bridge tests: `npm test` (from repo root). Full suite: `run_all_tests.bat`.

---

## Environment variables

Source of truth for names and comments is [`.env.example`](.env.example). This section is what the **code actually reads**, grouped by whether you need it.

**Rules that apply to almost every secret:**

- Env **wins** over a value saved in the admin UI. Saving that field then returns **409** rather than shadowing `.env`.
- Most integrations can be linked from Settings instead; the credential is then encrypted under `data/` with `data/secret.key`.
- Never commit filled `.env` files. Never log or paste live tokens into issues or this repo.
- Compose `env_file` only applies at container **create**. Recreate after edits.

### Required on a real home LAN

| Variable | What it does |
|----------|----------------|
| `LAN_UDP_SECRET` | Shared AES-256-GCM secret for UDP `:47832` / `:47833`. Same string as each client `"udpSecret"`. Empty = plaintext (tests only). Generate with `openssl rand -base64 32`. |

### Required for the Signal web UI

| Variable | Default | What it does |
|----------|---------|----------------|
| `ADMIN_PASSWORD` | *(empty — UI locked)* | Password for the first household admin. |
| `ADMIN_USERNAME` | `admin` | Username for that bootstrap admin. Everyone else is created in Settings 뿯↽ Accounts. |
| `ADMIN_SESSION_HOURS` | `12` | Session cookie lifetime. |

### Strongly recommended

| Variable | Default | What it does |
|----------|---------|----------------|
| `TZ` | `UTC` in Compose (`${TZ:-UTC}`) | Container clock. Alarms, reminders, and board clocks also use the house timezone from Settings 뿯↽ Global, with `ALARM_LOCAL_TIMEZONE` as a fallback (`America/Denver` if unset). |
| `PROXY_OWN_IP` | `127.0.0.1` | LAN IP of the machine running Amazon auth. **Required** for `./reauth.sh` on a NAS (the auth compose file refuses to start without it). Also used when deriving Guest Snaps / cert host fallbacks. |
| `AMAZON_PAGE` | `amazon.com` | Amazon site for login (`amazon.co.uk`, `amazon.de`, …). |
| `ACCEPT_LANGUAGE` | `en-US` | Login / Alexa locale. |
| `DEBUG` | off | `1` or `true` for verbose bridge logs. |

### Amazon session (not env)

There is no Amazon username/password env var. The unofficial `alexa-remote2` session is `data/alexa-session.json` from `npm run auth` or `./reauth.sh`. `SESSION_FILE` overrides that path (default `data/alexa-session.json`).

### Tesla Fleet API

Needed only for live battery / dashboard. Without them, "show Tesla battery" falls back to Alexa's spoken answer.

| Variable | What it does |
|----------|----------------|
| `TESLA_CLIENT_ID` | Tesla developer app client id. |
| `TESLA_CLIENT_SECRET` | Tesla developer app secret. |
| `TESLA_FLEET_DOMAIN` | Partner domain that hosts the public key (hostname only, no scheme). |
| `TESLA_FLEET_REGION` | `na` (default), `eu`, or `cn`. |
| `TESLA_VIN` | Optional. Omit to use the first vehicle on the account. |
| `TESLA_REDIRECT_URI` | Must match the Tesla app exactly. PC OAuth: `http://localhost:4381/callback`. Phone OAuth: `https://<your-public-host>/callback` proxied to `http://<NAS>:4381/callback`. |
| `TESLA_OAUTH_REDIRECT_URI` | Alias; wins over `TESLA_REDIRECT_URI` if both are set. |
| `TESLA_CALLBACK_LISTEN` | Optional bind override, e.g. `http://0.0.0.0:4381`. |

After filling Tesla vars: `./tesla-register.sh` once per region, then OAuth (`tesla-auth-pc.bat` / `npm run tesla-auth` on a PC, or Settings 뿯↽ Authenticate Tesla). Pair the virtual key on the phone at Tesla's `_ak` URL for *your* domain. Recreate the listener afterwards.

### Guest Snaps

| Variable | What it does |
|----------|----------------|
| `GUEST_WIFI_SSID` | SSID encoded in the welcome Wi-Fi QR. |
| `GUEST_WIFI_PASSWORD` | Wi-Fi password for that QR. |
| `GUEST_WIFI_SECURITY` | `WPA` (default) or `nopass`. |
| `GUEST_WIFI_HIDDEN` | `1` if the SSID is hidden. |
| `GUEST_PHOTOBOOTH_URL` | Public **origin** for the booth (the page itself is `/guestsnaps/`). Defaults to `https://<PROXY_OWN_IP or first cert host>:47810` when unset. Prefer the Let's Encrypt hostname once you have a real cert. |
| `GUEST_PHOTOBOOTH_DISPLAY_SECONDS` | How long the welcome overlay stays (default 180). |

There is also an optional bind-mounted `data/guest-photobooth.json` fallback with the same fields. Env wins.

### Short links (TinyURL)

| Variable | What it does |
|----------|----------------|
| `TINYURL_API_TOKEN` | Global token ([TinyURL API settings](https://tinyurl.com/app/settings/api)). Creates `/guestbook/`, `/guestsnaps/`, and `/games/` aliases. |
| `TINYURL_API_TOKEN_GUESTBOOK` | Overrides the global token for Guest Book only. |
| `TINYURL_API_TOKEN_GUESTSNAPS` | Same, for Guest Snaps. |
| `TINYURL_API_TOKEN_GAMES` | Same, for games. |

Also set the **Public base URL** (https, not a LAN IP) in Settings 뿯↽ Global.

### Steam Now Playing

| Variable | What it does |
|----------|----------------|
| `STEAM_API_KEY` | Long-lived Web API key from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey). |
| `STEAM_STEAM_ID` | Optional SteamID64. Otherwise link via Settings 뿯↽ Authenticate Steam. |
| `STEAM_OPENID_REALM` | Public https origin used as OpenID `return_to`. Must be the URL you actually open in the browser (not `127.0.0.1` from inside Docker). |
| `STEAM_ENABLED` | `0` disables the feature. |
| `STEAM_REQUIRE_PRESENCE` | `1` only shows a card when a listed PC reports the game. Default is "in-game on any machine". |
| `STEAM_ALLOWED_HOSTS` | Comma-separated `COMPUTERNAME` list; only used when presence is required. |
| `STEAM_PRESENCE_SECRET` | Shared secret for `tools/steam-presence-reporter` (defaults to the API key). |
| `STEAM_RESTORE_AFTER_INTERRUPT_SEC` | Re-show the card after Alexa/other overlays (default 75). |
| `STEAM_INFER_FROM_RECENT_SEC` | When Steam omits `gameid`, how fresh last-played must be (default 180). |
| `STEAM_RECENT_PLAY_STAGNANT_SEC` | End a no-`gameid` session if playtime stops moving (default 150). |
| `STEAM_RECENT_PLAY_HARD_IDLE_SEC` | Hard idle (default 600). |

### PlayStation Network

NPSSO is pasted in Settings 뿯↽ Games and stored encrypted. These only tune behaviour:

| Variable | What it does |
|----------|----------------|
| `PSN_ENABLED` | `0` disables PSN. |
| `PSN_ACCOUNT_ID` | Default `me`. |
| `PSN_RESTORE_AFTER_INTERRUPT_SEC` | Same idea as Steam (default 75). |

### YouTube Now Playing

| Variable | What it does |
|----------|----------------|
| `YOUTUBE_API_KEY` | Data API v3 key from Google Cloud. |
| `YOUTUBE_ENABLED` | `0` disables the whole feature. |
| `YOUTUBE_LOUNGE_ENABLED` | `0` keeps the API but stops TV pairing. |
| `YOUTUBE_PYTHON_BIN` | Interpreter for the Lounge sidecar. The Docker image already sets this to the image venv. |
| `YOUTUBE_LOUNGE_DEBUG` | `1` dumps the raw Lounge stream into `docker logs`. Verbose; needs `./recreate.sh`. |

### Plex (Feature Presentation + Top 10)

| Variable | What it does |
|----------|----------------|
| `PLEX_TOKEN` | Plex Media Server token. Never logged. Server URL and monitored players live in Settings (or `data/plex-settings.json`). |

### Ring Doorbell

Prefer **Settings 뿯↽ Ring 뿯↽ Sign in**. Optional override:

| Variable | What it does |
|----------|----------------|
| `RING_REFRESH_TOKEN` | Refresh token. Wins over `data/ring-credentials.json` and blocks admin overwrite (409). Not listed in `.env.example` but the bridge reads it. |

### News, trivia, Roll Credits, Flight Plan

| Variable | What it does |
|----------|----------------|
| `GUARDIAN_API_KEY` | [Guardian Open Platform](https://open-platform.theguardian.com/access/) — The Upside News. |
| `TRIVIA_API_KEY` | Optional paid trivia pool; free providers work without it. |
| `IGDB_CLIENT_ID` / `IGDB_CLIENT_SECRET` | Twitch developer app credentials used to talk to **IGDB** (not Twitch streaming). Roll Credits metadata. Search still works keyless via Steam. |
| `YT_DLP_BIN` | `yt-dlp` binary for Roll Credits video ingest. The Docker image already sets this. |
| `FLIGHTPLAN_RAPIDAPI_KEY` | AeroDataBox key from RapidAPI. A generic `RAPIDAPI_KEY` for some *other* RapidAPI product is not a substitute. |

Stock Market uses Yahoo Finance with no key. An optional Finnhub key is stored from Settings 뿯↽ News, not from `.env`.

### Autodarts

Day-to-day: Settings 뿯↽ Autodarts 뿯↽ **Link** (device code at Autodarts' link page) or email/password. Env still wins and returns 409 if set:

| Variable | What it does |
|----------|----------------|
| `AUTODARTS_CLIENT_ID` | Default in code is `darts-caller` (no secret). The old `developer-darts-caller` id is rejected by Autodarts' current auth server. |
| `AUTODARTS_CLIENT_SECRET` | Usually empty. |
| `AUTODARTS_EMAIL` / `AUTODARTS_PASSWORD` | Password login instead of device link. |

Voice matchers ("show darts", "darts dashboard") are toggled with `voiceEvents.autodartsQueries` in `config.json`, not with an `AUTODARTS_QUERIES` env var.

### Huupe Mini

| Variable | What it does |
|----------|----------------|
| `HUUPE_ADB_PATH` | Path to `adb` if it is not on `PATH`. The Docker image already includes `android-tools`. |

Discovery is an explicit **Settings 뿯↽ Huupe 뿯↽ Discover** action. The bridge does not sweep the LAN on startup. The hoop is tailed read-only (`adb logcat`); nothing is installed on the device.

### Gmail (password mail)

| Variable | What it does |
|----------|----------------|
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` | Google Cloud OAuth client. Enable Gmail API; scope is `gmail.send` only. |
| `GMAIL_REDIRECT_URI` | Must match the Cloud client, typically `https://<public-host>/api/gmail/callback`. |
| `CONTACT_EMAIL` | Address shown on `/privacy` and `/terms`. |

Link the mailbox from Settings 뿯↽ Accounts 뿯↽ Email after the Cloud client exists. Publish the Cloud app to **Production**. Apps left in **Testing** lose the refresh token every 7 days (verification is not required for household-only use).

### Vestaboard simulator bind

| Variable | Default | What it does |
|----------|---------|----------------|
| `VESTABOARD_SIM_PORT` | `7000` | Simulator Local API port. |
| `VESTABOARD_SIM_HOST` | `0.0.0.0` | Bind address. |

Real board keys are not env vars unless a board's `tokenEnv` names one.

### TLS / host

| Variable | What it does |
|----------|----------------|
| `WEB_TLS_CERT_FILE` / `WEB_TLS_KEY_FILE` | PEM overrides. Defaults are `data/web-certs/cert.pem` and `key.pem` (self-signed or Let's Encrypt). |
| `PROXY_PORT` | Amazon auth proxy (default `3456`). |
| `SIGNAL_SECRET_KEY` | Optional override for the local encryption key. If unset, the bridge uses `data/secret.key` (created on first run). Use this only if you want the key outside the data volume. |
| `ALARM_LOCAL_TIMEZONE` | IANA zone fallback when Settings 뿯↽ Global has no house pin yet. |

### Not environment variables

These are linked or stored under `data/` (encrypted where they are secrets). Do not put them in `.env` unless a row above says so.

| Secret / state | Where it lives |
|----------------|----------------|
| Amazon cookies / tokens | `data/alexa-session.json` |
| Household users + password hashes | `data/house-users.json` |
| Board Local API keys | `data/vestaboard-settings.json` |
| PSN NPSSO | Settings 뿯↽ Games 뿯↽ `data/psn-session.json` |
| Autodarts device tokens | Settings 뿯↽ Autodarts |
| Ring session (unless `RING_REFRESH_TOKEN`) | Settings 뿯↽ Ring |
| Gmail refresh token | `data/gmail-session.json` after Link Gmail |
| Tesla OAuth tokens | `data/tesla-session.json` after Tesla auth |
| Local encryption key | `data/secret.key` (or `SIGNAL_SECRET_KEY`) |
| House pin, scheduler, corpora, guest book | various `data/*-settings.json` |

---

## Optional integrations (after the core is up)

Do these from Signal 뿯↽ Settings unless you prefer env (env still wins).

| Integration | Settings / action | Env if you insist |
|-------------|-------------------|-------------------|
| **Steam** | Authenticate Steam + API key | `STEAM_API_KEY`, `STEAM_OPENID_REALM` |
| **PSN** | Paste NPSSO | `PSN_ENABLED=1` |
| **YouTube** | API key + pair a TV | `YOUTUBE_API_KEY` |
| **Plex** | Server URL + players; token | `PLEX_TOKEN` |
| **Tesla** | Register domain, OAuth, pair key | `TESLA_*` |
| **Ring** | Sign in | `RING_REFRESH_TOKEN` |
| **Autodarts** | Device link | `AUTODARTS_EMAIL` / `PASSWORD` |
| **Huupe** | Discover hoop | `HUUPE_ADB_PATH` if `adb` is missing |
| **Guardian / trivia / IGDB / Flight Plan / TinyURL / Gmail** | Each feature's card | matching `*_API_*` / `*_CLIENT_*` rows above |

---

## HTTPS on the LAN

Default: a self-signed cert in `data/web-certs/`. Put every name/IP you will type in `webServer.certHosts` **before** the first cert is generated, or delete `data/web-certs/` and restart after changing hosts. iPhone camera QR needs HTTPS plus accepting that cert once.

Let's Encrypt (DNS-01, manual TXT) is documented in [DOCKER.md](DOCKER.md#lets-encrypt-certbot-inside-the-container). Use *your* hostname and *your* contact mailbox on the issue script — do not copy another household's domain. After a real cert, set `GUEST_PHOTOBOOTH_URL` and `STEAM_OPENID_REALM` to that https origin and recreate.

---

## Checklist

- [ ] `data/` exists and `data/config.json` is a **file**, not a directory
- [ ] `.env` exists (Compose needs it) and is not committed
- [ ] `ADMIN_PASSWORD` set
- [ ] `LAN_UDP_SECRET` set; every display `udpSecret` matches
- [ ] `data/alexa-session.json` present (`npm run auth` or `./reauth.sh`)
- [ ] Docker uses `network_mode: host`
- [ ] NAS LAN IP in `webServer.certHosts` and each client `bridgeHosts`
- [ ] `./recreate.sh` after `.env` edits
- [ ] Echo announce produces a `voice-events.jsonl` line
- [ ] Display appears in the Signal picker
- [ ] Simulator Test flip (or a real board) moves flaps

---

## Common failures

| Symptom | Fix |
|---------|-----|
| Compose: env file not found | `cp .env.example .env` |
| `No session found` | `npm run auth` or copy `data/alexa-session.json` onto the NAS |
| `EISDIR` / `config.json` is a directory | Docker created a folder because the file was missing. `docker compose down`, remove that directory, copy the real file, recreate. Same for `voice-events.jsonl`. |
| `/admin` rejected / APIs locked | `ADMIN_PASSWORD` empty or container not recreated after setting it |
| Phone cannot open Signal / QR camera blocked | Use `https://` `:47810`; accept the cert; put the NAS IP in `certHosts` |
| Client never appears | `bridgeHosts` = NAS IP, discovery **47833**, host networking, matching `udpSecret` |
| Overlays never arrive | Windows firewall **47832**; optional `udpBroadcast.targets`; matching secret |
| Board **Not answering** | Static IP, not `vestaboard.local` |
| Nothing flips, queue grows | A game/Huupe hold, or quiet hours. Simulator 뿯↽ Release Holds |
| Auth proxy "address already in use" | Stop the listener and `docker rm -f signal-alexa-auth`; `PROXY_PORT=3457` if 3456 is taken |
| QNAP `docker compose build` ZFS error | `./recreate.sh` without `--build` — `src/` is bind-mounted |
| Tesla / Gmail / Steam callback fails | Redirect URI must match the developer console **and** the URL in the browser (public hostname, not Docker's `127.0.0.1`) |

More rows: [DOCKER.md 뿯↽ Troubleshooting](DOCKER.md#7-troubleshooting).

---

## Related docs

| Doc | Audience |
|-----|----------|
| [README.md](README.md) | What Signal does, skills, games, UDP, day-to-day |
| [DOCKER.md](DOCKER.md) | QNAP Container Station, Let's Encrypt, NAS-only traps |
| [`.env.example`](.env.example) | Annotated env template (copy, never commit the filled file) |
| [`config.example.json`](config.example.json) | Config template |
| [`alexa broadcast client/README.md`](alexa%20broadcast%20client/README.md) | Display client build and `config.json` |
| [`src/PROJECT.md`](src/PROJECT.md) | Bridge internals |
| [`alexa broadcast client/src/PROJECT.md`](alexa%20broadcast%20client/src/PROJECT.md) | Client internals |
