import unittest
from unittest import mock

from src.display_panels import TeslaBatteryPanel, TeslaDashboardPanel


class TeslaBatteryBarHeightTests(unittest.TestCase):
    """`battery_bar_height` is a pure @staticmethod — no Tk root needed."""

    def test_landscape_gauge_height_is_fixed(self):
        for linespace in (28, 36, 42, 48):
            self.assertEqual(
                TeslaBatteryPanel.battery_bar_height(linespace, portrait=False), 56,
            )

    def test_portrait_gauge_height_is_fixed(self):
        for linespace in (20, 36, 48):
            self.assertEqual(
                TeslaBatteryPanel.battery_bar_height(linespace, portrait=True), 72,
            )


class TeslaDashboardCarCardLayoutTests(unittest.TestCase):
    """Landscape centers the car+badge stack; portrait stays top-padded."""

    def test_landscape_centers_when_tile_is_taller_than_content(self):
        top = TeslaDashboardPanel.car_card_content_top(
            100, 400, 220, center_vertically=True, pad=12,
        )
        self.assertEqual(top, 100 + (400 - 220) // 2)

    def test_portrait_stays_top_padded(self):
        top = TeslaDashboardPanel.car_card_content_top(
            100, 400, 220, center_vertically=False, pad=12,
        )
        self.assertEqual(top, 112)

    def test_landscape_falls_back_to_pad_when_block_fills_tile(self):
        top = TeslaDashboardPanel.car_card_content_top(
            50, 200, 190, center_vertically=True, pad=12,
        )
        self.assertEqual(top, 62)


class TeslaBatteryRangeLabelTests(unittest.TestCase):
    def _make_panel(self):
        panel = TeslaBatteryPanel.__new__(TeslaBatteryPanel)
        panel._item_ids = []
        panel._track = lambda item_id: item_id
        panel.canvas = mock.MagicMock()
        panel.shell = mock.MagicMock()
        panel.shell.section_title_font = mock.MagicMock()
        panel.shell.section_title_font.metrics.return_value = 36
        panel.shell.body_font = mock.MagicMock()
        panel.shell.body_font.metrics.return_value = 22
        panel.shell.forecast_label_font = mock.MagicMock()
        panel.CARD = "#141F35"
        panel.INNER = "#0a111e"
        return panel

    def test_draw_battery_specs_shows_rounded_miles(self):
        panel = self._make_panel()
        with mock.patch.object(panel, "_draw_ticked_gauge"):
            panel._draw_battery_specs(
                0, 0, 400, "63%", 63, "#6EE7A8",
                {"batteryRange": 161.56}, portrait=True,
            )
        texts = [
            call.kwargs.get("text")
            for call in panel.canvas.create_text.call_args_list
            if call.kwargs.get("text")
        ]
        self.assertIn("162 mi", texts)
        self.assertNotIn("— mi", texts)

    def test_draw_battery_specs_uses_range_miles_when_battery_range_null(self):
        panel = self._make_panel()
        with mock.patch.object(panel, "_draw_ticked_gauge"):
            panel._draw_battery_specs(
                0, 0, 400, "63%", 63, "#6EE7A8",
                {"batteryRange": None, "rangeMiles": 188}, portrait=True,
            )
        texts = [
            call.kwargs.get("text")
            for call in panel.canvas.create_text.call_args_list
            if call.kwargs.get("text")
        ]
        self.assertIn("188 mi", texts)

    def test_draw_battery_specs_placeholder_when_range_missing(self):
        panel = self._make_panel()
        with mock.patch.object(panel, "_draw_ticked_gauge"):
            panel._draw_battery_specs(
                0, 0, 400, "63%", 63, "#6EE7A8",
                {"percent": 63}, portrait=True,
            )
        texts = [
            call.kwargs.get("text")
            for call in panel.canvas.create_text.call_args_list
            if call.kwargs.get("text")
        ]
        self.assertIn("— mi", texts)


class TeslaBatteryStatusBitsTests(unittest.TestCase):
    def _make_panel(self):
        panel = TeslaBatteryPanel.__new__(TeslaBatteryPanel)
        panel.config = {
            "accentColor": "#5FD0FF",
            "mutedTextColor": "#A4ACC0",
        }
        panel.CARD = "#141F35"
        panel.CARD_EDGE = "#264060"
        panel.AMBER = "#F5C453"
        panel.AMBER_BG = "#3a2605"
        return panel

    def test_status_bits_stale_refreshing_uses_accent_not_amber(self):
        panel = self._make_panel()
        battery = {
            "refreshing": True,
            "freshnessSec": 90,
            "cachedAt": "2026-07-08T20:30:00+00:00",
        }
        bits = panel._status_bits(battery, stale=True, limit_reset="", charging_label="", is_error=False)
        self.assertEqual(bits[0]["kind"], "pill")
        self.assertIn("updating", bits[0]["text"])
        self.assertEqual(bits[0]["fg"], panel.config["accentColor"])
        self.assertEqual(bits[1]["kind"], "legend")

    def test_status_bits_stale_only_uses_amber_warning(self):
        panel = self._make_panel()
        battery = {
            "freshnessSec": 120,
            "cachedAt": "2026-07-08T20:30:00+00:00",
            "staleReason": "Tesla unreachable",
        }
        bits = panel._status_bits(battery, stale=True, limit_reset="", charging_label="", is_error=False)
        self.assertEqual(bits[0]["kind"], "pill")
        self.assertIn("cached", bits[0]["text"])
        self.assertEqual(bits[0]["fg"], panel.AMBER)
        self.assertEqual(bits[1]["fill"], panel.AMBER)


if __name__ == "__main__":
    unittest.main()
