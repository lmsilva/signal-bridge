import json
from pathlib import Path

from src.paths import app_root, ensure_config_file

CONFIG_PATH = ensure_config_file()

DEFAULTS = {
    "listenPort": 47832,
    "listenAddress": "0.0.0.0",
    # Friendly name shown in the bridge control page. Falls back to hostname.
    "displayName": "",
    # Bridge NAS IP(s) for display.announce unicasts (broadcast often fails to NAS).
    "bridgeHosts": ["192.168.1.10"],
    # Dedicated announce port on the bridge (overlay traffic stays on listenPort).
    "discoveryPort": 47833,
    "maxDisplaySeconds": 120,
    "defaultDisplaySeconds": 120,
    "fadeInMs": 400,
    "fadeOutMs": 600,
    "overlayBackground": "#0f172a",
    "overlayOpacity": 0.88,
    "webOverlayOpacity": 0.88,
    "chipBackground": "#141a24",
    "accentColor": "#38bdf8",
    "alertColor": "#f97316",
    "textColor": "#f8fafc",
    "mutedTextColor": "#94a3b8",
    "maxMessageCharacters": 8000,
    "scrollPixelsPerSecond": 28,
    "scrollStartPauseMs": 1800,
    "scrollEndPauseMs": 2500,
    "defaultLocation": {
        "name": "Home",
        "latitude": 40.0,
        "longitude": -111.0,
    },
}


def load_config() -> dict:
    config = DEFAULTS.copy()
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        config.update(loaded)
        if isinstance(loaded.get("defaultLocation"), dict):
            config["defaultLocation"] = {
                **DEFAULTS.get("defaultLocation", {}),
                **loaded["defaultLocation"],
            }
    return config


def effective_display_seconds(payload: dict, config: dict) -> int:
    requested = payload.get("displaySeconds", config["defaultDisplaySeconds"])
    try:
        requested = int(requested)
    except (TypeError, ValueError):
        requested = config["defaultDisplaySeconds"]

    if payload.get("type") == "timer.snapshot":
        event_kind = (payload.get("event") or {}).get("kind")
        if event_kind == "fired":
            requested = max(requested, 25)

    if payload.get("type") == "photo.slideshow":
        # Duration is data-driven (number of shared photos * secondsPerPhoto)
        # — clamping it to maxDisplaySeconds would cut the slideshow short
        # before it finishes going through all the pictures once.
        return max(requested, 1)

    if payload.get("type") == "guest.photobooth":
        # Guests need time to scan Wi-Fi then the booth URL — don't clamp
        # the bridge's longer default (often 180s) down to maxDisplaySeconds.
        return max(requested, 1)

    return min(max(requested, 1), config["maxDisplaySeconds"])
