"""Trivia round panel — sequencing, geometry, auto-fit and artwork caching."""

from __future__ import annotations

import unittest
from unittest.mock import MagicMock, patch

from src.config import effective_display_seconds
from src.design_system import page_chrome
from src.payload_utils import is_display_payload, title_for_display_type
from src.trivia_panel import (
    TriviaPanel,
    artwork_url_candidates,
    build_phase_plan,
    fit_text_font,
    format_trivia_sources,
    mix_hex,
    trivia_artwork_cache_path,
    wrap_text,
)


class FakeFont:
    """Measures at a fixed ratio of the point size so wrapping is deterministic."""

    CHAR_RATIO = 0.6

    def __init__(self, size=40):
        self._size = int(size)

    def configure(self, **kwargs):
        if "size" in kwargs:
            self._size = int(kwargs["size"])

    def cget(self, key):
        return self._size if key == "size" else None

    def measure(self, text):
        return int(len(str(text)) * self._size * self.CHAR_RATIO)

    def metrics(self, key):
        return int(self._size * 1.3) if key == "linespace" else 0


class FakeClock:
    """Runs `root.after` callbacks by hand so phases advance without a real Tk loop."""

    def __init__(self):
        self.now = 0.0
        self._jobs = {}
        self._next_id = 1

    def after(self, delay_ms, callback):
        job_id = self._next_id
        self._next_id += 1
        self._jobs[job_id] = (self.now + delay_ms / 1000.0, callback)
        return job_id

    def after_cancel(self, job_id):
        self._jobs.pop(job_id, None)

    def advance(self, seconds):
        target = self.now + seconds
        while True:
            due = [(t, i) for i, (t, _) in self._jobs.items() if t <= target]
            if not due:
                break
            due.sort()
            fire_at, job_id = due[0]
            self.now = fire_at
            _, callback = self._jobs.pop(job_id)
            callback()
        self.now = target


def make_round(count=3, *, boolean=False, intro=True, summary=True):
    questions = []
    for i in range(count):
        answers = ["True", "False"] if boolean else [f"Answer {i}{c}" for c in "ABCD"]
        questions.append({
            "id": f"q{i}",
            "categoryId": "science",
            "categoryLabel": "Science",
            "difficulty": "medium",
            "type": "boolean" if boolean else "multiple",
            "text": f"Question number {i}?",
            "answers": answers,
            "correctIndex": 1,
            "accent": "#8BB7FF",
            "background": "#101820",
            "artwork": {
                "portrait": "https://bridge/trivia-artwork/science-portrait.webp",
                "landscape": "https://bridge/trivia-artwork/science-landscape.webp",
            },
        })
    return {
        "questions": questions,
        "questionSeconds": 15,
        "answerSeconds": 7,
        "introSeconds": 4,
        "summarySeconds": 6,
        "showIntro": intro,
        "showSummary": summary,
        "attribution": ["Open Trivia DB (CC BY-SA 4.0)"],
    }


class TriviaRegistrationTests(unittest.TestCase):
    def test_the_round_is_a_display_payload_with_a_title(self):
        self.assertTrue(is_display_payload({"type": "trivia.round"}))
        self.assertEqual(title_for_display_type("trivia.round"), ("Signal", "Trivia"))

    def test_display_seconds_are_never_clamped_mid_round(self):
        # A 12-question round outlives maxDisplaySeconds; clamping would cut it off.
        config = {"maxDisplaySeconds": 60, "defaultDisplaySeconds": 30}
        self.assertEqual(
            effective_display_seconds(
                {"type": "trivia.round", "displaySeconds": 274}, config,
            ),
            274,
        )


class PhasePlanTests(unittest.TestCase):
    def test_the_plan_alternates_question_and_answer_between_intro_and_summary(self):
        plan = build_phase_plan(make_round(3))
        self.assertEqual(
            [entry["phase"] for entry in plan],
            ["intro", "question", "answer", "question", "answer",
             "question", "answer", "summary"],
        )
        self.assertEqual([entry["index"] for entry in plan[1:7]], [0, 0, 1, 1, 2, 2])

    def test_total_plan_time_matches_the_bridge_duration_formula(self):
        trivia = make_round(5)
        total = sum(entry["seconds"] for entry in build_phase_plan(trivia))
        self.assertEqual(total, 4 + 5 * (15 + 7) + 6)

    def test_a_single_question_round_drops_the_summary(self):
        plan = build_phase_plan(make_round(1))
        self.assertNotIn("summary", [entry["phase"] for entry in plan])

    def test_intro_and_summary_can_be_switched_off(self):
        plan = build_phase_plan(make_round(2, intro=False, summary=False))
        self.assertEqual([entry["phase"] for entry in plan],
                         ["question", "answer", "question", "answer"])

    def test_an_empty_round_plans_nothing(self):
        self.assertEqual(build_phase_plan({"questions": []}), [])
        self.assertEqual(build_phase_plan(None), [])


class GeometryTests(unittest.TestCase):
    def test_portrait_boxes_stack_without_overlapping(self):
        boxes = TriviaPanel.compute_portrait_boxes(page_chrome(1080, 1920))
        order = ["chip", "pips", "question", "options", "progress", "attribution"]
        for earlier, later in zip(order, order[1:]):
            self.assertLessEqual(
                boxes[earlier][3], boxes[later][1],
                f"{earlier} bottom must clear {later} top",
            )

    def test_portrait_boxes_stay_inside_the_content_zone(self):
        chrome = page_chrome(1080, 1920)
        boxes = TriviaPanel.compute_portrait_boxes(chrome)
        self.assertGreaterEqual(boxes["chip"][1], chrome.content_top)
        self.assertLessEqual(boxes["attribution"][3], chrome.content_bottom)

    def test_landscape_puts_the_options_in_a_second_column(self):
        chrome = page_chrome(1920, 1080)
        boxes = TriviaPanel.compute_landscape_boxes(chrome)
        # The options column starts to the right of everything on the left.
        self.assertGreaterEqual(boxes["options"][0], boxes["question"][2])
        self.assertGreaterEqual(boxes["options"][0], boxes["chip"][2])
        # And the left column still stacks cleanly.
        self.assertLessEqual(boxes["chip"][3], boxes["pips"][1])
        self.assertLessEqual(boxes["pips"][3], boxes["question"][1])
        self.assertLessEqual(boxes["question"][3], boxes["progress"][1])

    def test_landscape_question_column_is_taller_than_portrait_relative_width(self):
        # The split exists so the question keeps a large point size; the column
        # must be narrower than the full content width.
        chrome = page_chrome(1920, 1080)
        boxes = TriviaPanel.compute_landscape_boxes(chrome)
        question_w = boxes["question"][2] - boxes["question"][0]
        self.assertLess(question_w, chrome.content_w * 0.6)

    def test_four_option_tiles_split_the_box_evenly_and_never_collide(self):
        tiles = TriviaPanel.compute_option_tiles((0, 0, 1000, 800), 4, 1.0)
        self.assertEqual(len(tiles), 4)
        heights = [round(t[3] - t[1], 3) for t in tiles]
        self.assertEqual(len(set(heights)), 1)
        for upper, lower in zip(tiles, tiles[1:]):
            self.assertLess(upper[3], lower[1])
        self.assertLessEqual(tiles[-1][3], 800.0001)

    def test_true_false_gets_two_large_tiles_not_two_of_four(self):
        two = TriviaPanel.compute_option_tiles((0, 0, 1000, 800), 2, 1.0)
        four = TriviaPanel.compute_option_tiles((0, 0, 1000, 800), 4, 1.0)
        self.assertEqual(len(two), 2)
        self.assertGreater(two[0][3] - two[0][1], (four[0][3] - four[0][1]) * 1.8)


class AutoFitTests(unittest.TestCase):
    def test_a_short_question_keeps_its_full_size(self):
        font = FakeFont(72)
        fitted, lines = fit_text_font(font, "Who?", max_width=800, max_lines=4, min_size=40)
        self.assertEqual(fitted.cget("size"), 72)
        self.assertEqual(lines, ["Who?"])

    def test_a_long_question_shrinks_until_it_fits_four_lines(self):
        text = " ".join(["word"] * 60)
        font = FakeFont(72)
        fitted, lines = fit_text_font(font, text, max_width=800, max_lines=4, min_size=24)
        self.assertLess(fitted.cget("size"), 72)
        self.assertLessEqual(len(lines), 4)

    def test_beyond_the_floor_it_ellipsises_rather_than_overflowing(self):
        text = " ".join(["word"] * 500)
        font = FakeFont(72)
        fitted, lines = fit_text_font(font, text, max_width=400, max_lines=4, min_size=40)
        self.assertEqual(fitted.cget("size"), 40)
        self.assertEqual(len(lines), 4)
        self.assertTrue(lines[-1].endswith("…"))

    def test_wrapping_never_exceeds_the_measured_width(self):
        font = FakeFont(40)
        lines = wrap_text(font, " ".join(["alpha", "beta", "gamma"] * 6), 300)
        for line in lines:
            self.assertLessEqual(font.measure(line), 300)


class PhaseSequencingTests(unittest.TestCase):
    def build_panel(self, trivia):
        clock = FakeClock()
        root = MagicMock()
        root.after = clock.after
        root.after_cancel = clock.after_cancel
        panel = TriviaPanel(root, MagicMock(), {})
        panel.canvas = MagicMock()
        panel._monotonic = lambda: clock.now
        panel._paint_step = MagicMock()
        panel._draw_empty_round = MagicMock()
        panel.visible = True
        panel.show({"type": "trivia.round", "trivia": trivia})
        return panel, clock

    def phases(self, panel):
        return [call.args[0]["phase"] for call in panel._paint_step.call_args_list]

    def test_the_round_walks_every_card_in_order(self):
        panel, clock = self.build_panel(make_round(2))
        clock.advance(4 + 2 * (15 + 7) + 6 + 1)
        self.assertEqual(
            self.phases(panel),
            ["intro", "question", "answer", "question", "answer", "summary"],
        )

    def test_a_card_holds_for_its_full_duration_before_advancing(self):
        panel, clock = self.build_panel(make_round(2))
        clock.advance(3.9)
        self.assertEqual(self.phases(panel), ["intro"])
        clock.advance(0.2)
        self.assertEqual(self.phases(panel), ["intro", "question"])
        clock.advance(14.0)
        self.assertEqual(self.phases(panel), ["intro", "question"])
        clock.advance(1.0)
        self.assertEqual(self.phases(panel)[-1], "answer")

    def test_the_sequence_stops_dead_when_the_panel_is_hidden(self):
        panel, clock = self.build_panel(make_round(3))
        clock.advance(5)
        painted = len(self.phases(panel))
        panel.hide()
        clock.advance(120)
        self.assertEqual(len(self.phases(panel)), painted)

    def test_an_empty_round_shows_the_stocking_up_card_instead(self):
        panel, clock = self.build_panel({"questions": []})
        panel._draw_empty_round.assert_called_once()
        clock.advance(60)
        self.assertEqual(self.phases(panel), [])


class CountdownTests(unittest.TestCase):
    def build_panel(self, remaining, total=15):
        clock = FakeClock()
        root = MagicMock()
        root.after = clock.after
        root.after_cancel = clock.after_cancel
        panel = TriviaPanel(root, MagicMock(), {})
        panel.canvas = MagicMock()
        panel.visible = True
        panel._monotonic = lambda: clock.now
        panel._phase_seconds = total
        panel._phase_ends_at = clock.now + remaining
        panel._ring_ids = [7]
        panel._countdown_text_id = 8
        panel._ring_accent = "#8BB7FF"
        return panel

    def config_for(self, panel, item_id):
        for call in panel.canvas.itemconfigure.call_args_list:
            if call.args[0] == item_id:
                return call.kwargs
        return {}

    def test_the_arc_shrinks_in_proportion_to_the_time_left(self):
        panel = self.build_panel(remaining=7.5, total=15)
        panel._update_countdown()
        extent = abs(self.config_for(panel, 7)["extent"])
        self.assertAlmostEqual(extent, 359.9 / 2, delta=1.0)

    def test_the_numeral_counts_whole_seconds(self):
        panel = self.build_panel(remaining=9.4, total=15)
        panel._update_countdown()
        self.assertEqual(self.config_for(panel, 8)["text"], "9")

    def test_the_ring_warms_in_the_last_three_seconds(self):
        calm = self.build_panel(remaining=8, total=15)
        calm._update_countdown()
        self.assertEqual(self.config_for(calm, 7)["outline"], "#8BB7FF")
        urgent = self.build_panel(remaining=2.5, total=15)
        urgent._update_countdown()
        self.assertEqual(self.config_for(urgent, 7)["outline"], "#F5C453")


class AttributionTests(unittest.TestCase):
    def test_sources_line_drops_licence_parentheticals(self):
        self.assertEqual(
            format_trivia_sources([
                "Open Trivia DB (CC BY-SA 4.0)",
                "The Trivia API (CC BY-NC 4.0)",
            ]),
            "Sources: Open Trivia DB | The Trivia API",
        )

    def test_sources_line_keeps_short_names(self):
        self.assertEqual(
            format_trivia_sources(["Open Trivia DB", "The Trivia API"]),
            "Sources: Open Trivia DB | The Trivia API",
        )


class ArtworkTests(unittest.TestCase):
    def test_artwork_url_candidates_add_bridge_hosts(self):
        urls = artwork_url_candidates(
            "https://signal.example/trivia-artwork/a.webp",
            {"bridgeHosts": ["192.168.1.10"]},
        )
        self.assertEqual(urls[0], "https://signal.example/trivia-artwork/a.webp")
        self.assertIn("https://192.168.1.10:47810/trivia-artwork/a.webp", urls)

    def test_the_cache_path_is_stable_and_keeps_the_extension(self):
        url = "https://bridge/trivia-artwork/science-portrait.webp"
        first = trivia_artwork_cache_path(url)
        self.assertEqual(first, trivia_artwork_cache_path(url))
        self.assertEqual(first.suffix, ".webp")

    def test_different_orientations_cache_separately(self):
        portrait = trivia_artwork_cache_path("https://b/science-portrait.webp")
        landscape = trivia_artwork_cache_path("https://b/science-landscape.webp")
        self.assertNotEqual(portrait.name, landscape.name)

    def test_an_odd_url_still_produces_a_safe_filename(self):
        path = trivia_artwork_cache_path("https://b/art?id=1&x=2")
        self.assertEqual(path.suffix, ".img")
        self.assertNotIn("?", path.name)

    def test_the_gradient_fallback_blends_between_its_two_ends(self):
        self.assertEqual(mix_hex("#000000", "#FFFFFF", 0.0), "#000000")
        self.assertEqual(mix_hex("#000000", "#FFFFFF", 1.0), "#FFFFFF")
        self.assertEqual(mix_hex("#000000", "#FFFFFF", 0.5), "#808080")

    def test_artwork_is_not_refetched_between_cards_of_one_category(self):
        panel = TriviaPanel(MagicMock(), MagicMock(), {})
        panel.canvas = MagicMock()
        panel._draw_gradient_fallback = MagicMock()
        geometry = {"portrait": True, "screen_w": 1080, "screen_h": 1920, "u": 1.0}
        card = {"categoryId": "science", "artwork": {}, "accent": "#8BB7FF"}
        panel._paint_artwork(geometry, card)
        panel._artwork_id = 42
        panel._paint_artwork(geometry, card)
        self.assertEqual(panel._draw_gradient_fallback.call_count, 1)

    def test_a_new_category_repaints_the_background(self):
        panel = TriviaPanel(MagicMock(), MagicMock(), {})
        panel.canvas = MagicMock()
        panel._draw_gradient_fallback = MagicMock()
        geometry = {"portrait": True, "screen_w": 1080, "screen_h": 1920, "u": 1.0}
        panel._paint_artwork(geometry, {"categoryId": "science", "artwork": {}})
        panel._artwork_id = 42
        panel._paint_artwork(geometry, {"categoryId": "history", "artwork": {}})
        self.assertEqual(panel._draw_gradient_fallback.call_count, 2)


class StackingCanvas:
    """Enough of a Tk canvas to observe z-order: items live bottom-to-top."""

    def __init__(self):
        self.order: list[int] = []
        self.kinds: dict[int, str] = {}
        self._next = 1

    def _add(self, kind):
        item = self._next
        self._next += 1
        self.order.append(item)
        self.kinds[item] = kind
        return item

    def create_rectangle(self, *args, **kwargs):
        return self._add("rect")

    def create_image(self, *args, **kwargs):
        return self._add("image")

    def create_text(self, *args, **kwargs):
        return self._add("text")

    def delete(self, item):
        if item in self.order:
            self.order.remove(item)

    def tag_lower(self, item):
        if item in self.order:
            self.order.remove(item)
            self.order.insert(0, item)

    def tag_raise(self, item, above_this=None):
        if item not in self.order:
            return
        self.order.remove(item)
        if above_this in self.order:
            self.order.insert(self.order.index(above_this) + 1, item)
        else:
            self.order.append(item)

    def configure(self, **kwargs):
        self.bg = kwargs.get("bg", getattr(self, "bg", None))


class FakePhotoImage:
    def __init__(self, image):
        self.image = image


class ArtworkStackingTests(unittest.TestCase):
    """The artwork downloads fine but must actually end up on screen."""

    GEOMETRY = {"portrait": True, "screen_w": 1080, "screen_h": 1920, "u": 1.0}
    CARD = {
        "categoryId": "science",
        "accent": "#8BB7FF",
        "background": "#101820",
        "artwork": {"portrait": "https://bridge/trivia-artwork/science-portrait.webp"},
    }

    def panel(self):
        panel = TriviaPanel(MagicMock(), MagicMock(), {})
        panel.canvas = StackingCanvas()
        panel.visible = True
        return panel

    def paint_background(self, panel):
        """Paint the colour field + gradient without kicking off a download."""
        panel._artwork_key = self.CARD["categoryId"]
        panel._set_palette(self.CARD)
        panel._draw_colour_field(self.GEOMETRY, self.CARD)
        panel._draw_gradient_fallback(self.GEOMETRY, self.CARD)

    def test_the_artwork_replaces_the_gradient_instead_of_hiding_beneath_it(self):
        panel = self.panel()
        self.paint_background(panel)
        self.assertTrue(panel._fallback_ids)
        self.assertIsNotNone(panel._color_id)

        with patch("src.trivia_panel.ImageTk") as image_tk:
            image_tk.PhotoImage = FakePhotoImage
            panel._apply_artwork(panel._fetch_token, object())

        # Opaque gradient bands hide the image; the solid colour field stays
        # underneath as the category identity when cover-crop leaves a sliver.
        self.assertEqual(panel._fallback_ids, [])
        self.assertEqual(panel.canvas.order[0], panel._color_id)
        self.assertEqual(panel.canvas.order[1], panel._artwork_id)
        self.assertEqual(panel.canvas.kinds[panel._artwork_id], "image")
        self.assertEqual(
            [panel.canvas.kinds[i] for i in panel.canvas.order],
            ["rect", "image"],
        )

    def test_the_artwork_sits_behind_the_question_card(self):
        panel = self.panel()
        self.paint_background(panel)
        with patch("src.trivia_panel.ImageTk") as image_tk:
            image_tk.PhotoImage = FakePhotoImage
            panel._apply_artwork(panel._fetch_token, object())

        foreground = panel._track(panel.canvas.create_text())
        self.assertEqual(panel.canvas.order[0], panel._color_id)
        self.assertEqual(panel.canvas.order[1], panel._artwork_id)
        self.assertEqual(panel.canvas.order[-1], foreground)

    def test_option_tiles_follow_the_category_background_not_house_blue(self):
        panel = self.panel()
        panel._set_palette({
            "background": "#00582A",
            "accent": "#00D16C",
        })
        self.assertEqual(panel._palette["background"], "#00582A")
        self.assertEqual(panel._palette["accent"], "#00D16C")
        # Idle tile fill is a darkened category field — never the Steam navy.
        self.assertNotEqual(panel._palette["tile_fill"].upper(), "#0D1526")
        self.assertTrue(panel._palette["tile_fill"].upper().startswith("#00"))

    def test_a_stale_download_never_paints_over_the_current_category(self):
        panel = self.panel()
        self.paint_background(panel)
        with patch("src.trivia_panel.ImageTk") as image_tk:
            image_tk.PhotoImage = FakePhotoImage
            panel._apply_artwork(panel._fetch_token - 1, object())

        self.assertIsNone(panel._artwork_id)
        self.assertTrue(panel._fallback_ids)

    def test_the_gradient_survives_the_next_card_while_the_artwork_loads(self):
        panel = self.panel()
        self.paint_background(panel)
        bands = list(panel._fallback_ids)
        stray = panel._track(panel.canvas.create_text())

        panel._clear_foreground()

        self.assertEqual(panel._fallback_ids, bands)
        self.assertNotIn(stray, panel.canvas.order)
        for band in bands:
            self.assertIn(band, panel.canvas.order)

    def test_the_artwork_survives_the_next_card_of_the_same_category(self):
        panel = self.panel()
        self.paint_background(panel)
        with patch("src.trivia_panel.ImageTk") as image_tk:
            image_tk.PhotoImage = FakePhotoImage
            panel._apply_artwork(panel._fetch_token, object())
        artwork = panel._artwork_id

        panel._clear_foreground()
        panel._paint_artwork(self.GEOMETRY, self.CARD)

        self.assertEqual(panel._artwork_id, artwork)
        self.assertEqual(panel._fallback_ids, [], "no gradient once the art is up")

    def test_a_new_category_clears_every_band_of_the_old_one(self):
        panel = self.panel()
        self.paint_background(panel)
        old_bands = list(panel._fallback_ids)

        panel._drop_background()

        self.assertEqual(panel._fallback_ids, [])
        self.assertIsNone(panel._artwork_id)
        for band in old_bands:
            self.assertNotIn(band, panel.canvas.order)
            self.assertNotIn(band, panel._item_ids)

    def test_hiding_forgets_the_background_it_no_longer_owns(self):
        panel = self.panel()
        self.paint_background(panel)
        panel.hide()

        self.assertIsNone(panel._artwork_id)
        self.assertIsNone(panel._color_id)
        self.assertEqual(panel._fallback_ids, [])


if __name__ == "__main__":
    unittest.main()
