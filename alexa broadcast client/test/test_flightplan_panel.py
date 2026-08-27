"""Flight Plan panel helpers — formatting, journey math, geo and layout."""

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import MagicMock

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import page_chrome
from src.flightplan_panel import (
    FlightPlanPanel,
    airport_code,
    airport_place,
    bearing_between,
    endpoint_latlon,
    format_clock,
    format_day,
    format_duration,
    format_flight_number,
    format_lead_time,
    format_route,
    great_circle_points,
    journey_caption,
    journey_fraction,
    layout_flightplan,
    parse_stamp,
    plane_polygon,
    status_color,
    status_token,
    unwrap_longitudes,
)

SCREENS = ((1080, 1920), (1200, 1920), (900, 1600), (1920, 1080))


class FormattingTests(unittest.TestCase):
    def test_format_flight_number_spaced(self):
        self.assertEqual(format_flight_number("DL", "167"), "DL 167")

    def test_format_flight_number_strips_duplicate_prefix(self):
        self.assertEqual(format_flight_number("DL", "DL167"), "DL 167")

    def test_format_route(self):
        self.assertEqual(format_route({"iata": "SLC"}, {"iata": "NRT"}), "SLC → NRT")

    def test_airport_code_and_place(self):
        self.assertEqual(airport_code({"icao": "rjtt"}), "RJTT")
        self.assertEqual(airport_place({"city": "Tokyo", "name": "Haneda"}), "Tokyo")
        self.assertEqual(airport_place({"name": "Haneda"}), "Haneda")

    def test_clock_uses_airport_wall_time_not_the_utc_offset(self):
        # The old slice-based reader turned this stamp into "00-07".
        self.assertEqual(format_clock("2027-06-24T13:45:00-07:00"), "1:45 PM")
        self.assertEqual(format_clock("2027-06-25T16:00:00+09:00"), "4:00 PM")
        self.assertEqual(format_clock("2026-09-10 08:05-06:00"), "8:05 AM")
        self.assertEqual(format_clock("nonsense"), "—")

    def test_format_day_names_the_calendar_day(self):
        label = format_day("2027-06-24T13:45:00-07:00")
        weekday = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")[date(2027, 6, 24).weekday()]
        self.assertEqual(label, f"{weekday} JUN 24")

    def test_parse_stamp_handles_both_separators(self):
        self.assertEqual(parse_stamp("2026-09-10 08:05-06:00"), (2026, 9, 10, 8, 5))
        self.assertEqual(parse_stamp("2026-09-10T08:05:00Z"), (2026, 9, 10, 8, 5))
        self.assertIsNone(parse_stamp(""))

    def test_format_duration(self):
        self.assertEqual(format_duration(795), "13h 15m")
        self.assertEqual(format_duration(120), "2h")
        self.assertEqual(format_duration(45), "45m")
        self.assertEqual(format_duration(None), "")

    def test_format_lead_time_picks_a_readable_unit(self):
        self.assertEqual(format_lead_time(20), "in 20 min")
        self.assertEqual(format_lead_time(200), "in 3h 20m")
        self.assertEqual(format_lead_time(60 * 24 * 302), "in 302 days")
        self.assertEqual(format_lead_time(-5), "departed")


class StatusTests(unittest.TestCase):
    def test_status_token_reads_either_spelling(self):
        self.assertEqual(status_token({"colorToken": "warn"}), "warn")
        self.assertEqual(status_token({"colour": "GOOD"}), "good")
        self.assertEqual(status_token({"colour": "INK_3"}), "muted")
        self.assertEqual(status_token({}), "muted")

    def test_status_colour_from_bridge_vocabulary(self):
        self.assertEqual(status_color({"status": {"colour": "WARN"}}), "#F5C453")

    def test_journey_fraction_clamps_and_completes_on_landing(self):
        self.assertEqual(journey_fraction({"progress": {"fraction": 0.4}}), 0.4)
        self.assertEqual(journey_fraction({"progress": {"fraction": 9}}), 1.0)
        self.assertEqual(
            journey_fraction({"progress": {"fraction": 0.2}, "flight": {"state": "landed"}}),
            1.0,
        )

    def test_journey_caption_counts_down_before_departure(self):
        upcoming = {"progress": {"departsInMinutes": 200}, "flight": {"state": "upcoming"}}
        self.assertEqual(journey_caption(upcoming), "in 3h 20m")
        airborne = {"progress": {"remainingMinutes": 95}, "flight": {"state": "active"}}
        self.assertEqual(journey_caption(airborne), "1h 35m remaining")
        self.assertEqual(journey_caption({"flight": {"state": "landed"}}), "arrived")


class GeoTests(unittest.TestCase):
    def test_great_circle_starts_and_ends_at_the_airports(self):
        points = great_circle_points(47.45, -122.31, 35.55, 139.78, count=48)
        self.assertGreaterEqual(len(points), 49)
        self.assertAlmostEqual(points[0][0], 47.45, places=3)
        self.assertAlmostEqual(points[0][1], -122.31, places=3)
        self.assertAlmostEqual(points[-1][0], 35.55, places=1)

    def test_great_circle_arcs_north_of_the_straight_line(self):
        points = great_circle_points(47.45, -122.31, 35.55, 139.78, count=48)
        mid = points[len(points) // 2]
        self.assertGreater(mid[0], 47.45, "Seattle→Tokyo should bend over the north Pacific")

    def test_longitudes_stay_continuous_across_the_antimeridian(self):
        points = great_circle_points(47.45, -122.31, 35.55, 139.78, count=48)
        for (_, lon_a), (_, lon_b) in zip(points, points[1:]):
            self.assertLess(abs(lon_b - lon_a), 180)

    def test_unwrap_longitudes_removes_the_360_jump(self):
        unwrapped = unwrap_longitudes([(0, 179.0), (0, -179.0)])
        self.assertAlmostEqual(unwrapped[1][1], 181.0)

    def test_bearing_between(self):
        self.assertAlmostEqual(bearing_between((0, 0), (10, 0)), 0.0, places=3)
        self.assertAlmostEqual(bearing_between((0, 0), (0, 10)), 90.0, places=3)

    def test_endpoint_latlon_accepts_either_key_style(self):
        self.assertEqual(endpoint_latlon({"lat": 1.5, "lon": 2.5}), (1.5, 2.5))
        self.assertEqual(endpoint_latlon({"latitude": 1.5, "longitude": 2.5}), (1.5, 2.5))
        self.assertIsNone(endpoint_latlon({"lat": "n/a"}))

    def test_plane_polygon_points_along_its_heading(self):
        flat = plane_polygon(100, 100, 90, 10)
        self.assertEqual(len(flat), 8)
        nose_x, nose_y = flat[0], flat[1]
        self.assertGreater(nose_x, 100, "heading 90° should aim the nose east")
        self.assertAlmostEqual(nose_y, 100, places=6)


class LayoutTests(unittest.TestCase):
    def test_every_screen_gets_the_core_cards(self):
        for screen in SCREENS:
            boxes = layout_flightplan(*screen, legs=1)
            for name in ("flight", "times", "journey", "map"):
                self.assertIn(name, boxes, screen)
            self.assertNotIn("itinerary", boxes, screen)

    def test_multi_leg_trip_adds_the_itinerary_card(self):
        for screen in SCREENS:
            boxes = layout_flightplan(*screen, legs=3)
            self.assertIn("itinerary", boxes, screen)

    def test_cards_stay_inside_the_page_chrome_and_never_overlap(self):
        for screen in SCREENS:
            chrome = page_chrome(*screen, timed=True)
            boxes = layout_flightplan(*screen, legs=3)
            for name, (x0, y0, x1, y1) in boxes.items():
                self.assertGreater(x1, x0, f"{name} {screen}")
                self.assertGreater(y1, y0, f"{name} {screen}")
                self.assertGreaterEqual(x0, chrome.content_x - 1, f"{name} {screen}")
                self.assertLessEqual(x1, chrome.content_x + chrome.content_w + 1,
                                     f"{name} {screen}")
                self.assertGreaterEqual(y0, chrome.content_top - 1, f"{name} {screen}")
                self.assertLessEqual(y1, chrome.content_bottom + 1, f"{name} {screen}")
            names = list(boxes)
            for index, name in enumerate(names):
                ax0, ay0, ax1, ay1 = boxes[name]
                for other in names[index + 1:]:
                    bx0, by0, bx1, by1 = boxes[other]
                    overlap = ax0 < bx1 - 1 and bx0 < ax1 - 1 and ay0 < by1 - 1 and by0 < ay1 - 1
                    self.assertFalse(overlap, f"{name} overlaps {other} on {screen}")

    def test_map_is_the_largest_card(self):
        for screen in SCREENS:
            boxes = layout_flightplan(*screen, legs=1)
            areas = {
                name: (box[2] - box[0]) * (box[3] - box[1]) for name, box in boxes.items()
            }
            self.assertEqual(max(areas, key=areas.get), "map", screen)


class MapRequestTests(unittest.TestCase):
    """`show` → `hide` → `_render` bumps the request id; a stale id drops the map."""

    def make_panel(self):
        root = MagicMock()
        shell = MagicMock()
        shell.screen_w, shell.screen_h = 1920, 1080
        shell.content_canvas = MagicMock()
        panel = FlightPlanPanel(root, shell, {})
        return panel

    def test_show_hands_the_map_the_live_request_id(self):
        panel = self.make_panel()
        panel._render = MagicMock()
        seen = []
        panel._start_map = lambda payload, request_id: seen.append(request_id)
        panel.show({"type": "flightplan.flight"})
        self.assertEqual(seen, [panel._request_id])

    def test_hide_invalidates_an_in_flight_fetch(self):
        panel = self.make_panel()
        panel._render = MagicMock()
        before = panel._request_id
        panel.hide()
        self.assertNotEqual(panel._request_id, before)


if __name__ == "__main__":
    unittest.main()
