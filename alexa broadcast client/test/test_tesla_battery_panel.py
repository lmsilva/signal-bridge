import unittest

from src.display_panels import TeslaBatteryPanel


class TeslaBatteryBarHeightTests(unittest.TestCase):
    """`battery_bar_height` is a pure @staticmethod — no Tk root needed."""

    def test_flat_track_is_compact(self):
        # Percent label sits above the bar; the track itself stays thin.
        for linespace in (28, 36, 42, 48):
            for portrait in (True, False):
                h = TeslaBatteryPanel.battery_bar_height(linespace, portrait=portrait)
                self.assertLessEqual(h, 32)
                self.assertGreaterEqual(h, 20)

    def test_portrait_floor_is_at_least_landscape(self):
        self.assertGreaterEqual(
            TeslaBatteryPanel.battery_bar_height(20, portrait=True),
            TeslaBatteryPanel.battery_bar_height(20, portrait=False),
        )


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
