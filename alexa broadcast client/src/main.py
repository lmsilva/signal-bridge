import queue
import sys
import tkinter as tk
from collections import deque
from tkinter import messagebox

from src.config import effective_display_seconds, load_config
from src.listener import UdpListener
from src.overlay import OverlayWindow
from src.tray_app import run_tray


class BroadcastClientApp:
    IMMEDIATE_DISPLAY_TYPES = frozenset({"broadcast", "time.query", "weather.query", "indoor-temperature.query", "air-quality.query"})

    def __init__(self):
        self.config = load_config()
        self.message_queue = queue.Queue()
        self.pending_displays = deque()
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
                self._enqueue_display(payload, seconds)
        except queue.Empty:
            pass

        self.root.after(100, self._poll_messages)

    def _is_immediate_display(self, payload: dict) -> bool:
        return payload.get("type") in self.IMMEDIATE_DISPLAY_TYPES

    @staticmethod
    def _is_timer_snapshot(payload: dict) -> bool:
        return payload.get("type") == "timer.snapshot"

    def _showing_timers(self) -> bool:
        return (
            self.display_active
            and self.overlay.visible
            and self.overlay.active_display_type == "timer.snapshot"
        )

    def _drop_pending_timer_snapshots(self):
        self.pending_displays = deque(
            item for item in self.pending_displays if not self._is_timer_snapshot(item[0])
        )

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
        if kind in ("fired", "cancelled"):
            return True
        return bool(payload.get("timers"))

    def _handle_timer_display(self, payload: dict, seconds: int):
        if not self._timer_payload_has_content(payload):
            return

        self._drop_pending_timer_snapshots()

        if self.display_active and self.overlay.visible:
            self.display_active = True
            self.overlay.advance(payload, seconds)
            return

        if self.display_active:
            self.display_active = True
            self.overlay.show(payload, seconds, on_closed=self._on_display_closed)
            return

        self.display_active = True
        self.overlay.show(payload, seconds, on_closed=self._on_display_closed)

    def _enqueue_display(self, payload: dict, seconds: int):
        if self.display_active and not self.overlay.visible and not self.pending_displays:
            self.display_active = False

        if self._is_timer_snapshot(payload):
            self._handle_timer_display(payload, seconds)
            return

        if self._is_immediate_display(payload):
            self._drop_pending_timer_snapshots()
            if self.display_active:
                self.display_active = True
                if self.overlay.visible:
                    self.overlay.advance(payload, seconds)
                else:
                    self.overlay.show(payload, seconds, on_closed=self._on_display_closed)
                return

        if self.display_active:
            self.pending_displays.append((payload, seconds))
            return

        self.display_active = True
        self.overlay.show(payload, seconds, on_closed=self._on_display_closed)

    def _on_local_timer_fired(self, timer: dict, base_payload: dict):
        fired_payload = self._build_fired_timer_payload(base_payload, timer)
        seconds = effective_display_seconds(fired_payload, self.config)
        self._handle_timer_display(fired_payload, seconds)

    def _on_user_dismiss(self):
        if self.pending_displays:
            payload, seconds = self.pending_displays.popleft()
            self.overlay.advance(payload, seconds)
            return

        self.overlay.dismiss_immediately()

    def _on_display_closed(self):
        if self.pending_displays:
            payload, seconds = self.pending_displays.popleft()
            self.display_active = True
            self.overlay.show(payload, seconds, on_closed=self._on_display_closed)
            return

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
