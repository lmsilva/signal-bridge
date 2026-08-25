"""Card painters — round corners must be circular, never banded rectangles."""

import sys
import unittest
from pathlib import Path

CLIENT_ROOT = Path(__file__).resolve().parents[1]
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import paint_card, paint_gradient, rounded_points


class FakeCanvas:
    def __init__(self):
        self.items = []

    def _add(self, kind, coords, kwargs):
        self.items.append({"kind": kind, "coords": coords, "kwargs": kwargs})
        return len(self.items)

    def create_polygon(self, *coords, **kwargs):
        return self._add("polygon", coords, kwargs)

    def create_rectangle(self, *coords, **kwargs):
        return self._add("rect", coords, kwargs)

    def create_line(self, *coords, **kwargs):
        return self._add("line", coords, kwargs)

    def create_image(self, *coords, **kwargs):
        return self._add("image", coords, kwargs)


class DesignSystemPaintTests(unittest.TestCase):
    def test_rounded_points_never_land_on_the_box_corner(self):
        points = rounded_points((0, 0, 100, 80), 16)
        coords = list(zip(points[0::2], points[1::2]))
        for corner in ((0, 0), (100, 0), (100, 80), (0, 80)):
            self.assertNotIn(corner, coords)

    def test_card_fill_is_not_banded_rectangles(self):
        canvas = FakeCanvas()
        paint_card(canvas, (10, 20, 400, 260), u=1.0)
        rects = [item for item in canvas.items if item["kind"] == "rect"]
        self.assertEqual(rects, [], "banded rects were the square-corner bug")
        images = [item for item in canvas.items if item["kind"] == "image"]
        self.assertEqual(images, [], "a rectangular photo is a square-corner box")
        polys = [item for item in canvas.items if item["kind"] == "polygon"]
        self.assertGreaterEqual(len(polys), 2)
        for poly in polys:
            self.assertEqual(poly["kwargs"].get("smooth"), False)

    def test_rounded_gradient_stays_a_polygon_even_on_tk(self):
        canvas = FakeCanvas()
        canvas.tk = object()
        paint_gradient(canvas, (10, 20, 400, 260), "#1a2a4a", "#0b1730", radius=16)
        kinds = [item["kind"] for item in canvas.items]
        self.assertNotIn("image", kinds)
        self.assertNotIn("rect", kinds)
        self.assertIn("polygon", kinds)


if __name__ == "__main__":
    unittest.main()
