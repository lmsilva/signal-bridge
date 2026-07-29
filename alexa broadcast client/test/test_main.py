import unittest
from unittest import mock

from src.main import BroadcastClientApp, _make_console_streams_unicode_safe


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

    def test_guest_photobooth_is_shown(self):
        self.assertIn("guest.photobooth", BroadcastClientApp.DISPLAY_TYPES)
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        self.assertTrue(app._should_show({"type": "guest.photobooth"}))

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
            {
                "visible": True,
                "active_display_type": "weather.query",
                "advance": lambda *args: None,
                "show": lambda *args: None,
            },
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

    def test_slideshow_ignores_soft_timer_followup(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.display_active = True
        called = {"advance": False}
        app.overlay = type(
            "Overlay",
            (),
            {
                "visible": True,
                "active_display_type": "photo.slideshow",
                "advance": lambda *a, **k: called.__setitem__("advance", True),
                "show": lambda *a, **k: None,
            },
        )()
        app._show_payload(
            {
                "type": "timer.snapshot",
                "trigger": "show-timers-followup-2000ms",
                "event": {"kind": "list"},
                "timers": [{"label": "Pasta"}],
            },
            30,
        )
        self.assertFalse(called["advance"])

    def test_slideshow_yields_to_explicit_show_timers(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.display_active = True
        called = {"advance": False}
        app.overlay = type(
            "Overlay",
            (),
            {
                "visible": True,
                "active_display_type": "photo.slideshow",
                "advance": lambda *a, **k: called.__setitem__("advance", True),
                "show": lambda *a, **k: None,
            },
        )()
        app._show_payload(
            {
                "type": "timer.snapshot",
                "trigger": "show-timers",
                "event": {"kind": "list"},
                "timers": [],
            },
            30,
        )
        self.assertTrue(called["advance"])

    def test_slideshow_yields_to_timer_fired(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.display_active = True
        called = {"advance": False}
        app.overlay = type(
            "Overlay",
            (),
            {
                "visible": True,
                "active_display_type": "photo.slideshow",
                "advance": lambda *a, **k: called.__setitem__("advance", True),
                "show": lambda *a, **k: None,
            },
        )()
        app._show_payload(
            {
                "type": "timer.snapshot",
                "trigger": "scheduled",
                "event": {"kind": "fired", "timer": {"label": "Pizza"}},
                "timers": [],
            },
            120,
        )
        self.assertTrue(called["advance"])


class ConsoleUnicodeTests(unittest.TestCase):
    def test_make_console_streams_unicode_safe_reconfigures_streams(self):
        stdout = mock.MagicMock()
        stderr = mock.MagicMock()
        with mock.patch("src.main.sys.stdout", stdout), mock.patch("src.main.sys.stderr", stderr):
            _make_console_streams_unicode_safe()
        stdout.reconfigure.assert_called_once_with(encoding="utf-8", errors="backslashreplace")
        stderr.reconfigure.assert_called_once_with(encoding="utf-8", errors="backslashreplace")

    def test_make_console_streams_unicode_safe_ignores_streams_without_reconfigure(self):
        with mock.patch("src.main.sys.stdout", object()), mock.patch("src.main.sys.stderr", object()):
            _make_console_streams_unicode_safe()


if __name__ == "__main__":
    unittest.main()
