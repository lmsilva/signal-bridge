import unittest
from unittest import mock

from src.display_identity import build_announce_payload, resolve_display_name
from src.input_control import handle_input_payload, handle_key, handle_pointer


class DisplayIdentityTests(unittest.TestCase):
    def test_resolve_display_name_prefers_config(self):
        self.assertEqual(resolve_display_name({"displayName": "Poster"}), "Poster")

    def test_build_announce_payload(self):
        payload = build_announce_payload({
            "displayName": "Kitchen TV",
            "displayId": "disp-fixed",
            "listenPort": 47832,
        })
        self.assertEqual(payload["type"], "display.announce")
        self.assertEqual(payload["display"]["id"], "disp-fixed")
        self.assertEqual(payload["display"]["name"], "Kitchen TV")
        self.assertEqual(payload["display"]["port"], 47832)

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
    def test_handle_input_payload_types(self):
        with mock.patch("src.input_control.handle_pointer") as pointer:
            with mock.patch("src.input_control.handle_key") as key:
                self.assertTrue(handle_input_payload({"type": "input.pointer", "pointer": {"dx": 1}}))
                pointer.assert_called_once()
                self.assertTrue(handle_input_payload({"type": "input.key", "key": {"key": "a"}}))
                key.assert_called_once()
                self.assertFalse(handle_input_payload({"type": "web.close"}))

    def test_pointer_moves_and_clicks(self):
        mouse = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._move_relative", return_value=True) as move:
                with mock.patch("src.input_control._mouse", mouse):
                    with mock.patch("src.input_control._Button") as Button:
                        Button.left = "L"
                        Button.right = "R"
                        Button.middle = "M"
                        handle_pointer({"dx": 4, "dy": -2, "buttons": {"left": "click"}})
                        move.assert_called_once_with(4, -2)
                        mouse.move.assert_not_called()
                        mouse.click.assert_called_once_with("L", 1)

    def test_pointer_falls_back_to_pynput_move(self):
        mouse = mock.Mock()
        with mock.patch("src.input_control._ensure_pynput"):
            with mock.patch("src.input_control._move_relative", return_value=False):
                with mock.patch("src.input_control._mouse", mouse):
                    with mock.patch("src.input_control._Button") as Button:
                        Button.left = "L"
                        Button.right = "R"
                        Button.middle = "M"
                        handle_pointer({"dx": 3, "dy": 1})
                        mouse.move.assert_called_once_with(3, 1)

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


if __name__ == "__main__":
    unittest.main()
