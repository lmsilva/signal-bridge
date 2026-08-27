"""Flight Plan overlay — ``flightplan.flight`` UDP payload."""

from __future__ import annotations

import math
import threading
import tkinter as tk
from datetime import datetime

from src.design_system import ACCENT, ALERT, BG, GOOD, INK, INK_2, INK_3, LINE, TRACK, WARN, page_chrome
from src.display_panels import BasePanel

STATUS_COLORS = {
    "good": GOOD,
    "accent": ACCENT,
    "warn": WARN,
    "alert": ALERT,
    "muted": INK_3,
}


def format_flight_number(airline: str, number: str) -> str:
    """``DL 167`` — space between code and number."""
    code = str(airline or "").strip().upper()
    num = str(number or "").strip()
    return f"{code} {num}".strip()


def format_route(origin: dict | None, destination: dict | None) -> str:
    o = str((origin or {}).get("iata") or (origin or {}).get("icao") or "—").upper()
    d = str((destination or {}).get("iata") or (destination or {}).get("icao") or "—").upper()
    return f"{o} \u2192 {d}"


def format_as_of(iso_text: str | None) -> str:
    text = str(iso_text or "").strip()
    if not text:
        return "as of —"
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return f"as of {dt.strftime('%H:%M')}"
    except ValueError:
        return "as of —"


def status_color(payload: dict) -> str:
    token = str((payload.get("status") or {}).get("colorToken") or "muted").lower()
    return STATUS_COLORS.get(token, INK_3)


def layout_bands(
    screen_w: int,
    screen_h: int,
    *,
    portrait: bool | None = None,
) -> dict[str, tuple[float, float, float, float]]:
    """Return band boxes ``(x0, y0, x1, y1)`` for portrait or landscape."""
    chrome = page_chrome(screen_w, screen_h, timed=True)
    u = chrome.u
    portrait = chrome.portrait if portrait is None else portrait
    left = chrome.content_x
    right = chrome.content_x + chrome.content_w
    top = chrome.content_top + (8 * u)
    bottom = chrome.content_bottom - (52 * u)
    width = right - left
    mid = left + width * (0.42 if not portrait else 1.0)
    stage_left = mid + (12 * u) if not portrait else left
    stage_width = (right - stage_left) if not portrait else width
    y = top
    header_h = 36 * u
    identity_h = 56 * u
    status_h = 24 * u
    detail_h = 88 * u
    progress_h = 28 * u
    left_col_bottom = y + header_h + identity_h + status_h + detail_h + progress_h + (24 * u)
    stage_top = top + header_h
    stage_bottom = bottom - (8 * u) if portrait else bottom
    bands = {
        "header": (left, y, right, y + header_h),
        "identity": (left, y + header_h, mid if not portrait else right, y + header_h + identity_h),
        "status": (left, y + header_h + identity_h, mid if not portrait else right, y + header_h + identity_h + status_h),
        "detail": (
            left,
            y + header_h + identity_h + status_h,
            mid if not portrait else right,
            y + header_h + identity_h + status_h + detail_h,
        ),
        "progress": (
            left,
            y + header_h + identity_h + status_h + detail_h,
            mid if not portrait else right,
            y + header_h + identity_h + status_h + detail_h + progress_h,
        ),
        "stage": (stage_left, stage_top, stage_left + stage_width, stage_bottom if not portrait else stage_top + 220 * u),
        "footer": (left, bottom - (40 * u), right, bottom),
    }
    if portrait:
        sy = bands["progress"][3] + (16 * u)
        bands["stage"] = (left, sy, right, sy + 220 * u)
    return bands


def airport_detail(label: str, flight: dict, side: str, kind: str) -> tuple[str, str]:
    """Return ``(time_line, airport_line)`` for depart/arrive columns."""
    scheduled = (flight.get("scheduled") or {})
    latest = (flight.get("latest") or {})
    dep = latest.get("departure") or {}
    arr = latest.get("arrival") or {}
    if side == "depart":
        sched = str(scheduled.get("departure") or dep.get("scheduledTime", {}).get("local") or "—")
        est = str(dep.get("revisedTime", {}).get("local") or dep.get("estimatedTime", {}).get("local") or sched)
        ap = flight.get("origin") or {}
        gate = dep.get("gate") or ap.get("gate") or ""
    else:
        sched = str(scheduled.get("arrival") or arr.get("scheduledTime", {}).get("local") or "—")
        est = str(arr.get("revisedTime", {}).get("local") or arr.get("estimatedTime", {}).get("local") or sched)
        ap = flight.get("destination") or {}
        gate = arr.get("gate") or arr.get("baggageBelt") or ap.get("gate") or ""
    sched_short = sched[-8:-3] if len(sched) >= 8 else sched
    est_short = est[-8:-3] if len(est) >= 8 else est
    if sched_short == est_short:
        time_line = sched_short
    else:
        time_line = f"{sched_short} \u2192 {est_short}"
    code = str(ap.get("iata") or ap.get("icao") or "—").upper()
    extra = f" · gate {gate}" if gate else ""
    if kind == "visitor" and side == "depart":
        code = str((flight.get("origin") or {}).get("iata") or code).upper()
    return time_line, f"{code}{extra}"


class FlightPlanPanel(BasePanel):
    """Six-band Flight Plan layout per bridge design doc."""

    STAGE_FILL = "#08122A"

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._map_photo = None
        self._image_photo = None
        self._request_id = 0

    def hide(self):
        self._request_id += 1
        self._map_photo = None
        self._image_photo = None
        super().hide()

    def show(self, payload: dict, *, remaining: float | None = None):
        self._request_id += 1
        request_id = self._request_id
        super().show(payload, remaining=remaining)
        self._draw(payload)
        self._load_stage_async(payload, request_id)

    def _draw(self, payload: dict):
        w = self.canvas.winfo_width() or self.root.winfo_width()
        h = self.canvas.winfo_height() or self.root.winfo_height()
        bands = layout_bands(w, h)
        trip = payload.get("trip") or {}
        flight = payload.get("flight") or {}
        status = payload.get("status") or {}
        stage = payload.get("stage") or {}
        color = status_color(payload)

        # Header
        x0, y0, x1, y1 = bands["header"]
        title = str(trip.get("title") or "upcoming flight")
        self.canvas.create_text(x0, y0 + 4, anchor="nw", text=title, fill=INK_2, font=self.shell.chip_label_font)
        self.canvas.create_text(x1, y0 + 4, anchor="ne", text=str(trip.get("name") or ""), fill=INK_3, font=self.shell.chip_label_font)
        self.canvas.create_line(x0, y1 - 2, x1, y1 - 2, fill=LINE)

        # Identity
        x0, y0, x1, y1 = bands["identity"]
        fn = format_flight_number(flight.get("airline"), flight.get("number"))
        self.canvas.create_text(x0, y0 + 4, anchor="nw", text=fn, fill=ACCENT, font=self.shell.title_font)
        route = format_route(flight.get("origin"), flight.get("destination"))
        self.canvas.create_text(x0, y0 + 34, anchor="nw", text=route, fill=INK, font=self.shell.forecast_value_font)

        # Status
        x0, y0, x1, y1 = bands["status"]
        self.canvas.create_text(x0, y0, anchor="nw", text=str(status.get("displayLine") or ""), fill=color, font=self.shell.forecast_label_font)

        # Detail columns
        x0, y0, x1, y1 = bands["detail"]
        col_w = (x1 - x0) / 2
        kind = str(trip.get("kind") or "ours")
        for idx, side in enumerate(("depart", "arrive")):
            cx = x0 + col_w * idx + 8
            label = "DEPART" if side == "depart" else "ARRIVE"
            self.canvas.create_text(cx, y0, anchor="nw", text=label, fill=INK_3, font=self.shell.chip_label_font)
            tline, aline = airport_detail(label, flight, side, kind)
            self.canvas.create_text(cx, y0 + 18, anchor="nw", text=tline, fill=color if "→" in tline else INK, font=self.shell.forecast_value_font)
            self.canvas.create_text(cx, y0 + 44, anchor="nw", text=aline, fill=INK_2, font=self.shell.chip_label_font)

        # Progress bar
        x0, y0, x1, y1 = bands["progress"]
        note = str(stage.get("note") or "not departed")
        self.canvas.create_text(x0, y0, anchor="nw", text=note, fill=INK_3, font=self.shell.chip_label_font)
        bar_y = y0 + 16
        self.canvas.create_rectangle(x0, bar_y, x1, bar_y + 8, fill=TRACK, outline="")
        frac = 0.35 if stage.get("mode") == "live" else (0.15 if stage.get("mode") == "estimated" else 0.0)
        if flight.get("state") == "landed":
            frac = 1.0
        bar_color = GOOD if flight.get("state") == "landed" else ACCENT
        self.canvas.create_rectangle(x0, bar_y, x0 + (x1 - x0) * frac, bar_y + 8, fill=bar_color, outline="")

        # Stage box placeholder
        sx0, sy0, sx1, sy1 = bands["stage"]
        self._panel_card(sx0, sy0, sx1 - sx0, sy1 - sy0, fill=self.STAGE_FILL)
        self.canvas.create_text((sx0 + sx1) / 2, (sy0 + sy1) / 2, anchor="center", text="…", fill=INK_3, font=self.shell.forecast_label_font, tags=("fp-stage",))

        # Quota / footer
        if payload.get("waitingForQuota"):
            fx0, fy0, fx1, _ = bands["footer"]
            self.canvas.create_text(fx0, fy0 - 18, anchor="nw", text="waiting for quota", fill=INK_3, font=self.shell.chip_label_font)
        fx0, fy0, fx1, fy1 = bands["footer"]
        self.canvas.create_line(fx0, fy0, fx1, fy0, fill=LINE)
        self.canvas.create_text(fx1, fy0 + 8, anchor="ne", text=format_as_of(payload.get("asOf")), fill=INK_3, font=self.shell.chip_label_font)

    def _load_stage_async(self, payload: dict, request_id: int):
        stage = payload.get("stage") or {}
        mode = str(stage.get("mode") or "preflight")
        if mode in ("live", "estimated", "ground"):
            threading.Thread(target=self._fetch_map, args=(payload, request_id), daemon=True).start()
        elif stage.get("imageUrl"):
            threading.Thread(target=self._fetch_image, args=(stage.get("imageUrl"), request_id), daemon=True).start()

    def _fetch_map(self, payload: dict, request_id: int):
        try:
            from src import map_tiles
            from PIL import ImageDraw, ImageTk

            flight = payload.get("flight") or {}
            route = payload.get("stage", {}).get("route") or {}
            origin = route.get("origin") or flight.get("origin") or {}
            dest = route.get("destination") or flight.get("destination") or {}
            lat1, lon1 = float(origin.get("lat")), float(origin.get("lon"))
            lat2, lon2 = float(dest.get("lat")), float(dest.get("lon"))
            w = max(320, self.canvas.winfo_width())
            h = 220
            zoom, center_lat, center_lon = map_tiles.zoom_to_fit(lat1, lon1, lat2, lon2, w, h)
            img = map_tiles.fetch_map_tiles(center_lat, center_lon, zoom, w, h)
            draw = ImageDraw.Draw(img)
            pos = (payload.get("stage") or {}).get("position") or {}
            if pos.get("lat") is not None and pos.get("lon") is not None:
                px, py = map_tiles.project_to_pixels(
                    float(pos["lat"]), float(pos["lon"]),
                    center_lat, center_lon, zoom, w, h,
                )
                draw.ellipse((px - 5, py - 5, px + 5, py + 5), fill=ACCENT)
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return

        def apply():
            if not self.visible or request_id != self._request_id:
                return
            self.canvas.delete("fp-stage")
            sx0, sy0, sx1, sy1 = layout_bands(self.canvas.winfo_width(), self.canvas.winfo_height())["stage"]
            self._map_photo = photo
            self.canvas.create_image((sx0 + sx1) / 2, (sy0 + sy1) / 2, image=photo, tags=("fp-stage",))

        self.root.after(0, apply)

    def _fetch_image(self, url: str, request_id: int):
        try:
            import io
            import urllib.request
            from PIL import Image, ImageTk

            with urllib.request.urlopen(str(url), timeout=12) as resp:
                raw = resp.read()
            img = Image.open(io.BytesIO(raw))
            sx0, sy0, sx1, sy1 = layout_bands(self.canvas.winfo_width(), self.canvas.winfo_height())["stage"]
            box_w = int(sx1 - sx0 - 8)
            box_h = int(sy1 - sy0 - 8)
            img.thumbnail((box_w, box_h), Image.Resampling.LANCZOS)
            photo = ImageTk.PhotoImage(img)
        except Exception:
            return

        def apply():
            if not self.visible or request_id != self._request_id:
                return
            self.canvas.delete("fp-stage")
            sx0, sy0, sx1, sy1 = layout_bands(self.canvas.winfo_width(), self.canvas.winfo_height())["stage"]
            self._image_photo = photo
            self.canvas.create_image((sx0 + sx1) / 2, (sy0 + sy1) / 2, image=photo, tags=("fp-stage",))

        self.root.after(0, apply)
