import unittest
from unittest import mock

from src.display_panels import RoutePlannerPanel
from src.payload_utils import (
    format_local_time_at_offset,
    format_route_distance,
    format_route_duration,
    shorten_route_place_name,
)


class ContentFrameBoundsTests(unittest.TestCase):
    """Route planner must clear the dismiss footer in both orientations."""

    def test_landscape_bottom_clears_dismiss_footer(self):
        from src.design_system import page_chrome

        screen_w, screen_h = 1920, 1080
        top, bottom, footer_clear = RoutePlannerPanel.content_frame_bounds(screen_w, screen_h)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        self.assertGreater(footer_clear, 0)
        self.assertLess(bottom, chrome.content_bottom)
        self.assertEqual(bottom, int(round(chrome.content_bottom)) - footer_clear)
        self.assertGreater(bottom - top, 280)
        # Footer band starts at content_bottom; keep a visible gap.
        self.assertGreaterEqual(chrome.content_bottom - bottom, 14)

    def test_portrait_bottom_clears_dismiss_footer(self):
        from src.design_system import page_chrome

        screen_w, screen_h = 1080, 1920
        top, bottom, footer_clear = RoutePlannerPanel.content_frame_bounds(screen_w, screen_h)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        self.assertLess(bottom, chrome.content_bottom)
        self.assertEqual(bottom, int(round(chrome.content_bottom)) - footer_clear)
        self.assertGreater(bottom - top, 280)
        self.assertLess(top, chrome.content_top)

    def test_tile_boxes_stay_inside_cleared_frame(self):
        screen_w, screen_h = 1920, 1080
        top, bottom, _ = RoutePlannerPanel.content_frame_bounds(screen_w, screen_h)
        tiles_top = top + 120
        tiles_bottom = bottom - 10
        boxes = RoutePlannerPanel._compute_tile_boxes(
            None, 60, 1800, tiles_top, tiles_bottom, False,
        )
        for key, (_x0, y0, _x1, y1) in boxes.items():
            self.assertGreaterEqual(y0, tiles_top - 1, key)
            self.assertLessEqual(y1, tiles_bottom + 1, key)
        self.assertLessEqual(boxes["time"][3], tiles_bottom + 1)


class ComputeTileBoxesTests(unittest.TestCase):
    """`_compute_tile_boxes` only does arithmetic on its arguments — no Tk
    canvas/config access — so it can run against a bare (unconstructed)
    instance, same convention as `QrPanel._build_qr_image`."""

    KEYS = {
        "map",
        "facts_origin",
        "facts_destination",
        "weather_origin",
        "weather_destination",
        "time",
    }

    def _boxes(self, width=800, height=1200, portrait=True):
        return RoutePlannerPanel._compute_tile_boxes(
            None, 0, width, 0, height, portrait,
        )

    def test_returns_all_six_tile_keys(self):
        boxes = self._boxes()
        self.assertEqual(set(boxes.keys()), self.KEYS)

    def test_portrait_tiles_stay_within_bounds_and_dont_overlap_vertically(self):
        width, height = 800, 1400
        boxes = self._boxes(width=width, height=height, portrait=True)
        for key, (x0, y0, x1, y1) in boxes.items():
            self.assertGreaterEqual(x0, -1, key)
            self.assertLessEqual(x1, width + 1, key)
            self.assertGreaterEqual(y0, -1, key)
            self.assertLessEqual(y1, height + 1, key)
            self.assertLess(y0, y1, key)
            self.assertLess(x0, x1, key)

        # map sits above the two tile rows, which sit above the time strip.
        self.assertLessEqual(boxes["map"][3], boxes["facts_origin"][1] + 1)
        self.assertLessEqual(boxes["facts_origin"][3], boxes["weather_origin"][1] + 1)
        self.assertLessEqual(boxes["weather_origin"][3], boxes["time"][1] + 1)

        # facts/weather rows are side-by-side columns, not stacked.
        self.assertAlmostEqual(boxes["facts_origin"][1], boxes["facts_destination"][1])
        self.assertLessEqual(boxes["facts_origin"][2], boxes["facts_destination"][0] + 1)

    def test_landscape_puts_map_in_a_tall_left_column(self):
        width, height = 1400, 800
        boxes = self._boxes(width=width, height=height, portrait=False)
        map_box = boxes["map"]
        # Map spans the full tile height and sits left of the other tiles.
        self.assertAlmostEqual(map_box[1], 0)
        self.assertAlmostEqual(map_box[3], height)
        self.assertLessEqual(map_box[2], boxes["facts_origin"][0] + 1)

    def test_landscape_and_portrait_both_keep_tiles_non_overlapping(self):
        for portrait in (True, False):
            boxes = self._boxes(width=1000, height=1000, portrait=portrait)
            # Every box has positive area.
            for key, (x0, y0, x1, y1) in boxes.items():
                self.assertGreater(x1 - x0, 0, key)
                self.assertGreater(y1 - y0, 0, key)


class ApplyFactsTests(unittest.TestCase):
    """`_apply_facts` draws a small header (the place name) plus a clipped,
    possibly-scrolling body underneath it — long facts should scroll in
    place (reusing the broadcast message's pause/scroll/pause controller)
    instead of overflowing the tile and overlapping the row below it,
    which was the original overlap bug."""

    def _make_panel(self):
        shell = mock.MagicMock()
        shell.content_canvas = mock.MagicMock()
        shell.chip_label_font = mock.MagicMock()
        shell.chip_label_font.metrics.return_value = 20
        shell.forecast_label_font = mock.MagicMock()
        shell.body_font = mock.MagicMock()
        config = {"textColor": "#fff", "mutedTextColor": "#94a3b8"}
        root = mock.MagicMock()
        panel = RoutePlannerPanel(root, shell, config)
        panel.visible = True
        return panel

    def test_apply_facts_draws_header_with_place_name(self):
        panel = self._make_panel()
        with mock.patch("src.display_panels.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 40)
            panel._apply_facts(
                panel._request_id, "facts_origin", "Saratoga Springs",
                {"extract": "Short fact."}, (0, 0, 240, 140),
            )
        _, kwargs = panel.canvas.create_text.call_args_list[0]
        self.assertEqual(kwargs["text"], "Saratoga Springs")

    def test_short_facts_do_not_scroll(self):
        panel = self._make_panel()
        with mock.patch("src.display_panels.tk.Canvas") as canvas_cls:
            # Rendered text height (40px) fits comfortably in the ~90px body.
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 40)
            panel._apply_facts(
                panel._request_id, "facts_origin", "Saratoga Springs",
                {"extract": "Short fact."}, (0, 0, 240, 140),
            )
        scroller = panel._fact_scrollers["facts_origin"]
        self.assertFalse(scroller.needs_scroll)
        self.assertEqual(scroller._state, "idle")

    def test_long_facts_scroll_instead_of_overflowing(self):
        panel = self._make_panel()
        with mock.patch("src.display_panels.tk.Canvas") as canvas_cls:
            # Rendered text height (400px) is far taller than the ~90px body.
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 400)
            panel._apply_facts(
                panel._request_id, "facts_origin", "Saratoga Springs",
                {"extract": "A very long fact. " * 20}, (0, 0, 240, 140),
            )
        scroller = panel._fact_scrollers["facts_origin"]
        self.assertTrue(scroller.needs_scroll)
        self.assertEqual(scroller._state, "start_pause")

    def test_no_facts_available_shows_centered_message_without_a_scroller(self):
        panel = self._make_panel()
        panel._apply_facts(
            panel._request_id, "facts_origin", "Nowhere", None, (0, 0, 240, 140),
        )
        self.assertNotIn("facts_origin", panel._fact_scrollers)
        texts = [kwargs.get("text") for _, kwargs in panel.canvas.create_text.call_args_list]
        self.assertIn("No facts available", texts)

    def test_hide_stops_active_fact_scrollers(self):
        panel = self._make_panel()
        with mock.patch("src.display_panels.tk.Canvas") as canvas_cls:
            canvas_cls.return_value.bbox.return_value = (0, 0, 200, 400)
            panel._apply_facts(
                panel._request_id, "facts_origin", "Saratoga Springs",
                {"extract": "A very long fact. " * 20}, (0, 0, 240, 140),
            )
        scroller = panel._fact_scrollers["facts_origin"]
        panel.hide()
        self.assertEqual(scroller._state, "idle")
        self.assertEqual(panel._fact_scrollers, {})


class RouteFormattingTests(unittest.TestCase):
    def test_format_route_distance_short_trips_keep_one_decimal(self):
        self.assertEqual(format_route_distance(3.4), "3.4 mi")

    def test_format_route_distance_long_trips_round_to_whole_miles(self):
        self.assertEqual(format_route_distance(177.1), "177 mi")

    def test_format_route_distance_handles_missing_value(self):
        self.assertEqual(format_route_distance(None), "…")
        self.assertEqual(format_route_distance("n/a"), "…")

    def test_format_route_duration_hours_and_minutes(self):
        self.assertEqual(format_route_duration(195), "3h 15m")

    def test_format_route_duration_whole_hours_only(self):
        self.assertEqual(format_route_duration(180), "3h")

    def test_format_route_duration_minutes_only(self):
        self.assertEqual(format_route_duration(45), "45m")

    def test_format_route_duration_handles_missing_value(self):
        self.assertEqual(format_route_duration(None), "…")

    def test_shorten_route_place_name_strips_us_country_suffix(self):
        self.assertEqual(
            shorten_route_place_name("Saratoga Springs, Utah, US"),
            "Saratoga Springs, Utah",
        )
        self.assertEqual(
            shorten_route_place_name("Las Vegas, Nevada, United States"),
            "Las Vegas, Nevada",
        )
        self.assertEqual(shorten_route_place_name("Moab"), "Moab")

    def test_format_local_time_at_offset_matches_manual_utc_math(self):
        from datetime import datetime, timedelta, timezone

        label = format_local_time_at_offset(3600 * 5)  # UTC+5
        expected = (datetime.now(timezone.utc) + timedelta(hours=5)).strftime("%I:%M %p").lstrip("0")
        self.assertEqual(label, expected)

    def test_format_local_time_at_offset_adds_extra_minutes_for_an_eta(self):
        from datetime import datetime, timedelta, timezone

        label = format_local_time_at_offset(0, extra_minutes=90)
        expected = (datetime.now(timezone.utc) + timedelta(minutes=90)).strftime("%I:%M %p").lstrip("0")
        self.assertEqual(label, expected)

    def test_format_local_time_at_offset_defaults_missing_offset_to_utc(self):
        from datetime import datetime, timezone

        label = format_local_time_at_offset(None)
        expected = datetime.now(timezone.utc).strftime("%I:%M %p").lstrip("0")
        self.assertEqual(label, expected)


class ProgressiveStatusTests(unittest.TestCase):
    """Progressive UDP updates: names first, then coords, then distance."""

    def test_resolve_status_defaults_to_loading_without_distance(self):
        self.assertEqual(
            RoutePlannerPanel.resolve_status({"origin": {}, "destination": {}}),
            "loading",
        )

    def test_resolve_status_defaults_to_ready_when_distance_present(self):
        self.assertEqual(
            RoutePlannerPanel.resolve_status({"distanceMiles": 177}),
            "ready",
        )

    def test_loading_badge_and_finding_places_copy(self):
        payload = {
            "status": "loading",
            "origin": {"name": "Home"},
            "destination": {"name": "Moab"},
        }
        self.assertEqual(
            RoutePlannerPanel.status_badge_label("loading", "driving"),
            "Looking Up Route",
        )
        self.assertIn(
            "Finding places",
            RoutePlannerPanel.status_stat_text(payload, "loading"),
        )

    def test_failed_badge_and_error_copy(self):
        payload = {"status": "failed", "error": "Could not find one of those places"}
        self.assertEqual(
            RoutePlannerPanel.status_badge_label("failed", "driving"),
            "Route Unavailable",
        )
        self.assertEqual(
            RoutePlannerPanel.status_stat_text(payload, "failed"),
            "Could not find one of those places",
        )

    def test_ready_driving_and_flight_badges(self):
        self.assertEqual(
            RoutePlannerPanel.status_badge_label("ready", "driving"),
            "Driving Estimate",
        )
        self.assertEqual(
            RoutePlannerPanel.status_badge_label("ready", "flight"),
            "Flight-Path Estimate",
        )
        payload = {"distanceMiles": 177.1, "durationMin": 180}
        text = RoutePlannerPanel.status_stat_text(payload, "ready")
        self.assertIn("177", text)
        self.assertIn("about", text)

    def test_map_weather_wait_until_both_places_have_coords(self):
        skeleton = (
            {"name": "Home", "latitude": 40.0, "longitude": -111.0},
            {"name": "Moab"},
        )
        self.assertFalse(RoutePlannerPanel.places_have_coords(*skeleton))
        geocoded = (
            {"name": "Home", "latitude": 40.0, "longitude": -111.0},
            {"name": "Moab", "latitude": 38.57, "longitude": -109.55},
        )
        self.assertTrue(RoutePlannerPanel.places_have_coords(*geocoded))


if __name__ == "__main__":
    unittest.main()
