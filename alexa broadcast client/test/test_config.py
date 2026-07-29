import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from src.config import DEFAULTS, effective_display_seconds, load_config
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

    def test_empty_list_snapshot_shown(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "list"},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_accepts_started_timer_snapshot(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "started"},
            "timers": [{"remainingSec": 300, "status": "ON"}],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_photo_slideshow_bypasses_max_display_seconds(self):
        # 20 photos * 5s = 100s, well past a tight 60s maxDisplaySeconds — the
        # slideshow must not get cut off partway through.
        config = {"defaultDisplaySeconds": 60, "maxDisplaySeconds": 60}
        payload = {"type": "photo.slideshow", "displaySeconds": 100}
        self.assertEqual(effective_display_seconds(payload, config), 100)

    def test_photo_slideshow_still_has_a_floor(self):
        config = {"defaultDisplaySeconds": 60, "maxDisplaySeconds": 60}
        payload = {"type": "photo.slideshow", "displaySeconds": 0}
        self.assertEqual(effective_display_seconds(payload, config), 1)

    def test_route_planner_bypasses_max_display_seconds(self):
        config = {"defaultDisplaySeconds": 60, "maxDisplaySeconds": 60}
        payload = {"type": "route-planner.query", "displaySeconds": 240}
        self.assertEqual(effective_display_seconds(payload, config), 240)

    def test_guest_photobooth_bypasses_max_display_seconds(self):
        config = {"defaultDisplaySeconds": 60, "maxDisplaySeconds": 60}
        payload = {"type": "guest.photobooth", "displaySeconds": 180}
        self.assertEqual(effective_display_seconds(payload, config), 180)

    def test_load_config_merges_shopping_list_defaults(self):
        with tempfile.TemporaryDirectory() as tmp_name:
            path = Path(tmp_name) / "config.json"
            path.write_text(
                json.dumps({"shoppingList": {"itemsPerPage": 15}}),
                encoding="utf-8",
            )
            with mock.patch("src.config.CONFIG_PATH", path):
                config = load_config()
        self.assertEqual(config["shoppingList"]["itemsPerPage"], 15)
        self.assertEqual(
            config["shoppingList"]["pageSeconds"],
            DEFAULTS["shoppingList"]["pageSeconds"],
        )


if __name__ == "__main__":
    unittest.main()
