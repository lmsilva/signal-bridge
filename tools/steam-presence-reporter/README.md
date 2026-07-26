# Steam presence reporter

Tiny Windows helper for **MOVIETHEATERPC** (or any host in `steam.allowedHosts`).

Steam’s public Web API does **not** say which PC is playing, and `gameid` in GetPlayerSummaries often **lags** a launch. This reporter heartbeats the local computer name + running Steam `appid` to the bridge so Now Playing only lights up for allowed machines — each heartbeat also **wakes an immediate bridge poll** (closest thing to a push; Steam has no launch webhook).

## Setup

1. On the gaming PC, copy this folder somewhere local (e.g. `C:\Signal\steam-presence-reporter`).
2. Copy `config.example.json` → `config.json` and fill in:
   - `bridgeUrl` — `https://<NAS>:47810`
   - `secret` — same as bridge `STEAM_PRESENCE_SECRET` or `STEAM_API_KEY`
3. Test once:

```bat
powershell -ExecutionPolicy Bypass -File report.ps1
```

4. Schedule it every 30 seconds (Task Scheduler → Create Task → trigger repeating, action = the same powershell command), or drop a shortcut into Startup that runs a loop:

```bat
powershell -ExecutionPolicy Bypass -File report-loop.ps1
```

Hostname must match an entry in bridge `steam.allowedHosts` (default `MOVIETHEATERPC`). Check with `echo %COMPUTERNAME%`.
