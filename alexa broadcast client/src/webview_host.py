"""Standalone WebView2 host for the persistent web display mode.

Spawned by the main client on ``web.open`` and terminated on ``web.close``.
Renders the pushed URL fullscreen, frameless, always-on-top, with the same
layered-window semi-transparency the Tk overlay uses (display style).

Run directly:  python src/webview_host.py --url https://example.com --opacity 0.88
Frozen build:  webview-host.exe --url ... (see alexa-broadcast-client.spec)
"""

import argparse
import ctypes
import sys
import time

WINDOW_TITLE = "Alexa Broadcast Web Display"

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
LWA_ALPHA = 0x2


def clamp_opacity(value) -> float:
    try:
        opacity = float(value)
    except (TypeError, ValueError):
        return 0.88
    return min(1.0, max(0.2, opacity))


def apply_window_opacity(title: str, opacity: float, attempts: int = 40,
                         delay: float = 0.25) -> bool:
    """Find our window by title and apply WS_EX_LAYERED alpha.

    Same Windows mechanism Tk's ``-alpha`` attribute uses, so the browser
    matches the display client's semi-transparent look.
    """
    if sys.platform != "win32":
        return False
    user32 = ctypes.windll.user32
    alpha = int(round(clamp_opacity(opacity) * 255))
    for _ in range(attempts):
        hwnd = user32.FindWindowW(None, title)
        if hwnd:
            style = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED)
            user32.SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA)
            return True
        time.sleep(delay)
    return False


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Alexa Broadcast web display host")
    parser.add_argument("--url", required=True, help="Page to display")
    parser.add_argument("--opacity", default="0.88", help="Window opacity 0.2-1.0")
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    if not str(args.url).lower().startswith(("http://", "https://")):
        print("webview_host: --url must be http(s)", file=sys.stderr)
        return 2

    try:
        import webview
    except ImportError as exc:
        print(f"webview_host: pywebview unavailable: {exc}", file=sys.stderr)
        return 3

    # Note: do NOT apply WS_EX_LAYERED / SetLayeredWindowAttributes here.
    # WebView2 uses DirectComposition; classic layered-window alpha commonly
    # produces a blank/invisible window while the process stays alive. The
    # host stays frameless, fullscreen, and always-on-top instead.
    try:
        webview.create_window(
            WINDOW_TITLE,
            args.url,
            frameless=True,
            fullscreen=True,
            on_top=True,
            background_color="#0f172a",
        )

        # Edge WebView2 (Chromium) explicitly: fail fast when the runtime is
        # missing instead of falling back to the legacy MSHTML engine.
        webview.start(gui="edgechromium", private_mode=True)
    except Exception as exc:  # noqa: BLE001 - runtime missing / engine failure
        print(f"webview_host: failed to start WebView2: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
