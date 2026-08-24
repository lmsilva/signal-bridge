"""Autodarts dashboard + live/final match overlay.

UDP: ``autodarts.dashboard``, ``autodarts.match`` (live or finished), close via
``autodarts.match.close`` (handled in main). Board geometry §12; layout §11 / §13.
"""

from __future__ import annotations

import json
import math
from datetime import datetime

from src.design_system import (
    ACCENT,
    ALERT,
    BG,
    FILL,
    INK,
    INK_2,
    INK_3,
    LINE,
    WARN,
    page_chrome,
)
from src.display_panels import BasePanel
from src.page_header import paint_page_header
from src.roll_credits_panel import format_month_axis_label, month_axis_font_size

# Classic board order, clockwise from top (20).
SEGMENT_ORDER = (
    20, 1, 18, 4, 13, 6, 10, 15, 2, 17,
    3, 19, 7, 16, 8, 11, 14, 9, 12, 5,
)

# Palette §12 — real board tones on the navy wall.
SURROUND = "#111111"
BED_BLACK = "#161616"
BED_CREAM = "#F2ECD8"
BAND_RED = "#D64541"
BAND_GREEN = "#3E9B5F"
NUMBERS = "#F2F7FF"
WIRES = "#0A0A0A"

# Ratios with double-outer = 1.0
R_DOUBLE_OUTER = 1.0
R_DOUBLE_INNER = 0.953
R_TREBLE_OUTER = 0.629
R_TREBLE_INNER = 0.582
R_OUTER_BULL = 0.094
R_INNER_BULL = 0.037
R_NUMBER_RING = 1.12
R_SURROUND = 1.28
R_MISS_FALLBACK = 1.08


def board_radii(outer_px: float) -> dict:
    """Absolute ring radii in pixels for a board whose double-outer is ``outer_px``."""
    r = max(1.0, float(outer_px))
    return {
        "double_outer": r * R_DOUBLE_OUTER,
        "double_inner": r * R_DOUBLE_INNER,
        "treble_outer": r * R_TREBLE_OUTER,
        "treble_inner": r * R_TREBLE_INNER,
        "outer_bull": r * R_OUTER_BULL,
        "inner_bull": r * R_INNER_BULL,
        "number_ring": r * R_NUMBER_RING,
        "surround": r * R_SURROUND,
    }


def segment_index(number: int) -> int | None:
    try:
        return SEGMENT_ORDER.index(int(number))
    except (ValueError, TypeError):
        return None


def segment_angle_rad(number: int) -> float | None:
    """Clockwise-from-top angle (radians) for the centre of a numbered wedge."""
    idx = segment_index(number)
    if idx is None:
        return None
    return idx * (2 * math.pi / 20)


def board_xy_to_offset(x: float, y: float, outer_px: float) -> tuple[float, float]:
    """Autodarts normalised coords → pixel offset from centre.

    Autodarts: 0,0 centre; distance 1.0 = double outer; **+y toward 20 (top)**.
    Screen: +x right, +y down → ``(x * R, -y * R)``.
    """
    r = max(1.0, float(outer_px))
    return float(x) * r, -float(y) * r


def map_coords_to_px(
    x: float,
    y: float,
    cx: float,
    cy: float,
    outer_px: float,
) -> tuple[float, float]:
    dx, dy = board_xy_to_offset(x, y, outer_px)
    return cx + dx, cy + dy


def parse_segment(seg) -> tuple[str, int | None]:
    """Return (kind, number) where kind is single|double|treble|bull|outer_bull|miss|unknown."""
    text = str(seg or "").strip().upper()
    if not text or text in ("M", "MISS", "OUT"):
        return "miss", None
    if text in ("DB", "BULL", "IB", "INNER"):
        return "bull", None
    if text in ("B", "SB", "OUTER", "25"):
        return "outer_bull", None
    if text.startswith("T") and text[1:].isdigit():
        return "treble", int(text[1:])
    if text.startswith("D") and text[1:].isdigit():
        return "double", int(text[1:])
    if text.startswith("S") and text[1:].isdigit():
        return "single", int(text[1:])
    if text.isdigit():
        return "single", int(text)
    return "unknown", None


def segment_centroid(seg, *, miss_radius: float = R_MISS_FALLBACK) -> tuple[float, float]:
    """Normalised board (x, y) at the visual centre of a segment bed (+y = 20/top)."""
    kind, number = parse_segment(seg)
    if kind == "miss":
        # Pin just outside the rim at a neutral angle (3-o'clock) — never invent a hit.
        return miss_radius, 0.0
    if kind == "bull":
        return 0.0, 0.0
    if kind == "outer_bull":
        return 0.0, (R_OUTER_BULL * 0.55)
    if number is None:
        return 0.0, 0.0
    angle = segment_angle_rad(number)
    if angle is None:
        return 0.0, 0.0
    if kind == "treble":
        radius = (R_TREBLE_INNER + R_TREBLE_OUTER) / 2
    elif kind == "double":
        radius = (R_DOUBLE_INNER + R_DOUBLE_OUTER) / 2
    else:
        # Outer single bed (between treble and double) — most readable centroid.
        radius = (R_TREBLE_OUTER + R_DOUBLE_INNER) / 2
    # x = r sin θ, y = r cos θ (θ clockwise from top; +y = top / 20).
    return radius * math.sin(angle), radius * math.cos(angle)


def dart_board_xy(dart: dict | None) -> tuple[float, float] | None:
    """Resolve a dart object to normalised board coords (passthrough or centroid)."""
    if not isinstance(dart, dict):
        return None
    kind, _number = parse_segment(dart.get("seg") or dart.get("segment"))
    x = dart.get("x")
    y = dart.get("y")
    has_coords = x is not None and y is not None
    try:
        if has_coords:
            return float(x), float(y)
    except (TypeError, ValueError):
        has_coords = False
    if kind == "miss" and not has_coords:
        return segment_centroid("M")
    seg = dart.get("seg") or dart.get("segment")
    if seg:
        return segment_centroid(seg)
    return None


def is_miss_dart(dart: dict | None) -> bool:
    if not isinstance(dart, dict):
        return False
    if str(dart.get("type") or "").lower() in ("miss", "outside"):
        return True
    kind, _ = parse_segment(dart.get("seg") or dart.get("segment"))
    return kind == "miss"


def is_bouncer_dart(dart: dict | None) -> bool:
    if not isinstance(dart, dict):
        return False
    return str(dart.get("type") or "").lower() in ("bouncer", "bounce", "bounce-out", "bounceout")


def wedge_contains_angle(number: int, angle_from_top_cw: float) -> bool:
    """True when ``angle_from_top_cw`` (radians) sits in the numbered 18° wedge."""
    centre = segment_angle_rad(number)
    if centre is None:
        return False
    half = math.pi / 20
    delta = (angle_from_top_cw - centre + math.pi) % (2 * math.pi) - math.pi
    return abs(delta) <= half + 1e-9


def point_board_radius_angle(x: float, y: float) -> tuple[float, float]:
    """Normalised (x,y) → (radius, angle clockwise from top). +y is toward 20."""
    radius = math.hypot(x, y)
    # atan2(x, y): 0 at top (+y), clockwise positive.
    angle = math.atan2(x, y) if radius > 1e-12 else 0.0
    return radius, angle


def is_t20_in_treble_wedge(x: float, y: float) -> bool:
    """Calibration helper: normalised point lands in the treble-20 bed."""
    radius, angle = point_board_radius_angle(x, y)
    if radius < R_TREBLE_INNER - 1e-6 or radius > R_TREBLE_OUTER + 1e-6:
        return False
    return wedge_contains_angle(20, angle)


def is_t20_in_treble_wedge_px(
    px: float,
    py: float,
    cx: float,
    cy: float,
    outer_px: float,
) -> bool:
    """Same check after mapping to screen pixels."""
    r = max(1.0, float(outer_px))
    x = (px - cx) / r
    y = -(py - cy) / r  # invert screen Y back to Autodarts (+y = top)
    return is_t20_in_treble_wedge(x, y)


def fit_player_name_size(label: str, col_w: float, *, compact: bool = False) -> int:
    """Width-driven name size so tall landscape columns cannot blow up type."""
    text = str(label or "")
    # Approximate Segoe UI bold advance (~0.62em); leave side padding.
    usable = max(40.0, col_w - 20.0)
    char_w = 0.62
    by_width = int(usable / max(1, len(text) * char_w)) if text else 18
    cap = 26 if not compact else 20
    floor = 13 if not compact else 12
    return int(max(floor, min(cap, by_width, col_w * 0.13)))


def current_month_bar_color(index: int, count: int) -> str:
    """Gold on the current month (last bar in the rolling 12)."""
    return WARN if count > 0 and index == count - 1 else ACCENT


def should_show_ghosts(turn: dict | None) -> bool:
    """Ghosts clear the moment the next turn's first dart lands."""
    darts = (turn or {}).get("darts") or []
    for dart in darts:
        if dart is not None:
            return False
    return True


def format_duration_sec(seconds) -> str:
    try:
        total = max(0, int(seconds))
    except (TypeError, ValueError):
        return ""
    minutes, sec = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h{minutes:02d}m"
    return f"{minutes}m{sec:02d}s"


def format_game_shot(value) -> str:
    if not value:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    upper = text.upper()
    if upper.startswith("GAME SHOT"):
        return upper
    return f"GAME SHOT — {upper}"


def turn_has_content(turn: dict | None) -> bool:
    """True when the turn strip would show real darts / points / bust (not empty dashes)."""
    if not isinstance(turn, dict):
        return False
    if turn.get("busted"):
        return True
    points = turn.get("points")
    if isinstance(points, (int, float)) and float(points) != 0:
        return True
    for dart in turn.get("darts") or []:
        if not isinstance(dart, dict):
            continue
        seg = str(dart.get("seg") or dart.get("segment") or "").strip()
        if seg and seg != "—":
            return True
    return False


def should_show_turn_strip(match: dict | None, *, finished: bool) -> bool:
    """Live always shows the strip; FINAL only when game-shot or last-turn content exists."""
    match = match or {}
    if format_game_shot(match.get("gameShot")):
        return True
    if finished:
        return turn_has_content(match.get("turn"))
    return True


def match_fingerprint(match: dict | None) -> str:
    try:
        return json.dumps(match or {}, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(match)


def dashboard_fingerprint(payload: dict | None) -> str:
    try:
        body = {
            k: (payload or {}).get(k)
            for k in (
                "totals", "leaderboard", "moreCount", "byMonth", "byVariant",
                "rivalry", "records", "recent", "board", "displaySeconds",
            )
        }
        return json.dumps(body, sort_keys=True, default=str)
    except (TypeError, ValueError):
        return str(payload)


def format_last_played_label(totals: dict | None) -> str:
    """Prefer a short calendar date; fall back to relative age."""
    totals = totals or {}
    iso = totals.get("lastPlayedAt")
    if iso:
        try:
            when = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            return when.strftime("%b %d")
        except ValueError:
            pass
    label = str(totals.get("lastPlayedLabel") or "").strip()
    if not label:
        return "—"
    # Bridge sends compact "22d" / "3h" — expand for the wall.
    if label.endswith("d") and label[:-1].isdigit():
        days = int(label[:-1])
        return f"{days} day{'s' if days != 1 else ''} ago"
    if label.endswith("h") and label[:-1].isdigit():
        hours = int(label[:-1])
        return f"{hours} hour{'s' if hours != 1 else ''} ago"
    if label.endswith("m") and label[:-1].isdigit():
        minutes = int(label[:-1])
        return f"{minutes} min ago"
    return label


def format_leaderboard_detail(row: dict, *, compact: bool = False) -> str:
    """Readable sub-line: checkout = finishing double; 180 = three T20s."""
    wins = int(row.get("wins") or 0)
    losses = int(row.get("losses") or 0)
    win_pct = row.get("winPct")
    avg = row.get("x01Average")
    hi = row.get("bestCheckout")
    one80 = int(row.get("oneEighties") or 0)
    matches = int(row.get("matches") or 0)
    pct = f"{win_pct:.0f}%" if isinstance(win_pct, (int, float)) else "—"
    avg_s = f"{avg:.1f}" if isinstance(avg, (int, float)) else "—"
    hi_s = str(int(hi)) if isinstance(hi, (int, float)) and hi else "—"
    if compact:
        return f"{wins}–{losses} ({pct})  ·  Avg {avg_s}  ·  Out {hi_s}  ·  180×{one80}"
    return (
        f"Record {wins}–{losses} ({pct})  ·  Avg {avg_s}  ·  "
        f"Highest checkout {hi_s}  ·  180 scores {one80}  ·  {matches} games"
    )


def format_record_average(value) -> str:
    if not isinstance(value, (int, float)):
        return "—"
    return f"{float(value):.1f}"


def format_final_scoreline(players) -> str:
    """FINAL banner: two-player head-to-head, or every name+legs for 3+."""
    rows = [p for p in (players or []) if isinstance(p, dict)]
    if not rows:
        return ""
    if len(rows) == 1:
        return f"{rows[0].get('name') or '—'}   {rows[0].get('legs') or 0}"
    if len(rows) == 2:
        left, right = rows[0], rows[1]
        return (
            f"{left.get('name') or '—'}   {left.get('legs') or 0}"
            f"  —  {right.get('legs') or 0}   {right.get('name') or '—'}"
        )
    return "  ·  ".join(
        f"{row.get('name') or '—'} {row.get('legs') or 0}" for row in rows
    )


def board_info_row_ys(box_h: float, pad: float = 18) -> dict:
    """Vertical anchors inside the YOUR BOARD tile — keep meta clear of stats."""
    height = max(160.0, float(box_h))
    title_y = pad
    name_y = pad + 26
    meta_y = pad + 56
    # Stats occupy the lower third only; never climb into the version line.
    stats_top = max(meta_y + 32, height * 0.52)
    stats_bottom = height - pad
    stats_mid = (stats_top + stats_bottom) / 2
    return {
        "title": title_y,
        "name": name_y,
        "meta": meta_y,
        "value": stats_mid - 14,
        "label": stats_mid + 16,
        "meta_clear_of_value": meta_y + 22 < (stats_mid - 14) - 8,
    }


def leaderboard_visible_rows(box_h: float, row_count: int, *, header: float = 52, footer: float = 14) -> tuple[int, float]:
    """How many two-line leaderboard rows fit without overlapping."""
    usable = max(60.0, float(box_h) - header - footer)
    min_row = 58.0
    max_rows = max(1, int(usable // min_row))
    visible = max(1, min(int(row_count or 0), max_rows))
    row_h = usable / visible
    return visible, row_h


def layout_dashboard(screen_w: int, screen_h: int, *, timed: bool = True) -> dict:
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0, y1 = chrome.content_top + 10 * u, chrome.content_bottom - 14 * u
    gap = 12 * u
    if chrome.portrait:
        avail = max(400.0, y1 - y0)
        totals_h = 96 * u
        board_info_h = 200 * u
        months_h = 170 * u
        rivalry_h = 150 * u
        records_h = 150 * u
        fixed = totals_h + board_info_h + months_h + rivalry_h + records_h + gap * 5
        board_h = max(240 * u, avail - fixed)
        y = y0
        boxes = {"totals": (x0, y, x1, y + totals_h)}
        y += totals_h + gap
        boxes["board_info"] = (x0, y, x1, y + board_info_h)
        y += board_info_h + gap
        boxes["leaderboard"] = (x0, y, x1, y + board_h)
        y += board_h + gap
        boxes["months"] = (x0, y, x1, y + months_h)
        y += months_h + gap
        boxes["rivalry"] = (x0, y, x1, y + rivalry_h)
        y += rivalry_h + gap
        boxes["records"] = (x0, y, x1, min(y + records_h, y1))
        return boxes
    # Landscape: give the board more of the width so 12 rows can breathe.
    left_w = chrome.content_w * 0.58
    boxes = {
        "leaderboard": (x0, y0, x0 + left_w, y1),
    }
    rx0 = x0 + left_w + gap
    totals_h = 100 * u
    board_info_h = 200 * u
    months_h = 180 * u
    rivalry_h = 140 * u
    boxes["totals"] = (rx0, y0, x1, y0 + totals_h)
    boxes["board_info"] = (rx0, y0 + totals_h + gap, x1, y0 + totals_h + gap + board_info_h)
    months_top = boxes["board_info"][3] + gap
    boxes["months"] = (rx0, months_top, x1, months_top + months_h)
    boxes["rivalry"] = (
        rx0,
        months_top + months_h + gap,
        x1,
        months_top + months_h + gap + rivalry_h,
    )
    boxes["records"] = (rx0, boxes["rivalry"][3] + gap, x1, y1)
    return boxes


def layout_match(screen_w: int, screen_h: int, *, timed: bool, player_count: int = 2,
                 finished: bool = False, show_strip: bool = True) -> dict:
    """Portrait: scores / board / strip fill height (board absorbs slack).
    Landscape: player | board | player with strip under the board.
    Finished cards reserve a result band so the board never covers names.
    When ``show_strip`` is False (empty FINAL), the board takes that space.
    """
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 8 * u
    y1 = chrome.content_bottom - 10 * u
    settings_h = 44 * u
    strip_h = (100 * u) if show_strip else 0
    result_h = (64 * u) if finished else 0
    players = max(1, min(8, int(player_count or 2)))
    if chrome.portrait:
        if finished and players <= 2:
            # Banner already has names — keep the score row short (legs + avg only).
            scores_h = 118 * u
            result_h = 56 * u
        elif players <= 2:
            scores_h = 150 * u
        elif players <= 4:
            scores_h = 200 * u
        else:
            scores_h = 240 * u
        settings = (x0, y0, x1, y0 + settings_h)
        cursor = y0 + settings_h + 6 * u
        result = None
        if finished:
            result = (x0, cursor, x1, cursor + result_h)
            cursor = result[3] + 8 * u
        scores = (x0, cursor, x1, cursor + scores_h)
        strip = (x0, y1 - strip_h, x1, y1) if show_strip else None
        board_bottom = (strip[1] - 10 * u) if strip else y1
        board = (x0, scores[3] + 10 * u, x1, board_bottom)
        return {
            "settings": settings,
            "result": result,
            "scores": scores,
            "board": board,
            "strip": strip,
            "portrait": True,
            "finished": finished,
            "chrome": chrome,
            "player_count": players,
            "show_strip": show_strip,
            "omit_score_names": bool(finished and players <= 2),
        }
    settings = (x0, y0, x1, y0 + settings_h)
    cursor = y0 + settings_h + 8 * u
    result = None
    if finished:
        result = (x0, cursor, x1, cursor + result_h)
        cursor = result[3] + 10 * u
    body_top = cursor
    # Narrower side columns when many players so the board stays readable.
    col_frac = 0.18 if players >= 5 else (0.20 if players >= 3 else 0.22)
    col_w = chrome.content_w * col_frac
    body_bottom = (y1 - strip_h - 8 * u) if show_strip else y1
    board_box = (x0 + col_w + 12 * u, body_top, x1 - col_w - 12 * u, body_bottom)
    return {
        "settings": settings,
        "result": result,
        "scores_left": (x0, body_top, x0 + col_w, body_bottom),
        "scores_right": (x1 - col_w, body_top, x1, body_bottom),
        "board": board_box,
        "strip": (board_box[0], y1 - strip_h, board_box[2], y1) if show_strip else None,
        "portrait": False,
        "finished": finished,
        "chrome": chrome,
        "player_count": players,
        "show_strip": show_strip,
    }


def draw_crown(canvas, cx: float, cy: float, size: float, *, fill=WARN, track=None):
    """Drawn crown glyph (not emoji) — leaderboard / leg leader / final winner."""
    s = max(6.0, float(size))
    points = [
        cx - s * 0.55, cy + s * 0.35,
        cx - s * 0.55, cy - s * 0.05,
        cx - s * 0.28, cy + s * 0.12,
        cx, cy - s * 0.42,
        cx + s * 0.28, cy + s * 0.12,
        cx + s * 0.55, cy - s * 0.05,
        cx + s * 0.55, cy + s * 0.35,
    ]
    item = canvas.create_polygon(*points, fill=fill, outline=fill, width=1, smooth=False)
    if track:
        track(item)
    band = canvas.create_rectangle(
        cx - s * 0.55, cy + s * 0.35, cx + s * 0.55, cy + s * 0.48,
        fill=fill, outline="",
    )
    if track:
        track(band)
    return item


def _wedge_path(cx, cy, r0, r1, a0, a1, steps=10):
    points = []
    for i in range(steps + 1):
        t = a0 + (a1 - a0) * (i / steps)
        points.extend([cx + r1 * math.sin(t), cy - r1 * math.cos(t)])
    for i in range(steps + 1):
        t = a1 - (a1 - a0) * (i / steps)
        points.extend([cx + r0 * math.sin(t), cy - r0 * math.cos(t)])
    return points


def draw_dartboard(canvas, cx, cy, outer_px, *, track=None, show_numbers=True):
    """Faithful classic board (§12). Returns radii dict."""
    radii = board_radii(outer_px)
    ids = []

    def add(item):
        ids.append(item)
        if track:
            track(item)
        return item

    add(canvas.create_oval(
        cx - radii["surround"], cy - radii["surround"],
        cx + radii["surround"], cy + radii["surround"],
        fill=SURROUND, outline=WIRES, width=1,
    ))

    wedge = 2 * math.pi / 20
    for index, number in enumerate(SEGMENT_ORDER):
        a0 = index * wedge - wedge / 2
        a1 = a0 + wedge
        black_bed = index % 2 == 0  # 20 is black
        single_fill = BED_BLACK if black_bed else BED_CREAM
        band_fill = BAND_RED if black_bed else BAND_GREEN
        # Inner single (bull → treble)
        add(canvas.create_polygon(
            *_wedge_path(cx, cy, radii["outer_bull"], radii["treble_inner"], a0, a1),
            fill=single_fill, outline=WIRES, width=1,
        ))
        # Treble
        add(canvas.create_polygon(
            *_wedge_path(cx, cy, radii["treble_inner"], radii["treble_outer"], a0, a1),
            fill=band_fill, outline=WIRES, width=1,
        ))
        # Outer single
        add(canvas.create_polygon(
            *_wedge_path(cx, cy, radii["treble_outer"], radii["double_inner"], a0, a1),
            fill=single_fill, outline=WIRES, width=1,
        ))
        # Double
        add(canvas.create_polygon(
            *_wedge_path(cx, cy, radii["double_inner"], radii["double_outer"], a0, a1),
            fill=band_fill, outline=WIRES, width=1,
        ))
        if show_numbers:
            nr = radii["number_ring"]
            angle = index * wedge
            nx = cx + nr * math.sin(angle)
            ny = cy - nr * math.cos(angle)
            size = max(9, int(outer_px * 0.07))
            add(canvas.create_text(
                nx, ny, text=str(number), fill=NUMBERS,
                font=("Segoe UI", size, "bold"), angle=0,
            ))

    add(canvas.create_oval(
        cx - radii["outer_bull"], cy - radii["outer_bull"],
        cx + radii["outer_bull"], cy + radii["outer_bull"],
        fill=BAND_GREEN, outline=WIRES, width=1,
    ))
    add(canvas.create_oval(
        cx - radii["inner_bull"], cy - radii["inner_bull"],
        cx + radii["inner_bull"], cy + radii["inner_bull"],
        fill=BAND_RED, outline=WIRES, width=1,
    ))
    return radii


def draw_dart_marker(canvas, px, py, *, kind="normal", index=None, scale=1.0, track=None):
    """Accent dart / ghost / miss ✕ / bouncer ring on the board face."""
    s = max(0.5, float(scale))

    def add(item):
        if track:
            track(item)
        return item

    if kind == "miss":
        size = 10 * s
        add(canvas.create_line(px - size, py - size, px + size, py + size, fill=INK_2, width=max(2, int(2 * s))))
        add(canvas.create_line(px - size, py + size, px + size, py - size, fill=INK_2, width=max(2, int(2 * s))))
        return
    if kind == "bouncer":
        r = 9 * s
        add(canvas.create_oval(px - r, py - r, px + r, py + r, outline=ACCENT, width=max(2, int(2 * s)), fill=""))
        return
    if kind == "ghost":
        r = 5 * s
        add(canvas.create_oval(px - r - 1, py - r - 1, px + r + 1, py + r + 1, outline="#0A0A0A", width=1, fill=""))
        add(canvas.create_oval(px - r, py - r, px + r, py + r, fill=INK_2, outline=""))
        return
    # Live dart: shadow + accent ring + white core + index
    r = 11 * s
    add(canvas.create_oval(px - r + 1, py - r + 2, px + r + 1, py + r + 2, fill="#000000", outline=""))
    add(canvas.create_oval(px - r, py - r, px + r, py + r, fill=ACCENT, outline=""))
    core = 4.5 * s
    add(canvas.create_oval(px - core, py - core, px + core, py + core, fill=INK, outline=""))
    if index is not None:
        add(canvas.create_text(
            px, py - r - 8 * s, text=str(index), fill=ACCENT,
            font=("Segoe UI", max(9, int(11 * s)), "bold"),
        ))


def normalize_hit_map(hit_map, players: list) -> list[dict]:
    """Return ``[{name, darts}, ...]`` or [] when there are no plottable coords."""
    if not hit_map:
        return []
    rows = []
    if isinstance(hit_map, dict) and isinstance(hit_map.get("players"), list):
        source = hit_map["players"]
    elif isinstance(hit_map, list):
        source = hit_map
    elif isinstance(hit_map, dict):
        source = [{"name": key, "darts": value} for key, value in hit_map.items()]
    else:
        return []
    for index, row in enumerate(source):
        if not isinstance(row, dict):
            continue
        name = row.get("name") or (
            (players[index].get("name") if index < len(players) else None) or f"P{index + 1}"
        )
        darts = row.get("darts") or row.get("throws") or []
        plottable = []
        for dart in darts:
            xy = dart_board_xy(dart if isinstance(dart, dict) else None)
            if xy is None:
                continue
            plottable.append({"x": xy[0], "y": xy[1], "raw": dart})
        rows.append({"name": name, "darts": plottable})
    if not any(row["darts"] for row in rows):
        return []
    return rows


class AutodartsPanel(BasePanel):
    """Owns chrome for dashboard + match (live / final)."""

    def __init__(self, root, shell, config: dict):
        super().__init__(root, shell, config)
        self._mode = None  # dashboard | match
        self._match_id = None
        self._revision = -1
        self._match_fp = None
        self._dashboard_fp = None
        self._payload = None
        self._draw_count = 0

    def show(self, payload: dict):
        payload_type = str((payload or {}).get("type") or "")
        if payload_type == "autodarts.dashboard":
            fp = dashboard_fingerprint(payload)
            if self.visible and self._mode == "dashboard" and fp == self._dashboard_fp:
                return
            self.hide()
            self.visible = True
            self._mode = "dashboard"
            self._dashboard_fp = fp
            self._match_id = None
            self._revision = -1
            self._match_fp = None
            self._payload = payload
            self._render_dashboard(payload)
            self._draw_count += 1
            return
        if payload_type == "autodarts.match":
            self._show_match(payload, force=True)
            return
        self.hide()

    def apply_match_payload(self, payload: dict) -> str:
        """In-place live update. Returns ignored | updated | replace."""
        if str((payload or {}).get("type") or "") != "autodarts.match":
            return "replace"
        if not self.visible or self._mode != "match":
            return "replace"
        match = (payload or {}).get("match") or {}
        match_id = str(match.get("matchId") or "")
        if match_id and self._match_id and match_id != self._match_id:
            return "replace"
        try:
            revision = int(match.get("revision") or 0)
        except (TypeError, ValueError):
            revision = 0
        if revision < self._revision:
            return "ignored"
        fp = match_fingerprint(match)
        if revision == self._revision and fp == self._match_fp:
            return "ignored"
        self._show_match(payload, force=False)
        return "updated"

    def _show_match(self, payload: dict, *, force: bool):
        match = (payload or {}).get("match") or {}
        try:
            revision = int(match.get("revision") or 0)
        except (TypeError, ValueError):
            revision = 0
        fp = match_fingerprint(match)
        match_id = str(match.get("matchId") or "")
        if (
            not force
            and self.visible
            and self._mode == "match"
            and revision < self._revision
        ):
            return
        if (
            self.visible
            and self._mode == "match"
            and revision == self._revision
            and fp == self._match_fp
        ):
            return
        self.hide()
        self.visible = True
        self._mode = "match"
        self._match_id = match_id
        self._revision = revision
        self._match_fp = fp
        self._dashboard_fp = None
        self._payload = payload
        self._render_match(payload)
        self._draw_count += 1

    def hide(self):
        super().hide()
        # Keep revision memory only while visible; cleared on hide so a reopen works.
        if not self.visible:
            pass

    def _screen(self):
        return int(self.shell.screen_w), int(self.shell.screen_h)

    def _font(self, size, bold=False):
        return ("Segoe UI", max(10, int(size)), "bold" if bold else "normal")

    def _paint_header(self, *, status_chip=None, title="AUTODARTS"):
        screen_w, screen_h = self._screen()
        right_label, right_value = "", ""
        if status_chip == "LIVE":
            right_label, right_value = "STATUS", "LIVE"
        elif status_chip == "FINAL":
            right_label, right_value = "STATUS", "FINAL"
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
            # Recolour the status value to alert coral (only LIVE uses ALERT).
            for item_id in ids[-2:]:
                try:
                    if self.canvas.type(item_id) == "text":
                        text = self.canvas.itemcget(item_id, "text")
                        if text == "LIVE":
                            self.canvas.itemconfigure(item_id, fill=ALERT)
                        elif text == "STATUS":
                            self.canvas.itemconfigure(item_id, fill=ALERT)
                except Exception:
                    pass
        return ids

    def _card(self, box):
        return self._track(self.canvas.create_rectangle(*box, fill=FILL, outline=LINE, width=2))

    # --- Dashboard ------------------------------------------------------------

    def _render_dashboard(self, payload: dict):
        self._paint_header(title="AUTODARTS DASHBOARD")
        screen_w, screen_h = self._screen()
        boxes = layout_dashboard(screen_w, screen_h, timed=True)
        for box in boxes.values():
            if box is None or not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box)
        self._draw_totals(boxes["totals"], payload.get("totals") or {})
        self._draw_board_info(boxes["board_info"], payload.get("board") or {})
        self._draw_leaderboard(
            boxes["leaderboard"],
            payload.get("leaderboard") or [],
            int(payload.get("moreCount") or 0),
        )
        self._draw_months(boxes["months"], payload.get("byMonth") or [])
        self._draw_rivalry(boxes["rivalry"], payload.get("rivalry"))
        self._draw_records(boxes["records"], payload.get("records"))

    def _draw_board_info(self, box, board: dict):
        x0, y0, x1, y1 = box
        pad = 18
        rows = board_info_row_ys(y1 - y0, pad)
        name = str(board.get("name") or "No board selected")
        online = board.get("online")
        status = board.get("statusLabel")
        if not status:
            status = "Running" if online is True else ("Offline" if online is False else "")
        status_fill = "#3E9B5F" if (
            online is True or str(status).lower() in ("running", "online", "connected")
        ) else (ALERT if online is False or str(status).lower() == "offline" else INK_3)
        self._track(self.canvas.create_text(
            x0 + pad, y0 + rows["title"], anchor="nw", text="YOUR BOARD",
            fill=INK_2, font=self._font(14, True),
        ))
        self._track(self.canvas.create_text(
            x0 + pad, y0 + rows["name"], anchor="nw", text=name,
            fill=INK, font=self._font(22, True),
        ))
        if status:
            self._track(self.canvas.create_text(
                x1 - pad, y0 + rows["name"] + 4, anchor="ne", text=status,
                fill=status_fill, font=self._font(16, True),
            ))
        version = board.get("version") or "—"
        update = board.get("updateLabel") or ""
        os_name = board.get("os") or ""
        meta_bits = [f"v{version}" if version != "—" else "v—"]
        if update:
            meta_bits.append(update)
        if os_name:
            meta_bits.append(str(os_name))
        self._track(self.canvas.create_text(
            x0 + pad, y0 + rows["meta"], anchor="nw",
            text=" · ".join(meta_bits),
            fill=INK_2, font=self._font(13),
        ))
        darts = board.get("dartsThrown")
        corrections = board.get("corrections")
        accuracy = board.get("accuracy")
        cells = [
            (f"{int(darts):,}" if isinstance(darts, (int, float)) else "—", "Darts"),
            (f"{int(corrections):,}" if isinstance(corrections, (int, float)) else "—", "Corrections"),
            (
                f"{accuracy:.2f}%" if isinstance(accuracy, (int, float)) else "—",
                "Accuracy",
            ),
        ]
        cell_w = (x1 - x0 - pad * 2) / len(cells)
        for index, (value, label) in enumerate(cells):
            cx = x0 + pad + cell_w * (index + 0.5)
            self._track(self.canvas.create_text(
                cx, y0 + rows["value"], text=str(value),
                fill=INK, font=self._font(20, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + rows["label"], text=label,
                fill=INK_3, font=self._font(12, True),
            ))

    def _draw_totals(self, box, totals: dict):
        x0, y0, x1, y1 = box
        last = format_last_played_label(totals)
        cells = [
            (totals.get("matches") or 0, "Matches"),
            (totals.get("legs") or 0, "Legs"),
            (totals.get("thisMonth") or 0, "This month"),
            (last, "Last played"),
        ]
        width = (x1 - x0) / len(cells)
        mid_y = (y0 + y1) / 2
        for index, (value, label) in enumerate(cells):
            x = x0 + width * (index + 0.5)
            value_size = 26 if isinstance(value, str) and len(str(value)) > 6 else 32
            self._track(self.canvas.create_text(
                x, mid_y - 16, text=str(value),
                fill=INK, font=self._font(value_size, True),
            ))
            self._track(self.canvas.create_text(
                x, mid_y + 18, text=label,
                fill=INK_3, font=self._font(13, True),
            ))

    def _draw_leaderboard(self, box, rows: list, more_count: int):
        x0, y0, x1, y1 = box
        pad = 18
        portrait = (x1 - x0) < 900
        self._track(self.canvas.create_text(
            x0 + pad, y0 + pad, anchor="nw", text="BOARD LEADERBOARD",
            fill=INK_2, font=self._font(16, True),
        ))
        if not rows:
            self._track(self.canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, text="No matches yet",
                fill=INK_3, font=self._font(18),
            ))
            return
        footer = 36 if more_count else 14
        visible_n, row_h = leaderboard_visible_rows(y1 - y0, len(rows), footer=footer)
        visible = list(rows)[:visible_n]
        top = y0 + 52
        # Fixed columns so rank / crown / name never overlap.
        rank_x = x0 + pad
        icon_cx = rank_x + 34
        name_x = rank_x + 56
        for index, row in enumerate(visible):
            cy = top + row_h * (index + 0.5)
            rank = row.get("rank") or (index + 1)
            name = str(row.get("name") or "—")
            crowned = bool(row.get("crown")) or index == 0
            if crowned:
                self._track(self.canvas.create_rectangle(
                    x0 + 10, cy - row_h * 0.42, x1 - 10, cy + row_h * 0.42,
                    fill="#1C2A1A", outline="",
                ))
                draw_crown(self.canvas, icon_cx, cy - row_h * 0.18, min(14, row_h * 0.22), track=self._track)
                name_fill = WARN
            else:
                name_fill = INK
            name_size = 18 if crowned else 16
            name_y = cy - row_h * 0.18
            detail_y = cy + row_h * 0.22
            self._track(self.canvas.create_text(
                rank_x, name_y, anchor="w",
                text=str(rank),
                fill=name_fill, font=self._font(name_size, True),
            ))
            self._track(self.canvas.create_text(
                name_x, name_y, anchor="w",
                text=name,
                fill=name_fill, font=self._font(name_size, True),
            ))
            self._track(self.canvas.create_text(
                name_x, detail_y, anchor="w",
                text=format_leaderboard_detail(row, compact=portrait),
                fill=INK_2, font=self._font(11 if portrait else 12),
            ))
        hidden = max(0, len(rows) - visible_n) + max(0, int(more_count or 0))
        if hidden > 0:
            self._track(self.canvas.create_text(
                x0 + pad, y1 - 16, anchor="sw",
                text=f"+ {hidden} more players",
                fill=INK_3, font=self._font(14, True),
            ))

    def _draw_months(self, box, months: list):
        x0, y0, x1, y1 = box
        pad = 22
        self._track(self.canvas.create_text(
            x0 + pad, y0 + pad, anchor="nw", text="MATCHES PER MONTH",
            fill=INK_2, font=self._font(16, True),
        ))
        rows = list(months)[-12:]
        if not rows:
            return
        max_count = max([int(row.get("count") or 0) for row in rows] or [1]) or 1
        axis_room = 50
        # Leave room under the title for the tallest count label.
        chart_top, chart_bottom = y0 + 78, y1 - axis_room
        usable = max(20.0, chart_bottom - chart_top)
        slot = (x1 - x0 - pad * 2) / max(1, len(rows))
        label_size = month_axis_font_size(slot)
        for index, row in enumerate(rows):
            count = int(row.get("count") or 0)
            height = max(2, usable * 0.88 * count / max_count)
            cx = x0 + pad + slot * (index + 0.5)
            color = current_month_bar_color(index, len(rows))
            bar_half = min(slot * 0.28, 18)
            self._track(self.canvas.create_rectangle(
                cx - bar_half, chart_bottom - height, cx + bar_half, chart_bottom,
                fill=color, outline="",
            ))
            self._track(self.canvas.create_text(
                cx, chart_bottom - height - 4, anchor="s", text=str(count),
                fill=INK_2, font=self._font(11, True),
            ))
            self._track(self.canvas.create_text(
                cx, chart_bottom + 10, anchor="n",
                text=format_month_axis_label(row.get("label"), row.get("key")),
                fill=INK_3 if index < len(rows) - 1 else WARN,
                font=self._font(label_size, True),
            ))

    def _draw_rivalry(self, box, rivalry):
        x0, y0, x1, y1 = box
        pad = 18
        self._track(self.canvas.create_text(
            x0 + pad, y0 + pad, anchor="nw", text="HEAD-TO-HEAD",
            fill=INK_2, font=self._font(16, True),
        ))
        if not isinstance(rivalry, dict) or not rivalry.get("a"):
            self._track(self.canvas.create_text(
                x0 + pad, y0 + 56, anchor="nw", text="Play a few rematches to fill this in",
                fill=INK_3, font=self._font(14),
            ))
            return
        a = str(rivalry.get("a") or "")
        b = str(rivalry.get("b") or "")
        a_wins = rivalry.get("aWins") or 0
        b_wins = rivalry.get("bWins") or 0
        # Stack below the title — never share the title's vertical band.
        line_y = y0 + pad + 48
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, line_y, anchor="n",
            text=f"{a}  {a_wins}  –  {b_wins}  {b}",
            fill=INK, font=self._font(20, True),
            width=max(80, int(x1 - x0 - pad * 2)),
        ))
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, line_y + 36, anchor="n",
            text="wins each (most-played pairing)",
            fill=INK_3, font=self._font(12),
        ))
        last = rivalry.get("lastWinner") or ""
        when = rivalry.get("lastPlayedAt") or ""
        when_label = ""
        if when:
            try:
                when_label = datetime.fromisoformat(str(when).replace("Z", "+00:00")).strftime("%b %d")
            except ValueError:
                when_label = str(when)[:10]
        line = f"Last win: {last}" if last else "Last win: —"
        if when_label:
            line = f"{line} · {when_label}"
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, min(y1 - 22, line_y + 62), anchor="n",
            text=line, fill=INK_2, font=self._font(13),
        ))

    def _draw_records(self, box, records):
        x0, y0, x1, y1 = box
        pad = 22
        self._track(self.canvas.create_text(
            x0 + pad, y0 + pad, anchor="nw", text="HOUSE RECORDS",
            fill=INK_2, font=self._font(16, True),
        ))
        records = records or {}
        best = records.get("bestMatchAverage") or {}
        hi = records.get("highestCheckout") or {}
        total180 = records.get("total180s")
        if total180 is None:
            total180 = 0
        avg_v = format_record_average(best.get("value"))
        avg_who = best.get("player") or ""
        hi_v = hi.get("value")
        hi_who = hi.get("player") or ""
        hi_s = str(int(hi_v)) if isinstance(hi_v, (int, float)) and hi_v else "—"
        lines = [
            (f"Best match average  {avg_v}" + (f"  ·  {avg_who}" if avg_who else ""), INK),
            (f"Highest checkout    {hi_s}" + (f"  ·  {hi_who}" if hi_who else ""), INK),
            (f"Total 180 scores    {int(total180)}", WARN),
        ]
        y = y0 + 56
        for line, color in lines:
            self._track(self.canvas.create_text(
                x0 + pad, y, anchor="nw", text=line,
                fill=color, font=self._font(16, True),
            ))
            y += 40

    # --- Match ----------------------------------------------------------------

    def _render_match(self, payload: dict):
        match = (payload or {}).get("match") or {}
        status = str(match.get("status") or "live").lower()
        finished = status in ("finished", "final", "complete", "completed")
        timed = finished or payload.get("persistent") is False
        chip = "FINAL" if finished else "LIVE"
        self._paint_header(status_chip=chip)

        players = list(match.get("players") or [])
        show_strip = should_show_turn_strip(match, finished=finished)
        screen_w, screen_h = self._screen()
        boxes = layout_match(
            screen_w, screen_h,
            timed=timed,
            player_count=len(players) or 2,
            finished=finished,
            show_strip=show_strip,
        )
        u = boxes["chrome"].u

        settings = str(match.get("settingsLine") or match.get("variant") or "")
        duration = format_duration_sec(match.get("durationSec"))
        settings_text = settings
        if duration:
            settings_text = f"{settings}   ·   {duration}" if settings else duration
        sx0, sy0, sx1, sy1 = boxes["settings"]
        self._track(self.canvas.create_text(
            (sx0 + sx1) / 2, (sy0 + sy1) / 2, text=settings_text,
            fill=INK_2, font=self._font(18, True),
        ))

        if boxes.get("result"):
            self._draw_final_banner(boxes, match, players)

        if boxes.get("portrait"):
            self._draw_scores_row(
                boxes["scores"], match, players, final=finished,
                omit_names=bool(boxes.get("omit_score_names")),
            )
        else:
            mid = (len(players) + 1) // 2
            self._draw_scores_column(boxes["scores_left"], match, players[:mid], 0, final=finished)
            self._draw_scores_column(boxes["scores_right"], match, players[mid:], mid, final=finished)

        bx0, by0, bx1, by1 = boxes["board"]
        # Final card may overlay hit-maps instead of the live board when present.
        hit_rows = normalize_hit_map(match.get("hitMap"), players) if finished else []
        if finished and hit_rows:
            self._draw_hit_maps(boxes["board"], hit_rows)
        else:
            side = min(bx1 - bx0, by1 - by0) * 0.92
            cx = (bx0 + bx1) / 2
            cy = (by0 + by1) / 2
            outer = side / (2 * R_SURROUND)
            draw_dartboard(self.canvas, cx, cy, outer, track=self._track, show_numbers=True)
            if not finished:
                self._draw_turn_markers(match, cx, cy, outer)

        if show_strip and boxes.get("strip"):
            game_shot = format_game_shot(match.get("gameShot")) if finished else ""
            self._draw_turn_strip(
                boxes["strip"],
                match.get("turn") or {},
                u=u,
                caption=game_shot or None,
            )

    def _draw_final_banner(self, boxes, match, players):
        """Winner / legs result — crown sits left of the scoreline with a gap."""
        box = boxes.get("result")
        if not box:
            return
        x0, y0, x1, y1 = box
        winner = next((p for p in players if p.get("isWinner")), None)
        if not winner and players:
            best_legs = max(int(p.get("legs") or 0) for p in players)
            if best_legs > 0:
                winner = max(players, key=lambda p: p.get("legs") or 0)
        label = format_final_scoreline(players)
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        # Shrink type when many names share the banner.
        font_size = 28 if len(players) <= 2 else (22 if len(players) <= 4 else 18)
        font = self._font(font_size, True)
        text_id = self._track(self.canvas.create_text(
            cx, cy, text=label,
            fill=WARN if winner else INK, font=font,
            width=max(80, int(x1 - x0 - 48)),
        ))
        if winner:
            bbox = self.canvas.bbox(text_id)
            if bbox:
                crown_size = 16 if len(players) <= 2 else 13
                gap = 12
                # Place crown fully left of the scoreline (never over the name).
                draw_crown(
                    self.canvas,
                    bbox[0] - gap - crown_size * 0.55,
                    cy,
                    crown_size,
                    track=self._track,
                )

    def _leg_leader_indices(self, players: list) -> set[int]:
        if not players:
            return set()
        best = max(int(p.get("legs") or 0) for p in players)
        if best <= 0:
            return set()
        return {i for i, p in enumerate(players) if int(p.get("legs") or 0) == best}

    def _draw_scores_row(self, box, match, players, *, final: bool = False, omit_names: bool = False):
        x0, y0, x1, y1 = box
        n = max(1, len(players))
        width = (x1 - x0) / n
        thrower = match.get("currentPlayerIndex")
        leaders = self._leg_leader_indices(players)
        for index, player in enumerate(players):
            px0 = x0 + width * index
            px1 = px0 + width
            active = (not final) and thrower == index
            if active:
                self._track(self.canvas.create_rectangle(
                    px0 + 4, y0 + 4, px1 - 4, y1 - 4,
                    fill="#12263A", outline=ACCENT, width=3,
                ))
            self._draw_player_block(
                px0, y0, px1, y1, player,
                thrower=active, crown=index in leaders, compact=n > 2, final=final,
                omit_name=omit_names,
            )

    def _draw_scores_column(self, box, match, players, index_offset: int, *, final: bool = False):
        x0, y0, x1, y1 = box
        if not players:
            return
        height = (y1 - y0) / len(players)
        thrower = match.get("currentPlayerIndex")
        all_players = (self._payload or {}).get("match", {}).get("players") or players
        leaders = self._leg_leader_indices(all_players)
        for local_i, player in enumerate(players):
            index = index_offset + local_i
            py0 = y0 + height * local_i
            py1 = py0 + height
            active = (not final) and thrower == index
            if active:
                self._track(self.canvas.create_rectangle(
                    x0 + 4, py0 + 4, x1 - 4, py1 - 4,
                    fill="#12263A", outline=ACCENT, width=3,
                ))
            self._draw_player_block(
                x0, py0, x1, py1, player,
                thrower=active, crown=index in leaders,
                compact=len(players) > 1, final=final,
            )

    def _draw_player_block(self, x0, y0, x1, y1, player, *, thrower, crown, compact, final=False,
                           omit_name=False):
        cx = (x0 + x1) / 2
        col_w = max(80.0, x1 - x0)
        col_h = max(80.0, y1 - y0)
        name = str(player.get("name") or "—")
        prefix = "▶ " if thrower else ""
        show_name = not omit_name
        # Names are width-capped — tall side columns must not inflate type.
        name_size = fit_player_name_size(f"{prefix}{name}", col_w, compact=compact)
        score_size = int(min(64 if not compact else 40, max(28, min(col_w * 0.42, col_h * (0.34 if omit_name else 0.26)))))
        legs_size = int(min(18, max(12, col_h * 0.07)))
        if show_name:
            name_y = y0 + col_h * (0.14 if not compact else 0.16)
            self._track(self.canvas.create_text(
                cx, name_y, text=f"{prefix}{name}",
                fill=ACCENT if thrower else INK, font=self._font(name_size, True),
            ))
        if final:
            # Final card: legs are the headline number; remaining score is stale.
            headline = player.get("legs")
            headline_label = "legs won"
        else:
            headline = player.get("score")
            headline_label = None
        score_y = y0 + col_h * (0.38 if omit_name else (0.48 if not compact else 0.52))
        self._track(self.canvas.create_text(
            cx, score_y, text=str(headline if headline is not None else "—"),
            fill=INK, font=self._font(score_size, True),
        ))
        legs = player.get("legs")
        legs_y = y0 + col_h * (0.68 if omit_name else 0.72)
        legs_text = headline_label or f"legs {legs if legs is not None else 0}"
        if final:
            legs_text = f"legs {legs if legs is not None else 0}"
        legs_font = self._font(legs_size, True)
        legs_id = self._track(self.canvas.create_text(
            cx, legs_y,
            text=legs_text,
            fill=WARN if crown else INK_2, font=legs_font,
        ))
        if crown:
            bbox = self.canvas.bbox(legs_id)
            if bbox:
                crown_size = max(12, legs_size - 2)
                gap = 10
                draw_crown(
                    self.canvas,
                    bbox[0] - gap - crown_size * 0.55,
                    legs_y,
                    crown_size,
                    track=self._track,
                )
        avg = player.get("average")
        last = player.get("lastTurnPoints")
        bits = []
        if isinstance(avg, (int, float)):
            bits.append(f"avg {avg:.1f}")
        if last is not None and not final:
            bits.append(f"last {last}")
        if bits and (omit_name or not compact):
            self._track(self.canvas.create_text(
                cx, y0 + col_h * (0.88 if omit_name else 0.88), text=" · ".join(bits),
                fill=INK_3, font=self._font(max(12, int(legs_size * 0.85))),
            ))

    def _draw_turn_markers(self, match: dict, cx: float, cy: float, outer_px: float):
        turn = match.get("turn") or {}
        prev = match.get("prevTurn") or {}
        if should_show_ghosts(turn):
            for dart in prev.get("darts") or []:
                if not isinstance(dart, dict):
                    continue
                xy = dart_board_xy(dart)
                if xy is None:
                    continue
                px, py = map_coords_to_px(xy[0], xy[1], cx, cy, outer_px)
                if is_miss_dart(dart):
                    draw_dart_marker(self.canvas, px, py, kind="miss", scale=0.85, track=self._track)
                elif is_bouncer_dart(dart):
                    draw_dart_marker(self.canvas, px, py, kind="bouncer", scale=0.85, track=self._track)
                else:
                    draw_dart_marker(self.canvas, px, py, kind="ghost", scale=0.9, track=self._track)
        for index, dart in enumerate(turn.get("darts") or []):
            if not isinstance(dart, dict):
                continue
            xy = dart_board_xy(dart)
            if xy is None:
                continue
            px, py = map_coords_to_px(xy[0], xy[1], cx, cy, outer_px)
            if is_miss_dart(dart):
                draw_dart_marker(self.canvas, px, py, kind="miss", index=index + 1, track=self._track)
            elif is_bouncer_dart(dart):
                draw_dart_marker(self.canvas, px, py, kind="bouncer", index=index + 1, track=self._track)
            else:
                draw_dart_marker(self.canvas, px, py, kind="normal", index=index + 1, track=self._track)

    def _draw_turn_strip(self, box, turn: dict, *, u: float, caption: str | None = None):
        x0, y0, x1, y1 = box
        busted = bool(turn.get("busted"))
        fill = "#3f1220" if busted else FILL
        outline = ALERT if busted else LINE
        self._track(self.canvas.create_rectangle(x0, y0, x1, y1, fill=fill, outline=outline, width=2))
        has_darts = turn_has_content(turn)
        # Game-shot only (no last-turn darts): one centered line, no empty — boxes.
        if caption and not has_darts:
            self._track(self.canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, text=caption,
                fill=WARN, font=self._font(22, True),
            ))
            return
        # Caption sits in its own top band so it never overlaps the dart slots.
        content_top = y0
        if caption:
            caption_band = max(22 * u, 28)
            self._track(self.canvas.create_text(
                (x0 + x1) / 2, y0 + caption_band / 2, text=caption,
                fill=INK_3, font=self._font(13, True),
            ))
            content_top = y0 + caption_band
        darts = list(turn.get("darts") or [None, None, None])
        while len(darts) < 3:
            darts.append(None)
        darts = darts[:3]
        slot_w = min(160 * u, (x1 - x0 - 200 * u) / 3)
        start_x = x0 + 24 * u
        cy = (content_top + y1) / 2
        slot_half = min(28 * u, max(16 * u, (y1 - content_top) * 0.38))
        for index, dart in enumerate(darts):
            sx = start_x + index * (slot_w + 12 * u)
            label = "—"
            if isinstance(dart, dict):
                label = str(dart.get("seg") or dart.get("segment") or "—")
            self._track(self.canvas.create_rectangle(
                sx, cy - slot_half, sx + slot_w, cy + slot_half,
                fill=BG, outline=ALERT if busted else ACCENT, width=2,
            ))
            self._track(self.canvas.create_text(
                sx + slot_w / 2, cy, text=label,
                fill=INK, font=self._font(20, True),
            ))
        points = turn.get("points")
        right = f"BUST" if busted else f"= {points if points is not None else 0}"
        self._track(self.canvas.create_text(
            x1 - 28 * u, cy, anchor="e", text=right,
            fill=ALERT if busted else INK, font=self._font(28, True),
        ))

    def _draw_hit_maps(self, box, rows: list):
        x0, y0, x1, y1 = box
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, y0 + 8, anchor="n", text="MATCH HIT-MAP",
            fill=INK_2, font=self._font(14, True),
        ))
        n = max(1, len(rows))
        width = (x1 - x0) / n
        for index, row in enumerate(rows):
            cx = x0 + width * (index + 0.5)
            cy = (y0 + y1) / 2 + 10
            side = min(width * 0.85, (y1 - y0) * 0.7)
            outer = side / (2 * R_SURROUND)
            draw_dartboard(
                self.canvas, cx, cy - 12, outer,
                track=self._track, show_numbers=False,
            )
            for dart in row.get("darts") or []:
                px, py = map_coords_to_px(dart["x"], dart["y"], cx, cy - 12, outer)
                draw_dart_marker(self.canvas, px, py, kind="ghost", scale=0.7, track=self._track)
            self._track(self.canvas.create_text(
                cx, y1 - 18, anchor="s", text=str(row.get("name") or ""),
                fill=INK_2, font=self._font(13, True),
            ))
