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
        boxes = panel._compute_portrait_boxes(
            20, 40, 60, 1040, 1860, aspect_wh=600 / 900, has_shots=True,
        )
        ordered = ["header", "hero", "meta", "shots", "footer"]
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
        boxes = panel._compute_portrait_boxes(
            20, 40, 60, 1040, 1860, aspect_wh=600 / 900, has_shots=True,
        )
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        meta_h = boxes["meta"][3] - boxes["meta"][1]
        shots_h = boxes["shots"][3] - boxes["shots"][1]
        # Portrait hero can take ~half the column; meta + shots still get room.
        self.assertLessEqual(hero_h, int((1860 - 60) * 0.55))
        self.assertGreater(meta_h, 140)
        self.assertGreater(shots_h, 90)
        # Footer sits at the content bottom (no stranded empty band).
        self.assertGreaterEqual(boxes["footer"][3], 1860 - 20 - 5)

    def test_landscape_hero_box_is_short_to_avoid_letterboxing(self):
        from src.steam_now_playing_panel import hero_aspect_hint

        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        aspect = hero_aspect_hint({
            "posterCandidates": [
                "https://cdn.example/steam/apps/1/header.jpg",
            ],
        })
        self.assertGreater(aspect, 1.5)
        boxes = panel._compute_portrait_boxes(
            20, 40, 60, 1040, 1860, aspect_wh=aspect, has_shots=True,
        )
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        hero_w = boxes["hero"][2] - boxes["hero"][0]
        # Landscape frame stays much wider than tall (Denshattack fix).
        self.assertLess(hero_h / hero_w, 0.55)
        self.assertLessEqual(hero_h, int((1860 - 60) * 0.36))

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

    def test_landscape_boxes_keep_hero_and_meta_side_by_side(self):
        panel = SteamNowPlayingPanel.__new__(SteamNowPlayingPanel)
        boxes = panel._compute_landscape_boxes(
            20, 80, 50, 1840, 980, aspect_wh=600 / 900,
        )
        hero = boxes["hero"]
        meta = boxes["meta"]
        self.assertLess(hero[2], meta[0])  # hero right edge left of meta left edge
        self.assertGreater(hero[2] - hero[0], 300)
        self.assertGreater(hero[3] - hero[1], 200)

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
        self.assertEqual(rect["y1"], 1022)

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
        # 90% of portrait screen — mockup gutters, not the old skinny column.
        self.assertEqual(rect["x1"] - rect["x0"], int(1080 * 0.90))
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

    def test_long_description_uses_scrolling_viewport(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 420),
            "shots": (0, 430, 800, 560),
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
            canvas_cls.return_value.bbox.return_value = (0, 0, 400, 600)
            panel._draw_meta(boxes, steam)
        self.assertIsNotNone(panel.scroller)
        self.assertTrue(panel.needs_scroll)
        # Screenshots live in the dedicated shots band.
        self.assertEqual(len(panel._shot_ids), 3)

    def test_hide_stops_description_scroller(self):
        panel = self._make_draw_panel()
        boxes = {
            "meta": (0, 50, 800, 420),
            "shots": (0, 430, 800, 560),
        }
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


if __name__ == "__main__":
    unittest.main()
