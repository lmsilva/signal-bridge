import json
import socket
import sys
import threading
from typing import Callable

from src.payload_utils import is_display_payload


class UdpListener:
    def __init__(self, port: int, address: str, on_message: Callable[[dict], None]):
        self.port = port
        self.address = address
        self.on_message = on_message
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread = None
        self.bind_error = None

    def start(self):
        self.bind_error = None
        self._ready.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="udp-listener")
        self._thread.start()

    def wait_until_ready(self, timeout_seconds: float = 2.0) -> bool:
        if not self._ready.wait(timeout_seconds):
            return False
        return self.bind_error is None

    def stop(self):
        self._stop.set()

    def _run(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((self.address, self.port))
        except OSError as exc:
            self.bind_error = exc
            print(
                f"UDP listener failed to bind {self.address}:{self.port}: {exc}",
                file=sys.stderr,
            )
            return

        self._ready.set()
        sock.settimeout(1.0)

        while not self._stop.is_set():
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                break

            try:
                payload = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue

            if isinstance(payload, dict) and is_display_payload(payload):
                self.on_message(payload)

        sock.close()
