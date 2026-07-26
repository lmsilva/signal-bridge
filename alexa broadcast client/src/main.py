import queue
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox

from src.config import effective_display_seconds, load_config
from src.display_announce import DisplayAnnouncer
from src.display_identity import resolve_display_id, resolve_display_name
from src.input_control import (
    handle_input_payload,
    set_cursor_duck_callback,
    set_cursor_moved_callback,
)
from src.listener import UdpListener
from src.overlay import OverlayWindow
from src.remote_cursor import RemoteCursorOverlay
from src.tray_app import run_tray
from src.payload_utils import COMMAND_TYPES
from src.web_overlay import (
    WebOverlayManager,
    build_web_error_payload,
    build_web_opening_payload,
)


class BroadcastClientApp:
    DISPLAY_TYPES = frozenset(
        {
            "broadcast",
            "time.query",
            "weather.query",
            "indoor-temperature.query",
            "air-quality.query",
            "timer.snapshot",
            "alarm.snapshot",
            "shopping-list.snapshot",
            "music.playing",
            "smart-home.command",
            "tesla-battery.query",
            "tesla-dashboard.query",
            "vivint-alarm.query",
            "alexa-notifications.query",
            "request.processing",
            "display.auth",
            "qr.display",
            "guest.photobooth",
            "photo.slideshow",
            "route-planner.query",
            "steam.now-playing",
        }
    )

    # Bridge control commands — handled outside the overlay/timeout path.
    COMMAND_TYPES = frozenset(COMMAND_TYPES)

    def __init__(self):
        self.config = load_config()
        self.display_id = resolve_display_id(self.config)
        self.display_name = resolve_display_name(self.config)
        self.message_queue = queue.Queue()
        self.display_active = False
        self.listener = UdpListener(
            port=self.config["listenPort"],
            address=self.config["listenAddress"],
            on_message=self.message_queue.put,
            display_id=self.display_id,
            udp_secret=self.config.get("udpSecret") or "",
        )
        self.announcer = DisplayAnnouncer(self.config)
        self.tray_icon = None
        self.root = None
        self.overlay = None
        self.remote_cursor = None
        self.web_overlay = WebOverlayManager(self.config)

    def start(self):
        # Do not call SetProcessDpiAwareness here: making the process DPI-aware
        # inflates Tk font pixel metrics while panel layouts still use fixed
        # offsets, which stacks Tesla/dashboard cards on top of each other.
        # SendInput uses the same (DPI-unaware) metrics as GetCursorPos.
        self.listener.start()
        if not self.listener.wait_until_ready():
            error = self.listener.bind_error
            message = (
                f"Could not listen on UDP {self.config['listenAddress']}:"
                f"{self.config['listenPort']}"
            )
            if error:
                message = f"{message} ({error})"
            print(message, file=sys.stderr)
            raise RuntimeError(message)

        print(
            f"Display identity: {self.display_name} ({self.display_id})",
            flush=True,
        )
        if str(self.config.get("udpSecret") or "").strip():
            print("UDP LAN encryption enabled (AES-256-GCM shared secret)", flush=True)
        else:
            print(
                "WARNING: UDP LAN encryption disabled — set udpSecret in config.json "
                "(matching bridge LAN_UDP_SECRET) to encrypt overlays and remote input",
                flush=True,
            )
        self.announcer.start()
        self.tray_icon = run_tray(on_exit=self.shutdown)

        self.root = tk.Tk()
        self.root.withdraw()
        self.overlay = OverlayWindow(
            self.root,
            self.config,
            on_user_dismiss=self._on_user_dismiss,
            on_local_timer_fired=self._on_local_timer_fired,
        )
        self.remote_cursor = RemoteCursorOverlay(self.root)
        set_cursor_moved_callback(self._on_remote_cursor_moved)
        set_cursor_duck_callback(self._on_remote_cursor_duck)
        self.root.after(100, self._poll_messages)
        self.root.mainloop()

    def _on_remote_cursor_moved(self, x: int, y: int):
        # Tk callbacks must run on the main thread — input is already applied
        # from the poll loop on that thread, so this is safe to call directly.
        if self.remote_cursor is not None:
            self.remote_cursor.show_at(x, y)

    def _on_remote_cursor_duck(self):
        if self.remote_cursor is not None:
            self.remote_cursor.duck()

    def _poll_messages(self):
        try:
            while True:
                payload = self.message_queue.get_nowait()
                # One bad payload must never kill the poll loop — an uncaught
                # exception here would stop the after() rescheduling and the
                # client would silently ignore all UDP from then on.
                try:
                    if payload.get("type") in self.COMMAND_TYPES:
                        self._handle_command_payload(payload)
                        continue
                    seconds = effective_display_seconds(payload, self.config)
                    self._show_payload(payload, seconds)
                except Exception as exc:
                    print(
                        f"Failed to handle {payload.get('type')} payload: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
        except queue.Empty:
            pass

        self.root.after(100, self._poll_messages)

    def _handle_command_payload(self, payload: dict):
        command_type = payload.get("type")
        if command_type == "display.discover":
            rinfo = payload.get("_rinfo") or {}
            discovery = payload.get("discovery") or {}
            self.announcer.remember_bridge_host(
                rinfo.get("address"),
                discovery.get("port"),
            )
            self.announcer.announce_now(rinfo.get("address"))
            return
        if handle_input_payload(payload):
            return
        if command_type == "web.open":
            url = (payload.get("web") or {}).get("url")
            if not url:
                return
            # Always acknowledge receipt on-screen first — otherwise a silent
            # spawn failure looks like the push never arrived.
            ack = build_web_opening_payload(payload)
            self._show_payload(ack, effective_display_seconds(ack, self.config))
            # Pre-flight + spawn happen off-thread; on failure the friendly
            # error message flows back through the normal display path.
            self.web_overlay.open_url(
                url,
                on_failure=lambda _reason, p=payload: self.message_queue.put(
                    build_web_error_payload(p)
                ),
            )
        elif command_type == "web.close":
            self.web_overlay.close()
        elif command_type == "steam.now-playing.close":
            if self.overlay and self.overlay.active_display_type == "steam.now-playing":
                self.overlay.dismiss_immediately()
        elif command_type == "system.command":
            self._run_system_command((payload.get("system") or {}).get("action"))

    def _run_system_command(self, action: str):
        flags = {"reboot": "/r", "poweroff": "/s"}
        flag = flags.get(action)
        if not flag:
            return
        self.web_overlay.close()
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            subprocess.Popen(
                ["shutdown", flag, "/t", "5"], creationflags=creationflags
            )
        except OSError as exc:
            print(f"System {action} failed: {exc}", file=sys.stderr)

    @staticmethod
    def _is_alarm_snapshot(payload: dict) -> bool:
        return payload.get("type") == "alarm.snapshot"

    @staticmethod
    def _alarm_payload_has_content(payload: dict) -> bool:
        kind = BroadcastClientApp._timer_event_kind(payload)
        if kind in ("list", "started", "cancelled"):
            return True
        if payload.get("trigger") == "show-alarms":
            return True
        return bool(payload.get("alarms"))

    @staticmethod
    def _is_timer_snapshot(payload: dict) -> bool:
        return payload.get("type") == "timer.snapshot"

    @staticmethod
    def _build_fired_timer_payload(base_payload: dict, timer: dict) -> dict:
        fired_payload = dict(base_payload)
        fired_timer = {**timer, "remainingSec": 0, "status": "OFF"}
        fired_payload["event"] = {"kind": "fired", "timer": fired_timer}
        fired_payload["timers"] = [fired_timer]
        return fired_payload

    @staticmethod
    def _timer_event_kind(payload: dict) -> str:
        return (payload.get("event") or {}).get("kind", "list")

    @staticmethod
    def _timer_payload_has_content(payload: dict) -> bool:
        kind = BroadcastClientApp._timer_event_kind(payload)
        if kind in ("fired", "cancelled", "list"):
            return True
        if payload.get("trigger") == "show-timers":
            return True
        return bool(payload.get("timers"))

    def _should_show(self, payload: dict) -> bool:
        if self._is_timer_snapshot(payload):
            return self._timer_payload_has_content(payload)
        if self._is_alarm_snapshot(payload):
            return self._alarm_payload_has_content(payload)
        display_type = payload.get("type")
        if display_type in self.DISPLAY_TYPES:
            return True
        return bool(payload.get("message"))

    def _show_payload(self, payload: dict, seconds: int):
        if not self._should_show(payload):
            return

        if self.display_active and self.overlay.visible:
            self.overlay.advance(payload, seconds)
            return

        self.display_active = True
        self.overlay.show(payload, seconds, on_closed=self._on_display_closed)

    def _on_local_timer_fired(self, timer: dict, base_payload: dict):
        fired_payload = self._build_fired_timer_payload(base_payload, timer)
        seconds = effective_display_seconds(fired_payload, self.config)
        self._show_payload(fired_payload, seconds)

    def _on_user_dismiss(self):
        self.overlay.dismiss_immediately()

    def _on_display_closed(self):
        self.display_active = False

    def shutdown(self):
        self.web_overlay.close()
        set_cursor_moved_callback(None)
        set_cursor_duck_callback(None)
        if self.remote_cursor:
            self.remote_cursor.destroy()
            self.remote_cursor = None
        self.announcer.stop()
        self.listener.stop()
        if self.tray_icon:
            self.tray_icon.stop()
        if self.root:
            self.root.after(0, self.root.destroy)


def _make_console_streams_unicode_safe():
    """On Windows the console/log stream often defaults to cp1252, which
    raises UnicodeEncodeError (and silently kills whichever background
    thread was mid-``print()``) the moment a log message contains an
    arrow or other non-Latin-1 character. Reconfigure to UTF-8 with a
    forgiving error handler so a stray character never takes down a
    thread — this is a no-op on streams that don't support reconfigure
    (e.g. already UTF-8, or redirected to a file opened elsewhere)."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except (ValueError, OSError):
                pass


def main():
    _make_console_streams_unicode_safe()
    try:
        app = BroadcastClientApp()
        app.start()
    except RuntimeError as exc:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("Alexa Broadcast Client", str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
