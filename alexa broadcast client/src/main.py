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
        self.overlay = OverlayWindow(self.root, self.config, on_user_dismiss=self._on_user_dismiss)
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

    def _enqueue_display(self, payload: dict, seconds: int):
        if self.display_active and not self.overlay.visible and not self.pending_displays:
            self.display_active = False

        if self.display_active:
            self.pending_displays.append((payload, seconds))
            return

        self.display_active = True
        self.overlay.show(payload, seconds, on_closed=self._on_display_closed)

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
