import unittest
from unittest import mock

from src.text_marquee import MarqueeLine


def _make_font(char_width: int, linespace: int = 30):
    font = mock.MagicMock()
    font.measure.side_effect = lambda text: len(text) * char_width
    font.metrics.return_value = linespace
    return font


class MarqueeLineFitsTests(unittest.TestCase):
    """Text that already fits should render once, statically — no ticking."""

    def test_short_text_is_centered_and_does_not_schedule_a_tick(self):
        root = mock.MagicMock()
        with mock.patch("src.text_marquee.tk.Canvas") as canvas_cls:
            canvas = canvas_cls.return_value
            marquee = MarqueeLine(root)
            marquee.build(
                parent=root,
                text="Tennessee",
                font=_make_font(char_width=5),
                fill="#fff",
                width=300,
                height=30,
                bg="#000",
            )
        root.after.assert_not_called()
        canvas.create_text.assert_called_once()
        _, kwargs = canvas.create_text.call_args
        self.assertEqual(kwargs["anchor"], "center")


class MarqueeLineOverflowTests(unittest.TestCase):
    """Text wider than its column should scroll: pause, scroll to the end,
    pause, then reset to the start and repeat — indefinitely."""

    def _build_overflowing(self, root):
        with mock.patch("src.text_marquee.tk.Canvas") as canvas_cls:
            canvas = canvas_cls.return_value
            marquee = MarqueeLine(root)
            marquee.build(
                parent=root,
                text="3 Years, 5 Months And 2 Days In The Life Of...",
                font=_make_font(char_width=10),
                fill="#fff",
                width=200,
                height=30,
                bg="#000",
            )
        return marquee, canvas

    def test_overflowing_text_schedules_start_pause(self):
        root = mock.MagicMock()
        marquee, canvas = self._build_overflowing(root)
        canvas.create_text.assert_called_once()
        _, kwargs = canvas.create_text.call_args
        self.assertEqual(kwargs["anchor"], "w")
        root.after.assert_called_once_with(MarqueeLine.START_PAUSE_MS, marquee._tick)
        self.assertEqual(marquee._state, "start_pause")

    def test_tick_cycle_scrolls_to_the_end_then_pauses_then_resets(self):
        root = mock.MagicMock()
        marquee, canvas = self._build_overflowing(root)
        max_scroll = marquee._max_scroll
        self.assertGreater(max_scroll, 0)

        # start_pause -> scrolling
        marquee._tick()
        self.assertEqual(marquee._state, "scrolling")

        # Force a huge elapsed time so a single scroll tick clamps straight
        # to the end rather than requiring many small ticks in the test.
        marquee._last_tick_at -= 100
        marquee._tick()
        self.assertEqual(marquee._state, "end_pause")
        self.assertEqual(marquee._offset, max_scroll)
        canvas.coords.assert_called_with(marquee._text_id, -int(round(max_scroll)), 15)

        # end_pause -> reset to start, loop forever (no "stop" condition).
        marquee._tick()
        self.assertEqual(marquee._state, "start_pause")
        self.assertEqual(marquee._offset, 0.0)
        canvas.coords.assert_called_with(marquee._text_id, 0, 15)

    def test_stop_cancels_pending_tick_and_clears_state(self):
        root = mock.MagicMock()
        marquee, _ = self._build_overflowing(root)
        marquee.stop()
        root.after_cancel.assert_called_once()
        self.assertEqual(marquee._state, "idle")
        self.assertIsNone(marquee.viewport)


if __name__ == "__main__":
    unittest.main()
