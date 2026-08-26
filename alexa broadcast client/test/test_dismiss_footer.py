import time
import unittest
from unittest import mock

from src.design_system import footer_band_h, page_chrome
from src.dismiss_footer import (
    BAND_H_U,
    RAIL_H_U,
    DismissFooter,
    format_dismiss_parts,
    format_dismiss_value,
    footer_height,
    dismiss_u,
    remaining_rail_fraction,
)


class DismissFooterFormatTests(unittest.TestCase):
    def test_value_seconds_under_a_minute(self):
        self.assertEqual(format_dismiss_value(43), "43s")
        self.assertEqual(format_dismiss_value(7), "7s")
        self.assertEqual(format_dismiss_value(1), "1s")

    def test_value_never_shows_zero(self):
        self.assertEqual(format_dismiss_value(0), "1s")
        self.assertEqual(format_dismiss_value(-3), "1s")

    def test_value_minutes_and_seconds(self):
        self.assertEqual(format_dismiss_value(125), "2:05")
        self.assertEqual(format_dismiss_value(60), "1:00")

    def test_parts_prefix_and_value(self):
        self.assertEqual(format_dismiss_parts(43), ("Dismisses in ", "43s"))
        self.assertEqual(format_dismiss_parts(125), ("Dismisses in ", "2:05"))

    def test_parts_finishing(self):
        self.assertEqual(format_dismiss_parts(0, finishing=True), ("Finishing…", ""))


class DismissFooterGeometryTests(unittest.TestCase):
    def test_u_and_footer_height_on_design_canvas(self):
        self.assertAlmostEqual(dismiss_u(1080, 1920), 1.0)
        self.assertEqual(footer_height(1080, 1920), BAND_H_U)

    def test_footer_scales_down_on_smaller_screen(self):
        self.assertLess(footer_height(540, 960), BAND_H_U)


class DismissFooterContentClearanceTests(unittest.TestCase):
    """The band the footer paints and the gap pages leave for it must agree.

    Broadcast puts its message area in a child widget, and a widget always
    stacks above canvas items — so when the reserved gap was smaller than the
    painted band, the viewport hung over the band and buried the draining rail
    with no way to raise it back out.
    """

    # Anything under 810 wide lands on the band's minimum height, which is
    # where the reserved gap and the painted band used to disagree.
    SCREENS = (
        (1080, 1920), (1920, 1080), (1200, 1920), (900, 1600), (810, 1440),
        (800, 1422), (768, 1366), (720, 1280), (1366, 768), (1280, 720),
        (2160, 3840), (3840, 2160),
    )

    def test_painted_band_matches_the_reserved_band(self):
        for w, h in self.SCREENS:
            with self.subTest(screen=f"{w}x{h}"):
                self.assertEqual(footer_height(w, h), int(footer_band_h(dismiss_u(w, h))))

    def test_page_content_stops_above_the_rail(self):
        for w, h in self.SCREENS:
            with self.subTest(screen=f"{w}x{h}"):
                content_bottom = int(round(page_chrome(w, h, timed=True).content_bottom))
                band_top = h - footer_height(w, h)
                rail_h = max(2, int(round(RAIL_H_U * dismiss_u(w, h))))
                # Last row the page may paint must sit above the rail's first.
                self.assertLessEqual(content_bottom - 1, band_top - 1)
                self.assertGreater(band_top + rail_h, band_top)


class DismissFooterRailTests(unittest.TestCase):
    def test_rail_fraction_matches_remaining_label(self):
        now = 1_000_000.0
        expires = now + 60.0
        # Fresh 60s page — nearly full.
        self.assertAlmostEqual(
            remaining_rail_fraction(expires, 60_000, now=now),
            1.0,
            places=3,
        )
        # 56s left of 60s — still ~93% full, not a tiny sliver.
        self.assertAlmostEqual(
            remaining_rail_fraction(expires, 60_000, now=now + 4.0),
            56.0 / 60.0,
            places=3,
        )
        self.assertAlmostEqual(
            remaining_rail_fraction(expires, 60_000, now=expires),
            0.0,
            places=3,
        )

    def test_pulse_restarts_a_dead_rail_job(self):
        root = mock.MagicMock()
        root.after = mock.MagicMock(return_value=99)
        canvas = mock.MagicMock()
        canvas.winfo_width.return_value = 1080
        canvas.create_rectangle.side_effect = range(1, 50)
        canvas.create_text.side_effect = range(100, 150)

        with mock.patch("src.dismiss_footer.tkfont.Font") as font_cls:
            font = mock.MagicMock()
            font.measure.return_value = 40
            font_cls.return_value = font
            footer = DismissFooter(canvas, root, screen_w=1080, screen_h=1920)
            footer.show(30_000, expires_at=time.time() + 30)
            self.assertTrue(footer._visible)
            self.assertIsNotNone(footer._rail_job)

            footer._rail_job = None
            footer.pulse()
            self.assertIsNotNone(footer._rail_job)


class BroadcastChipFitTests(unittest.TestCase):
    def test_long_from_name_shrinks_before_marquee(self):
        from src.display_panels import BroadcastPanel

        panel = BroadcastPanel.__new__(BroadcastPanel)
        panel.CHIP_VALUE_MIN_SIZE = 10
        panel.shell = mock.MagicMock()
        base = mock.MagicMock()
        base.cget.side_effect = lambda key: "Segoe UI" if key == "family" else 15
        panel.shell.chip_value_font = base

        with mock.patch("src.display_panels.tkfont.Font") as font_cls:
            font = mock.MagicMock()
            state = {"size": 15}
            widths = {15: 400, 14: 360, 13: 320, 12: 200, 11: 180, 10: 160}

            def configure(*_args, **kwargs):
                if "size" in kwargs:
                    state["size"] = kwargs["size"]

            font.configure.side_effect = configure
            font.measure.side_effect = lambda _text: widths[state["size"]]
            font_cls.return_value = font

            _fitted, fits = BroadcastPanel._chip_value_font_for(
                panel, "Master Bathroom Echo", 220,
            )
            self.assertTrue(fits)
            self.assertEqual(state["size"], 12)

    def test_extreme_name_reports_not_fit_at_minimum(self):
        from src.display_panels import BroadcastPanel

        panel = BroadcastPanel.__new__(BroadcastPanel)
        panel.CHIP_VALUE_MIN_SIZE = 10
        panel.shell = mock.MagicMock()
        base = mock.MagicMock()
        base.cget.side_effect = lambda key: "Segoe UI" if key == "family" else 15
        panel.shell.chip_value_font = base

        with mock.patch("src.display_panels.tkfont.Font") as font_cls:
            font = mock.MagicMock()
            font.configure.side_effect = lambda **_k: None
            font.measure.side_effect = lambda _text: 9999
            font_cls.return_value = font

            _fitted, fits = BroadcastPanel._chip_value_font_for(
                panel, "Master Bathroom Echo Extra Long Name", 100,
            )
            self.assertFalse(fits)


if __name__ == "__main__":
    unittest.main()
