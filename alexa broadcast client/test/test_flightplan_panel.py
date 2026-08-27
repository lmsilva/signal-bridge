"""Flight Plan panel layout helpers."""

import unittest

from src.flightplan_panel import (
    airport_detail,
    format_as_of,
    format_flight_number,
    format_route,
    layout_bands,
    status_color,
)


class FlightplanPanelTests(unittest.TestCase):
    def test_format_flight_number_spaced(self):
        self.assertEqual(format_flight_number("DL", "167"), "DL 167")

    def test_format_route(self):
        route = format_route({"iata": "SLC"}, {"iata": "NRT"})
        self.assertEqual(route, "SLC → NRT")

    def test_format_as_of(self):
        self.assertTrue(format_as_of("2026-09-10T10:42:00").startswith("as of"))

    def test_status_color_warn(self):
        payload = {"status": {"colorToken": "warn"}}
        self.assertEqual(status_color(payload), "#F5C453")

    def test_layout_bands_portrait_has_stage(self):
        bands = layout_bands(1080, 1920, portrait=True)
        self.assertIn("stage", bands)
        self.assertGreater(bands["stage"][3], bands["stage"][1])

    def test_visitor_depart_shows_origin(self):
        flight = {
            "origin": {"iata": "LAX"},
            "destination": {"iata": "SLC"},
            "scheduled": {"departure": "2026-09-10T10:00:00"},
            "latest": {"departure": {"scheduledTime": {"local": "2026-09-10T10:00:00"}}},
        }
        _, line = airport_detail("DEPART", flight, "depart", "visitor")
        self.assertIn("LAX", line)


if __name__ == "__main__":
    unittest.main()
