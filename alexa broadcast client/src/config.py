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
    # Shared secret for AES-GCM UDP with the bridge (must match LAN_UDP_SECRET).
    # Empty = plaintext (dev only). Set the same long random string on both sides.
    "udpSecret": "",
    "maxDisplaySeconds": 120,
    "defaultDisplaySeconds": 120,
    "fadeInMs": 400,
    "fadeOutMs": 600,
    "overlayBackground": "#0B1730",
    "overlayOpacity": 0.88,
    "webOverlayOpacity": 0.88,
    "chipBackground": "#141F35",
    "accentColor": "#5FD0FF",
    "alertColor": "#FF7A6B",
    "textColor": "#F2F7FF",
    "mutedTextColor": "#A4ACC0",
    "maxMessageCharacters": 8000,
    "scrollPixelsPerSecond": 28,
    "scrollStartPauseMs": 1800,
    "scrollEndPauseMs": 2500,
    "defaultLocation": {
        "name": "Home",
        "latitude": 40.0,
        "longitude": -111.0,
    },
    "shoppingList": {
        "pageSeconds": 10,
        "itemsPerPage": 10,
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
        if isinstance(loaded.get("shoppingList"), dict):
            config["shoppingList"] = {
                **DEFAULTS.get("shoppingList", {}),
                **loaded["shoppingList"],
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

    if payload.get("type") == "route-planner.query":
        # Map + facts + weather tiles need time; bridge asks for 2× default
        # (or routePlanner.displaySeconds) and we must not clamp it.
        return max(requested, 1)

    if payload.get("type") == "steam.now-playing":
        # Auto sessions are persistent; manual preview / last-played use displaySeconds.
        if payload.get("persistent") is True:
            return 0
        return min(max(requested, 1), config["maxDisplaySeconds"])

    if payload.get("type") == "psn.now-playing":
        if payload.get("persistent") is True:
            return 0
        return min(max(requested, 1), config["maxDisplaySeconds"])

    if payload.get("type") == "youtube.now-playing":
        if payload.get("persistent") is True:
            return 0
        return min(max(requested, 1), config["maxDisplaySeconds"])

    if payload.get("type") == "trivia.round":
        # The bridge sizes this to the whole sequence (intro + n×(question +
        # answer) + summary). Clamping would cut the round off mid-question.
        return max(requested, 1)

    if payload.get("type") == "upside-news.round":
        # Index + stories may loop; clamping would cut mid-story.
        return max(requested, 1)

    if payload.get("type") == "wiki-common-knowledge.round":
        # Index + articles may loop; clamping would cut mid-article.
        return max(requested, 1)

    if payload.get("type") == "overhead.round":
        # Radar scope + paginated list may loop; clamping would cut mid-cycle.
        return max(requested, 1)

    if payload.get("type") == "game.library-tour":
        # Client loops posters locally; bridge marks persistent with displaySeconds 0.
        if payload.get("persistent") is True:
            return 0
        return max(requested, 1)

    if payload.get("persistent") is True:
        # Stay until an explicit close or another overlay replaces it.
        return 0

    return min(max(requested, 1), config["maxDisplaySeconds"])
