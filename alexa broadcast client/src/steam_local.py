"""Read the local Steam RunningAppID (Windows registry) for display announces."""

from __future__ import annotations


def read_steam_running_app_id() -> int:
    """Return the Steam app currently running on this PC, or 0 if none/unavailable."""
    try:
        import winreg
    except ImportError:
        return 0
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as key:
            value, _ = winreg.QueryValueEx(key, "RunningAppID")
        app_id = int(value)
        return app_id if app_id > 0 else 0
    except OSError:
        return 0
    except (TypeError, ValueError):
        return 0
