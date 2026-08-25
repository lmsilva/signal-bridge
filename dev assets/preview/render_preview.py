"""Headless preview renderer for the wall dashboards.

Replays the Tk canvas calls a panel makes into a PNG using PIL, so a design
pass can be reviewed without a display client, a poster PC, or a camera.

    python "dev assets/preview/render_preview.py" --out "dev assets/preview/out"

Not part of the shipped client and not imported by tests.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from unittest.mock import MagicMock

from PIL import Image, ImageDraw, ImageFont

CLIENT_ROOT = Path(__file__).resolve().parents[2] / "alexa broadcast client"
if str(CLIENT_ROOT) not in sys.path:
    sys.path.insert(0, str(CLIENT_ROOT))

from src.design_system import PX_PER_POINT  # noqa: E402

FONT_DIR = Path("C:/Windows/Fonts")
FONT_FILES = {
    ("segoe ui", False): "segoeui.ttf",
    ("segoe ui", True): "segoeuib.ttf",
    ("consolas", False): "consola.ttf",
    ("consolas", True): "consolab.ttf",
}
# Tk sizes are points; PIL sizes are px em. Keep the preview in step with the
# px-per-point the panels assume when they cannot measure a live display.
EM_PER_POINT = PX_PER_POINT / 1.33

_FONT_CACHE: dict[tuple[str, bool, int], ImageFont.FreeTypeFont] = {}


def load_font(family: str, points: float, bold: bool) -> ImageFont.FreeTypeFont:
    size = max(6, int(round(float(points) * EM_PER_POINT)))
    key = (str(family).lower(), bool(bold), size)
    cached = _FONT_CACHE.get(key)
    if cached is None:
        name = FONT_FILES.get((str(family).lower(), bool(bold))) or "segoeui.ttf"
        cached = ImageFont.truetype(str(FONT_DIR / name), size)
        _FONT_CACHE[key] = cached
    return cached


class RecordingCanvas:
    """Records canvas items in paint order (same surface the smoke tests use)."""

    def __init__(self):
        self.items: dict[int, dict] = {}
        self.order: list[int] = []
        self._next = 1

    def _add(self, kind, coords, kwargs):
        item = self._next
        self._next += 1
        self.items[item] = {"kind": kind, "coords": tuple(coords), "kwargs": dict(kwargs)}
        self.order.append(item)
        return item

    def create_text(self, *coords, **kwargs):
        return self._add("text", coords, kwargs)

    def create_rectangle(self, *coords, **kwargs):
        return self._add("rect", coords, kwargs)

    def create_line(self, *coords, **kwargs):
        return self._add("line", coords, kwargs)

    def create_oval(self, *coords, **kwargs):
        return self._add("oval", coords, kwargs)

    def create_polygon(self, *coords, **kwargs):
        return self._add("polygon", coords, kwargs)

    def create_arc(self, *coords, **kwargs):
        return self._add("arc", coords, kwargs)

    def create_image(self, *coords, **kwargs):
        return self._add("image", coords, kwargs)

    def create_window(self, *coords, **kwargs):
        return self._add("window", coords, kwargs)

    def delete(self, item):
        self.items.pop(item, None)
        if item in self.order:
            self.order.remove(item)

    def type(self, item):
        return self.items.get(item, {}).get("kind")

    def itemcget(self, item, key):
        return self.items.get(item, {}).get("kwargs", {}).get(key, "")

    def itemconfigure(self, item, **kwargs):
        if item in self.items:
            self.items[item]["kwargs"].update(kwargs)

    def coords(self, item, *values):
        if values:
            self.items[item]["coords"] = tuple(values)
        return list(self.items.get(item, {}).get("coords", ()))

    def bbox(self, item):
        entry = self.items.get(item)
        if not entry:
            return None
        if entry["kind"] == "text":
            font_spec = entry["kwargs"].get("font") or ("Segoe UI", 12)
            font = load_font(font_spec[0], font_spec[1], len(font_spec) > 2)
            text = str(entry["kwargs"].get("text") or "")
            width = max((font.getlength(line) for line in text.split("\n")), default=0)
            ascent, descent = font.getmetrics()
            height = (ascent + descent) * (text.count("\n") + 1)
            x, y = entry["coords"][0], entry["coords"][1]
            left, top = anchor_origin(
                str(entry["kwargs"].get("anchor") or "center"), x, y, width, height,
            )
            return (left, top, left + width, top + height)
        coords = entry["coords"]
        xs = coords[0::2] or (0,)
        ys = coords[1::2] or (0,)
        return (min(xs), min(ys), max(xs), max(ys))

    def tag_raise(self, *_a, **_k):
        return None

    def tag_lower(self, *_a, **_k):
        return None

    def configure(self, **_k):
        return None


def anchor_origin(anchor: str, x: float, y: float, w: float, h: float) -> tuple[float, float]:
    anchor = (anchor or "center").strip().lower()
    if anchor in ("", "center"):
        return x - w / 2, y - h / 2
    left = x - w / 2
    top = y - h / 2
    if "w" in anchor:
        left = x
    if "e" in anchor:
        left = x - w
    if "n" in anchor:
        top = y
    if "s" in anchor:
        top = y - h
    return left, top


def wrap_text(text: str, font, width_px: float) -> list[str]:
    lines = []
    for paragraph in str(text).split("\n"):
        if not width_px:
            lines.append(paragraph)
            continue
        current = ""
        for word in paragraph.split(" "):
            trial = word if not current else f"{current} {word}"
            if font.getlength(trial) <= width_px or not current:
                current = trial
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def smooth_polygon(points: list[tuple[float, float]], steps: int = 12):
    """Approximate Tk's smooth=True (quadratic B-spline through midpoints)."""
    n = len(points)
    if n < 3:
        return points
    out = []
    for i in range(n):
        p0 = points[i]
        p1 = points[(i + 1) % n]
        p2 = points[(i + 2) % n]
        start = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
        end = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        for step in range(steps + 1):
            t = step / steps
            mt = 1 - t
            out.append((
                mt * mt * start[0] + 2 * mt * t * p1[0] + t * t * end[0],
                mt * mt * start[1] + 2 * mt * t * p1[1] + t * t * end[1],
            ))
    return out


def norm_color(value):
    text = str(value or "").strip()
    if not text or text in ("", "none"):
        return None
    return text


def render(canvas: RecordingCanvas, size: tuple[int, int], bg="#0B1730") -> Image.Image:
    image = Image.new("RGB", size, bg)
    draw = ImageDraw.Draw(image)
    for item_id in canvas.order:
        entry = canvas.items.get(item_id)
        if not entry:
            continue
        kind = entry["kind"]
        coords = [float(value) for value in entry["coords"]]
        kwargs = entry["kwargs"]
        fill = norm_color(kwargs.get("fill"))
        outline = norm_color(kwargs.get("outline"))
        width = int(kwargs.get("width") or 1)
        if kind == "rect" and len(coords) >= 4:
            box = (min(coords[0], coords[2]), min(coords[1], coords[3]),
                   max(coords[0], coords[2]), max(coords[1], coords[3]))
            if box[2] - box[0] >= 1 and box[3] - box[1] >= 1:
                draw.rectangle(box, fill=fill, outline=outline, width=width)
        elif kind == "oval" and len(coords) >= 4:
            box = (min(coords[0], coords[2]), min(coords[1], coords[3]),
                   max(coords[0], coords[2]), max(coords[1], coords[3]))
            draw.ellipse(box, fill=fill, outline=outline, width=width)
        elif kind == "arc" and len(coords) >= 4:
            box = (min(coords[0], coords[2]), min(coords[1], coords[3]),
                   max(coords[0], coords[2]), max(coords[1], coords[3]))
            start = float(kwargs.get("start") or 0)
            extent = float(kwargs.get("extent") or 90)
            draw.arc(box, -(start + extent), -start, fill=outline or fill, width=width)
        elif kind == "line" and len(coords) >= 4:
            draw.line(coords, fill=fill or "#ffffff", width=max(1, width), joint="curve")
        elif kind == "polygon" and len(coords) >= 6:
            points = list(zip(coords[0::2], coords[1::2]))
            if kwargs.get("smooth"):
                points = smooth_polygon(points)
            draw.polygon(points, fill=fill, outline=outline)
            if outline and width > 1:
                draw.line(points + [points[0]], fill=outline, width=width, joint="curve")
        elif kind == "image":
            draw.rectangle(
                (coords[0] - 60, coords[1] - 60, coords[0] + 60, coords[1] + 60),
                outline="#2b3f63",
            )
        elif kind == "window":
            w = float(kwargs.get("width") or 100)
            h = float(kwargs.get("height") or 30)
            left, top = anchor_origin(kwargs.get("anchor"), coords[0], coords[1], w, h)
            draw.rectangle((left, top, left + w, top + h), outline="#2b3f63")
        elif kind == "text":
            font_spec = kwargs.get("font") or ("Segoe UI", 12)
            font = load_font(
                font_spec[0], font_spec[1] if len(font_spec) > 1 else 12, len(font_spec) > 2,
            )
            text = str(kwargs.get("text") or "")
            if not text:
                continue
            lines = wrap_text(text, font, float(kwargs.get("width") or 0))
            ascent, descent = font.getmetrics()
            line_h = ascent + descent
            block_w = max((font.getlength(line) for line in lines), default=0)
            block_h = line_h * len(lines)
            left, top = anchor_origin(
                kwargs.get("anchor"), coords[0], coords[1], block_w, block_h,
            )
            justify = str(kwargs.get("justify") or "left")
            for index, line in enumerate(lines):
                lw = font.getlength(line)
                lx = left
                if justify == "center":
                    lx = left + (block_w - lw) / 2
                elif justify == "right":
                    lx = left + block_w - lw
                draw.text((lx, top + index * line_h), line, font=font, fill=fill or "#ffffff")
    return image


def use_pil_metrics():
    """Let the shared header measure with the font this preview will paint.

    `page_header` asks Tk for the pill's text width and line height. There is no
    Tk here, so it would fall back to an estimate and draw a frame that does not
    match the glyphs — making the preview lie about the one thing it is for.
    """
    from src import page_header

    def measure(font_spec, text):
        font = load_font(font_spec[0], font_spec[1], len(font_spec) > 2)
        return int(font.getlength(str(text or "")))

    def linespace(font_spec):
        font = load_font(font_spec[0], font_spec[1], len(font_spec) > 2)
        ascent, descent = font.getmetrics()
        return int(ascent + descent)

    page_header._measure = measure
    page_header._linespace = linespace


def make_panel(cls, screen):
    root = MagicMock()
    root.winfo_screenwidth.return_value = screen[0]
    root.winfo_screenheight.return_value = screen[1]
    root.after.return_value = "job"
    shell = MagicMock()
    shell.screen_w, shell.screen_h = screen
    shell.overlay = MagicMock(screen_w=screen[0], screen_h=screen[1])
    canvas = RecordingCanvas()
    shell.content_canvas = canvas
    panel = cls(root, shell, {})
    panel.canvas = canvas
    panel.visible = True
    return panel, canvas


def sample_dashboard():
    return {
        "type": "autodarts.dashboard",
        "displaySeconds": 120,
        "totals": {"matches": 42, "legs": 57, "thisMonth": 1, "lastPlayedLabel": "Aug 02"},
        "board": {
            "name": "Movie Theater Board", "online": True, "statusLabel": "Error",
            "version": "1.0.7", "updateLabel": "Up to date", "os": "Linux",
            "dartsThrown": 3371, "corrections": 53, "accuracy": 98.43,
        },
        "leaderboard": [
            {"rank": index + 1, "crown": index == 0, "name": name, "wins": wins,
             "losses": losses, "winPct": pct, "x01Average": avg, "bestCheckout": out,
             "oneEighties": one80, "matches": wins + losses}
            for index, (name, wins, losses, pct, avg, out, one80) in enumerate((
                ("war d", 11, 4, 73, 24.3, 47, 0),
                ("trashpanda", 10, 25, 29, 24.6, 51, 1),
                ("tommy", 6, 1, 86, 20.3, 25, 0),
                ("Bot Level 2", 2, 0, 100, 31.0, 40, 0),
                ("kylie", 2, 0, 100, 12.7, 16, 0),
                ("emsss", 1, 0, 100, 27.1, 4, 0),
                ("lundisupcorp", 1, 0, 100, 0.0, None, 0),
                ("guest", 1, 2, 33, 18.2, 20, 0),
            ))
        ],
        "moreCount": 5,
        "byMonth": [
            {"key": f"2025-{m:02d}", "label": label, "count": count}
            for m, label, count in (
                (9, "Sep", 0), (10, "Oct", 0), (11, "Nov", 15), (12, "Dec", 2),
                (1, "Jan", 7), (2, "Feb", 1), (3, "Mar", 0), (4, "Apr", 4),
                (5, "May", 3), (6, "Jun", 3), (7, "Jul", 0), (8, "Aug", 1),
            )
        ],
        "rivalry": {"a": "trashpanda", "b": "war d", "aWins": 4, "bWins": 11,
                    "lastWinner": "trashpanda", "lastPlayedAt": "2026-08-02T00:00:00Z"},
        "records": {
            "bestMatchAverage": {"value": 36.3, "player": "trashpanda"},
            "highestCheckout": {"value": 48, "player": "war d"},
            "total180s": 2,
        },
    }


def sample_match(finished=False):
    return {
        "type": "autodarts.match",
        "persistent": not finished,
        "match": {
            "matchId": "m1", "revision": 4,
            "status": "finished" if finished else "live",
            "variant": "X01 501 · Best of 5", "settingsLine": "X01 501 · Best of 5",
            "durationSec": 742,
            "currentPlayerIndex": 0,
            "gameShot": "D20" if finished else "",
            "players": [
                {"name": "war d", "score": 141, "legs": 3, "average": 24.8,
                 "lastTurnPoints": 60, "isWinner": finished},
                {"name": "trashpanda", "score": 288, "legs": 1, "average": 21.2,
                 "lastTurnPoints": 41},
            ],
            "turn": {"points": 60, "busted": False, "darts": [
                {"seg": "T20", "x": 0.0, "y": 0.61},
                {"seg": "S5", "x": 0.30, "y": 0.72},
                {"seg": "S1", "x": -0.22, "y": 0.75},
            ]},
            "prevTurn": {"darts": [{"seg": "S20"}, {"seg": "T19"}, {"seg": "M"}]},
        },
    }


def sample_tour():
    return {
        "type": "roll-credits.tour",
        "secondsPerGame": 15, "dashboardSeconds": 25, "loop": True, "count": 29,
        "stats": {
            "total": 29, "thisYear": 8, "systemsCount": 6, "latestMilestone": 25,
            "bestMonth": {"label": "Aug 2026", "count": 3},
            "topBeatenWith": {"name": "War D", "count": 26},
            "undatedCount": 21,
            "latest": {
                "title": "Split/Second", "systemLabel": "Xbox 360", "induction": 29,
                "beatenWith": "War D, Tommy", "beatenAt": None,
            },
            "months": [
                {"key": f"2025-{m:02d}", "label": label, "count": count}
                for m, label, count in (
                    (9, "Sep", 0), (10, "Oct", 0), (11, "Nov", 0), (12, "Dec", 0),
                    (1, "Jan", 0), (2, "Feb", 1), (3, "Mar", 0), (4, "Apr", 0),
                    (5, "May", 2), (6, "Jun", 2), (7, "Jul", 0), (8, "Aug", 3),
                )
            ],
            "bySystem": [{"id": s, "label": s, "count": c} for s, c in (
                ("Arcade", 18), ("PC", 4), ("Dreamcast", 3), ("Xbox 360", 2), ("Saturn", 1),
            )],
            "beatenWith": [{"name": "War D", "count": 26},
                           {"name": "War D, Tommy", "count": 2},
                           {"name": "Tommy", "count": 1}],
        },
    }


def sample_card():
    return {
        "id": "g1", "title": "Split/Second", "systemLabel": "Xbox 360", "induction": 29,
        "beatenAt": "2026-08-23", "beatenWith": "War D, Tommy",
        "description": (
            "A racing game where the track itself is the weapon: trigger power plays to "
            "collapse cranes, explode fuel tanks and reroute the circuit under your rivals."
        ),
        "maxPlayers": 2, "difficulty": "Hard", "releaseDate": "2010-05-18",
        "developer": "Black Rock Studio", "publisher": "Disney Interactive",
        "genres": ["Racing", "Action"], "media": {},
    }


def scenes():
    from src.autodarts_panel import AutodartsPanel
    from src.roll_credits_panel import RollCreditsPanel

    use_pil_metrics()

    def autodarts_dashboard(screen):
        panel, canvas = make_panel(AutodartsPanel, screen)
        panel._render_dashboard(sample_dashboard())
        return canvas

    def autodarts_match(screen):
        panel, canvas = make_panel(AutodartsPanel, screen)
        panel._render_match(sample_match(finished=False))
        return canvas

    def autodarts_final(screen):
        panel, canvas = make_panel(AutodartsPanel, screen)
        panel._render_match(sample_match(finished=True))
        return canvas

    def roll_credits_dashboard(screen):
        panel, canvas = make_panel(RollCreditsPanel, screen)
        panel._tour = sample_tour()
        panel._games = []
        panel._draw_dashboard()
        return canvas

    def roll_credits_showcase(screen):
        panel, canvas = make_panel(RollCreditsPanel, screen)
        panel._tour = sample_tour()
        panel._games = [{"id": "g1"}] * 29
        panel._index = 4
        panel._draw_showcase(sample_card())
        return canvas

    return {
        "autodarts-dashboard": autodarts_dashboard,
        "autodarts-match": autodarts_match,
        "autodarts-final": autodarts_final,
        "roll-credits-dashboard": roll_credits_dashboard,
        "roll-credits-showcase": roll_credits_showcase,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent / "out"))
    parser.add_argument("--scene", action="append", default=None)
    parser.add_argument("--landscape", action="store_true")
    parser.add_argument("--scale", type=float, default=0.5)
    parser.add_argument("--tag", default="")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    screen = (1920, 1080) if args.landscape else (1080, 1920)
    wanted = args.scene or list(scenes())
    for name, build in scenes().items():
        if name not in wanted:
            continue
        canvas = build(screen)
        image = render(canvas, screen)
        if args.scale and args.scale != 1.0:
            image = image.resize(
                (int(screen[0] * args.scale), int(screen[1] * args.scale)), Image.LANCZOS,
            )
        suffix = "-landscape" if args.landscape else ""
        tag = f"-{args.tag}" if args.tag else ""
        path = out_dir / f"{name}{suffix}{tag}.png"
        image.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
