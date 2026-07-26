"""Announce this display to the bridge over UDP.

Uses a dedicated discovery port (default 47833) so announces do not collide
with the overlay listen socket on :47832. Prefers unicast to configured
``bridgeHosts`` (LAN broadcasts to 255.255.255.255 often never reach a NAS).

While a Steam game is running on this PC, announces more often so the bridge
can treat the client as a presence heartbeat (no separate reporter process).
"""

from __future__ import annotations

import json
import socket
import threading
import time

from src.display_identity import build_announce_payload
from src.lan_crypto import encode_outbound
from src.steam_local import read_steam_running_app_id

ANNOUNCE_INTERVAL_SEC = 5 * 60
ANNOUNCE_PLAYING_SEC = 20
STEAM_WATCH_SEC = 5
DEFAULT_DISCOVERY_PORT = 47833


class DisplayAnnouncer:
    def __init__(self, config: dict, log=print):
        self.config = config
        self.log = log
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.listen_port = int(config.get("listenPort") or 47832)
        self.discovery_port = int(
            config.get("discoveryPort") or DEFAULT_DISCOVERY_PORT
        )
        hosts = config.get("bridgeHosts") or []
        if isinstance(hosts, str):
            hosts = [hosts]
        self._bridge_hosts: set[str] = {
            str(h).strip() for h in hosts if str(h).strip()
        }
        self._last_steam_app_id = 0

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="display-announce", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop.set()

    def remember_bridge_host(self, host: str | None, discovery_port: int | None = None):
        host = str(host or "").strip()
        if host and host not in ("0.0.0.0", "127.0.0.1", "::1"):
            self._bridge_hosts.add(host)
        if discovery_port:
            try:
                self.discovery_port = int(discovery_port)
            except (TypeError, ValueError):
                pass

    def announce_now(self, bridge_hint: str | None = None):
        if bridge_hint:
            self.remember_bridge_host(bridge_hint)

        steam_app_id = read_steam_running_app_id()
        self._last_steam_app_id = steam_app_id
        payload = build_announce_payload(self.config, steam_app_id=steam_app_id)
        wire = encode_outbound(payload, self.config.get("udpSecret") or "")
        body = json.dumps(wire, separators=(",", ":")).encode("utf-8")
        targets = set(self._bridge_hosts)
        # Always try broadcast as a fallback (works on some LANs).
        targets.add("255.255.255.255")

        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sent = []
            for host in sorted(targets):
                try:
                    sock.sendto(body, (host, self.discovery_port))
                    sent.append(f"{host}:{self.discovery_port}")
                except OSError as exc:
                    self.log(f"Display announce to {host}:{self.discovery_port} failed: {exc}")
            steam_note = f" steamAppId={steam_app_id}" if steam_app_id else ""
            self.log(
                f"Display announced: {payload['display']['name']} "
                f"({payload['display']['id']}) host={payload['display'].get('hostname')}"
                f"{steam_note} -> {', '.join(sent) or 'nowhere'}"
            )
        finally:
            sock.close()

    def _run(self):
        next_announce_at = 0.0
        while not self._stop.is_set():
            steam_app_id = read_steam_running_app_id()
            now = time.monotonic()
            changed = steam_app_id != self._last_steam_app_id
            if changed or now >= next_announce_at:
                self.announce_now()
                interval = ANNOUNCE_PLAYING_SEC if steam_app_id > 0 else ANNOUNCE_INTERVAL_SEC
                next_announce_at = time.monotonic() + interval
            self._stop.wait(STEAM_WATCH_SEC)
