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
    format_score,
    layout_huupe_dashboard,
    layout_huupe_session,
    zone_rows,
)


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

    def test_junk_entries_are_ignored_rather_than_crashing(self):
        rows = zone_rows([None, "three", {"zone": "two", "made": 1, "attempts": 2, "pct": 50}])
        self.assertEqual(len(rows), 4)
        self.assertEqual(next(r for r in rows if r["zone"] == "two")["made"], 1)


class LayoutTests(unittest.TestCase):
    SCREENS = ((1080, 1920), (1200, 1920), (900, 1600), (1920, 1080))

    def test_session_cards_stack_without_overlapping(self):
        for screen in self.SCREENS:
            boxes = layout_huupe_session(*screen, timed=True, finished=True)
            order = ["mode", "headline", "body", "zones", "strip"]
            for upper, lower in zip(order, order[1:]):
                self.assertLessEqual(
                    boxes[upper][3], boxes[lower][1] + 0.5,
                    f"{upper} runs into {lower} at {screen}",
                )

    def test_session_cards_stay_within_the_page_chrome(self):
        for screen in self.SCREENS:
            boxes = layout_huupe_session(*screen, timed=True)
            chrome = boxes["chrome"]
            self.assertGreaterEqual(boxes["mode"][1], chrome.content_top - 0.5)
            self.assertLessEqual(boxes["strip"][3], chrome.content_bottom + 0.5)

    def test_dashboard_cards_stack_without_overlapping(self):
        for screen in self.SCREENS:
            boxes = layout_huupe_dashboard(*screen, timed=True)
            order = ["totals", "leaderboard", "zones", "records"]
            for upper, lower in zip(order, order[1:]):
                self.assertLessEqual(
                    boxes[upper][3], boxes[lower][1] + 0.5,
                    f"{upper} runs into {lower} at {screen}",
                )

    def test_the_leaderboard_takes_the_slack_on_a_tall_screen(self):
        short = layout_huupe_dashboard(1920, 1080, timed=True)
        tall = layout_huupe_dashboard(1080, 1920, timed=True)
        short_h = short["leaderboard"][3] - short["leaderboard"][1]
        tall_h = tall["leaderboard"][3] - tall["leaderboard"][1]
        self.assertGreater(tall_h, short_h)


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
