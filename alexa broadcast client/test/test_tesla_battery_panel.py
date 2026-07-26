import unittest

from src.display_panels import TeslaBatteryPanel


class TeslaBatteryBarHeightTests(unittest.TestCase):
    """`battery_bar_height` is a pure @staticmethod — no Tk root needed."""

    def test_taller_than_percent_font_linespace(self):
        # section_title_font linespace is typically ~36–42; old bar was 32–36.
        for linespace in (28, 36, 42, 48):
            for portrait in (True, False):
                h = TeslaBatteryPanel.battery_bar_height(linespace, portrait=portrait)
                self.assertGreaterEqual(h, linespace + 22)
                self.assertGreaterEqual(h, 52)

    def test_portrait_floor_is_at_least_landscape(self):
        self.assertGreaterEqual(
            TeslaBatteryPanel.battery_bar_height(20, portrait=True),
            TeslaBatteryPanel.battery_bar_height(20, portrait=False),
        )


if __name__ == "__main__":
    unittest.main()
