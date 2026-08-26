"""Display design-system tokens and geometry (1080×1920 / 1920×1080).

`--u` uses vmin so 1 design px is the same physical size in both orientations
(see display-design-system.md §1.5).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

try:
    from PIL import Image, ImageDraw, ImageTk
except Exception:  # pragma: no cover - Pillow is a runtime dep; tests may stub.
    Image = ImageDraw = ImageTk = None


# --- Colour tokens -----------------------------------------------------------
BG = "#0B1730"
BG_LIFT = "#16294F"  # optional top wash
INK = "#F2F7FF"
INK_2 = "#A4ACC0"  # ≈ rgba(242,247,255,.68) on dark
INK_3 = "#6B7388"  # ≈ rgba(242,247,255,.42)
ACCENT = "#5FD0FF"
GOOD = "#6EE7A8"
WARN = "#F5C453"
ALERT = "#FF7A6B"
LINE = "#264060"  # ≈ rgba(150,200,255,.18)
FILL = "#141F35"  # ≈ rgba(255,255,255,.045) over BG
CARD = FILL
CARD_EDGE = LINE
CONTAINER = BG

# --- Depth tokens (§1.4b) ----------------------------------------------------
# Tk has no native alpha or radii. Cards used to fake both with 16 banded
# rectangles and an 8-point spline that put control points on the box
# corners — that is what read as square "ears" and striped fills on the
# wall. Card bodies are now one circular-corner polygon; the page wash can
# still use a full-rect PIL gradient (a rounded PhotoImage becomes the
# same square ears when Tk drops the alpha).
BG_DEEP = "#050B1A"  # page bottom / vignette
BG_WASH = "#123056"  # page top
CARD_HI = "#16294F"  # card top
CARD_LO = "#0C1730"  # card bottom
CARD_BEVEL = "#4E7BB4"  # top edge highlight
EDGE = "#284A78"  # card border
EDGE_SOFT = "#1E3860"  # inner rules / row separators
SHADOW = "#03070F"
TRACK = "#152443"  # empty part of a bar / rail
GOLD = "#F5C453"
SILVER = "#C9D6EA"
BRONZE = "#E09256"
MEDALS = (GOLD, SILVER, BRONZE)
# Hand-tuned plates: blending an accent into navy desaturates to grey, so the
# tinted surfaces behind chips and winner rows are authored directly.
PLATE_GOLD = "#46300F"
PLATE_ACCENT = "#0E3252"
PLATE_GOOD = "#0F3527"
PLATE_ALERT = "#3D1421"
PLATE_MUTED = "#1A2540"


def plate_for(color: str) -> str:
    """Tinted surface that matches an accent without going grey."""
    return {
        GOLD: PLATE_GOLD,
        ACCENT: PLATE_ACCENT,
        GOOD: PLATE_GOOD,
        ALERT: PLATE_ALERT,
    }.get(color, PLATE_MUTED)


def _channels(color: str) -> tuple[int, int, int]:
    text = str(color or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        text = "0B1730"
    try:
        return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
    except ValueError:
        return 0x0B, 0x17, 0x30


def mix(color_a: str, color_b: str, t: float) -> str:
    """Blend two hex colours (`t=0` → a, `t=1` → b)."""
    ratio = max(0.0, min(1.0, float(t)))
    ar, ag, ab = _channels(color_a)
    br, bg_, bb = _channels(color_b)
    return "#%02x%02x%02x" % (
        int(round(ar + (br - ar) * ratio)),
        int(round(ag + (bg_ - ag) * ratio)),
        int(round(ab + (bb - ab) * ratio)),
    )


def tint(color: str, amount: float, *, over: str = BG) -> str:
    """Push a colour toward white (`amount > 0`) or toward the page (`< 0`)."""
    if amount >= 0:
        return mix(color, "#FFFFFF", amount)
    return mix(color, over, -amount)


def rounded_points(box, radius: float, *, steps: int = 16) -> list[float]:
    """Vertices along a true round-rect — circular corners, never the box corner.

    The old 8-point `smooth=True` spline put a control point on each bounding-box
    corner, which reads as a square "ear" on the wall. These points follow the
    quarter-circles instead, so `create_polygon` can stay unsmoothed.
    """
    x0, y0, x1, y1 = (float(value) for value in box)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    r = max(0.0, min(float(radius), (x1 - x0) / 2, (y1 - y0) / 2))
    if r <= 0.6:
        return [x0, y0, x1, y0, x1, y1, x0, y1]
    count = max(4, int(steps))
    points: list[float] = []
    corners = (
        (x0 + r, y0 + r, math.pi, math.pi * 1.5),
        (x1 - r, y0 + r, math.pi * 1.5, math.pi * 2.0),
        (x1 - r, y1 - r, 0.0, math.pi * 0.5),
        (x0 + r, y1 - r, math.pi * 0.5, math.pi),
    )
    for cx, cy, start, end in corners:
        for index in range(count + 1):
            angle = start + (end - start) * (index / count)
            points.extend((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return points


def retain_photo(canvas, photo) -> None:
    """Keep a PhotoImage alive — Tk drops it the moment Python's last ref dies."""
    if photo is None:
        return
    bucket = getattr(canvas, "_design_photos", None)
    if not isinstance(bucket, list):
        bucket = []
        try:
            canvas._design_photos = bucket
        except Exception:
            return
    bucket.append(photo)


def release_photos(canvas) -> None:
    bucket = getattr(canvas, "_design_photos", None)
    if isinstance(bucket, list):
        bucket.clear()


def _canvas_can_photo(canvas) -> bool:
    return ImageTk is not None and Image is not None and hasattr(canvas, "tk")


def _gradient_image(width: int, height: int, top_color: str, bottom_color: str, radius: float):
    """Per-pixel vertical gradient clipped to a circular-corner round-rect."""
    w = max(1, int(width))
    h = max(1, int(height))
    r = max(0, min(int(round(radius)), w // 2, h // 2))
    scale = 2
    sw, sh, sr = w * scale, h * scale, r * scale
    top = _channels(top_color)
    bot = _channels(bottom_color)
    column = Image.new("RGB", (1, sh))
    pixels = column.load()
    denom = max(1, sh - 1)
    for y in range(sh):
        t = y / denom
        pixels[0, y] = (
            int(round(top[0] + (bot[0] - top[0]) * t)),
            int(round(top[1] + (bot[1] - top[1]) * t)),
            int(round(top[2] + (bot[2] - top[2]) * t)),
        )
    grad = column.resize((sw, sh), Image.Resampling.BILINEAR)
    if sr > 0:
        mask = Image.new("L", (sw, sh), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=sr, fill=255)
        image = grad.convert("RGBA")
        image.putalpha(mask)
    else:
        image = grad.convert("RGBA")
    if scale != 1:
        image = image.resize((w, h), Image.Resampling.LANCZOS)
    return image


def paint_gradient(
    canvas,
    box,
    top_color: str,
    bottom_color: str,
    *,
    radius: float = 0.0,
    bands: int = 18,
    track=None,
):
    """Page wash (radius 0) can be a PhotoImage; rounded boxes stay polygons."""
    del bands
    x0, y0, x1, y1 = (float(value) for value in box)
    width = x1 - x0
    height = y1 - y0
    if height <= 0 or width <= 0:
        return []
    r = max(0.0, min(float(radius), width / 2, height / 2))
    # Rounded fills must be polygons. A PhotoImage is a rectangle; Windows Tk
    # often drops the alpha, which paints a light square at every card corner —
    # the same artifact the old banded-rect fill produced.
    if r > 0.6:
        return [paint_round_rect(
            canvas, box, radius=r, fill=mix(top_color, bottom_color, 0.38), track=track,
        )]
    if _canvas_can_photo(canvas):
        try:
            image = _gradient_image(
                max(1, int(round(width))),
                max(1, int(round(height))),
                top_color,
                bottom_color,
                0,
            )
            photo = ImageTk.PhotoImage(image, master=canvas)
            retain_photo(canvas, photo)
            item = canvas.create_image(x0, y0, image=photo, anchor="nw")
            if track:
                track(item)
            return [item]
        except Exception:
            pass
    return [paint_round_rect(
        canvas, box, radius=0, fill=mix(top_color, bottom_color, 0.42), track=track,
    )]


def paint_backdrop(canvas, screen_w: int, screen_h: int, *, track=None, accent: str = BG_WASH):
    """Page wash — a lit top fading into a deep bottom, instead of flat navy."""
    ids = paint_gradient(
        canvas, (0, 0, screen_w, screen_h), mix(BG, accent, 0.55), BG_DEEP,
        bands=26, track=track,
    )
    return ids


def paint_round_rect(
    canvas, box, *, radius: float = 0.0, fill: str = "", outline: str = "",
    width: float = 1, track=None,
):
    item = canvas.create_polygon(
        *rounded_points(box, radius),
        fill=fill or "",
        outline=outline or "",
        width=max(1, int(round(width))),
        smooth=False,
        joinstyle="round",
    )
    if track:
        track(item)
    return item


def paint_card(
    canvas,
    box,
    *,
    u: float = 1.0,
    radius: float | None = None,
    accent: str | None = None,
    lift: float = 0.0,
    track=None,
    shadow: bool = True,
):
    """Layered card: shadow, solid round body, hairline edge and top bevel."""
    x0, y0, x1, y1 = (float(value) for value in box)
    r = (18 * u) if radius is None else float(radius)
    r = max(0.0, min(r, (x1 - x0) / 2, (y1 - y0) / 2))
    top = mix(CARD_HI, accent, 0.10) if accent else CARD_HI
    bottom = CARD_LO
    if lift:
        top = tint(top, lift)
        bottom = tint(bottom, lift * 0.6)
    if shadow:
        # Inset horizontally so the shadow only reads as a soft seat under the
        # card instead of a hard band down its right edge.
        paint_round_rect(
            canvas, (x0 + 8 * u, y0 + 8 * u, x1 - 8 * u, y1 + 7 * u),
            radius=r, fill=mix(BG_DEEP, SHADOW, 0.6), outline="", track=track,
        )
    paint_gradient(canvas, box, top, bottom, radius=r, bands=16, track=track)
    edge = mix(EDGE, accent, 0.45) if accent else EDGE
    paint_round_rect(canvas, box, radius=r, fill="", outline=edge, width=max(1, 2 * u), track=track)
    # Bevel: a short lit run along the top edge sells the glass.
    bevel = canvas.create_line(
        x0 + r * 0.8, y0 + max(1.0, 1.5 * u), x1 - r * 0.8, y0 + max(1.0, 1.5 * u),
        fill=mix(top, CARD_BEVEL, 0.55), width=max(1, int(round(1.5 * u))),
    )
    if track:
        track(bevel)
    return bevel


def paint_bar(
    canvas, box, *, radius: float | None = None, fill: str = ACCENT, outline: str = "",
    track=None,
):
    """Rounded bar/pill; falls back to a rectangle when it is too small to round."""
    x0, y0, x1, y1 = (float(value) for value in box)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    short = min(x1 - x0, y1 - y0)
    r = (short / 2) if radius is None else max(0.0, min(float(radius), short / 2))
    if short < 3 or r < 1.2:
        item = canvas.create_rectangle(x0, y0, x1, y1, fill=fill, outline=outline or "")
        if track:
            track(item)
        return item
    return paint_round_rect(
        canvas, (x0, y0, x1, y1), radius=r, fill=fill, outline=outline, track=track,
    )


def paint_column(canvas, cx: float, baseline: float, half: float, height: float, color: str,
                 *, u: float = 1.0, track=None):
    """Chart bar with a rounded cap that still sits flat on the axis."""
    top = baseline - max(0.0, height)
    radius = min(half, max(0.0, height) / 2)
    paint_bar(canvas, (cx - half, top, cx + half, baseline), radius=radius, fill=color,
              track=track)
    if height > radius * 2:
        item = canvas.create_rectangle(
            cx - half, baseline - radius, cx + half, baseline, fill=color, outline="",
        )
        if track:
            track(item)
    cap = canvas.create_line(
        cx - half * 0.55, top + max(1.0, u), cx + half * 0.55, top + max(1.0, u),
        fill=mix(color, "#FFFFFF", 0.45), width=max(1, int(round(2 * u))),
    )
    if track:
        track(cap)


def paint_meter(canvas, box, fraction: float, color: str, *, track=None, track_color=TRACK):
    """Horizontal track with a proportional fill — used by every stat bar."""
    x0, y0, x1, y1 = (float(value) for value in box)
    paint_bar(canvas, (x0, y0, x1, y1), fill=track_color, track=track)
    share = max(0.0, min(1.0, float(fraction or 0.0)))
    if share <= 0:
        return
    height = y1 - y0
    end = x0 + max(height, (x1 - x0) * share)
    paint_bar(canvas, (x0, y0, min(x1, end), y1), fill=color, track=track)


THIN_SPACE = "\u2009"


def letterspace(text: str, *, gap: str = THIN_SPACE) -> str:
    """Fake tracking for small-caps labels (Tk has no letter-spacing)."""
    letters = str(text or "")
    if len(letters) < 2:
        return letters
    return gap.join(letters)


def paint_section_title(
    canvas,
    x: float,
    y: float,
    *,
    text: str,
    font,
    u: float = 1.0,
    fill: str = INK_2,
    accent: str = ACCENT,
    line_h: float = 0.0,
    track=None,
):
    """Accent tick + tracked caps label — the shared card header treatment."""
    tick_w = max(2.0, 3 * u)
    tick_h = max(8.0, line_h * 0.72 if line_h else 14 * u)
    tick_top = y + max(0.0, (line_h - tick_h) / 2) if line_h else y
    bar = canvas.create_rectangle(
        x, tick_top, x + tick_w, tick_top + tick_h, fill=accent, outline="",
    )
    if track:
        track(bar)
    label_x = x + tick_w + 9 * u
    item = canvas.create_text(
        label_x, y, anchor="nw", text=letterspace(text), fill=fill, font=font,
    )
    if track:
        track(item)
    return {"text_x": label_x, "tick_w": tick_w}
# Timer rings — muted arc for non-soonest; track under every ring.
MUTE_ARC = "#606878"  # ≈ rgba(255,255,255,.35) on BG
RING_TRACK = "#232E45"  # ≈ rgba(255,255,255,.10) on BG

# Steam-specific (steam-panel-redesign-spec §8)
STEAM_BG = "#08183A"
STEAM_STAGE_BG = "#061230"
STEAM_INK_DIM = "#B8C8E0"  # ≈ rgba(226,238,255,.80)
STEAM_INK_MUTED = "#8FB6E8"
STEAM_LINE = "#4A6A8A"
STEAM_TAG_BG = "#1A3A5C"
STEAM_TAG_BORDER = "#4A78A0"

# Shared photos print border
PRINT_BORDER = "#F4F2ED"


# Tk font sizes are *points*, box geometry is pixels. Windows display scaling
# (125% on the theatre wall) makes one point ~2.05px, so px offsets guessed from
# the point size overlap. Panels measure the real value; this is the fallback.
PX_PER_POINT = 2.05


def text_line_h(points: float, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT) -> float:
    """Painted height of one text line, in the same px space as the layout boxes."""
    scale = max(0.05, float(u))
    return max(9.0, float(points) * scale * max(1.0, float(px_per_pt)))


def stack_rows(
    rows,
    *,
    top: float = 0.0,
    available: float | None = None,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
    min_gap: float = 2.0,
) -> dict:
    """Lay out text rows top-down so painted glyphs can never overlap.

    ``rows`` is ``[(key, points, gap_after)]`` in design units. Gaps compress
    (never past ``min_gap``) first; if the type itself still cannot fit, the
    returned ``font_scale`` shrinks it rather than letting a card overflow.
    """
    keys = [key for key, _points, _gap in rows]
    points = {key: float(pt) for key, pt, _gap in rows}
    gaps = {key: max(0.0, float(gap)) * max(0.05, float(u)) for key, _points, gap in rows}
    floor = max(0.0, float(min_gap)) * max(0.05, float(u))
    floor_total = floor * max(0, len(keys) - 1)

    font_scale = 1.0
    if available is not None and keys:
        natural = sum(text_line_h(pt, u=u, px_per_pt=px_per_pt) for pt in points.values())
        room = max(0.0, float(available)) - floor_total
        if natural > room and natural > 0:
            font_scale = max(0.55, room / natural)

    heights = {
        key: text_line_h(points[key] * font_scale, u=u, px_per_pt=px_per_pt) for key in keys
    }
    scale = 1.0
    if available is not None and keys:
        slack = sum(gaps[key] for key in keys[:-1])
        room = max(0.0, float(available)) - sum(heights.values()) - floor_total
        if slack > room:
            scale = max(0.0, room / slack) if slack > 0 else 0.0
    ys: dict[str, float] = {}
    y = float(top)
    bottom = float(top)
    for index, key in enumerate(keys):
        ys[key] = y
        bottom = y + heights[key]
        if index < len(keys) - 1:
            y = bottom + floor + gaps[key] * scale
    return {
        "y": ys,
        "h": heights,
        "top": float(top),
        "bottom": bottom,
        "height": bottom - float(top),
        "font_scale": font_scale,
        "fits": available is None or bottom <= float(top) + float(available) + 0.5,
    }


def _finite(value) -> float | None:
    """Tk (or a stubbed root) can hand back non-numbers — treat those as absent."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")) or number <= 0:
        return None
    return number


def measure_px_per_point(root, u: float = 1.0, *, points: int = 20) -> float:
    """Painted px per font point on this display, falling back to `PX_PER_POINT`."""
    scale = max(0.05, float(u or 1.0))
    try:
        import tkinter.font as tkfont

        size = max(8, int(round(points * scale)))
        linespace = _finite(
            tkfont.Font(root=root, family="Segoe UI", size=size).metrics("linespace")
        )
    except Exception:
        linespace = None
    if linespace is None:
        return PX_PER_POINT
    return max(1.2, linespace / max(1.0, points * scale))


def text_measurer(root, font_spec):
    """Callable returning painted px width, estimated when Tk cannot measure."""
    size = float(font_spec[1] if len(font_spec) > 1 else 12)

    def estimate(text, _size=size):
        return len(str(text or "")) * _size * 0.72

    try:
        import tkinter.font as tkfont

        font = tkfont.Font(
            root=root,
            family=font_spec[0],
            size=int(font_spec[1]),
            weight=font_spec[2] if len(font_spec) > 2 else "normal",
        )
        if _finite(font.measure("M")) is None:
            return estimate

        def measure(text):
            width = _finite(font.measure(str(text or "")))
            return width if width is not None else estimate(text)

        return measure
    except Exception:
        return estimate


def stack_overlaps(stack: dict) -> bool:
    """True when any two rows in a `stack_rows` result collide."""
    rows = sorted(stack["y"].items(), key=lambda item: item[1])
    for (key, y), (_next_key, next_y) in zip(rows, rows[1:]):
        if y + stack["h"][key] > next_y + 0.5:
            return True
    return False


@dataclass(frozen=True)
class PageChrome:
    """Shared page frame geometry in screen px."""

    u: float
    portrait: bool
    screen_w: int
    screen_h: int
    margin_x: float
    content_w: float
    content_x: float
    header_top: float
    header_h: float
    content_top: float
    content_bottom: float  # exclusive of dismiss footer
    footer_h: float


def design_u(screen_w: int, screen_h: int) -> float:
    """`--u: calc(100vmin / 1080)`."""
    screen_w = max(64, int(screen_w))
    screen_h = max(64, int(screen_h))
    return min(screen_w, screen_h) / 1080.0


def is_portrait(screen_w: int, screen_h: int) -> bool:
    return int(screen_h) >= int(screen_w)


FOOTER_BAND_H_U = 64
# The painted band never goes below this, so neither may the space reserved
# for content. When the two disagreed, a page whose content is a child widget
# (the broadcast message viewport) hung over the band and covered the rail —
# and a widget always stacks above canvas items, so raising the footer could
# not fix it.
FOOTER_BAND_MIN_H = 48


def footer_band_h(u: float) -> float:
    """Height of the shared dismiss band. Canonical — `dismiss_footer` uses it."""
    return float(max(FOOTER_BAND_MIN_H, int(round(FOOTER_BAND_H_U * u))))


def page_chrome(screen_w: int, screen_h: int, *, timed: bool = True) -> PageChrome:
    """Shared header + content zone + optional dismiss footer."""
    u = design_u(screen_w, screen_h)
    portrait = is_portrait(screen_w, screen_h)
    footer_h = footer_band_h(u) if timed else 0.0
    if portrait:
        margin_x = 40 * u
        content_w = 1000 * u
        header_top = 32 * u
        header_h = 84 * u
        content_top = 136 * u
        # Design: content 136–1824 when footer present.
        content_bottom = screen_h - footer_h
    else:
        margin_x = 60 * u
        content_w = 1800 * u
        header_top = 28 * u
        header_h = 84 * u
        content_top = 132 * u
        content_bottom = screen_h - footer_h
    content_x = (screen_w - content_w) / 2
    return PageChrome(
        u=u,
        portrait=portrait,
        screen_w=screen_w,
        screen_h=screen_h,
        margin_x=margin_x,
        content_w=content_w,
        content_x=content_x,
        header_top=header_top,
        header_h=header_h,
        content_top=content_top,
        content_bottom=content_bottom,
        footer_h=footer_h,
    )


def approx_rgba_white(alpha: float, *, on: str = BG) -> str:
    """Blend white over `on` for Tk (no real alpha fills)."""
    a = max(0.0, min(1.0, float(alpha)))
    on = (on or BG).lstrip("#")
    if len(on) != 6:
        on = "0B1730"
    br, bg, bb = int(on[0:2], 16), int(on[2:4], 16), int(on[4:6], 16)
    r = int(round(br * (1 - a) + 255 * a))
    g = int(round(bg * (1 - a) + 255 * a))
    b = int(round(bb * (1 - a) + 255 * a))
    return f"#{r:02x}{g:02x}{b:02x}"
