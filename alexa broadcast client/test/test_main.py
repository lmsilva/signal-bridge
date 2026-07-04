import unittest
from collections import deque

from src.config import effective_display_seconds
from src.main import BroadcastClientApp


class MainTimerDisplayTests(unittest.TestCase):
    def test_timer_snapshot_detected(self):
        self.assertTrue(BroadcastClientApp._is_timer_snapshot({"type": "timer.snapshot"}))
        self.assertFalse(BroadcastClientApp._is_timer_snapshot({"type": "broadcast"}))

    def test_build_fired_timer_payload(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "started"},
            "timers": [{"label": "Pizza", "durationSec": 300, "device": "Kitchen Echo"}],
        }
        fired = BroadcastClientApp._build_fired_timer_payload(payload, payload["timers"][0])
        self.assertEqual(fired["event"]["kind"], "fired")
        self.assertEqual(fired["timers"][0]["remainingSec"], 0)
        self.assertEqual(fired["timers"][0]["status"], "OFF")
        self.assertEqual(fired["event"]["timer"]["label"], "Pizza")

    def test_fired_payload_has_content_without_timers_list(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "fired", "timer": {"label": "Pizza"}},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_empty_list_snapshot_ignored(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "list"},
            "timers": [],
        }
        self.assertFalse(BroadcastClientApp._timer_payload_has_content(payload))

    def test_cancelled_empty_snapshot_shown(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "cancelled"},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_fired_uses_full_display_seconds(self):
        config = {"defaultDisplaySeconds": 120, "maxDisplaySeconds": 120}
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "fired"},
            "timers": [{"remainingSec": 0, "status": "OFF"}],
        }
        self.assertEqual(effective_display_seconds(payload, config), 120)

    def test_weather_interrupts_active_timer_overlay(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.display_active = True
        app.pending_displays = deque()
        app.overlay = type("Overlay", (), {"visible": True, "advance": lambda *args: None, "show": lambda *args: None})()
        app._on_display_closed = lambda: None

        called = {"advance": False}

        def advance(payload, seconds):
            called["advance"] = True
            self.assertEqual(payload["type"], "weather.query")

        app.overlay.advance = advance
        app._showing_timers = lambda: True
        app._drop_pending_timer_snapshots = lambda: None
        app._handle_timer_display = lambda payload, seconds: self.fail("timer handler should not run")

        app._enqueue_display({"type": "weather.query", "displaySeconds": 60}, 60)
        self.assertTrue(called["advance"])


if __name__ == "__main__":
    unittest.main()
