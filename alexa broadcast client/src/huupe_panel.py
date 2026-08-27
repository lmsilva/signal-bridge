"""Huupe Mini overlay: live session, final card, and the career dashboard.

The hoop reports two very different shapes. Family Mode names its players and
keeps a score per person; free play knows only that a ball went in and roughly
where from. Rather than force one into the other, the body of the session page
switches: a scoreboard when there are names, a solo stat block when there are
not. Everything else — mode bar, headline, shooting breakdown, footer — is
shared, so the two read as the same page.
"""

import json

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
# range even before the numbers do.
ZONE_COLORS = {
    "layup": INK_3,
    "one": ACCENT,
    "two": GOOD,
    "three": WARN,
}


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
        rows.append({
            "zone": zone,
            "label": row.get("label") or zone.upper(),
            "made": int(row.get("made") or 0),
            "attempts": int(row.get("attempts") or 0),
            "pct": int(row.get("pct") or 0),
        })
    return rows


def layout_huupe_session(screen_w, screen_h, *, timed, finished=False):
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 8 * u
    y1 = chrome.content_bottom - 12 * u
    gap = 12 * u

    mode_h = 46 * u
    headline_h = 168 * u
    zones_h = 266 * u
    strip_h = 92 * u
    avail = max(360.0, y1 - y0)
    fixed = mode_h + headline_h + zones_h + strip_h + gap * 4
    body_h = max(150 * u, avail - fixed)

    boxes = {}
    y = y0
    boxes["mode"] = (x0, y, x1, y + mode_h)
    y += mode_h + gap
    boxes["headline"] = (x0, y, x1, y + headline_h)
    y += headline_h + gap
    boxes["body"] = (x0, y, x1, y + body_h)
    y += body_h + gap
    boxes["zones"] = (x0, y, x1, y + zones_h)
    y += zones_h + gap
    boxes["strip"] = (x0, y, x1, min(y + strip_h, y1))
    boxes["chrome"] = chrome
    boxes["finished"] = finished
    return boxes


def layout_huupe_dashboard(screen_w, screen_h, *, timed=True):
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 10 * u
    y1 = chrome.content_bottom - 14 * u
    gap = 12 * u

    totals_h = 124 * u
    zones_h = 250 * u
    records_h = 196 * u
    avail = max(400.0, y1 - y0)
    fixed = totals_h + zones_h + records_h + gap * 3
    board_h = max(200 * u, avail - fixed)

    boxes = {}
    y = y0
    boxes["totals"] = (x0, y, x1, y + totals_h)
    y += totals_h + gap
    boxes["leaderboard"] = (x0, y, x1, y + board_h)
    y += board_h + gap
    boxes["zones"] = (x0, y, x1, y + zones_h)
    y += zones_h + gap
    boxes["records"] = (x0, y, x1, min(y + records_h, y1))
    boxes["chrome"] = chrome
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

    # --------------------------------------------------------------- session

    def _render_session(self, payload: dict):
        self._sync_metrics()
        session = (payload or {}).get("session") or {}
        finished = str(session.get("status") or "live").lower() == "finished"
        timed = finished or payload.get("persistent") is False

        screen_w, screen_h = self._screen()
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(status_chip="FINAL" if finished else "LIVE")

        boxes = layout_huupe_session(screen_w, screen_h, timed=timed, finished=finished)
        accents = {
            "headline": WARN if finished else ACCENT,
            "body": ACCENT,
            "zones": ACCENT,
        }
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4:
                continue
            if name == "mode":
                continue
            self._card(box, accent=accents.get(name), lift=0.05 if name == "headline" else 0.0)

        self._draw_mode(boxes["mode"], session)
        self._draw_headline(boxes["headline"], session, finished=finished)
        players = [p for p in (session.get("players") or []) if p.get("name")]
        if players:
            self._draw_scoreboard(boxes["body"], players, finished=finished)
        else:
            self._draw_solo(boxes["body"], session)
        self._draw_zones(boxes["zones"], session.get("zones"), title="SHOOTING")
        self._draw_strip(boxes["strip"], session, finished=finished)

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

    def _draw_headline(self, box, session, *, finished):
        x0, y0, x1, y1 = box
        headline = session.get("headline") or {}
        primary = str(headline.get("primary") or "—")
        secondary = str(headline.get("secondary") or "")
        mid_x = (x0 + x1) / 2

        # A name needs far less room than a score, and the card is a fixed
        # height, so the hero size follows the string rather than the reverse.
        hero = 96 if len(primary) <= 6 else (64 if len(primary) <= 12 else 44)
        stack = stack_rows(
            [("hero", hero, 10), ("sub", 20, 0)],
            top=y0 + self._pad(),
            available=(y1 - y0) - self._pad() * 2,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        self._text(
            mid_x, stack["y"]["hero"], clip(primary, 22),
            size=hero * scale, bold=True, fill=WARN if finished else INK, anchor="n",
        )
        if secondary:
            self._text(
                mid_x, stack["y"]["sub"], letterspace(secondary.upper()),
                size=20 * scale, fill=INK_2, anchor="n",
            )

    def _draw_scoreboard(self, box, players, *, finished):
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, "SCOREBOARD")

        top = y0 + pad * 0.7 + self._line_h(14) + 14 * self._scale
        available = (y1 - top) - pad
        shown = players[:6]
        rows = [(f"p{index}", 24, 22) for index in range(len(shown))]
        if not rows:
            return
        rows[-1] = (rows[-1][0], rows[-1][1], 0)
        stack = stack_rows(
            rows, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 24 * stack["font_scale"]

        for index, player in enumerate(shown):
            y = stack["y"][f"p{index}"]
            height = stack["h"][f"p{index}"]
            winner = bool(player.get("isWinner")) and finished
            if winner:
                paint_bar(
                    self.canvas,
                    (x0 + pad * 0.5, y - 3 * self._scale, x1 - pad * 0.5, y + height + 3 * self._scale),
                    fill=plate_for(WARN), outline="", track=self._track,
                )
            colour = MEDALS[index] if index < len(MEDALS) and finished else INK
            rank = str(player.get("rank") or index + 1)
            name = clip(player.get("name"), 14)
            self._text(left, y, f"{rank}  {name}", size=size, bold=True, fill=colour)
            self._text(
                right, y, format_score(player.get("score")),
                size=size, bold=True, fill=WARN if winner else INK, anchor="ne",
            )

    def _draw_solo(self, box, session):
        """Free play has no names, so the tiles carry the session instead."""
        x0, y0, x1, y1 = box
        pad = self._pad()
        stats = session.get("stats") or {}
        tiles = [
            ("POINTS", format_score(stats.get("points"))),
            ("MADE", str(stats.get("shotLine") or "0/0")),
            ("ACCURACY", f"{int(stats.get('fgPct') or 0)}%"),
            ("BEST RUN", str(int(stats.get("bestStreak") or 0))),
        ]
        self._title(x0 + pad, y0 + pad * 0.7, "THIS SESSION")

        top = y0 + pad * 0.7 + self._line_h(14) + 16 * self._scale
        cell_w = (x1 - x0 - pad * 2) / len(tiles)
        stack = stack_rows(
            [("value", 40, 8), ("label", 14, 0)],
            top=top,
            available=(y1 - top) - pad,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        for index, (label, value) in enumerate(tiles):
            cx = x0 + pad + cell_w * (index + 0.5)
            if index:
                self._track(self.canvas.create_line(
                    x0 + pad + cell_w * index, top, x0 + pad + cell_w * index, y1 - pad,
                    fill=EDGE_SOFT, width=1,
                ))
            self._text(cx, stack["y"]["value"], value, size=40 * scale, bold=True, anchor="n")
            self._text(
                cx, stack["y"]["label"], letterspace(label),
                size=14 * scale, fill=INK_3, anchor="n",
            )

    def _draw_zones(self, box, zones, *, title="SHOOTING"):
        x0, y0, x1, y1 = box
        pad = self._pad()
        left = x0 + pad
        right = x1 - pad
        self._title(left, y0 + pad * 0.7, title)

        rows = zone_rows(zones)
        top = y0 + pad * 0.7 + self._line_h(14) + 14 * self._scale
        spec = [(f"z{index}", 19, 30) for index in range(len(rows))]
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=(y1 - top) - pad,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 19 * stack["font_scale"]

        for index, row in enumerate(rows):
            key = f"z{index}"
            y = stack["y"][key]
            height = stack["h"][key]
            colour = ZONE_COLORS.get(row["zone"], ACCENT)
            self._text(left, y, letterspace(row["label"]), size=size, bold=True, fill=colour)
            self._text(
                right, y, f"{row['made']}/{row['attempts']}   {row['pct']}%",
                size=size, fill=INK_2 if row["attempts"] else INK_3, anchor="ne",
            )
            # The rail only appears when the compressed gap actually left room
            # for it — a bar drawn through the next label is worse than none.
            next_y = stack["y"].get(f"z{index + 1}")
            room = (next_y - (y + height)) if next_y else ((y1 - pad) - (y + height))
            if room >= 12 * self._scale:
                rail_y = y + height + room / 2
                thickness = max(3.0, 5 * self._scale)
                fraction = (row["pct"] or 0) / 100.0
                paint_meter(
                    self.canvas,
                    (left, rail_y - thickness / 2, right, rail_y + thickness / 2),
                    fraction, colour, track=self._track, track_color=TRACK,
                )

    def _draw_strip(self, box, session, *, finished):
        x0, y0, x1, y1 = box
        pad = self._pad()
        stats = session.get("stats") or {}
        last = session.get("lastShot") or {}

        if finished:
            left_text = f"FINAL · {session.get('shotLine') or stats.get('shotLine') or ''}".strip(" ·")
            right_text = f"{int(stats.get('fgPct') or 0)}% FROM THE FLOOR"
        else:
            if last:
                who = last.get("player")
                verb = "MADE" if last.get("made") else "MISSED"
                zone = last.get("zoneLabel") or ""
                left_text = " ".join(part for part in [clip(who, 12), verb, zone] if part)
            else:
                left_text = "WARMING UP"
            streak = int(stats.get("streak") or 0)
            right_text = f"{streak} IN A ROW" if streak > 1 else str(stats.get("shotLine") or "")

        cy = (y0 + y1) / 2
        self._text(
            x0 + pad, cy, letterspace(left_text.upper()),
            size=17, bold=True, fill=INK_2, anchor="w",
        )
        if right_text:
            self._text(
                x1 - pad, cy, letterspace(right_text.upper()),
                size=17, fill=GOOD if not finished else INK_2, anchor="e",
            )

    # ------------------------------------------------------------- dashboard

    def _render_dashboard(self, payload: dict):
        self._sync_metrics()
        screen_w, screen_h = self._screen()
        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        self._paint_header(title="HUUPE DASHBOARD")

        boxes = layout_huupe_dashboard(screen_w, screen_h, timed=True)
        accents = {"totals": ACCENT, "leaderboard": ACCENT, "zones": ACCENT, "records": WARN}
        for name, box in boxes.items():
            if not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box, accent=accents.get(name), lift=0.05 if name == "totals" else 0.0)

        self._draw_totals(boxes["totals"], payload.get("totals") or {})
        self._draw_leaderboard(
            boxes["leaderboard"],
            payload.get("leaderboard") or [],
            int(payload.get("moreCount") or 0),
        )
        self._draw_zones(boxes["zones"], payload.get("zones"), title="WHERE THE POINTS COME FROM")
        self._draw_records(boxes["records"], payload.get("records") or {}, payload.get("device"))

    def _draw_totals(self, box, totals):
        x0, y0, x1, y1 = box
        pad = self._pad()
        tiles = [
            ("SESSIONS", str(totals.get("sessions") or 0)),
            ("SHOTS", str(totals.get("shots") or 0)),
            ("ACCURACY", f"{int(totals.get('fgPct') or 0)}%"),
            ("LAST", str(totals.get("lastPlayedLabel") or "—")),
        ]
        cell_w = (x1 - x0 - pad * 2) / len(tiles)
        stack = stack_rows(
            [("value", 34, 6), ("label", 13, 0)],
            top=y0 + pad * 0.8,
            available=(y1 - y0) - pad * 1.6,
            u=self._scale,
            px_per_pt=self._px_per_pt,
        )
        scale = stack["font_scale"]
        for index, (label, value) in enumerate(tiles):
            cx = x0 + pad + cell_w * (index + 0.5)
            if index:
                self._track(self.canvas.create_line(
                    x0 + pad + cell_w * index, y0 + pad * 0.7,
                    x0 + pad + cell_w * index, y1 - pad * 0.7,
                    fill=EDGE_SOFT, width=1,
                ))
            self._text(cx, stack["y"]["value"], clip(value, 10), size=34 * scale, bold=True, anchor="n")
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

        top = y0 + pad * 0.7 + self._line_h(14) + 14 * self._scale
        available = (y1 - top) - pad
        if not leaderboard:
            self._text(left, top, "No games yet — go shoot something.", size=18, fill=INK_3)
            return

        row_points = 21
        row_height = self._line_h(row_points) + 12 * self._scale
        capacity = max(1, int(available // max(1.0, row_height)))
        shown = list(leaderboard[:capacity])
        hidden = more_count + max(0, len(leaderboard) - len(shown))
        if hidden and len(shown) > 1:
            shown = shown[:-1]
            hidden += 1

        spec = [(f"r{index}", row_points, 12) for index in range(len(shown))]
        if hidden:
            spec.append(("more", 14, 0))
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=available,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = row_points * stack["font_scale"]

        for index, player in enumerate(shown):
            key = f"r{index}"
            y = stack["y"][key]
            height = stack["h"][key]
            if index == 0:
                paint_bar(
                    self.canvas,
                    (x0 + pad * 0.5, y - 3 * self._scale, x1 - pad * 0.5, y + height + 3 * self._scale),
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

        if hidden:
            self._text(
                left, stack["y"]["more"], f"+{hidden} more",
                size=14 * stack["font_scale"], fill=INK_3,
            )

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

        top = y0 + pad * 0.7 + self._line_h(14) + 14 * self._scale
        spec = [(f"l{index}", 18, 14) for index in range(len(lines))]
        spec[-1] = (spec[-1][0], spec[-1][1], 0)
        stack = stack_rows(
            spec, top=top, available=(y1 - top) - pad,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        size = 18 * stack["font_scale"]

        for index, (label, value, note) in enumerate(lines):
            y = stack["y"][f"l{index}"]
            self._text(left, y, letterspace(label), size=size, fill=INK_3)
            text = f"{value}  ·  {note}" if note else value
            colour = GOOD if label == "HOOP" and value == "ONLINE" else INK
            self._text(right, y, text, size=size, bold=True, fill=colour, anchor="ne")
