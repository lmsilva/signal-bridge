import unittest

from src.main import BroadcastClientApp


class MainDisplayRoutingTests(unittest.TestCase):
    def test_timer_snapshot_detected(self):
        self.assertTrue(BroadcastClientApp._is_timer_snapshot({"type": "timer.snapshot"}))
        self.assertFalse(BroadcastClientApp._is_timer_snapshot({"type": "broadcast"}))

    def test_build_fired_timer_payload(self):
        payload = {
            "type": "timer.snapshot",
            "displaySeconds": 120,
            "event": {"kind": "started"},
            "timers": [{"label": "Pizza", "durationSec": 300, "device": "Kitchen Echo"}],
        }
        fired = BroadcastClientApp._build_fired_timer_payload(payload, payload["timers"][0])
        self.assertEqual(fired["event"]["kind"], "fired")
        self.assertEqual(fired["timers"][0]["remainingSec"], 0)
        self.assertEqual(fired["timers"][0]["status"], "OFF")
        self.assertEqual(fired["event"]["timer"]["label"], "Pizza")

    def test_fired_payload_has_content_without_timers_list(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "fired", "timer": {"label": "Pizza"}},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_empty_list_snapshot_shown(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "list"},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_cancelled_empty_snapshot_shown(self):
        payload = {
            "type": "timer.snapshot",
            "event": {"kind": "cancelled"},
            "timers": [],
        }
        self.assertTrue(BroadcastClientApp._timer_payload_has_content(payload))

    def test_alarm_snapshot_detected(self):
        self.assertTrue(BroadcastClientApp._is_alarm_snapshot({"type": "alarm.snapshot"}))
        self.assertFalse(BroadcastClientApp._is_alarm_snapshot({"type": "timer.snapshot"}))

    def test_empty_alarm_list_snapshot_shown(self):
        payload = {
            "type": "alarm.snapshot",
            "trigger": "show-alarms",
            "event": {"kind": "list"},
            "alarms": [],
        }
        self.assertTrue(BroadcastClientApp._alarm_payload_has_content(payload))

    def test_alarm_set_snapshot_shown(self):
        payload = {
            "type": "alarm.snapshot",
            "event": {"kind": "started"},
            "alarms": [{"amazonId": "alarm-1", "device": "Kitchen Echo"}],
        }
        self.assertTrue(BroadcastClientApp._alarm_payload_has_content(payload))

    def test_qr_display_is_shown(self):
        self.assertIn("qr.display", BroadcastClientApp.DISPLAY_TYPES)
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        self.assertTrue(
            app._should_show({"type": "qr.display", "qr": {"qrType": "url", "content": "https://example.com"}})
        )

    def test_photo_slideshow_is_shown(self):
        self.assertIn("photo.slideshow", BroadcastClientApp.DISPLAY_TYPES)
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        self.assertTrue(
            app._should_show({"type": "photo.slideshow", "slideshow": {"photos": ["https://nas/a.jpg"]}})
        )

    def test_input_text_is_a_command_not_a_display_type(self):
        self.assertIn("input.text", BroadcastClientApp.COMMAND_TYPES)
        self.assertNotIn("input.text", BroadcastClientApp.DISPLAY_TYPES)

    def test_new_payload_replaces_active_display(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.display_active = True
        app.overlay = type(
            "Overlay",
            (),
            {"visible": True, "advance": lambda *args: None, "show": lambda *args: None},
        )()
        app._on_display_closed = lambda: None

        called = {"advance": False}

        def advance(payload, seconds):
            called["advance"] = True
            self.assertEqual(payload["type"], "weather.query")
            self.assertEqual(seconds, 60)

        app.overlay.advance = advance
        app._show_payload({"type": "weather.query", "displaySeconds": 60}, 60)
        self.assertTrue(called["advance"])


if __name__ == "__main__":
    unittest.main()
