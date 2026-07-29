import unittest
from types import SimpleNamespace
from unittest import mock

from src.display_panels import MusicPanel


class MusicPanelEmptyTests(unittest.TestCase):
    def _make_panel(self):
        layout = SimpleNamespace(
            content_x=100,
            content_width=800,
            message_area_top=200,
            message_area_bottom=900,
            portrait=True,
        )
        shell = SimpleNamespace(
            layout=layout,
            section_title_font=mock.MagicMock(metrics=lambda key: 28 if key == "linespace" else 0),
            body_font=mock.MagicMock(metrics=lambda key: 20 if key == "linespace" else 0),
            hero_font=mock.MagicMock(),
        )
        config = {
            "textColor": "#f8fafc",
            "mutedTextColor": "#94a3b8",
            "accentColor": "#38bdf8",
        }
        panel = MusicPanel.__new__(MusicPanel)
        panel.root = mock.MagicMock()
        panel.shell = shell
        panel.config = config
        panel.canvas = mock.MagicMock()
        panel._item_ids = []
        panel._round_rect = mock.MagicMock(return_value=1)
        panel._track = lambda item_id: item_id
        panel._marquees = []
        return panel

    def test_render_empty_shows_nothing_playing(self):
        panel = self._make_panel()
        texts = []
        art_sizes = []

        def capture_text(*args, **kwargs):
            texts.append(kwargs.get("text"))
            return len(texts)

        def capture_art(cx, cy, size, accent):
            art_sizes.append(size)
            return panel._draw_art_placeholder(cx, cy, size, accent, False)

        panel.canvas.create_text.side_effect = capture_text
        panel._make_empty_album_photo = staticmethod(lambda size, accent: None)
        panel._draw_empty_album_art = capture_art
        panel._render_empty(panel.shell.layout, "Kitchen Echo")
        self.assertIn("Nothing playing", texts)
        self.assertTrue(any("Kitchen Echo" in text for text in texts))
        # Same sizing path as a real album cover (not the old 180px chip).
        self.assertEqual(len(art_sizes), 1)
        self.assertGreaterEqual(art_sizes[0], 330)

    def test_render_empty_when_music_empty_flag(self):
        panel = self._make_panel()
        panel._render_empty = mock.MagicMock()
        panel._render_stack = mock.MagicMock()
        panel._render_landscape = mock.MagicMock()
        panel._render({
            "type": "music.playing",
            "music": {"empty": True, "device": "Office"},
        })
        panel._render_empty.assert_called_once_with(panel.shell.layout, "Office")
        panel._render_stack.assert_not_called()

    def test_render_empty_for_music_query_without_song(self):
        panel = self._make_panel()
        panel._render_empty = mock.MagicMock()
        panel._render({
            "type": "music.playing",
            "trigger": "music-query",
            "music": {"device": "Living Room"},
        })
        panel._render_empty.assert_called_once_with(panel.shell.layout, "Living Room")

    def test_progress_label_and_auto_dismiss_at_zero(self):
        panel = self._make_panel()
        panel.shell.chip_value_font = mock.MagicMock(
            metrics=lambda key: 18 if key == "linespace" else 0,
        )
        panel.shell.overlay = mock.MagicMock()
        panel.visible = True
        # Observe positive remaining first so a units bug (already 0) cannot dismiss.
        panel._bind_progress({
            "state": "PLAYING",
            "mediaLengthSec": 100,
            "mediaProgressSec": 99,
            "progressAt": None,
        })
        self.assertEqual(panel._progress_remaining(), 1)
        self.assertTrue(panel._saw_positive_remaining)
        panel._media_progress_sec = 100
        self.assertEqual(panel._progress_remaining(), 0)
        self.assertEqual(panel._progress_label(0), "Length 1m40s - 0s left")
        panel._auto_dismissed = False
        panel._progress_text_id = None
        panel._progress_fill_id = None
        panel._on_progress_tick()
        panel.shell.overlay.dismiss_immediately.assert_called_once()

    def test_progress_zero_on_first_bind_does_not_auto_dismiss(self):
        panel = self._make_panel()
        panel.shell.overlay = mock.MagicMock()
        panel.visible = True
        panel._bind_progress({
            "state": "PLAYING",
            "mediaLengthSec": 100,
            "mediaProgressSec": 100,
            "progressAt": None,
        })
        self.assertEqual(panel._progress_remaining(), 0)
        self.assertFalse(panel._saw_positive_remaining)
        panel._auto_dismissed = False
        panel._progress_text_id = None
        panel._progress_fill_id = None
        panel._on_progress_tick()
        panel.shell.overlay.dismiss_immediately.assert_not_called()


if __name__ == "__main__":
    unittest.main()
