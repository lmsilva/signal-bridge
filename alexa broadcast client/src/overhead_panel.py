"""Overhead flight-radar overlay (overhead.round / overhead.update).

Single-page layout: radar scope + aircraft list (never swaps map vs list).
Pure geometry / roster / dead-reckon helpers are testable without Tk.
"""

from __future__ import annotations

import hashlib
import math
import threading
import time
import tkinter as tk
import tkinter.font as tkfont

try:
    from PIL import Image, ImageDraw, ImageTk
except ImportError:
    Image = None
    ImageDraw = None
    ImageTk = None

from src.design_system import ACCENT, BG, INK, INK_2, INK_3, LINE, WARN, page_chrome
from src.display_panels import BasePanel
from src import map_tiles
from src.trivia_panel import mix_hex

NM_TO_DEG_LAT = 1.0 / 60.0
STALE_FREEZE_SEC = 60
STALE_FADE_SEC = 90
EASE_MS = 350
MOTION_MS = 33  # ~30 fps
PAGE_COUNTDOWN_MS = 250  # keep "next page in Ns" ticking smoothly
METERS_PER_NM = 1852.0
EMERGENCY_SQUAWKS = {"7500", "7600", "7700"}

COLOR_JET = "#5FD0FF"
COLOR_GA = "#F5C453"
COLOR_HELI = "#F0ABFC"
COLOR_GENERIC = "#9AA6C3"
COLOR_EMERGENCY = "#FF7A6B"
COLOR_OUT_OF_RANGE = INK_3

LABEL_OFFSETS = (
    (0, -22),
    (24, 0),
    (0, 22),
    (-24, 0),
    (18, -18),
    (18, 18),
    (-18, 18),
    (-18, -18),
    (0, -36),
    (36, 0),
    (0, 36),
    (-36, 0),
)


def rows_per_page(portrait: bool) -> int:
    return 4 if portrait else 6


def compute_layout_regions(
    content_x: float,
    content_y: float,
    content_w: float,
    content_h: float,
    *,
    portrait: bool,
) -> dict:
    """Scope ~55% primary axis, legend band, list fills remainder."""
    gap = max(10.0, content_h * 0.014)
    # Tall enough for swatch + spelled-out legend labels with breathing room.
    legend_h = max(40.0, content_h * 0.055)

    if portrait:
        # Leave room for header clearance inside the scope box; list gets the
        # lower band with a reserved footer for pager text.
        scope_h = content_h * 0.50
        list_top = content_y + scope_h + gap + legend_h + gap
        return {
            "portrait": True,
            "scope": (content_x, content_y, content_x + content_w, content_y + scope_h),
            "legend": (
                content_x,
                content_y + scope_h + gap,
                content_x + content_w,
                content_y + scope_h + gap + legend_h,
            ),
            "list": (content_x, list_top, content_x + content_w, content_y + content_h),
            "rows": rows_per_page(True),
        }

    scope_w = content_w * 0.55
    list_left = content_x + scope_w + gap
    list_w = max(40.0, content_x + content_w - list_left)
    return {
        "portrait": False,
        "scope": (content_x, content_y, content_x + scope_w, content_y + content_h),
        "legend": (
            content_x,
            content_y + content_h - legend_h,
            content_x + scope_w,
            content_y + content_h,
        ),
        "list": (list_left, content_y, list_left + list_w, content_y + content_h),
        "rows": rows_per_page(False),
    }


def freeze_roster(aircraft: list | None) -> list[dict]:
    """Stable roster order for a display cycle (nearest first when distance known)."""
    rows = [dict(ac) for ac in (aircraft or []) if isinstance(ac, dict)]

    def sort_key(ac: dict):
        try:
            dist = float(ac.get("dstNm"))
        except (TypeError, ValueError):
            dist = 9999.0
        label = aircraft_display_label(ac).upper()
        return (dist, label)

    rows.sort(key=sort_key)
    return rows


def roster_page_count(total: int, rows: int) -> int:
    rows = max(1, int(rows or 1))
    total = max(0, int(total or 0))
    if total <= 0:
        return 1
    return max(1, (total + rows - 1) // rows)


def roster_page_slice(roster: list, page_index: int, rows: int) -> list[dict]:
    rows = max(1, int(rows or 1))
    page_index = max(0, int(page_index or 0))
    start = page_index * rows
    return list(roster[start : start + rows])


def page_highlight_hexes(roster: list, page_index: int, rows: int) -> set[str]:
    return {
        str(ac.get("hex") or "").strip().upper()
        for ac in roster_page_slice(roster, page_index, rows)
        if str(ac.get("hex") or "").strip()
    }


def aircraft_display_label(ac: dict | None) -> str:
    ac = ac or {}
    for key in ("label", "callsign", "registration", "hex"):
        text = str(ac.get(key) or "").strip()
        if text:
            return text
    return "—"


def label_offset_index(hex_code: str) -> int:
    digest = hashlib.md5(str(hex_code or "").encode("utf-8")).hexdigest()
    return int(digest[:2], 16) % len(LABEL_OFFSETS)


def label_offset_for_hex(hex_code: str) -> tuple[int, int]:
    return LABEL_OFFSETS[label_offset_index(hex_code) % len(LABEL_OFFSETS)]


def _label_boxes_overlap(
    a: tuple[float, float, float, float],
    b: tuple[float, float, float, float],
    pad: float = 6.0,
) -> bool:
    ax0, ay0, ax1, ay1 = a
    bx0, by0, bx1, by1 = b
    return not (
        ax1 + pad <= bx0
        or bx1 + pad <= ax0
        or ay1 + pad <= by0
        or by1 + pad <= ay0
    )


def resolve_map_label_offsets(
    anchors: list[tuple[str, float, float, str]],
    *,
    char_w: float = 7.5,
    height: float = 16.0,
    pad: float = 6.0,
) -> dict[str, tuple[float, float]]:
    """Greedy non-overlapping label offsets for on-page aircraft.

    ``anchors`` entries are ``(hex, x, y, label_text)``. Prefers the
    deterministic slot for each hex, then walks other slots and radial scales.
    """
    placed: list[tuple[float, float, float, float]] = []
    out: dict[str, tuple[float, float]] = {}
    scales = (1.0, 1.4, 1.85, 2.35, 2.9)
    for hex_code, x, y, text in anchors:
        w = max(28.0, len(str(text or "")) * float(char_w))
        h = max(12.0, float(height))
        start = label_offset_index(hex_code)
        chosen: tuple[float, float] | None = None
        for scale in scales:
            for i in range(len(LABEL_OFFSETS)):
                ox, oy = LABEL_OFFSETS[(start + i) % len(LABEL_OFFSETS)]
                ox *= scale
                oy *= scale
                tx = x + ox
                ty = y + oy
                box = (tx - w / 2, ty - h / 2, tx + w / 2, ty + h / 2)
                if any(_label_boxes_overlap(box, other, pad) for other in placed):
                    continue
                chosen = (ox, oy)
                placed.append(box)
                break
            if chosen is not None:
                break
        if chosen is None:
            ox, oy = LABEL_OFFSETS[start]
            chosen = (ox * 3.2, oy * 3.2)
            tx = x + chosen[0]
            ty = y + chosen[1]
            placed.append((tx - w / 2, ty - h / 2, tx + w / 2, ty + h / 2))
        out[hex_code] = chosen
    return out


def aircraft_is_emergency(ac: dict | None) -> bool:
    """True only for real emergencies — ADS-B often sends emergency=\"none\"."""
    ac = ac or {}
    if ac.get("isEmergency") is True:
        return True
    if ac.get("isEmergency") is False:
        return False
    squawk = str(ac.get("squawk") or "").strip()
    if squawk in EMERGENCY_SQUAWKS:
        return True
    emergency = str(ac.get("emergency") or "none").strip().lower()
    return bool(emergency) and emergency not in {"none", "null", "false", "0"}


def icon_color(ac: dict | None) -> str:
    ac = ac or {}
    if aircraft_is_emergency(ac):
        return COLOR_EMERGENCY
    icon = str(ac.get("iconClass") or "generic").lower()
    if icon in ("jet", "heavy"):
        return COLOR_JET
    if icon in ("light", "ga", "turboprop"):
        return COLOR_GA
    if icon in ("heli", "helicopter"):
        return COLOR_HELI
    return COLOR_GENERIC


def zoom_for_radius_nm(
    lat: float,
    radius_nm: float,
    diameter_px: float,
    *,
    max_zoom: int = 13,
    min_zoom: int = 6,
) -> int:
    """Largest OSM zoom where ``radius_nm`` still fits inside the scope circle."""
    target_px = max(32.0, float(diameter_px) * 0.46)
    radius_nm = max(1.0, float(radius_nm))
    lat = max(-85.0, min(85.0, float(lat)))
    for zoom in range(max_zoom, min_zoom - 1, -1):
        meters_per_px = 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)
        nm_per_px = meters_per_px / METERS_PER_NM
        if radius_nm / max(1e-9, nm_per_px) <= target_px:
            return zoom
    return min_zoom


def tone_map_image(image, width: int, height: int):
    """Resize + dark-tone a rectangular OSM stitch for the scope panel."""
    if Image is None or image is None:
        return None
    width = max(64, int(width))
    height = max(64, int(height))
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.BICUBIC)
    rect = image.resize((width, height), resample)
    from PIL import ImageEnhance

    rect = ImageEnhance.Brightness(rect).enhance(0.74)
    rect = ImageEnhance.Color(rect).enhance(0.58)
    navy = Image.new("RGB", rect.size, (11, 23, 48))
    return Image.blend(rect, navy, 0.28)


def circularize_map(image, diameter: int):
    """Legacy circular crop — kept for tests; runtime uses rectangular tone_map_image."""
    if Image is None or ImageDraw is None or image is None:
        return None
    diameter = max(64, int(diameter))
    square = tone_map_image(image, diameter, diameter)
    if square is None:
        return None
    rgba = square.convert("RGBA")
    mask = Image.new("L", (diameter, diameter), 0)
    ImageDraw.Draw(mask).ellipse((1, 1, diameter - 2, diameter - 2), fill=255)
    rgba.putalpha(mask)
    return rgba


def flat_nm_offset(lat: float, lon: float, ref_lat: float, ref_lon: float) -> tuple[float, float]:
    north_nm = (lat - ref_lat) / NM_TO_DEG_LAT
    east_nm = (lon - ref_lon) / NM_TO_DEG_LAT / max(0.01, math.cos(math.radians(ref_lat)))
    return north_nm, east_nm


def nm_offset_to_latlon(
    ref_lat: float,
    ref_lon: float,
    north_nm: float,
    east_nm: float,
) -> tuple[float, float]:
    lat = ref_lat + north_nm * NM_TO_DEG_LAT
    lon = ref_lon + east_nm * NM_TO_DEG_LAT / max(0.01, math.cos(math.radians(ref_lat)))
    return lat, lon


def dead_reckon_position(
    lat: float | None,
    lon: float | None,
    track_deg: float | None,
    gs_kt: float | None,
    elapsed_sec: float,
) -> tuple[float | None, float | None]:
    """Advance position along track at groundspeed (pure, no Tk)."""
    if lat is None or lon is None or elapsed_sec <= 0:
        return lat, lon
    try:
        speed = float(gs_kt or 0)
        track = float(track_deg or 0)
    except (TypeError, ValueError):
        return lat, lon
    if speed <= 0:
        return lat, lon
    dist_nm = speed * float(elapsed_sec) / 3600.0
    br = math.radians(track)
    north = dist_nm * math.cos(br)
    east = dist_nm * math.sin(br)
    return nm_offset_to_latlon(lat, lon, north, east)


def scope_xy_from_latlon(
    lat: float | None,
    lon: float | None,
    home_lat: float,
    home_lon: float,
    radius_nm: float,
    cx: float,
    cy: float,
    radius_px: float,
) -> tuple[tuple[float, float] | None, float]:
    if lat is None or lon is None or radius_nm <= 0:
        return None, 9999.0
    north_nm, east_nm = flat_nm_offset(lat, lon, home_lat, home_lon)
    dist_nm = math.hypot(north_nm, east_nm)
    if dist_nm > radius_nm:
        return None, dist_nm
    bearing = math.degrees(math.atan2(east_nm, north_nm)) % 360
    frac = dist_nm / radius_nm
    br = math.radians(bearing)
    x = cx + math.sin(br) * frac * radius_px
    y = cy - math.cos(br) * frac * radius_px
    return (x, y), dist_nm


def stale_opacity(age_sec: float | None) -> float:
    if age_sec is None:
        return 1.0
    if age_sec >= STALE_FADE_SEC:
        return 0.35
    if age_sec >= STALE_FREEZE_SEC:
        return 0.65
    return 1.0


def motion_frozen(age_sec: float | None) -> bool:
    return age_sec is not None and age_sec >= STALE_FREEZE_SEC


def format_list_footer(page_index: int, rows: int, total: int, next_in_sec: int) -> str:
    rows = max(1, int(rows or 1))
    total = max(0, int(total or 0))
    if total <= 0:
        return "No aircraft"
    start = page_index * rows + 1
    end = min(total, (page_index + 1) * rows)
    pages = roster_page_count(total, rows)
    if pages <= 1:
        return f"{start}–{end} of {total}"
    return f"{start}–{end} of {total} · next page in {max(0, int(next_in_sec))}s"


def page_seconds_remaining(
    page_seconds: float,
    started_at: float,
    *,
    now: float | None = None,
) -> int:
    """Whole seconds left until the next list page (ceil so 8→7→…→1→0)."""
    now_ts = time.time() if now is None else float(now)
    remaining = float(page_seconds) - (now_ts - float(started_at))
    if remaining <= 0:
        return 0
    return max(0, int(math.ceil(remaining - 1e-9)))


def _split_route_arrow(text: str) -> tuple[str, str]:
    raw = str(text or "").strip()
    if not raw:
        return "", ""
    for sep in (" → ", " -> ", "⟶", "▸", "→", "->"):
        if sep in raw:
            left, right = raw.split(sep, 1)
            return left.strip(), right.strip()
    return raw, ""


def route_label(ac: dict | None, routes_by_hex: dict | None = None) -> tuple[str, str]:
    """Return (origin, destination) from aircraft.route or overhead.routes[hex].

    Bridge enrichment may send a structured dict, a \"City → City\" string, or
    a parallel routes map keyed by hex.
    """
    ac = ac or {}
    route = ac.get("route")
    if isinstance(route, str):
        return _split_route_arrow(route)
    if isinstance(route, dict):
        origin = str(
            route.get("originCity") or route.get("originIata") or route.get("origin") or "",
        ).strip()
        dest = str(
            route.get("destCity") or route.get("destIata") or route.get("destination") or "",
        ).strip()
        if origin or dest:
            return origin, dest
        label = str(route.get("label") or "").strip()
        if label:
            return _split_route_arrow(label)
    hex_code = str(ac.get("hex") or "").strip().lower()
    if routes_by_hex and hex_code:
        entry = routes_by_hex.get(hex_code) or routes_by_hex.get(hex_code.upper())
        if isinstance(entry, str):
            return _split_route_arrow(entry)
        if isinstance(entry, dict):
            return route_label({"route": entry})
    return "", ""


class OverheadPanel(BasePanel):
    """Flight radar scope + paginated aircraft list."""

    BRAND_U = 22
    TITLE_U = (40, 34)
    ROW_U = (22, 20)
    META_U = 16
    FOOTER_U = 18

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._payload: dict = {}
        self._overhead: dict = {}
        self._roster: list[dict] = []
        self._page_index = 0
        self._page_started_at = 0.0
        self._page_seconds = 8
        self._page_job = None
        self._page_countdown_job = None
        self._footer_text_id = None
        self._motion_job = None
        self._ease_job = None
        self._last_update_at = 0.0
        self._display_positions: dict[str, tuple[float, float]] = {}
        self._target_positions: dict[str, tuple[float, float]] = {}
        self._ease_started_at = 0.0
        self._easing = False
        self._pulse_phase = 0
        self._scope_ids: list[int] = []
        self._list_ids: list[int] = []
        self._fonts: dict[str, tkfont.Font] = {}
        self._map_photo = None
        self._map_image_id = None
        self._map_request = 0
        self._map_meta: dict | None = None
        self._map_cache_key = None

    def hide(self):
        self._cancel_jobs()
        super().hide()
        self._scope_ids.clear()
        self._list_ids.clear()
        self._footer_text_id = None
        self._display_positions.clear()
        self._target_positions.clear()
        self._easing = False
        self._map_request += 1
        self._map_photo = None
        self._map_image_id = None
        self._map_meta = None
        self._map_cache_key = None

    def apply_update(self, payload: dict):
        """Refresh aircraft without tearing down the panel."""
        if not self.visible:
            return
        incoming = payload.get("overhead") or {}
        session = str(incoming.get("sessionId") or "")
        current = str(self._overhead.get("sessionId") or "")
        if session and current and session != current:
            return
        self._payload = payload
        merged = dict(self._overhead)
        merged.update(incoming)
        if incoming.get("aircraft") is not None:
            merged["aircraft"] = incoming["aircraft"]
        self._overhead = merged
        self._last_update_at = time.time()
        self._merge_aircraft_into_roster()
        self._recompute_targets()
        self._ease_started_at = time.time()
        self._easing = True
        self._schedule_ease()
        self._paint_all()
        self._schedule_page_countdown()

    def _cancel_jobs(self):
        for attr in ("_page_job", "_page_countdown_job", "_motion_job", "_ease_job"):
            job = getattr(self, attr, None)
            if job is not None:
                try:
                    self.root.after_cancel(job)
                except Exception:
                    pass
                setattr(self, attr, None)

    def _render(self, payload: dict):
        self._payload = payload
        self._overhead = dict(payload.get("overhead") or {})
        self._roster = freeze_roster(self._overhead.get("aircraft"))
        self._page_index = 0
        self._page_seconds = max(3, int(self._overhead.get("pageSeconds") or 8))
        self._page_started_at = time.time()
        self._last_update_at = self._parse_update_time(payload)
        self._display_positions.clear()
        self._target_positions.clear()
        self._recompute_targets(initial=True)
        self._ensure_fonts()
        self._paint_all()
        self._schedule_page_turn()
        self._schedule_page_countdown()
        self._schedule_motion()

    def _parse_update_time(self, payload: dict) -> float:
        from src.payload_utils import parse_iso_timestamp

        ts = payload.get("timestamp") or self._overhead.get("updatedAt")
        parsed = parse_iso_timestamp(ts)
        if parsed:
            return parsed.timestamp()
        return time.time()

    def _data_age_sec(self) -> float:
        if self._last_update_at <= 0:
            return 0.0
        return max(0.0, time.time() - self._last_update_at)

    def _merge_aircraft_into_roster(self):
        by_hex = {
            str(ac.get("hex") or "").strip().upper(): dict(ac)
            for ac in (self._overhead.get("aircraft") or [])
            if isinstance(ac, dict) and str(ac.get("hex") or "").strip()
        }
        merged: list[dict] = []
        for row in self._roster:
            key = str(row.get("hex") or "").strip().upper()
            merged.append(by_hex.pop(key, row) if key in by_hex else row)
        for ac in by_hex.values():
            merged.append(ac)
        self._roster = freeze_roster(merged)

    def _geometry(self) -> dict:
        screen_w = int(getattr(self.shell.overlay, "screen_w", 1080) or 1080)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 1920) or 1920)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        regions = compute_layout_regions(
            chrome.content_x,
            chrome.content_top,
            chrome.content_w,
            chrome.content_bottom - chrome.content_top,
            portrait=chrome.portrait,
        )
        regions["u"] = chrome.u
        regions["screen_w"] = screen_w
        regions["screen_h"] = screen_h
        regions["chrome"] = chrome
        return regions

    def _ensure_fonts(self):
        if self._fonts:
            return
        family = self.config.get("titleFontFamily", "Segoe UI")
        geo = self._geometry()
        u = geo["u"]
        portrait = geo["portrait"]
        self._fonts = {
            "brand": tkfont.Font(family=family, size=max(10, int(self.BRAND_U * u)), weight="bold"),
            "title": tkfont.Font(
                family=family,
                size=max(12, int((self.TITLE_U[0] if portrait else self.TITLE_U[1]) * u)),
                weight="bold",
            ),
            "row": tkfont.Font(
                family=family,
                size=max(10, int((self.ROW_U[0] if portrait else self.ROW_U[1]) * u)),
            ),
            "meta": tkfont.Font(family=family, size=max(9, int(self.META_U * u))),
            "footer": tkfont.Font(family=family, size=max(9, int(self.FOOTER_U * u))),
            "legend": tkfont.Font(family=family, size=max(8, int(14 * u))),
            "cardinal": tkfont.Font(family=family, size=max(11, int(18 * u)), weight="bold"),
        }

    def _home(self) -> tuple[float, float]:
        home = self._overhead.get("home") or {}
        try:
            lat = float(home.get("lat"))
            lon = float(home.get("lon"))
            return lat, lon
        except (TypeError, ValueError):
            return 40.0, -111.0

    def _radius_nm(self) -> float:
        try:
            return max(1.0, float(self._overhead.get("radiusNm") or 25))
        except (TypeError, ValueError):
            return 25.0

    def _scope_circle(self) -> tuple[float, float, float, tuple[float, float, float, float]]:
        geo = self._geometry()
        x0, y0, x1, y1 = geo["scope"]
        # Full scope rectangle is the map; the circle is only the focus/range
        # ring. In landscape the legend sits on the bottom edge — keep rings and
        # N/E/S/W clear of that band (map still fills the full rectangle).
        usable_y1 = y1
        if not geo["portrait"]:
            legend = geo["legend"]
            gap = max(10.0, float(geo.get("u") or 1) * 8)
            usable_y1 = min(y1, float(legend[1]) - gap)
        cx = (x0 + x1) / 2
        cy = (y0 + usable_y1) / 2
        radius_px = min(x1 - x0, usable_y1 - y0) / 2 * 0.90
        return cx, cy, radius_px, (x0, y0, x1, y1)

    def _project_aircraft(self, lat: float, lon: float) -> tuple[float, float] | None:
        cx, cy, radius_px, _box = self._scope_circle()
        meta = self._map_meta
        if meta:
            px, py = map_tiles.project_to_pixels(
                lat, lon,
                meta["center_lat"], meta["center_lon"], meta["zoom"],
                meta["box_w"], meta["box_h"],
            )
            x = meta["img_x0"] + px
            y = meta["img_y0"] + py
            if (x - cx) ** 2 + (y - cy) ** 2 > (radius_px * 1.02) ** 2:
                return None
            return x, y
        home_lat, home_lon = self._home()
        pos, _dist = scope_xy_from_latlon(
            lat, lon, home_lat, home_lon, self._radius_nm(), cx, cy, radius_px,
        )
        return pos

    def _recompute_targets(self, *, initial: bool = False):
        age = self._data_age_sec()
        frozen = motion_frozen(age)
        elapsed = 0.0 if frozen else min(age, STALE_FREEZE_SEC)

        targets: dict[str, tuple[float, float]] = {}
        for ac in self._roster:
            hex_code = str(ac.get("hex") or "").strip().upper()
            if not hex_code:
                continue
            try:
                lat = float(ac.get("lat"))
                lon = float(ac.get("lon"))
            except (TypeError, ValueError):
                continue
            if not frozen:
                track = ac.get("track")
                gs = ac.get("gsKt")
                lat, lon = dead_reckon_position(lat, lon, track, gs, elapsed)
            pos = self._project_aircraft(lat, lon)
            if pos is not None:
                targets[hex_code] = pos
        self._target_positions = targets
        if initial:
            self._display_positions = dict(targets)

    def _schedule_page_turn(self):
        if self._page_job is not None:
            try:
                self.root.after_cancel(self._page_job)
            except Exception:
                pass
            self._page_job = None
        pages = roster_page_count(len(self._roster), self._geometry()["rows"])
        if pages <= 1:
            return
        self._page_job = self.root.after(self._page_seconds * 1000, self._advance_page)

    def _schedule_page_countdown(self):
        if self._page_countdown_job is not None:
            try:
                self.root.after_cancel(self._page_countdown_job)
            except Exception:
                pass
            self._page_countdown_job = None
        pages = roster_page_count(len(self._roster), self._geometry()["rows"])
        if pages <= 1:
            return
        self._page_countdown_job = self.root.after(
            PAGE_COUNTDOWN_MS, self._on_page_countdown_tick,
        )

    def _on_page_countdown_tick(self):
        self._page_countdown_job = None
        if not self.visible:
            return
        self._refresh_list_footer()
        self._schedule_page_countdown()

    def _advance_page(self):
        if not self.visible:
            return
        pages = roster_page_count(len(self._roster), self._geometry()["rows"])
        self._page_index = (self._page_index + 1) % pages
        self._page_started_at = time.time()
        self._paint_list()
        self._paint_scope_aircraft()
        self._schedule_page_turn()
        self._schedule_page_countdown()

    def _schedule_motion(self):
        if self._motion_job is not None:
            try:
                self.root.after_cancel(self._motion_job)
            except Exception:
                pass
        self._motion_job = self.root.after(MOTION_MS, self._on_motion_tick)

    def _schedule_ease(self):
        if self._ease_job is not None:
            try:
                self.root.after_cancel(self._ease_job)
            except Exception:
                pass
        self._ease_job = self.root.after(MOTION_MS, self._on_ease_tick)

    def _on_motion_tick(self):
        if not self.visible:
            return
        self._motion_job = None
        age = self._data_age_sec()
        if not motion_frozen(age) and not self._easing:
            self._recompute_targets()
            self._step_positions(1.0)
        self._pulse_phase = (self._pulse_phase + 1) % 20
        self._paint_scope_aircraft()
        self._schedule_motion()

    def _on_ease_tick(self):
        if not self.visible:
            return
        self._ease_job = None
        elapsed_ms = (time.time() - self._ease_started_at) * 1000
        t = min(1.0, elapsed_ms / EASE_MS)
        t = 1 - (1 - t) ** 3
        self._step_positions(t)
        self._paint_scope_aircraft()
        if t < 1.0:
            self._schedule_ease()
        else:
            self._easing = False
            self._display_positions = dict(self._target_positions)

    def _step_positions(self, blend: float):
        blend = max(0.0, min(1.0, float(blend)))
        for hex_code, target in self._target_positions.items():
            current = self._display_positions.get(hex_code, target)
            x = current[0] + (target[0] - current[0]) * blend
            y = current[1] + (target[1] - current[1]) * blend
            self._display_positions[hex_code] = (x, y)
        stale = set(self._display_positions) - set(self._target_positions)
        for hex_code in stale:
            del self._display_positions[hex_code]

    def _paint_all(self):
        self._clear_layer()
        self._paint_header()
        self._paint_scope_static()
        self._paint_scope_aircraft()
        self._paint_legend()
        self._paint_list()
        # Map underlay is painted after the header; keep chrome readable.
        try:
            self.canvas.tag_raise("overhead-header")
            self.canvas.tag_raise("overhead-legend")
        except Exception:
            pass

    def _clear_layer(self):
        for item_id in list(self._item_ids):
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
        self._item_ids.clear()
        self._scope_ids.clear()
        self._list_ids.clear()

    def _paint_header(self):
        geo = self._geometry()
        chrome = geo["chrome"]
        u = geo["u"]
        title = str(self._overhead.get("title") or "Overhead")
        radius = self._radius_nm()
        subtitle = f"{radius:.0f} NM · {len(self._roster)} aircraft"
        x = chrome.content_x
        y = chrome.header_top + 4 * u
        brand_font = self._fonts["brand"]
        title_font = self._fonts["title"]
        meta_font = self._fonts["meta"]
        # Measure real glyph boxes — fixed u offsets were burying the subtitle
        # under the large "Overhead" display face.
        brand_h = brand_font.metrics("ascent") + brand_font.metrics("descent")
        title_h = title_font.metrics("ascent") + title_font.metrics("descent")
        meta_h = meta_font.metrics("ascent") + meta_font.metrics("descent")
        # Fit SIGNAL + title + subtitle inside the chrome header band.
        band_bottom = chrome.content_top - 4 * u
        avail = max(40.0, band_bottom - y)
        gap = max(2.0, 3 * u)
        stack = brand_h + gap + title_h + gap + meta_h
        if stack > avail:
            # Prefer keeping the subtitle readable over generous title leading.
            gap = max(1.0, (avail - brand_h - title_h - meta_h) / 2)
        self._item_ids.append(
            self.canvas.create_text(
                x, y, anchor="nw", text="SIGNAL", fill=INK_3,
                font=brand_font, tags=("overhead", "overhead-header"),
            ),
        )
        title_y = y + brand_h + gap
        self._item_ids.append(
            self.canvas.create_text(
                x, title_y, anchor="nw", text=title, fill=INK,
                font=title_font, tags=("overhead", "overhead-header"),
            ),
        )
        sub_y = title_y + title_h + gap
        self._item_ids.append(
            self.canvas.create_text(
                x, sub_y, anchor="nw", text=subtitle, fill=INK_2,
                font=meta_font, tags=("overhead", "overhead-header"),
            ),
        )
        age = self._data_age_sec()
        if age >= STALE_FREEZE_SEC:
            banner = "Provider data stale — positions frozen"
            self._item_ids.append(
                self.canvas.create_text(
                    chrome.content_x + chrome.content_w,
                    y,
                    anchor="ne",
                    text=banner,
                    fill=WARN,
                    font=meta_font,
                    tags=("overhead", "overhead-header"),
                ),
            )

    def _paint_scope_static(self):
        geo = self._geometry()
        x0, y0, x1, y1 = geo["scope"]
        cx, cy, radius_px, _box = self._scope_circle()
        self._scope_ids.append(
            self.canvas.create_rectangle(
                x0, y0, x1, y1, outline="", width=0, fill=BG, tags=("overhead", "scope"),
            ),
        )
        # Full rectangular map underlay; the circle is only the focus/range ring.
        self._start_scope_map_fetch(x0, y0, x1, y1, cx, cy, radius_px)
        # High-contrast rings so they stay readable over the toned OSM basemap.
        for frac in (0.25, 0.5, 0.75, 1.0):
            r = radius_px * frac
            if frac >= 1.0:
                outline, width = "#D7E4FF", 3
            elif frac >= 0.75:
                outline, width = "#B7C6E4", 2
            else:
                outline, width = "#8FA0C0", 2
            self._scope_ids.append(
                self.canvas.create_oval(
                    cx - r, cy - r, cx + r, cy + r,
                    outline=outline,
                    width=width, tags=("overhead", "scope", "ring"),
                ),
            )
        cardinal_font = self._fonts.get("cardinal") or self._fonts["legend"]
        # Keep cardinals outside the ring but inside the usable scope (above
        # the landscape legend band).
        cardinal_r = radius_px + max(12.0, min(20.0, radius_px * 0.04))
        legend = geo["legend"]
        for label, dx, dy in (("N", 0, -1), ("E", 1, 0), ("S", 0, 1), ("W", -1, 0)):
            lx = cx + dx * cardinal_r
            ly = cy + dy * cardinal_r
            if not geo["portrait"] and ly > float(legend[1]) - 4:
                ly = float(legend[1]) - max(14.0, float(geo.get("u") or 1) * 12)
            self._scope_ids.append(
                self.canvas.create_text(
                    lx, ly, text=label, fill=INK, font=cardinal_font,
                    tags=("overhead", "scope", "ring"),
                ),
            )
        self._scope_ids.append(
            self.canvas.create_oval(
                cx - 5, cy - 5, cx + 5, cy + 5, fill=ACCENT, outline=INK, width=1,
                tags=("overhead", "scope", "ring"),
            ),
        )
        self._draw_geo_polylines(cx, cy, radius_px)
        self._draw_airports(cx, cy, radius_px)
        self._item_ids.extend(self._scope_ids)

    def _start_scope_map_fetch(
        self, x0: float, y0: float, x1: float, y1: float,
        cx: float, cy: float, radius_px: float,
    ):
        if Image is None or ImageTk is None:
            return
        home_lat, home_lon = self._home()
        radius_nm = self._radius_nm()
        map_w = max(128, int(x1 - x0))
        map_h = max(128, int(y1 - y0))
        # Zoom so the configured radius still fits the inscribed focus circle.
        zoom = zoom_for_radius_nm(home_lat, radius_nm, radius_px * 2)
        cache_key = (round(home_lat, 4), round(home_lon, 4), round(radius_nm, 1), map_w, map_h, zoom)
        meta = {
            "center_lat": home_lat,
            "center_lon": home_lon,
            "zoom": zoom,
            "box_w": map_w,
            "box_h": map_h,
            "img_x0": x0,
            "img_y0": y0,
        }
        if cache_key == self._map_cache_key and self._map_photo is not None:
            self._place_scope_map(self._map_photo, cx, cy, meta)
            return

        self._map_request += 1
        request_id = self._map_request

        def worker():
            try:
                raw = map_tiles.fetch_map_tiles(home_lat, home_lon, zoom, map_w, map_h)
                toned = tone_map_image(raw, map_w, map_h)
            except Exception as error:
                map_tiles.log_map_error(f"overhead scope map failed: {error!r}")
                return
            if toned is None:
                return

            def apply():
                if not self.visible or request_id != self._map_request:
                    return
                photo = ImageTk.PhotoImage(toned)
                self._map_photo = photo
                self._map_cache_key = cache_key
                self._place_scope_map(photo, cx, cy, meta)
                self._recompute_targets(initial=True)
                self._paint_scope_aircraft()

            try:
                self.root.after(0, apply)
            except Exception:
                pass

        threading.Thread(target=worker, name="overhead-scope-map", daemon=True).start()

    def _place_scope_map(self, photo, cx: float, cy: float, meta: dict):
        self._map_meta = meta
        if self._map_image_id is not None:
            try:
                self.canvas.delete(self._map_image_id)
            except Exception:
                pass
            if self._map_image_id in self._scope_ids:
                self._scope_ids.remove(self._map_image_id)
            if self._map_image_id in self._item_ids:
                self._item_ids.remove(self._map_image_id)
        # Anchor at top-left of the scope rectangle so corners stay filled.
        img_id = self.canvas.create_image(
            meta["img_x0"], meta["img_y0"],
            anchor="nw", image=photo, tags=("overhead", "scope", "scope-map"),
        )
        self._map_image_id = img_id
        self._scope_ids.append(img_id)
        self._item_ids.append(img_id)
        try:
            self.canvas.tag_raise("ring")
            self.canvas.tag_raise("ac")
        except Exception:
            pass

    def _draw_geo_polylines(self, cx: float, cy: float, radius_px: float):
        geo_data = self._overhead.get("geo") or {}
        lines = geo_data.get("lines") or []
        for line in lines:
            points = []
            for pt in line if isinstance(line, list) else []:
                if not isinstance(pt, dict):
                    continue
                try:
                    lat = float(pt.get("lat"))
                    lon = float(pt.get("lon"))
                except (TypeError, ValueError):
                    continue
                pos = self._project_aircraft(lat, lon)
                if pos:
                    points.extend(pos)
            if len(points) >= 4:
                self._scope_ids.append(
                    self.canvas.create_line(
                        *points, fill="#5A6A88", width=1, smooth=True, tags=("overhead", "scope", "ring"),
                    ),
                )

    def _draw_airports(self, cx: float, cy: float, radius_px: float):
        for apt in self._overhead.get("airports") or []:
            if not isinstance(apt, dict):
                continue
            try:
                lat = float(apt.get("lat"))
                lon = float(apt.get("lon"))
            except (TypeError, ValueError):
                continue
            pos = self._project_aircraft(lat, lon)
            if not pos:
                continue
            x, y = pos
            code = str(apt.get("iata") or apt.get("icao") or "")[:3]
            self._scope_ids.append(
                self.canvas.create_rectangle(x - 3, y - 3, x + 3, y + 3, fill=INK_2, outline=""),
            )
            if code:
                self._scope_ids.append(
                    self.canvas.create_text(x + 8, y, anchor="w", text=code, fill=INK_2, font=self._fonts["legend"]),
                )

    def _paint_scope_aircraft(self):
        for item_id in list(self._scope_ids):
            tags = set(self.canvas.gettags(item_id))
            if "ac" in tags:
                try:
                    self.canvas.delete(item_id)
                except Exception:
                    pass
                if item_id in self._scope_ids:
                    self._scope_ids.remove(item_id)
                if item_id in self._item_ids:
                    self._item_ids.remove(item_id)

        highlight = page_highlight_hexes(self._roster, self._page_index, self._geometry()["rows"])
        age = self._data_age_sec()
        opacity = stale_opacity(age)

        draw_rows: list[tuple] = []
        label_anchors: list[tuple[str, float, float, str]] = []
        for ac in self._roster:
            hex_code = str(ac.get("hex") or "").strip().upper()
            if not hex_code:
                continue
            pos = self._display_positions.get(hex_code)
            if pos is None:
                continue
            x, y = pos
            on_page = bool(highlight) and hex_code in highlight
            label = aircraft_display_label(ac)
            try:
                alt = int(float(ac.get("altFt") or 0))
                fl = f" {alt // 100:03d}" if alt > 0 else ""
            except (TypeError, ValueError):
                fl = ""
            label_text = f"{label}{fl}"
            if on_page:
                label_anchors.append((hex_code, x, y, label_text))
            draw_rows.append((ac, hex_code, x, y, on_page, label_text))

        legend_font = self._fonts["legend"]
        char_w = max(6.0, float(legend_font.measure("0")))
        label_h = max(12.0, float(legend_font.metrics("linespace")))
        label_offsets = resolve_map_label_offsets(
            label_anchors, char_w=char_w * 0.92, height=label_h, pad=8.0,
        )

        for ac, hex_code, x, y, on_page, label_text in draw_rows:
            emergency = aircraft_is_emergency(ac)
            color = icon_color(ac)
            if emergency and self._pulse_phase < 10:
                color = COLOR_EMERGENCY
            elif not on_page:
                color = mix_hex(color, BG, 0.48)
            track = ac.get("track")
            try:
                track_f = float(track or 0)
            except (TypeError, ValueError):
                track_f = 0.0
            icon = str(ac.get("iconClass") or "generic").lower()
            scale = 1.0 if on_page else 0.82
            if on_page:
                halo = self.canvas.create_oval(
                    x - 16, y - 16, x + 16, y + 16, outline=color, width=2, tags=("overhead", "ac", "scope"),
                )
                self._scope_ids.append(halo)
                self._item_ids.append(halo)
            body = self._draw_aircraft_icon(x, y, track_f, icon, color, opacity, scale=scale)
            self._scope_ids.extend(body)
            self._item_ids.extend(body)
            if on_page or emergency:
                heading_len = 18 if on_page else 12
                br = math.radians(track_f)
                hx = x + math.sin(br) * heading_len
                hy = y - math.cos(br) * heading_len
                line = self.canvas.create_line(
                    x, y, hx, hy, fill=color, width=2, tags=("overhead", "ac", "scope"),
                )
                self._scope_ids.append(line)
                self._item_ids.append(line)
            if on_page:
                ox, oy = label_offsets.get(hex_code) or label_offset_for_hex(hex_code)
                text_id = self.canvas.create_text(
                    x + ox, y + oy,
                    text=label_text,
                    fill=INK,
                    font=legend_font,
                    tags=("overhead", "ac", "scope"),
                )
                self._scope_ids.append(text_id)
                self._item_ids.append(text_id)
        try:
            # Page/motion redraws recreate ac items after the legend was painted.
            self.canvas.tag_raise("overhead-legend")
        except Exception:
            pass

    def _draw_aircraft_icon(
        self,
        x: float,
        y: float,
        track_deg: float,
        icon_class: str,
        color: str,
        opacity: float,
        *,
        scale: float = 1.0,
    ) -> list[int]:
        scale = (1.0 if opacity >= 0.9 else 0.85) * max(0.5, float(scale))
        points = self._icon_points(icon_class, scale)
        rotated = []
        br = math.radians(track_deg)
        cos_b = math.cos(br)
        sin_b = math.sin(br)
        for px, py in points:
            rx = px * cos_b - py * sin_b
            ry = px * sin_b + py * cos_b
            rotated.extend((x + rx, y + ry))
        stipple = "" if opacity >= 0.95 else "gray50"
        item_id = self.canvas.create_polygon(
            *rotated,
            fill=color,
            outline=INK,
            width=1,
            stipple=stipple,
            tags=("overhead", "ac", "scope"),
        )
        return [item_id]

    @staticmethod
    def _icon_points(icon_class: str, scale: float) -> list[tuple[float, float]]:
        s = 10 * scale
        icon = str(icon_class or "generic").lower()
        if icon == "jet":
            return [(-s, 0), (0, -s * 0.35), (s, 0), (0, s * 0.35)]
        if icon in ("heli", "helicopter"):
            return [(-s * 0.9, 0), (0, -s * 0.25), (s * 0.5, 0), (0, s * 0.5), (-s * 0.3, s * 0.5)]
        if icon in ("light", "ga"):
            return [(-s * 0.8, 0), (0, -s * 0.2), (s * 0.7, 0), (0, s * 0.3)]
        return [(0, -s), (-s * 0.6, s * 0.5), (s * 0.6, s * 0.5)]

    def _paint_legend(self):
        geo = self._geometry()
        x0, y0, x1, y1 = geo["legend"]
        u = geo["u"]
        items = [
            ("Airliner", COLOR_JET),
            ("General aviation", COLOR_GA),
            ("Helicopter", COLOR_HELI),
            ("Emergency", COLOR_EMERGENCY),
        ]
        font = self._fonts["legend"]
        # Solid band so map/cardinals never show through the legend labels.
        self._item_ids.append(
            self.canvas.create_rectangle(
                x0, y0, x1, y1, fill=BG, outline="",
                tags=("overhead", "overhead-legend"),
            ),
        )
        swatch_w = max(14.0, 18 * u)
        swatch_h = max(8.0, 10 * u)
        gap_swatch = max(10.0, 12 * u)
        gap_item = max(18.0, 22 * u)
        # Lay out left→right: [swatch][gap][label][item gap]…
        widths = []
        for label, _color in items:
            widths.append(swatch_w + gap_swatch + font.measure(label))
        total = sum(widths) + gap_item * (len(items) - 1)
        start_x = x0 + max(0.0, ((x1 - x0) - total) / 2)
        cy = (y0 + y1) / 2
        x = start_x
        for (label, color), item_w in zip(items, widths):
            self._item_ids.append(
                self.canvas.create_rectangle(
                    x, cy - swatch_h / 2, x + swatch_w, cy + swatch_h / 2,
                    fill=color, outline="",
                    tags=("overhead", "overhead-legend"),
                ),
            )
            self._item_ids.append(
                self.canvas.create_text(
                    x + swatch_w + gap_swatch, cy, anchor="w",
                    text=label, fill=INK_2, font=font,
                    tags=("overhead", "overhead-legend"),
                ),
            )
            x += item_w + gap_item

    def _refresh_list_footer(self):
        """Update only the 'next page in Ns' text so it counts down every second."""
        if self._footer_text_id is None:
            return
        geo = self._geometry()
        rows = geo["rows"]
        total = len(self._roster)
        next_in = page_seconds_remaining(self._page_seconds, self._page_started_at)
        footer = format_list_footer(self._page_index, rows, total, next_in)
        try:
            self.canvas.itemconfigure(self._footer_text_id, text=footer)
        except Exception:
            self._footer_text_id = None

    def _paint_list(self):
        for item_id in list(self._list_ids):
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
            if item_id in self._item_ids:
                self._item_ids.remove(item_id)
        self._list_ids.clear()
        self._footer_text_id = None

        geo = self._geometry()
        x0, y0, x1, y1 = geo["list"]
        rows = geo["rows"]
        page_rows = roster_page_slice(self._roster, self._page_index, rows)
        # Reserve a clear footer band so pager text is never clipped by the
        # dismiss chrome / panel edge.
        footer_h = max(48.0, geo["u"] * 40)
        usable_bottom = y1 - footer_h
        row_h = max(44.0, (usable_bottom - y0) / rows)
        home_lat, home_lon = self._home()
        radius_nm = self._radius_nm()
        row_font = self._fonts["row"]
        meta_font = self._fonts["meta"]
        row_metrics = row_font.metrics()
        meta_metrics = meta_font.metrics()
        label_block = row_metrics["ascent"] + row_metrics["descent"]
        meta_block = meta_metrics["ascent"] + meta_metrics["descent"]
        line_gap = max(3.0, geo["u"] * 3)
        routes_by_hex = self._overhead.get("routes") or {}
        show_routes = self._overhead.get("showRoutes") is not False

        for i, ac in enumerate(page_rows):
            ry = y0 + i * row_h
            label = aircraft_display_label(ac)
            type_code = str(ac.get("typeCode") or "").strip().upper()
            if type_code:
                label = f"{label}  {type_code}"
            try:
                alt = int(float(ac.get("altFt") or 0))
            except (TypeError, ValueError):
                alt = 0
            try:
                gs = int(float(ac.get("gsKt") or 0))
            except (TypeError, ValueError):
                gs = 0
            try:
                dst = float(ac.get("dstNm"))
                bearing = str(ac.get("bearingLabel") or "").strip()
                dist_bit = f" · {dst:.1f} nm {bearing}".rstrip()
            except (TypeError, ValueError):
                dist_bit = ""
            meta = f"{alt:,} ft · {gs} kt{dist_bit}"
            origin, dest = route_label(ac, routes_by_hex) if show_routes else ("", "")
            has_route = bool(origin or dest)
            try:
                lat = float(ac.get("lat"))
                lon = float(ac.get("lon"))
            except (TypeError, ValueError):
                lat = lon = None
            if lat is not None and lon is not None:
                north, east = flat_nm_offset(lat, lon, home_lat, home_lon)
                dist = math.hypot(north, east)
            else:
                dist = 9999.0
            out_of_range = dist > radius_nm
            fill = COLOR_OUT_OF_RANGE if out_of_range else INK
            meta_fill = INK_3 if out_of_range else INK_2
            class_color = icon_color(ac)
            # Class accent rule on the left of each row.
            self._list_ids.append(
                self.canvas.create_rectangle(
                    x0, ry + 2, x0 + 4, ry + row_h - 6,
                    fill=class_color, outline="", tags=("overhead", "list"),
                ),
            )
            text_x = x0 + 12
            if has_route:
                stack_h = label_block + line_gap + meta_block + line_gap + meta_block
            else:
                stack_h = label_block + line_gap + meta_block
            label_y = ry + max(2.0, (row_h - stack_h) / 2)
            self._list_ids.append(
                self.canvas.create_text(
                    text_x, label_y, anchor="nw", text=label, fill=fill, font=row_font,
                    tags=("overhead", "list"),
                ),
            )
            cursor_y = label_y + label_block + line_gap
            if has_route:
                self._draw_route_chip(
                    text_x, cursor_y + meta_block / 2, origin, dest,
                    dim=out_of_range, max_right=x1 - 8,
                )
                cursor_y += meta_block + line_gap
            self._list_ids.append(
                self.canvas.create_text(
                    text_x, cursor_y, anchor="nw", text=meta, fill=meta_fill, font=meta_font,
                    tags=("overhead", "list"),
                ),
            )

        total = len(self._roster)
        pages = roster_page_count(total, rows)
        next_in = page_seconds_remaining(self._page_seconds, self._page_started_at)
        footer = format_list_footer(self._page_index, rows, total, next_in)
        footer_top = usable_bottom + 6
        self._footer_text_id = self.canvas.create_text(
            x0, footer_top, anchor="nw", text=footer, fill=INK_2, font=self._fonts["footer"],
            tags=("overhead", "list", "overhead-footer"),
        )
        self._list_ids.append(self._footer_text_id)
        if pages > 1:
            # Dots sit under the footer copy, still inside the reserved band.
            dot_y = min(y1 - 10, footer_top + self._fonts["footer"].metrics("linespace") + 8)
            visible_pages = min(pages, 12)
            start_page = 0
            if pages > visible_pages:
                start_page = max(0, min(self._page_index - visible_pages // 2, pages - visible_pages))
            dot_span = min(x1 - x0 - 20, visible_pages * 14)
            start_x = x0 + (x1 - x0 - dot_span) / 2
            for i in range(visible_pages):
                p = start_page + i
                cx = start_x + (i + 0.5) * (dot_span / visible_pages)
                fill = ACCENT if p == self._page_index else LINE
                self._list_ids.append(
                    self.canvas.create_oval(cx - 3, dot_y - 3, cx + 3, dot_y + 3, fill=fill, outline=""),
                )

        if total == 0:
            self._list_ids.append(
                self.canvas.create_text(
                    (x0 + x1) / 2,
                    (y0 + usable_bottom) / 2,
                    text="Clear skies",
                    fill=INK_2,
                    font=self._fonts["title"],
                ),
            )

        self._item_ids.extend(self._list_ids)

    def _draw_route_chip(
        self, left_x: float, cy: float, origin: str, dest: str, *, dim: bool, max_right: float | None = None,
    ):
        fill = INK_3 if dim else INK_2
        font = self._fonts["meta"]
        origin = origin or "—"
        dest = dest or "—"
        # Prefer city names; fall back to shorter codes when the row is too tight.
        max_right = left_x + 400 if max_right is None else max_right
        avail = max(40.0, max_right - left_x)
        sep = 14
        o_w = font.measure(origin)
        d_w = font.measure(dest)
        if o_w + sep + d_w > avail:
            # Prefer IATA-style short tokens already in the strings when cities are long.
            if len(origin) > 12:
                origin = origin[:10].rstrip() + "…"
            if len(dest) > 12:
                dest = dest[:10].rstrip() + "…"
            o_w = font.measure(origin)
            d_w = font.measure(dest)
        x = left_x
        self._list_ids.append(
            self.canvas.create_text(x, cy, anchor="w", text=origin, fill=fill, font=font),
        )
        tri_x = x + o_w + sep / 2
        self._list_ids.append(
            self.canvas.create_polygon(
                tri_x - 3, cy,
                tri_x + 4, cy - 4,
                tri_x + 4, cy + 4,
                fill=fill,
                outline="",
            ),
        )
        self._list_ids.append(
            self.canvas.create_text(x + o_w + sep, cy, anchor="w", text=dest, fill=fill, font=font),
        )
