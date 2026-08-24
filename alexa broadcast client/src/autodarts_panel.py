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
    BG_DEEP,
    CARD_HI,
    CARD_LO,
    EDGE_SOFT,
    FILL,
    GOOD,
    INK,
    INK_2,
    INK_3,
    LINE,
    MEDALS,
    PLATE_ACCENT,
    PLATE_GOLD,
    PX_PER_POINT,
    TRACK,
    WARN,
    design_u,
    letterspace,
    measure_px_per_point,
    mix,
    page_chrome,
    paint_backdrop,
    paint_bar,
    paint_card,
    paint_column,
    paint_meter,
    paint_round_rect,
    paint_section_title,
    plate_for,
    stack_rows,
    text_line_h,
    text_measurer,
)
from src.display_panels import BasePanel
from src.page_header import paint_page_header
from src.roll_credits_panel import format_month_axis_label, month_axis_font_size, months_chart_geom

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


def segment_accent(seg) -> str:
    """Chip colour by segment family — trebles green, doubles gold, misses grey."""
    kind, _number = parse_segment(seg)
    if kind == "treble":
        return GOOD
    if kind == "double":
        return WARN
    if kind in ("bull", "outer_bull"):
        return ALERT
    if kind in ("miss", "unknown"):
        return INK_3
    return ACCENT


def _is_big_turn(points) -> bool:
    return isinstance(points, (int, float)) and float(points) >= 100


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
        # Win % is painted as a meter beside the row, so it is dropped here.
        return f"{wins}–{losses}  ·  Avg {avg_s}  ·  Out {hi_s}  ·  180×{one80}"
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


def board_info_row_ys(
    box_h: float, pad: float = 18, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Vertical anchors inside the YOUR BOARD tile — keep meta clear of stats."""
    height = max(160.0, float(box_h))
    pad_px = pad * u
    stack = stack_rows(
        [("title", 13, 6), ("name", 21, 4), ("meta", 12, 10), ("value", 19, 2), ("label", 11, 0)],
        top=pad_px, available=height - pad_px * 2, u=u, px_per_pt=px_per_pt,
    )
    ys = dict(stack["y"])
    # Stats hug the bottom edge; the header keeps the top.
    drop = max(0.0, height - pad_px - stack["bottom"])
    ys["value"] += drop
    ys["label"] += drop
    return {
        "title": ys["title"],
        "name": ys["name"],
        "meta": ys["meta"],
        "value": ys["value"],
        "label": ys["label"],
        "heights": stack["h"],
        "font_scale": stack["font_scale"],
        "meta_clear_of_value": ys["value"] >= ys["meta"] + stack["h"]["meta"] - 0.5,
        "fits": stack["fits"] and ys["label"] + stack["h"]["label"] <= height - pad_px * 0.5 + 0.5,
    }


def totals_row_ys(
    box_h: float, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT, pad: float = 10,
) -> dict:
    """Big number over its caption, vertically centred in the totals strip."""
    height = max(60.0, float(box_h))
    stack = stack_rows(
        [("value", 30, 4), ("label", 12, 0)],
        top=0.0, available=height - pad * u * 2, u=u, px_per_pt=px_per_pt,
    )
    top = max(pad * u, (height - stack["bottom"]) / 2)
    return {
        "value": top + stack["y"]["value"],
        "label": top + stack["y"]["label"],
        "heights": stack["h"],
        "font_scale": stack["font_scale"],
        "fits": top + stack["bottom"] <= height + 0.5,
    }


def records_chip_ys(
    box_h: float,
    *,
    pad: float = 20,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> dict:
    """HOUSE RECORDS as side-by-side chips: value over label over holder."""
    height = max(100.0, float(box_h))
    pad_px = pad * u
    stack = stack_rows(
        [("title", 14, 14), ("value", 26, 3), ("label", 11, 3), ("who", 12, 0)],
        top=pad_px, available=height - pad_px * 2, u=u, px_per_pt=px_per_pt,
    )
    ys = stack["y"]
    chip_top = ys["value"] - 12 * u
    chip_bottom = min(height - pad_px * 0.5, ys["who"] + stack["h"]["who"] + 10 * u)
    return {
        "title": ys["title"],
        "value": ys["value"],
        "label": ys["label"],
        "who": ys["who"],
        "chip": (chip_top, chip_bottom),
        "heights": stack["h"],
        "font_scale": stack["font_scale"],
        "fits": stack["fits"] and ys["who"] + stack["h"]["who"] <= height - pad_px * 0.5 + 0.5,
    }


STATUS_OK = BAND_GREEN


def board_status_chip(online, status_label) -> tuple[str, str]:
    """Wall chip: Running / Stopped / Offline only — never raw BM 'Error'."""
    raw = str(status_label or "").strip()
    key = raw.lower()
    if key in ("error", "failed", "fault", "starting", "connecting", "unknown"):
        if online is False:
            return "Offline", ALERT
        return "Stopped", INK_3
    if key == "running":
        return "Running", STATUS_OK
    if key in ("online", "connected"):
        return raw.title() if raw else "Running", STATUS_OK
    if key in ("offline", "disconnected") or online is False:
        return "Offline", ALERT
    if key in ("stopped", "idle"):
        return "Stopped", INK_3
    if not raw:
        if online is True:
            return "Running", STATUS_OK
        return "", INK_3
    if online is True:
        return "Stopped", INK_3
    return raw, INK_3


def format_rivalry_footer(rivalry: dict) -> str:
    last = (rivalry or {}).get("lastWinner") or ""
    when = (rivalry or {}).get("lastPlayedAt") or ""
    when_label = ""
    if when:
        try:
            when_label = datetime.fromisoformat(str(when).replace("Z", "+00:00")).strftime("%b %d")
        except ValueError:
            when_label = str(when)[:10]
    line = f"Last win: {last}" if last else "Last win: —"
    if when_label:
        line = f"{line} · {when_label}"
    return line


def rivalry_score_parts(rivalry) -> dict | None:
    """Three columns — never one wrapping string (Tk stacks wrapped lines)."""
    if not isinstance(rivalry, dict) or not rivalry.get("a"):
        return None
    try:
        a_wins = int(rivalry.get("aWins") or 0)
        b_wins = int(rivalry.get("bWins") or 0)
    except (TypeError, ValueError):
        a_wins, b_wins = 0, 0
    return {
        "left": str(rivalry.get("a") or ""),
        "score": f"{a_wins} – {b_wins}",
        "right": str(rivalry.get("b") or ""),
        "caption": "wins each (most-played pairing)",
        "footer": format_rivalry_footer(rivalry),
    }


def rivalry_row_ys(
    box_h: float, pad: float = 18, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Title / names+score / caption / last-win, measured so nothing collides."""
    height = max(120.0, float(box_h))
    stack = stack_rows(
        [("title", 14, 12), ("names", 20, 10), ("caption", 11, 6), ("footer", 12, 0)],
        top=pad * u, available=height - pad * 2 * u, u=u, px_per_pt=px_per_pt,
    )
    ys = stack["y"]
    return {
        "title": ys["title"],
        "names": ys["names"] + stack["h"]["names"] / 2,
        "names_top": ys["names"],
        "caption": ys["caption"],
        "footer": ys["footer"],
        "heights": stack["h"],
        "font_scale": stack["font_scale"],
        "stacked": ys["footer"] >= ys["caption"] + stack["h"]["caption"] - 0.5,
        "fits": stack["fits"],
    }


def leaderboard_row_ys(
    row_h: float,
    *,
    crowned: bool = False,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Name over detail, centred in the row — measured so the two never touch."""
    name_h = text_line_h(18 if crowned else 16, u=u, px_per_pt=px_per_pt)
    detail_h = text_line_h(12, u=u, px_per_pt=px_per_pt)
    gap = 2 * u
    group = name_h + gap + detail_h
    top = -group / 2
    return {
        "name_dy": top + name_h / 2,
        "detail_dy": top + name_h + gap + detail_h / 2,
        "name_h": name_h,
        "detail_h": detail_h,
        "fits": group <= float(row_h) + 0.5,
    }


def leaderboard_visible_rows(
    box_h: float,
    row_count: int,
    *,
    header: float = 52,
    footer: float = 14,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> tuple[int, float]:
    """How many two-line leaderboard rows fit without overlapping."""
    usable = max(60.0 * u, float(box_h) - header - footer)
    min_row = (
        text_line_h(18, u=u, px_per_pt=px_per_pt)
        + text_line_h(12, u=u, px_per_pt=px_per_pt)
        + 8 * u
    )
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
        totals_h = 116 * u
        board_info_h = 226 * u
        months_h = 230 * u
        rivalry_h = 196 * u
        records_h = 192 * u
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
    # The right rail is height-bound in landscape: share it out by weight so
    # HOUSE RECORDS keeps a real card instead of the leftover sliver.
    rail_h = max(360.0, (y1 - y0) - gap * 4)
    weights = (("totals", 0.115), ("board_info", 0.255), ("months", 0.195),
               ("rivalry", 0.205), ("records", 0.23))
    heights = {name: rail_h * weight for name, weight in weights}
    y = y0
    for name, _weight in weights:
        boxes[name] = (rx0, y, x1, y + heights[name])
        y += heights[name] + gap
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
        # The board is width-bound in portrait, so any height it cannot use is
        # dead space. Hand it to the score cards instead of centring a gap.
        board_needed = (x1 - x0) * 0.92
        spare = (
            (y1 - y0) - settings_h - 6 * u - strip_h - (10 * u if strip_h else 0)
            - (result_h + 8 * u if finished else 0) - 10 * u - board_needed - scores_h
        )
        if spare > 0:
            # Scores take the lion's share (a wall-sized number is the point of
            # this screen), the dart strip takes a little, the board keeps the
            # rest as breathing room rather than a void.
            grow = min(spare * 0.72, scores_h * (2.0 if players <= 2 else 1.0))
            scores_h += grow
            spare -= grow
            if strip_h and spare > 0:
                strip_h += min(spare * 0.4, 70 * u)
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
        self._scale = 1.0
        self._px_per_pt = PX_PER_POINT

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
        scaled = max(8, int(round(float(size) * float(getattr(self, "_scale", 1.0) or 1.0))))
        return ("Segoe UI", scaled, "bold" if bold else "normal")

    def _sync_metrics(self):
        """Fonts are points, boxes are px — measure the ratio for this display."""
        screen_w, screen_h = self._screen()
        self._scale = design_u(screen_w, screen_h)
        self._px_per_pt = measure_px_per_point(self.root, self._scale)

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

    def _card(self, box, *, accent=None, lift=0.0):
        return paint_card(
            self.canvas, box, u=self._scale, accent=accent, lift=lift, track=self._track,
        )

    def _title(self, x, y, text, *, size=14, fill=INK_2, accent=ACCENT, fs=1.0):
        return paint_section_title(
            self.canvas, x, y, text=text, font=self._font(size * fs, True),
            u=self._scale, fill=fill, accent=accent,
            line_h=text_line_h(size * fs, u=self._scale, px_per_pt=self._px_per_pt),
            track=self._track,
        )

    def _divider(self, x, y0, y1):
        self._track(self.canvas.create_line(x, y0, x, y1, fill=EDGE_SOFT, width=1))

    # --- Dashboard ------------------------------------------------------------

    def _render_dashboard(self, payload: dict):
        self._sync_metrics()
        screen_w, screen_h = self._screen()
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(title="AUTODARTS DASHBOARD")
        boxes = layout_dashboard(screen_w, screen_h, timed=True)
        accents = {"totals": ACCENT, "leaderboard": ACCENT, "rivalry": WARN, "records": WARN}
        for name, box in boxes.items():
            if box is None or not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box, accent=accents.get(name), lift=0.05 if name == "totals" else 0.0)
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
        u = self._scale
        pad = 18 * u
        rows = board_info_row_ys(y1 - y0, 18, u=u, px_per_pt=self._px_per_pt)
        fs = rows["font_scale"]
        name = str(board.get("name") or "No board selected")
        status, status_fill = board_status_chip(board.get("online"), board.get("statusLabel"))
        self._title(x0 + pad, y0 + rows["title"], "YOUR BOARD", size=13, fs=fs)
        self._track(self.canvas.create_text(
            x0 + pad, y0 + rows["name"], anchor="nw", text=name,
            fill=INK, font=self._font(21 * fs, True),
        ))
        if status:
            self._status_pill(
                x1 - pad, y0 + rows["name"] + rows["heights"]["name"] / 2, status, status_fill,
                fs=fs,
            )
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
            text="  ·  ".join(meta_bits),
            fill=INK_3, font=self._font(12 * fs),
        ))
        darts = board.get("dartsThrown")
        corrections = board.get("corrections")
        accuracy = board.get("accuracy")
        good_accuracy = isinstance(accuracy, (int, float)) and accuracy >= 97
        cells = [
            (f"{int(darts):,}" if isinstance(darts, (int, float)) else "—", "DARTS", INK),
            (
                f"{int(corrections):,}" if isinstance(corrections, (int, float)) else "—",
                "CORRECTIONS", INK,
            ),
            (
                f"{accuracy:.2f}%" if isinstance(accuracy, (int, float)) else "—",
                "ACCURACY", GOOD if good_accuracy else INK,
            ),
        ]
        cell_w = (x1 - x0 - pad * 2) / len(cells)
        stats_top = y0 + rows["value"] - 10 * u
        stats_bottom = y0 + rows["label"] + rows["heights"]["label"] + 2 * u
        for index, (value, label, fill) in enumerate(cells):
            cx = x0 + pad + cell_w * (index + 0.5)
            if index:
                self._divider(x0 + pad + cell_w * index, stats_top, stats_bottom)
            self._track(self.canvas.create_text(
                cx, y0 + rows["value"], anchor="n", text=str(value),
                fill=fill, font=self._font(19 * fs, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + rows["label"], anchor="n", text=letterspace(label),
                fill=INK_3, font=self._font(11 * fs, True),
            ))

    def _status_pill(self, right_x, cy, text, color, *, fs=1.0):
        """Board state as a tinted pill with a lit dot — never a bare word."""
        u = self._scale
        font = self._font(14 * fs, True)
        measure = text_measurer(self.root, font)
        text_w = max(30.0, measure(text))
        dot_r = 4 * u
        pad_x = 14 * u
        height = text_line_h(14 * fs, u=u, px_per_pt=self._px_per_pt) + 8 * u
        width = text_w + pad_x * 2 + dot_r * 2 + 8 * u
        left = right_x - width
        paint_bar(
            self.canvas, (left, cy - height / 2, right_x, cy + height / 2),
            fill=mix(CARD_HI, color, 0.22), outline="", track=self._track,
        )
        paint_bar(
            self.canvas, (left, cy - height / 2, right_x, cy + height / 2),
            fill="", outline=mix(EDGE_SOFT, color, 0.55), track=self._track,
        )
        dot_cx = left + pad_x
        self._track(self.canvas.create_oval(
            dot_cx - dot_r, cy - dot_r, dot_cx + dot_r, cy + dot_r, fill=color, outline="",
        ))
        self._track(self.canvas.create_text(
            dot_cx + dot_r + 8 * u, cy, anchor="w", text=text, fill=color, font=font,
        ))

    def _draw_totals(self, box, totals: dict):
        x0, y0, x1, y1 = box
        u = self._scale
        last = format_last_played_label(totals)
        cells = [
            (totals.get("matches") or 0, "MATCHES", INK),
            (totals.get("legs") or 0, "LEGS", INK),
            (totals.get("thisMonth") or 0, "THIS MONTH", ACCENT),
            (last, "LAST PLAYED", WARN),
        ]
        rows = totals_row_ys(y1 - y0, u=u, px_per_pt=self._px_per_pt)
        fs = rows["font_scale"]
        width = (x1 - x0) / len(cells)
        for index, (value, label, fill) in enumerate(cells):
            x = x0 + width * (index + 0.5)
            if index:
                self._divider(x0 + width * index, y0 + 18 * u, y1 - 18 * u)
            value_size = 22 if isinstance(value, str) and len(str(value)) > 6 else 30
            self._track(self.canvas.create_text(
                x, y0 + rows["value"], anchor="n", text=str(value),
                fill=fill, font=self._font(value_size * fs, True),
            ))
            self._track(self.canvas.create_text(
                x, y0 + rows["label"], anchor="n", text=letterspace(label),
                fill=INK_3, font=self._font(11 * fs, True),
            ))

    def _draw_leaderboard(self, box, rows: list, more_count: int):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 18 * u
        title_h = text_line_h(15, u=u, px_per_pt=self._px_per_pt)
        self._title(x0 + pad, y0 + pad, "BOARD LEADERBOARD", size=15)
        if not rows:
            self._track(self.canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, text="No matches yet",
                fill=INK_3, font=self._font(18),
            ))
            return
        header = pad + title_h + 14 * u
        footer_h = text_line_h(13, u=u, px_per_pt=self._px_per_pt) + 12 * u
        footer = footer_h if more_count else 12 * u
        visible_n, row_h = leaderboard_visible_rows(
            y1 - y0, len(rows), header=header, footer=footer, u=u, px_per_pt=self._px_per_pt,
        )
        visible = list(rows)[:visible_n]
        top = y0 + header
        chip_w = 36 * u
        rank_x = x0 + pad
        name_x = rank_x + chip_w + 16 * u
        pct_x = x1 - pad
        bar_w = min(190 * u, (x1 - x0) * 0.2)
        bar_x1 = pct_x - 62 * u
        bar_x0 = bar_x1 - bar_w
        detail_w = max(120 * u, bar_x0 - 20 * u - name_x)
        for index, row in enumerate(visible):
            cy = top + row_h * (index + 0.5)
            rank = int(row.get("rank") or (index + 1))
            name = str(row.get("name") or "—")
            crowned = bool(row.get("crown")) or index == 0
            plate = (x0 + 10 * u, cy - row_h * 0.44, x1 - 10 * u, cy + row_h * 0.44)
            if crowned:
                paint_round_rect(
                    self.canvas, plate, radius=10 * u,
                    fill=PLATE_GOLD, outline=mix(PLATE_GOLD, WARN, 0.35),
                    track=self._track,
                )
                paint_bar(
                    self.canvas,
                    (plate[0], plate[1] + 6 * u, plate[0] + 4 * u, plate[3] - 6 * u),
                    fill=WARN, track=self._track,
                )
            elif index:
                self._track(self.canvas.create_line(
                    x0 + pad, cy - row_h / 2, x1 - pad, cy - row_h / 2,
                    fill=EDGE_SOFT, width=1,
                ))
            name_fill = WARN if crowned else INK
            name_size = 18 if crowned else 16
            geom = leaderboard_row_ys(
                row_h, crowned=crowned, u=u, px_per_pt=self._px_per_pt,
            )
            name_y = cy + geom["name_dy"]
            detail_y = cy + geom["detail_dy"]
            self._rank_chip(rank_x, cy, chip_w, min(chip_w, row_h * 0.62), rank)
            self._track(self.canvas.create_text(
                name_x, name_y, anchor="w", text=name,
                fill=name_fill, font=self._font(name_size, True),
            ))
            self._track(self.canvas.create_text(
                name_x, detail_y, anchor="w",
                text=self._fit_leaderboard_detail(row, detail_w),
                fill=INK_2, font=self._font(12),
            ))
            self._win_meter(bar_x0, bar_x1, pct_x, cy, row, crowned=crowned)
        hidden = max(0, len(rows) - visible_n) + max(0, int(more_count or 0))
        if hidden > 0:
            self._track(self.canvas.create_text(
                x0 + pad, y1 - 12 * u, anchor="sw",
                text=f"+ {hidden} more players",
                fill=INK_3, font=self._font(13, True),
            ))

    def _rank_chip(self, x, cy, width, height, rank: int):
        """Rank in a chip — medal-toned for the podium, quiet slate below it."""
        u = self._scale
        podium = MEDALS[rank - 1] if 1 <= rank <= 3 else None
        box = (x, cy - height / 2, x + width, cy + height / 2)
        paint_round_rect(
            self.canvas, box, radius=8 * u,
            fill=podium or TRACK,
            outline="" if podium else EDGE_SOFT,
            track=self._track,
        )
        self._track(self.canvas.create_text(
            x + width / 2, cy, text=str(rank),
            fill=BG if podium else INK_2,
            font=self._font(15 if podium else 14, True),
        ))

    def _win_meter(self, bar_x0, bar_x1, pct_x, cy, row, *, crowned=False):
        """Win share as a bar + percentage — readable from across the room."""
        u = self._scale
        wins = int(row.get("wins") or 0)
        losses = int(row.get("losses") or 0)
        played = wins + losses
        pct = row.get("winPct")
        share = (wins / played) if played else 0.0
        if not isinstance(pct, (int, float)):
            pct = share * 100
        height = 9 * u
        # Thin samples get a muted bar so a lone 1–0 cannot out-shout a real run.
        color = WARN if crowned else ACCENT
        if played < 3:
            color = mix(color, TRACK, 0.55)
        paint_meter(
            self.canvas, (bar_x0, cy - height / 2, bar_x1, cy + height / 2),
            share, color, track=self._track,
        )
        self._track(self.canvas.create_text(
            pct_x, cy, anchor="e", text=f"{pct:.0f}%",
            fill=INK if played >= 3 else INK_3, font=self._font(13, True),
        ))

    def _fit_leaderboard_detail(self, row, available_px):
        """Full stat line when it measures short enough, compact otherwise."""
        measure = text_measurer(self.root, self._font(12))
        full = format_leaderboard_detail(row, compact=False)
        if measure(full) <= max(40.0, available_px):
            return full
        return format_leaderboard_detail(row, compact=True)

    def _draw_months(self, box, months: list):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        geom = months_chart_geom(y1 - y0, 20, u=u, px_per_pt=self._px_per_pt)
        self._title(x0 + pad, y0 + geom["title_y"], "MATCHES PER MONTH", size=14)
        rows = list(months)[-12:]
        if not rows:
            return
        max_count = max([int(row.get("count") or 0) for row in rows] or [1]) or 1
        chart_top = y0 + geom["chart_top"]
        chart_bottom = y0 + geom["chart_bottom"]
        usable = max(20.0, chart_bottom - chart_top)
        slot = (x1 - x0 - pad * 2) / max(1, len(rows))
        label_size = month_axis_font_size(slot / max(0.05, u))
        self._track(self.canvas.create_line(
            x0 + pad, chart_bottom, x1 - pad, chart_bottom, fill=EDGE_SOFT, width=max(1, u),
        ))
        for index, row in enumerate(rows):
            count = int(row.get("count") or 0)
            current = index == len(rows) - 1
            cx = x0 + pad + slot * (index + 0.5)
            color = current_month_bar_color(index, len(rows))
            bar_half = min(slot * 0.3, 20 * u)
            # Empty column track shows the scale even in a quiet month.
            paint_bar(
                self.canvas,
                (cx - bar_half, chart_top, cx + bar_half, chart_bottom),
                radius=bar_half * 0.5, fill=mix(TRACK, CARD_HI, 0.35), track=self._track,
            )
            height = 0.0
            if count > 0:
                height = max(6 * u, usable * 0.9 * count / max_count)
                paint_column(
                    self.canvas, cx, chart_bottom, bar_half, height, color,
                    u=u, track=self._track,
                )
            count_y = min(chart_bottom - height - 4 * u, y0 + geom["count_y"])
            count_y = max(count_y, y0 + geom["title_bottom"] + 2 * u)
            self._track(self.canvas.create_text(
                cx, count_y, anchor="s", text=str(count),
                fill=(WARN if current else INK) if count else INK_3,
                font=self._font(11, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + geom["axis_y"], anchor="n",
                text=format_month_axis_label(row.get("label"), row.get("key")),
                fill=WARN if current else INK_3,
                font=self._font(label_size, True),
            ))

    def _draw_rivalry(self, box, rivalry):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 18 * u
        rows = rivalry_row_ys(y1 - y0, 18, u=u, px_per_pt=self._px_per_pt)
        fs = rows["font_scale"]
        self._title(x0 + pad, y0 + rows["title"], "HEAD-TO-HEAD", size=14, accent=WARN)
        parts = rivalry_score_parts(rivalry)
        if not parts:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + rows["names_top"], anchor="nw",
                text="Play a few rematches to fill this in",
                fill=INK_3, font=self._font(14),
            ))
            return
        mid = (x0 + x1) / 2
        name_y = y0 + rows["names"]
        score_h = rows["heights"]["names"]
        self._score_pill(mid, name_y, score_h, parts["score"], fs=fs)
        # Name colours match their half of the share bar below.
        self._track(self.canvas.create_text(
            x0 + pad, name_y, anchor="w", text=parts["left"],
            fill=ACCENT, font=self._font(19 * fs, True),
        ))
        self._track(self.canvas.create_text(
            x1 - pad, name_y, anchor="e", text=parts["right"],
            fill=WARN, font=self._font(19 * fs, True),
        ))
        # Win share as one two-tone bar — the numbers alone read as a tie.
        bar_h = max(8 * u, rows["heights"]["caption"] * 0.5)
        bar_cy = y0 + rows["caption"] + rows["heights"]["caption"] / 2
        self._share_bar(
            (x0 + pad, bar_cy - bar_h / 2, x1 - pad, bar_cy + bar_h / 2),
            rivalry.get("aWins") or 0, rivalry.get("bWins") or 0,
        )
        self._track(self.canvas.create_text(
            mid, y0 + rows["footer"], anchor="n",
            text=f"{parts['caption']}  ·  {parts['footer']}",
            fill=INK_3, font=self._font(12 * fs),
        ))

    def _score_pill(self, cx, cy, height, text, *, fs=1.0):
        u = self._scale
        font = self._font(20 * fs, True)
        measure = text_measurer(self.root, font)
        width = max(90 * u, measure(text) + 40 * u)
        box = (cx - width / 2, cy - height * 0.62, cx + width / 2, cy + height * 0.62)
        paint_bar(self.canvas, box, fill=PLATE_GOLD, track=self._track)
        paint_bar(self.canvas, box, fill="", outline=mix(PLATE_GOLD, WARN, 0.4), track=self._track)
        self._track(self.canvas.create_text(cx, cy, text=text, fill=WARN, font=font))

    def _share_bar(self, box, left_value, right_value):
        x0, y0, x1, y1 = box
        total = max(0, int(left_value or 0)) + max(0, int(right_value or 0))
        paint_bar(self.canvas, box, fill=TRACK, track=self._track)
        if total <= 0:
            return
        split = x0 + (x1 - x0) * (int(left_value or 0) / total)
        radius = (y1 - y0) / 2
        if split > x0 + radius:
            paint_bar(self.canvas, (x0, y0, split, y1), fill=ACCENT, track=self._track)
        if split < x1 - radius:
            paint_bar(self.canvas, (split, y0, x1, y1), fill=WARN, track=self._track)
        self._track(self.canvas.create_line(
            split, y0 - 1, split, y1 + 1, fill=CARD_HI, width=max(2, int(round(2 * self._scale))),
        ))

    def _draw_records(self, box, records):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        records = records or {}
        best = records.get("bestMatchAverage") or {}
        hi = records.get("highestCheckout") or {}
        total180 = records.get("total180s")
        if total180 is None:
            total180 = 0
        hi_v = hi.get("value")
        chips = [
            (format_record_average(best.get("value")), "BEST MATCH AVG",
             str(best.get("player") or ""), INK),
            (str(int(hi_v)) if isinstance(hi_v, (int, float)) and hi_v else "—",
             "HIGHEST CHECKOUT", str(hi.get("player") or ""), ACCENT),
            (str(int(total180)), "180 SCORES", "", WARN),
        ]
        rows = records_chip_ys(y1 - y0, pad=20, u=u, px_per_pt=self._px_per_pt)
        fs = rows["font_scale"]
        self._title(x0 + pad, y0 + rows["title"], "HOUSE RECORDS", size=14, accent=WARN)
        chip_top, chip_bottom = rows["chip"]
        gap = 12 * u
        width = (x1 - x0 - pad * 2 - gap * (len(chips) - 1)) / len(chips)
        for index, (value, label, who, color) in enumerate(chips):
            cx0 = x0 + pad + (width + gap) * index
            paint_round_rect(
                self.canvas, (cx0, y0 + chip_top, cx0 + width, y0 + chip_bottom),
                radius=12 * u, fill=mix(CARD_LO, plate_for(color), 0.55),
                outline=mix(EDGE_SOFT, color, 0.2), track=self._track,
            )
            cx = cx0 + width / 2
            self._track(self.canvas.create_text(
                cx, y0 + rows["value"], anchor="n", text=value,
                fill=color, font=self._font(26 * fs, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + rows["label"], anchor="n", text=letterspace(label),
                fill=INK_3, font=self._font(11 * fs, True),
            ))
            if who:
                self._track(self.canvas.create_text(
                    cx, y0 + rows["who"], anchor="n", text=who,
                    fill=INK_2, font=self._font(12 * fs),
                ))

    # --- Match ----------------------------------------------------------------

    def _render_match(self, payload: dict):
        # Match type is already sized from its boxes; keep the point sizes as authored.
        self._scale = 1.0
        match = (payload or {}).get("match") or {}
        status = str(match.get("status") or "live").lower()
        finished = status in ("finished", "final", "complete", "completed")
        timed = finished or payload.get("persistent") is False
        chip = "FINAL" if finished else "LIVE"
        screen_w, screen_h = self._screen()
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(status_chip=chip)

        players = list(match.get("players") or [])
        show_strip = should_show_turn_strip(match, finished=finished)
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
        if settings_text:
            font = self._font(17, True)
            label = letterspace(settings_text)
            width = text_measurer(self.root, font)(label) + 44 * u
            cy = (sy0 + sy1) / 2
            height = min(sy1 - sy0, text_line_h(17, px_per_pt=self._px_per_pt) + 14 * u)
            mid_x = (sx0 + sx1) / 2
            paint_bar(
                self.canvas,
                (mid_x - width / 2, cy - height / 2, mid_x + width / 2, cy + height / 2),
                fill=mix(CARD_LO, ACCENT, 0.10), outline=EDGE_SOFT, track=self._track,
            )
            self._track(self.canvas.create_text(
                mid_x, cy, text=label, fill=INK_2, font=font,
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
            self._draw_board_stage(cx, cy, outer, u=u)
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

    def _draw_board_stage(self, cx, cy, outer, *, u=1.0, show_numbers=True):
        """Seat the board on the wall: cast shadow, lit rim, then the board."""
        surround = outer * R_SURROUND
        self._track(self.canvas.create_oval(
            cx - surround - 6 * u, cy - surround + 2 * u,
            cx + surround + 6 * u, cy + surround + 12 * u,
            fill=BG_DEEP, outline="",
        ))
        for step, alpha in ((10 * u, 0.30), (5 * u, 0.55)):
            self._track(self.canvas.create_oval(
                cx - surround - step, cy - surround - step,
                cx + surround + step, cy + surround + step,
                fill="", outline=mix(BG, ACCENT, alpha * 0.35), width=max(1, int(round(u))),
            ))
        radii = draw_dartboard(
            self.canvas, cx, cy, outer, track=self._track, show_numbers=show_numbers,
        )
        self._track(self.canvas.create_oval(
            cx - surround, cy - surround, cx + surround, cy + surround,
            fill="", outline=mix(SURROUND, INK, 0.22), width=max(1, int(round(2 * u))),
        ))
        return radii

    def _draw_final_banner(self, boxes, match, players):
        """Winner / legs result — crown sits left of the scoreline with a gap."""
        box = boxes.get("result")
        if not box:
            return
        x0, y0, x1, y1 = box
        u = boxes["chrome"].u
        winner = next((p for p in players if p.get("isWinner")), None)
        if not winner and players:
            best_legs = max(int(p.get("legs") or 0) for p in players)
            if best_legs > 0:
                winner = max(players, key=lambda p: p.get("legs") or 0)
        label = format_final_scoreline(players)
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2
        paint_round_rect(
            self.canvas, (x0, y0, x1, y1), radius=14 * u,
            fill=PLATE_GOLD if winner else CARD_LO,
            outline=mix(PLATE_GOLD, WARN, 0.35) if winner else EDGE_SOFT,
            track=self._track,
        )
        # Shrink type when many names share the banner — and again if the band
        # itself is short (small screens scale the box, not the point size).
        font_size = 28 if len(players) <= 2 else (22 if len(players) <= 4 else 18)
        font_size = min(font_size, (y1 - y0 - 10 * u) / max(1.0, self._px_per_pt))
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

    def _player_plate(self, box, *, active: bool, winner: bool = False):
        """Every player gets a card; the thrower gets the lit one."""
        x0, y0, x1, y1 = box
        u = self._scale
        gap = 5 * u
        plate = (x0 + gap, y0 + gap, x1 - gap, y1 - gap)
        if active:
            paint_round_rect(
                self.canvas, plate, radius=14 * u, fill=PLATE_ACCENT,
                outline=ACCENT, width=max(2, 3 * u), track=self._track,
            )
        elif winner:
            paint_round_rect(
                self.canvas, plate, radius=14 * u, fill=PLATE_GOLD,
                outline=mix(PLATE_GOLD, WARN, 0.4), width=max(1, 2 * u), track=self._track,
            )
        else:
            paint_card(self.canvas, plate, u=u, radius=14 * u, track=self._track, shadow=False)
        return plate

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
            self._player_plate(
                (px0, y0, px1, y1), active=active,
                winner=bool(final and player.get("isWinner")),
            )
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
            self._player_plate(
                (x0, py0, x1, py1), active=active,
                winner=bool(final and player.get("isWinner")),
            )
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
        u = self._scale
        name = str(player.get("name") or "—")
        show_name = not omit_name
        # Names are width-capped — tall side columns must not inflate type.
        name_size = fit_player_name_size(f"** {name}", col_w, compact=compact)
        # The remaining score is the whole point of this screen, so let it grow
        # to whatever the card can carry instead of pinning it to a small size.
        score_cap = 60 if compact else 104
        score_size = int(min(score_cap, max(28, min(col_w * 0.40, col_h * 0.36))))
        legs_size = int(min(20, max(12, col_h * 0.075)))
        meta_size = max(11, int(legs_size * 0.85))
        if final:
            # Final card: legs are the headline number; remaining score is stale.
            headline = player.get("legs")
        else:
            headline = player.get("score")
        legs = player.get("legs")
        legs_text = f"legs {legs if legs is not None else 0}"
        avg = player.get("average")
        last = player.get("lastTurnPoints")
        bits = []
        if isinstance(avg, (int, float)):
            bits.append(f"avg {avg:.1f}")
        if last is not None and not final:
            bits.append(f"last {last}")
        meta_text = " · ".join(bits) if (bits and (omit_name or not compact)) else ""

        rows = []
        if show_name:
            rows.append(("name", name_size, 12))
        rows.append(("score", score_size, 10))
        rows.append(("legs", legs_size, 8))
        if meta_text:
            rows.append(("meta", meta_size, 0))
        pad = 14 * u
        stack = stack_rows(
            rows, top=y0 + pad, available=col_h - 2 * pad, u=u, px_per_pt=self._px_per_pt,
        )
        # Centre the block in the card so short stacks do not hug the top edge.
        offset = max(0.0, (col_h - 2 * pad - stack["height"]) / 2)
        scale = stack["font_scale"]

        def row_cy(key):
            return stack["y"][key] + offset + stack["h"][key] / 2

        if show_name:
            name_y = row_cy("name")
            name_id = self._track(self.canvas.create_text(
                cx, name_y, text=name,
                fill=ACCENT if thrower else INK, font=self._font(name_size * scale, True),
            ))
            if thrower:
                self._throw_marker(name_id, name_y, name_size * scale)
        self._track(self.canvas.create_text(
            cx, row_cy("score"), text=str(headline if headline is not None else "—"),
            fill=INK, font=self._font(score_size * scale, True),
        ))
        legs_y = row_cy("legs")
        legs_id = self._track(self.canvas.create_text(
            cx, legs_y, text=legs_text,
            fill=WARN if crown else INK_2, font=self._font(legs_size * scale, True),
        ))
        if crown:
            bbox = self.canvas.bbox(legs_id)
            if bbox:
                crown_size = max(12, legs_size * scale - 2)
                draw_crown(
                    self.canvas,
                    bbox[0] - 10 - crown_size * 0.55,
                    legs_y,
                    crown_size,
                    track=self._track,
                )
        if meta_text:
            self._track(self.canvas.create_text(
                cx, row_cy("meta"), text=meta_text,
                fill=INK_3, font=self._font(meta_size * scale),
            ))

    def _throw_marker(self, name_id, cy, size):
        """Drawn caret for the thrower — a ▶ glyph is not in every Tk font."""
        bbox = self.canvas.bbox(name_id)
        if not bbox:
            return
        half = max(5.0, size * 0.34)
        right = bbox[0] - half * 1.4
        self._track(self.canvas.create_polygon(
            right - half, cy - half, right - half, cy + half, right + half * 0.4, cy,
            fill=ACCENT, outline="",
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
        paint_card(
            self.canvas, box, u=u, radius=16 * u,
            accent=ALERT if busted else ACCENT, track=self._track,
        )
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
        points = turn.get("points")
        busted_label = "BUST" if busted else f"{points if points is not None else 0}"
        cy = (content_top + y1) / 2
        # Chips scale with the band so a tall strip reads from across the room.
        slot_half = min(46 * u, max(16 * u, (y1 - content_top) * 0.34))
        seg_size = int(max(15, min(34, slot_half * 1.05 / max(1.0, self._px_per_pt))))
        total_size = int(max(18, min(46, seg_size * 1.45)))
        total_font = self._font(total_size, True)
        total_w = max(96 * u, text_measurer(self.root, total_font)(busted_label) + 44 * u)
        total_x1 = x1 - 22 * u
        # Spread the dart slots across everything left of the total chip.
        lane_x0 = x0 + 22 * u
        lane_x1 = total_x1 - total_w - 20 * u
        gap = 14 * u
        slot_w = max(58 * u, (lane_x1 - lane_x0 - gap * 2) / 3)
        for index, dart in enumerate(darts):
            sx = lane_x0 + index * (slot_w + gap)
            label = "—"
            if isinstance(dart, dict):
                label = str(dart.get("seg") or dart.get("segment") or "—")
            thrown = label != "—"
            edge = ALERT if busted else segment_accent(label)
            paint_round_rect(
                self.canvas, (sx, cy - slot_half, sx + slot_w, cy + slot_half),
                radius=12 * u, fill=mix(BG, edge, 0.16 if thrown else 0.05),
                outline=edge if thrown else EDGE_SOFT,
                width=max(2, 2 * u), track=self._track,
            )
            self._track(self.canvas.create_text(
                sx + slot_w / 2, cy, text=label,
                fill=INK if thrown else INK_3, font=self._font(seg_size, True),
            ))
        color = ALERT if busted else (WARN if _is_big_turn(points) else INK)
        paint_round_rect(
            self.canvas,
            (total_x1 - total_w, cy - slot_half, total_x1, cy + slot_half),
            radius=12 * u, fill=mix(BG, color, 0.14), outline=mix(EDGE_SOFT, color, 0.5),
            width=max(2, 2 * u), track=self._track,
        )
        self._track(self.canvas.create_text(
            (total_x1 - total_w / 2), cy, text=busted_label, fill=color, font=total_font,
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
