import unittest
from datetime import datetime, timezone

from src.payload_utils import normalize_condition
from src.weather_fetch import (
    extract_named_location,
    has_forecast_data,
    normalize_transcript,
    resolve_location_for_fetch,
    weather_code_to_condition,
)


class WeatherFetchTests(unittest.TestCase):
    def test_normalize_transcript_handles_curly_apostrophe(self):
        self.assertEqual(normalize_transcript("what\u2019s the weather"), "what's the weather")

    def test_weather_code_to_condition(self):
        self.assertEqual(weather_code_to_condition(0), "sunny")
        self.assertEqual(weather_code_to_condition(3), "cloudy")
        self.assertEqual(weather_code_to_condition(63), "rainy")
        self.assertEqual(weather_code_to_condition(71), "snowy")
        self.assertEqual(weather_code_to_condition(95), "stormy")

    def test_has_forecast_data(self):
        self.assertFalse(has_forecast_data(None))
        self.assertFalse(has_forecast_data({"current": {"temperatureF": 60}}))
        self.assertTrue(
            has_forecast_data({"next24Hours": [{"time": "2026-06-28T12:00"}], "next7Days": [{"date": "2026-06-28"}]})
        )

    def test_resolve_location_uses_default_coordinates(self):
        resolved = resolve_location_for_fetch(
            {"scope": "local", "query": "local"},
            {"name": "Home", "latitude": 40.0, "longitude": -111.0},
        )
        self.assertEqual(resolved["latitude"], 40.0)
        self.assertEqual(resolved["longitude"], -111.0)

    def test_extract_named_location_from_spoken_response(self):
        self.assertEqual(
            extract_named_location("Currently in New York it's 65 degrees and sunny"),
            "New York",
        )
        self.assertEqual(
            extract_named_location("what is the weather", "Currently in New York it is 65 degrees"),
            "New York",
        )

    def test_resolve_location_does_not_use_default_for_named_city(self):
        resolved = resolve_location_for_fetch(
            {"scope": "local", "query": "Home", "latitude": 40.0, "longitude": -111.0},
            {"name": "Home", "latitude": 40.0, "longitude": -111.0},
            spoken_response="Currently in New York it's 65 degrees and sunny",
            query_text="what is the weather",
        )
        self.assertIsNotNone(resolved)
        self.assertIn("New York", resolved.get("resolvedName", ""))
        self.assertNotAlmostEqual(resolved["latitude"], 40.0, places=1)

    def test_hourly_start_index_handles_timezoneless_api_times(self):
        from datetime import timedelta
        from src.weather_fetch import _hourly_start_index

        now = datetime.now(timezone.utc)
        times = [
            (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:00"),
            (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:00"),
            (now + timedelta(hours=1)).strftime("%Y-%m-%dT%H:00"),
        ]
        self.assertEqual(_hourly_start_index(times), 2)
        self.assertEqual(normalize_condition("windy"), "windy")


if __name__ == "__main__":
    unittest.main()
