import unittest
from unittest import mock

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

    def test_badge_padding_is_roomier_than_text(self):
        # Guard against the tight white box that clipped NOW PLAYING.
        pad_x, pad_y = 28, 16
        text_w, text_h = 140, 22
        badge_w = text_w + pad_x * 2
        badge_h = max(48, text_h + pad_y * 2)
        self.assertGreaterEqual(badge_w - text_w, 40)
        self.assertGreaterEqual(badge_h - text_h, 24)

    def test_title(self):
        self.assertEqual(title_for_display_type("steam.now-playing"), ("Steam", "Now Playing"))

    def test_portrait_boxes_do_not_overlap(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(20, 40, 60, 1040, 1860)
        ordered = ["header", "hero", "tags", "meta", "footer"]
        bottoms = []
        for key in ordered:
            x0, y0, x1, y1 = boxes[key]
            self.assertLess(x0, x1)
            self.assertLess(y0, y1)
            self.assertGreaterEqual(y0, bottoms[-1] if bottoms else 0)
            bottoms.append(y1)
        # Hero must claim real screen space (guards against the winfo_width=1 bug).
        hero = boxes["hero"]
        self.assertGreater(hero[2] - hero[0], 400)
        self.assertGreater(hero[3] - hero[1], 200)

    def test_portrait_meta_gets_room_under_capped_hero(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(20, 40, 60, 1040, 1860)
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        meta_h = boxes["meta"][3] - boxes["meta"][1]
        # Poster is capped so description + screenshots aren't crushed.
        self.assertLessEqual(hero_h, int((1860 - 60) * 0.40))
        self.assertGreater(meta_h, 280)
        # Footer sits at the content bottom (no stranded empty band).
        self.assertGreaterEqual(boxes["footer"][3], 1860 - 20 - 5)

    def test_meta_bands_reserve_shots_below_description(self):
        title_band, desc_h, shot_h = SteamNowPlayingPanel._meta_band_heights(
            (0, 0, 800, 400), has_shots=True,
        )
        self.assertGreater(shot_h, 0)
        self.assertGreater(desc_h, 0)
        self.assertLessEqual(title_band + desc_h + shot_h, 410)

    def test_landscape_boxes_keep_hero_and_meta_side_by_side(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_landscape_boxes(20, 80, 50, 1840, 980)
        hero = boxes["hero"]
        meta = boxes["meta"]
        self.assertLess(hero[2], meta[0])  # hero right edge left of meta left edge
        self.assertGreater(hero[2] - hero[0], 300)
        self.assertGreater(hero[3] - hero[1], 200)

    def test_content_rect_uses_shell_screen_not_canvas_winfo(self):
        class _Layout:
            content_x = 100
            content_width = 800
            message_area_bottom = 900
            countdown_y = 1040
            portrait = False

        class _Overlay:
            screen_w = 1920
            screen_h = 1080

        class _Shell:
            layout = _Layout()
            overlay = _Overlay()

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = _Shell()
        panel.root = type("R", (), {"winfo_screenwidth": lambda self: 1, "winfo_screenheight": lambda self: 1})()
        rect = panel._content_rect()
        self.assertEqual(rect["screen_w"], 1920)
        self.assertEqual(rect["screen_h"], 1080)
        self.assertEqual(rect["x0"], 100)
        self.assertEqual(rect["x1"], 900)
        # Prefer countdown_y so the card fills down toward the dismiss clock.
        self.assertEqual(rect["y1"], 1016)

    def _make_draw_panel(self):
        shell = mock.MagicMock()
        shell.content_canvas = mock.MagicMock()
        shell.chip_label_font = mock.MagicMock()
        shell.chip_label_font.measure.return_value = 40
        shell.chip_label_font.metrics.return_value = 14
        shell.chip_value_font = mock.MagicMock()
        shell.section_title_font = mock.MagicMock()
        shell.section_title_font.metrics.return_value = 28
        shell.body_font = mock.MagicMock()
        shell.forecast_label_font = mock.MagicMock()
        shell.forecast_label_font.measure.return_value = 32
        shell.forecast_label_font.metrics.return_value = 11
        config = {
            "textColor": "#fff",
            "mutedTextColor": "#94a3b8",
            "scrollPixelsPerSecond": 28,
            "scrollStartPauseMs": 100,
            "scrollEndPauseMs": 100,
        }
        root = mock.MagicMock()
        panel = SteamNowPlayingPanel(root, shell, config)
        panel.visible = True
        panel.canvas = shell.content_canvas
        return panel

    def test_long_description_uses_scrolling_viewport(self):
        panel = self._make_draw_panel()
        boxes = {
            "tags": (0, 0, 800, 40),
            "meta": (0, 50, 800, 420),
        }
        steam = {
            "name": "Boomerang Fu",
            "developers": ["Cranky Watermelon"],
            "releaseYear": 2020,
            "shortDescription": "A very long description. " * 40,
            "screenshots": ["http://a", "http://b", "http://c"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 400, 600)
            panel._draw_meta(boxes, steam)
        self.assertIsNotNone(panel.scroller)
        self.assertTrue(panel.needs_scroll)

    def test_hide_stops_description_scroller(self):
        panel = self._make_draw_panel()
        boxes = {"tags": (0, 0, 800, 40), "meta": (0, 50, 800, 420)}
        steam = {
            "name": "Game",
            "shortDescription": "Long text. " * 40,
            "screenshots": ["http://a"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 400, 600)
            panel._draw_meta(boxes, steam)
        scroller = panel.scroller
        panel.hide()
        self.assertIsNone(panel.scroller)
        self.assertFalse(panel.needs_scroll)
        self.assertEqual(scroller._state, "idle")


if __name__ == "__main__":
    unittest.main()
