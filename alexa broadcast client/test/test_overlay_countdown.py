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
        overlay.countdown_label = mock.MagicMock()
        overlay.countdown_label.winfo_ismapped.return_value = False
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
        overlay.countdown_label.configure.assert_called_with(text="")
        overlay.countdown_label.place_forget.assert_called()

    def test_update_countdown_blanks_persistent_steam_without_reschedule(self):
        overlay = self._make_overlay()
        overlay._active_panel_key = "steam.now-playing"
        overlay._display_seconds = 0
        overlay._update_countdown()
        overlay.countdown_label.configure.assert_called_with(text="")
        overlay.root.after.assert_not_called()
        self.assertIsNone(overlay._countdown_job)

    def test_stop_timers_clears_countdown_text(self):
        overlay = self._make_overlay()
        overlay._countdown_job = 99
        overlay._hide_job = 88
        overlay._stop_timers()
        overlay.countdown_label.configure.assert_called_with(text="")
        overlay.countdown_label.place_forget.assert_called()
        overlay.root.after_cancel.assert_called()


if __name__ == "__main__":
    unittest.main()
