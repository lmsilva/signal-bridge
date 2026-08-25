# 07 — Local API addendum

The original requirements (06 §2, §10) listed the Vestaboard **Cloud API**
as the first connection mode, with Local API as a follow-up. Signal Bridge
ships **Local API only**. There is no Cloud subscription in this house, and
the send path was written against the same HTTP contract the Flagship board
speaks on the LAN.

This note is the locked Local API shape for agents and for the day hardware
arrives. If anything here disagrees with 06, **this file wins**.

## 1. Why Local API

- No Vestaboard Cloud subscription.
- The board is already on the same LAN as the NAS.
- The simulator can speak the real Local API, so nothing in the send path
  changes when a physical board is added.

Cloud API paths, `X-Vestaboard-Token`, and VBML are out of scope.

## 2. Contract

Every board — hardware or simulator — is reached by `src/vestaboard/transport.js`
with a `baseUrl` and a key.

| | |
|---|---|
| Port | **7000** |
| Enable | `POST /local-api/enablement` with `X-Vestaboard-Local-Api-Enablement-Token` |
| Write | `POST /local-api/message` with `X-Vestaboard-Local-Api-Key` and a 6×22 code grid |
| Read | `GET /local-api/message` (bare grid, not the Cloud `currentMessage` wrapper) |
| Failures | 401 missing/wrong key, 400 unshowable layout, 503 still flipping or offline |

The simulator (`src/vestaboard/simulator.js`) binds this contract on
`vestaboardSimulator.port` (default **7000**). Enablement at boot walks the
same HTTP handshake a person does with a real board.

## 3. Addressing a real board

Vestaboard documents `http://vestaboard.local:7000`. mDNS (`*.local`) is
unreliable from Docker, even with `network_mode: host` — the container often
cannot resolve the name the board advertises.

**Use a DHCP reservation / static IP** and store it as the board's `baseUrl`
in Settings (`http://192.168.x.x:7000`). Do not rely on mDNS from the NAS.

The Flagship Local API is HTTP, not HTTPS. That matches the LAN-only
assumption: the key never leaves the house, and it is stored encrypted in
`data/vestaboard-settings.json` (never in a log, SSE frame, or API body).

## 4. Simulator vs hardware

| | Simulator | Hardware |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:<sim-port>` (adopted at hub start) | `http://<static-ip>:7000` |
| Enablement token | Generated into `data/vestaboard-simulator.json` | Printed in the Vestaboard app / board settings |
| Key | Returned by enablement; stored in the board list | Same, after the first enable POST |
| Rate window | `vestaboardSimulator.rateWindowSeconds` (default 15) | 15s on current Flagship firmware |

Both share one queue, one router, and one transport. The only differences
are `baseUrl` and the key.

## 5. Docker

This bridge runs with `network_mode: host`. Port 7000 on the NAS *is* port
7000 on the LAN, which is what a physical board (and a browser hitting the
simulator from another machine) expects.

A replay run (`npm run board-replay`) does **not** use the live simulator on
7000. It stands up a temporary sim + hub in a temp directory so CI cannot
fight the running bridge.

## 6. Adding hardware

1. Give the board a static LAN IP.
2. Settings → Vestaboards → add board: name, `http://<ip>:7000`, Local API key
   (or enable once from the enablement token if the board is still locked).
3. Leave the simulator enabled. A push to `vestaboard` / All Displays that
   reaches every board will also land on the Simulator tab, which is the
   live mirror of what was sent.
4. `./recreate.sh` is not required for a settings-only add; board changes
   apply live.
