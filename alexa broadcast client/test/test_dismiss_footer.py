import unittest

from src.dismiss_footer import (
    BAND_H_U,
    format_dismiss_parts,
    format_dismiss_value,
    footer_height,
    dismiss_u,
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


if __name__ == "__main__":
    unittest.main()
