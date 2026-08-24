"""Display design-system tokens and geometry (1080×1920 / 1920×1080).

`--u` uses vmin so 1 design px is the same physical size in both orientations
(see display-design-system.md §1.5).
"""

from __future__ import annotations

from dataclasses import dataclass


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


def footer_band_h(u: float) -> float:
    # Keep in sync with dismiss_footer.BAND_H_U (compact chrome strip).
    return 64 * u


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
