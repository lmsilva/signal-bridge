import json
from pathlib import Path

from src.paths import app_root, ensure_config_file

CONFIG_PATH = ensure_config_file()

DEFAULTS = {
    "listenPort": 47832,
    "listenAddress": "0.0.0.0",
    "maxDisplaySeconds": 120,
    "defaultDisplaySeconds": 120,
    "fadeInMs": 400,
    "fadeOutMs": 600,
    "overlayBackground": "#0f172a",
    "overlayOpacity": 0.88,
    "accentColor": "#38bdf8",
    "textColor": "#f8fafc",
    "mutedTextColor": "#94a3b8",
    "maxMessageCharacters": 8000,
    "scrollPixelsPerSecond": 28,
    "scrollStartPauseMs": 1800,
    "scrollEndPauseMs": 2500,
}


def load_config() -> dict:
    config = DEFAULTS.copy()
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            config.update(json.load(handle))
    return config


def effective_display_seconds(payload: dict, config: dict) -> int:
    requested = payload.get("displaySeconds", config["defaultDisplaySeconds"])
    try:
        requested = int(requested)
    except (TypeError, ValueError):
        requested = config["defaultDisplaySeconds"]

    return min(max(requested, 1), config["maxDisplaySeconds"])
