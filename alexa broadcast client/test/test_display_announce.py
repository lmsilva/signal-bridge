import unittest
from unittest import mock

from src.display_announce import DisplayAnnouncer
from src.display_identity import build_announce_payload


class DisplayAnnounceTests(unittest.TestCase):
    def test_announce_log_is_ascii_only(self):
        logs = []
        announcer = DisplayAnnouncer({"listenPort": 47832, "bridgeHosts": []}, log=logs.append)
        payload = {
            "display": {"name": "Poster PC", "id": "disp-abc", "hostname": "MOVIETHEATERPOSTER"},
        }
        with mock.patch.object(announcer, "remember_bridge_host"), \
                mock.patch("src.display_announce.build_announce_payload", return_value=payload), \
                mock.patch("src.display_announce.encode_outbound", return_value={"v": 3}), \
                mock.patch("src.display_announce.read_steam_running_app_id", return_value=570), \
                mock.patch("src.display_announce.socket.socket") as socket_cls:
            sock = mock.MagicMock()
            socket_cls.return_value = sock
            announcer.announce_now()

        self.assertEqual(len(logs), 1)
        line = logs[0]
        self.assertNotIn("\u2192", line)
        line.encode("ascii")

    def test_build_announce_payload_includes_hostname_and_steam_app_id(self):
        config = {"listenPort": 47832, "displayName": "Poster"}
        payload = build_announce_payload(config, steam_app_id=570)
        self.assertEqual(payload["type"], "display.announce")
        self.assertEqual(payload["display"]["hostname"], payload["display"]["hostname"].upper())
        self.assertEqual(payload["display"]["steamAppId"], 570)


if __name__ == "__main__":
    unittest.main()
