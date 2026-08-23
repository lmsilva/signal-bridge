"""Overhead flight-radar panel — geometry, roster, dead-reckon helpers."""

from __future__ import annotations

import math
import unittest

from src.config import effective_display_seconds
from src.payload_utils import is_display_payload, title_for_display_type
from src.overhead_panel import (
    COLOR_EMERGENCY,
    COLOR_JET,
    STALE_FADE_SEC,
    STALE_FREEZE_SEC,
    aircraft_display_label,
    aircraft_is_emergency,
    compute_layout_regions,
    dead_reckon_position,
    format_list_footer,
    freeze_roster,
    icon_color,
    label_offset_for_hex,
    list_grid_for_box,
    list_row_min_height,
    motion_frozen,
    page_highlight_hexes,
    page_seconds_remaining,
    resolve_map_label_offsets,
    roster_page_count,
    roster_page_slice,
    route_label,
    rows_per_page,
    scope_xy_from_latlon,
    stale_opacity,
    zoom_for_radius_nm,
)


def sample_aircraft(count=8):
    rows = []
    for i in range(count):
        bearing = i * 45
        dist = 5 + i * 2
        br = math.radians(bearing)
        lat = 40.0 + dist * math.cos(br) / 60.0
        lon = -111.0 + dist * math.sin(br) / (60.0 * math.cos(math.radians(40.0)))
        rows.append({
            "hex": f"A{i:06X}",
            "callsign": f"TST{i + 1}",
            "registration": f"N{i:03d}TS",
            "iconClass": ["jet", "light", "heli", "generic"][i % 4],
            "lat": lat,
            "lon": lon,
            "track": (bearing + 90) % 360,
            "gsKt": 220 - i * 15,
            "altFt": 25000 + i * 1000,
            "dstNm": dist,
            "dirDeg": bearing,
            "route": {
                "originCity": "SLC",
                "destCity": "DEN",
                "originIata": "SLC",
                "destIata": "DEN",
            },
        })
    return rows


class OverheadGeometryTests(unittest.TestCase):
    def test_rows_per_page_orientation(self):
        self.assertEqual(rows_per_page(True), 4)
        self.assertEqual(rows_per_page(False), 6)

    def test_portrait_list_uses_multiple_columns_when_wide(self):
        grid = list_grid_for_box(1000, 700, portrait=True, u=1.0)
        self.assertGreaterEqual(grid["columns"], 2)
        self.assertGreaterEqual(grid["page_size"], 7)
        layout = compute_layout_regions(40, 136, 1000, 1600, portrait=True, u=1.0)
        self.assertGreaterEqual(layout["list_columns"], 2)
        self.assertGreaterEqual(layout["rows"], 7)
        # Map starts below the NM/aircraft meta strip.
        self.assertIn("meta_strip", layout)
        self.assertGreaterEqual(layout["scope"][1], layout["meta_strip"][3])

    def test_portrait_scope_is_top_band(self):
        layout = compute_layout_regions(40, 136, 1000, 1600, portrait=True, u=1.0)
        scope = layout["scope"]
        scope_h = scope[3] - scope[1]
        self.assertAlmostEqual(scope_h / 1600, 0.40, places=2)
        self.assertLess(scope[3], layout["list"][1])
        self.assertIn("legend", layout)
        self.assertLessEqual(layout["meta_strip"][3], scope[1])

    def test_landscape_scope_is_left_55_percent(self):
        layout = compute_layout_regions(60, 132, 1800, 900, portrait=False, u=1.0)
        scope = layout["scope"]
        scope_w = scope[2] - scope[0]
        self.assertAlmostEqual(scope_w / 1800, 0.55, places=2)
        self.assertLess(scope[2], layout["list"][0])
        self.assertGreaterEqual(layout["rows"], 5)
        self.assertLessEqual(layout["list_rows"], 6)
        self.assertGreaterEqual(layout["min_row"], list_row_min_height(False, 1.0))
        self.assertGreaterEqual(scope[1], layout["meta_strip"][3])

    def test_landscape_list_rows_leave_room_for_three_line_cards(self):
        grid = list_grid_for_box(700, 900, portrait=False, u=1.0)
        self.assertLessEqual(grid["rows"], 6)
        self.assertGreaterEqual(grid["min_row"], 90)
        usable = 900 - max(48.0, 40.0)
        row_h = usable / grid["rows"]
        self.assertGreaterEqual(row_h, grid["min_row"] - 0.5)

    def test_scope_projection_inside_radius(self):
        pos, dist = scope_xy_from_latlon(40.1, -111.0, 40.0, -111.0, 25, 200, 200, 100)
        self.assertIsNotNone(pos)
        self.assertLess(dist, 25)

    def test_scope_projection_outside_radius(self):
        pos, dist = scope_xy_from_latlon(41.5, -111.0, 40.0, -111.0, 25, 200, 200, 100)
        self.assertIsNone(pos)
        self.assertGreater(dist, 25)


class OverheadRosterTests(unittest.TestCase):
    def test_freeze_roster_sorts_by_distance(self):
        roster = freeze_roster(sample_aircraft(4))
        distances = [float(ac["dstNm"]) for ac in roster]
        self.assertEqual(distances, sorted(distances))

    def test_page_math(self):
        roster = freeze_roster(sample_aircraft(10))
        rows = 4
        self.assertEqual(roster_page_count(len(roster), rows), 3)
        page0 = roster_page_slice(roster, 0, rows)
        page2 = roster_page_slice(roster, 2, rows)
        self.assertEqual(len(page0), 4)
        self.assertEqual(len(page2), 2)

    def test_page_highlight_hexes(self):
        roster = freeze_roster(sample_aircraft(6))
        highlights = page_highlight_hexes(roster, 1, 4)
        self.assertEqual(len(highlights), 2)
        self.assertIn(str(roster[4]["hex"]).upper(), highlights)

    def test_aircraft_display_label_fallback(self):
        self.assertEqual(aircraft_display_label({"callsign": "UAL123"}), "UAL123")
        self.assertEqual(aircraft_display_label({"registration": "N12345"}), "N12345")
        self.assertEqual(aircraft_display_label({"hex": "ABC123"}), "ABC123")

    def test_route_label_dict_string_and_hex_map(self):
        self.assertEqual(
            route_label({
                "route": {
                    "originCity": "Salt Lake City",
                    "destCity": "Denver",
                    "originIata": "SLC",
                    "destIata": "DEN",
                },
            }),
            ("Salt Lake City", "Denver"),
        )
        self.assertEqual(
            route_label({"route": "SLC → LAX"}),
            ("SLC", "LAX"),
        )
        self.assertEqual(
            route_label(
                {"hex": "a1b2c3"},
                {"a1b2c3": {"originCity": "Boise", "destCity": "Phoenix"}},
            ),
            ("Boise", "Phoenix"),
        )
        self.assertEqual(route_label({"hex": "zzz"}), ("", ""))

    def test_label_offset_is_deterministic(self):
        a = label_offset_for_hex("A1B2C3")
        b = label_offset_for_hex("A1B2C3")
        c = label_offset_for_hex("ZZZZZZ")
        self.assertEqual(a, b)
        self.assertNotEqual(a, c)

    def test_resolve_map_label_offsets_spreads_collisions(self):
        # Two aircraft nearly on top of each other — offsets must differ.
        anchors = [
            ("AAA111", 100.0, 100.0, "N12345 045"),
            ("BBB222", 104.0, 102.0, "N67890 050"),
            ("CCC333", 108.0, 98.0, "N11111 055"),
        ]
        offsets = resolve_map_label_offsets(anchors, char_w=8.0, height=16.0, pad=6.0)
        self.assertEqual(len(offsets), 3)
        positions = {
            hex_code: (anchors[i][1] + offsets[hex_code][0], anchors[i][2] + offsets[hex_code][1])
            for i, (hex_code, *_rest) in enumerate(anchors)
        }
        vals = list(positions.values())
        # At least one pair must be meaningfully separated after resolution.
        spreads = [
            math.hypot(vals[i][0] - vals[j][0], vals[i][1] - vals[j][1])
            for i in range(len(vals))
            for j in range(i + 1, len(vals))
        ]
        self.assertTrue(any(s > 20 for s in spreads))
        # Preferred deterministic offset still used when alone.
        alone = resolve_map_label_offsets(
            [("SOLO01", 50.0, 50.0, "SOLO")], char_w=8.0, height=16.0,
        )
        self.assertEqual(alone["SOLO01"], label_offset_for_hex("SOLO01"))


class OverheadMotionTests(unittest.TestCase):
    def test_dead_reckon_moves_along_track(self):
        lat0, lon0 = 40.0, -111.0
        lat1, lon1 = dead_reckon_position(lat0, lon0, 0, 360, 60)
        self.assertIsNotNone(lat1)
        self.assertGreater(lat1, lat0)
        self.assertAlmostEqual(lon1, lon0, places=4)

    def test_dead_reckon_zero_speed_is_unchanged(self):
        lat, lon = dead_reckon_position(40.0, -111.0, 90, 0, 30)
        self.assertEqual((lat, lon), (40.0, -111.0))

    def test_stale_thresholds(self):
        self.assertFalse(motion_frozen(30))
        self.assertTrue(motion_frozen(STALE_FREEZE_SEC))
        self.assertAlmostEqual(stale_opacity(30), 1.0)
        self.assertLess(stale_opacity(STALE_FREEZE_SEC), 1.0)
        self.assertLess(stale_opacity(STALE_FADE_SEC), stale_opacity(STALE_FREEZE_SEC))

    def test_list_footer(self):
        text = format_list_footer(0, 4, 10, 5)
        self.assertIn("1–4 of 10", text)
        self.assertIn("next page in 5s", text)

    def test_page_seconds_remaining_counts_down(self):
        started = 1_000_000.0
        self.assertEqual(page_seconds_remaining(8, started, now=started), 8)
        self.assertEqual(page_seconds_remaining(8, started, now=started + 0.2), 8)
        self.assertEqual(page_seconds_remaining(8, started, now=started + 1.0), 7)
        self.assertEqual(page_seconds_remaining(8, started, now=started + 7.1), 1)
        self.assertEqual(page_seconds_remaining(8, started, now=started + 8.0), 0)
        self.assertEqual(page_seconds_remaining(8, started, now=started + 9.0), 0)


class OverheadColorTests(unittest.TestCase):
    def test_emergency_none_is_not_emergency(self):
        # ADS-B frequently sends emergency="none"; that must not paint red.
        ac = {"emergency": "none", "iconClass": "jet", "squawk": "1200"}
        self.assertFalse(aircraft_is_emergency(ac))
        self.assertEqual(icon_color(ac), COLOR_JET)

    def test_emergency_flag_and_squawk(self):
        self.assertTrue(aircraft_is_emergency({"emergency": "general"}))
        self.assertTrue(aircraft_is_emergency({"squawk": "7700", "emergency": "none"}))
        self.assertTrue(aircraft_is_emergency({"isEmergency": True, "emergency": "none"}))
        self.assertEqual(icon_color({"emergency": "general"}), COLOR_EMERGENCY)

    def test_zoom_for_radius_is_sane(self):
        zoom = zoom_for_radius_nm(40.35, 40, 600)
        self.assertGreaterEqual(zoom, 6)
        self.assertLessEqual(zoom, 13)
        tight = zoom_for_radius_nm(40.35, 10, 600)
        wide = zoom_for_radius_nm(40.35, 100, 600)
        self.assertGreaterEqual(tight, wide)


class OverheadRegistrationTests(unittest.TestCase):
    def test_display_type_registered(self):
        self.assertTrue(is_display_payload({"type": "overhead.round"}))
        self.assertEqual(title_for_display_type("overhead.round"), ("Signal", "Overhead"))

    def test_effective_display_seconds_not_clamped(self):
        config = {"maxDisplaySeconds": 30, "defaultDisplaySeconds": 30}
        seconds = effective_display_seconds(
            {"type": "overhead.round", "displaySeconds": 240},
            config,
        )
        self.assertEqual(seconds, 240)


if __name__ == "__main__":
    unittest.main()
