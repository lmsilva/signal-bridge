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

        def capture_text(*args, **kwargs):
            texts.append(kwargs.get("text"))
            return len(texts)

        panel.canvas.create_text.side_effect = capture_text
        panel._render_empty(panel.shell.layout, "Kitchen Echo")
        self.assertIn("Nothing playing", texts)
        self.assertTrue(any("Kitchen Echo" in text for text in texts))

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


if __name__ == "__main__":
    unittest.main()
