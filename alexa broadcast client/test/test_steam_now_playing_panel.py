import unittest

from src.config import effective_display_seconds
from src.payload_utils import (
    COMMAND_TYPES,
    DISPLAY_TYPES,
    is_command_payload,
    is_display_payload,
    title_for_display_type,
)
from src.steam_now_playing_panel import SteamNowPlayingPanel


class SteamNowPlayingClientTests(unittest.TestCase):
    def test_type_is_display_and_close_is_command(self):
        self.assertIn("steam.now-playing", DISPLAY_TYPES)
        self.assertIn("steam.now-playing.close", COMMAND_TYPES)
        self.assertTrue(is_display_payload({"type": "steam.now-playing"}))
        self.assertTrue(is_command_payload({"type": "steam.now-playing.close"}))

    def test_persistent_display_seconds_is_zero(self):
        seconds = effective_display_seconds(
            {"type": "steam.now-playing", "displaySeconds": 0, "persistent": True},
            {"defaultDisplaySeconds": 120, "maxDisplaySeconds": 180},
        )
        self.assertEqual(seconds, 0)

    def test_dismissible_last_played_uses_display_seconds(self):
        seconds = effective_display_seconds(
            {
                "type": "steam.now-playing",
                "displaySeconds": 90,
                "persistent": False,
                "steam": {"mode": "last-played"},
            },
            {"defaultDisplaySeconds": 120, "maxDisplaySeconds": 180},
        )
        self.assertEqual(seconds, 90)

    def test_last_played_chrome_flags(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel._steam = {"mode": "last-played", "playtimeLabel": "12 hrs"}
        self.assertTrue(panel._is_last_played())
        panel._steam = {"mode": "playing"}
        self.assertFalse(panel._is_last_played())

    def test_title(self):
        self.assertEqual(title_for_display_type("steam.now-playing"), ("Steam", "Now Playing"))

    def test_portrait_boxes_do_not_overlap(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(20, 1080, 1920)
        ordered = ["header", "hero", "tags", "meta", "footer"]
        bottoms = []
        for key in ordered:
            x0, y0, x1, y1 = boxes[key]
            self.assertLess(x0, x1)
            self.assertLess(y0, y1)
            self.assertGreaterEqual(y0, bottoms[-1] if bottoms else 0)
            bottoms.append(y1)

    def test_landscape_boxes_keep_hero_and_meta_side_by_side(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_landscape_boxes(20, 1920, 1080)
        hero = boxes["hero"]
        meta = boxes["meta"]
        self.assertLess(hero[2], meta[0])  # hero right edge left of meta left edge


if __name__ == "__main__":
    unittest.main()
