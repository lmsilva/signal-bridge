import json
import socket
import unittest
from datetime import datetime, timezone

from src.payload_utils import (
    format_duration,
    format_timer_clock,
    format_timer_set_label,
    format_weather_location,
    is_display_payload,
    normalize_condition,
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
        self.assertEqual(resolve_display_type({"type": "timer.snapshot", "timers": []}), "timer.snapshot")

    def test_is_display_payload(self):
        self.assertTrue(is_display_payload({"type": "time.query", "device": "Kitchen"}))
        self.assertFalse(is_display_payload({"version": 2}))

    def test_title_for_display_type(self):
        self.assertEqual(title_for_display_type("weather.query"), ("Alexa", "Weather"))

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
