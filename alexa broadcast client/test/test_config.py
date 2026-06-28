import unittest

from src.config import effective_display_seconds
from src.main import BroadcastClientApp


class ConfigTests(unittest.TestCase):
    def test_fired_timer_uses_full_display_seconds(self):
        config = {"defaultDisplaySeconds": 120, "maxDisplaySeconds": 120}
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "fired"},
            "timers": [{"remainingSec": 0, "status": "OFF"}],
        }
        self.assertEqual(effective_display_seconds(payload, config), 120)

    def test_active_timer_list_uses_full_display_seconds(self):
        config = {"defaultDisplaySeconds": 120, "maxDisplaySeconds": 120}
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "started"},
            "timers": [{"remainingSec": 45, "status": "ON"}],
        }
        self.assertEqual(effective_display_seconds(payload, config), 120)

    def test_ignores_empty_timer_snapshot(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "list"},
            "timers": [],
        }
        self.assertFalse(BroadcastClientApp._timer_payload_has_content(payload))

    def test_accepts_started_timer_snapshot(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "started"},
            "timers": [{"remainingSec": 300, "status": "ON"}],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))


if __name__ == "__main__":
    unittest.main()
