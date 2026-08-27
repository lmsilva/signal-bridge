"""Huupe overlay: score formatting, zone ordering, and the live-update contract.

The session page is repainted on every made shot, so the interesting behaviour
is not what a single render looks like — it is which repaints the panel agrees
to do. A late packet must not roll the score backwards, an identical one must
not cause a flicker, and a new session must force a full teardown.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.huupe_panel import (
    HuupePanel,
    clip,
    court_regions,
    format_score,
    heat_color,
    hot_zone,
    layout_huupe_dashboard,
    layout_huupe_session,
    stack_boxes,
    zone_rows,
)


def cards(boxes):
    """Just the painted card rectangles, without chrome or flags."""
    return {
        name: box for name, box in boxes.items()
        if isinstance(box, tuple) and len(box) == 4
    }


def make_panel(screen=(1080, 1920)):
    root = MagicMock()
    shell = MagicMock()
    shell.screen_w, shell.screen_h = screen
    shell.content_canvas = MagicMock()
    panel = HuupePanel(root, shell, {})
    panel._render_session = MagicMock()
    panel._render_dashboard = MagicMock()
    return panel


def session_payload(*, revision=1, session_id="s-1", made=5, status="live"):
    return {
        "type": "huupe.session",
        "persistent": status != "finished",
        "session": {
            "sessionId": session_id,
            "revision": revision,
            "status": status,
            "mode": "justhuupe",
            "stats": {"made": made, "attempts": 12},
        },
    }


class FormattingTests(unittest.TestCase):
    def test_whole_scores_lose_the_decimal_point(self):
        self.assertEqual(format_score(12), "12")
        self.assertEqual(format_score(12.0), "12")
        self.assertEqual(format_score("8"), "8")

    def test_layup_tenths_survive(self):
        """Family Mode pays 0.1 for a layup, so 17.1 must not read as 17."""
        self.assertEqual(format_score(17.1), "17.1")
        self.assertEqual(format_score(0.1), "0.1")

    def test_missing_scores_read_as_zero(self):
        self.assertEqual(format_score(None), "0")
        self.assertEqual(format_score("not a number"), "0")

    def test_clip_keeps_short_names_untouched(self):
        self.assertEqual(clip("war d", 14), "war d")

    def test_clip_marks_names_it_shortened(self):
        self.assertEqual(clip("lundisupcorporation", 10), "lundisupc…")


class ZoneRowTests(unittest.TestCase):
    def test_all_four_zones_appear_in_a_fixed_order(self):
        rows = zone_rows([{"zone": "three", "made": 2, "attempts": 9, "pct": 22}])
        self.assertEqual([row["zone"] for row in rows], ["layup", "one", "two", "three"])

    def test_zones_the_hoop_never_reported_come_back_empty(self):
        rows = zone_rows([])
        self.assertTrue(all(row["attempts"] == 0 and row["made"] == 0 for row in rows))

    def test_reported_counts_are_carried_through(self):
        rows = zone_rows([{"zone": "one", "label": "Close", "made": 4, "attempts": 11, "pct": 36}])
        close = next(row for row in rows if row["zone"] == "one")
        self.assertEqual((close["label"], close["made"], close["attempts"], close["pct"]),
                         ("Close", 4, 11, 36))

    def test_a_zone_says_where_it_is_and_what_a_make_is_worth(self):
        """An older bridge sends counts only; the panel still has to name them."""
        rows = zone_rows([{"zone": "three", "made": 2, "attempts": 9, "pct": 22}])
        self.assertEqual(
            [row["label"] for row in rows],
            ["Layup", "Short Range", "Mid Range", "Deep Range"],
        )
        self.assertEqual(
            [row["pointsLabel"] for row in rows], ["0.1 PT", "1 PT", "2 PT", "3 PT"],
        )
        self.assertEqual(rows[3]["note"], "Top of the key")

    def test_junk_entries_are_ignored_rather_than_crashing(self):
        rows = zone_rows([None, "three", {"zone": "two", "made": 1, "attempts": 2, "pct": 50}])
        self.assertEqual(len(rows), 4)
        self.assertEqual(next(r for r in rows if r["zone"] == "two")["made"], 1)


class LayoutTests(unittest.TestCase):
    PORTRAIT = ((1080, 1920), (1200, 1920), (900, 1600))
    LANDSCAPE = (1920, 1080)
    SCREENS = PORTRAIT + (LANDSCAPE,)

    def assert_inside_chrome(self, boxes, screen):
        chrome = boxes["chrome"]
        for name, box in cards(boxes).items():
            self.assertGreaterEqual(
                box[1], chrome.content_top - 0.5, f"{name} above the header at {screen}")
            self.assertLessEqual(
                box[3], chrome.content_bottom + 0.5, f"{name} past the footer at {screen}")

    def assert_no_overlap(self, boxes, screen):
        """Two cards may share a row only if they share no columns."""
        items = list(cards(boxes).items())
        for index, (name, box) in enumerate(items):
            for other_name, other in items[index + 1:]:
                rows_clash = box[1] < other[3] - 0.5 and box[3] > other[1] + 0.5
                cols_clash = box[0] < other[2] - 0.5 and box[2] > other[0] + 0.5
                self.assertFalse(
                    rows_clash and cols_clash,
                    f"{name} overlaps {other_name} at {screen}",
                )

    def test_session_cards_never_overlap_or_leave_the_page(self):
        for screen in self.SCREENS:
            for players in (0, 3):
                boxes = layout_huupe_session(
                    *screen, timed=True, finished=True, players=players)
                self.assert_no_overlap(boxes, screen)
                self.assert_inside_chrome(boxes, screen)

    def test_portrait_stacks_the_session_top_to_bottom(self):
        boxes = layout_huupe_session(1080, 1920, timed=True, players=2)
        order = ["mode", "hero", "body", "tiles", "court", "ticker"]
        for upper, lower in zip(order, order[1:]):
            self.assertLessEqual(
                boxes[upper][3], boxes[lower][1] + 0.5, f"{upper} runs into {lower}")
        # The shot chart and its legend share that row rather than stacking.
        self.assertEqual(boxes["court"][1], boxes["zones"][1])
        self.assertLess(boxes["court"][2], boxes["zones"][0])

    def test_landscape_puts_the_chart_beside_the_scoreboard(self):
        # A single column stretched across 1920px is what this replaces.
        boxes = layout_huupe_session(*self.LANDSCAPE, timed=False, players=2)
        for name in ("hero", "body", "tiles"):
            self.assertLess(boxes[name][2], boxes["court"][0], f"{name} is not left of the court")
        self.assertLess(boxes["court"][2], boxes["zones"][0])
        self.assertLess(boxes["ticker"][1], boxes["chrome"].content_bottom)
        self.assertGreater(boxes["ticker"][2] - boxes["ticker"][0], boxes["court"][2] - boxes["court"][0])

    def test_free_play_drops_the_scoreboard_and_still_fills_the_page(self):
        """No names means no scoreboard, and no hole where one would have been."""
        for screen in self.SCREENS:
            boxes = layout_huupe_session(*screen, timed=True, players=0)
            self.assertNotIn("body", boxes)
            bottom = max(box[3] for box in cards(boxes).values())
            self.assertGreater(
                bottom, boxes["chrome"].content_bottom - 60 * boxes["chrome"].u,
                f"free play leaves the page short at {screen}",
            )

    def test_dashboard_cards_never_overlap_or_leave_the_page(self):
        for screen in self.SCREENS:
            for recent in (False, True):
                boxes = layout_huupe_dashboard(*screen, timed=True, recent=recent)
                self.assert_no_overlap(boxes, screen)
                self.assert_inside_chrome(boxes, screen)

    def test_a_hoop_with_no_history_drops_the_recent_card(self):
        for screen in (self.PORTRAIT[0], self.LANDSCAPE):
            boxes = layout_huupe_dashboard(*screen, timed=True, recent=False)
            self.assertNotIn("recent", boxes)
            self.assertIn("records", boxes)

    def test_the_leaderboard_takes_the_slack_on_a_tall_screen(self):
        short = layout_huupe_dashboard(1920, 1080, timed=True)
        tall = layout_huupe_dashboard(1080, 1920, timed=True)
        short_h = short["leaderboard"][3] - short["leaderboard"][1]
        tall_h = tall["leaderboard"][3] - tall["leaderboard"][1]
        self.assertGreater(tall_h, short_h)


class StackBoxTests(unittest.TestCase):
    def test_flexible_rows_share_the_slack(self):
        boxes = stack_boxes(0, 100, 0, 300, [("a", 50, 1.0), ("b", 50, 1.0)], 0)
        self.assertAlmostEqual(boxes["a"][3] - boxes["a"][1], 150)
        self.assertAlmostEqual(boxes["b"][3] - boxes["b"][1], 150)

    def test_a_capped_row_hands_its_share_to_the_others(self):
        """Free play has one fewer card; the chart must not swallow the page."""
        boxes = stack_boxes(
            0, 100, 0, 400, [("chart", 50, 1.0, 120), ("tiles", 50, 1.0)], 0)
        self.assertAlmostEqual(boxes["chart"][3] - boxes["chart"][1], 120)
        self.assertAlmostEqual(boxes["tiles"][3] - boxes["tiles"][1], 280)

    def test_rows_that_cannot_fit_are_squeezed_rather_than_overflowing(self):
        boxes = stack_boxes(0, 100, 0, 100, [("a", 100, 0.0), ("b", 100, 0.0)], 0)
        self.assertLessEqual(boxes["b"][3], 100.5)


class CourtTests(unittest.TestCase):
    def test_the_court_sits_inside_the_box_it_was_given(self):
        for box in ((0, 0, 400, 400), (0, 0, 300, 800), (0, 0, 800, 300)):
            geo = court_regions(box)
            left, top, right, bottom = geo["court"]
            self.assertGreaterEqual(left, box[0] - 0.5)
            self.assertLessEqual(right, box[2] + 0.5)
            self.assertGreaterEqual(top, box[1] - 0.5)
            self.assertLessEqual(bottom, box[3] + 0.5)

    def test_the_markings_stay_on_the_floor(self):
        geo = court_regions((0, 0, 400, 420))
        _left, top, _right, bottom = geo["court"]
        key = geo["key"]
        self.assertGreater(key[1], top)
        self.assertAlmostEqual(key[3], bottom)
        rim_x, rim_y, _rim_r = geo["rim"]
        self.assertLess(rim_y, bottom)
        self.assertGreater(rim_y, key[1])

    def test_a_taller_card_adds_floor_rather_than_stretching_the_paint(self):
        short = court_regions((0, 0, 400, 360))
        tall = court_regions((0, 0, 400, 520))
        short_key = short["key"][3] - short["key"][1]
        tall_key = tall["key"][3] - tall["key"][1]
        self.assertAlmostEqual(short_key, tall_key, delta=1.0)
        self.assertGreater(
            tall["court"][3] - tall["court"][1], short["court"][3] - short["court"][1])

    def test_the_centre_circle_hangs_off_the_far_baseline(self):
        for box in ((0, 0, 400, 340), (0, 0, 400, 540)):
            geo = court_regions(box)
            top = geo["court"][1]
            lowest = max(geo["centre"][index] for index in range(1, len(geo["centre"]), 2))
            arc_apex = min(geo["arc"][index] for index in range(1, len(geo["arc"]), 2))
            self.assertGreater(lowest, top)
            self.assertLess(lowest, arc_apex, "the centre circle runs into the arc")


class HeatTests(unittest.TestCase):
    def test_cold_and_hot_ends_are_different_colours(self):
        self.assertNotEqual(heat_color(0), heat_color(100))

    def test_the_ramp_warms_up_as_the_percentage_climbs(self):
        """Red channel is the cheap proxy for 'hotter' on a blue-to-red ramp."""
        reds = [int(heat_color(pct)[1:3], 16) for pct in (0, 25, 50, 75, 100)]
        self.assertEqual(reds, sorted(reds))

    def test_out_of_range_percentages_are_clamped(self):
        self.assertEqual(heat_color(-40), heat_color(0))
        self.assertEqual(heat_color(140), heat_color(100))


class HotZoneTests(unittest.TestCase):
    def rows(self, **pcts):
        return [
            {"zone": zone, "made": made, "attempts": attempts,
             "pct": round(100 * made / attempts) if attempts else 0}
            for zone, (made, attempts) in pcts.items()
        ]

    def test_the_best_percentage_wins(self):
        rows = self.rows(layup=(2, 8), one=(6, 10), three=(1, 9))
        self.assertEqual(hot_zone(rows)["zone"], "one")

    def test_a_single_lucky_shot_is_not_a_hot_zone(self):
        rows = self.rows(three=(1, 1), one=(5, 10))
        self.assertEqual(hot_zone(rows)["zone"], "one")

    def test_one_attempt_is_better_than_nothing_at_all(self):
        rows = self.rows(three=(1, 1), one=(0, 0))
        self.assertEqual(hot_zone(rows)["zone"], "three")

    def test_a_hoop_nobody_has_shot_at_has_no_hot_zone(self):
        self.assertIsNone(hot_zone(zone_rows([])))


class LiveUpdateTests(unittest.TestCase):
    def test_a_newer_revision_repaints_in_place(self):
        panel = make_panel()
        panel.show(session_payload(revision=1))
        panel._render_session.reset_mock()
        self.assertEqual(panel.apply_session_payload(session_payload(revision=2, made=6)), "updated")
        panel._render_session.assert_called_once()

    def test_a_late_packet_is_dropped_rather_than_rolling_the_score_back(self):
        panel = make_panel()
        panel.show(session_payload(revision=5, made=9))
        panel._render_session.reset_mock()
        self.assertEqual(panel.apply_session_payload(session_payload(revision=3, made=4)), "ignored")
        panel._render_session.assert_not_called()

    def test_an_identical_repeat_does_not_flicker_the_page(self):
        panel = make_panel()
        panel.show(session_payload(revision=4))
        panel._render_session.reset_mock()
        self.assertEqual(panel.apply_session_payload(session_payload(revision=4)), "ignored")
        panel._render_session.assert_not_called()

    def test_the_same_revision_with_new_content_still_repaints(self):
        """Revision is a hint, not a guarantee; content decides."""
        panel = make_panel()
        panel.show(session_payload(revision=4, made=5))
        panel._render_session.reset_mock()
        self.assertEqual(panel.apply_session_payload(session_payload(revision=4, made=7)), "updated")
        panel._render_session.assert_called_once()

    def test_a_different_session_forces_a_full_teardown(self):
        panel = make_panel()
        panel.show(session_payload(session_id="s-1", revision=9))
        self.assertEqual(
            panel.apply_session_payload(session_payload(session_id="s-2", revision=1)),
            "replace",
        )

    def test_updates_are_refused_while_the_dashboard_is_up(self):
        panel = make_panel()
        panel.show({"type": "huupe.dashboard", "totals": {}})
        self.assertEqual(panel.apply_session_payload(session_payload()), "replace")

    def test_updates_are_refused_when_nothing_is_showing(self):
        panel = make_panel()
        self.assertEqual(panel.apply_session_payload(session_payload()), "replace")

    def test_a_foreign_payload_is_refused(self):
        panel = make_panel()
        panel.show(session_payload())
        self.assertEqual(panel.apply_session_payload({"type": "autodarts.match"}), "replace")


class ShowTests(unittest.TestCase):
    def test_an_unchanged_dashboard_is_not_repainted(self):
        panel = make_panel()
        payload = {"type": "huupe.dashboard", "totals": {"sessions": 4}, "leaderboard": []}
        panel.show(payload)
        panel._render_dashboard.reset_mock()
        panel.show(dict(payload))
        panel._render_dashboard.assert_not_called()

    def test_a_changed_dashboard_is_repainted(self):
        panel = make_panel()
        panel.show({"type": "huupe.dashboard", "totals": {"sessions": 4}})
        panel._render_dashboard.reset_mock()
        panel.show({"type": "huupe.dashboard", "totals": {"sessions": 5}})
        panel._render_dashboard.assert_called_once()

    def test_switching_from_session_to_dashboard_swaps_modes(self):
        panel = make_panel()
        panel.show(session_payload())
        panel.show({"type": "huupe.dashboard", "totals": {}})
        self.assertEqual(panel._mode, "dashboard")
        self.assertIsNone(panel._session_id)

    def test_an_unknown_type_hides_the_panel(self):
        panel = make_panel()
        panel.show(session_payload())
        panel.show({"type": "something.else"})
        self.assertFalse(panel.visible)


if __name__ == "__main__":
    unittest.main()
