import http.server
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from src import web_overlay
from src.main import BroadcastClientApp
from src.web_overlay import (
    WebOverlayManager,
    build_host_command,
    build_web_error_payload,
    preflight_url,
)


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path.startswith("/ok"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<html>ok</html>")
        elif self.path.startswith("/missing"):
            self.send_error(404)
        else:
            self.send_error(500)

    def log_message(self, *args):  # silence test output
        pass


class PreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_preflight_ok(self):
        self.assertTrue(preflight_url(f"http://127.0.0.1:{self.port}/ok"))

    def test_preflight_bad_response_still_ok(self):
        # HTTP answers (even 404/500) mean the host is reachable — WebView2
        # should open the page rather than showing the friendly error.
        self.assertTrue(preflight_url(f"http://127.0.0.1:{self.port}/missing"))
        self.assertTrue(preflight_url(f"http://127.0.0.1:{self.port}/error"))

    def test_preflight_unreachable(self):
        self.assertFalse(preflight_url("http://127.0.0.1:9/nope", timeout=2))


class HostCommandTests(unittest.TestCase):
    def test_dev_command_uses_python_and_script(self):
        command = build_host_command(
            {"webOverlayOpacity": 0.75}, "https://example.com",
            frozen=False, executable="python",
        )
        self.assertEqual(command[0], "python")
        self.assertTrue(command[1].endswith("webview_host.py"))
        self.assertIn("--url", command)
        self.assertIn("https://example.com", command)
        self.assertIn("0.75", command)

    def test_frozen_command_uses_sibling_exe(self):
        command = build_host_command(
            {}, "https://example.com",
            frozen=True, executable=r"C:\app\alexa-broadcast-client.exe",
        )
        self.assertTrue(command[0].endswith("webview-host.exe"))
        self.assertIn("0.88", command)

    def test_invalid_opacity_falls_back(self):
        command = build_host_command(
            {"webOverlayOpacity": "banana"}, "https://example.com",
            frozen=False, executable="python",
        )
        self.assertIn("0.88", command)


class ErrorPayloadTests(unittest.TestCase):
    def test_error_payload_uses_error_display_seconds(self):
        payload = build_web_error_payload(
            {"web": {"url": "https://x", "errorDisplaySeconds": 25}}
        )
        self.assertEqual(payload["type"], "broadcast")
        self.assertEqual(payload["message"], "Cannot display content at this time")
        self.assertEqual(payload["displaySeconds"], 25)
        self.assertEqual(payload["trigger"], "web-open-failed")

    def test_error_payload_defaults(self):
        payload = build_web_error_payload({})
        self.assertEqual(payload["displaySeconds"], 20)

    def test_opening_ack_payload(self):
        from src.web_overlay import build_web_opening_payload

        payload = build_web_opening_payload(
            {"web": {"url": "https://www.google.com/search?q=1"}}
        )
        self.assertEqual(payload["type"], "broadcast")
        self.assertIn("www.google.com", payload["message"])
        self.assertEqual(payload["trigger"], "web-open-ack")


class ManagerTests(unittest.TestCase):
    def test_open_url_failure_invokes_callback(self):
        manager = WebOverlayManager({})
        failures = []
        with mock.patch.object(web_overlay, "preflight_url", return_value=False), \
                mock.patch.object(web_overlay, "resolve_host_executable", return_value=Path("x")):
            thread = manager.open_url("http://bad.example", on_failure=failures.append)
            thread.join(timeout=5)
        self.assertEqual(failures, ["preflight"])
        self.assertFalse(manager.active)

    def test_open_url_missing_host(self):
        manager = WebOverlayManager({})
        failures = []
        with mock.patch.object(web_overlay, "resolve_host_executable", return_value=None):
            thread = manager.open_url("https://good.example", on_failure=failures.append)
            thread.join(timeout=5)
        self.assertEqual(failures, ["missing-host"])

    def test_open_url_success_spawns_host(self):
        manager = WebOverlayManager({})
        fake_process = mock.Mock()
        fake_process.poll.return_value = None
        fake_process.pid = 1234
        with mock.patch.object(web_overlay, "preflight_url", return_value=True), \
                mock.patch.object(web_overlay, "resolve_host_executable", return_value=Path("host")), \
                mock.patch.object(web_overlay, "STARTUP_GRACE_SEC", 0.01), \
                mock.patch("subprocess.Popen", return_value=fake_process) as popen:
            thread = manager.open_url("https://good.example", on_failure=None)
            thread.join(timeout=5)
        self.assertTrue(popen.called)
        command = popen.call_args[0][0]
        self.assertIn("https://good.example", command)
        self.assertTrue(manager.active)

    def test_early_host_death_reports_failure(self):
        manager = WebOverlayManager({})
        fake_process = mock.Mock()
        fake_process.poll.return_value = 3
        fake_process.returncode = 3
        fake_process.pid = 1
        failures = []
        with mock.patch.object(web_overlay, "preflight_url", return_value=True), \
                mock.patch.object(web_overlay, "resolve_host_executable", return_value=Path("host")), \
                mock.patch.object(web_overlay, "STARTUP_GRACE_SEC", 0.01), \
                mock.patch("subprocess.Popen", return_value=fake_process):
            thread = manager.open_url("https://good.example", on_failure=failures.append)
            thread.join(timeout=5)
        self.assertEqual(failures, ["host-exited"])

    def test_close_terminates_process(self):
        manager = WebOverlayManager({})
        fake_process = mock.Mock()
        fake_process.poll.return_value = None
        manager._process = fake_process
        manager.close()
        fake_process.terminate.assert_called_once()
        self.assertFalse(manager.active)


class CommandRoutingTests(unittest.TestCase):
    def _make_app(self):
        app = BroadcastClientApp.__new__(BroadcastClientApp)
        app.config = {"defaultDisplaySeconds": 30, "maxDisplaySeconds": 120}
        app.web_overlay = mock.Mock()
        app.message_queue = mock.Mock()
        app.announcer = mock.Mock()
        app.display_active = False
        app.overlay = mock.Mock(visible=False)
        app._show_payload = mock.Mock()
        return app

    def test_command_types_are_not_display_types(self):
        app = self._make_app()
        for command_type in BroadcastClientApp.COMMAND_TYPES:
            self.assertNotIn(command_type, BroadcastClientApp.DISPLAY_TYPES)
            # discover/input are commands but _should_show only cares about overlays
            self.assertFalse(app._should_show({"type": command_type}))

    def test_web_open_routes_to_manager(self):
        app = self._make_app()
        payload = {"type": "web.open", "web": {"url": "https://example.com"}}
        app._handle_command_payload(payload)
        app.web_overlay.open_url.assert_called_once()
        self.assertEqual(
            app.web_overlay.open_url.call_args[0][0], "https://example.com"
        )

    def test_web_open_failure_enqueues_friendly_error(self):
        app = self._make_app()
        payload = {
            "type": "web.open",
            "web": {"url": "https://example.com", "errorDisplaySeconds": 18},
        }
        app._handle_command_payload(payload)
        on_failure = app.web_overlay.open_url.call_args[1]["on_failure"]
        on_failure("preflight")
        queued = app.message_queue.put.call_args[0][0]
        self.assertEqual(queued["message"], "Cannot display content at this time")
        self.assertEqual(queued["displaySeconds"], 18)

    def test_web_open_without_url_ignored(self):
        app = self._make_app()
        app._handle_command_payload({"type": "web.open", "web": {}})
        app.web_overlay.open_url.assert_not_called()

    def test_web_close_routes_to_manager(self):
        app = self._make_app()
        app._handle_command_payload({"type": "web.close"})
        app.web_overlay.close.assert_called_once()

    def test_system_reboot_runs_shutdown(self):
        app = self._make_app()
        with mock.patch("src.main.subprocess.Popen") as popen:
            app._handle_command_payload(
                {"type": "system.command", "system": {"action": "reboot"}}
            )
        command = popen.call_args[0][0]
        self.assertEqual(command[:2], ["shutdown", "/r"])
        app.web_overlay.close.assert_called_once()

    def test_system_poweroff_runs_shutdown(self):
        app = self._make_app()
        with mock.patch("src.main.subprocess.Popen") as popen:
            app._handle_command_payload(
                {"type": "system.command", "system": {"action": "poweroff"}}
            )
        command = popen.call_args[0][0]
        self.assertEqual(command[:2], ["shutdown", "/s"])

    def test_unknown_system_action_ignored(self):
        app = self._make_app()
        with mock.patch("src.main.subprocess.Popen") as popen:
            app._handle_command_payload(
                {"type": "system.command", "system": {"action": "explode"}}
            )
        popen.assert_not_called()

    def test_steam_close_dismisses_only_when_steam_active(self):
        app = self._make_app()
        app.overlay.active_display_type = "steam.now-playing"
        app._handle_command_payload({"type": "steam.now-playing.close"})
        app.overlay.dismiss_immediately.assert_called_once()

        app.overlay.dismiss_immediately.reset_mock()
        app.overlay.active_display_type = "weather.query"
        app._handle_command_payload({"type": "steam.now-playing.close"})
        app.overlay.dismiss_immediately.assert_not_called()


class WebviewHostTests(unittest.TestCase):
    def test_clamp_opacity(self):
        from src.webview_host import clamp_opacity

        self.assertEqual(clamp_opacity("0.5"), 0.5)
        self.assertEqual(clamp_opacity(2), 1.0)
        self.assertEqual(clamp_opacity(0), 0.2)
        self.assertEqual(clamp_opacity("junk"), 0.88)

    def test_parse_args(self):
        from src.webview_host import parse_args

        args = parse_args(["--url", "https://example.com", "--opacity", "0.7"])
        self.assertEqual(args.url, "https://example.com")
        self.assertEqual(args.opacity, "0.7")

    def test_main_rejects_non_http_url(self):
        from src.webview_host import main

        self.assertEqual(main(["--url", "file:///c:/x"]), 2)


if __name__ == "__main__":
    unittest.main()
