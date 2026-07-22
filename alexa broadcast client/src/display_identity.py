"""Stable display id + name for UDP registration with the bridge."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import uuid
from pathlib import Path


def _local_app_data() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    path = Path(base) / "AlexaBroadcastClient"
    path.mkdir(parents=True, exist_ok=True)
    return path


def machine_hostname() -> str:
    try:
        return socket.gethostname() or "Display"
    except OSError:
        return "Display"


def resolve_display_name(config: dict) -> str:
    name = str(config.get("displayName") or "").strip()
    return name or machine_hostname()


def _load_or_create_machine_id() -> str:
    path = _local_app_data() / "display-id.json"
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            mid = str(data.get("machineId") or "").strip()
            if mid:
                return mid
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
    mid = str(uuid.uuid4())
    try:
        path.write_text(json.dumps({"machineId": mid}, indent=2) + "\n", encoding="utf-8")
    except OSError:
        pass
    return mid


def resolve_display_id(config: dict) -> str:
    """Stable per-machine id (not tied to displayName — duplicate names are OK)."""
    explicit = str(config.get("displayId") or "").strip()
    if explicit:
        return explicit
    machine = _load_or_create_machine_id()
    digest = hashlib.sha256(machine.encode("utf-8")).hexdigest()[:16]
    return f"disp-{digest}"


def resolve_display_short_id(config: dict) -> str:
    """Short suffix for UI disambiguation when two displays share a name."""
    display_id = resolve_display_id(config)
    raw = display_id.replace("disp-", "")
    return raw[-4:] if len(raw) >= 4 else raw


def build_announce_payload(config: dict) -> dict:
    display_id = resolve_display_id(config)
    short_id = resolve_display_short_id(config)
    return {
        "version": 2,
        "type": "display.announce",
        "timestamp": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat().replace("+00:00", "Z"),
        "display": {
            "id": display_id,
            "shortId": short_id,
            "name": resolve_display_name(config),
            "port": int(config.get("listenPort") or 47832),
        },
    }
