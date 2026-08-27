"""Flight Plan overlay — ``flightplan.flight`` UDP payload.

Two shapes share one page: a single flight (``mode: next``) and the whole trip
board (``mode: board``). The map is never optional — an upcoming flight draws
its expected great-circle path, an airborne one draws the flown arc plus the
live ADS-B position.
"""

from __future__ import annotations

import math
import re
import threading
import tkinter as tk
from datetime import date, datetime

from src.design_system import (
    ACCENT,
    ALERT,
    BG_DEEP,
    CARD_HI,
    EDGE_SOFT,
    GOOD,
    INK,
    INK_2,
    INK_3,
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
    stack_rows,
    text_line_h,
    text_measurer,
)
from src.display_panels import BasePanel
from src.page_header import paint_page_header

STATUS_COLORS = {
    "good": GOOD,
    "accent": ACCENT,
    "warn": WARN,
    "alert": ALERT,
    "muted": INK_3,
}

# The bridge status vocabulary names colours `GOOD`/`WARN`/…; older payloads
# carry only that field, so both spellings resolve here.
STATUS_COLOUR_ALIASES = {
    "good": "good",
    "warn": "warn",
    "alert": "alert",
    "accent": "accent",
    "ink_3": "muted",
    "muted": "muted",
}

MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN",
          "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")

# `2027-06-24T13:45:00-07:00` and AeroDataBox's `2027-06-24 13:45-07:00`.
_STAMP_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})")

MAP_LINE = "#7FD9FF"
# Map card interior: title band above the tiles, endpoint caption below them.
MAP_INSET_U = 14
MAP_TITLE_U = 40
MAP_FOOTER_U = 28


def format_flight_number(airline: str, number: str) -> str:
    """``DL 167`` — space between code and number; strip duplicated airline prefix."""
    code = str(airline or "").strip().upper()
    num = str(number or "").strip().upper().replace(" ", "")
    if code and num.startswith(code):
        num = num[len(code):]
    return f"{code} {num}".strip()


def airport_code(point: dict | None) -> str:
    point = point or {}
    return str(point.get("iata") or point.get("icao") or "—").upper()


def airport_place(point: dict | None) -> str:
    """City, else the airport name — never the raw IATA a second time."""
    point = point or {}
    for key in ("city", "municipality", "name"):
        text = str(point.get(key) or "").strip()
        if text:
            return text
    return ""


def format_route(origin: dict | None, destination: dict | None) -> str:
    return f"{airport_code(origin)} \u2192 {airport_code(destination)}"


def parse_stamp(value) -> tuple[int, int, int, int, int] | None:
    """``(year, month, day, hour, minute)`` in *airport-local* wall clock.

    The offset is deliberately ignored: a passenger reads the clock at the gate,
    not the instant translated into the display's own zone.
    """
    match = _STAMP_RE.search(str(value or ""))
    if not match:
        return None
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def format_clock(value) -> str:
    """``1:45 PM`` from an ISO-ish stamp, or ``—``."""
    parts = parse_stamp(value)
    if not parts:
        return "—"
    hour, minute = parts[3], parts[4]
    suffix = "AM" if hour < 12 else "PM"
    return f"{hour % 12 or 12}:{minute:02d} {suffix}"


def format_day(value) -> str:
    """``WED JUN 24`` — the day the clock above belongs to."""
    parts = parse_stamp(value)
    if not parts:
        return ""
    year, month, day = parts[0], parts[1], parts[2]
    try:
        weekday = WEEKDAYS[date(year, month, day).weekday()]
    except ValueError:
        return ""
    return f"{weekday} {MONTHS[month - 1]} {day}"


def format_duration(minutes) -> str:
    try:
        total = int(minutes)
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return ""
    hours, mins = divmod(total, 60)
    if hours and mins:
        return f"{hours}h {mins}m"
    if hours:
        return f"{hours}h"
    return f"{mins}m"


def format_lead_time(minutes) -> str:
    """How long until departure, in the largest unit that still means something."""
    try:
        total = int(minutes)
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return "departed"
    if total < 60:
        return f"in {total} min"
    if total < 60 * 24:
        return f"in {format_duration(total)}"
    days = round(total / (60 * 24))
    return f"in {days} day{'s' if days != 1 else ''}"


def format_as_of(iso_text: str | None) -> str:
    text = str(iso_text or "").strip()
    if not text:
        return "as of —"
    try:
        stamp = datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return "as of —"
    return f"as of {stamp.strftime('%I:%M %p').lstrip('0')}"


def status_token(status: dict | None) -> str:
    status = status or {}
    raw = str(status.get("colorToken") or status.get("colour") or "muted").strip().lower()
    return STATUS_COLOUR_ALIASES.get(raw, "muted")


def status_color(payload: dict) -> str:
    """Accent for the whole page, taken from the headline flight's status."""
    return STATUS_COLORS.get(status_token(payload.get("status")), INK_3)


def journey_fraction(payload: dict) -> float:
    progress = payload.get("progress") or {}
    try:
        value = float(progress.get("fraction"))
    except (TypeError, ValueError):
        value = 0.0
    if (payload.get("flight") or {}).get("state") == "landed":
        return 1.0
    return max(0.0, min(1.0, value))


def journey_caption(payload: dict) -> str:
    """The one number worth reading under the rail."""
    progress = payload.get("progress") or {}
    flight = payload.get("flight") or {}
    if flight.get("state") == "landed":
        return "arrived"
    if flight.get("state") == "active":
        remaining = format_duration(progress.get("remainingMinutes"))
        return f"{remaining} remaining" if remaining else "in the air"
    lead = format_lead_time(progress.get("departsInMinutes"))
    return lead or "not departed"


# --- Geo ---------------------------------------------------------------------

def _coord(point: dict | None, *keys: str):
    point = point or {}
    for key in keys:
        value = point.get(key)
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if number == number:  # not NaN
            return number
    return None


def endpoint_latlon(point: dict | None) -> tuple[float, float] | None:
    lat = _coord(point, "lat", "latitude")
    lon = _coord(point, "lon", "lng", "longitude")
    if lat is None or lon is None:
        return None
    return lat, lon


def unwrap_longitudes(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Keep a path continuous across the antimeridian (SEA→HND runs past 180)."""
    if not points:
        return []
    out = [points[0]]
    for lat, lon in points[1:]:
        previous = out[-1][1]
        while lon - previous > 180:
            lon -= 360
        while previous - lon > 180:
            lon += 360
        out.append((lat, lon))
    return out


def great_circle_points(
    lat1: float, lon1: float, lat2: float, lon2: float, *, count: int = 72,
) -> list[tuple[float, float]]:
    """Sampled great-circle arc — the path an aircraft actually flies."""
    p1, l1, p2, l2 = (math.radians(v) for v in (lat1, lon1, lat2, lon2))
    delta = 2 * math.asin(min(1.0, math.sqrt(
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin((l2 - l1) / 2) ** 2
    )))
    if delta < 1e-9:
        return unwrap_longitudes([(lat1, lon1), (lat2, lon2)])
    steps = max(2, int(count))
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        f = index / steps
        a = math.sin((1 - f) * delta) / math.sin(delta)
        b = math.sin(f * delta) / math.sin(delta)
        x = a * math.cos(p1) * math.cos(l1) + b * math.cos(p2) * math.cos(l2)
        y = a * math.cos(p1) * math.sin(l1) + b * math.cos(p2) * math.sin(l2)
        z = a * math.sin(p1) + b * math.sin(p2)
        points.append((
            math.degrees(math.atan2(z, math.hypot(x, y))),
            math.degrees(math.atan2(y, x)),
        ))
    return unwrap_longitudes(points)


def bearing_between(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Compass bearing in degrees from ``a`` to ``b``."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def path_bounds(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    lats = [lat for lat, _lon in points]
    lons = [lon for _lat, lon in points]
    return min(lats), min(lons), max(lats), max(lons)


def plane_polygon(cx: float, cy: float, heading_deg: float, size: float) -> list[float]:
    """Dart-shaped aircraft marker pointing along ``heading_deg`` (0 = north)."""
    rad = math.radians(float(heading_deg or 0.0))
    fx, fy = math.sin(rad), -math.cos(rad)   # forward on screen
    rx, ry = math.cos(rad), math.sin(rad)    # starboard on screen
    shape = ((0.0, 1.0), (0.72, -0.55), (0.0, -0.18), (-0.72, -0.55))
    flat: list[float] = []
    for right, forward in shape:
        flat.append(cx + rx * right * size + fx * forward * size)
        flat.append(cy + ry * right * size + fy * forward * size)
    return flat


# --- Layout ------------------------------------------------------------------

def layout_flightplan(
    screen_w: int,
    screen_h: int,
    *,
    timed: bool = True,
    legs: int = 1,
) -> dict[str, tuple[float, float, float, float]]:
    """Card boxes. Landscape puts the map beside the detail rail; portrait stacks."""
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0 = chrome.content_x
    x1 = chrome.content_x + chrome.content_w
    y0 = chrome.content_top + 10 * u
    y1 = chrome.content_bottom - 14 * u
    gap = 14 * u
    show_legs = legs > 1

    if not chrome.portrait:
        rail_w = (x1 - x0) * 0.42
        rail_x1 = x0 + rail_w
        map_x0 = rail_x1 + gap
        height = y1 - y0
        weights = (("flight", 0.34), ("times", 0.33), ("journey", 0.33))
        rail_h = height - gap * (len(weights) - 1)
        boxes: dict[str, tuple[float, float, float, float]] = {}
        y = y0
        for name, weight in weights:
            card_h = rail_h * weight
            boxes[name] = (x0, y, rail_x1, y + card_h)
            y += card_h + gap
        if show_legs:
            legs_h = min(height * 0.36, (90 + 52 * min(legs, 4)) * u)
            boxes["map"] = (map_x0, y0, x1, y1 - legs_h - gap)
            boxes["itinerary"] = (map_x0, y1 - legs_h, x1, y1)
        else:
            boxes["map"] = (map_x0, y0, x1, y1)
        return boxes

    height = y1 - y0
    flight_h = min(300 * u, height * 0.19)
    times_h = min(250 * u, height * 0.17)
    journey_h = min(210 * u, height * 0.14)
    legs_h = min((90 + 52 * min(legs, 5)) * u, height * 0.26) if show_legs else 0.0
    used = flight_h + times_h + journey_h + legs_h + gap * (4 if show_legs else 3)
    map_h = max(320 * u, height - used)
    boxes = {}
    y = y0
    for name, card_h in (("flight", flight_h), ("times", times_h),
                         ("map", map_h), ("journey", journey_h)):
        boxes[name] = (x0, y, x1, y + card_h)
        y += card_h + gap
    if show_legs:
        boxes["itinerary"] = (x0, y, x1, min(y + legs_h, y1))
    return boxes


class FlightPlanPanel(BasePanel):
    """Flight Plan page: identity, times, journey rail, itinerary and route map."""

    MAP_FILL = "#08122A"

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._map_photo = None
        self._request_id = 0
        self._scale = 1.0
        self._px_per_pt = PX_PER_POINT

    def hide(self):
        self._request_id += 1
        self._map_photo = None
        super().hide()

    def show(self, payload: dict):
        # `super().show` calls `hide`, which bumps the request id and so cancels
        # any in-flight tile fetch. Read the id back only afterwards.
        super().show(payload)
        self._start_map(payload, self._request_id)

    # --- shared drawing helpers ---------------------------------------------

    def _screen(self) -> tuple[int, int]:
        w = int(getattr(self.shell, "screen_w", 0) or 0)
        h = int(getattr(self.shell, "screen_h", 0) or 0)
        if w < 64:
            w = int(self.root.winfo_screenwidth() or 1920)
        if h < 64:
            h = int(self.root.winfo_screenheight() or 1080)
        return w, h

    def _sync_metrics(self):
        screen_w, screen_h = self._screen()
        self._scale = design_u(screen_w, screen_h)
        self._px_per_pt = measure_px_per_point(self.root, self._scale)

    def _font(self, size, bold: bool = False):
        scaled = max(8, int(round(float(size) * float(self._scale or 1.0))))
        return ("Segoe UI", scaled, "bold" if bold else "normal")

    def _line_h(self, size: float) -> float:
        return text_line_h(size, u=self._scale, px_per_pt=self._px_per_pt)

    def _text(self, x, y, text, *, size=14, bold=False, fill=INK, anchor="nw"):
        return self._track(self.canvas.create_text(
            x, y, anchor=anchor, text=str(text), fill=fill, font=self._font(size, bold),
        ))

    def _card(self, box, *, accent=None, lift=0.0):
        return paint_card(
            self.canvas, box, u=self._scale, accent=accent, lift=lift, track=self._track,
        )

    def _title(self, x, y, text, *, size=13, fill=INK_2, accent=ACCENT):
        return paint_section_title(
            self.canvas, x, y, text=text, font=self._font(size, True),
            u=self._scale, fill=fill, accent=accent, line_h=self._line_h(size),
            track=self._track,
        )

    def _pill(self, right_x, cy, text, color, *, size=13):
        """Status as a tinted pill with a lit dot — matches the Autodarts board chip."""
        u = self._scale
        font = self._font(size, True)
        measure = text_measurer(self.root, font)
        text_w = max(28.0, measure(text))
        dot_r = 4 * u
        pad_x = 13 * u
        height = self._line_h(size) + 8 * u
        width = text_w + pad_x * 2 + dot_r * 2 + 8 * u
        left = right_x - width
        box = (left, cy - height / 2, right_x, cy + height / 2)
        paint_bar(self.canvas, box, fill=mix(CARD_HI, color, 0.22), outline="",
                  track=self._track)
        paint_bar(self.canvas, box, fill="", outline=mix(EDGE_SOFT, color, 0.55),
                  track=self._track)
        dot_cx = left + pad_x
        self._track(self.canvas.create_oval(
            dot_cx - dot_r, cy - dot_r, dot_cx + dot_r, cy + dot_r, fill=color, outline="",
        ))
        self._text(dot_cx + dot_r + 8 * u, cy, text, size=size, bold=True, fill=color,
                   anchor="w")
        return width

    # --- page ----------------------------------------------------------------

    def _render(self, payload: dict):
        self._sync_metrics()
        screen_w, screen_h = self._screen()
        trip = payload.get("trip") or {}
        flight = payload.get("flight") or {}
        legs = [leg for leg in (payload.get("flights") or []) if isinstance(leg, dict)]
        board = str(payload.get("mode") or "next") == "board" and len(legs) > 1
        accent = status_color(payload)

        paint_backdrop(self.canvas, screen_w, screen_h, track=self._track)
        paint_page_header(
            self.canvas,
            screen_w=screen_w,
            screen_h=screen_h,
            pill="TRIP BOARD" if board else "FLIGHT PLAN",
            left_label="TRIP",
            left_value=str(trip.get("name") or "Flight Plan"),
            right_label="STATUS",
            right_value=str((payload.get("status") or {}).get("boardCode") or "").upper(),
            track=self._track,
        )

        boxes = layout_flightplan(
            screen_w, screen_h, timed=True, legs=len(legs) if board else 1,
        )
        self._card(boxes["flight"], accent=accent, lift=0.05)
        self._card(boxes["times"])
        self._card(boxes["journey"], accent=accent)
        self._card(boxes["map"])
        if "itinerary" in boxes:
            self._card(boxes["itinerary"])

        self._draw_flight(boxes["flight"], payload, accent)
        self._draw_times(boxes["times"], flight)
        self._draw_journey(boxes["journey"], payload, accent)
        self._draw_map_placeholder(boxes["map"], payload)
        if "itinerary" in boxes:
            self._draw_itinerary(boxes["itinerary"], legs, flight.get("id"))

    def _draw_flight(self, box, payload: dict, accent: str):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        flight = payload.get("flight") or {}
        trip = payload.get("trip") or {}
        status = payload.get("status") or {}

        rows = stack_rows(
            [("title", 13, 12), ("number", 30, 6), ("route", 46, 8), ("places", 13, 0)],
            top=y0 + pad,
            available=(y1 - y0) - pad * 2,
            u=u,
            px_per_pt=self._px_per_pt,
        )
        fs = rows["font_scale"]
        self._title(x0 + pad, rows["y"]["title"], str(trip.get("title") or "flight"),
                    size=13 * fs)
        line = str(status.get("displayLine") or "").strip()
        if line:
            self._pill(
                x1 - pad, rows["y"]["title"] + rows["h"]["title"] / 2,
                line[:26], accent, size=12 * fs,
            )
        self._text(
            x0 + pad, rows["y"]["number"],
            format_flight_number(flight.get("airline"), flight.get("number")),
            size=30 * fs, bold=True, fill=INK,
        )
        self._text(
            x0 + pad, rows["y"]["route"],
            format_route(flight.get("origin"), flight.get("destination")),
            size=46 * fs, bold=True, fill=ACCENT,
        )
        places = " \u00b7 ".join(
            part for part in (
                airport_place(flight.get("origin")), airport_place(flight.get("destination")),
            ) if part
        )
        if places:
            self._text(x0 + pad, rows["y"]["places"], places, size=13 * fs, fill=INK_3)

    def _draw_times(self, box, flight: dict):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        rows = stack_rows(
            [("label", 12, 10), ("clock", 30, 6), ("day", 13, 6), ("where", 12, 0)],
            top=y0 + pad,
            available=(y1 - y0) - pad * 2,
            u=u,
            px_per_pt=self._px_per_pt,
        )
        fs = rows["font_scale"]
        latest = flight.get("latest") or {}
        scheduled = flight.get("scheduled") or {}
        columns = (
            ("DEPARTS", scheduled.get("departure"), latest.get("departure") or {},
             flight.get("origin")),
            ("ARRIVES", scheduled.get("arrival"), latest.get("arrival") or {},
             flight.get("destination")),
        )
        col_w = (x1 - x0 - pad * 2) / 2
        for index, (label, sched, live, point) in enumerate(columns):
            cx = x0 + pad + col_w * index
            if index:
                self._track(self.canvas.create_line(
                    x0 + pad + col_w, y0 + 18 * u, x0 + pad + col_w, y1 - 18 * u,
                    fill=EDGE_SOFT, width=1,
                ))
                cx += 16 * u
            revised = (live.get("revisedTime") or {}).get("local") \
                or (live.get("estimatedTime") or {}).get("local")
            stamp = revised or sched
            late = bool(revised and parse_stamp(revised) != parse_stamp(sched))
            self._text(cx, rows["y"]["label"], letterspace(label), size=12 * fs,
                       bold=True, fill=INK_3)
            self._text(cx, rows["y"]["clock"], format_clock(stamp), size=30 * fs,
                       bold=True, fill=WARN if late else INK)
            self._text(cx, rows["y"]["day"], format_day(stamp), size=13 * fs, fill=INK_2)
            detail = [airport_code(point)]
            gate = live.get("gate") or (point or {}).get("gate")
            terminal = live.get("terminal")
            if terminal:
                detail.append(f"Term {terminal}")
            if gate:
                detail.append(f"Gate {gate}")
            belt = live.get("baggageBelt")
            if belt:
                detail.append(f"Belt {belt}")
            self._text(cx, rows["y"]["where"], "  \u00b7  ".join(str(bit) for bit in detail),
                       size=12 * fs, fill=INK_3)

    def _draw_journey(self, box, payload: dict, accent: str):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        progress = payload.get("progress") or {}
        stage = payload.get("stage") or {}
        rows = stack_rows(
            [("title", 13, 14), ("rail", 12, 12), ("caption", 16, 6), ("note", 12, 0)],
            top=y0 + pad,
            available=(y1 - y0) - pad * 2,
            u=u,
            px_per_pt=self._px_per_pt,
        )
        fs = rows["font_scale"]
        duration = format_duration(progress.get("durationMinutes"))
        self._title(x0 + pad, rows["y"]["title"], "JOURNEY", size=13 * fs)
        if duration:
            self._text(x1 - pad, rows["y"]["title"], duration, size=13 * fs, bold=True,
                       fill=INK_2, anchor="ne")

        fraction = journey_fraction(payload)
        rail_y = rows["y"]["rail"]
        rail_h = max(6.0, 10 * u)
        rail_x0, rail_x1 = x0 + pad, x1 - pad
        paint_meter(
            self.canvas, (rail_x0, rail_y, rail_x1, rail_y + rail_h), fraction, accent,
            track=self._track, track_color=TRACK,
        )
        marker_x = rail_x0 + (rail_x1 - rail_x0) * fraction
        self._track(self.canvas.create_polygon(
            plane_polygon(marker_x, rail_y + rail_h / 2, 90, max(7.0, 11 * u)),
            fill=INK, outline=BG_DEEP, width=max(1, int(round(u))),
        ))
        self._text(rail_x0, rows["y"]["caption"], journey_caption(payload), size=16 * fs,
                   bold=True, fill=accent)
        percent = int(round(fraction * 100))
        if fraction > 0:
            self._text(rail_x1, rows["y"]["caption"], f"{percent}%", size=16 * fs,
                       bold=True, fill=INK_2, anchor="ne")
        note = str(stage.get("note") or "").strip()
        if payload.get("waitingForQuota"):
            note = f"{note} \u00b7 waiting for quota" if note else "waiting for quota"
        if note:
            self._text(rail_x0, rows["y"]["note"], note, size=12 * fs, fill=INK_3)

    def _draw_itinerary(self, box, legs: list, current_id):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        self._title(x0 + pad, y0 + pad, "TRIP ITINERARY", size=13)
        head_h = self._line_h(13) + 16 * u
        top = y0 + pad + head_h
        room = max(0.0, (y1 - pad) - top)
        row_h = self._line_h(15) + 16 * u
        visible = max(1, min(len(legs), int(room // row_h) if row_h else 1))
        for index, leg in enumerate(legs[:visible]):
            ry = top + row_h * index
            color = STATUS_COLORS.get(status_token(leg.get("status")), INK_3)
            if leg.get("id") and leg.get("id") == current_id:
                paint_bar(
                    self.canvas, (x0 + pad - 8 * u, ry - 3 * u, x1 - pad + 8 * u,
                                  ry + row_h - 9 * u),
                    radius=6 * u, fill=mix(CARD_HI, ACCENT, 0.16), outline="",
                    track=self._track,
                )
            cy = ry + (row_h - 12 * u) / 2
            self._text(x0 + pad, cy, format_day(leg.get("scheduled", {}).get("departure"))
                       or str(leg.get("date") or ""), size=12, fill=INK_3, anchor="w")
            self._text(x0 + pad + (x1 - x0) * 0.24, cy,
                       format_flight_number(leg.get("airline"), leg.get("number")),
                       size=15, bold=True, fill=INK, anchor="w")
            self._text(x0 + pad + (x1 - x0) * 0.44, cy,
                       format_route(leg.get("origin"), leg.get("destination")),
                       size=15, fill=INK_2, anchor="w")
            self._text(x0 + pad + (x1 - x0) * 0.68, cy,
                       format_clock(leg.get("scheduled", {}).get("departure")),
                       size=13, fill=INK_2, anchor="w")
            self._text(x1 - pad, cy, str((leg.get("status") or {}).get("boardCode") or "—"),
                       size=13, bold=True, fill=color, anchor="e")
        hidden = len(legs) - visible
        if hidden > 0:
            self._text(x1 - pad, y0 + pad, f"+{hidden} more", size=12, fill=INK_3,
                       anchor="ne")

    # --- map -----------------------------------------------------------------

    def _draw_map_placeholder(self, box, payload: dict):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 18 * u
        stage = payload.get("stage") or {}
        live = str(stage.get("mode") or "preflight") == "live"
        self._title(x0 + pad, y0 + pad, "LIVE POSITION" if live else "EXPECTED ROUTE",
                    size=13, accent=ALERT if live else ACCENT)
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, (y0 + y1) / 2, anchor="center", text="plotting route\u2026",
            fill=INK_3, font=self._font(13), tags=("fp-map",),
        ))

    def _map_box(self, payload: dict):
        screen_w, screen_h = self._screen()
        legs = [leg for leg in (payload.get("flights") or []) if isinstance(leg, dict)]
        board = str(payload.get("mode") or "next") == "board" and len(legs) > 1
        boxes = layout_flightplan(
            screen_w, screen_h, timed=True, legs=len(legs) if board else 1,
        )
        return boxes["map"]

    def _route_endpoints(self, payload: dict):
        stage = payload.get("stage") or {}
        route = stage.get("route") or {}
        flight = payload.get("flight") or {}
        origin = endpoint_latlon(route.get("origin")) or endpoint_latlon(flight.get("origin"))
        dest = (endpoint_latlon(route.get("destination"))
                or endpoint_latlon(flight.get("destination")))
        return origin, dest

    def _start_map(self, payload: dict, request_id: int):
        origin, dest = self._route_endpoints(payload)
        if not origin or not dest:
            return
        box = self._map_box(payload)
        u = self._scale
        width = max(120, int(box[2] - box[0] - MAP_INSET_U * u * 2))
        height = max(120, int(
            box[3] - box[1] - MAP_INSET_U * u * 2 - MAP_TITLE_U * u - MAP_FOOTER_U * u
        ))
        threading.Thread(
            target=self._fetch_map,
            args=(payload, origin, dest, box, width, height, request_id),
            daemon=True,
        ).start()

    def _fetch_map(self, payload, origin, dest, box, width, height, request_id: int):
        try:
            from PIL import ImageTk

            from src import map_tiles

            points = great_circle_points(origin[0], origin[1], dest[0], dest[1])
            min_lat, min_lon, max_lat, max_lon = path_bounds(points)
            zoom, center_lat, center_lon = map_tiles.zoom_to_fit(
                min_lat, min_lon, max_lat, max_lon, width, height,
            )
            image = map_tiles.fetch_map_tiles(center_lat, center_lon, zoom, width, height)
            pixels = map_tiles.project_points_to_pixels(
                points, center_lat, center_lon, zoom, width, height,
            )
            photo = ImageTk.PhotoImage(image)
        except Exception as error:  # tiles are best-effort; the cards still stand
            self.root.after(0, lambda: self._show_map_error(request_id, box, error))
            return

        marker = self._marker_pixels(payload, points, pixels)
        self.root.after(
            0, lambda: self._apply_map(request_id, photo, box, pixels, marker, payload),
        )

    def _marker_pixels(self, payload: dict, points, pixels):
        """Where the aircraft sits, and which way it points."""
        stage = payload.get("stage") or {}
        position = stage.get("position") or {}
        fraction = journey_fraction(payload)
        live = endpoint_latlon(position)
        if live:
            index = min(range(len(points)), key=lambda i: (
                (points[i][0] - live[0]) ** 2 + (points[i][1] - live[1]) ** 2
            ))
            heading = position.get("heading")
            if heading is None and index + 1 < len(points):
                heading = bearing_between(points[index], points[index + 1])
            return {"index": index, "heading": heading or 0.0, "live": True}
        if fraction <= 0.001:
            return None
        index = min(len(points) - 1, max(0, int(round(fraction * (len(points) - 1)))))
        nxt = min(len(points) - 1, index + 1)
        return {
            "index": index,
            "heading": bearing_between(points[index], points[nxt]) if nxt != index else 0.0,
            "live": False,
        }

    def _apply_map(self, request_id: int, photo, box, pixels, marker, payload: dict):
        if not self.visible or request_id != self._request_id:
            return
        self.canvas.delete("fp-map")
        x0, y0, x1, y1 = box
        u = self._scale
        inset = MAP_INSET_U * u
        origin_x = x0 + inset
        origin_y = y0 + inset + MAP_TITLE_U * u
        self._map_photo = photo
        self._track(self.canvas.create_image(
            origin_x, origin_y, image=photo, anchor="nw", tags=("fp-map",),
        ))

        flown = journey_fraction(payload)
        split = max(1, int(round(flown * (len(pixels) - 1)))) if flown > 0 else 0
        screen = [(origin_x + px, origin_y + py) for px, py in pixels]

        def polyline(section, **kwargs):
            flat = [value for point in section for value in point]
            if len(flat) >= 4:
                self._track(self.canvas.create_line(*flat, tags=("fp-map",), **kwargs))

        glow = max(4, int(round(7 * u)))
        polyline(screen, fill=mix(BG_DEEP, MAP_LINE, 0.35), width=glow,
                 capstyle=tk.ROUND, joinstyle=tk.ROUND, smooth=True)
        polyline(screen[split:], fill=MAP_LINE, width=max(2, int(round(3 * u))),
                 dash=(9, 7), capstyle=tk.ROUND, smooth=True)
        if split:
            polyline(screen[:split + 1], fill=ACCENT, width=max(3, int(round(4 * u))),
                     capstyle=tk.ROUND, joinstyle=tk.ROUND, smooth=True)

        for point, color in ((screen[0], GOOD), (screen[-1], ALERT)):
            radius = max(4, int(round(6 * u)))
            self._track(self.canvas.create_oval(
                point[0] - radius, point[1] - radius, point[0] + radius, point[1] + radius,
                fill=color, outline=BG_DEEP, width=max(1, int(round(2 * u))),
                tags=("fp-map",),
            ))

        if marker:
            mx, my = screen[marker["index"]]
            size = max(9, int(round(15 * u))) if marker["live"] else max(7, int(round(12 * u)))
            self._track(self.canvas.create_polygon(
                plane_polygon(mx, my, marker["heading"], size),
                fill=ALERT if marker["live"] else INK,
                outline=BG_DEEP, width=max(1, int(round(1.5 * u))), tags=("fp-map",),
            ))

        flight = payload.get("flight") or {}
        caption_y = y1 - inset
        self._track(self.canvas.create_text(
            origin_x, caption_y, anchor="sw",
            text=f"{airport_code(flight.get('origin'))} \u2192 "
                 f"{airport_code(flight.get('destination'))}",
            fill=INK_3, font=self._font(12), tags=("fp-map",),
        ))
        self._track(self.canvas.create_text(
            x1 - inset, caption_y, anchor="se", text=format_as_of(payload.get("asOf")),
            fill=INK_3, font=self._font(12), tags=("fp-map",),
        ))

    def _show_map_error(self, request_id: int, box, error):
        if not self.visible or request_id != self._request_id:
            return
        self.canvas.delete("fp-map")
        x0, y0, x1, y1 = box
        try:
            from src import map_tiles

            map_tiles.log_map_error(f"flight plan map failed: {error!r}")
        except Exception:
            pass
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, (y0 + y1) / 2, anchor="center", text="map offline",
            fill=WARN, font=self._font(13), tags=("fp-map",),
        ))
