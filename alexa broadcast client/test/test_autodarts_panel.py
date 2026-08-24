"""Autodarts panel — payload routing, board geometry, layouts, revision guards."""

import sys
import unittest
from pathlib import Path

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import ACCENT, WARN, page_chrome
from src.payload_utils import COMMAND_TYPES, resolve_display_type, title_for_payload
from src.autodarts_panel import (
    AutodartsPanel,
    R_TREBLE_INNER,
    R_TREBLE_OUTER,
    board_info_row_ys,
    board_radii,
    current_month_bar_color,
    dart_board_xy,
    fit_player_name_size,
    format_final_scoreline,
    format_game_shot,
    format_last_played_label,
    format_leaderboard_detail,
    format_record_average,
    is_bouncer_dart,
    is_miss_dart,
    is_t20_in_treble_wedge,
    is_t20_in_treble_wedge_px,
    layout_dashboard,
    layout_match,
    leaderboard_visible_rows,
    map_coords_to_px,
    match_fingerprint,
    normalize_hit_map,
    segment_centroid,
    should_show_ghosts,
    should_show_turn_strip,
    turn_has_content,
)


T20_XY = (0.0, (R_TREBLE_INNER + R_TREBLE_OUTER) / 2)


def sample_match(*, revision=41, status="live", with_turn=True, busted=False, players=2):
    darts = [
        {"seg": "T20", "x": T20_XY[0], "y": T20_XY[1], "type": "normal"},
        {"seg": "5", "x": -0.55, "y": 0.42, "type": "normal"},
        None,
    ] if with_turn else [None, None, None]
    roster = [
        {"name": "TRASHPANDA", "score": 261, "legs": 1, "average": 25.03,
         "lastTurnPoints": 85, "isWinner": status == "finished"},
        {"name": "WAR D", "score": 356, "legs": 0, "average": 20.89,
         "lastTurnPoints": 41, "isWinner": False},
    ]
    if players >= 3:
        roster.append({"name": "KYLIE", "score": 401, "legs": 0, "average": 18.0,
                       "lastTurnPoints": 20, "isWinner": False})
    if players >= 4:
        roster.append({"name": "TOMMY", "score": 440, "legs": 0, "average": 15.0,
                       "lastTurnPoints": 12, "isWinner": False})
    return {
        "version": 2,
        "type": "autodarts.match",
        "persistent": status == "live",
        "displaySeconds": 0 if status == "live" else 60,
        "match": {
            "matchId": "m1",
            "revision": revision,
            "status": status,
            "variant": "X01",
            "settingsLine": "501 · SI-DO · First to 2 legs",
            "durationSec": 412,
            "currentPlayerIndex": 0,
            "turn": {"points": 65, "busted": busted, "darts": darts},
            "prevTurn": {
                "playerIndex": 1,
                "points": 41,
                "darts": [
                    {"seg": "20", "x": 0.03, "y": -0.71, "type": "normal"},
                    {"seg": "M", "x": 1.24, "y": 0.31, "type": "normal"},
                    {"seg": "1", "x": 0.28, "y": -0.66, "type": "bouncer"},
                ],
            },
            "players": roster,
            "gameShot": "D8" if status == "finished" else None,
            "hitMap": None,
        },
    }


def sample_dashboard():
    return {
        "version": 2,
        "type": "autodarts.dashboard",
        "displaySeconds": 120,
        "totals": {"matches": 412, "legs": 1204, "thisMonth": 18, "lastPlayedLabel": "2d"},
        "leaderboard": [
            {"rank": 1, "crown": True, "name": "TRASHPANDA", "wins": 23, "losses": 14,
             "winPct": 62, "x01Average": 25.0, "bestCheckout": 48, "oneEighties": 0, "matches": 37},
            {"rank": 2, "crown": False, "name": "WAR D", "wins": 14, "losses": 23,
             "winPct": 38, "x01Average": 20.9, "bestCheckout": 40, "oneEighties": 0, "matches": 37},
        ],
        "moreCount": 3,
        "byMonth": [{"key": f"2026-{m:02d}", "label": "Jan", "count": m} for m in range(1, 13)],
        "rivalry": {"a": "TRASHPANDA", "b": "WAR D", "aWins": 23, "bWins": 14,
                    "lastWinner": "TRASHPANDA", "lastPlayedAt": "2026-08-01T00:00:00Z"},
        "records": {
            "bestMatchAverage": {"value": 36.3, "player": "TRASHPANDA"},
            "highestCheckout": {"value": 48, "player": "TRASHPANDA"},
            "total180s": 0,
        },
    }


class PayloadRoutingTests(unittest.TestCase):
    def test_display_types_and_titles(self):
        self.assertEqual(resolve_display_type({"type": "autodarts.dashboard"}), "autodarts.dashboard")
        self.assertEqual(resolve_display_type({"type": "autodarts.match"}), "autodarts.match")
        self.assertEqual(title_for_payload({"type": "autodarts.dashboard"}), ("Signal", "autodarts"))
        self.assertEqual(title_for_payload({"type": "autodarts.match"}), ("Signal", "autodarts"))

    def test_close_is_command(self):
        self.assertIn("autodarts.match.close", COMMAND_TYPES)
        self.assertEqual(resolve_display_type({"type": "autodarts.match.close"}), "")


class BoardGeometryTests(unittest.TestCase):
    def test_t20_centroid_in_treble_wedge(self):
        x, y = segment_centroid("T20")
        self.assertTrue(is_t20_in_treble_wedge(x, y))
        self.assertTrue(is_t20_in_treble_wedge(*T20_XY))

    def test_map_coords_keeps_t20_in_treble_both_orientations(self):
        for w, h in ((1080, 1920), (1920, 1080)):
            cx, cy, outer = w / 2, h / 2, min(w, h) * 0.35
            px, py = map_coords_to_px(T20_XY[0], T20_XY[1], cx, cy, outer)
            self.assertTrue(is_t20_in_treble_wedge_px(px, py, cx, cy, outer), (w, h))

    def test_segment_centroid_fallback_when_coords_absent(self):
        xy = dart_board_xy({"seg": "T20", "x": None, "y": None, "type": "normal"})
        self.assertEqual(xy, segment_centroid("T20"))
        self.assertTrue(is_t20_in_treble_wedge(*xy))

    def test_miss_and_bouncer_helpers(self):
        miss = {"seg": "M", "x": None, "y": None, "type": "normal"}
        self.assertTrue(is_miss_dart(miss))
        self.assertEqual(dart_board_xy(miss)[0], segment_centroid("M")[0])
        bouncer = {"seg": "20", "x": 0.1, "y": -0.7, "type": "bouncer"}
        self.assertTrue(is_bouncer_dart(bouncer))

    def test_board_radii_ratios(self):
        radii = board_radii(100)
        self.assertAlmostEqual(radii["double_outer"], 100)
        self.assertAlmostEqual(radii["double_inner"], 95.3)
        self.assertAlmostEqual(radii["treble_outer"], 62.9)
        self.assertAlmostEqual(radii["treble_inner"], 58.2)
        self.assertAlmostEqual(radii["outer_bull"], 9.4)
        self.assertAlmostEqual(radii["inner_bull"], 3.7)

    def test_ghosts_clear_when_first_dart_lands(self):
        self.assertTrue(should_show_ghosts({"darts": [None, None, None]}))
        self.assertFalse(should_show_ghosts({
            "darts": [{"seg": "T20", "x": 0, "y": -0.6}, None, None],
        }))


class LayoutTests(unittest.TestCase):
    def assert_boxes_fit(self, boxes, width, height, timed=True):
        chrome = page_chrome(width, height, timed=timed)
        for name, box in boxes.items():
            if name in ("portrait", "chrome", "finished", "player_count", "show_strip", "omit_score_names") or box is None:
                continue
            x0, y0, x1, y1 = box
            self.assertGreaterEqual(x0, chrome.content_x - 1, name)
            self.assertGreaterEqual(y0, chrome.content_top - 1, name)
            self.assertLessEqual(x1, chrome.content_x + chrome.content_w + 1, name)
            self.assertLessEqual(y1, chrome.content_bottom + 1, name)
            self.assertGreater(x1, x0, name)
            self.assertGreater(y1, y0, name)

    def test_dashboard_portrait_and_landscape(self):
        for size in ((1080, 1920), (1920, 1080)):
            boxes = layout_dashboard(*size, timed=True)
            self.assertIn("leaderboard", boxes)
            self.assertIn("board_info", boxes)
            self.assertIn("months", boxes)
            self.assertIn("rivalry", boxes)
            self.assert_boxes_fit(boxes, *size)
            # Room for version line + stats without overlap (was 150 → collided).
            board_h = boxes["board_info"][3] - boxes["board_info"][1]
            self.assertGreaterEqual(board_h, 190)

    def test_portrait_dashboard_boxes_do_not_overlap(self):
        boxes = layout_dashboard(1080, 1920, timed=True)
        ordered = ["totals", "board_info", "leaderboard", "months", "rivalry", "records"]
        for left, right in zip(ordered, ordered[1:]):
            self.assertLessEqual(boxes[left][3], boxes[right][1] + 1, f"{left} overlaps {right}")
        rows = board_info_row_ys(boxes["board_info"][3] - boxes["board_info"][1])
        self.assertTrue(rows["meta_clear_of_value"])
        visible, row_h = leaderboard_visible_rows(boxes["leaderboard"][3] - boxes["leaderboard"][1], 12)
        self.assertGreaterEqual(row_h, 58)
        self.assertLessEqual(visible, 12)

    def test_finished_portrait_omits_duplicate_score_names(self):
        boxes = layout_match(1080, 1920, timed=True, player_count=2, finished=True, show_strip=False)
        self.assertTrue(boxes.get("omit_score_names"))
        self.assertGreaterEqual(boxes["board"][3] - boxes["board"][1], 400)

    def test_board_info_rows_keep_meta_clear_of_stats(self):
        rows = board_info_row_ys(178)
        # Meta baseline sits above the value row with room for ~13px type.
        self.assertLess(rows["meta"] + 20, rows["value"] - 10)
        self.assertLess(rows["value"] + 10, rows["label"])
        self.assertLess(rows["label"], 178 - 10)

    def test_match_portrait_board_absorbs_slack(self):
        boxes = layout_match(1080, 1920, timed=False, player_count=2)
        self.assertTrue(boxes["portrait"])
        board_h = boxes["board"][3] - boxes["board"][1]
        scores_h = boxes["scores"][3] - boxes["scores"][1]
        strip_h = boxes["strip"][3] - boxes["strip"][1]
        self.assertGreater(board_h, scores_h)
        self.assertGreater(board_h, strip_h)
        self.assert_boxes_fit(boxes, 1080, 1920, timed=False)

    def test_match_landscape_player_board_player(self):
        boxes = layout_match(1920, 1080, timed=False, player_count=2)
        self.assertFalse(boxes["portrait"])
        self.assertIn("scores_left", boxes)
        self.assertIn("scores_right", boxes)
        self.assertLess(boxes["scores_left"][2], boxes["board"][0])
        self.assertGreater(boxes["scores_right"][0], boxes["board"][2])
        self.assert_boxes_fit(boxes, 1920, 1080, timed=False)

    def test_four_player_layouts(self):
        for size in ((1080, 1920), (1920, 1080)):
            boxes = layout_match(*size, timed=True, player_count=4)
            self.assertIn("board", boxes)
            self.assert_boxes_fit(boxes, *size, timed=True)

    def test_current_month_gold(self):
        self.assertEqual(current_month_bar_color(11, 12), WARN)
        self.assertEqual(current_month_bar_color(10, 12), ACCENT)

    def test_game_shot_line(self):
        self.assertEqual(format_game_shot("D8"), "GAME SHOT — D8")
        self.assertEqual(format_game_shot(""), "")

    def test_finished_match_reserves_result_band(self):
        for size in ((1080, 1920), (1920, 1080)):
            boxes = layout_match(*size, timed=True, player_count=2, finished=True)
            self.assertTrue(boxes["finished"])
            self.assertIsNotNone(boxes["result"])
            self.assert_boxes_fit(boxes, *size, timed=True)
            # Board must sit below the result banner.
            self.assertGreaterEqual(boxes["board"][1], boxes["result"][3] - 1)

    def test_finished_without_strip_gives_board_the_space(self):
        with_strip = layout_match(1920, 1080, timed=True, player_count=2, finished=True, show_strip=True)
        without = layout_match(1920, 1080, timed=True, player_count=2, finished=True, show_strip=False)
        self.assertIsNotNone(with_strip["strip"])
        self.assertIsNone(without["strip"])
        self.assertGreater(without["board"][3] - without["board"][1],
                           with_strip["board"][3] - with_strip["board"][1])


class LabelFormatTests(unittest.TestCase):
    def test_last_played_expands_relative(self):
        self.assertEqual(format_last_played_label({"lastPlayedLabel": "22d"}), "22 days ago")
        self.assertEqual(
            format_last_played_label({"lastPlayedAt": "2026-08-01T00:00:00Z"}),
            "Aug 01",
        )

    def test_final_scoreline_lists_all_players(self):
        two = format_final_scoreline([
            {"name": "trashpanda", "legs": 2},
            {"name": "war d", "legs": 1},
        ])
        self.assertIn("—", two)
        self.assertIn("trashpanda", two)
        self.assertIn("war d", two)
        four = format_final_scoreline([
            {"name": "trashpanda", "legs": 0},
            {"name": "tommy", "legs": 0},
            {"name": "war d", "legs": 0},
            {"name": "kylie", "legs": 0},
        ])
        self.assertIn("tommy", four)
        self.assertIn("kylie", four)
        self.assertIn("·", four)
        self.assertNotIn("—", four)

    def test_final_hides_empty_turn_strip(self):
        empty = {"status": "finished", "turn": {"points": 0, "darts": [None, None, None]}}
        self.assertFalse(should_show_turn_strip(empty, finished=True))
        self.assertFalse(turn_has_content(empty["turn"]))
        with_shot = {**empty, "gameShot": "D16"}
        self.assertTrue(should_show_turn_strip(with_shot, finished=True))
        with_darts = {
            "status": "finished",
            "turn": {"points": 60, "darts": [{"seg": "T20"}, None, None]},
        }
        self.assertTrue(should_show_turn_strip(with_darts, finished=True))
        self.assertTrue(should_show_turn_strip({"status": "live", "turn": {}}, finished=False))
        self.assertEqual(format_game_shot("D16"), "GAME SHOT — D16")

    def test_leaderboard_detail_readable(self):
        line = format_leaderboard_detail({
            "wins": 11, "losses": 4, "winPct": 73,
            "x01Average": 25.03, "bestCheckout": 48, "oneEighties": 0, "matches": 15,
        })
        self.assertIn("Record 11–4", line)
        self.assertIn("Avg 25.0", line)
        self.assertIn("Highest checkout 48", line)
        self.assertIn("180 scores 0", line)
        self.assertNotIn("Best out", line)

    def test_record_average(self):
        self.assertEqual(format_record_average(36.3), "36.3")
        self.assertEqual(format_record_average(None), "—")

    def test_name_size_stays_width_capped(self):
        wide = fit_player_name_size("▶ trashpanda", 420, compact=False)
        tall_narrow = fit_player_name_size("▶ trashpanda", 180, compact=False)
        self.assertLessEqual(tall_narrow, 26)
        self.assertLessEqual(tall_narrow, wide + 2)
        self.assertGreaterEqual(tall_narrow, 13)

    def test_s20_coords_map_near_top_of_board(self):
        # Autodarts +y is toward 20; screen Y grows downward.
        cx, cy, outer = 500.0, 500.0, 200.0
        px, py = map_coords_to_px(0.0, 0.7, cx, cy, outer)
        self.assertLess(py, cy)
        self.assertTrue(is_t20_in_treble_wedge(*T20_XY))


class HitMapTests(unittest.TestCase):
    def test_normalize_and_skip_without_coords(self):
        players = [{"name": "A"}, {"name": "B"}]
        rows = normalize_hit_map({
            "players": [
                {"name": "A", "darts": [{"seg": "T20", "x": T20_XY[0], "y": T20_XY[1]}]},
                {"name": "B", "darts": [{"seg": "20", "x": None, "y": None}]},
            ],
        }, players)
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(rows[0]["darts"]), 1)
        self.assertEqual(len(rows[1]["darts"]), 1)  # centroid fallback
        empty = normalize_hit_map({"players": [{"name": "A", "darts": []}]}, players)
        self.assertEqual(empty, [])
        self.assertEqual(normalize_hit_map(None, players), [])


class RevisionAndIdentityTests(unittest.TestCase):
    def _panel(self):
        panel = AutodartsPanel.__new__(AutodartsPanel)
        panel.visible = False
        panel._mode = None
        panel._match_id = None
        panel._revision = -1
        panel._match_fp = None
        panel._dashboard_fp = None
        panel._payload = None
        panel._draw_count = 0
        panel._item_ids = []
        panel._widgets = []
        panel.root = None
        panel.shell = None
        panel.config = {}
        panel.canvas = None
        rendered = []

        def fake_render(payload):
            rendered.append(payload)

        panel._render_match = fake_render
        panel._render_dashboard = fake_render

        def fake_hide():
            panel.visible = False
            panel._item_ids.clear()

        panel.hide = fake_hide
        panel._rendered = rendered
        return panel

    def test_stale_revision_ignored(self):
        panel = self._panel()
        first = sample_match(revision=10)
        panel.show(first)
        self.assertEqual(panel._revision, 10)
        draws = panel._draw_count
        result = panel.apply_match_payload(sample_match(revision=8))
        self.assertEqual(result, "ignored")
        self.assertEqual(panel._draw_count, draws)

    def test_identical_payload_no_redraw(self):
        panel = self._panel()
        payload = sample_match(revision=5)
        panel.show(payload)
        draws = panel._draw_count
        fp = match_fingerprint(payload["match"])
        self.assertEqual(panel._match_fp, fp)
        result = panel.apply_match_payload(payload)
        self.assertEqual(result, "ignored")
        self.assertEqual(panel._draw_count, draws)

    def test_newer_revision_updates(self):
        panel = self._panel()
        panel.show(sample_match(revision=1))
        next_payload = sample_match(revision=2)
        next_payload["match"]["turn"]["darts"][2] = {
            "seg": "1", "x": 0.2, "y": -0.5, "type": "normal",
        }
        result = panel.apply_match_payload(next_payload)
        self.assertEqual(result, "updated")
        self.assertEqual(panel._revision, 2)

    def test_final_card_fields(self):
        payload = sample_match(status="finished")
        payload["match"]["hitMap"] = {
            "players": [
                {"name": "TRASHPANDA", "darts": [
                    {"seg": "T20", "x": T20_XY[0], "y": T20_XY[1]},
                ]},
            ],
        }
        self.assertEqual(format_game_shot(payload["match"]["gameShot"]), "GAME SHOT — D8")
        rows = normalize_hit_map(payload["match"]["hitMap"], payload["match"]["players"])
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["darts"])

    def test_thrower_and_bust_in_payload(self):
        live = sample_match(busted=True)
        self.assertEqual(live["match"]["currentPlayerIndex"], 0)
        self.assertTrue(live["match"]["turn"]["busted"])
        four = sample_match(players=4)
        self.assertEqual(len(four["match"]["players"]), 4)

    def test_close_type_not_display(self):
        self.assertEqual(resolve_display_type({"type": "autodarts.match.close"}), "")


class DashboardContentTests(unittest.TestCase):
    def test_leaderboard_crown_and_more(self):
        payload = sample_dashboard()
        self.assertTrue(payload["leaderboard"][0]["crown"])
        self.assertEqual(payload["moreCount"], 3)
        self.assertEqual(current_month_bar_color(11, 12), WARN)


if __name__ == "__main__":
    unittest.main()
