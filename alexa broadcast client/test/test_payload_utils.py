import json
import socket
import unittest
from datetime import datetime, timezone

from src.payload_utils import (
    air_quality_band,
    air_quality_band_label,
    format_air_quality_location,
    battery_level_color,
    format_battery_percent,
    format_limit_reset_time,
    format_freshness_sec,
    format_cached_time_label,
    format_charge_time_to_full,
    format_tesla_media_volume_label,
    format_duration,
    format_indoor_location,
    format_timer_clock,
    format_timer_set_label,
    format_weather_location,
    indoor_comfort_band,
    is_accepted_payload,
    is_command_payload,
    is_display_payload,
    normalize_condition,
    parse_spoken_air_quality,
    parse_spoken_battery_percent,
    parse_spoken_indoor,
    parse_spoken_weather,
    payload_targets_display,
    processing_stage_message,
    resolve_display_type,
    resolve_time_display_datetime,
    sample_hourly_indices,
    timer_detail_line,
    timer_title,
    title_for_display_type,
    title_for_payload,
    voc_band_label,
    DISPLAY_TYPES,
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
        self.assertEqual(resolve_display_type({"type": "alarm.snapshot", "alarms": []}), "alarm.snapshot")
        self.assertEqual(resolve_display_type({"type": "tesla-battery.query"}), "tesla-battery.query")
        self.assertEqual(resolve_display_type({"type": "tesla-dashboard.query"}), "tesla-dashboard.query")
        self.assertEqual(resolve_display_type({"type": "vivint-alarm.query"}), "vivint-alarm.query")
        self.assertEqual(resolve_display_type({"type": "alexa-notifications.query"}), "alexa-notifications.query")

    def test_battery_helpers(self):
        self.assertEqual(format_battery_percent(78), "78%")
        self.assertEqual(parse_spoken_battery_percent("your battery is 80 percent"), 80)
        self.assertEqual(battery_level_color(0), "#ef4444")
        self.assertEqual(battery_level_color(100), "#22c55e")
        self.assertEqual(title_for_display_type("tesla-battery.query"), ("Alexa", "Tesla Battery"))
        self.assertEqual(title_for_display_type("vivint-alarm.query"), ("Alexa", "Security"))
        self.assertEqual(title_for_display_type("alexa-notifications.query"), ("Alexa", "Notifications"))
        self.assertEqual(title_for_display_type("alarm.snapshot"), ("Alexa", "Alarms"))
        self.assertRegex(
            format_limit_reset_time("2026-07-08T20:30:00+00:00"),
            r"Try again at",
        )
        self.assertEqual(format_limit_reset_time(""), "")
        self.assertEqual(format_limit_reset_time(None), "")
        self.assertEqual(format_freshness_sec(45), "45s ago")
        self.assertEqual(format_freshness_sec(125), "2m ago")
        self.assertEqual(format_freshness_sec(7200), "2h ago")
        self.assertRegex(format_cached_time_label("2026-07-08T20:30:00+00:00"), r"\d")
        self.assertEqual(format_charge_time_to_full(45), "45 min to full")
        self.assertEqual(format_charge_time_to_full(394), "6h 34m to full")
        self.assertEqual(format_charge_time_to_full(120), "2h to full")
        self.assertEqual(format_tesla_media_volume_label({"volumePercent": 21}), "21% volume")
        self.assertEqual(format_tesla_media_volume_label({"volume": 2.3333}), "21% volume")
        self.assertEqual(format_tesla_media_volume_label({"volumePercent": 50}), "50% volume")

    def test_processing_payload_type_and_title(self):
        self.assertEqual(
            resolve_display_type({"type": "request.processing"}), "request.processing"
        )
        self.assertEqual(
            title_for_display_type("request.processing"), ("Alexa", "Working on it")
        )

    def test_processing_stage_message_picks_latest_reached_stage(self):
        stages = [
            {"afterSec": 0, "message": "Request received"},
            {"afterSec": 5, "message": "Fetching data"},
            {"afterSec": 12, "message": "Still working"},
        ]
        self.assertEqual(processing_stage_message(stages, 0), "Request received")
        self.assertEqual(processing_stage_message(stages, 4.9), "Request received")
        self.assertEqual(processing_stage_message(stages, 5), "Fetching data")
        self.assertEqual(processing_stage_message(stages, 30), "Still working")
        self.assertEqual(processing_stage_message([], 10), "")
        self.assertEqual(processing_stage_message(None, 10), "")
        self.assertEqual(processing_stage_message([{"bogus": True}], 10), "")

    def test_resolve_time_display_prefers_parsed_components(self):
        payload = {
            "parsedTime": {
                "iso": "2026-07-10T22:15:00.000Z",
                "hour": 22,
                "minute": 15,
                "second": 0,
            }
        }
        dt = resolve_time_display_datetime(payload)
        self.assertEqual((dt.hour, dt.minute, dt.second), (22, 15, 0))

    def test_resolve_time_display_ignores_activity_timestamp(self):
        payload = {
            "timestamp": "2026-07-10T22:15:00.000Z",
        }
        dt = resolve_time_display_datetime(payload)
        now = datetime.now().astimezone()
        self.assertEqual(dt.date(), now.date())
        self.assertLess(abs((dt - now).total_seconds()), 2)

    def test_tesla_fleet_battery_payload_fields(self):
        payload = {
            "type": "tesla-battery.query",
            "battery": {
                "percent": None,
                "status": "rate_limited",
                "error": "Tesla rate limit reached",
                "limitResetAt": "2026-07-08T20:30:00+00:00",
                "source": "fleet-api",
            },
        }
        self.assertEqual(resolve_display_type(payload), "tesla-battery.query")
        self.assertRegex(
            format_limit_reset_time(payload["battery"]["limitResetAt"]),
            r"Try again at",
        )

    def test_tesla_fleet_battery_ok_charging_label(self):
        payload = {
            "type": "tesla-battery.query",
            "battery": {
                "percent": 78,
                "status": "ok",
                "source": "fleet-api",
                "chargingLabel": "Charging",
            },
        }
        self.assertEqual(resolve_display_type(payload), "tesla-battery.query")
        self.assertEqual(payload["battery"]["chargingLabel"], "Charging")
        self.assertEqual(payload["battery"]["percent"], 78)

    def test_alarm_helpers(self):
        from src.payload_utils import (
            alarm_detail_line,
            alarm_title,
            alarm_until_line,
            format_alarm_time,
            resolve_alarm_trigger_time,
        )

        alarm = {
            "label": "Wake up",
            "triggerTime": "2026-07-07T07:00:00+00:00",
            "remainingSec": 3660,
        }
        self.assertEqual(alarm_title(alarm), "Wake up")
        self.assertIn("on Kitchen Echo", alarm_detail_line(alarm, "Kitchen Echo"))
        self.assertEqual(alarm_until_line(alarm), "in 1h 1m")
        self.assertRegex(format_alarm_time(alarm["triggerTime"]), r"\d:\d\d")

    def test_resolve_alarm_trigger_time_from_remaining_sec(self):
        from src.payload_utils import format_alarm_time, resolve_alarm_trigger_time

        alarm = {"remainingSec": 3600}
        resolved = resolve_alarm_trigger_time(alarm)
        self.assertIsNotNone(resolved)
        self.assertNotEqual(format_alarm_time(resolved), "—")

    def test_is_display_payload(self):
        self.assertTrue(is_display_payload({"type": "time.query", "device": "Kitchen"}))
        self.assertFalse(is_display_payload({"version": 2}))
        # Commands are not display payloads, but they must still be accepted
        # by the UDP listener (is_accepted_payload).
        self.assertFalse(is_display_payload({"type": "web.open", "web": {"url": "https://x"}}))

    def test_command_payloads_are_accepted(self):
        for command_type in (
            "web.open",
            "web.close",
            "system.command",
            "input.pointer",
            "input.key",
            "display.discover",
        ):
            payload = {"type": command_type, "version": 2}
            self.assertTrue(is_command_payload(payload), command_type)
            self.assertTrue(is_accepted_payload(payload), command_type)
            self.assertFalse(is_display_payload(payload), command_type)

    def test_payload_targets_display(self):
        self.assertTrue(payload_targets_display({"type": "web.open"}, "disp-1"))
        self.assertTrue(
            payload_targets_display({"type": "web.open", "target": {"all": True}}, "disp-1")
        )
        self.assertTrue(
            payload_targets_display({"type": "web.open", "target": {"id": "disp-1"}}, "disp-1")
        )
        self.assertFalse(
            payload_targets_display({"type": "web.open", "target": {"id": "disp-2"}}, "disp-1")
        )
        self.assertTrue(
            payload_targets_display(
                {"type": "display.discover", "target": {"id": "other"}}, "disp-1"
            )
        )

    def test_title_for_display_type(self):
        self.assertEqual(title_for_display_type("weather.query"), ("Alexa", "Weather"))
        self.assertEqual(title_for_display_type("indoor-temperature.query"), ("Alexa", "Indoor"))
        self.assertEqual(title_for_display_type("air-quality.query"), ("Alexa", "Air Quality"))
        self.assertEqual(
            title_for_display_type("display.auth"),
            ("Unlock", "Enter this PIN on your phone"),
        )
        self.assertEqual(
            title_for_payload({"type": "display.auth", "auth": {"status": "ok"}}),
            ("Unlock", "Authenticated"),
        )
        self.assertEqual(
            title_for_payload({"type": "display.auth", "auth": {"pin": "1234"}}),
            ("Unlock", "Enter this PIN on your phone"),
        )

    def test_qr_display_is_a_recognized_display_type(self):
        self.assertIn("qr.display", DISPLAY_TYPES)
        self.assertTrue(is_display_payload({"type": "qr.display", "qr": {"content": "https://example.com"}}))
        self.assertEqual(resolve_display_type({"type": "qr.display"}), "qr.display")
        self.assertEqual(title_for_display_type("qr.display"), ("Signal", "QR Code"))

    def test_guest_photobooth_is_a_recognized_display_type(self):
        self.assertIn("guest.photobooth", DISPLAY_TYPES)
        self.assertTrue(is_display_payload({"type": "guest.photobooth"}))
        self.assertEqual(resolve_display_type({"type": "guest.photobooth"}), "guest.photobooth")
        self.assertEqual(
            title_for_display_type("guest.photobooth"),
            ("Signal", "Guest Photo Booth"),
        )

    def test_photo_slideshow_is_a_recognized_display_type(self):
        self.assertIn("photo.slideshow", DISPLAY_TYPES)
        self.assertTrue(is_display_payload({"type": "photo.slideshow", "slideshow": {"photos": []}}))
        self.assertEqual(resolve_display_type({"type": "photo.slideshow"}), "photo.slideshow")
        self.assertEqual(title_for_display_type("photo.slideshow"), ("Signal", "Shared Photos"))

    def test_input_text_is_a_recognized_command_type(self):
        self.assertTrue(is_command_payload({"type": "input.text", "text": {"value": "hi"}}))
        self.assertFalse(is_display_payload({"type": "input.text"}))

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
        self.assertTrue(parsed.get("temp_is_current"))
        self.assertEqual(parsed["condition"], "mostly_cloudy")
        self.assertIn("60 degrees", parsed["summary"])

    def test_parse_spoken_weather_forecast_numbers_not_marked_current(self):
        parsed = parse_spoken_weather("Tonight you can expect a low of 62 degrees.")
        self.assertEqual(parsed["temp_f"], 62)
        self.assertFalse(parsed.get("temp_is_current", False))

    def test_normalize_condition_clear_night(self):
        self.assertEqual(normalize_condition("clear-night"), "clear-night")
        self.assertEqual(normalize_condition("clear_night"), "clear-night")
        self.assertEqual(normalize_condition("clear"), "sunny")

    def test_voc_band_label(self):
        self.assertEqual(voc_band_label(1), "Low")
        self.assertEqual(voc_band_label(50), "Elevated")
        self.assertEqual(voc_band_label(90), "High")

    def test_sample_hourly_indices_spans_full_window(self):
        self.assertEqual(sample_hourly_indices(24, 6), [0, 5, 9, 14, 18, 23])
        self.assertEqual(sample_hourly_indices(24, 1), [0])

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
