import sys
import unittest
from pathlib import Path

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import ACCENT, WARN, page_chrome
from src.payload_utils import resolve_display_type, title_for_payload
from src.roll_credits_panel import (
    RollCreditsPanel,
    choose_image_hero,
    choose_showcase_shots,
    format_beaten,
    format_month_axis_label,
    layout_boxes,
    month_axis_font_size,
    month_bar_color,
    title_needs_marquee,
)


class RollCreditsPayloadTests(unittest.TestCase):
    def test_payload_type_and_title(self):
        payload = {"type": "roll-credits.tour", "stats": {"total": 12}}
        self.assertEqual(resolve_display_type(payload), "roll-credits.tour")
        self.assertEqual(title_for_payload(payload), ("Signal", "Roll Credits"))

    def test_video_is_never_the_phase_one_hero(self):
        card = {
            "media": {
                "hero": {"kind": "video", "url": "hero.mp4"},
                "screenshots": [{"kind": "screenshot", "url": "shot.jpg"}],
            }
        }
        self.assertEqual(choose_image_hero(card)["url"], "shot.jpg")
        self.assertIsNone(choose_image_hero({"media": {"hero": {"kind": "video", "url": "x"}}}))

    def test_cover_hero_keeps_screenshots_for_strip(self):
        card = {
            "media": {
                "hero": {"id": "c1", "kind": "cover", "url": "cover.jpg"},
                "screenshots": [
                    {"id": "s1", "kind": "screenshot", "url": "shot1.jpg"},
                    {"id": "s2", "kind": "screenshot", "url": "shot2.jpg"},
                ],
            }
        }
        self.assertEqual(choose_image_hero(card)["kind"], "cover")
        shots = choose_showcase_shots(card)
        self.assertEqual([s["url"] for s in shots], ["shot1.jpg", "shot2.jpg"])

    def test_cover_fallthrough_and_date_format(self):
        cover = {"kind": "cover", "url": "cover.jpg"}
        self.assertEqual(choose_image_hero({"media": {"hero": cover}}), cover)
        self.assertEqual(format_beaten("2026-08-14"), "BEATEN AUG 14 2026")
        self.assertEqual(format_beaten(None), "DATE UNKNOWN")


class RollCreditsLayoutTests(unittest.TestCase):
    def assert_boxes_fit(self, width, height, dashboard):
        chrome = page_chrome(width, height, timed=True)
        boxes = layout_boxes(width, height, dashboard=dashboard, timed=True)
        for name, (x0, y0, x1, y1) in boxes.items():
            self.assertGreaterEqual(x0, chrome.content_x, name)
            self.assertGreaterEqual(y0, chrome.content_top, name)
            self.assertLessEqual(x1, chrome.content_x + chrome.content_w + 1, name)
            self.assertLessEqual(y1, chrome.content_bottom + 1, name)
            self.assertGreater(x1, x0, name)
            self.assertGreater(y1, y0, name)

    def test_dashboard_fits_portrait_and_landscape(self):
        self.assert_boxes_fit(1080, 1920, True)
        self.assert_boxes_fit(1920, 1080, True)

    def test_portrait_dashboard_sections_do_not_overlap(self):
        boxes = layout_boxes(1080, 1920, dashboard=True, timed=True)
        ordered = ["hero", "counters", "months", "systems"]
        for left, right in zip(ordered, ordered[1:]):
            self.assertLessEqual(boxes[left][3], boxes[right][1] + 1, f"{left} overlaps {right}")
        # Counters need room for notes + 2×2 stats.
        self.assertGreaterEqual(boxes["counters"][3] - boxes["counters"][1], 180)

    def test_portrait_showcase_keeps_shot_strip(self):
        boxes = layout_boxes(1080, 1920, dashboard=False, timed=True)
        shots_h = boxes["shots"][3] - boxes["shots"][1]
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        self.assertGreaterEqual(shots_h, 180)
        self.assertLess(hero_h, shots_h * 3)
        self.assertLessEqual(boxes["facts"][3], boxes["shots"][1] + 1)

    def test_showcase_fits_portrait_and_landscape(self):
        self.assert_boxes_fit(1080, 1920, False)
        self.assert_boxes_fit(1920, 1080, False)

    def test_current_month_is_gold(self):
        self.assertEqual(month_bar_color(11, 12), WARN)
        self.assertEqual(month_bar_color(10, 12), ACCENT)

    def test_long_titles_request_marquee(self):
        self.assertTrue(title_needs_marquee("A very long game title that cannot fit", 180))
        self.assertFalse(title_needs_marquee("Portal", 300))

    def test_month_axis_uses_three_letter_labels(self):
        self.assertEqual(format_month_axis_label("Aug"), "AUG")
        self.assertEqual(format_month_axis_label("January"), "JAN")
        self.assertEqual(format_month_axis_label("Jun"), "JUN")
        self.assertEqual(format_month_axis_label("Jul"), "JUL")
        self.assertEqual(format_month_axis_label("", "2026-02"), "FEB")
        self.assertNotEqual(format_month_axis_label("Jun"), "J")
        self.assertGreaterEqual(month_axis_font_size(60), 11)
        self.assertLessEqual(month_axis_font_size(36), 9)


class RollCreditsPhaseTests(unittest.TestCase):
    def test_prefetch_does_not_overwrite_dashboard(self):
        panel = RollCreditsPanel.__new__(RollCreditsPanel)
        panel._token = 1
        panel._phase = "dashboard"
        panel.visible = True
        panel._games = [{"id": "g1"}]
        panel._index = 0
        panel._cards = {}
        panel._prefetching = {"g1"}
        panel.drawn = None
        panel._draw_showcase = lambda card: setattr(panel, "drawn", card)

        RollCreditsPanel._store_card(panel, 1, "g1", {"id": "g1", "title": "A"})
        self.assertIsNone(panel.drawn)
        self.assertEqual(panel._cards["g1"]["title"], "A")

        panel._phase = "showcase"
        RollCreditsPanel._store_card(panel, 1, "g1", {"id": "g1", "title": "B"})
        self.assertEqual(panel.drawn["title"], "B")

    def test_playlist_apply_does_not_prefetch_during_dashboard(self):
        panel = RollCreditsPanel.__new__(RollCreditsPanel)
        panel._token = 7
        panel._phase = "dashboard"
        panel.visible = True
        panel._games = []
        panel._index = 0
        panel.prefetched = False
        panel._prefetch = lambda index: setattr(panel, "prefetched", True)

        RollCreditsPanel._apply_playlist(panel, 7, [{"id": "a"}, {"id": "b"}])
        self.assertEqual([game["id"] for game in panel._games], ["a", "b"])
        self.assertFalse(panel.prefetched)

        panel._phase = "showcase"
        RollCreditsPanel._apply_playlist(panel, 7, [{"id": "c"}])
        self.assertTrue(panel.prefetched)

    def test_start_games_waits_out_dashboard_deadline(self):
        import time

        panel = RollCreditsPanel.__new__(RollCreditsPanel)
        panel.visible = True
        panel._phase = "dashboard"
        panel._dashboard_until = time.monotonic() + 12
        panel._games = [{"id": "g1"}]
        panel._job = None
        panel.scheduled = None
        panel._schedule = lambda seconds, callback: setattr(
            panel, "scheduled", (round(seconds, 1), callback.__name__),
        )
        panel._show_game = lambda: setattr(panel, "started", True)

        RollCreditsPanel._start_games(panel)
        self.assertEqual(panel.scheduled[1], "_start_games")
        self.assertGreaterEqual(panel.scheduled[0], 10)
        self.assertFalse(hasattr(panel, "started"))


if __name__ == "__main__":
    unittest.main()
