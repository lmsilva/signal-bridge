import queue
import sys
import tkinter as tk
from tkinter import messagebox

from src.config import effective_display_seconds, load_config
from src.listener import UdpListener
from src.overlay import OverlayWindow
from src.tray_app import run_tray


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
        }
    )

    def __init__(self):
        self.config = load_config()
        self.message_queue = queue.Queue()
        self.display_active = False
        self.listener = UdpListener(
            port=self.config["listenPort"],
            address=self.config["listenAddress"],
            on_message=self.message_queue.put,
        )
        self.tray_icon = None
        self.root = None
        self.overlay = None

    def start(self):
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

        self.tray_icon = run_tray(on_exit=self.shutdown)

        self.root = tk.Tk()
        self.root.withdraw()
        self.overlay = OverlayWindow(
            self.root,
            self.config,
            on_user_dismiss=self._on_user_dismiss,
            on_local_timer_fired=self._on_local_timer_fired,
        )
        self.root.after(100, self._poll_messages)
        self.root.mainloop()

    def _poll_messages(self):
        try:
            while True:
                payload = self.message_queue.get_nowait()
                seconds = effective_display_seconds(payload, self.config)
                self._show_payload(payload, seconds)
        except queue.Empty:
            pass

        self.root.after(100, self._poll_messages)

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
        self.listener.stop()
        if self.tray_icon:
            self.tray_icon.stop()
        if self.root:
            self.root.after(0, self.root.destroy)


def main():
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
