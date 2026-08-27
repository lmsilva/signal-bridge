"""Huupe Mini overlay: live session, final card, and the career dashboard.

The hoop reports two very different shapes. Family Mode names its players and
keeps a score per person; free play knows only that a ball went in and roughly
where from. Rather than force one into the other, the body of the session page
switches: a scoreboard when there are names, a solo stat block when there are
not. Everything else — mode bar, headline, shooting breakdown, footer — is
shared, so the two read as the same page.

Both pages are laid out as a broadcast graphic: a hero plate with a shooting
dial, a half-court heat map of where the points came from, and a ticker of the
last shots. Portrait stacks those; landscape puts the court and its legend
beside the scoreboard instead of stretching one column across 1920px.
"""

import json
import math

from src.design_system import (
    ACCENT,
    ALERT,
    CARD_LO,
    EDGE,
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
    paint_backdrop,
    paint_bar,
    paint_card,
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

# A zone needs more than one attempt before its percentage means anything —
# otherwise the first make of the night is always the "hot zone" at 100%.
HOT_ZONE_MIN_ATTEMPTS = 2

# The court is darker than the card it sits on, so it reads as a floor rather
# than as another panel.
COURT_FLOOR = "#0A1424"
COURT_LINE = "#93A6C4"

# Cold blue through green and amber to hot red — the ramp every broadcast shot
# chart uses, and the reason a glance at the court tells you where the night is
# going before you have read a single number.
HEAT_STOPS = (
    (0.00, "#15223A"),
    (0.22, "#1E4E86"),
    (0.40, ACCENT),
    (0.58, GOOD),
    (0.78, WARN),
    (1.00, ALERT),
)


def heat_color(pct):
    """Colour for a shooting percentage on the cold-to-hot ramp."""
    share = max(0.0, min(1.0, (float(pct or 0)) / 100.0))
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
        rows.append({
            "zone": zone,
            "label": row.get("label") or label,
            "note": row.get("note") or note,
            "pointsLabel": row.get("pointsLabel") or points,
            "made": int(row.get("made") or 0),
            "attempts": int(row.get("attempts") or 0),
            "pct": int(row.get("pct") or 0),
        })
    return rows


def hot_zone(rows):
    """The zone worth bragging about: best percentage on a real sample."""
    ranked = [row for row in rows if row["attempts"] >= HOT_ZONE_MIN_ATTEMPTS]
    if not ranked:
        ranked = [row for row in rows if row["attempts"]]
    if not ranked:
        return None
    return sorted(ranked, key=lambda row: (row["pct"], row["attempts"]), reverse=True)[0]


def zone_heat(row):
    """Court fill for a zone — damped so the markings stay on top of it."""
    if not row["attempts"]:
        return mix(COURT_FLOOR, INK_3, 0.10)
    return mix(COURT_FLOOR, heat_color(row["pct"]), 0.64)


def arc_points(cx, cy, radius, start_deg, end_deg, *, steps=40):
    """Flat [x, y, ...] along a circular arc. 0° is straight up, +° clockwise."""
    span = float(end_deg) - float(start_deg)
    count = max(2, int(steps))
    points = []
    for index in range(count + 1):
        angle = math.radians(float(start_deg) + span * (index / count))
        points.extend((cx + radius * math.sin(angle), cy - radius * math.cos(angle)))
    return points


def court_regions(box):
    """Half-court geometry, basket at the bottom, in painting order.

    Proportions are the broadcast ones rather than survey-accurate: the paint
    and the arc have to stay legible at a quarter of this size on a phone-shaped
    card, which a true 50ft-wide court does not. Everything below half court is
    measured off the court *width*, so a taller card simply shows more floor
    behind the arc instead of stretching the key into a corridor.
    """
    x0, y0, x1, y1 = (float(value) for value in box)
    width = max(1.0, x1 - x0)
    height = max(1.0, y1 - y0)
    court_w = min(width, height / 0.86)
    court_h = min(height, court_w * 1.34)
    cx = (x0 + x1) / 2
    bottom = (y0 + y1) / 2 + court_h / 2
    top = bottom - court_h

    rim_y = bottom - 0.115 * court_w
    rim_r = 0.036 * court_w
    key_half = 0.19 * court_w
    key_top = bottom - 0.47 * court_w
    ft_r = 0.115 * court_w
    arc_r = 0.46 * court_w
    corner_x = 0.44 * court_w
    corner_y = rim_y - math.sqrt(max(0.0, arc_r ** 2 - corner_x ** 2))
    sweep = math.degrees(math.asin(min(1.0, corner_x / arc_r)))
    arc = arc_points(cx, rim_y, arc_r, -sweep, sweep)

    inside = [cx - corner_x, bottom, *arc, cx + corner_x, bottom]
    # The bottom half of the centre circle. Without it the floor behind the arc
    # reads as empty background rather than as the far end of a court.
    centre = arc_points(cx, top, ft_r, 90, 270)
    return {
        "centre": centre,
        "court": (cx - court_w / 2, top, cx + court_w / 2, bottom),
        "inside": inside,
        "arc": arc,
        "corners": (
            (cx - corner_x, bottom, cx - corner_x, corner_y),
            (cx + corner_x, bottom, cx + corner_x, corner_y),
        ),
        "key": (cx - key_half, key_top, cx + key_half, bottom),
        "ft_circle": (cx, key_top, ft_r),
        "restricted": (cx, rim_y, 0.115 * court_w),
        "rim": (cx, rim_y, rim_r),
        "backboard": (cx - 0.13 * court_w, bottom - 0.055 * court_w,
                      cx + 0.13 * court_w, bottom - 0.055 * court_w),
    }


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
        return paint_card(
            self.canvas, box, u=self._scale, accent=accent, lift=lift, track=self._track,
        )

    def _title(self, x, y, text, *, size=14, fill=INK_2, accent=ACCENT):
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
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(status_chip="FINAL" if finished else "LIVE")

        boxes = layout_huupe_session(
            screen_w, screen_h, timed=timed, finished=finished, players=len(players),
        )
        accents = {
            "hero": WARN if finished else ACCENT,
            "body": ACCENT,
            "tiles": ACCENT,
            "court": ACCENT,
            "zones": ACCENT,
            "ticker": WARN if finished else GOOD,
        }
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4 or name == "mode":
                continue
            self._card(box, accent=accents.get(name), lift=0.05 if name == "hero" else 0.0)

        stats = session.get("stats") or {}
        self._draw_mode(boxes["mode"], session)
        self._draw_hero(boxes["hero"], session, finished=finished)
        if "body" in boxes:
            self._draw_scoreboard(boxes["body"], players, finished=finished)
        self._draw_tiles(boxes["tiles"], stats, titled=bool(players))
        rows = zone_rows(session.get("zones"))
        self._draw_court(boxes["court"], rows)
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

    def _draw_court(self, box, rows, *, title="SHOT CHART"):
        """Half-court heat map — the graphic that says what a zone actually is."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        self._title(x0 + pad, y0 + pad * 0.7, title)

        foot_h = self._line_h(15) + 12 * self._scale
        court_box = (
            x0 + pad * 0.5, self._head_top(box) - 8 * self._scale,
            x1 - pad * 0.5, y1 - pad * 0.8 - foot_h,
        )
        by_zone = {row["zone"]: row for row in rows}
        geo = court_regions(court_box)
        line = COURT_LINE
        hair = max(1, int(round(1.8 * self._scale)))

        # Painted outside-in: the deep zone is the floor everything else sits on.
        paint_round_rect(
            self.canvas, geo["court"], radius=10 * self._scale,
            fill=zone_heat(by_zone["three"]), outline=mix(EDGE, line, 0.45),
            width=max(2, int(round(2.4 * self._scale))), track=self._track,
        )
        self._track(self.canvas.create_polygon(
            *geo["inside"], fill=zone_heat(by_zone["two"]), outline="", smooth=False,
        ))
        self._track(self.canvas.create_rectangle(
            *geo["key"], fill=zone_heat(by_zone["one"]), outline="",
        ))
        rx, ry, rr = geo["restricted"]
        self._dot(rx, ry, rr, fill=zone_heat(by_zone["layup"]))

        # Court markings on top, so the fills never swallow the lines.
        self._track(self.canvas.create_line(
            *geo["arc"], fill=line, width=hair, smooth=False,
        ))
        for corner in geo["corners"]:
            self._track(self.canvas.create_line(*corner, fill=line, width=hair))
        self._track(self.canvas.create_rectangle(
            *geo["key"], fill="", outline=line, width=hair,
        ))
        fx, fy, fr = geo["ft_circle"]
        self._dot(fx, fy, fr, fill="", outline=line, width=hair)
        self._dot(rx, ry, rr, fill="", outline=mix(line, INK, 0.3), width=hair)
        if geo["centre"]:
            self._track(self.canvas.create_line(
                *geo["centre"], fill=mix(line, EDGE, 0.35), width=hair, smooth=False,
            ))
        self._track(self.canvas.create_line(
            *geo["backboard"], fill=INK, width=max(2, int(round(4 * self._scale))),
        ))
        bx, by, br = geo["rim"]
        self._dot(bx, by, br, fill="", outline=ALERT,
                  width=max(2, int(round(3 * self._scale))))

        hot = hot_zone(rows)
        if hot:
            caption = f"HOT ZONE · {hot['label'].upper()}  {hot['pct']}%"
            colour = heat_color(hot["pct"])
        else:
            caption = "NO SHOTS LOGGED YET"
            colour = INK_3
        size = self._fit_size(
            letterspace(caption), (x1 - x0) - pad * 1.6, 15, minimum=9,
        )
        self._text(
            (x0 + x1) / 2, y1 - pad * 0.5 - foot_h / 2, letterspace(caption),
            size=size, bold=True, fill=colour, anchor="center",
        )

    def _draw_zone_legend(self, box, rows, *, title="WHERE THE POINTS COME FROM"):
        """Names the zone, says what it is worth, and shows how it is shooting."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, title)

        top = self._head_top(box)
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
            heat = heat_color(row["pct"]) if row["attempts"] else mix(CARD_LO, INK_3, 0.4)
            name_y = stack["y"][f"n{index}"]
            name_h = stack["h"][f"n{index}"]
            sub_y = stack["y"][f"s{index}"]
            sub_h = stack["h"][f"s{index}"]
            live = bool(row["attempts"])

            # The chip is the colour that zone is painted on the court, so a row
            # and its region on the chart find each other at a glance.
            self._dot(
                left + chip, name_y + name_h / 2, chip,
                fill=heat, outline=mix(heat, INK, 0.35),
                width=max(1, int(round(1.6 * self._scale))),
            )
            self._text(
                left + chip * 3, name_y, letterspace(row["label"].upper()),
                size=18 * scale, bold=True, fill=colour if live else INK_3,
            )
            self._text(
                right, name_y, f"{row['pct']}%",
                size=18 * scale, bold=True, fill=INK if live else INK_3, anchor="ne",
            )
            self._text(
                left + chip * 3, sub_y, f"{row['note']}  ·  {row['pointsLabel']}",
                size=12 * scale, fill=INK_3,
            )
            self._text(
                right, sub_y, f"{row['made']}/{row['attempts']} made",
                size=12 * scale, fill=INK_2 if live else INK_3, anchor="ne",
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
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(title="HUUPE DASHBOARD")

        recent = [row for row in (payload.get("recent") or []) if isinstance(row, dict)]
        boxes = layout_huupe_dashboard(screen_w, screen_h, timed=True, recent=bool(recent))
        accents = {
            "totals": ACCENT, "leaderboard": ACCENT, "recent": ACCENT,
            "court": ACCENT, "zones": ACCENT, "records": WARN,
        }
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box, accent=accents.get(name), lift=0.05 if name == "totals" else 0.0)

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
        self._draw_court(boxes["court"], rows, title="CAREER SHOT CHART")
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
