# Steam presence reporter (optional)

**Not required for normal use.** By default the bridge shows Now Playing whenever
your linked Steam account is in-game on **any** PC (`STEAM_REQUIRE_PRESENCE=0`).

Use this helper (or display-client `steamAppId` announce) only if you set
`STEAM_REQUIRE_PRESENCE=1` and want to limit the overlay to specific hostnames.

## Setup (only if host-gating)

1. Copy this folder to the gaming PC.
2. Copy `config.example.json` → `config.json` (`bridgeUrl` + `secret`).
3. `powershell -ExecutionPolicy Bypass -File report-loop.ps1`

Hostname must match `STEAM_ALLOWED_HOSTS`.
