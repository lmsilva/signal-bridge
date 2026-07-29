import unittest

from src.design_system import GOOD, WARN, ALERT
from src.display_panels import AirQualityPanel


class AirQualityDisplayBandTests(unittest.TestCase):
    def test_display_band_cutoffs(self):
        self.assertEqual(AirQualityPanel.display_band(98), "good")
        self.assertEqual(AirQualityPanel.display_band(65), "good")
        self.assertEqual(AirQualityPanel.display_band(64), "fair")
        self.assertEqual(AirQualityPanel.display_band(35), "fair")
        self.assertEqual(AirQualityPanel.display_band(34), "poor")
        self.assertEqual(AirQualityPanel.display_band(15), "poor")
        self.assertEqual(AirQualityPanel.display_band(14), "severe")
        self.assertEqual(AirQualityPanel.display_band(0), "severe")

    def test_moderate_payload_band_maps_to_fair(self):
        self.assertEqual(AirQualityPanel.display_band(None, "moderate"), "fair")

    def test_band_colors(self):
        self.assertEqual(AirQualityPanel.band_color("good"), GOOD)
        self.assertEqual(AirQualityPanel.band_color("fair"), WARN)
        self.assertEqual(AirQualityPanel.band_color("poor"), ALERT)
        self.assertEqual(AirQualityPanel.band_color("severe"), ALERT)

    def test_band_segments_sum_to_100(self):
        total = sum(weight for _name, weight, _label in AirQualityPanel.BAND_SEGMENTS)
        self.assertEqual(total, 100)
        # Scale reads good→severe left to right (not inverted 100→0 axis alone).
        self.assertEqual(AirQualityPanel.BAND_SEGMENTS[0][0], "good")
        self.assertEqual(AirQualityPanel.BAND_SEGMENTS[-1][0], "severe")

    def test_rating_word(self):
        self.assertEqual(AirQualityPanel.rating_word("good"), "Good")
        self.assertEqual(AirQualityPanel.rating_word("severe"), "Severe")


if __name__ == "__main__":
    unittest.main()
