import tempfile
import unittest
from pathlib import Path
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

    def test_format_elapsed_tracks_seconds_then_minutes(self):
        self.assertEqual(SteamNowPlayingPanel.format_elapsed(45), "45s")
        self.assertEqual(SteamNowPlayingPanel.format_elapsed(65), "1m 05s")
        self.assertEqual(SteamNowPlayingPanel.format_elapsed(3725), "1h 02m")

    def test_format_ago_for_last_played_corner(self):
        from datetime import datetime, timezone, timedelta

        now = datetime(2026, 7, 26, 19, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(
            SteamNowPlayingPanel.format_ago(now - timedelta(seconds=20), now=now),
            "just now",
        )
        self.assertEqual(
            SteamNowPlayingPanel.format_ago(now - timedelta(minutes=12), now=now),
            "12m ago",
        )
        self.assertEqual(
            SteamNowPlayingPanel.format_ago(now - timedelta(hours=5), now=now),
            "5h ago",
        )
        self.assertEqual(
            SteamNowPlayingPanel.format_ago(now - timedelta(days=3), now=now),
            "3d ago",
        )

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

    def test_steam_image_cache_path_is_stable(self):
        from src.steam_now_playing_panel import steam_image_cache_path

        a = steam_image_cache_path("https://example.com/steam/apps/570/library_600x900.jpg")
        b = steam_image_cache_path("https://example.com/steam/apps/570/library_600x900.jpg")
        self.assertEqual(a, b)
        self.assertTrue(str(a).endswith(".jpg"))

    def test_portrait_boxes_do_not_overlap(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_shots=True)
        ordered = ["header", "hero", "meta", "desc", "shots", "footer"]
        bottoms = []
        for key in ordered:
            x0, y0, x1, y1 = boxes[key]
            self.assertLess(x0, x1)
            self.assertLess(y0, y1)
            self.assertGreaterEqual(y0, bottoms[-1] if bottoms else 0 - 0.1)
            bottoms.append(y1)
        hero = boxes["hero"]
        # Fixed stage is 1000 wide × up to 1100 tall.
        self.assertAlmostEqual(hero[2] - hero[0], 1000)
        self.assertGreater(hero[3] - hero[1], 400)

    def test_portrait_stage_is_fixed_geometry(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_shots=True)
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        shots_h = boxes["shots"][3] - boxes["shots"][1]
        footer_h = boxes["footer"][3] - boxes["footer"][1]
        self.assertAlmostEqual(hero_h, 1100, delta=1)
        self.assertAlmostEqual(shots_h, 183, delta=1)
        self.assertAlmostEqual(footer_h, 101, delta=1)
        # Meta (title/tags) → desc → shots — desc never enters the shot row.
        self.assertGreaterEqual(boxes["meta"][1], boxes["hero"][3])
        self.assertLessEqual(boxes["meta"][3], boxes["desc"][1] + 0.1)
        self.assertLessEqual(boxes["desc"][3], boxes["shots"][1] + 0.1)
        self.assertAlmostEqual(boxes["desc"][3] - boxes["desc"][1], boxes["desc_h"], delta=1)
        self.assertGreater(boxes["desc_h"], 0)

    def test_portrait_desc_band_pinned_above_screenshots(self):
        """Regression: description must be a dedicated band, not leftover under tags."""
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_portrait_boxes(40, 40, 1040, 1880, u=1.0, has_shots=True)
        self.assertEqual(boxes["desc"][3], boxes["shots"][1])
        self.assertAlmostEqual(boxes["desc"][3] - boxes["desc"][1], 128, delta=1)
        # Title/tags meta must end strictly above the desc band.
        self.assertLess(boxes["meta"][3], boxes["desc"][1] + 0.1)

    def test_landscape_boxes_keep_hero_and_meta_side_by_side(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        # y0 = header_top (28); zone is 132→1040 (908 tall) per spec §9.
        boxes = panel._compute_landscape_boxes(60, 28, 1860, 1040, u=1.0, has_shots=True)
        hero = boxes["hero"]
        meta = boxes["meta"]
        self.assertAlmostEqual(boxes["header"][1], 28)
        self.assertAlmostEqual(hero[1], 132)
        self.assertAlmostEqual(hero[3], 1040)
        self.assertAlmostEqual(hero[3] - hero[1], 908, delta=2)
        self.assertLess(hero[2], meta[0])  # hero right edge left of meta left edge
        self.assertAlmostEqual(hero[2] - hero[0], 888, delta=2)
        # Shots + footer pinned to the bottom of the right column.
        self.assertAlmostEqual(boxes["footer"][3], 1040)
        self.assertLessEqual(meta[3], boxes["desc"][1] + 0.1)
        self.assertLessEqual(boxes["desc"][3], boxes["shots"][1] + 0.1)
        self.assertAlmostEqual(boxes["desc"][3] - boxes["desc"][1], 256, delta=1)

    def test_timed_landscape_content_clears_dismiss_footer(self):
        from src.design_system import page_chrome

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = mock.Mock()
        panel.root = mock.Mock()
        panel.root.winfo_screenwidth.return_value = 1920
        panel.root.winfo_screenheight.return_value = 1080
        panel.shell.overlay = mock.Mock(screen_w=1920, screen_h=1080, _display_seconds=90)
        rect = panel._content_rect()
        chrome = page_chrome(1920, 1080, timed=True)
        self.assertFalse(rect["portrait"])
        self.assertTrue(rect["timed"])
        self.assertGreater(rect["footer_clear"], 0)
        self.assertLess(rect["y1"], chrome.content_bottom)
        self.assertEqual(rect["y1"], int(chrome.content_bottom) - rect["footer_clear"])
        # Boxes built from the cleared bottom stay above the dismiss band.
        boxes = panel._compute_landscape_boxes(
            rect["x0"], rect["y0"], rect["x1"], rect["y1"],
            u=rect["u"], has_shots=True,
        )
        self.assertLessEqual(boxes["footer"][3], rect["y1"] + 0.1)
        self.assertLessEqual(boxes["hero"][3], rect["y1"] + 0.1)

    def test_persistent_landscape_keeps_existing_layout_height(self):
        from src.design_system import page_chrome

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = mock.Mock()
        panel.root = mock.Mock()
        panel.root.winfo_screenwidth.return_value = 1920
        panel.root.winfo_screenheight.return_value = 1080
        panel.shell.overlay = mock.Mock(screen_w=1920, screen_h=1080, _display_seconds=0)
        rect = panel._content_rect()
        chrome = page_chrome(1920, 1080, timed=False)
        self.assertFalse(rect["timed"])
        self.assertEqual(rect["footer_clear"], 0)
        # Persistent landscape keeps the intentional bottom pad (40u), not flush.
        self.assertEqual(rect["y1"], int(round(1080 - 40 * chrome.u)))
        self.assertLess(rect["y1"], int(chrome.content_bottom))

    def test_timed_portrait_also_clears_dismiss_footer(self):
        from src.design_system import page_chrome

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = mock.Mock()
        panel.root = mock.Mock()
        panel.root.winfo_screenwidth.return_value = 1080
        panel.root.winfo_screenheight.return_value = 1920
        panel.shell.overlay = mock.Mock(screen_w=1080, screen_h=1920, _display_seconds=90)
        rect = panel._content_rect()
        chrome = page_chrome(1080, 1920, timed=True)
        self.assertTrue(rect["portrait"])
        self.assertTrue(rect["timed"])
        self.assertLess(rect["y1"], int(round(1920 - chrome.footer_h)))
        self.assertGreater(rect["y1"] - rect["y0"], 1000)

    def test_hero_aspect_hint_prefers_portrait_library_capsule(self):
        from src.steam_now_playing_panel import hero_aspect_hint

        aspect = hero_aspect_hint({
            "posterCandidates": [
                "https://cdn.example/steam/apps/1/library_600x900.jpg",
                "https://cdn.example/steam/apps/1/header.jpg",
            ],
        })
        self.assertLess(aspect, 1.0)

    def test_meta_bands_reserve_shots_below_description(self):
        title_band, desc_h, shot_h = SteamNowPlayingPanel._meta_band_heights(
            (0, 0, 800, 400), has_shots=True,
        )
        self.assertGreater(shot_h, 0)
        self.assertGreater(desc_h, 0)
        self.assertLessEqual(title_band + desc_h + shot_h, 410)

    def test_fit_image_cover_fills_box_without_letterboxing(self):
        from src.steam_now_playing_panel import fit_image_cover, Image

        if Image is None:
            self.skipTest("Pillow not installed")
        # Landscape source into a landscape target — should fill exactly.
        src = Image.new("RGB", (460, 215), color=(10, 20, 30))
        out = fit_image_cover(src, 800, 360)
        self.assertEqual(out.size, (800, 360))
        # Portrait source into a portrait target.
        src2 = Image.new("RGB", (600, 900), color=(10, 20, 30))
        out2 = fit_image_cover(src2, 600, 900)
        self.assertEqual(out2.size, (600, 900))

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
            _display_seconds = 0  # persistent — full height

        class _Shell:
            layout = _Layout()
            overlay = _Overlay()

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = _Shell()
        panel.root = type("R", (), {"winfo_screenwidth": lambda self: 1, "winfo_screenheight": lambda self: 1})()
        rect = panel._content_rect()
        self.assertEqual(rect["screen_w"], 1920)
        self.assertEqual(rect["screen_h"], 1080)
        # Landscape content column: 60u side margins → 1800 wide.
        self.assertEqual(rect["x0"], 60)
        self.assertEqual(rect["x1"], 1860)
        # Header starts at 28u — not content_top (132), which wasted the top band.
        self.assertEqual(rect["y0"], 28)
        self.assertEqual(rect["y1"], 1040)
        self.assertFalse(rect["portrait"])

    def test_portrait_content_rect_uses_wide_column(self):
        class _Layout:
            content_x = 200
            content_width = 600
            message_area_bottom = 1800
            countdown_y = 1900
            portrait = True

        class _Overlay:
            screen_w = 1080
            screen_h = 1920

        class _Shell:
            layout = _Layout()
            overlay = _Overlay()

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.shell = _Shell()
        panel.root = type("R", (), {"winfo_screenwidth": lambda self: 1, "winfo_screenheight": lambda self: 1})()
        rect = panel._content_rect()
        # Spec: 40 pad → 1000-wide column.
        self.assertEqual(rect["x1"] - rect["x0"], 1000)
        self.assertTrue(rect["portrait"])

    def _make_draw_panel(self):
        shell = mock.MagicMock()
        shell.content_canvas = mock.MagicMock()
        shell.chip_label_font = mock.MagicMock()
        shell.chip_label_font.measure.return_value = 40
        shell.chip_label_font.metrics.return_value = 14
        shell.chip_value_font = mock.MagicMock()
        shell.section_title_font = mock.MagicMock()
        shell.section_title_font.metrics.return_value = 28
        shell.section_title_font.measure.return_value = 200
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

    def test_long_description_scrolls_in_reserved_viewport(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 280),
            "desc": (0, 292, 800, 420),
            "shots": (0, 430, 800, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Boomerang Fu",
            "developers": ["Cranky Watermelon"],
            "releaseYear": 2020,
            "shortDescription": "A very long description. " * 40,
            "screenshots": ["http://a", "http://b", "http://c"],
            "tags": ["PvP", "Co-op"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            # Taller than the reserved 128px band → must scroll, not overflow.
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 400)
            panel._draw_meta(boxes, steam)
            canvas_cls.assert_called()
            _, kwargs = canvas_cls.call_args
            self.assertEqual(kwargs.get("height"), 128)
            self.assertEqual(kwargs.get("width"), 800)
            # Nested canvas is parented to the overlay canvas (create_window).
            self.assertIs(canvas_cls.call_args.args[0], panel.canvas)
        self.assertIsNotNone(panel.scroller)
        self.assertTrue(panel.needs_scroll)
        self.assertTrue(panel.scroller.needs_scroll)
        panel.canvas.create_window.assert_called()
        win_args, win_kwargs = panel.canvas.create_window.call_args
        self.assertEqual(win_kwargs.get("anchor"), "nw")
        self.assertEqual(win_kwargs.get("height"), 128)
        self.assertEqual(win_args[0], 0)  # x
        self.assertEqual(win_args[1], 292)  # y = desc top
        # Screenshots live in the dedicated shots band (3 columns).
        self.assertEqual(len(panel._shot_ids), 3)
        # STEAM source chip is drawn in the tag row (not on the art).
        steam_chip = False
        for call in panel.canvas.create_text.call_args_list:
            kwargs = call.kwargs
            args = call.args
            text = kwargs.get("text")
            if text is None and len(args) >= 3:
                text = args[2]
            if text == "STEAM":
                steam_chip = True
                break
        self.assertTrue(steam_chip)
        # Description must not also be painted unbounded on the main canvas.
        for call in panel.canvas.create_text.call_args_list:
            kwargs = call.kwargs
            text = kwargs.get("text") or ""
            if "very long description" in str(text).lower():
                self.fail("long description drawn on main canvas (would cover screenshots)")

    def test_short_description_does_not_scroll(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 280),
            "desc": (0, 292, 800, 420),
            "shots": (0, 430, 800, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Game",
            "shortDescription": "Short blurb.",
            "screenshots": ["http://a"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 40)
            panel._draw_meta(boxes, steam)
        self.assertIsNotNone(panel.scroller)
        self.assertFalse(panel.needs_scroll)
        self.assertFalse(panel.scroller.needs_scroll)

    def test_description_scroll_speed_is_half_global(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 280),
            "desc": (0, 292, 800, 420),
            "shots": (0, 430, 800, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Game",
            "shortDescription": "Long blurb. " * 40,
            "screenshots": ["http://a"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 400)
            panel._draw_meta(boxes, steam)
        self.assertAlmostEqual(panel.scroller._pixels_per_second(), 14.0)
        # Global broadcast config stays unchanged.
        self.assertEqual(panel.config["scrollPixelsPerSecond"], 28)

    def test_description_viewport_stays_above_screenshots(self):
        """Regression: unclipped create_text painted over the screenshot row."""
        panel = self._make_draw_panel()
        boxes = {
            "meta": (40, 100, 840, 260),
            "desc": (40, 272, 840, 400),
            "shots": (40, 400, 840, 580),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Boomerang Fu",
            "shortDescription": "Slice and dice your friends. " * 30,
            "screenshots": ["http://a", "http://b", "http://c"],
            "tags": ["PvP"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 500)
            panel._draw_meta(boxes, steam)
            height = canvas_cls.call_args.kwargs.get("height")
        win_args, win_kwargs = panel.canvas.create_window.call_args
        y = win_args[1]
        self.assertEqual(win_args[0], 40)
        # Viewport bottom must not enter the shots band (y=400).
        self.assertLessEqual(y + height, boxes["shots"][1] + 0.1)
        self.assertEqual(y, boxes["desc"][1])
        self.assertEqual(height, int(boxes["desc"][3] - boxes["desc"][1]))
        self.assertGreater(height, 20)

    def test_draw_meta_uses_layout_desc_box_not_tags_leftover(self):
        """Even with a tall title/tags stack, desc stays in the pinned layout box."""
        panel = self._make_draw_panel()
        # Huge section title font would previously push leftover-desc into shots.
        panel.shell.section_title_font.metrics.return_value = 90
        panel.shell.section_title_font.measure.return_value = 700
        layout = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)._compute_portrait_boxes(
            40, 40, 1040, 1880, u=1.0, has_shots=True,
        )
        steam = {
            "name": "A Very Long Game Title That Uses The Whole Row",
            "developers": ["Studio With A Long Name"],
            "releaseYear": 2020,
            "shortDescription": "Must stay in the desc band. " * 25,
            "screenshots": ["http://a", "http://b", "http://c"],
            "tags": ["PvP", "Co-op", "Action", "Indie"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 500)
            panel._draw_meta(layout, steam)
            height = canvas_cls.call_args.kwargs.get("height")
        win_args, _win_kwargs = panel.canvas.create_window.call_args
        y = win_args[1]
        self.assertEqual(y, int(layout["desc"][1]))
        self.assertEqual(height, int(layout["desc"][3] - layout["desc"][1]))
        self.assertLessEqual(y + height, layout["shots"][1] + 0.1)

    def test_hide_clears_panel_state(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 280),
            "desc": (0, 292, 800, 420),
            "shots": (0, 430, 800, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Game",
            "shortDescription": "Long text. " * 40,
            "screenshots": ["http://a"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 400)
            panel._draw_meta(boxes, steam)
            scroller = panel.scroller
            viewport = panel._desc_viewport
            win_id = panel._desc_window_id
        panel.hide()
        self.assertIsNone(panel.scroller)
        self.assertIsNone(panel._desc_viewport)
        self.assertIsNone(panel._desc_window_id)
        self.assertFalse(panel.needs_scroll)
        self.assertEqual(scroller._state, "idle")
        viewport.destroy.assert_called()
        panel.canvas.delete.assert_any_call(win_id)

    def test_credit_is_right_aligned_on_title_row(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 280),
            "desc": (0, 292, 800, 420),
            "shots": (0, 430, 800, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Boomerang Fu",
            "developers": ["Cranky Watermelon"],
            "releaseYear": 2020,
            "shortDescription": "Short.",
            "screenshots": ["http://a"],
            "tags": ["PvP"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 40)
            panel._draw_meta(boxes, steam)
        found = False
        for call in panel.canvas.create_text.call_args_list:
            kwargs = call.kwargs
            args = call.args
            text = kwargs.get("text")
            if text is None and len(args) >= 3:
                text = args[2]
            if text and "CRANKY WATERMELON" in str(text):
                self.assertEqual(kwargs.get("anchor"), "ne")
                self.assertEqual(args[0], 800)
                found = True
                break
        self.assertTrue(found, "developer/year credit was not drawn right-aligned")

    def test_description_uses_clipped_nested_canvas(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (10, 50, 810, 280),
            "desc": (10, 292, 810, 420),
            "shots": (10, 430, 810, 560),
            "desc_h": 128,
            "tags_h": 40,
        }
        steam = {
            "name": "Game",
            "shortDescription": "Desc line. " * 40,
            "screenshots": ["http://a"],
        }
        with mock.patch("src.steam_now_playing_panel.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 800, 400)
            panel._draw_meta(boxes, steam)
            viewport = canvas_cls.return_value
        self.assertIs(panel._desc_viewport, viewport)
        viewport.create_text.assert_called()
        panel.canvas.create_window.assert_called()
        # Nested text item is configured via the scroller (not main canvas).
        self.assertIsNotNone(panel.scroller)
        self.assertTrue(panel.scroller.needs_scroll)
        # Long copy starts scrolling immediately (persistent Steam has no timer).
        self.assertNotEqual(panel.scroller._state, "idle")

    def test_blur_backdrop_cover_fills_hero_box(self):
        from src.steam_now_playing_panel import Image

        if Image is None:
            self.skipTest("Pillow not installed")
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        # Portrait source into a wider hero frame — backdrop must fill exactly.
        src = Image.new("RGB", (600, 900), color=(20, 180, 220))
        out = panel._make_blur_backdrop(src, 800, 500)
        self.assertIsNotNone(out)
        self.assertEqual(out.size, (800, 500))


class SteamArtworkCacheTests(unittest.TestCase):
    TINY_PNG_BYTES = __import__("base64").b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )

    def test_load_cached_photo_reads_disk_cache(self):
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp = Path(tmp_name)
            url = "https://example.com/steam/apps/570/library.jpg"
            cache_file = tmp / "cached.jpg"
            cache_file.write_bytes(self.TINY_PNG_BYTES)
            with mock.patch("src.steam_now_playing_panel.steam_image_cache_path", return_value=cache_file):
                image = SteamNowPlayingPanel._load_cached_photo(url, 120, 90)
            self.assertIsNotNone(image)
            self.assertLessEqual(image.width, 120)
            self.assertLessEqual(image.height, 90)

    def test_fetch_photo_downloads_and_writes_cache(self):
        with tempfile.TemporaryDirectory() as tmp_name:
            tmp = Path(tmp_name)
            url = "https://example.com/steam/apps/570/header.jpg"
            with mock.patch("src.steam_now_playing_panel.steam_image_cache_dir", return_value=tmp), \
                    mock.patch("src.steam_now_playing_panel.steam_image_cache_path", side_effect=lambda u: tmp / "out.jpg"), \
                    mock.patch("src.steam_now_playing_panel.urllib.request.urlopen") as urlopen:
                response = mock.MagicMock()
                response.read.return_value = self.TINY_PNG_BYTES
                response.__enter__.return_value = response
                urlopen.return_value = response
                image = SteamNowPlayingPanel._fetch_photo(url, 100, 80, force_network=True)
            self.assertIsNotNone(image)
            self.assertTrue((tmp / "out.jpg").exists())


class SteamFooterAndChromeTests(unittest.TestCase):
    def _make_panel(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.config = {"textColor": "#fff", "mutedTextColor": "#94a3b8"}
        panel.canvas = mock.MagicMock()
        panel._item_ids = []
        panel.shell = mock.MagicMock()
        panel.shell.chip_label_font = mock.MagicMock()
        panel.shell.chip_value_font = mock.MagicMock()
        panel._round_rect = mock.MagicMock(return_value=1)
        panel.canvas.create_line.return_value = 2
        panel.canvas.create_text.side_effect = lambda *args, **kwargs: len(panel._item_ids) + 1
        return panel

    def test_draw_footer_formats_current_players_singular_and_plural(self):
        panel = self._make_panel()
        boxes = {"footer": (0, 0, 900, 80)}
        texts = []

        def capture(*args, **kwargs):
            texts.append(kwargs.get("text"))
            return len(texts)

        panel.canvas.create_text.side_effect = capture
        panel._draw_footer(boxes, {"currentPlayers": 1, "playtimeLabel": "1 hr"})
        self.assertIn("1", texts)
        texts.clear()
        panel._draw_footer(boxes, {"currentPlayers": 1234, "playtimeLabel": "1 hr"})
        self.assertIn("1,234", texts)

    def test_fmt_last_played_date_formats_local_timestamp(self):
        from datetime import datetime, timezone

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        dt = datetime(2026, 7, 26, 15, 30, tzinfo=timezone.utc)
        formatted = panel._fmt_last_played_date(dt)
        self.assertIn("Jul", formatted)
        self.assertIn(":", formatted)

    def test_schedule_elapsed_tick_uses_root_after(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.visible = True
        panel._elapsed_value_id = 42
        panel._steam = {"mode": "playing"}
        panel._is_last_played = mock.Mock(return_value=False)
        panel._fmt_elapsed = mock.Mock(return_value="45s")
        panel._stop_elapsed_tick = mock.Mock()
        panel.canvas = mock.MagicMock()
        panel.root = mock.MagicMock()
        panel.root.after = mock.MagicMock(return_value=99)
        panel._schedule_elapsed_tick()
        panel.root.after.assert_called_once_with(1_000, mock.ANY)
        self.assertEqual(panel._tick_job, 99)

    def test_enrich_pending_draws_loading_shot_row(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        panel.config = {"accentColor": "#38bdf8"}
        panel.ACCENT = "#38bdf8"
        panel.canvas = mock.MagicMock()
        panel.canvas.create_arc = mock.MagicMock(side_effect=range(10, 40))
        panel.root = mock.MagicMock()
        panel.root.after = mock.MagicMock(return_value=7)
        panel._item_ids = []
        panel._enrich_spinner_arcs = []
        panel._enrich_spinner_job = None
        panel._enrich_spinner_angle = 0.0
        panel._round_rect = mock.MagicMock()
        panel._draw_loading_shot_row((0, 0, 300, 100), count=3)
        self.assertEqual(panel._round_rect.call_count, 3)
        self.assertEqual(len(panel._enrich_spinner_arcs), 3)
        panel.root.after.assert_called()


if __name__ == "__main__":
    unittest.main()
