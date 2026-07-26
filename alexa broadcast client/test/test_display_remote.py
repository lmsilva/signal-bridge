import unittest
from unittest import mock

from src.display_identity import build_announce_payload, resolve_display_name
from src.input_control import handle_input_payload, handle_key, handle_pointer, handle_text


class DisplayIdentityTests(unittest.TestCase):
    def test_resolve_display_name_prefers_config(self):
        self.assertEqual(resolve_display_name({"displayName": "Poster"}), "Poster")

    def test_build_announce_payload(self):
        with mock.patch("src.steam_local.read_steam_running_app_id", return_value=686200):
            payload = build_announce_payload({
                "displayName": "Kitchen TV",
                "displayId": "disp-fixedabcd",
                "listenPort": 47832,
            })
        self.assertEqual(payload["type"], "display.announce")
        self.assertEqual(payload["display"]["id"], "disp-fixedabcd")
        self.assertEqual(payload["display"]["shortId"], "abcd")
        self.assertEqual(payload["display"]["name"], "Kitchen TV")
        self.assertEqual(payload["display"]["port"], 47832)
        self.assertTrue(payload["display"]["hostname"])
        self.assertEqual(payload["display"]["steamAppId"], 686200)

    def test_build_announce_payload_omits_steam_when_idle(self):
        payload = build_announce_payload({
            "displayName": "Kitchen TV",
            "displayId": "disp-fixedabcd",
            "listenPort": 47832,
        }, steam_app_id=0)
        self.assertNotIn("steamAppId", payload["display"])

    def test_display_id_ignores_name_so_duplicates_stay_unique(self):
        from src.display_identity import resolve_display_id

        a = resolve_display_id({"displayName": "Poster Display", "displayId": ""})
        b = resolve_display_id({"displayName": "Other Name", "displayId": ""})
        # Same machine id file → same id even if friendly names differ.
        self.assertEqual(a, b)
        self.assertTrue(a.startswith("disp-"))

    def test_announce_unicasts_to_bridge_hosts(self):
        from src.display_announce import DisplayAnnouncer

        sent = []

        class FakeSock:
            def setsockopt(self, *a, **k):
                return None

            def sendto(self, body, addr):
                sent.append(addr)

            def close(self):
                return None

        announcer = DisplayAnnouncer({
            "displayName": "Poster",
            "displayId": "disp-1",
            "listenPort": 47832,
            "bridgeHosts": ["192.168.1.10"],
            "discoveryPort": 47833,
        }, log=lambda *_: None)
        with mock.patch("src.display_announce.socket.socket", return_value=FakeSock()):
            announcer.announce_now()
        self.assertIn(("192.168.1.10", 47833), sent)
        self.assertIn(("255.255.255.255", 47833), sent)


class InputControlTests(unittest.TestCase):
    def setUp(self):
        from src import input_control as ic

        # Isolate tracked cursor state between tests.
        ic._tracked_pos = None
        ic._on_cursor_moved = None

    def test_handle_input_payload_types(self):
        with mock.patch("src.input_control.handle_pointer") as pointer:
            with mock.patch("src.input_control.handle_key") as key:
                with mock.patch("src.input_control.handle_text") as text:
                    self.assertTrue(handle_input_payload({"type": "input.pointer", "pointer": {"dx": 1}}))
                    pointer.assert_called_once()
                    self.assertTrue(handle_input_payload({"type": "input.key", "key": {"key": "a"}}))
                    key.assert_called_once()
                    self.assertTrue(handle_input_payload({"type": "input.text", "text": {"value": "hi"}}))
                    text.assert_called_once()
                    self.assertFalse(handle_input_payload({"type": "web.close"}))

    def test_move_uses_absolute_sendinput_and_notifies_overlay(self):
        from src import input_control as ic

        batches = []
        moved = []
        ic.set_cursor_moved_callback(lambda x, y: moved.append((x, y)))
        with mock.patch(
            "src.input_control._send_mouse_events",
            side_effect=lambda events: batches.append(list(events)) or True,
        ):
            with mock.patch("src.input_control._virtual_screen", return_value=(0, 0, 1000, 1000)):
                with mock.patch("src.input_control._cursor_pos", return_value=(100, 200)):
                    handle_pointer({"dx": 6, "dy": -3})
        self.assertEqual(len(batches), 1)
        self.assertEqual(len(batches[0]), 1)
        nx, ny, flags, _data = batches[0][0]
        self.assertEqual(nx, round(106 * 65535 / 999))
        self.assertEqual(ny, round(197 * 65535 / 999))
        self.assertEqual(flags, ic.ABS_MOVE_FLAGS)
        self.assertEqual(moved, [(106, 197)])

    def test_click_moves_to_tracked_position_first(self):
        # Under RDP, bare button events click at the frozen system arrow —
        # so every click is preceded by an absolute move to our tracked tip,
        # then plain LEFTDOWN/LEFTUP (no ABSOLUTE ORed onto the button flags).
        from src import input_control as ic

        batches = []
        with mock.patch(
            "src.input_control._send_mouse_events",
            side_effect=lambda events: batches.append(list(events)) or True,
        ):
            with mock.patch("src.input_control._virtual_screen", return_value=(0, 0, 1000, 1000)):
                with mock.patch("src.input_control._cursor_pos", return_value=(100, 200)):
                    handle_pointer({"dx": 10, "dy": 0})
                    handle_pointer({"buttons": {"left": "click"}})
        self.assertEqual(len(batches), 2)
        click_batch = batches[1]
        self.assertEqual(len(click_batch), 3)
        self.assertEqual(click_batch[0][2], ic.ABS_MOVE_FLAGS)
        self.assertEqual(click_batch[1][2], ic.MOUSEEVENTF_LEFTDOWN)
        self.assertEqual(click_batch[2][2], ic.MOUSEEVENTF_LEFTUP)

    def test_wheel_and_right_click_include_absolute_aim(self):
        from src import input_control as ic

        batches = []
        with mock.patch(
            "src.input_control._send_mouse_events",
            side_effect=lambda events: batches.append(list(events)) or True,
        ):
            with mock.patch("src.input_control._virtual_screen", return_value=(0, 0, 1000, 1000)):
                with mock.patch("src.input_control._cursor_pos", return_value=(50, 50)):
                    handle_pointer({"wheel": -2, "buttons": {"right": "click"}})
        self.assertEqual(len(batches), 2)
        wheel_batch = batches[0]
        self.assertEqual(wheel_batch[-1][2], ic.MOUSEEVENTF_WHEEL)
        self.assertEqual(wheel_batch[-1][3], -2 * ic.WHEEL_DELTA)
        click_batch = batches[1]
        self.assertEqual(click_batch[-2][2], ic.MOUSEEVENTF_RIGHTDOWN)
        self.assertEqual(click_batch[-1][2], ic.MOUSEEVENTF_RIGHTUP)

    def test_click_ducks_overlay_before_injecting(self):
        ducked = []
        from src import input_control as ic

        ic.set_cursor_duck_callback(lambda: ducked.append(True))
        with mock.patch("src.input_control._send_mouse_events", return_value=True):
            with mock.patch("src.input_control._virtual_screen", return_value=(0, 0, 1000, 1000)):
                with mock.patch("src.input_control._cursor_pos", return_value=(10, 10)):
                    handle_pointer({"buttons": {"left": "click"}})
        self.assertTrue(ducked)

    def test_pointer_falls_back_to_pynput_when_sendinput_unavailable(self):
        mouse = mock.Mock()
        with mock.patch("src.input_control._send_mouse_events", return_value=False):
            with mock.patch("src.input_control._set_cursor_pos", return_value=False):
                with mock.patch("src.input_control._virtual_screen", return_value=(0, 0, 1000, 1000)):
                    with mock.patch("src.input_control._cursor_pos", return_value=(0, 0)):
                        with mock.patch("src.input_control._ensure_pynput"):
                            with mock.patch("src.input_control._mouse", mouse):
                                with mock.patch("src.input_control._Button") as Button:
                                    Button.left = "L"
                                    Button.right = "R"
                                    Button.middle = "M"
                                    handle_pointer({"dx": 3, "dy": 1, "buttons": {"left": "click"}})
                                    mouse.move.assert_called_once_with(3, 1)
                                    mouse.click.assert_called_once_with("L", 1)

    def test_pointer_survives_broken_pynput(self):
        with mock.patch("src.input_control._send_mouse_events", return_value=False):
            with mock.patch("src.input_control._set_cursor_pos", return_value=False):
                with mock.patch("src.input_control._virtual_screen", return_value=None):
                    with mock.patch("src.input_control._cursor_pos", return_value=None):
                        with mock.patch(
                            "src.input_control._ensure_pynput",
                            side_effect=ImportError("no pynput"),
                        ):
                            handle_pointer({"dx": 5, "dy": 5, "buttons": {"left": "click"}})

    def test_key_survives_broken_pynput(self):
        with mock.patch(
            "src.input_control._ensure_pynput",
            side_effect=ImportError("no pynput"),
        ):
            handle_key({"key": "a", "action": "press"})

    def test_key_chord_presses_modifiers(self):
        keyboard = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._keyboard", keyboard):
                with mock.patch("src.input_control._Key") as Key:
                    Key.alt = "ALT"
                    Key.f4 = "F4"
                    handle_key({"key": "F4", "modifiers": ["alt"], "action": "press"})
                    keyboard.press.assert_any_call("ALT")
                    keyboard.press.assert_any_call("F4")
                    keyboard.release.assert_any_call("F4")
                    keyboard.release.assert_any_call("ALT")

    def test_handle_text_types_the_whole_string_in_one_shot(self):
        keyboard = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._keyboard", keyboard):
                handle_text({"value": "correct-horse-battery-staple"})
        keyboard.type.assert_called_once_with("correct-horse-battery-staple")
        keyboard.press.assert_not_called()

    def test_handle_text_presses_enter_when_requested(self):
        keyboard = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._keyboard", keyboard):
                with mock.patch("src.input_control._Key") as Key:
                    Key.enter = "ENTER"
                    handle_text({"value": "https://example.com", "pressEnter": True})
        keyboard.type.assert_called_once_with("https://example.com")
        keyboard.press.assert_called_once_with("ENTER")
        keyboard.release.assert_called_once_with("ENTER")

    def test_handle_text_ignores_empty_value(self):
        keyboard = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._keyboard", keyboard):
                handle_text({"value": ""})
                handle_text(None)
        keyboard.type.assert_not_called()

    def test_handle_text_survives_broken_pynput(self):
        with mock.patch(
            "src.input_control._ensure_pynput",
            side_effect=ImportError("no pynput"),
        ):
            handle_text({"value": "hello"})


class RemoteCursorOverlayTests(unittest.TestCase):
    def test_overlay_is_compact(self):
        from src.remote_cursor import RemoteCursorOverlay

        self.assertLessEqual(RemoteCursorOverlay.SIZE, 20)

    def test_duck_does_not_restore_system_cursor(self):
        from src.remote_cursor import RemoteCursorOverlay

        root = mock.Mock()
        root.after = mock.Mock(return_value="timer")
        root.after_cancel = mock.Mock()
        overlay = RemoteCursorOverlay(root)
        overlay._visible = True
        overlay._system_hidden = True
        overlay._win = mock.Mock()
        with mock.patch.object(overlay, "_restore_system_cursor") as restore:
            with mock.patch.object(overlay, "_stop_physical_mouse_watch"):
                overlay.duck()
        restore.assert_not_called()
        overlay._win.withdraw.assert_called_once()


if __name__ == "__main__":
    unittest.main()
