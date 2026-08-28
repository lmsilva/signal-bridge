"""Huupe Mini overlay: live session, final card, and the career dashboard.

The hoop reports two very different shapes. Family Mode names its players and
keeps a score per person; free play knows only that a ball went in and roughly
where from. Rather than force one into the other, the body of the session page
switches: a scoreboard when there are names, a solo stat block when there are
not. Everything else — mode bar, headline, shooting breakdown, footer — is
shared, so the two read as the same page.

Both pages are laid out as a broadcast graphic: a hero plate with a shooting
dial, a blueprint half-court coloured by share of points, and a ticker of the
last shots. Portrait stacks those; landscape puts the court and its legend
beside the scoreboard instead of stretching one column across 1920px.
"""

import json
import math
from pathlib import Path

from src.design_system import (
    ACCENT,
    ALERT,
    CARD_LO,
    EDGE_SOFT,
    GOOD,
    INK,
    INK_2,
    INK_3,
    MEDALS,
    PLATE_ACCENT,
    PX_PER_POINT,
    SILVER,
    TRACK,
    WARN,
    design_u,
    letterspace,
    measure_px_per_point,
    mix,
    page_chrome,
    paint_bar,
    paint_gradient,
    paint_meter,
    paint_round_rect,
    paint_section_title,
    plate_for,
    retain_photo,
    stack_rows,
    text_line_h,
    text_measurer,
    tint,
)
from src.display_panels import BasePanel
from src.page_header import paint_page_header

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageTk
except ImportError:  # pragma: no cover — portable builds always ship Pillow
    Image = ImageDraw = ImageFilter = ImageTk = None

ZONE_ORDER = ("layup", "one", "two", "three")

# Zone colours run cool to warm with distance, so the shooting card reads as a
# range even before the numbers do. They are also what ties a legend row to its
# region on the court.
ZONE_COLORS = {
    "layup": SILVER,
    "one": ACCENT,
    "two": GOOD,
    "three": WARN,
}

# What each zone is called when the bridge is older than these labels. "1 PT"
# on its own used to read as *Player 1*, which is what these names fix.
ZONE_FALLBACK = {
    "layup": ("Layup", "At the rim", "0.1 PT"),
    "one": ("Short Range", "Low post", "1 PT"),
    "two": ("Mid Range", "High post", "2 PT"),
    "three": ("Deep Range", "Top of the key", "3 PT"),
}

ZONE_POINT_VALUES = {"layup": 0.1, "one": 1.0, "two": 2.0, "three": 3.0}

# Chart heat answers "where do the points come from". Kept as one switch so it
# can later become share of makes / attempts without rewriting the drawing.
HEAT_STAT = "points"

# Spec tokens (Shot Zone Enhancements rev 4).
GLASS_CARD = "#0D1A32"
GLASS_BORDER = mix("#7CA9DA", GLASS_CARD, 0.35)
# How opaque a card sits over the page art, and how strong the ghost type is
# under it. Cards any denser than this and the editorial background is wasted.
GLASS_ALPHA = 0.80
GHOST_ALPHA = 0.13
PANEL_GAP = "#0F1D36"
COURT_BASE = "#0B1A33"
COURT_LINE = "#A9C6E8"
RIM_COLOR = "#FF8A7A"
PAGE_TOP = "#0C1936"
PAGE_BOTTOM = "#0A1428"
SCRIM_BASE = "#0B1730"
GHOST_INK = "#E8F1FB"
LABEL_SOFT = "#8FA9C9"
LABEL_DIM = "#6C84A6"
LABEL_EMPTY = "#54687F"
LABEL_DARK_VALUE = "#0E1B31"
LABEL_DARK_NAME = "#12233E"
ACCENT_CORAL = "#FF6157"
ACCENT_AMBER = "#EFA23C"

# Template viewBox 0 0 560 530 — 1 foot = 10 units, hoop at the bottom.
TEMPLATE_W = 560.0
TEMPLATE_H = 530.0

# Cold navy → teal → amber → coral. Mix between stops; never a fixed four-colour set.
HEAT_STOPS = (
    (0.00, "#152540"),
    (0.28, "#155E71"),
    (0.55, "#21A895"),
    (0.78, "#EFA23C"),
    (1.00, "#FF6157"),
)


def heat_color(t):
    """Colour for a 0..1 heat value on the cold-to-hot ramp."""
    share = max(0.0, min(1.0, float(t or 0.0)))
    for (low, low_color), (high, high_color) in zip(HEAT_STOPS, HEAT_STOPS[1:]):
        if share <= high:
            span = high - low
            return mix(low_color, high_color, (share - low) / span if span else 0.0)
    return HEAT_STOPS[-1][1]


def format_score(value):
    """Scores keep a tenth only when a layup actually put one there."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "0"
    if abs(number - round(number)) < 0.05:
        return str(int(round(number)))
    return f"{number:.1f}"


def clip(text, limit):
    text = str(text or "")
    if len(text) <= limit:
        return text
    return f"{text[: max(1, limit - 1)]}…"


def session_fingerprint(session):
    try:
        return json.dumps(session or {}, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(session)


def dashboard_fingerprint(payload):
    try:
        body = {
            key: (payload or {}).get(key)
            for key in ("totals", "leaderboard", "moreCount", "zones", "records", "recent", "device")
        }
        return json.dumps(body, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(payload)


def zone_rows(payload):
    """Always four rows in a fixed order, so the card never reflows mid-session."""
    by_zone = {row.get("zone"): row for row in (payload or []) if isinstance(row, dict)}
    rows = []
    for zone in ZONE_ORDER:
        row = by_zone.get(zone) or {}
        label, note, points = ZONE_FALLBACK[zone]
        made = int(row.get("made") or 0)
        attempts = int(row.get("attempts") or 0)
        unit = ZONE_POINT_VALUES[zone]
        if row.get("scored") is not None:
            try:
                scored = float(row.get("scored"))
            except (TypeError, ValueError):
                scored = round(made * unit, 1)
        else:
            scored = round(made * unit, 1)
        rows.append({
            "zone": zone,
            "label": row.get("label") or label,
            "note": row.get("note") or note,
            "pointsLabel": row.get("pointsLabel") or points,
            "points": float(row.get("points") if row.get("points") is not None else unit),
            "scored": scored,
            "made": made,
            "attempts": attempts,
            "pct": int(row.get("pct") or 0),
        })
    return rows


def band_stat(row):
    """The number that colours a band — points by default, see HEAT_STAT."""
    if HEAT_STAT == "makes":
        return float(row.get("made") or 0)
    if HEAT_STAT == "attempts":
        return float(row.get("attempts") or 0)
    return float(row.get("scored") or 0)


def hot_zone(rows):
    """The band with the most points. Ties: more attempts, then longer range."""
    ranked = [row for row in rows if band_stat(row) > 0]
    if not ranked:
        return None
    order = {zone: index for index, zone in enumerate(ZONE_ORDER)}
    return sorted(
        ranked,
        key=lambda row: (band_stat(row), row["attempts"], order[row["zone"]]),
        reverse=True,
    )[0]


def band_heat(rows):
    """Per-zone heat for the blueprint court: share of points, relative to peak."""
    total = sum(band_stat(row) for row in rows)
    peak = max((band_stat(row) for row in rows), default=0.0)
    hot = hot_zone(rows)
    bands = {}
    for row in rows:
        points = band_stat(row)
        t = (points / peak) if peak > 0 else 0.0
        share = int(round(100 * points / total)) if total > 0 else 0
        bands[row["zone"]] = {
            "t": t,
            "share_pct": share,
            "color": heat_color(t),
            "empty": row["attempts"] == 0,
            "bright": t >= 0.6 and row["zone"] != "three",
            "is_hot": hot is not None and hot["zone"] == row["zone"],
            "points": points,
            "label": row["label"],
        }
    return bands, hot, total


def arc_points(cx, cy, radius, start_deg, end_deg, *, steps=40):
    """Flat [x, y, ...] along a circular arc. 0° is straight up, +° clockwise."""
    span = float(end_deg) - float(start_deg)
    count = max(2, int(steps))
    points = []
    for index in range(count + 1):
        angle = math.radians(float(start_deg) + span * (index / count))
        points.extend((cx + radius * math.sin(angle), cy - radius * math.cos(angle)))
    return points


def _svg_arc_points(cx, cy, radius, x_start, y_start, x_end, y_end, *, sweep_ccw=True, steps=48):
    """Polygon points along the SVG-style arc used by the three-point line."""
    start = math.atan2(y_start - cy, x_start - cx)
    end = math.atan2(y_end - cy, x_end - cx)
    if sweep_ccw and end < start:
        end += 2 * math.pi
    if not sweep_ccw and start < end:
        start += 2 * math.pi
    span = end - start
    count = max(2, int(steps))
    points = []
    for index in range(count + 1):
        angle = start + span * (index / count)
        points.extend((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return points


def court_regions(box):
    """Half-court geometry from the 560×530 template, scaled into `box`.

    Proportions are survey-accurate (1 ft = 10 units). The drawing never
    stretches — a non-matching card just letterboxes the court.
    """
    x0, y0, x1, y1 = (float(value) for value in box)
    width = max(1.0, x1 - x0)
    height = max(1.0, y1 - y0)
    scale = min(width / TEMPLATE_W, height / TEMPLATE_H)
    court_w = TEMPLATE_W * scale
    court_h = TEMPLATE_H * scale
    ox = (x0 + x1) / 2 - court_w / 2
    oy = (y0 + y1) / 2 - court_h / 2

    def T(x, y):
        return ox + float(x) * scale, oy + float(y) * scale

    def R(value):
        return float(value) * scale

    rim_x, rim_y = T(280, 447.5)
    left, top = T(30, 30)
    right, bottom = T(530, 500)
    tl = T(60, 500)
    tr = T(500, 500)
    tl_corner = T(60, 358.02)
    tr_corner = T(500, 358.02)
    arc = _svg_arc_points(
        rim_x, rim_y, R(237.5),
        tl_corner[0], tl_corner[1], tr_corner[0], tr_corner[1],
        sweep_ccw=True, steps=56,
    )
    mid_poly = [
        tl[0], tl[1], tl_corner[0], tl_corner[1], *arc,
        tr_corner[0], tr_corner[1], tr[0], tr[1],
    ]
    three_path = [tl_corner[0], tl_corner[1], *arc, tr_corner[0], tr_corner[1]]
    ft_y = T(280, 310)[1]
    return {
        "scale": scale,
        "origin": (ox, oy),
        "size": (court_w, court_h),
        "court": (left, top, right, bottom),
        "court_radius": R(10),
        "rim": (rim_x, rim_y, R(7.5)),
        "backboard": (*T(250, 460), *T(310, 460)),
        "key": (*T(200, 310), *T(360, 500)),
        "ft_arc": arc_points(rim_x, ft_y, R(60), -90, 90, steps=32),
        "restricted_arc": arc_points(rim_x, rim_y, R(40), -90, 90, steps=24),
        "centre": arc_points(*T(280, 30), R(60), 90, 270, steps=32),
        "layup_r": R(50),
        "short_r": R(137.5),
        "mid_poly": mid_poly,
        "three_path": three_path,
        "three_sides": (
            (tl[0], tl[1], tl_corner[0], tl_corner[1]),
            (tr[0], tr[1], tr_corner[0], tr_corner[1]),
        ),
        "deep_radius": R(470),
        "labels": {
            "three": T(280, 112),
            "two": T(280, 246),
            "one": T(280, 338),
            # Above the template's 412 so the share clears the backboard.
            "layup": T(280, 404),
        },
        "label_value_dy": {"three": R(38), "two": R(34), "one": R(28), "layup": R(20)},
        "label_unit_dy": {"three": R(54), "two": R(49), "one": R(42), "layup": None},
        "label_name_size": {"three": 12, "two": 12, "one": 11, "layup": 9},
        "label_value_size": {"three": 32, "two": 28, "one": 22, "layup": 16},
    }


def _hex_rgb(color):
    text = str(color or "#000000").lstrip("#")
    if len(text) != 6:
        return (0, 0, 0)
    return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4))


def deep_fade_alpha(t):
    """Opacity of the deep band `t` rim-radii out — the spec's gradient stops.

    Anything nearer than the arc keeps the first stop, the way CSS holds a
    radial gradient's colour inside its first offset.
    """
    t = max(0.0, float(t or 0.0))
    if t <= 0.485:
        return 0.85
    if t < 0.72:
        u = (t - 0.485) / (0.72 - 0.485)
        return 0.85 * (1 - u) + 0.32 * u
    if t < 0.98:
        u = (t - 0.72) / (0.98 - 0.72)
        return 0.32 * (1 - u) + 0.06 * u
    return 0.06


def deep_fade_bands(court_box, *, rim_y, radius, color, base, corner=0.0, steps=44):
    """Rows that fade the deep band from hot at the arc to navy by half court.

    Returned as plain rectangles rather than an image: Tk cannot clip, and a
    PhotoImage needs a real widget, so a canvas without one (the preview
    renderer, the smoke tests) used to fall back to one flat block of colour
    and lose the heat ramp entirely.
    """
    x0, y0, x1, y1 = (float(value) for value in court_box)
    height = y1 - y0
    if height <= 0 or x1 <= x0 or radius <= 0:
        return []
    r = max(0.0, min(float(corner), (x1 - x0) / 2, height / 2))
    count = max(2, int(steps))
    rows = []
    for index in range(count):
        top = y0 + height * (index / count)
        bottom = y0 + height * ((index + 1) / count)
        alpha = deep_fade_alpha((float(rim_y) - (top + bottom) / 2) / float(radius))
        inset = 0.0
        if r > 0:
            # Keep the rows inside the rounded corners instead of squaring them.
            for edge in (top - y0, y1 - bottom):
                if edge < r:
                    inset = max(inset, r - math.sqrt(max(0.0, r * r - (r - edge) ** 2)))
        rows.append((x0 + inset, top, x1 - inset, bottom, mix(base, color, alpha)))
    return rows


def deep_fade_image(width, height, *, rim_xy, radius, color, base, corner=0.0, steps=180):
    """Smooth radial fade for the deep band — the version the wall gets.

    `deep_fade_bands` is the same ramp as stacked rectangles; on a 1080-wide
    court those rows are thick enough to read as stripes, so wherever the
    canvas can take a PhotoImage the gradient is drawn here instead.
    """
    if Image is None or ImageDraw is None:
        return None
    w, h = int(round(width)), int(round(height))
    if w < 2 or h < 2 or radius <= 0:
        return None
    img = Image.new("RGB", (w, h), base)
    draw = ImageDraw.Draw(img)
    rx, ry = rim_xy
    count = max(8, int(steps))
    # Far to near: each ring paints over the fainter one outside it.
    for index in range(count, 0, -1):
        r = float(radius) * (index / count)
        colour = mix(base, color, deep_fade_alpha(r / float(radius)))
        draw.ellipse((rx - r, ry - r, rx + r, ry + r), fill=colour)
    r = max(0.0, min(float(corner), w / 2, h / 2))
    if r > 0.6:
        mask = Image.new("L", (w, h), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, w - 1, h - 1), radius=int(round(r)), fill=255,
        )
        out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask=mask)
        return out
    return img.convert("RGBA")


def glow_stroke_image(width, height, points, color, stroke_width, *, blur=9):
    """Soft halo along the hot band's edge — one showpiece effect (§8)."""
    if Image is None or ImageDraw is None or ImageFilter is None:
        return None
    w, h = int(round(width)), int(round(height))
    if w < 2 or h < 2 or len(points) < 4:
        return None
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    red, green, blue = _hex_rgb(color)
    xy = [(points[i], points[i + 1]) for i in range(0, len(points) - 1, 2)]
    draw.line(xy, fill=(red, green, blue, 190), width=max(2, int(round(stroke_width))), joint="curve")
    return img.filter(ImageFilter.GaussianBlur(radius=max(1.0, float(blur))))


def clipped_circle(cx, cy, radius, box, *, steps=72):
    """Circle outline clamped into `box`, because Tk has no clipping region.

    The short-range ring reaches past the baseline; drawn as an oval it spilled
    out of the court panel and over the card's caption.
    """
    x0, y0, x1, y1 = (float(value) for value in box)
    points = []
    for index in range(max(8, int(steps))):
        angle = 2 * math.pi * index / max(8, int(steps))
        x = cx + radius * math.cos(angle)
        y = cy + radius * math.sin(angle)
        points.extend((min(max(x, x0), x1), min(max(y, y0), y1)))
    return points


def glow_ring_layers(color, stroke_width, base=PANEL_GAP):
    """Widths and colours that fake a soft glow on the hot band's edge.

    Tk strokes have no alpha and no blur, so the halo is three passes that get
    narrower and hotter — painted under the dark seam, which leaves a lit
    fringe on both sides of the boundary.
    """
    stroke = max(2.0, float(stroke_width))
    layers = []
    for factor, blend in ((1.0, 0.34), (0.66, 0.62), (0.38, 1.0)):
        tone = color if blend >= 1.0 else mix(base, color, blend)
        layers.append((max(2, int(round(stroke * factor))), tone))
    return layers


def reduced_motion_preferred():
    """Windows SPI_GETCLIENTAREAANIMATION when available; else allow motion."""
    try:
        import ctypes
        value = ctypes.c_int(1)
        if ctypes.windll.user32.SystemParametersInfoW(0x1042, 0, ctypes.byref(value), 0):
            return value.value == 0
    except Exception:
        pass
    return False


def court_photo_path():
    """Optional local court photo — never fetched from the network."""
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / "dev assets" / "huupe_signal_bridge" / "Shot Zone Enhancements" / "court-photo.jpg",
        here.parents[2] / "dev assets" / "huupe_signal_bridge" / "court-photo.jpg",
        here.parents[1] / "assets" / "huupe-court.jpg",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def stack_boxes(x0, x1, top, bottom, rows, gap):
    """Stack `(name, min_h, flex_weight[, max_h])` rows into boxes.

    A cap matters on the tall portrait wall: free play has no scoreboard, and
    without one the shot chart used to inherit 800px of leftover and paint a
    small court adrift in the middle of it.
    """
    rows = [tuple(row) for row in rows if row]
    if not rows:
        return {}
    names = [row[0] for row in rows]
    heights = {row[0]: float(row[1]) for row in rows}
    weights = {row[0]: float(row[2]) for row in rows}
    caps = {row[0]: (float(row[3]) if len(row) > 3 and row[3] else None) for row in rows}

    available = max(0.0, bottom - top) - gap * (len(rows) - 1)
    fixed = sum(heights.values())
    if fixed > available and fixed > 0:
        # Everything still has to fit: a card pushed past the footer is worse
        # than one that gave up a few pixels of headroom.
        squeeze = max(0.0, available / fixed)
        heights = {name: height * squeeze for name, height in heights.items()}
        fixed = available

    slack = available - fixed
    while slack > 0.5:
        active = [
            name for name in names
            if weights[name] > 0 and (caps[name] is None or heights[name] < caps[name] - 0.5)
        ]
        if not active:
            break
        total = sum(weights[name] for name in active)
        share = {name: slack * (weights[name] / total) for name in active}
        clamped = False
        for name in active:
            cap = caps[name]
            if cap is not None and heights[name] + share[name] > cap:
                slack -= cap - heights[name]
                heights[name] = cap
                clamped = True
        if clamped:
            continue
        for name in active:
            heights[name] += share[name]
        slack = 0.0

    boxes = {}
    y = float(top)
    for name in names:
        boxes[name] = (x0, y, x1, y + heights[name])
        y += heights[name] + gap
    return boxes


def split_row(box, weights, gap):
    """Cut one box into side-by-side columns."""
    x0, y0, x1, y1 = box
    total = sum(weights) or 1
    width = (x1 - x0) - gap * (len(weights) - 1)
    out = []
    x = x0
    for weight in weights:
        span = width * (weight / total)
        out.append((x, y0, x + span, y1))
        x += span + gap
    return out


def layout_huupe_session(screen_w, screen_h, *, timed, finished=False, players=0):
    """Portrait stacks the page; landscape puts the court beside the scoreboard."""
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 8 * u
    y1 = chrome.content_bottom - 12 * u
    gap = 12 * u

    boxes = {"chrome": chrome, "finished": finished}
    mode_h = 46 * u
    boxes["mode"] = (x0, y0, x1, y0 + mode_h)
    body_top = y0 + mode_h + gap

    if chrome.portrait:
        rows = [
            ("hero", 250 * u, 1.0, 520 * u),
            ("body", 250 * u, 1.4, 620 * u) if players else None,
            ("tiles", 170 * u, 0.5, 380 * u),
            ("chart", 420 * u, 1.0, 640 * u),
            ("ticker", 130 * u, 0.35, 190 * u),
        ]
        stacked = stack_boxes(x0, x1, body_top, y1, rows, gap)
        boxes.update(stacked)
        court, zones = split_row(stacked["chart"], (0.44, 0.56), gap)
        boxes.pop("chart")
        boxes["court"] = court
        boxes["zones"] = zones
        return boxes

    ticker_h = 96 * u
    middle = (body_top, y1 - ticker_h - gap)
    boxes["ticker"] = (x0, y1 - ticker_h, x1, y1)

    left, court, zones = split_row(
        (x0, middle[0], x1, middle[1]), (0.46, 0.26, 0.28), gap,
    )
    boxes["court"] = court
    boxes["zones"] = zones
    column = [
        ("hero", 200 * u, 0.6, 420 * u),
        ("body", 200 * u, 1.4, 520 * u) if players else None,
        ("tiles", 150 * u, 0.5, 400 * u),
    ]
    boxes.update(stack_boxes(left[0], left[2], left[1], left[3], column, gap))
    return boxes


def layout_huupe_dashboard(screen_w, screen_h, *, timed=True, recent=False):
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 10 * u
    y1 = chrome.content_bottom - 14 * u
    gap = 12 * u

    boxes = {"chrome": chrome}
    if chrome.portrait:
        rows = [
            ("totals", 170 * u, 0.0),
            ("leaderboard", 240 * u, 1.0, 620 * u),
            ("recent", 200 * u, 0.75, 460 * u) if recent else None,
            ("chart", 420 * u, 1.2, 640 * u),
            ("records", 210 * u, 0.2, 280 * u),
        ]
        stacked = stack_boxes(x0, x1, y0, y1, rows, gap)
        boxes.update(stacked)
        court, zones = split_row(stacked["chart"], (0.44, 0.56), gap)
        boxes.pop("chart")
        boxes["court"] = court
        boxes["zones"] = zones
        return boxes

    totals_h = 168 * u
    footer_h = 215 * u
    boxes["totals"] = (x0, y0, x1, y0 + totals_h)
    middle_top = y0 + totals_h + gap
    middle_bottom = y1 - footer_h - gap

    board, court, zones = split_row(
        (x0, middle_top, x1, middle_bottom), (0.40, 0.28, 0.32), gap,
    )
    boxes["leaderboard"] = board
    boxes["court"] = court
    boxes["zones"] = zones

    footer = (x0, y1 - footer_h, x1, y1)
    if recent:
        left, right = split_row(footer, (0.58, 0.42), gap)
        boxes["recent"] = left
        boxes["records"] = right
    else:
        boxes["records"] = footer
    return boxes


class HuupePanel(BasePanel):
    """Owns chrome for the session page and the dashboard."""

    def __init__(self, root, shell, config: dict):
        super().__init__(root, shell, config)
        self._mode = None  # session | dashboard
        self._session_id = None
        self._revision = -1
        self._session_fp = None
        self._dashboard_fp = None
        self._payload = None
        self._scale = 1.0
        self._px_per_pt = PX_PER_POINT
        self._glow_job = None
        self._glow_items = []
        self._glow_color = ACCENT_CORAL
        self._glow_phase = 0.0
        self._huupe_photos = []
        self._glass_painted = False

    def hide(self):
        self._stop_glow()
        self._huupe_photos.clear()
        super().hide()

    def _stop_glow(self):
        job = self._glow_job
        self._glow_job = None
        self._glow_items = []
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass

    def _start_glow(self, item_ids, color):
        self._stop_glow()
        self._glow_items = [item for item in item_ids if item]
        self._glow_color = color
        self._glow_phase = 0.0
        if not self._glow_items:
            return
        if reduced_motion_preferred():
            self._apply_glow_opacity(0.6)
            return
        self._tick_glow()

    def _apply_glow_opacity(self, opacity):
        # Tk lines have no alpha — lean the stroke toward the card instead.
        fill = mix(GLASS_CARD, self._glow_color, max(0.0, min(1.0, float(opacity))))
        for item_id in self._glow_items:
            try:
                self.canvas.itemconfigure(item_id, fill=fill)
            except Exception:
                pass

    def _tick_glow(self):
        if not self.visible or not self._glow_items:
            self._glow_job = None
            return
        self._glow_phase = (self._glow_phase + 50 / 3200.0) % 1.0
        wave = 0.5 - 0.5 * math.cos(self._glow_phase * 2 * math.pi)
        self._apply_glow_opacity(0.55 + 0.20 * wave)
        try:
            self._glow_job = self.root.after(50, self._tick_glow)
        except Exception:
            self._glow_job = None

    def _keep_photo(self, photo):
        if photo is None:
            return None
        self._huupe_photos.append(photo)
        retain_photo(self.canvas, photo)
        return photo

    def _can_photo(self):
        """RecordingCanvas / MagicMock have no real Tk photo support."""
        if Image is None:
            return False
        if hasattr(self.canvas, "pil_photo"):
            return True
        return ImageTk is not None and hasattr(self.canvas, "tk")

    def _photo_image(self, image):
        if image is None or not self._can_photo():
            return None
        # The preview renderer paints into Pillow, so it takes the image
        # directly — otherwise a preview silently shows the fallback art
        # instead of what the wall will actually paint.
        if hasattr(self.canvas, "pil_photo"):
            return self._keep_photo(self.canvas.pil_photo(image))
        master = self.canvas if hasattr(self.canvas, "tk") else self.root
        try:
            photo = ImageTk.PhotoImage(image, master=master)
        except Exception:
            return None
        return self._keep_photo(photo)

    # ------------------------------------------------------------ lifecycle

    def show(self, payload: dict):
        payload_type = str((payload or {}).get("type") or "")
        if payload_type == "huupe.dashboard":
            fp = dashboard_fingerprint(payload)
            if self.visible and self._mode == "dashboard" and fp == self._dashboard_fp:
                return
            self.hide()
            self.visible = True
            self._mode = "dashboard"
            self._dashboard_fp = fp
            self._session_id = None
            self._revision = -1
            self._session_fp = None
            self._payload = payload
            self._render_dashboard(payload)
            return
        if payload_type == "huupe.session":
            self._show_session(payload, force=True)
            return
        self.hide()

    def apply_session_payload(self, payload: dict) -> str:
        """In-place live update. Returns ignored | updated | replace."""
        if str((payload or {}).get("type") or "") != "huupe.session":
            return "replace"
        if not self.visible or self._mode != "session":
            return "replace"
        session = (payload or {}).get("session") or {}
        session_id = str(session.get("sessionId") or "")
        if session_id and self._session_id and session_id != self._session_id:
            return "replace"
        try:
            revision = int(session.get("revision") or 0)
        except (TypeError, ValueError):
            revision = 0
        if revision < self._revision:
            return "ignored"
        fp = session_fingerprint(session)
        if revision == self._revision and fp == self._session_fp:
            return "ignored"
        self._show_session(payload, force=False)
        return "updated"

    def _show_session(self, payload: dict, *, force: bool):
        session = (payload or {}).get("session") or {}
        try:
            revision = int(session.get("revision") or 0)
        except (TypeError, ValueError):
            revision = 0
        fp = session_fingerprint(session)
        if (
            not force
            and self.visible
            and self._mode == "session"
            and revision < self._revision
        ):
            return
        if (
            self.visible
            and self._mode == "session"
            and revision == self._revision
            and fp == self._session_fp
        ):
            return
        self.hide()
        self.visible = True
        self._mode = "session"
        self._session_id = str(session.get("sessionId") or "")
        self._revision = revision
        self._session_fp = fp
        self._dashboard_fp = None
        self._payload = payload
        self._render_session(payload)

    # -------------------------------------------------------------- plumbing

    def _screen(self):
        return int(self.shell.screen_w), int(self.shell.screen_h)

    def _font(self, size, bold=False):
        scaled = max(8, int(round(float(size) * float(getattr(self, "_scale", 1.0) or 1.0))))
        return ("Segoe UI", scaled, "bold" if bold else "normal")

    def _sync_metrics(self):
        screen_w, screen_h = self._screen()
        self._scale = design_u(screen_w, screen_h)
        self._px_per_pt = measure_px_per_point(self.root, self._scale)

    def _line_h(self, points):
        return text_line_h(points, u=self._scale, px_per_pt=self._px_per_pt)

    def _fit_size(self, text, max_width, size, *, minimum=10, bold=True):
        """Shrink a point size until the string fits the space it was given."""
        size = float(size)
        if max_width <= 0:
            return minimum
        width = text_measurer(self.root, self._font(size, bold))(str(text))
        if width <= max_width or width <= 0:
            return size
        return max(float(minimum), size * (max_width / width))

    def _fit_line(self, candidates, max_width, size, *, minimum=10, bold=True):
        """First wording that fits at full size — shrinking has a floor.

        `_font` never paints below 8pt, so a caption that is simply too long
        leaks past its card no matter what `_fit_size` returns. Dropping words
        keeps it inside.
        """
        measure = text_measurer(self.root, self._font(size, bold))
        for text in candidates:
            text = str(text)
            if max_width <= 0:
                break
            width = measure(text)
            if width <= max_width or width <= 0:
                return text, float(size)
        last = str(candidates[-1]) if candidates else ""
        return last, self._fit_size(last, max_width, size, minimum=minimum, bold=bold)

    def _paint_header(self, *, title="HUUPE", status_chip=None):
        screen_w, screen_h = self._screen()
        right_label, right_value = "", ""
        if status_chip:
            right_label, right_value = "STATUS", status_chip
        ids = paint_page_header(
            self.canvas,
            screen_w=screen_w,
            screen_h=screen_h,
            pill=title,
            left_label="",
            left_value="",
            right_label=right_label,
            right_value=right_value,
            track=self._track,
        )
        if status_chip == "LIVE":
            for item_id in ids[-2:]:
                try:
                    if self.canvas.type(item_id) == "text":
                        if self.canvas.itemcget(item_id, "text") in ("LIVE", "STATUS"):
                            self.canvas.itemconfigure(item_id, fill=ALERT)
                except Exception:
                    pass
        return ids

    def _card(self, box, *, accent=None, lift=0.0):
        """Card frame. The fill comes from the page image when there is one.

        Tk has no backdrop blur and no alpha, so real glass only happens when
        the whole page — wash, art, ghost type, card tints — is composited in
        Pillow first (`_page_image`). Without that, cards are solid.
        """
        edge = mix(GLASS_BORDER, accent, 0.35) if accent else mix(GLASS_CARD, "#7CA9DA", 0.45)
        if self._glass_painted:
            fill = ""
        else:
            fill = tint(GLASS_CARD, lift) if lift else GLASS_CARD
        return paint_round_rect(
            self.canvas, box, radius=16 * self._scale,
            fill=fill, outline=edge, width=max(1, int(round(1.5 * self._scale))),
            track=self._track,
        )

    def _page_art(self, kind, *, status, portrait):
        """Where the page's art lives: texture, glow origin and ghost word."""
        screen_w, screen_h = self._screen()
        if kind == "dashboard":
            return {
                "glow": ACCENT_CORAL,
                "glow_xy": (
                    (screen_w * 0.85, -screen_h * 0.05) if portrait
                    else (screen_w * 0.85, screen_h * 0.85)
                ),
                "ghost": ("BASKETBALL", "left" if portrait else "top"),
            }
        return {
            "glow": ACCENT_AMBER,
            "glow_xy": (-screen_w * 0.05, -screen_h * 0.05),
            "ghost": (str(status or "LIVE").upper(), "right" if portrait else "bottom"),
        }

    def _page_image(self, *, kind, status, cards):
        """The whole page as one Pillow image — the only way to get alpha."""
        if Image is None or ImageDraw is None:
            return None
        screen_w, screen_h = self._screen()
        if screen_w < 16 or screen_h < 16:
            return None
        portrait = screen_h >= screen_w
        art = self._page_art(kind, status=status, portrait=portrait)

        column = Image.new("RGB", (1, 128))
        pixels = column.load()
        for index in range(128):
            pixels[0, index] = _hex_rgb(mix(PAGE_TOP, PAGE_BOTTOM, index / 127))
        page = column.resize((screen_w, screen_h), Image.Resampling.BILINEAR)

        def overlay(paint):
            layer = Image.new("RGBA", (screen_w, screen_h), (0, 0, 0, 0))
            paint(ImageDraw.Draw(layer))
            page.paste(layer, (0, 0), layer)

        if kind == "dashboard":
            photo = court_photo_path()
            if photo is not None:
                try:
                    raw = Image.open(photo).convert("L").convert("RGB")
                    raw = raw.resize((screen_w, screen_h), Image.Resampling.LANCZOS)
                    dark = Image.blend(raw, Image.new("RGB", raw.size, (0, 0, 0)), 0.55)
                    page = Image.blend(page, dark, 0.35)
                except Exception:
                    pass
            overlay(lambda draw: self._art_court_strip(draw, portrait=portrait))
        else:
            overlay(lambda draw: self._art_echo_arcs(draw, portrait=portrait))
        overlay(lambda draw: self._art_warm_glow(draw, art["glow_xy"], art["glow"]))

        # Scrim as a smooth ramp: the spec's three blocks left visible seams.
        ramp = Image.new("L", (1, 128))
        ramp_px = ramp.load()
        for index in range(128):
            t = index / 127
            if t < 0.5:
                alpha = 0.42 + (0.18 - 0.42) * (t / 0.5)
            else:
                alpha = 0.18 + (0.50 - 0.18) * ((t - 0.5) / 0.5)
            ramp_px[0, index] = int(round(alpha * 255))
        page.paste(
            Image.new("RGB", (screen_w, screen_h), SCRIM_BASE),
            (0, 0),
            ramp.resize((screen_w, screen_h), Image.Resampling.BILINEAR),
        )

        # Ghost type goes over the scrim — under it, 10% ink disappeared.
        overlay(lambda draw: self._art_ghost_word(draw, *art["ghost"]))

        radius = max(1, int(round(16 * self._scale)))
        for box, lift in cards:
            bx0, by0, bx1, by1 = (int(round(value)) for value in box)
            width, height = bx1 - bx0, by1 - by0
            if width < 8 or height < 8:
                continue
            mask = Image.new("L", (width, height), 0)
            ImageDraw.Draw(mask).rounded_rectangle(
                (0, 0, width - 1, height - 1), radius=radius,
                fill=int(round(GLASS_ALPHA * 255)),
            )
            tile = Image.new(
                "RGB", (width, height), tint(GLASS_CARD, lift) if lift else GLASS_CARD,
            )
            page.paste(tile, (bx0, by0), mask)
        return page

    def _paint_huupe_backdrop(self, *, kind, status=None, cards=()):
        """Editorial page wash — decoration only; cards always win (§10)."""
        screen_w, screen_h = self._screen()
        portrait = screen_h >= screen_w
        page = self._photo_image(
            self._page_image(kind=kind, status=status, cards=cards)
        )
        if page is not None:
            self._track(self.canvas.create_image(0, 0, image=page, anchor="nw"))
            self._glass_painted = True
            self._paint_corner_ticks()
            return
        self._glass_painted = False
        paint_gradient(
            self.canvas, (0, 0, screen_w, screen_h), PAGE_TOP, PAGE_BOTTOM,
            bands=28, track=self._track,
        )

        if kind == "dashboard":
            self._paint_court_strip(portrait=portrait)
            glow = ACCENT_CORAL
            if portrait:
                gx, gy = screen_w * 0.85, -screen_h * 0.05
            else:
                gx, gy = screen_w * 0.85, screen_h * 0.85
        else:
            self._paint_echo_arcs(portrait=portrait)
            glow = ACCENT_AMBER
            gx, gy = -screen_w * 0.05, -screen_h * 0.05

        diameter = max(screen_w, screen_h) * 0.75
        self._paint_warm_glow(gx, gy, diameter, glow)
        for index, (y0, y1, alpha) in enumerate((
            (0, screen_h * 0.35, 0.42),
            (screen_h * 0.35, screen_h * 0.65, 0.18),
            (screen_h * 0.65, screen_h, 0.50),
        )):
            # Approximate opacity by mixing toward the base gradient band.
            self._track(self.canvas.create_rectangle(
                0, y0, screen_w, y1, fill=mix(PAGE_TOP if index == 0 else PAGE_BOTTOM, SCRIM_BASE, alpha),
                outline="",
            ))
        self._paint_corner_ticks()

    def _paint_corner_ticks(self):
        """Crop marks. Inset stays outside the 40u content margin — on it they
        cut into the header's STATUS column."""
        screen_w, screen_h = self._screen()
        arm = 22 * self._scale
        thick = max(2, int(round(4 * self._scale)))
        inset = 16 * self._scale
        tick = mix(GHOST_INK, PAGE_BOTTOM, 0.30)
        corners = (
            (inset, inset, 1, 1),
            (screen_w - inset, inset, -1, 1),
            (inset, screen_h - inset, 1, -1),
            (screen_w - inset, screen_h - inset, -1, -1),
        )
        for cx, cy, sx, sy in corners:
            self._track(self.canvas.create_line(
                cx, cy, cx + arm * sx, cy, fill=tick, width=thick,
            ))
            self._track(self.canvas.create_line(
                cx, cy, cx, cy + arm * sy, fill=tick, width=thick,
            ))

    @staticmethod
    def _ghost_face(size):
        from PIL import ImageFont
        for name in ("segoeuib.ttf", "arialbd.ttf"):
            try:
                return ImageFont.truetype(name, max(24, int(size)))
            except Exception:
                continue
        return ImageFont.load_default()

    def _art_ghost_word(self, draw, word, edge):
        """Huge editorial type set into the page (§10.2).

        Drawn into the page image rather than as `create_text`, so the smoke
        tests that assert every painted string sits inside a card never see
        decoration — and so it sits *under* the glass cards.
        """
        word = str(word or "").upper()
        if not word:
            return
        screen_w, screen_h = self._screen()
        ink = (*_hex_rgb(GHOST_INK), int(round(GHOST_ALPHA * 255)))
        try:
            if edge in ("left", "right"):
                # One letter per line down the page, spread to fill it instead
                # of running off the bottom after six of them.
                letters = list(word[:11])
                span = screen_h * 0.80
                step = span / max(1, len(letters) - 1)
                font = self._ghost_face(min(step * 0.86, screen_w * 0.26))
                x = screen_w * (0.20 if edge == "left" else 0.80)
                y0 = (screen_h - span) / 2
                for index, letter in enumerate(letters):
                    draw.text((x, y0 + step * index), letter, fill=ink, font=font, anchor="mm")
            else:
                font = self._ghost_face(screen_w * (0.11 if edge == "top" else 0.14))
                y = screen_h * (0.14 if edge == "top" else 0.86)
                draw.text((screen_w / 2, y), word, fill=ink, font=font, anchor="mm")
        except Exception:
            pass

    def _art_court_strip(self, draw, *, portrait):
        screen_w, screen_h = self._screen()
        height = screen_h * 0.28
        top = screen_h * (0.72 if portrait else 0.36)
        # Feathered rather than a flat block: a hard edge read as a seam
        # running across the page.
        red, green, blue = _hex_rgb("#5A6470")
        rows = max(2, int(round(height)))
        for index in range(rows):
            t = index / (rows - 1)
            edge = min(1.0, min(t, 1 - t) * 5)
            draw.line(
                (0, top + index, screen_w, top + index),
                fill=(red, green, blue, int(round(66 * edge))),
            )
        stroke = (*_hex_rgb("#DDE6EE"), 64)
        cx, cy = screen_w * 0.55, top + height * 1.8
        for radius in (screen_w * 0.34, screen_w * 0.21):
            draw.ellipse(
                (cx - radius, cy - radius, cx + radius, cy + radius),
                outline=stroke, width=max(2, int(round(3 * self._scale))),
            )
        draw.line((screen_w * 0.82, top, screen_w * 0.74, top + height), fill=stroke, width=2)
        draw.line((screen_w * 0.16, top, screen_w * 0.10, top + height), fill=stroke, width=2)

    def _art_echo_arcs(self, draw, *, portrait):
        screen_w, screen_h = self._screen()
        cx = screen_w * (-0.05 if portrait else 1.05)
        cy = screen_h * 1.08
        unit = max(screen_w, screen_h) / 1600.0
        thin = (*_hex_rgb(COURT_LINE), 26)
        wide = (*_hex_rgb(COURT_LINE), 11)
        for radius in (280, 470, 660, 850, 1040, 1230):
            r = radius * unit
            draw.ellipse(
                (cx - r, cy - r, cx + r, cy + r),
                outline=thin, width=max(1, int(round(2.5 * self._scale))),
            )
        for radius in (375, 945):
            r = radius * unit
            draw.ellipse(
                (cx - r, cy - r, cx + r, cy + r),
                outline=wide, width=max(8, int(round(20 * self._scale))),
            )

    def _art_warm_glow(self, draw, centre, colour):
        screen_w, screen_h = self._screen()
        diameter = max(screen_w, screen_h) * 0.75
        peak = 0.13 if colour == ACCENT_CORAL else 0.11
        red, green, blue = _hex_rgb(colour)
        cx, cy = centre
        steps = 44
        for index in range(steps, 0, -1):
            t = index / steps
            r = (diameter / 2) * t
            draw.ellipse(
                (cx - r, cy - r, cx + r, cy + r),
                fill=(red, green, blue, int(round(peak * (1 - t) * 255))),
            )

    def _paint_court_strip(self, *, portrait):
        screen_w, screen_h = self._screen()
        h = screen_h * 0.28
        top = screen_h * 0.74 if portrait else screen_h * 0.38
        self._track(self.canvas.create_rectangle(
            0, top, screen_w, top + h, fill=mix(PAGE_BOTTOM, "#464D55", 0.30), outline="",
        ))
        stroke = mix(PAGE_BOTTOM, "#DDE6EE", 0.30)
        cx = screen_w * 0.55
        cy = top + h * 1.8
        for radius in (screen_w * 0.34, screen_w * 0.21):
            self._track(self.canvas.create_oval(
                cx - radius, cy - radius, cx + radius, cy + radius,
                fill="", outline=stroke, width=max(2, int(round(3 * self._scale))),
            ))
        self._track(self.canvas.create_line(
            screen_w * 0.82, top, screen_w * 0.74, top + h, fill=stroke, width=2,
        ))
        self._track(self.canvas.create_line(
            screen_w * 0.16, top, screen_w * 0.10, top + h, fill=stroke, width=2,
        ))

    def _paint_echo_arcs(self, *, portrait):
        screen_w, screen_h = self._screen()
        # Landscape: bottom-right; portrait flips to bottom-left via mirrored cx.
        cx = screen_w * 1.05 if not portrait else -screen_w * 0.05
        cy = screen_h * 1.08
        thin = mix(PAGE_BOTTOM, COURT_LINE, 0.10)
        wide = mix(PAGE_BOTTOM, COURT_LINE, 0.04)
        for radius in (280, 470, 660, 850, 1040, 1230):
            r = radius * (max(screen_w, screen_h) / 1600.0)
            self._track(self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                fill="", outline=thin, width=max(1, int(round(2.5 * self._scale))),
            ))
        for radius in (375, 945):
            r = radius * (max(screen_w, screen_h) / 1600.0)
            self._track(self.canvas.create_oval(
                cx - r, cy - r, cx + r, cy + r,
                fill="", outline=wide, width=max(8, int(round(20 * self._scale))),
            ))

    def _paint_warm_glow(self, cx, cy, diameter, color):
        if not self._can_photo():
            # Stacked discs stand in for the blur on canvases with no photo
            # support — a single oval would draw a hard-edged spotlight.
            peak = 0.13 if color == ACCENT_CORAL else 0.11
            for index in range(10, 0, -1):
                t = index / 10
                r = max(8.0, (diameter / 2) * t)
                self._track(self.canvas.create_oval(
                    cx - r, cy - r, cx + r, cy + r,
                    fill=mix(PAGE_BOTTOM, color, peak * (1 - t)), outline="",
                ))
            return
        size = max(2, int(round(diameter)))
        img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        cr, cg, cb = _hex_rgb(color)
        steps = 32
        for index in range(steps, 0, -1):
            t = index / steps
            alpha = int(round((0.13 if color == ACCENT_CORAL else 0.11) * (1 - t) * 255))
            r = (size / 2) * t
            mid = size / 2
            draw.ellipse((mid - r, mid - r, mid + r, mid + r), fill=(cr, cg, cb, alpha))
        photo = self._photo_image(img)
        if photo is not None:
            self._track(self.canvas.create_image(cx, cy, image=photo, anchor="center"))

    def _title(self, x, y, text, *, size=14, fill=INK_2, accent=ACCENT_CORAL):
        return paint_section_title(
            self.canvas, x, y, text=text, font=self._font(size, True),
            u=self._scale, fill=fill, accent=accent,
            line_h=self._line_h(size), track=self._track,
        )

    def _text(self, x, y, text, *, size=18, bold=False, fill=INK, anchor="nw"):
        return self._track(self.canvas.create_text(
            x, y, text=str(text), fill=fill, font=self._font(size, bold), anchor=anchor,
        ))

    def _pad(self):
        return 22 * self._scale

    def _head_top(self, box):
        """Y of the first row under a card's section title."""
        return box[1] + self._pad() * 0.7 + self._line_h(14) + 14 * self._scale

    def _even_gap(self, available, row_h, count, *, minimum=12, maximum=42):
        """Row gap, in design points, that spreads rows down the whole card.

        `stack_rows` only ever compresses a gap, so a short list left a hole at
        the bottom of a flexible card — and the rail drawn after the last row
        floated in the middle of it.
        """
        if count <= 0:
            return minimum
        slack = max(0.0, float(available) - float(row_h) * count)
        return max(minimum, min(maximum, (slack / count) / max(0.05, self._scale)))

    def _dial(self, cx, cy, radius, fraction, colour):
        """Broadcast gauge: a 270° track with the value swept over it."""
        width = max(3.0, 9 * self._scale)
        self._track(self.canvas.create_line(
            *arc_points(cx, cy, radius, -135, 135),
            fill=TRACK, width=width, capstyle="round", joinstyle="round",
        ))
        share = max(0.0, min(1.0, float(fraction or 0.0)))
        if share * 270 >= 3:
            self._track(self.canvas.create_line(
                *arc_points(cx, cy, radius, -135, -135 + 270 * share),
                fill=colour, width=width, capstyle="round", joinstyle="round",
            ))

    @staticmethod
    def _centre_offset(stack, available):
        """Nudge a short stack down so it sits in the middle of its card."""
        return max(0.0, (float(available) - stack["height"]) / 2)

    def _dial_block(self, cx, top, bottom, max_radius, pct, caption):
        """Gauge with the value inside it and a caption clear of the arc."""
        caption_h = self._line_h(12) + 6 * self._scale
        radius = max(14.0, min(float(max_radius), ((bottom - top) - caption_h) / 2))
        cy = top + max(0.0, ((bottom - top) - (radius * 2 + caption_h)) / 2) + radius
        colour = GOOD if pct >= 50 else (ACCENT if pct >= 25 else WARN)
        self._dial(cx, cy, radius, pct / 100.0, colour)
        base = (radius * 0.85) / max(0.05, self._scale * self._px_per_pt)
        size = self._fit_size(f"{pct}%", radius * 1.5, base, minimum=10)
        self._text(cx, cy, f"{pct}%", size=size, bold=True, anchor="center")
        self._text(
            cx, cy + radius + 5 * self._scale, letterspace(caption),
            size=12, fill=INK_3, anchor="n",
        )
        return radius

    def _dot(self, cx, cy, radius, *, fill, outline="", width=1):
        return self._track(self.canvas.create_oval(
            cx - radius, cy - radius, cx + radius, cy + radius,
            fill=fill, outline=outline, width=max(1, int(round(width))),
        ))

    # --------------------------------------------------------------- session

    def _render_session(self, payload: dict):
        self._sync_metrics()
        session = (payload or {}).get("session") or {}
        finished = str(session.get("status") or "live").lower() == "finished"
        timed = finished or payload.get("persistent") is False
        players = [p for p in (session.get("players") or []) if p.get("name")]

        screen_w, screen_h = self._screen()
        status = "FINAL" if finished else "LIVE"
        boxes = layout_huupe_session(
            screen_w, screen_h, timed=timed, finished=finished, players=len(players),
        )
        cards = [
            (box, 0.05 if name == "hero" else 0.0)
            for name, box in boxes.items()
            if isinstance(box, tuple) and len(box) == 4 and name != "mode"
        ]
        # The page image carries the card fills, so it needs the boxes first.
        self._paint_huupe_backdrop(kind="live", status=status, cards=cards)
        self._paint_header(status_chip=status)
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4 or name == "mode":
                continue
            self._card(box, accent=ACCENT_CORAL if name == "hero" else None,
                       lift=0.05 if name == "hero" else 0.0)

        stats = session.get("stats") or {}
        self._draw_mode(boxes["mode"], session)
        self._draw_hero(boxes["hero"], session, finished=finished)
        if "body" in boxes:
            self._draw_scoreboard(boxes["body"], players, finished=finished)
        self._draw_tiles(boxes["tiles"], stats, titled=bool(players))
        rows = zone_rows(session.get("zones"))
        self._draw_court(
            boxes["court"], rows,
            title="SHOT CHART", subtitle="SHARE OF SESSION POINTS",
        )
        self._draw_zone_legend(boxes["zones"], rows, title="SHOOTING BY ZONE")
        self._draw_ticker(boxes["ticker"], session, finished=finished)

    def _draw_mode(self, box, session):
        x0, y0, x1, y1 = box
        label = str(session.get("modeLabel") or "SESSION").upper()
        duration = str(session.get("durationLabel") or "")
        text = f"{label}   ·   {duration}" if duration else label
        font = self._font(17, True)
        spaced = letterspace(text)
        width = text_measurer(self.root, font)(spaced) + 44 * self._scale
        mid_x = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        height = min(y1 - y0, self._line_h(17) + 14 * self._scale)
        paint_bar(
            self.canvas,
            (mid_x - width / 2, cy - height / 2, mid_x + width / 2, cy + height / 2),
            fill=mix(CARD_LO, ACCENT, 0.10), outline=EDGE_SOFT, track=self._track,
        )
        self._track(self.canvas.create_text(
            mid_x, cy, text=spaced, fill=INK_2, font=font,
        ))

    def _draw_hero(self, box, session, *, finished):
        """Lower-third: the one number to read from the sofa, plus a FG dial."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        headline = session.get("headline") or {}
        primary = clip(headline.get("primary") or "—", 20)
        secondary = str(headline.get("secondary") or "")
        stats = session.get("stats") or {}

        radius = max(18.0, min((x1 - x0) * 0.15, (y1 - y0) * 0.34))
        dial_cx = x1 - pad - radius
        left = x0 + pad * 1.2
        budget = max(60.0, (dial_cx - radius - pad) - left)

        available = (y1 - y0) - pad * 2
        hero_pt = 100 if len(primary) <= 6 else (68 if len(primary) <= 12 else 46)
        hero_pt = self._fit_size(primary, budget, hero_pt, minimum=24)
        stack = stack_rows(
            [("hero", hero_pt, 10), ("sub", 20, 0)],
            top=y0 + pad,
            available=available,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        shift = self._centre_offset(stack, available)
        self._text(
            left, stack["y"]["hero"] + shift, primary,
            size=hero_pt * scale, bold=True, fill=WARN if finished else INK,
        )
        if secondary:
            sub_pt = self._fit_size(secondary.upper(), budget, 20, minimum=11)
            self._text(
                left, stack["y"]["sub"] + shift, letterspace(secondary.upper()),
                size=sub_pt * scale, fill=INK_2,
            )

        self._dial_block(
            dial_cx, y0 + pad, y1 - pad, radius,
            int(stats.get("fgPct") or 0), "FIELD GOAL",
        )

    def _draw_scoreboard(self, box, players, *, finished):
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, "SCOREBOARD")

        top = self._head_top(box)
        available = (y1 - top) - pad
        shown = players[:6]
        if not shown:
            return
        gap = self._even_gap(
            available, self._line_h(24), len(shown), minimum=18, maximum=44,
        )
        rows = [(f"p{index}", 24, gap) for index in range(len(shown))]
        rows[-1] = (rows[-1][0], rows[-1][1], 0)
        stack = stack_rows(
            rows, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 24 * stack["font_scale"]
        lead = max([abs(float(p.get("score") or 0)) for p in shown] or [0]) or 1.0

        for index, player in enumerate(shown):
            key = f"p{index}"
            y = stack["y"][key]
            height = stack["h"][key]
            winner = bool(player.get("isWinner")) and finished
            if winner:
                paint_bar(
                    self.canvas,
                    (x0 + pad * 0.5, y - 4 * self._scale, x1 - pad * 0.5,
                     y + height + 4 * self._scale),
                    fill=plate_for(WARN), outline="", track=self._track,
                )
            colour = MEDALS[index] if index < len(MEDALS) and finished else INK
            rank = str(player.get("rank") or index + 1)
            line = f"{rank}  {clip(player.get('name'), 14)}"
            made, attempts = player.get("made"), player.get("attempts")
            if attempts:
                line = f"{line}   ·   {int(made or 0)}/{int(attempts)}"
            self._text(left, y, line, size=size, bold=True, fill=colour)
            self._text(
                right, y, format_score(player.get("score")),
                size=size, bold=True, fill=WARN if winner else INK, anchor="ne",
            )
            # Score share, so a runaway game looks like one from across the room.
            next_y = stack["y"].get(f"p{index + 1}")
            room = (next_y - (y + height)) if next_y else ((y1 - pad) - (y + height))
            if room >= 12 * self._scale:
                # Kept close to its own row: a generously spaced card must not
                # leave the rail floating halfway to the next name.
                rail_y = y + height + min(room, 30 * self._scale) / 2
                thickness = max(3.0, 6 * self._scale)
                paint_meter(
                    self.canvas,
                    (left, rail_y - thickness / 2, right, rail_y + thickness / 2),
                    abs(float(player.get("score") or 0)) / lead,
                    WARN if winner else (MEDALS[index] if index < len(MEDALS) else ACCENT),
                    track=self._track, track_color=TRACK,
                )

    def _draw_tiles(self, box, stats, *, titled=False):
        """Four numbers that describe the session however it is being played."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        tiles = [
            ("POINTS", format_score(stats.get("points"))),
            ("MADE", str(stats.get("shotLine") or "0/0")),
            ("ACCURACY", f"{int(stats.get('fgPct') or 0)}%"),
            ("BEST RUN", str(int(stats.get("bestStreak") or 0))),
        ]
        self._title(x0 + pad, y0 + pad * 0.7, "GAME TOTALS" if titled else "THIS SESSION")

        top = self._head_top(box)
        available = (y1 - top) - pad
        cell_w = (x1 - x0 - pad * 2) / len(tiles)
        stack = stack_rows(
            [("value", 40, 8), ("label", 14, 0)],
            top=top,
            available=available,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        shift = self._centre_offset(stack, available)
        for index, (label, value) in enumerate(tiles):
            cx = x0 + pad + cell_w * (index + 0.5)
            if index:
                self._track(self.canvas.create_line(
                    x0 + pad + cell_w * index, top, x0 + pad + cell_w * index, y1 - pad,
                    fill=EDGE_SOFT, width=1,
                ))
            size = self._fit_size(value, cell_w * 0.86, 40 * scale, minimum=14)
            self._text(cx, stack["y"]["value"] + shift, value, size=size, bold=True, anchor="n")
            self._text(
                cx, stack["y"]["label"] + shift, letterspace(label),
                size=14 * scale, fill=INK_3, anchor="n",
            )

    def _draw_court(self, box, rows, *, title="SHOT CHART", subtitle="SHARE OF SESSION POINTS"):
        """Blueprint half-court coloured by share of points (§4–9)."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        self._title(x0 + pad, y0 + pad * 0.7, title, accent=ACCENT_CORAL)
        sub_size = self._fit_size(letterspace(subtitle), (x1 - x0) - pad * 2, 9, minimum=7, bold=False)
        self._text(
            x0 + pad + 14 * self._scale,
            y0 + pad * 0.7 + self._line_h(14) + 2 * self._scale,
            letterspace(subtitle), size=sub_size, fill=LABEL_DIM, anchor="nw",
        )

        foot_h = self._line_h(14) + self._line_h(9) + 22 * self._scale
        court_box = (
            x0 + pad * 0.35, self._head_top(box) + self._line_h(9) + 6 * self._scale,
            x1 - pad * 0.35, y1 - pad * 0.55 - foot_h,
        )
        bands, hot, total = band_heat(rows)
        geo = court_regions(court_box)
        left, top, right, bottom = geo["court"]
        scale = geo["scale"]
        hair = max(1, int(round(1.5 * scale)))
        gap_w = max(2, int(round(5 * scale)))
        rim_x, rim_y, rim_r = geo["rim"]

        # Deep band: hot at the arc, fading back to navy by the half-court line.
        # A PhotoImage is smooth; the stacked-rectangle ramp is the fallback for
        # canvases that cannot hold one.
        deep_color = bands["three"]["color"]
        paint_round_rect(
            self.canvas, geo["court"], radius=geo["court_radius"],
            fill=COURT_BASE, outline="", track=self._track,
        )
        court_w, court_h = right - left, bottom - top
        fade = self._photo_image(deep_fade_image(
            court_w, court_h, rim_xy=(rim_x - left, rim_y - top),
            radius=geo["deep_radius"], color=deep_color, base=COURT_BASE,
            corner=geo["court_radius"],
        ))
        if fade is not None:
            self._track(self.canvas.create_image(left, top, image=fade, anchor="nw"))
        else:
            for bx0, by0, bx1, by1, colour in deep_fade_bands(
                geo["court"], rim_y=rim_y, radius=geo["deep_radius"],
                color=deep_color, base=COURT_BASE, corner=geo["court_radius"],
            ):
                self._track(self.canvas.create_rectangle(
                    bx0, by0, bx1, by1, fill=colour, outline="",
                ))

        # Mid / short / layup, far → near. The rings are clipped to the court,
        # which the short band overruns at the baseline.
        inner = (left + hair, top + hair, right - hair, bottom - hair)
        short_ring = clipped_circle(rim_x, rim_y, geo["short_r"], inner)
        layup_ring = clipped_circle(rim_x, rim_y, geo["layup_r"], inner)
        self._track(self.canvas.create_polygon(
            *geo["mid_poly"], fill=bands["two"]["color"], outline="", smooth=False,
        ))
        self._track(self.canvas.create_polygon(
            *short_ring, fill=bands["one"]["color"], outline="", smooth=False,
        ))
        self._track(self.canvas.create_polygon(
            *layup_ring, fill=bands["layup"]["color"], outline="", smooth=False,
        ))

        seams = {
            "three": (geo["three_path"], geo["three_sides"], 16 * scale),
            "two": (geo["three_path"], geo["three_sides"], 16 * scale),
            "one": (short_ring + short_ring[:2], (), 14 * scale),
            "layup": (layup_ring + layup_ring[:2], (), 14 * scale),
        }

        def stroke_seam(zone, colour, width):
            path, sides, _ = seams[zone]
            self._track(self.canvas.create_line(
                *path, fill=colour, width=width, smooth=False,
            ))
            for side in sides:
                self._track(self.canvas.create_line(*side, fill=colour, width=width))

        # Hot-zone halo, painted under the seam so it lights both sides of it.
        hot_id = hot["zone"] if hot else None
        if hot_id:
            hot_color = bands[hot_id]["color"]
            path, sides, hot_stroke = seams[hot_id]
            halo = self._photo_image(glow_stroke_image(
                court_w, court_h,
                [
                    value - (left if index % 2 == 0 else top)
                    for index, value in enumerate(path)
                ],
                hot_color, hot_stroke * 0.55, blur=max(3.0, 7 * scale),
            ))
            if halo is not None:
                self._track(self.canvas.create_image(left, top, image=halo, anchor="nw"))
                for side in sides:
                    edge = self._photo_image(glow_stroke_image(
                        court_w, court_h,
                        [
                            value - (left if index % 2 == 0 else top)
                            for index, value in enumerate(side)
                        ],
                        hot_color, hot_stroke * 0.55, blur=max(3.0, 7 * scale),
                    ))
                    if edge is not None:
                        self._track(self.canvas.create_image(
                            left, top, image=edge, anchor="nw",
                        ))
            else:
                for width, tone in glow_ring_layers(hot_color, hot_stroke):
                    stroke_seam(hot_id, tone, width)

        # Dark gaps between bands.
        for zone in ("three", "one", "layup"):
            stroke_seam(zone, PANEL_GAP, gap_w)

        # Breathing core, drawn on top of the seam so the boundary pulses.
        if hot_id:
            core = max(2, int(round(seams[hot_id][2] * 0.30)))
            before = len(self._item_ids)
            stroke_seam(hot_id, hot_color, core)
            self._start_glow(list(self._item_ids[before:]), hot_color)
        else:
            self._stop_glow()

        # Court markings.
        line = COURT_LINE
        self._track(self.canvas.create_line(
            *geo["three_path"], fill=mix(PAGE_BOTTOM, line, 0.50), width=max(1, int(round(2 * scale))),
            smooth=False,
        ))
        for side in geo["three_sides"]:
            self._track(self.canvas.create_line(
                *side, fill=mix(PAGE_BOTTOM, line, 0.50), width=max(1, int(round(2 * scale))),
            ))
        for zone in ("one", "layup"):
            stroke_seam(zone, mix(PAGE_BOTTOM, line, 0.16), hair)
        self._track(self.canvas.create_rectangle(
            *geo["key"], fill="", outline=mix(PAGE_BOTTOM, line, 0.30), width=hair,
        ))
        if geo["ft_arc"]:
            self._track(self.canvas.create_line(
                *geo["ft_arc"], fill=mix(PAGE_BOTTOM, line, 0.30), width=hair, smooth=False,
            ))
        if geo["restricted_arc"]:
            self._track(self.canvas.create_line(
                *geo["restricted_arc"], fill=mix(PAGE_BOTTOM, line, 0.30), width=hair, smooth=False,
            ))
        if geo["centre"]:
            self._track(self.canvas.create_line(
                *geo["centre"], fill=mix(PAGE_BOTTOM, line, 0.30), width=hair, smooth=False,
            ))
        self._track(self.canvas.create_line(
            *geo["backboard"], fill=mix(PAGE_BOTTOM, line, 0.55),
            width=max(2, int(round(3.5 * scale))),
        ))
        self._dot(rim_x, rim_y, rim_r, fill="", outline=RIM_COLOR,
                  width=max(2, int(round(2.5 * scale))))
        paint_round_rect(
            self.canvas, geo["court"], radius=geo["court_radius"],
            fill="", outline=mix(PAGE_BOTTOM, line, 0.42),
            width=max(1, int(round(2 * scale))), track=self._track,
        )

        # Each name sits on the template's anchor for its band, with the share
        # hung underneath. Head- and foot-room come from the neighbouring
        # anchors, so a short card shrinks type instead of colliding.
        card_w = max(1.0, right - left)
        court_top = top + 8 * scale
        # The backboard, not the baseline, is the floor for the layup label.
        court_bottom = min(bottom - 14 * scale, geo["backboard"][1] - 8 * scale)
        slots = ("three", "two", "one", "layup")
        centres = [
            min(max(geo["labels"][zone][1], court_top), court_bottom) for zone in slots
        ]
        for index, zone in enumerate(slots):
            band = bands[zone]
            lx = (left + right) / 2
            centre = centres[index]
            # Neighbouring anchors split the court into disjoint slots, so
            # fitting inside one is enough to never touch the band above.
            slot_top = (centres[index - 1] + centre) / 2 if index else court_top
            slot_bottom = (
                (centre + centres[index + 1]) / 2
                if index + 1 < len(slots) else court_bottom
            )
            head_room = centre - slot_top
            foot_room = slot_bottom - centre
            name = band["label"].upper()
            if total > 0:
                value = f"{band['share_pct']}%"
            else:
                value = "—"
            if band["empty"]:
                name_fill = value_fill = LABEL_EMPTY
            elif band["bright"]:
                name_fill, value_fill = LABEL_DARK_NAME, LABEL_DARK_VALUE
            else:
                name_fill, value_fill = LABEL_SOFT, INK
            name_pt = self._fit_size(
                name, card_w * 0.55,
                geo["label_name_size"][zone] * (scale / max(0.05, self._scale)),
                minimum=6, bold=False,
            )
            value_pt = self._fit_size(
                value, card_w * 0.36,
                geo["label_value_size"][zone] * (scale / max(0.05, self._scale)),
                minimum=7,
            )
            gap = max(3.0, 3 * self._scale)

            def line_heights(name_size, value_size):
                # _font floors at 8pt — measure what actually gets painted.
                return (
                    text_line_h(max(8, int(round(name_size * self._scale))),
                                u=1.0, px_per_pt=self._px_per_pt),
                    text_line_h(max(8, int(round(value_size * self._scale))),
                                u=1.0, px_per_pt=self._px_per_pt),
                )

            for _ in range(10):
                name_h, value_h = line_heights(name_pt, value_pt)
                if (
                    name_h / 2 <= head_room
                    and name_h / 2 + gap + value_h <= foot_room
                ):
                    break
                name_pt = max(6.0, name_pt * 0.85)
                value_pt = max(7.0, value_pt * 0.85)
            name_h, value_h = line_heights(name_pt, value_pt)
            # Still too tight at the 8pt floor: the share alone carries the band.
            if name_h / 2 > head_room or name_h / 2 + gap + value_h > foot_room:
                if value_h > head_room + foot_room:
                    continue
                self._text(
                    lx,
                    min(max(centre, slot_top + value_h / 2), slot_bottom - value_h / 2),
                    value, size=value_pt, bold=True, fill=value_fill, anchor="center",
                )
                continue
            self._text(lx, centre, name, size=name_pt, fill=name_fill, anchor="center")
            self._text(
                lx, centre + name_h / 2 + gap + value_h / 2, value,
                size=value_pt, bold=True, fill=value_fill, anchor="center",
            )

        # Hot-zone strip + ramp legend. Both shed words before they shed size,
        # because 8pt is the floor and a long caption would run off the card.
        room = (x1 - x0) - pad * 1.4
        if hot and total > 0:
            share = bands[hot["zone"]]["share_pct"]
            name = hot["label"].upper()
            chip_options = (
                letterspace(f"HOT ZONE  ·  {name}  ·  {share}% OF POINTS"),
                letterspace(f"HOT ZONE  ·  {name}  ·  {share}%"),
                letterspace(f"{name}  ·  {share}%"),
                f"{name} · {share}%",
            )
            chip_fill = ACCENT_CORAL
        else:
            chip_options = (
                letterspace("NO SHOTS YET — THE COURT LIGHTS UP AS YOU PLAY"),
                letterspace("NO SHOTS YET"),
                "NO SHOTS YET",
            )
            chip_fill = LABEL_DIM
        chip, chip_size = self._fit_line(chip_options, room, 12, minimum=8)
        foot_y = y1 - pad * 0.35 - foot_h
        self._text(
            (x0 + x1) / 2, foot_y, chip,
            size=chip_size, bold=True, fill=chip_fill, anchor="n",
        )
        legend_y = foot_y + self._line_h(chip_size) + 8 * self._scale
        bar_w = min(140 * self._scale, (x1 - x0) * 0.35)
        bar_h = max(3.0, 5 * self._scale)
        bar_x0 = (x0 + x1) / 2 - bar_w / 2
        # Ramp bar as small gradient bands.
        for index in range(24):
            t = index / 23
            colour = heat_color(t)
            seg = bar_w / 24
            self._track(self.canvas.create_rectangle(
                bar_x0 + seg * index, legend_y,
                bar_x0 + seg * (index + 1), legend_y + bar_h,
                fill=colour, outline="",
            ))
        ramp, ramp_size = self._fit_line(
            (
                letterspace("FEWER POINTS") + "   ·   " + letterspace("MOST POINTS"),
                "FEWER POINTS  ·  MOST POINTS",
                "FEWER · MOST",
            ),
            room, 8, minimum=8, bold=False,
        )
        self._text(
            (x0 + x1) / 2, legend_y + bar_h + 4 * self._scale,
            ramp, size=ramp_size, fill=LABEL_DIM, anchor="n",
        )

    def _draw_zone_legend(
        self, box, rows, *, title="SHOOTING BY ZONE", subtitle="% MADE  ·  POINTS SCORED",
    ):
        """Names the zone, says what it is worth, and shows how it is shooting.

        The big number here is **accuracy**, not the court's share of points —
        titled "where the points come from" it read as the same statistic, and
        100% off two attempts looked like it contradicted a 10% slice.
        """
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, title, accent=ACCENT_CORAL)
        sub_size = self._fit_size(
            letterspace(subtitle), (x1 - x0) - pad * 2, 9, minimum=7, bold=False,
        )
        self._text(
            left + 14 * self._scale,
            y0 + pad * 0.7 + self._line_h(14) + 2 * self._scale,
            letterspace(subtitle), size=sub_size, fill=LABEL_DIM, anchor="nw",
        )

        top = self._head_top(box) + self._line_h(9) + 4 * self._scale
        available = (y1 - top) - pad
        pair_h = self._line_h(18) + 4 * self._scale + self._line_h(12)
        gap = self._even_gap(available, pair_h, len(rows), minimum=16, maximum=100)
        spec = []
        for index in range(len(rows)):
            spec.append((f"n{index}", 18, 4))
            spec.append((f"s{index}", 12, gap))
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        chip = max(4.0, 7 * self._scale)

        for index, row in enumerate(rows):
            colour = ZONE_COLORS.get(row["zone"], ACCENT)
            # Legend answers accuracy — complementary to the court's points share.
            heat = heat_color((row["pct"] or 0) / 100.0) if row["attempts"] else mix(CARD_LO, INK_3, 0.4)
            name_y = stack["y"][f"n{index}"]
            name_h = stack["h"][f"n{index}"]
            sub_y = stack["y"][f"s{index}"]
            sub_h = stack["h"][f"s{index}"]
            live = bool(row["attempts"])

            self._dot(
                left + chip, name_y + name_h / 2, chip,
                fill=heat if live else "", outline=LABEL_EMPTY if not live else mix(heat, INK, 0.35),
                width=max(1, int(round(1.6 * self._scale))),
            )
            self._text(
                left + chip * 3, name_y, letterspace(row["label"].upper()),
                size=18 * scale, bold=True, fill=colour if live else LABEL_EMPTY,
            )
            self._text(
                right, name_y, f"{row['pct']}%",
                size=18 * scale, bold=True, fill=INK if live else LABEL_EMPTY, anchor="ne",
            )
            self._text(
                left + chip * 3, sub_y, f"{row['note']}  ·  {row['pointsLabel']}",
                size=12 * scale, fill=INK_3,
            )
            # Points scored is the bridge between this card and the chart's
            # share: 2 makes from short range is 2 of the session's points.
            self._text(
                right, sub_y,
                f"{row['made']}/{row['attempts']} made  ·  {format_score(row['scored'])} PTS",
                size=12 * scale, fill=INK_2 if live else LABEL_EMPTY, anchor="ne",
            )

            next_y = stack["y"].get(f"n{index + 1}")
            room = (next_y - (sub_y + sub_h)) if next_y else ((y1 - pad) - (sub_y + sub_h))
            if room >= 10 * self._scale:
                rail_y = sub_y + sub_h + min(room, 26 * self._scale) / 2
                thickness = max(3.0, 5 * self._scale)
                paint_meter(
                    self.canvas,
                    (left, rail_y - thickness / 2, right, rail_y + thickness / 2),
                    (row["pct"] or 0) / 100.0, heat,
                    track=self._track, track_color=TRACK,
                )

    def _draw_ticker(self, box, session, *, finished):
        """The last shots as dots — filled for a make, hollow for a miss."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        stats = session.get("stats") or {}
        last = session.get("lastShot") or {}
        shots = [shot for shot in (session.get("recentShots") or []) if isinstance(shot, dict)]

        if finished:
            title = "FINAL"
            right_text = f"{int(stats.get('fgPct') or 0)}% FROM THE FLOOR"
            right_fill = WARN
        else:
            title = "LAST SHOTS"
            streak = int(stats.get("streak") or 0)
            if streak > 1:
                right_text = f"{streak} IN A ROW"
                right_fill = GOOD
            elif last:
                verb = "MADE" if last.get("made") else "MISSED"
                right_text = " ".join(part for part in [
                    clip(last.get("player"), 12), verb, str(last.get("zoneLabel") or ""),
                ] if part).upper()
                right_fill = GOOD if last.get("made") else INK_2
            else:
                right_text = "WARMING UP"
                right_fill = INK_2

        head_y = y0 + pad * 0.7
        self._title(x0 + pad, head_y, title)
        size = self._fit_size(
            letterspace(right_text), (x1 - x0) * 0.5, 15, minimum=9, bold=False,
        )
        self._text(
            x1 - pad, head_y, letterspace(right_text),
            size=size, fill=right_fill, anchor="ne",
        )

        if not shots:
            return
        row_top = head_y + self._line_h(14) + 8 * self._scale
        row_h = max(10.0, (y1 - pad * 0.8) - row_top)
        cy = row_top + row_h / 2
        radius = min(row_h / 2, 19 * self._scale)
        step = radius * 2.9
        capacity = max(1, int(((x1 - pad) - (x0 + pad)) // max(1.0, step)))
        shown = shots[-capacity:]
        for index, shot in enumerate(shown):
            cx = x0 + pad + radius + step * index
            colour = ZONE_COLORS.get(shot.get("zone"), ACCENT)
            if shot.get("made"):
                self._dot(cx, cy, radius, fill=colour)
            else:
                self._dot(cx, cy, radius * 0.86, fill=CARD_LO,
                          outline=mix(INK_3, colour, 0.35),
                          width=max(2, int(round(2.4 * self._scale))))
            if index == len(shown) - 1:
                self._dot(cx, cy, radius * 1.34, fill="", outline=mix(colour, INK, 0.35),
                          width=max(1, int(round(1.8 * self._scale))))

    # ------------------------------------------------------------- dashboard

    def _render_dashboard(self, payload: dict):
        self._sync_metrics()
        screen_w, screen_h = self._screen()
        recent = [row for row in (payload.get("recent") or []) if isinstance(row, dict)]
        boxes = layout_huupe_dashboard(screen_w, screen_h, timed=True, recent=bool(recent))
        cards = [
            (box, 0.05 if name == "totals" else 0.0)
            for name, box in boxes.items()
            if isinstance(box, tuple) and len(box) == 4
        ]
        # The page image carries the card fills, so it needs the boxes first.
        self._paint_huupe_backdrop(kind="dashboard", cards=cards)
        self._paint_header(title="HUUPE DASHBOARD")
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box, lift=0.05 if name == "totals" else 0.0)

        self._draw_totals(
            boxes["totals"], payload.get("totals") or {},
            wide=not boxes["chrome"].portrait,
        )
        self._draw_leaderboard(
            boxes["leaderboard"],
            payload.get("leaderboard") or [],
            int(payload.get("moreCount") or 0),
        )
        if "recent" in boxes:
            self._draw_recent(boxes["recent"], recent)
        rows = zone_rows(payload.get("zones"))
        self._draw_court(
            boxes["court"], rows,
            title="CAREER SHOT CHART", subtitle="SHARE OF CAREER POINTS",
        )
        self._draw_zone_legend(boxes["zones"], rows)
        self._draw_records(boxes["records"], payload.get("records") or {}, payload.get("device"))

    def _draw_totals(self, box, totals, *, wide=False):
        """Accuracy as a dial, everything else as tiles beside it."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        radius = max(16.0, min((x1 - x0) * 0.10, (y1 - y0) * 0.40))
        dial_cx = x0 + pad + radius
        self._dial_block(
            dial_cx, y0 + pad * 0.8, y1 - pad * 0.8, radius,
            int(totals.get("fgPct") or 0), "ACCURACY",
        )

        tiles = [
            ("SESSIONS", str(totals.get("sessions") or 0)),
            ("SHOTS", str(totals.get("shots") or 0)),
            ("POINTS", str(totals.get("pointsLabel") or format_score(totals.get("points")))),
            ("LAST", str(totals.get("lastPlayedLabel") or "—")),
        ]
        if wide:
            # A 1920px band spreads four numbers into nothing; landscape has the
            # room for the two the portrait page has to leave out.
            tiles[2:2] = [
                ("MADE", str(totals.get("makes") or 0)),
                ("ON THE CLOCK", str(totals.get("playLabel") or "—")),
            ]
        grid_x = dial_cx + radius + pad
        cell_w = (x1 - pad - grid_x) / len(tiles)
        stack = stack_rows(
            [("value", 32, 6), ("label", 13, 0)],
            top=y0 + pad * 0.9,
            available=(y1 - y0) - pad * 1.8,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        for index, (label, value) in enumerate(tiles):
            cx = grid_x + cell_w * (index + 0.5)
            if index:
                self._track(self.canvas.create_line(
                    grid_x + cell_w * index, y0 + pad * 0.7,
                    grid_x + cell_w * index, y1 - pad * 0.7,
                    fill=EDGE_SOFT, width=1,
                ))
            size = self._fit_size(value, cell_w * 0.88, 32 * scale, minimum=13)
            self._text(cx, stack["y"]["value"], value, size=size, bold=True, anchor="n")
            self._text(
                cx, stack["y"]["label"], letterspace(label),
                size=13 * scale, fill=INK_3, anchor="n",
            )

    def _draw_leaderboard(self, box, leaderboard, more_count):
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, "BRAGGING RIGHTS")

        top = self._head_top(box)
        available = (y1 - top) - pad
        if not leaderboard:
            empty = stack_rows(
                [("a", 18, 10), ("b", 15, 0)],
                top=top, available=available, u=self._scale, px_per_pt=self._px_per_pt,
            )
            self._text(left, empty["y"]["a"], "No named games yet.", size=18, fill=INK_2)
            self._text(
                left, empty["y"]["b"],
                "Family Mode games land here — free play feeds the totals above.",
                size=15, fill=INK_3,
            )
            return

        row_points = 21
        row_height = self._line_h(row_points) + 18 * self._scale
        capacity = max(1, int(available // max(1.0, row_height)))
        shown = list(leaderboard[:capacity])
        hidden = more_count + max(0, len(leaderboard) - len(shown))
        if hidden and len(shown) > 1:
            shown = shown[:-1]
            hidden += 1

        gap = self._even_gap(
            available, self._line_h(row_points), len(shown) + (1 if hidden else 0),
            minimum=14, maximum=40,
        )
        spec = [(f"r{index}", row_points, gap) for index in range(len(shown))]
        if hidden:
            spec.append(("more", 14, 0))
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = row_points * stack["font_scale"]
        lead = max([int(row.get("wins") or 0) for row in shown] or [0]) or 1

        for index, player in enumerate(shown):
            key = f"r{index}"
            y = stack["y"][key]
            height = stack["h"][key]
            if index == 0:
                paint_bar(
                    self.canvas,
                    (x0 + pad * 0.5, y - 4 * self._scale, x1 - pad * 0.5,
                     y + height + 4 * self._scale),
                    fill=PLATE_ACCENT, outline="", track=self._track,
                )
            colour = MEDALS[index] if index < len(MEDALS) else INK
            rank = str(player.get("rank") or index + 1)
            self._text(
                left, y, f"{rank}  {clip(player.get('name'), 13)}",
                size=size, bold=True, fill=colour,
            )
            wins = int(player.get("wins") or 0)
            summary = f"{wins}W   {int(player.get('fgPct') or 0)}%   {format_score(player.get('bestScore'))}"
            self._text(right, y, summary, size=size, fill=INK_2, anchor="ne")

            next_y = stack["y"].get(f"r{index + 1}") or stack["y"].get("more")
            room = (next_y - (y + height)) if next_y else ((y1 - pad) - (y + height))
            if room >= 10 * self._scale:
                rail_y = y + height + min(room, 26 * self._scale) / 2
                thickness = max(3.0, 5 * self._scale)
                paint_meter(
                    self.canvas,
                    (left, rail_y - thickness / 2, right, rail_y + thickness / 2),
                    wins / lead, colour, track=self._track, track_color=TRACK,
                )

        if hidden:
            self._text(
                left, stack["y"]["more"], f"+{hidden} more",
                size=14 * stack["font_scale"], fill=INK_3,
            )

    def _draw_recent(self, box, recent):
        """The last few sessions, so free play has something to show for itself."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, "RECENT SESSIONS")

        top = self._head_top(box)
        available = (y1 - top) - pad
        row_h = self._line_h(17) + 14 * self._scale
        capacity = max(1, int(available // max(1.0, row_h)))
        shown = list(recent[:capacity])
        if not shown:
            return
        gap = self._even_gap(
            available, self._line_h(17), len(shown), minimum=12, maximum=34,
        )
        spec = [(f"g{index}", 17, gap) for index in range(len(shown))]
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 17 * stack["font_scale"]

        for index, row in enumerate(shown):
            y = stack["y"][f"g{index}"]
            when = str(row.get("whenLabel") or "")
            mode = str(row.get("modeLabel") or "Session")
            winner = str(row.get("winner") or "")
            head = f"{when}  ·  {mode}" if when else mode
            if winner:
                head = f"{head}  ·  {clip(winner, 12)}"
            self._text(left, y, head, size=size, fill=INK)
            points = str(row.get("pointsLabel") or format_score(row.get("points")))
            made, attempts = int(row.get("made") or 0), int(row.get("attempts") or 0)
            tail = f"{points} PTS" if not attempts else f"{points} PTS   {made}/{attempts}"
            self._text(right, y, tail, size=size, bold=True, fill=INK_2, anchor="ne")

    def _draw_records(self, box, records, device):
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, "RECORDS")

        best = records.get("bestSessionScore") or {}
        streak = records.get("bestStreak") or {}
        accuracy = records.get("bestFgPct") or {}
        lines = [
            ("BEST GAME", format_score(best.get("value")) if best else "—",
             str(best.get("modeLabel") or "")),
            ("LONGEST RUN", str(int(streak.get("value") or 0)) if streak else "—",
             clip(streak.get("player") or "", 12)),
            ("BEST ACCURACY", f"{int(accuracy.get('value') or 0)}%" if accuracy else "—",
             clip(accuracy.get("player") or "", 12)),
        ]
        if device:
            status = "ONLINE" if device.get("online") else "OFFLINE"
            lines.append(("HOOP", status, clip(device.get("name") or "", 14)))

        top = self._head_top(box)
        available = (y1 - top) - pad
        gap = self._even_gap(
            available, self._line_h(18), len(lines), minimum=12, maximum=34,
        )
        spec = [(f"l{index}", 18, gap) for index in range(len(lines))]
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 18 * stack["font_scale"]

        for index, (label, value, note) in enumerate(lines):
            y = stack["y"][f"l{index}"]
            self._text(left, y, letterspace(label), size=size, fill=INK_3)
            text = f"{value}  ·  {note}" if note else value
            colour = GOOD if label == "HOOP" and value == "ONLINE" else INK
            self._text(right, y, text, size=size, bold=True, fill=colour, anchor="ne")
