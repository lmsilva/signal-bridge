import unittest

from src.display_panels import WeatherPanel


class WeatherPanelHelperTests(unittest.TestCase):
    def test_temp_gradient_color_spans_cold_to_hot(self):
        cold = WeatherPanel._temp_gradient_color(64, 64, 106)
        hot = WeatherPanel._temp_gradient_color(106, 64, 106)
        mid = WeatherPanel._temp_gradient_color(85, 64, 106)
        self.assertTrue(cold.startswith("#"))
        self.assertTrue(hot.startswith("#"))
        self.assertNotEqual(cold, hot)
        self.assertNotEqual(mid, cold)

    def test_weather_context_extracts_temp_and_condition(self):
        panel = WeatherPanel.__new__(WeatherPanel)
        ctx = panel._weather_context({
            "spokenResponse": "It's currently 84 degrees and cloudy.",
            "weather": {
                "current": {"temperatureF": 90, "condition": "sunny", "humidity": 20},
                "next24Hours": [{"precipitationProbability": 5}],
                "next7Days": [],
            },
            "location": {"city": "Saratoga Springs", "name": "Saratoga Springs"},
        })
        self.assertIsNotNone(ctx["temp_f"])
        self.assertTrue(ctx["updated_label"])


if __name__ == "__main__":
    unittest.main()
