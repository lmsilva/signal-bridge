import io
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

try:
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is a runtime dependency
    Image = None

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import ACCENT, WARN, design_u, page_chrome, text_line_h
from src.payload_utils import resolve_display_type, title_for_payload
from src.roll_credits_panel import (
    LOOP_MAX_FRAMES,
    LOOP_MIN_DELAY_MS,
    HeroLoop,
    RollCreditsPanel,
    choose_counter_grid,
    card_media_urls,
    choose_image_hero,
    choose_showcase_shots,
    choose_still_hero,
    decode_animation,
    clip_text_to_lines,
    counters_layout,
    facts_card_layout,
    format_beaten,
    format_game_meta,
    format_month_axis_label,
    latest_layout,
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

# Tk paints points, not px — the same tile must stay clear from 96 DPI
# (1.6 px/pt) through the wall's 125% scaling and beyond.
DPI_CASES = (1.6, 2.05, 2.4)
SCREEN_CASES = ((1080, 1920), (1200, 1920), (900, 1600), (1920, 1080))


def spans_overlap(spans):
    """`spans` are (top, height) pairs — True when any two painted rows collide."""
    ordered = sorted(spans, key=lambda span: span[0])
    return any(a[0] + a[1] > b[0] + 0.5 for a, b in zip(ordered, ordered[1:]))


class RollCreditsPayloadTests(unittest.TestCase):
    def test_payload_type_and_title(self):
        payload = {"type": "roll-credits.tour", "stats": {"total": 12}}
        self.assertEqual(resolve_display_type(payload), "roll-credits.tour")
        self.assertEqual(title_for_payload(payload), ("Signal", "Roll Credits"))

    def test_a_raw_video_hero_is_never_used(self):
        # Without a rendered loop the panel has nothing it can decode.
        card = {
            "media": {
                "hero": {"kind": "video", "url": "hero.mp4"},
                "screenshots": [{"kind": "screenshot", "url": "shot.jpg"}],
            }
        }
        self.assertEqual(choose_image_hero(card)["url"], "shot.jpg")
        self.assertIsNone(choose_image_hero({"media": {"hero": {"kind": "video", "url": "x"}}}))

    def test_an_animated_video_hero_outranks_the_stills(self):
        hero = {"kind": "video", "url": "clip.preview.webp", "animated": True}
        card = {
            "media": {
                "hero": hero,
                "screenshots": [{"kind": "screenshot", "url": "shot.jpg"}],
            }
        }
        self.assertEqual(choose_image_hero(card), hero)
        # The strip still carries the screenshots alongside the loop.
        self.assertEqual([s["url"] for s in choose_showcase_shots(card)], ["shot.jpg"])

    def test_uncached_video_falls_down_to_the_poster_still(self):
        hero = {
            "kind": "video",
            "url": "clip.preview.webp",
            "thumbUrl": "clip.poster.jpg",
            "animated": True,
        }
        still = {"kind": "video", "url": "clip.poster.jpg", "animated": False}
        card = {"media": {"hero": hero, "still": still}}
        self.assertEqual(choose_image_hero(card, cached=lambda url: False)["url"], "clip.poster.jpg")
        self.assertFalse(choose_image_hero(card, cached=lambda url: False).get("animated"))
        self.assertEqual(choose_image_hero(card, cached=lambda url: url == hero["url"]), hero)

    def test_uncached_video_without_still_uses_the_thumb_then_a_screenshot(self):
        hero = {
            "kind": "video",
            "url": "clip.preview.webp",
            "thumbUrl": "clip.poster.jpg",
            "animated": True,
        }
        self.assertEqual(
            choose_image_hero({"media": {"hero": hero}}, cached=lambda url: False)["url"],
            "clip.poster.jpg",
        )
        bare = {"kind": "video", "url": "clip.preview.webp", "animated": True}
        card = {
            "media": {
                "hero": bare,
                "screenshots": [{"kind": "screenshot", "url": "shot.jpg"}],
            }
        }
        self.assertEqual(choose_image_hero(card, cached=lambda url: False)["url"], "shot.jpg")

    def test_card_media_urls_puts_stills_ahead_of_the_loop(self):
        urls = card_media_urls({
            "media": {
                "hero": {
                    "url": "clip.preview.webp",
                    "thumbUrl": "clip.poster.jpg",
                    "animated": True,
                },
                "still": {"url": "clip.poster.jpg"},
                "screenshots": [{"url": "shot.jpg"}],
            }
        })
        self.assertEqual(urls, ["clip.poster.jpg", "shot.jpg", "clip.preview.webp"])
        self.assertEqual(choose_still_hero({"media": {"still": {"url": "poster.jpg"}}})["url"], "poster.jpg")

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


def make_animation(frame_count, duration_ms=100, size=(8, 6)):
    """An in-memory animated WebP with distinguishable frames."""
    frames = [
        Image.new("RGB", size, (index * 8 % 256, 20, 40))
        for index in range(frame_count)
    ]
    buffer = io.BytesIO()
    frames[0].save(
        buffer, format="WEBP", save_all=True, append_images=frames[1:],
        duration=duration_ms, loop=0,
    )
    buffer.seek(0)
    return buffer


@unittest.skipIf(Image is None, "Pillow is required to build the fixture animation")
class RollCreditsAnimatedHeroTests(unittest.TestCase):
    def test_animation_decodes_to_frames_and_a_delay(self):
        frames, delay = decode_animation(make_animation(6, duration_ms=120))
        self.assertEqual(len(frames), 6)
        self.assertEqual(delay, 120)
        self.assertEqual(frames[0].mode, "RGB")

    def test_long_animations_are_not_preloaded(self):
        # Longer than the RAM budget is seeked, not sampled down to a slideshow.
        frames, delay = decode_animation(make_animation(30, duration_ms=42), max_frames=24)
        self.assertEqual(frames, [])
        self.assertEqual(delay, 0)

    def test_a_24fps_clip_is_not_sampled(self):
        frames, delay = decode_animation(make_animation(120, duration_ms=42))
        self.assertEqual(len(frames), 120)
        self.assertEqual(delay, 42)

    def test_a_still_image_yields_no_loop(self):
        buffer = io.BytesIO()
        Image.new("RGB", (8, 6), (10, 20, 30)).save(buffer, format="WEBP")
        buffer.seek(0)
        self.assertEqual(decode_animation(buffer), ([], 0))
        self.assertEqual(decode_animation(io.BytesIO(b"not an image")), ([], 0))

    def test_delay_never_drops_below_the_floor(self):
        _, delay = decode_animation(make_animation(4, duration_ms=1))
        self.assertGreaterEqual(delay, LOOP_MIN_DELAY_MS)


class HeroLoopTests(unittest.TestCase):
    def setUp(self):
        self.root = MagicMock()
        self.canvas = MagicMock()
        self.jobs = []
        self.root.after.side_effect = lambda delay, fn: self.jobs.append((delay, fn)) or len(self.jobs)

    def run_ticks(self, count):
        for _ in range(count):
            self.assertTrue(self.jobs, "loop stopped scheduling early")
            _, callback = self.jobs.pop()
            callback()

    def test_the_loop_advances_and_wraps_around(self):
        loop = HeroLoop(self.root)
        loop.start(self.canvas, "hero", ["a", "b", "c"], 100)
        self.run_ticks(4)
        shown = [call.kwargs["image"] for call in self.canvas.itemconfigure.call_args_list]
        self.assertEqual(shown, ["b", "c", "a", "b"])

    def test_a_single_frame_never_schedules(self):
        loop = HeroLoop(self.root)
        loop.start(self.canvas, "hero", ["only"], 100)
        self.assertEqual(self.jobs, [])
        loop.start(self.canvas, None, ["a", "b"], 100)
        self.assertEqual(self.jobs, [])

    def test_stopping_cancels_the_pending_frame(self):
        loop = HeroLoop(self.root)
        loop.start(self.canvas, "hero", ["a", "b"], 100)
        loop.stop()
        self.root.after_cancel.assert_called_once()
        # A stopped loop must not repaint even if a stale callback fires.
        self.canvas.itemconfigure.reset_mock()
        self.jobs.pop()[1]()
        self.canvas.itemconfigure.assert_not_called()

    def test_the_delay_floor_is_enforced_at_playback(self):
        loop = HeroLoop(self.root)
        loop.start(self.canvas, "hero", ["a", "b"], 5)
        self.assertEqual(self.jobs[0][0], LOOP_MIN_DELAY_MS)


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
        self.assertGreaterEqual(boxes["counters"][3] - boxes["counters"][1], 270)
        self.assertIn("progress", boxes)
        self.assertGreaterEqual(boxes["progress"][3] - boxes["progress"][1], 60)

    def test_dashboard_text_never_overlaps_at_any_display_scaling(self):
        """The counters grid used to be painted straight over the notes band and
        the hero copy ran past its card once Windows scaling inflated the type."""
        for screen in SCREEN_CASES:
            u = design_u(*screen)
            portrait = screen[1] > screen[0]
            boxes = layout_boxes(*screen, dashboard=True, timed=True)
            for ppp in DPI_CASES:
                where = f"{screen} @ {ppp}px/pt"
                hero = boxes["hero"]
                notes = 0 if portrait else 3
                latest = latest_layout(
                    hero[2] - hero[0], hero[3] - hero[1],
                    note_count=notes, u=u, px_per_pt=ppp,
                )
                self.assertTrue(latest["fits"], f"hero copy overflows — {where}")
                self.assertFalse(spans_overlap(
                    [(y, latest["h"][key]) for key, y in latest["y"].items()]
                ), f"hero rows collide — {where}")
                self.assertGreater(latest["text_x"], latest["art"][2], f"copy on art — {where}")

                counters_h = boxes["counters"][3] - boxes["counters"][1]
                counters = counters_layout(
                    counters_h, note_count=3 if portrait else 0, value_count=4,
                    portrait=portrait, u=u, px_per_pt=ppp,
                )
                self.assertTrue(counters["fits"], f"counters overflow — {where}")
                self.assertTrue(counters["grid_clear_of_notes"], f"grid on notes — {where}")
                cell_spans = []
                for cell in counters["cells"]:
                    cell_spans.append((cell["value_y"], cell["value_h"]))
                    cell_spans.append((cell["label_y"], cell["label_h"]))
                note_spans = [
                    (y, counters["note_h"][key]) for key, y in counters["notes"].items()
                ]
                self.assertFalse(
                    spans_overlap(note_spans + cell_spans), f"counter rows collide — {where}",
                )

                months = months_chart_geom(
                    boxes["months"][3] - boxes["months"][1], u=u, px_per_pt=ppp,
                )
                self.assertTrue(months["fits"], f"month axis clipped — {where}")
                self.assertTrue(months["bars_clear_of_title"], f"bars on title — {where}")

                chrome = tour_progress_layout(
                    boxes["progress"], index=0, total=12, u=u, px_per_pt=ppp,
                )
                self.assertTrue(chrome["fits"], f"tour rail clipped — {where}")

    def test_showcase_text_never_overlaps_at_any_display_scaling(self):
        for screen in SCREEN_CASES:
            u = design_u(*screen)
            boxes = layout_boxes(*screen, dashboard=False, timed=True)
            for ppp in DPI_CASES:
                where = f"{screen} @ {ppp}px/pt"
                title = title_card_layout(
                    boxes["title"][3] - boxes["title"][1], u=u, px_per_pt=ppp,
                )
                self.assertTrue(title["fits"], f"title card overflows — {where}")
                self.assertFalse(spans_overlap([
                    (title["title_y"], title["title_h"]),
                    (title["meta_y"], title["meta_h"]),
                ]), f"title over meta — {where}")

                facts = facts_card_layout(
                    boxes["facts"][3] - boxes["facts"][1],
                    has_companion=True, u=u, px_per_pt=ppp,
                )
                self.assertTrue(facts["fits"], f"facts card overflows — {where}")
                self.assertTrue(facts["desc_clear_of_facts"], f"blurb on facts — {where}")
                self.assertFalse(spans_overlap([
                    (facts["companion_y"], facts["companion_h"]),
                    (facts["desc_top"], facts["desc_lines"] * facts["desc_line_h"]),
                    (facts["facts_y"], facts["facts_h"]),
                ]), f"facts rows collide — {where}")

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
        self.assertGreaterEqual(title_h, 112)
        self.assertGreaterEqual(facts_h, 180)
        self.assertTrue(title_card_layout(title_h)["meta_fits"])
        self.assertTrue(facts_card_layout(facts_h, has_companion=True)["desc_clear_of_facts"])
        self.assertLessEqual(boxes["title"][3], boxes["facts"][1] + 1)
        self.assertLessEqual(boxes["shots"][3], boxes["progress"][1] + 1)

    def test_showcase_without_shots_reinvests_the_strip(self):
        """A game with no screenshots used to stretch the blurb card into a
        mostly-empty rectangle. Portrait grows the art, landscape centres."""
        for screen in ((1080, 1920), (1920, 1080)):
            with_shots = layout_boxes(*screen, dashboard=False, timed=True)
            bare = layout_boxes(*screen, dashboard=False, timed=True, shots=False)
            self.assertNotIn("shots", bare)
            band_bottom = with_shots["shots"][3]
            facts_h = bare["facts"][3] - bare["facts"][1]
            # The blurb keeps a modest lift, never the whole strip.
            self.assertLess(
                facts_h, (with_shots["facts"][3] - with_shots["facts"][1]) + 130,
                f"blurb card ballooned — {screen}",
            )
            self.assertLessEqual(bare["facts"][3], band_bottom + 1)
            self.assertLessEqual(bare["title"][3], bare["facts"][1] + 1)
            if screen[1] > screen[0]:
                self.assertGreater(
                    bare["hero"][3] - bare["hero"][1],
                    with_shots["hero"][3] - with_shots["hero"][1] + 200,
                    "portrait art should absorb the strip",
                )
                self.assertLessEqual(bare["hero"][3], bare["title"][1] + 1)
            else:
                # Copy block sits centred against the full-height still.
                head = bare["title"][1] - with_shots["title"][1]
                tail = band_bottom - bare["facts"][3]
                self.assertLess(abs(head - tail), 4, "copy block is not centred")

    def test_wide_hero_moves_the_induction_number_to_a_plate(self):
        wide = latest_layout(1000, 340, note_count=0, game_row=False)
        tall = latest_layout(380, 1400, note_count=3)
        self.assertNotIn("game", wide["y"])
        self.assertIn("game", tall["y"])
        self.assertTrue(wide["fits"])

    def test_showcase_fits_portrait_and_landscape(self):
        self.assert_boxes_fit(1080, 1920, False)
        self.assert_boxes_fit(1920, 1080, False)

    def test_current_month_is_gold(self):
        self.assertEqual(month_bar_color(11, 12), WARN)
        self.assertEqual(month_bar_color(10, 12), ACCENT)

    def test_long_titles_request_marquee(self):
        self.assertTrue(title_needs_marquee("A very long game title that cannot fit", 180))
        self.assertFalse(title_needs_marquee("Portal", 300))
        # A measured font wins over the estimate — wide type marquees sooner.
        wide = lambda text: len(text) * 60  # noqa: E731
        self.assertTrue(title_needs_marquee("Portal", 300, measure=wide))
        self.assertFalse(title_needs_marquee("Portal", 300, measure=lambda text: 40))

    def test_tour_chrome_matches_slideshow_language(self):
        self.assertEqual(next_in_label(12), "NEXT IN 12s")
        self.assertEqual(tour_counter_label(0, 29), "01 / 29")
        self.assertEqual(tour_counter_label(0, 29, dashboard=True), "DASHBOARD")
        rail = tour_progress_layout((40, 1700, 1040, 1770), index=0, total=12)
        self.assertTrue(rail["segmented"])
        self.assertEqual(len(rail["segments"]), 12)
        self.assertGreaterEqual(rail["rail_h"], 6)
        self.assertTrue(rail["fits"])
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

    def test_playlist_apply_warms_cards_during_dashboard(self):
        # Card JSON + media files may download during the stats page; painting
        # a showcase over it is still `_store_card`'s job to refuse.
        panel = RollCreditsPanel.__new__(RollCreditsPanel)
        panel._token = 7
        panel._phase = "dashboard"
        panel.visible = True
        panel._games = []
        panel._index = 0
        panel.warmed = None
        panel._warm_ahead = lambda index, count=3: setattr(panel, "warmed", index)

        RollCreditsPanel._apply_playlist(panel, 7, [{"id": "a"}, {"id": "b"}])
        self.assertEqual([game["id"] for game in panel._games], ["a", "b"])
        self.assertEqual(panel.warmed, 0)

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
