"""Render the Huupe panels to PNGs so a layout can be judged by eye.

The unit tests prove nothing overlaps; they cannot say whether a page looks
like a basketball broadcast. This paints the real draw code onto a Pillow
canvas at wall resolution, in both orientations.

    python "dev assets/huupe_signal_bridge/preview_huupe.py" [outdir]
"""

from __future__ import annotations

import sys
import tkinter as tk
import tkinter.font as tkfont
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageDraw, ImageFont

CLIENT_ROOT = Path(__file__).resolve().parents[2] / "alexa broadcast client"
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

TEST_ROOT = CLIENT_ROOT / "test"
if str(TEST_ROOT) not in sys.path:
    sys.path.insert(0, str(TEST_ROOT))

from src.huupe_panel import HuupePanel  # noqa: E402
from test_dashboard_render_smoke import (  # noqa: E402
    sample_huupe_dashboard,
    sample_huupe_session,
)

FONT_FILES = {
    "normal": "C:/Windows/Fonts/segoeui.ttf",
    "bold": "C:/Windows/Fonts/segoeuib.ttf",
}

ANCHORS = {
    "nw": "la", "n": "ma", "ne": "ra",
    "w": "lm", "center": "mm", "": "mm", "e": "rm",
    "sw": "ld", "s": "md", "se": "rd",
}


def coerce_points(coords):
    """Tk takes either `x0, y0, x1, y1` or one flat sequence — accept both."""
    flat = []
    for value in coords:
        if isinstance(value, (list, tuple)):
            flat.extend(float(item) for item in value)
        else:
            flat.append(float(value))
    return [(flat[index], flat[index + 1]) for index in range(0, len(flat) - 1, 2)]


class PilCanvas:
    """Enough of the Tk canvas API for the panels to paint into a PNG."""

    def __init__(self, width, height, px_per_point):
        self.image = Image.new("RGB", (width, height), "#0B1730")
        self.draw = ImageDraw.Draw(self.image)
        self.px_per_point = px_per_point
        self._next = 1
        self._fonts = {}

    def _id(self):
        self._next += 1
        return self._next

    def _font(self, spec):
        size = int(spec[1]) if len(spec) > 1 else 12
        weight = spec[2] if len(spec) > 2 else "normal"
        key = (size, weight)
        if key not in self._fonts:
            pixels = max(6, int(round(size * self.px_per_point)))
            self._fonts[key] = ImageFont.truetype(FONT_FILES.get(weight, FONT_FILES["normal"]), pixels)
        return self._fonts[key]

    @staticmethod
    def _colour(value):
        value = str(value or "").strip()
        return value or None

    def create_text(self, *coords, **kwargs):
        x, y = float(coords[0]), float(coords[1])
        anchor = ANCHORS.get(str(kwargs.get("anchor") or "center").lower(), "mm")
        self.draw.text(
            (x, y), str(kwargs.get("text") or ""),
            font=self._font(kwargs.get("font") or ("Segoe UI", 12)),
            fill=self._colour(kwargs.get("fill")) or "#F2F7FF",
            anchor=anchor,
        )
        return self._id()

    def create_rectangle(self, *coords, **kwargs):
        points = coerce_points(coords)
        box = [points[0][0], points[0][1], points[1][0], points[1][1]]
        box = [min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])]
        self.draw.rectangle(
            box, fill=self._colour(kwargs.get("fill")),
            outline=self._colour(kwargs.get("outline")),
            width=int(kwargs.get("width") or 1),
        )
        return self._id()

    def create_oval(self, *coords, **kwargs):
        points = coerce_points(coords)
        box = [points[0][0], points[0][1], points[1][0], points[1][1]]
        self.draw.ellipse(
            box, fill=self._colour(kwargs.get("fill")),
            outline=self._colour(kwargs.get("outline")),
            width=int(kwargs.get("width") or 1),
        )
        return self._id()

    def create_line(self, *coords, **kwargs):
        points = coerce_points(coords)
        if len(points) < 2:
            return self._id()
        self.draw.line(
            points, fill=self._colour(kwargs.get("fill")) or "#F2F7FF",
            width=max(1, int(kwargs.get("width") or 1)), joint="curve",
        )
        return self._id()

    def create_polygon(self, *coords, **kwargs):
        points = coerce_points(coords)
        if len(points) < 3:
            return self._id()
        self.draw.polygon(
            points, fill=self._colour(kwargs.get("fill")),
            outline=self._colour(kwargs.get("outline")),
            width=max(1, int(kwargs.get("width") or 1)),
        )
        return self._id()

    def create_image(self, *_coords, **_kwargs):
        return self._id()

    def create_window(self, *_coords, **_kwargs):
        return self._id()

    def delete(self, _item):
        return None

    def type(self, _item):
        return "text"

    def itemcget(self, _item, _key):
        return ""

    def itemconfigure(self, *_args, **_kwargs):
        return None

    def coords(self, *_args):
        return []

    def bbox(self, *_args):
        return (0, 0, 0, 0)

    def tag_raise(self, *_args, **_kwargs):
        return None

    def tag_lower(self, *_args, **_kwargs):
        return None

    def configure(self, **_kwargs):
        return None


def make_panel(root, screen):
    px_per_point = float(root.winfo_fpixels("1p"))
    canvas = PilCanvas(screen[0], screen[1], px_per_point)
    shell = SimpleNamespace(
        screen_w=screen[0], screen_h=screen[1], content_canvas=canvas,
        overlay=SimpleNamespace(screen_w=screen[0], screen_h=screen[1]),
    )
    panel = HuupePanel(root, shell, {})
    panel.canvas = canvas
    panel.visible = True
    return panel, canvas


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent / "preview")
    out.mkdir(parents=True, exist_ok=True)

    root = tk.Tk()
    root.withdraw()
    tkfont.Font(root=root, family="Segoe UI", size=20)  # warm the font cache

    pages = {
        "dashboard": lambda panel: panel._render_dashboard(sample_huupe_dashboard()),
        "live-family": lambda panel: panel._render_session(
            sample_huupe_session(finished=False, players=3)),
        "live-freeplay": lambda panel: panel._render_session(
            sample_huupe_session(finished=False, players=0)),
        "final": lambda panel: panel._render_session(
            sample_huupe_session(finished=True, players=3)),
    }
    for name, paint in pages.items():
        for label, screen in (("portrait", (1080, 1920)), ("landscape", (1920, 1080))):
            panel, canvas = make_panel(root, screen)
            paint(panel)
            path = out / f"huupe-{name}-{label}.png"
            canvas.image.save(path)
            print(path)
    root.destroy()


if __name__ == "__main__":
    main()
