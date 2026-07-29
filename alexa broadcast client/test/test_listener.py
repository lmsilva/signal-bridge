import json
import socket
import time
import unittest

from src.lan_crypto import encode_outbound
from src.listener import UdpListener


class UdpListenerTests(unittest.TestCase):
    DISPLAY_ID = "disp-test-listener"

    def _ephemeral_port(self) -> int:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        return port

    def _start_listener(self, **kwargs):
        port = self._ephemeral_port()
        messages = []
        listener = UdpListener(
            port=port,
            address="127.0.0.1",
            on_message=messages.append,
            display_id=self.DISPLAY_ID,
            **kwargs,
        )
        listener.start()
        self.assertTrue(listener.wait_until_ready())
        return listener, port, messages

    def _send(self, port: int, body: bytes):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.sendto(body, ("127.0.0.1", port))
        finally:
            sock.close()

    def _wait_for_messages(self, messages, count=1, timeout=2.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if len(messages) >= count:
                return
            time.sleep(0.02)
        self.fail(f"expected {count} message(s), got {len(messages)}")

    def test_plaintext_display_payload_delivers_rinfo(self):
        listener, port, messages = self._start_listener()
        try:
            payload = {
                "version": 2,
                "type": "broadcast",
                "message": "hello",
                "displaySeconds": 10,
            }
            self._send(port, json.dumps(payload).encode("utf-8"))
            self._wait_for_messages(messages)
            self.assertEqual(messages[0]["message"], "hello")
            self.assertEqual(messages[0]["_rinfo"]["address"], "127.0.0.1")
            self.assertIsInstance(messages[0]["_rinfo"]["port"], int)
        finally:
            listener.stop()

    def test_encrypted_payload_accepted_plaintext_dropped(self):
        secret = "listener-test-secret"
        listener, port, messages = self._start_listener(udp_secret=secret)
        try:
            good = {
                "version": 2,
                "type": "time.query",
                "displaySeconds": 10,
            }
            wire = encode_outbound(good, secret)
            self._send(port, json.dumps(wire).encode("utf-8"))

            bad = {"version": 2, "type": "weather.query", "displaySeconds": 10}
            self._send(port, json.dumps(bad).encode("utf-8"))

            self._wait_for_messages(messages)
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["type"], "time.query")
        finally:
            listener.stop()

    def test_wrong_target_dropped_discover_always_accepted(self):
        listener, port, messages = self._start_listener()
        try:
            wrong = {
                "version": 2,
                "type": "music.playing",
                "target": {"id": "disp-other"},
                "music": {"song": "Track"},
            }
            self._send(port, json.dumps(wrong).encode("utf-8"))

            discover = {
                "version": 2,
                "type": "display.discover",
                "target": {"id": "disp-other"},
                "discovery": {"port": 47833},
            }
            self._send(port, json.dumps(discover).encode("utf-8"))

            self._wait_for_messages(messages)
            self.assertEqual(len(messages), 1)
            self.assertEqual(messages[0]["type"], "display.discover")
        finally:
            listener.stop()

    def test_non_accepted_payload_types_dropped(self):
        listener, port, messages = self._start_listener()
        try:
            meta = {
                "version": 2,
                "type": "display.announce",
                "display": {"id": self.DISPLAY_ID, "name": "Poster"},
            }
            self._send(port, json.dumps(meta).encode("utf-8"))

            unknown = {"version": 2, "type": "not.a.real.type"}
            self._send(port, json.dumps(unknown).encode("utf-8"))

            time.sleep(0.15)
            self.assertEqual(messages, [])
        finally:
            listener.stop()


if __name__ == "__main__":
    unittest.main()
