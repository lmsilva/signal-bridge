"""PSN Now Playing — dedicated panel layout + payload routing."""

from __future__ import annotations

import unittest
from unittest import mock
from unittest.mock import MagicMock

from src.psn_now_playing_panel import PsnNowPlayingPanel
from src.payload_utils import (
    is_command_payload,
    is_display_payload,
    title_for_display_type,
)
from src.config import effective_display_seconds


class PsnNowPlayingPanelTests(unittest.TestCase):
    def test_payload_types(self):
        self.assertTrue(is_display_payload({"type": "psn.now-playing"}))
        self.assertTrue(is_command_payload({"type": "psn.now-playing.close"}))
        self.assertEqual(
            title_for_display_type("psn.now-playing"),
            ("PlayStation", "Now Playing"),
        )

    def test_persistent_display_seconds(self):
        cfg = {"maxDisplaySeconds": 60, "defaultDisplaySeconds": 30}
        self.assertEqual(
            effective_display_seconds(
                {"type": "psn.now-playing", "persistent": True, "displaySeconds": 0},
                cfg,
            ),
            0,
        )

    def test_portrait_collapses_empty_bands_into_hero(self):
        panel = PsnNowPlayingPanel(MagicMock(), MagicMock(), {})
        with_all = panel._compute_portrait_boxes(
            0, 0, 1000, 1800, u=1.0, has_shots=True, has_desc=True, has_status=True,
        )
        no_extras = panel._compute_portrait_boxes(
            0, 0, 1000, 1800, u=1.0, has_shots=False, has_desc=False, has_status=False,
        )
        hero_with = with_all["hero"][3] - with_all["hero"][1]
        hero_bare = no_extras["hero"][3] - no_extras["hero"][1]
        self.assertGreater(hero_bare, hero_with)
        self.assertEqual(no_extras["status"][3], no_extras["status"][1])
        self.assertEqual(no_extras["desc"][3], no_extras["desc"][1])

    def test_enrich_pending_reserves_desc_and_shots(self):
        """Library-tour thin cards must not collapse bands while enrich spins."""
        root = MagicMock()
        shell = MagicMock()
        shell.overlay = MagicMock()
        shell.overlay.screen_w = 1080
        shell.overlay.screen_h = 1920
        shell.overlay._display_seconds = 0
        shell.chip_label_font = MagicMock()
        shell.chip_label_font.measure = MagicMock(return_value=40)
        shell.chip_value_font = MagicMock()
        shell.section_title_font = MagicMock()
        shell.section_title_font.metrics = MagicMock(return_value=32)
        shell.section_title_font.measure = MagicMock(return_value=120)
        shell.body_font = MagicMock()
        panel = PsnNowPlayingPanel(root, shell, {"textColor": "#fff", "accentColor": "#38bdf8"})
        panel.canvas = MagicMock()
        panel.canvas.create_rectangle = MagicMock(return_value=1)
        panel.canvas.create_text = MagicMock(return_value=2)
        panel.canvas.create_line = MagicMock(return_value=3)
        panel.canvas.create_image = MagicMock(return_value=5)
        panel.canvas.create_window = MagicMock(return_value=6)
        panel.canvas.create_arc = MagicMock(side_effect=range(100, 200))
        panel._item_ids = []
        panel._widgets = []
        panel._round_rect = MagicMock()
        panel._start_image_fetches = MagicMock()
        panel._schedule_elapsed_tick = MagicMock()
        panel._draw_chrome = MagicMock()
        panel._place_description_viewport = MagicMock()

        with mock.patch("src.text_marquee.tk.Canvas") as title_canvas:
            title_canvas.return_value.bbox.return_value = (0, 0, 40, 40)
            panel._render({
                "type": "psn.now-playing",
                "psn": {
                    "name": "Astro Bot",
                    "mode": "library-tour",
                    "enrichPending": True,
                    "statusLine": "In library",
                    "shortDescription": "",
                    "screenshots": [],
                    "playtimeLabel": "2.0 h",
                },
            })
        boxes = panel._layout_boxes
        self.assertGreater(boxes["desc"][3] - boxes["desc"][1], 20)
        self.assertGreater(boxes["shots"][3] - boxes["shots"][1], 20)
        panel._place_description_viewport.assert_not_called()
        self.assertGreaterEqual(panel.canvas.create_arc.call_count, 4)
        self.assertTrue(panel._enrich_spinner_arcs)

    def test_screenshot_row_sizes_to_available_count(self):
        root = MagicMock()
        shell = MagicMock()
        panel = PsnNowPlayingPanel(root, shell, {})
        panel.canvas = MagicMock()
        panel.canvas.create_image = MagicMock(side_effect=[10, 11])
        panel._item_ids = []
        panel._shot_ids = []
        panel._round_rect = MagicMock()
        panel._place_screenshot_row(
            ["https://a.jpg", "https://b.jpg"],
            0, 0, 300, 100,
        )
        self.assertEqual(len(panel._shot_ids), 2)
        self.assertEqual(panel._round_rect.call_count, 2)

    def test_footer_uses_plays_not_progress_percent(self):
        root = MagicMock()
        shell = MagicMock()
        shell.chip_label_font = MagicMock()
        shell.chip_value_font = MagicMock()
        panel = PsnNowPlayingPanel(root, shell, {"textColor": "#fff", "mutedTextColor": "#888"})
        panel.canvas = MagicMock()
        panel.canvas.create_line = MagicMock(return_value=1)
        panel.canvas.create_text = MagicMock(return_value=2)
        panel._item_ids = []
        panel._draw_footer(
            {"footer": (0, 0, 900, 100)},
            {
                "playtimeLabel": "12.5 h",
                "trophies": {"earned": 2, "total": 21, "available": True, "progress": 6},
                "progressLabel": "6%",
                "playCount": 7,
                "platform": "PS5",
            },
        )
        labels = [
            call.kwargs["text"]
            for call in panel.canvas.create_text.call_args_list
            if "text" in call.kwargs
        ]
        values = [
            call.kwargs["text"]
            for call in panel.canvas.create_text.call_args_list
            if "text" in call.kwargs
        ]
        self.assertIn("PLAYTIME", labels)
        self.assertIn("TROPHIES", labels)
        self.assertIn("PLAYS", labels)
        self.assertIn("7", values)
        self.assertNotIn("SESSIONS", labels)
        self.assertNotIn("PROGRESS", labels)
        self.assertNotIn("PLAYING NOW", labels)
        self.assertNotIn("ACHIEVEMENTS", labels)

    def test_render_uses_status_not_description_viewport(self):
        root = MagicMock()
        shell = MagicMock()
        shell.overlay = MagicMock()
        shell.overlay.screen_w = 1080
        shell.overlay.screen_h = 1920
        shell.overlay._display_seconds = 0
        shell.chip_label_font = MagicMock()
        shell.chip_label_font.measure = MagicMock(return_value=40)
        shell.chip_value_font = MagicMock()
        shell.section_title_font = MagicMock()
        shell.section_title_font.metrics = MagicMock(return_value=32)
        shell.section_title_font.measure = MagicMock(return_value=120)
        shell.body_font = MagicMock()
        panel = PsnNowPlayingPanel(root, shell, {"textColor": "#fff"})
        panel.canvas = MagicMock()
        panel.canvas.create_rectangle = MagicMock(return_value=1)
        panel.canvas.create_text = MagicMock(return_value=2)
        panel.canvas.create_line = MagicMock(return_value=3)
        panel.canvas.create_image = MagicMock(return_value=5)
        panel.canvas.create_window = MagicMock(return_value=6)
        panel._item_ids = []
        panel._widgets = []
        panel._round_rect = MagicMock()
        panel._start_image_fetches = MagicMock()
        panel._schedule_elapsed_tick = MagicMock()
        panel._clear_description_viewport = MagicMock()
        panel._draw_chrome = MagicMock()
        panel._draw_footer = MagicMock()
        panel._place_screenshot_row = MagicMock()

        with mock.patch("src.text_marquee.tk.Canvas") as title_canvas:
            title_canvas.return_value.bbox.return_value = (0, 0, 40, 40)
            panel._render({
                "type": "psn.now-playing",
                "psn": {
                    "name": "Split Fiction",
                    "platform": "PS5",
                    "tags": ["PS5"],
                    "statusLine": "Playing now · on PS5 · as Tester",
                    "mode": "playing",
                    "startedAt": "2026-07-28T12:00:00Z",
                    "screenshots": ["https://example.com/a.jpg"],
                    "trophies": {"earned": 0, "total": 21, "available": True, "progress": 0},
                    "progressLabel": "0%",
                    "playtimeLabel": "2.0 h",
                },
            })
        self.assertEqual(panel.SOURCE_CHIP, "PSN")
        self.assertEqual(panel.PAYLOAD_KEY, "psn")
        panel._clear_description_viewport.assert_called()
        # Status text should be painted (not a nested scroll viewport).
        status_texts = [
            c.kwargs.get("text")
            for c in panel.canvas.create_text.call_args_list
            if c.kwargs.get("text")
        ]
        self.assertIn("Playing now · on PS5 · as Tester", status_texts)

    def test_long_title_uses_marquee_not_main_canvas_text(self):
        """Library-tour titles like Uncharted must scroll, never clip mid-word."""
        root = MagicMock()
        shell = MagicMock()
        shell.chip_label_font = MagicMock()
        shell.chip_label_font.measure = MagicMock(return_value=40)
        shell.chip_label_font.metrics = MagicMock(return_value=14)
        shell.chip_value_font = MagicMock()
        shell.section_title_font = MagicMock()
        shell.section_title_font.metrics = MagicMock(return_value=32)
        shell.section_title_font.measure = MagicMock(return_value=1200)
        shell.body_font = MagicMock()
        panel = PsnNowPlayingPanel(root, shell, {"textColor": "#fff", "mutedTextColor": "#888"})
        panel.canvas = MagicMock()
        panel.canvas.create_window = MagicMock(return_value=9)
        panel._item_ids = []
        panel._widgets = []
        panel._round_rect = MagicMock()
        long_name = "Uncharted™: The Nathan Drake Collection"
        boxes = {
            "meta": (40, 900, 1040, 1100),
            "status": (40, 1108, 1040, 1140),
            "desc": (40, 1150, 1040, 1400),
            "tags_h": 40,
            "title_h": 104,
        }
        with mock.patch("src.text_marquee.tk.Canvas") as title_canvas:
            title_canvas.return_value.bbox.return_value = (0, 0, 40, 40)
            panel._draw_meta(boxes, {
                "name": long_name,
                "tags": ["PSN", "PS4", "Adventure"],
                "statusLine": "Last played · on PS4",
                "shortDescription": "Experience one of the most revered…",
            })
        title_on_canvas = [
            call for call in panel.canvas.create_text.call_args_list
            if long_name in str(call.kwargs.get("text", ""))
        ]
        self.assertEqual(title_on_canvas, [])
        self.assertEqual(len(panel._marquees), 1)
        self.assertEqual(panel._marquees[0]._state, "start_pause")
        panel.canvas.create_window.assert_called()


if __name__ == "__main__":
    unittest.main()
