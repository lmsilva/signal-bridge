import json
import socket
import unittest
from datetime import datetime, timezone

from src.payload_utils import (
    air_quality_band,
    air_quality_band_label,
    format_air_quality_location,
    format_duration,
    format_indoor_location,
    format_timer_clock,
    format_timer_set_label,
    format_weather_location,
    indoor_comfort_band,
    is_display_payload,
    normalize_condition,
    parse_spoken_air_quality,
    parse_spoken_indoor,
    parse_spoken_weather,
    resolve_display_type,
    timer_detail_line,
    timer_title,
    title_for_display_type,
)


class PayloadUtilsTests(unittest.TestCase):
    def test_resolve_legacy_broadcast(self):
        payload = {"message": "hello", "sender": "Kitchen"}
        self.assertEqual(resolve_display_type(payload), "broadcast")

    def test_resolve_typed_payloads(self):
        self.assertEqual(resolve_display_type({"type": "time.query"}), "time.query")
        self.assertEqual(resolve_display_type({"type": "weather.query"}), "weather.query")
        self.assertEqual(resolve_display_type({"type": "indoor-temperature.query"}), "indoor-temperature.query")
        self.assertEqual(resolve_display_type({"type": "air-quality.query"}), "air-quality.query")
        self.assertEqual(resolve_display_type({"type": "timer.snapshot", "timers": []}), "timer.snapshot")

    def test_is_display_payload(self):
        self.assertTrue(is_display_payload({"type": "time.query", "device": "Kitchen"}))
        self.assertFalse(is_display_payload({"version": 2}))

    def test_title_for_display_type(self):
        self.assertEqual(title_for_display_type("weather.query"), ("Alexa", "Weather"))
        self.assertEqual(title_for_display_type("indoor-temperature.query"), ("Alexa", "Indoor"))
        self.assertEqual(title_for_display_type("air-quality.query"), ("Alexa", "Air Quality"))

    def test_air_quality_helpers(self):
        self.assertEqual(format_air_quality_location({"label": "Main Floor"}), "Main Floor")
        self.assertEqual(air_quality_band(90), "good")
        self.assertEqual(air_quality_band(40), "moderate")
        self.assertEqual(air_quality_band_label("fair"), "Fair")
        parsed = parse_spoken_air_quality("The main floor airquality is 40 out of 100")
        self.assertEqual(parsed["iaq_score"], 40)
        self.assertEqual(parsed["band"], "moderate")

    def test_format_indoor_location(self):
        self.assertEqual(format_indoor_location({"label": "Top Floor"}), "Top Floor")
        self.assertEqual(format_indoor_location({"entity": "top floor"}), "top floor")

    def test_indoor_comfort_band(self):
        self.assertEqual(indoor_comfort_band(67), "cold")
        self.assertEqual(indoor_comfort_band(70), "comfortable")
        self.assertEqual(indoor_comfort_band(75), "hot")

    def test_parse_spoken_indoor(self):
        parsed = parse_spoken_indoor("It's 76 degrees on the top floor")
        self.assertEqual(parsed["temp_f"], 76)
        humidity = parse_spoken_indoor("The humidity of top floor is 16%")
        self.assertEqual(humidity["humidity"], 16)
        decimal = parse_spoken_indoor("oh it's 72.5 degrees on Room 16's room")
        self.assertAlmostEqual(decimal["temp_f"], 72.5)
        self.assertEqual(decimal["location_phrase"], "Room 16's room")

    def test_format_duration(self):
        self.assertEqual(format_duration(125), "2:05")
        self.assertEqual(format_duration(3661), "1:01:01")

    def test_format_weather_location(self):
        self.assertEqual(
            format_weather_location({"query": "local", "resolvedName": None}),
            "Your area",
        )
        self.assertEqual(
            format_weather_location({"query": "local", "resolvedName": "Home"}),
            "Home",
        )

    def test_parse_spoken_weather(self):
        parsed = parse_spoken_weather(
            "Currently 60 degrees and mostly cloudy, with a high of 68 and a low of 52."
        )
        self.assertEqual(parsed["temp_f"], 60)
        self.assertEqual(parsed["condition"], "mostly_cloudy")
        self.assertIn("60 degrees", parsed["summary"])

    def test_format_timer_labels(self):
        self.assertEqual(format_timer_set_label(300), "5 min timer")
        self.assertEqual(format_timer_clock(300), "5:00")
        self.assertEqual(format_timer_clock(254), "4:14")

    def test_normalize_condition(self):
        self.assertEqual(normalize_condition("mostly cloudy"), "cloudy")

    def test_timer_title_and_detail(self):
        self.assertEqual(timer_title({"label": "Pizza", "durationSec": 300}), "Pizza")
        self.assertEqual(timer_title({"durationSec": 300}), "5 min timer")
        self.assertEqual(
            timer_detail_line({"durationSec": 300}, "Kitchen Echo", finished=True),
            "Kitchen Echo · 5:00 timer — finished",
        )


if __name__ == "__main__":
    unittest.main()
