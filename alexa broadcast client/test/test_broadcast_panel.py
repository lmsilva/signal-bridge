import unittest
from types import SimpleNamespace
from unittest import mock

from src.display_panels import BroadcastPanel


class BroadcastPanelViewportTests(unittest.TestCase):
    def test_build_viewport_message_top_below_chips(self):
        layout = SimpleNamespace(
            chip_y=180,
            chip_height=72,
            message_area_top=180,
            message_area_bottom=900,
            message_content_width=800,
            message_center_x=400,
        )
        shell = SimpleNamespace(
            layout=layout,
            message_font=mock.MagicMock(),
            overlay=mock.MagicMock(),
        )
        config = {
            "overlayBackground": "#0f172a",
            "textColor": "#f8fafc",
            "scrollPixelsPerSecond": 28,
            "scrollStartPauseMs": 100,
            "scrollEndPauseMs": 100,
        }

        with mock.patch("src.display_panels.tk.Canvas") as canvas_cls, \
                mock.patch("src.display_panels.MessageScrollController"):
            canvas = mock.MagicMock()
            canvas.create_text.return_value = 1
            canvas_cls.return_value = canvas

            panel = BroadcastPanel.__new__(BroadcastPanel)
            panel.root = mock.MagicMock()
            panel.shell = shell
            panel.config = config
            panel.chip_value_ids = []
            panel._message_top = 0
            panel._message_viewport_height = 0
            panel._build_viewport()

        expected_top = layout.chip_y + layout.chip_height + BroadcastPanel.CHIP_MESSAGE_GAP
        self.assertEqual(panel._message_top, expected_top)
        self.assertGreater(panel._message_top, layout.message_area_top)
        canvas_cls.assert_called_once()
        args, kwargs = canvas_cls.call_args
        self.assertEqual(kwargs["height"], max(80, layout.message_area_bottom - expected_top))


if __name__ == "__main__":
    unittest.main()
