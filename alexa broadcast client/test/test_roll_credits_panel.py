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
    choose_counter_grid,
    choose_image_hero,
    choose_showcase_shots,
    clip_text_to_lines,
    facts_card_layout,
    format_beaten,
    format_game_meta,
    format_month_axis_label,
    layout_boxes,
    month_axis_font_size,
    month_bar_color,
    months_chart_geom,
    next_in_label,
    title_card_layout,
    title_needs_marquee,
    tour_counter_label,
    tour_progress_layout,
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
        # Looping tours (timed=False) still reserve NEXT IN chrome.
        for width, height in ((1080, 1920), (1920, 1080)):
            boxes = layout_boxes(width, height, dashboard=True, timed=False)
            self.assertIn("progress", boxes)
            self.assertGreater(boxes["progress"][1], boxes["systems"][3] - 1)

    def test_portrait_dashboard_sections_do_not_overlap(self):
        boxes = layout_boxes(1080, 1920, dashboard=True, timed=True)
        ordered = ["hero", "counters", "months", "systems", "progress"]
        for left, right in zip(ordered, ordered[1:]):
            self.assertLessEqual(boxes[left][3], boxes[right][1] + 1, f"{left} overlaps {right}")
        # Counters need room for notes + 2×2 stats (portrait width is ~1000px).
        self.assertGreaterEqual(boxes["counters"][3] - boxes["counters"][1], 240)
        self.assertIn("progress", boxes)
        self.assertGreaterEqual(boxes["progress"][3] - boxes["progress"][1], 60)

    def test_portrait_counters_use_2x2_even_when_wide(self):
        # 1080-wide portrait content is ~1000px — the old width<900 check used 4 columns.
        self.assertEqual(choose_counter_grid(True, 4), (2, 2))
        self.assertEqual(choose_counter_grid(False, 4), (4, 1))
        boxes = layout_boxes(1080, 1920, dashboard=True, timed=False)
        self.assertGreaterEqual(boxes["counters"][2] - boxes["counters"][0], 900)
        self.assertEqual(choose_counter_grid(True, 4), (2, 2))

    def test_portrait_showcase_keeps_shot_strip(self):
        boxes = layout_boxes(1080, 1920, dashboard=False, timed=True)
        shots_h = boxes["shots"][3] - boxes["shots"][1]
        hero_h = boxes["hero"][3] - boxes["hero"][1]
        self.assertGreaterEqual(shots_h, 180)
        self.assertLess(hero_h, shots_h * 3)
        self.assertLessEqual(boxes["facts"][3], boxes["shots"][1] + 1)
        title_h = boxes["title"][3] - boxes["title"][1]
        facts_h = boxes["facts"][3] - boxes["facts"][1]
        self.assertGreaterEqual(title_h, 88)
        self.assertGreaterEqual(facts_h, 180)
        self.assertTrue(title_card_layout(title_h)["meta_fits"])
        self.assertTrue(facts_card_layout(facts_h, has_companion=True)["desc_clear_of_facts"])
        self.assertLessEqual(boxes["title"][3], boxes["facts"][1] + 1)
        self.assertLessEqual(boxes["shots"][3], boxes["progress"][1] + 1)

    def test_showcase_fits_portrait_and_landscape(self):
        self.assert_boxes_fit(1080, 1920, False)
        self.assert_boxes_fit(1920, 1080, False)

    def test_current_month_is_gold(self):
        self.assertEqual(month_bar_color(11, 12), WARN)
        self.assertEqual(month_bar_color(10, 12), ACCENT)

    def test_long_titles_request_marquee(self):
        self.assertTrue(title_needs_marquee("A very long game title that cannot fit", 180))
        self.assertFalse(title_needs_marquee("Portal", 300))

    def test_tour_chrome_matches_slideshow_language(self):
        self.assertEqual(next_in_label(12), "NEXT IN 12s")
        self.assertEqual(tour_counter_label(0, 29), "01 / 29")
        self.assertEqual(tour_counter_label(0, 29, dashboard=True), "DASHBOARD")
        rail = tour_progress_layout((40, 1700, 1040, 1770), index=0, total=12)
        self.assertTrue(rail["segmented"])
        self.assertEqual(len(rail["segments"]), 12)
        self.assertGreaterEqual(rail["rail_h"], 8)
        wide = tour_progress_layout((40, 1700, 1040, 1770), index=0, total=29)
        self.assertFalse(wide["segmented"])

    def test_facts_and_title_stay_inside_their_cards(self):
        meta = format_game_meta({
            "system": "Arcade", "induction": 3, "beatenAt": "2026-08-23",
        })
        self.assertIn("ARCADE", meta)
        self.assertIn("GAME #003", meta)
        self.assertIn("AUG 23 2026", meta)
        clipped = clip_text_to_lines(
            "No description available. 2 players Ami Friction Game Studios "
            "Coast-to-Coast Entertainment Lightgun extra copy that must not spill.",
            width_px=900, font_size=14, max_lines=3,
        )
        self.assertLessEqual(clipped.count("\n") + 1, 3)
        self.assertTrue(clipped.endswith("…") or len(clipped) < 180)
        self.assertTrue(months_chart_geom(220)["bars_clear_of_title"])

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
