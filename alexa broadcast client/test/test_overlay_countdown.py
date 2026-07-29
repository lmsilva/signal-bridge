import time
import unittest
from types import SimpleNamespace
from unittest import mock

from src.overlay import OverlayWindow


class OverlayCountdownTests(unittest.TestCase):
    def _make_overlay(self):
        overlay = OverlayWindow.__new__(OverlayWindow)
        overlay.root = mock.MagicMock()
        overlay.root.after = mock.MagicMock(side_effect=lambda _ms, fn: id(fn))
        overlay.root.after_cancel = mock.MagicMock()
        overlay.dismiss_footer = mock.MagicMock()
        overlay.dismiss_footer._visible = False
        overlay.countdown_label = overlay.dismiss_footer
        overlay.canvas = mock.MagicMock()
        overlay.layout = SimpleNamespace(content_x=0, content_width=800, countdown_y=1000)
        overlay.panels = {"broadcast": mock.Mock(scroller=None)}
        overlay._expires_at = time.time() + 45
        overlay._display_seconds = 45
        overlay._active_panel_key = None
        overlay._active_panel = None
        overlay._countdown_job = None
        overlay._hide_job = None
        overlay._fade_job = None
        return overlay

    def test_format_remaining_seconds_only(self):
        overlay = self._make_overlay()
        self.assertEqual(overlay._format_remaining(8), "Dismisses in 8s")

    def test_format_remaining_minutes_and_seconds(self):
        overlay = self._make_overlay()
        self.assertEqual(overlay._format_remaining(125), "Dismisses in 2:05")

    def test_format_remaining_finishing(self):
        overlay = self._make_overlay()
        self.assertEqual(overlay._format_remaining(0, finishing=True), "Finishing…")

    def test_update_countdown_blanks_for_photo_slideshow(self):
        overlay = self._make_overlay()
        overlay._active_panel_key = "photo.slideshow"
        overlay._update_countdown()
        overlay.dismiss_footer.hide.assert_called()

    def test_update_countdown_blanks_for_shared_photo_qr(self):
        overlay = self._make_overlay()
        overlay._active_panel_key = "qr.display"
        overlay._active_panel = mock.Mock(_photo_mode=True)
        overlay._update_countdown()
        overlay.dismiss_footer.hide.assert_called()

    def test_is_shared_photo_qr_detects_photo_type_and_url(self):
        self.assertTrue(OverlayWindow._is_shared_photo_qr(
            "qr.display", {"qr": {"qrType": "photo", "content": "https://x/a.jpg"}},
        ))
        self.assertTrue(OverlayWindow._is_shared_photo_qr(
            "qr.display", {"qr": {"content": "https://nas/qr-images/a.jpg"}},
        ))
        self.assertFalse(OverlayWindow._is_shared_photo_qr(
            "qr.display", {"qr": {"qrType": "url", "content": "https://example.com"}},
        ))
        self.assertFalse(OverlayWindow._is_shared_photo_qr("photo.slideshow", {}))

    def test_update_countdown_blanks_persistent_steam_without_reschedule(self):
        overlay = self._make_overlay()
        overlay._active_panel_key = "steam.now-playing"
        overlay._display_seconds = 0
        overlay._update_countdown()
        overlay.dismiss_footer.hide.assert_called()
        overlay.root.after.assert_not_called()
        self.assertIsNone(overlay._countdown_job)

    def test_start_countdown_shows_dismiss_footer(self):
        overlay = self._make_overlay()
        overlay._active_panel_key = "weather.query"
        overlay._start_countdown(30)
        overlay.dismiss_footer.show.assert_called()
        args, kwargs = overlay.dismiss_footer.show.call_args
        self.assertEqual(args[0], 30000)
        self.assertIn("expires_at", kwargs)

    def test_stop_timers_cancels_jobs(self):
        overlay = self._make_overlay()
        overlay._countdown_job = 99
        overlay._hide_job = 88
        overlay._stop_timers()
        overlay.root.after_cancel.assert_called()


if __name__ == "__main__":
    unittest.main()
