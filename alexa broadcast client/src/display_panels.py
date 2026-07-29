import io
import math
import re
import sys
import threading
import time
import tkinter as tk
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from tkinter import font as tkfont

try:
    from PIL import Image, ImageTk
except ImportError:  # Pillow ships with the client, but degrade gracefully.
    Image = None
    ImageTk = None

from src import map_tiles, place_facts, weather_fetch
from src.message_scroll import MessageScrollController
from src.paths import asset_path
from src.text_marquee import MarqueeLine
from src.payload_utils import (
    battery_level_color,
    format_battery_percent,
    format_chip_timestamp,
    format_duration,
    format_indoor_location,
    format_local_time_at_offset,
    format_route_distance,
    format_route_duration,
    shorten_route_place_name,
    format_timer_clock,
    format_timer_set_label,
    format_timer_ends_label,
    format_music_progress_label,
    music_remaining_seconds,
    timer_display_label,
    format_alarm_time,
    format_alarm_clock_parts,
    format_alarm_in_compact,
    format_alarm_recurrence_chip,
    resolve_alarm_trigger_time,
    format_alarm_date,
    alarm_title,
    alarm_detail_line,
    alarm_until_line,
    format_weather_location,
    format_air_quality_location,
    air_quality_band,
    air_quality_band_label,
    indoor_comfort_band,
    normalize_condition,
    parse_iso_timestamp,
    processing_stage_message,
    resolve_time_display_datetime,
    parse_qualitative_air_quality_band,
    parse_spoken_air_quality,
    parse_spoken_battery_percent,
    parse_spoken_indoor,
    parse_spoken_weather,
    format_limit_reset_time,
    format_freshness_sec,
    format_cached_time_label,
    format_charge_time_to_full,
    format_tesla_media_volume_label,
    format_temperature_f,
    sample_hourly_indices,
    timer_detail_line,
    timer_label_name,
    timer_title,
    voc_band_label,
)


class BasePanel:
    needs_scroll = False
    scroller = None

    # Design-system palette (display-design-system.md §1.3–1.4).
    GREEN = "#6EE7A8"
    GREEN_BG = "#123524"
    AMBER = "#F5C453"
    AMBER_BG = "#3a2605"
    RED = "#FF7A6B"
    RED_BG = "#3f1220"
    CONTAINER = "#0B1730"
    CARD = "#141F35"
    CARD_EDGE = "#264060"
    INNER = "#0a111e"

    def __init__(self, root: tk.Tk, shell, config: dict):
        self.root = root
        self.shell = shell
        self.config = config
        self.canvas = shell.content_canvas
        self.visible = False
        self._item_ids: list[int] = []
        self._widgets: list[tk.Widget] = []

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        self._render(payload)

    def hide(self):
        self.visible = False
        self._stop_tick()
        for item_id in self._item_ids:
            self.canvas.delete(item_id)
        self._item_ids.clear()
        for widget in self._widgets:
            widget.place_forget()
        self._widgets.clear()

    def _stop_tick(self):
        if getattr(self, "_tick_job", None):
            self.root.after_cancel(self._tick_job)
            self._tick_job = None

    def _track(self, item_id: int) -> int:
        self._item_ids.append(item_id)
        return item_id

    def _place_widget(self, widget: tk.Widget, **kwargs):
        widget.place(**kwargs)
        self._widgets.append(widget)

    def _round_rect(self, x0, y0, x1, y1, *, radius=0, fill="", outline="", width=1, dash=None):
        """Sharp cards by default (design-system radius 0)."""
        radius = max(0, min(int(radius), int(x1 - x0) // 2, int(y1 - y0) // 2))
        if radius <= 0:
            kwargs = {"fill": fill, "outline": outline or fill, "width": width}
            if dash:
                # Canvas rectangle doesn't support dash the same way; fall through.
                pass
            else:
                return self._track(self.canvas.create_rectangle(x0, y0, x1, y1, **kwargs))
        points = [
            x0 + radius, y0, x1 - radius, y0, x1, y0, x1, y0 + radius,
            x1, y1 - radius, x1, y1, x1 - radius, y1, x0 + radius, y1,
            x0, y1, x0, y1 - radius, x0, y0 + radius, x0, y0,
        ]
        kwargs = {"smooth": True, "fill": fill, "outline": outline, "width": width}
        if dash:
            kwargs["dash"] = dash
        return self._track(self.canvas.create_polygon(points, **kwargs))

    def _panel_card(self, x, y, w, h, *, radius=0, fill=None, outline=None, dash=None):
        return self._round_rect(
            x, y, x + w, y + h,
            radius=radius,
            fill=self.CARD if fill is None else fill,
            outline=self.CARD_EDGE if outline is None else outline,
            dash=dash,
        )

    def _container_frame(self, x, y, w, h, *, pad=20, radius=0):
        """Full-bleed content plate (no rounded chrome; never into dismiss footer)."""
        return self._round_rect(
            x - pad, y - 14, x + w + pad, y + h,
            radius=radius, fill=self.CONTAINER, outline=self.CARD_EDGE,
        )

    def _pill(self, x, y, label, *, fill, fg, anchor="nw", font=None, outline=None):
        font = font or self.shell.forecast_label_font
        text_w = font.measure(label)
        text_h = font.metrics("linespace")
        pad_x, pad_y = 12, 5
        w = text_w + pad_x * 2
        h = text_h + pad_y * 2
        if anchor == "ne":
            x0 = x - w
        elif anchor == "n":
            x0 = x - w // 2
        else:
            x0 = x
        # Square chips (radius 0) — design system forbids rounded-full pills.
        self._round_rect(x0, y, x0 + w, y + h, radius=0, fill=fill, outline=outline or fill)
        self._track(
            self.canvas.create_text(
                x0 + w // 2, y + h // 2, anchor="center", text=label, fill=fg, font=font,
            )
        )
        return h

    def _draw_dashboard_tile(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        label: str,
        value: str,
        *,
        chip: str,
        text: str,
        muted: str,
        accent: str,
        sublabel: str | None = None,
    ):
        self._panel_card(x, y, width, height, fill=chip)
        self._track(
            self.canvas.create_text(
                x + 16,
                y + 14,
                anchor="nw",
                text=label,
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                x + 16,
                y + height // 2 + 4,
                anchor="w",
                text=value,
                fill=accent,
                font=self.shell.chip_value_font,
            )
        )
        if sublabel:
            self._track(
                self.canvas.create_text(
                    x + 16,
                    y + height - 14,
                    anchor="sw",
                    text=sublabel,
                    fill=text,
                    font=self.shell.forecast_detail_font,
                )
            )


class BroadcastPanel(BasePanel):
    # Vertical gap between the bottom of the FROM/TO/TIME chip row and the
    # scrolling message text below it.
    CHIP_MESSAGE_GAP = 24

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self.needs_scroll = False
        self.scroller = None
        self.chip_value_ids = []
        self._message_top = 0
        self._message_viewport_height = 0
        self._build_viewport()

    def _build_viewport(self):
        layout = self.shell.layout
        # This panel is the only one that still renders the chip row, so its
        # message area must start below the chips (other panels start their
        # content at layout.message_area_top, right under the title).
        self._message_top = layout.chip_y + layout.chip_height + self.CHIP_MESSAGE_GAP
        self._message_viewport_height = max(80, layout.message_area_bottom - self._message_top)
        self.message_viewport = tk.Canvas(
            self.root,
            width=layout.message_content_width,
            height=self._message_viewport_height,
            highlightthickness=0,
            bd=0,
            bg=self.config["overlayBackground"],
        )
        self.message_text_id = self.message_viewport.create_text(
            layout.message_center_x,
            0,
            anchor="n",
            text="",
            fill=self.config["textColor"],
            font=self.shell.message_font,
            width=layout.message_content_width,
            justify="center",
        )
        self.scroller = MessageScrollController(
            self.message_viewport,
            self.message_text_id,
            self.config,
            self.root,
            on_finish=self.shell.overlay.hide,
        )

    def _build_chips(self):
        layout = self.shell.layout
        chip_fill = self.config.get("chipBackground", "#141a24")
        self.chip_value_ids = []

        for index, label in enumerate(("FROM", "TO", "TIME")):
            chip_x = layout.content_x + index * (layout.chip_width + layout.chip_gap)
            self._round_rect(
                chip_x,
                layout.chip_y,
                chip_x + layout.chip_width,
                layout.chip_y + layout.chip_height,
                radius=0,
                fill=self.CARD,
                outline=self.CARD_EDGE,
            )
            self._track(
                self.canvas.create_text(
                    chip_x + layout.chip_width // 2,
                    layout.chip_y + 22,
                    anchor="center",
                    text=label,
                    fill=self.config["mutedTextColor"],
                    font=self.shell.chip_label_font,
                )
            )
            value_id = self._track(
                self.canvas.create_text(
                    chip_x + layout.chip_width // 2,
                    layout.chip_y + layout.chip_height // 2 + 10,
                    anchor="center",
                    text="—",
                    fill=self.config["textColor"],
                    font=self.shell.chip_value_font,
                    width=layout.chip_width - 20,
                    justify="center",
                )
            )
            self.chip_value_ids.append(value_id)

    def hide(self):
        self.visible = False
        for item_id in self._item_ids:
            self.canvas.delete(item_id)
        self._item_ids.clear()
        self.chip_value_ids = []
        if self.message_viewport:
            self.message_viewport.place_forget()
        if self.scroller:
            self.scroller.stop()
        self.needs_scroll = False

    def _render(self, payload: dict):
        self._build_chips()
        layout = self.shell.layout
        sender = payload.get("sender", "Unknown")
        destination = payload.get("destination", "All devices")
        timestamp = format_chip_timestamp(payload.get("timestamp", ""))
        message = payload.get("message", "")

        for item_id, value in zip(self.chip_value_ids, (sender, destination, timestamp)):
            self.canvas.itemconfigure(item_id, text=value)

        self.needs_scroll = self.scroller.configure(
            message,
            center_x=layout.message_center_x,
            viewport_height=self._message_viewport_height,
        )
        self._place_widget(
            self.message_viewport,
            x=layout.content_x + 24,
            y=self._message_top,
        )


class TimePanel(BasePanel):
    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._display_dt: datetime | None = None

    def hide(self):
        if self._tick_job:
            self.root.after_cancel(self._tick_job)
            self._tick_job = None
        super().hide()

    def _resolve_datetime(self, payload: dict) -> datetime:
        return resolve_time_display_datetime(payload)

    def _render(self, payload: dict):
        self._display_dt = self._resolve_datetime(payload)
        self._draw_clock(payload)
        self._schedule_tick()

    def _schedule_tick(self):
        if self._tick_job:
            self.root.after_cancel(self._tick_job)
        self._tick_job = self.root.after(1000, self._on_tick)

    def _on_tick(self):
        if not self.visible:
            return
        self._display_dt = datetime.now().astimezone()
        self._draw_clock(self._last_payload)
        self._schedule_tick()

    def _draw_clock(self, payload: dict):
        self._last_payload = payload
        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()

        layout = self.shell.layout
        center_x = layout.content_x + layout.content_width // 2
        center_y = layout.message_area_top + int(layout.message_viewport_height * 0.34)
        radius = min(layout.content_width, layout.message_viewport_height) // 4

        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]

        self._track(
            self.canvas.create_oval(
                center_x - radius - 14,
                center_y - radius - 14,
                center_x + radius + 14,
                center_y + radius + 14,
                fill=self.INNER,
                outline=self.CARD_EDGE,
                width=1,
            )
        )
        self._track(
            self.canvas.create_oval(
                center_x - radius,
                center_y - radius,
                center_x + radius,
                center_y + radius,
                fill=self.CARD,
                outline=accent,
                width=3,
            )
        )

        for index in range(12):
            angle = math.radians(index * 30 - 90)
            outer = radius - 8
            inner = radius - (22 if index % 3 == 0 else 14)
            self._track(
                self.canvas.create_line(
                    center_x + inner * math.cos(angle),
                    center_y + inner * math.sin(angle),
                    center_x + outer * math.cos(angle),
                    center_y + outer * math.sin(angle),
                    fill=muted if index % 3 else text,
                    width=3 if index % 3 == 0 else 2,
                )
            )

        dt = self._display_dt or datetime.now().astimezone()
        hour_angle = math.radians((dt.hour % 12 + dt.minute / 60) * 30 - 90)
        minute_angle = math.radians(dt.minute * 6 - 90)
        second_angle = math.radians(dt.second * 6 - 90)

        self._track(
            self.canvas.create_line(
                center_x, center_y,
                center_x + (radius * 0.55) * math.cos(hour_angle),
                center_y + (radius * 0.55) * math.sin(hour_angle),
                fill=text,
                width=6,
                capstyle=tk.ROUND,
            )
        )
        self._track(
            self.canvas.create_line(
                center_x, center_y,
                center_x + (radius * 0.72) * math.cos(minute_angle),
                center_y + (radius * 0.72) * math.sin(minute_angle),
                fill=accent,
                width=4,
                capstyle=tk.ROUND,
            )
        )
        self._track(
            self.canvas.create_line(
                center_x, center_y,
                center_x + (radius * 0.82) * math.cos(second_angle),
                center_y + (radius * 0.82) * math.sin(second_angle),
                fill=self.config.get("titleAccentColor", accent),
                width=2,
                capstyle=tk.ROUND,
            )
        )
        self._track(self.canvas.create_oval(center_x - 6, center_y - 6, center_x + 6, center_y + 6, fill=accent, outline=""))

        digital_y = center_y + radius + 48
        self._track(
            self.canvas.create_text(
                center_x,
                digital_y,
                anchor="n",
                text=dt.strftime("%I:%M:%S %p").lstrip("0"),
                fill=text,
                font=self.shell.digital_time_font,
            )
        )
        self._track(
            self.canvas.create_text(
                center_x,
                digital_y + self.shell.digital_time_font.metrics("linespace") + 8,
                anchor="n",
                text=dt.strftime("%A, %B %d, %Y"),
                fill=muted,
                font=self.shell.date_font,
            )
        )

        device = payload.get("device", "Unknown device")
        pill_font = self.shell.chip_value_font
        pill_h = pill_font.metrics("linespace") + 10
        self._pill(
            center_x,
            layout.message_area_bottom - pill_h - 8,
            f"Asked on {device}",
            fill=self.CARD, fg=muted, outline=self.CARD_EDGE,
            anchor="n", font=pill_font,
        )


class ProcessingPanel(BasePanel):
    """Instant acknowledgment while the bridge fetches slow external-API data.

    Shows an animated spinner with staged reassurance messages (from the
    payload) and flips to a timeout/failure state if the real data never
    arrives. The real payload simply replaces this panel when it lands.
    """

    TICK_MS = 90
    DEFAULT_TIMEOUT_SEC = 45

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._started_at = 0.0
        self._spinner_angle = 0.0
        self._payload: dict = {}
        self._timed_out = False

    def _render(self, payload: dict):
        self._payload = payload
        self._started_at = time.time()
        self._spinner_angle = 0.0
        self._timed_out = False
        self._draw()
        self._schedule_tick()

    def _schedule_tick(self):
        self._stop_tick()
        self._tick_job = self.root.after(self.TICK_MS, self._on_tick)

    def _on_tick(self):
        if not self.visible:
            return
        self._spinner_angle = (self._spinner_angle - 9) % 360
        self._draw()
        if not self._timed_out:
            self._schedule_tick()

    def _elapsed_sec(self) -> float:
        return max(0.0, time.time() - self._started_at)

    def _timeout_sec(self) -> float:
        request = self._payload.get("request") or {}
        try:
            value = float(request.get("timeoutSeconds"))
        except (TypeError, ValueError):
            return float(self.DEFAULT_TIMEOUT_SEC)
        return value if value > 0 else float(self.DEFAULT_TIMEOUT_SEC)

    def _draw(self):
        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()

        layout = self.shell.layout
        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]

        request = self._payload.get("request") or {}
        elapsed = self._elapsed_sec()
        timed_out = elapsed >= self._timeout_sec()
        self._timed_out = timed_out

        center_x = layout.content_x + layout.content_width // 2
        area_h = layout.message_area_bottom - layout.message_area_top
        center_y = layout.message_area_top + int(area_h * 0.34)
        radius = max(44, min(layout.content_width, area_h) // 6)

        # Halo ring + animated spinner arc (static broken ring on timeout).
        ring_color = self.RED if timed_out else accent
        self._track(
            self.canvas.create_oval(
                center_x - radius - 12, center_y - radius - 12,
                center_x + radius + 12, center_y + radius + 12,
                fill=self.INNER, outline=self.CARD_EDGE, width=1,
            )
        )
        self._track(
            self.canvas.create_oval(
                center_x - radius, center_y - radius,
                center_x + radius, center_y + radius,
                fill=self.CARD, outline=self.CARD_EDGE, width=2,
            )
        )
        if timed_out:
            self._track(
                self.canvas.create_text(
                    center_x, center_y, anchor="center",
                    text="!", fill=ring_color, font=self.shell.hero_font,
                )
            )
        else:
            self._track(
                self.canvas.create_arc(
                    center_x - radius, center_y - radius,
                    center_x + radius, center_y + radius,
                    start=self._spinner_angle, extent=100,
                    style=tk.ARC, outline=ring_color, width=5,
                )
            )
            self._track(
                self.canvas.create_arc(
                    center_x - radius, center_y - radius,
                    center_x + radius, center_y + radius,
                    start=self._spinner_angle + 180, extent=60,
                    style=tk.ARC, outline=ring_color, width=3,
                )
            )
            self._track(
                self.canvas.create_text(
                    center_x, center_y, anchor="center",
                    text="⋯", fill=accent, font=self.shell.section_title_font,
                )
            )

        title = request.get("title") or "Your request"
        headline = f"{title} unavailable" if timed_out else f"Getting {title}…"
        text_y = center_y + radius + 40
        self._track(
            self.canvas.create_text(
                center_x, text_y, anchor="n",
                text=headline, fill=text, font=self.shell.section_title_font,
            )
        )
        text_y += self.shell.section_title_font.metrics("linespace") + 14

        if timed_out:
            message = "This is taking longer than expected — the request may have failed."
            detail = "Please try asking again in a moment."
        else:
            message = processing_stage_message(request.get("stages"), elapsed)
            message = message or "Request received — fetching live data…"
            detail = ""
            if elapsed >= 5:
                detail = f"{int(elapsed)}s elapsed"

        self._track(
            self.canvas.create_text(
                center_x, text_y, anchor="n",
                text=message, fill=muted, font=self.shell.body_font,
                width=layout.message_content_width - 40, justify="center",
            )
        )
        text_y += self.shell.body_font.metrics("linespace") * 2 + 10

        if detail:
            self._track(
                self.canvas.create_text(
                    center_x, text_y, anchor="n",
                    text=detail,
                    fill=self.RED if timed_out else muted,
                    font=self.shell.forecast_label_font,
                )
            )

        source = request.get("source")
        device = self._payload.get("device")
        bits = []
        if device:
            bits.append(f"Asked on {device}")
        if source and not timed_out:
            bits.append(f"via {source}")
        if bits:
            pill_font = self.shell.chip_value_font
            pill_h = pill_font.metrics("linespace") + 10
            self._pill(
                center_x,
                layout.message_area_bottom - pill_h - 8,
                " · ".join(bits),
                fill=self.CARD, fg=muted, outline=self.CARD_EDGE,
                anchor="n", font=pill_font,
            )


class WeatherPanel(BasePanel):
    CONDITION_COLORS = {
        "sunny": "#fbbf24",
        "clear-night": "#c7d2fe",
        "cloudy": "#94a3b8",
        "rainy": "#38bdf8",
        "snowy": "#e2e8f0",
        "stormy": "#a78bfa",
        "windy": "#cbd5e1",
        "unknown": "#64748b",
    }

    CONDITION_LABELS = {
        "sunny": "Sunny",
        "clear-night": "Clear",
        "cloudy": "Cloudy",
        "rainy": "Rainy",
        "snowy": "Snowy",
        "stormy": "Stormy",
        "windy": "Windy",
        "unknown": "",
    }

    def _fit_forecast_heights(self, layout, y_before_hourly: int, has_hourly: bool, has_daily: bool) -> tuple[int, int]:
        min_slot, max_slot = 72, 114
        min_day, max_day = 72, 122
        hourly_gap = 22
        hourly_header = self.shell.section_label_font.metrics("linespace") + 16
        day_header = hourly_header

        available = layout.message_area_bottom - y_before_hourly - hourly_header
        if has_daily:
            available -= day_header

        if has_hourly and has_daily:
            slot_height = min(max_slot, max(min_slot, int((available - hourly_gap) * 0.52)))
            day_height = min(max_day, max(min_day, available - hourly_gap - slot_height))
        elif has_hourly:
            slot_height = min(max_slot, max(min_slot, available - 12))
            day_height = max_day
        elif has_daily:
            slot_height = max_slot
            day_height = min(max_day, max(min_day, available - 12))
        else:
            slot_height, day_height = max_slot, max_day

        return slot_height, day_height

    def _weather_context(self, payload: dict) -> dict:
        location = payload.get("location") or {}
        weather = payload.get("weather") or {}
        current = weather.get("current") or {}
        hourly = weather.get("next24Hours") or []
        daily = weather.get("next7Days") or []
        spoken = payload.get("spokenResponse") or ""
        spoken_bits = parse_spoken_weather(spoken)
        location_name = format_weather_location(location)
        # Spoken current temp wins for the hero number.
        temp_f = spoken_bits.get("temp_f") if spoken_bits.get("temp_is_current") else None
        if temp_f is None:
            temp_f = current.get("temperatureF")
        if temp_f is None:
            temp_f = spoken_bits.get("temp_f")
        temp_c = round((temp_f - 32) * 5 / 9) if temp_f is not None else None
        condition = normalize_condition(current.get("condition") or spoken_bits.get("condition"))
        if condition == "unknown" and spoken_bits.get("condition"):
            condition = normalize_condition(spoken_bits.get("condition"))
        updated = (
            current.get("observedAt")
            or weather.get("updatedAt")
            or payload.get("receivedAt")
        )
        try:
            updated_label = format_chip_timestamp(updated).split("·")[-1].strip() if updated else ""
        except Exception:
            updated_label = ""
        if not updated_label:
            updated_label = datetime.now().strftime("%I:%M %p").lstrip("0")
        return {
            "location_name": location_name,
            "current": current,
            "hourly": hourly,
            "daily": daily,
            "spoken_bits": spoken_bits,
            "temp_f": temp_f,
            "temp_c": temp_c,
            "condition": condition,
            "updated_label": updated_label,
            "wind": current.get("windSpeedMph"),
            "rain": (hourly[0].get("precipitationProbability") if hourly else None),
            "humidity": current.get("humidity"),
        }

    def _paint_weather_header(self, ctx: dict, screen_w: int, screen_h: int):
        from src.page_header import paint_page_header

        city = ctx["location_name"] or "Home"
        # Keep the header value short so it doesn't collide with the pill.
        if "," in city:
            city = city.split(",")[0].strip()
        paint_page_header(
            self.canvas,
            screen_w=screen_w,
            screen_h=screen_h,
            pill="WEATHER",
            left_label="UPDATED",
            left_value=ctx["updated_label"],
            right_label="LOCATION",
            right_value=city,
            track=self._track,
            sans_family=self.config.get("titleFontFamily", "Segoe UI"),
            mono_family="Consolas",
        )

    @staticmethod
    def _temp_gradient_color(t: float, t_min: float, t_max: float) -> str:
        """Shared week gradient: cold→hot = cyan→mint→amber→coral."""
        if t_max <= t_min:
            return "#6EE7A8"
        frac = max(0.0, min(1.0, (float(t) - t_min) / (t_max - t_min)))
        stops = (
            (0.0, (95, 208, 255)),
            (0.33, (110, 231, 168)),
            (0.66, (245, 196, 83)),
            (1.0, (255, 122, 107)),
        )
        for i in range(len(stops) - 1):
            a_f, a_c = stops[i]
            b_f, b_c = stops[i + 1]
            if frac <= b_f or i == len(stops) - 2:
                local = 0.0 if b_f == a_f else (frac - a_f) / (b_f - a_f)
                local = max(0.0, min(1.0, local))
                r = int(a_c[0] + (b_c[0] - a_c[0]) * local)
                g = int(a_c[1] + (b_c[1] - a_c[1]) * local)
                b = int(a_c[2] + (b_c[2] - a_c[2]) * local)
                return f"#{r:02x}{g:02x}{b:02x}"
        return "#FF7A6B"

    def _render(self, payload: dict):
        from src.design_system import page_chrome, ACCENT, INK, INK_2, INK_3

        ctx = self._weather_context(payload)
        overlay = getattr(self.shell, "overlay", None)
        screen_w = int(getattr(overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        screen_h = int(getattr(overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        self._paint_weather_header(ctx, screen_w, screen_h)
        if chrome.portrait:
            self._render_weather_portrait(ctx, chrome, ACCENT, INK, INK_2, INK_3)
        else:
            self._render_weather_landscape(ctx, chrome, ACCENT, INK, INK_2, INK_3)

    def _render_weather_landscape(self, ctx, chrome, accent, ink, ink2, ink3):
        """Landscape mockup: hero+sparkline top band, 7 vertical range bars below."""
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        zone_h = chrome.content_bottom - chrome.content_top
        top_h = min(470 * u, zone_h * 0.55)
        gap = 24 * u
        left_w = 736 * u
        right_w = width - left_w - gap

        temp_f = ctx["temp_f"]
        temp_c = ctx["temp_c"]
        condition = ctx["condition"]
        cond_label = self.CONDITION_LABELS.get(condition, condition.title())
        if temp_f is not None:
            hero = f"{round(temp_f)}°"
            cond = f"{cond_label} · {temp_c}°C" if cond_label else f"{temp_c}°C"
        else:
            hero = "—"
            cond = ctx["spoken_bits"].get("summary") or "Forecast unavailable"

        # Hero display size (~232u) — use a dedicated font, fall back to shell hero.
        try:
            from tkinter import font as tkfont
            hero_font = tkfont.Font(
                family=self.config.get("titleFontFamily", "Segoe UI"),
                size=max(48, int(round(120 * u))),
                weight="bold",
            )
            cond_font = tkfont.Font(
                family=self.config.get("titleFontFamily", "Segoe UI"),
                size=max(14, int(round(40 * u))),
            )
            value_font = tkfont.Font(
                family=self.config.get("titleFontFamily", "Segoe UI"),
                size=max(14, int(round(38 * u))),
                weight="bold",
            )
            sec_font = ("Consolas", max(11, int(round(22 * u))))
        except Exception:
            hero_font = self.shell.hero_font
            cond_font = self.shell.body_font
            value_font = self.shell.section_title_font
            sec_font = self.shell.section_label_font

        self._track(self.canvas.create_text(
            x0, y0, anchor="nw", text=hero, fill=ink, font=hero_font,
        ))
        hero_h = hero_font.metrics("linespace") if hasattr(hero_font, "metrics") else int(120 * u)
        self._track(self.canvas.create_text(
            x0, y0 + hero_h + 8 * u, anchor="nw", text=cond, fill=ink2, font=cond_font,
        ))
        # Condition icon on the right of the hero column.
        self._draw_condition_icon(
            x0 + left_w - 70 * u, y0 + 90 * u, max(48, 120 * u), condition,
        )

        stats_y = y0 + top_h - 120 * u
        self._track(self.canvas.create_line(
            x0, stats_y, x0 + left_w, stats_y, fill="#264060",
        ))
        stats = (
            ("WIND", f"{round(ctx['wind'])} mph" if ctx["wind"] is not None else "—"),
            ("RAIN", f"{ctx['rain']}%" if ctx["rain"] is not None else "—"),
            ("HUMIDITY", f"{ctx['humidity']}%" if ctx["humidity"] is not None else "—"),
        )
        cell_w = left_w / 3
        for i, (lab, val) in enumerate(stats):
            cx = x0 + cell_w * i + cell_w / 2
            if i:
                self._track(self.canvas.create_line(
                    x0 + cell_w * i, stats_y + 8 * u,
                    x0 + cell_w * i, stats_y + 90 * u,
                    fill="#264060",
                ))
            self._track(self.canvas.create_text(
                cx, stats_y + 18 * u, anchor="n", text=lab,
                fill=accent, font=sec_font,
            ))
            self._track(self.canvas.create_text(
                cx, stats_y + 48 * u, anchor="n", text=val,
                fill=ink, font=value_font,
            ))

        # Hourly sparkline (right of hero).
        hx = x0 + left_w + gap
        self._track(self.canvas.create_text(
            hx, y0, anchor="nw", text="NEXT 24 HOURS", fill=ink3, font=sec_font,
        ))
        spark_top = y0 + 36 * u
        spark_h = top_h - 110 * u
        self._draw_hourly_sparkline(
            hx, spark_top, right_w, spark_h, ctx["hourly"], accent, ink, ink3, u,
        )

        # 7-day vertical range bars.
        week_y = y0 + top_h + 24 * u
        week_h = chrome.content_bottom - week_y
        self._draw_week_vertical_bars(
            x0, week_y, width, week_h, ctx["daily"], accent, ink, ink2, ink3, u,
        )

    def _draw_hourly_sparkline(
        self, x, y, w, h, hourly, accent, ink, ink3, u,
    ):
        if not hourly:
            self._track(self.canvas.create_text(
                x, y + 24, anchor="nw", text="Hourly forecast unavailable",
                fill=ink3, font=self.shell.body_font,
            ))
            return
        # Skip "Now" — start at next whole hour samples (design-system note).
        picks = sample_hourly_indices(len(hourly), 6)
        if picks and picks[0] == 0 and len(hourly) > 1:
            picks = sample_hourly_indices(max(1, len(hourly) - 1), 6)
            picks = [i + 1 for i in picks if i + 1 < len(hourly)]
            if len(picks) < 6:
                picks = sample_hourly_indices(len(hourly), 6)
        temps = []
        labels = []
        for idx in picks:
            slot = hourly[idx]
            temps.append(slot.get("temperatureF"))
            label = "—"
            if slot.get("time"):
                try:
                    label = (
                        datetime.fromisoformat(slot["time"].replace("Z", "+00:00"))
                        .strftime("%I%p")
                        .lstrip("0")
                    )
                except ValueError:
                    label = str(slot["time"])[-5:]
            labels.append(label)
        valid = [t for t in temps if t is not None]
        if not valid:
            return
        t_min, t_max = min(valid), max(valid)
        pad = 20 * u
        chart_h = max(40, h - 50 * u)
        n = len(picks)
        xs = [x + (w * (i + 0.5) / n) for i in range(n)]
        ys = []
        for t in temps:
            if t is None:
                ys.append(y + chart_h / 2)
            else:
                frac = 0.5 if t_max == t_min else (t - t_min) / (t_max - t_min)
                ys.append(y + pad + chart_h * (1 - frac))
        for i in range(n - 1):
            self._track(self.canvas.create_line(
                xs[i], ys[i], xs[i + 1], ys[i + 1],
                fill=accent, width=max(2, int(3 * u)),
            ))
        for i, t in enumerate(temps):
            r = max(3, int(7 * u))
            self._track(self.canvas.create_oval(
                xs[i] - r, ys[i] - r, xs[i] + r, ys[i] + r,
                fill=accent, outline="",
            ))
            if t is not None:
                self._track(self.canvas.create_text(
                    xs[i], ys[i] - 18 * u, anchor="s",
                    text=f"{round(t)}°", fill=ink,
                    font=self.shell.forecast_value_font,
                ))
            self._track(self.canvas.create_text(
                xs[i], y + h - 4 * u, anchor="s",
                text=labels[i], fill=ink3,
                font=self.shell.forecast_label_font,
            ))

    def _draw_week_vertical_bars(
        self, x, y, w, h, daily, accent, ink, ink2, ink3, u,
    ):
        days = list(daily or [])[:7]
        highs = [d.get("highF") for d in days if d.get("highF") is not None]
        lows = [d.get("lowF") for d in days if d.get("lowF") is not None]
        if highs and lows:
            week_lo, week_hi = min(lows), max(highs)
            sec = f"7-DAY FORECAST · {round(week_lo)}° TO {round(week_hi)}°"
        else:
            week_lo, week_hi = 0, 100
            sec = "7-DAY FORECAST"
        sec_font = ("Consolas", max(11, int(round(22 * u))))
        self._track(self.canvas.create_text(
            x, y, anchor="nw", text=sec, fill=ink3, font=sec_font,
        ))
        if not days:
            self._track(self.canvas.create_text(
                x, y + 40 * u, anchor="nw", text="Daily forecast unavailable",
                fill=ink3, font=self.shell.body_font,
            ))
            return
        plot_top = y + 36 * u
        plot_h = max(120 * u, h - 56 * u)
        col_gap = 24 * u
        col_w = (w - col_gap * (len(days) - 1)) / max(1, len(days))
        bar_w = min(60 * u, col_w * 0.45)
        track_h = min(200 * u, plot_h - 90 * u)
        for i, day in enumerate(days):
            cx = x + i * (col_w + col_gap) + col_w / 2
            high = day.get("highF")
            low = day.get("lowF")
            label = "TODAY" if i == 0 else ""
            if not label and day.get("date"):
                try:
                    label = datetime.fromisoformat(day["date"]).strftime("%a").upper()
                except ValueError:
                    label = str(day.get("date"))[-5:]
            self._track(self.canvas.create_text(
                cx, plot_top, anchor="n",
                text=f"{round(high)}°" if high is not None else "—",
                fill=ink, font=self.shell.forecast_value_font,
            ))
            track_y0 = plot_top + 36 * u
            track_x0 = cx - bar_w / 2
            self._track(self.canvas.create_rectangle(
                track_x0, track_y0, track_x0 + bar_w, track_y0 + track_h,
                fill="#1a2438", outline="",
            ))
            if high is not None and low is not None and week_hi > week_lo:
                top_frac = (week_hi - high) / (week_hi - week_lo)
                bot_frac = (week_hi - low) / (week_hi - week_lo)
                by0 = track_y0 + track_h * top_frac
                by1 = track_y0 + track_h * bot_frac
                mid = (float(high) + float(low)) / 2
                color = self._temp_gradient_color(mid, week_lo, week_hi)
                self._track(self.canvas.create_rectangle(
                    track_x0, by0, track_x0 + bar_w, by1,
                    fill=color, outline="",
                ))
            self._track(self.canvas.create_text(
                cx, track_y0 + track_h + 8 * u, anchor="n",
                text=f"{round(low)}°" if low is not None else "—",
                fill=ink3, font=self.shell.forecast_label_font,
            ))
            self._track(self.canvas.create_text(
                cx, track_y0 + track_h + 32 * u, anchor="n",
                text=label, fill=ink2, font=sec_font,
            ))

    def _render_weather_portrait(self, ctx, chrome, accent, ink, ink2, ink3):
        """Portrait stack in the shared content zone (header already painted)."""
        layout = self.shell.layout
        x = chrome.content_x
        width = chrome.content_w
        y = chrome.content_top
        text = ink
        muted = ink2
        temp_f = ctx["temp_f"]
        temp_c = ctx["temp_c"]
        condition = ctx["condition"]
        hourly = ctx["hourly"]
        daily = ctx["daily"]

        icon_x = x + 72
        icon_y = y + 54
        self._draw_condition_icon(icon_x, icon_y, 54, condition)

        if temp_f is not None:
            temp_line = f"{round(temp_f)}°"
            condition_label = self.CONDITION_LABELS.get(condition, condition.title())
            sub_line = f"{condition_label} · {temp_c}°C" if condition_label else f"{temp_c}°C"
        else:
            temp_line = "—"
            sub_line = ctx["spoken_bits"].get("summary") or "Forecast unavailable"

        self._track(self.canvas.create_text(
            x + 130, y + 18, anchor="nw", text=temp_line, fill=text, font=self.shell.hero_font,
        ))
        self._track(self.canvas.create_text(
            x + 130, y + 88, anchor="nw", text=sub_line, fill=muted,
            font=self.shell.body_font, width=max(240, width - 150),
        ))

        wind, rain, humidity = ctx["wind"], ctx["rain"], ctx["humidity"]
        detail_parts = []
        if wind is not None:
            detail_parts.append(f"Wind {round(wind)} mph")
        if rain is not None:
            detail_parts.append(f"Rain {rain}%")
        if humidity is not None:
            detail_parts.append(f"Humidity {humidity}%")
        if detail_parts:
            detail_y = y + 136
            self._track(self.canvas.create_text(
                x + 130, detail_y, anchor="nw", text=" · ".join(detail_parts),
                fill=accent, font=self.shell.chip_value_font,
            ))
            y = detail_y + self.shell.chip_value_font.metrics("linespace") + 40
        else:
            y += 148

        # Fake an OverlayLayout-like object for height fitting.
        class _L:
            pass
        fit_layout = _L()
        fit_layout.message_area_bottom = chrome.content_bottom
        slot_height, day_height = self._fit_forecast_heights(
            fit_layout, int(y), bool(hourly), bool(daily),
        )

        self._track(self.canvas.create_text(
            x, y, anchor="nw", text="NEXT 24 HOURS", fill=ink3,
            font=self.shell.section_label_font,
        ))
        y += self.shell.section_label_font.metrics("linespace") + 16
        icon_box = 22
        if hourly:
            picks = sample_hourly_indices(len(hourly), min(6, max(4, int(width // 90))))
            slot_width = width / max(1, len(picks))
            for index, hour_index in enumerate(picks):
                slot = hourly[hour_index]
                slot_x = x + index * slot_width
                inner_w = slot_width - 10
                center_x = slot_x + inner_w / 2
                label = "—"
                if slot.get("time"):
                    try:
                        label = (
                            datetime.fromisoformat(slot["time"].replace("Z", "+00:00"))
                            .strftime("%I%p").lstrip("0")
                        )
                    except ValueError:
                        label = str(slot["time"])[-5:]
                temp = slot.get("temperatureF")
                rain_chance = slot.get("precipitationProbability")
                self._round_rect(
                    slot_x, y, slot_x + inner_w, y + slot_height,
                    radius=0, fill=self.CARD, outline=self.CARD_EDGE,
                )
                self._track(self.canvas.create_text(
                    center_x, y + 4, anchor="n", text=label, fill=muted,
                    font=self.shell.forecast_label_font,
                ))
                self._draw_condition_icon(
                    center_x, y + 20 + icon_box / 2, icon_box, slot.get("condition", "unknown"),
                )
                self._track(self.canvas.create_text(
                    center_x, y + 20 + icon_box + 10, anchor="n",
                    text=f"{temp}°" if temp is not None else "—",
                    fill=text, font=self.shell.forecast_value_font,
                ))
                self._track(self.canvas.create_text(
                    center_x, y + slot_height - 8, anchor="s",
                    text=f"{rain_chance}%" if rain_chance is not None else "",
                    fill=accent, font=self.shell.forecast_detail_font,
                ))
        else:
            self._track(self.canvas.create_text(
                x, y + 24, anchor="nw", text="Hourly forecast unavailable",
                fill=muted, font=self.shell.body_font,
            ))

        y += slot_height + 22 if hourly else 96
        highs = [d.get("highF") for d in daily if d.get("highF") is not None]
        lows = [d.get("lowF") for d in daily if d.get("lowF") is not None]
        if highs and lows:
            week_label = f"7-DAY FORECAST · {round(min(lows))}° TO {round(max(highs))}°"
            week_lo, week_hi = min(lows), max(highs)
        else:
            week_label = "7-DAY FORECAST"
            week_lo, week_hi = 0, 100
        self._track(self.canvas.create_text(
            x, y, anchor="nw", text=week_label, fill=ink3,
            font=self.shell.section_label_font,
        ))
        y += self.shell.section_label_font.metrics("linespace") + 16

        if daily:
            day_count = min(7, len(daily))
            row_h = max(72, min(day_height, (chrome.content_bottom - y) / max(1, day_count)))
            track_x0 = x + 120
            track_x1 = x + width - 190
            track_w = max(40, track_x1 - track_x0)
            for index, day in enumerate(daily[:day_count]):
                row_y = y + index * row_h
                label = "TODAY" if index == 0 else ""
                if not label and day.get("date"):
                    try:
                        label = datetime.fromisoformat(day["date"]).strftime("%a").upper()
                    except ValueError:
                        label = str(day.get("date"))[-5:]
                high = day.get("highF")
                low = day.get("lowF")
                self._track(self.canvas.create_text(
                    x, row_y + row_h / 2, anchor="w", text=label,
                    fill=ink2, font=self.shell.forecast_label_font,
                ))
                self._track(self.canvas.create_rectangle(
                    track_x0, row_y + row_h / 2 - 7, track_x1, row_y + row_h / 2 + 7,
                    fill="#1a2438", outline="",
                ))
                if high is not None and low is not None and week_hi > week_lo:
                    left_frac = (low - week_lo) / (week_hi - week_lo)
                    right_frac = (high - week_lo) / (week_hi - week_lo)
                    bx0 = track_x0 + track_w * left_frac
                    bx1 = track_x0 + track_w * right_frac
                    mid = (float(high) + float(low)) / 2
                    color = self._temp_gradient_color(mid, week_lo, week_hi)
                    self._track(self.canvas.create_rectangle(
                        bx0, row_y + row_h / 2 - 7, bx1, row_y + row_h / 2 + 7,
                        fill=color, outline="",
                    ))
                if high is not None and low is not None:
                    self._track(self.canvas.create_text(
                        x + width, row_y + row_h / 2, anchor="e",
                        text=f"{round(high)}°", fill=text,
                        font=self.shell.forecast_value_font,
                    ))
                    # lo sits left of hi in the right column.
                    try:
                        hi_w = self.shell.forecast_value_font.measure(f"{round(high)}°")
                    except Exception:
                        hi_w = 48
                    self._track(self.canvas.create_text(
                        x + width - hi_w - 12, row_y + row_h / 2, anchor="e",
                        text=f"{round(low)}°", fill=ink3,
                        font=self.shell.forecast_value_font,
                    ))
                elif high is not None:
                    self._track(self.canvas.create_text(
                        x + width, row_y + row_h / 2, anchor="e",
                        text=f"{round(high)}°", fill=text,
                        font=self.shell.forecast_value_font,
                    ))
        else:
            self._track(self.canvas.create_text(
                x, y, anchor="nw", text="Daily forecast unavailable",
                fill=muted, font=self.shell.body_font,
            ))

    def _draw_condition_icon(self, cx: float, cy: float, size: float, condition: str):
        condition = normalize_condition(condition)
        color = self.CONDITION_COLORS.get(condition, self.CONDITION_COLORS["unknown"])
        half = size / 2

        if condition == "sunny":
            radius = size * 0.30 if size <= 24 else size * 0.24
            self._track(
                self.canvas.create_oval(
                    cx - radius,
                    cy - radius,
                    cx + radius,
                    cy + radius,
                    fill=color,
                    outline="",
                )
            )
            ray_outer = half * 0.82 if size <= 24 else half - size * 0.04
            for angle in range(0, 360, 45):
                rad = math.radians(angle)
                inner = radius + size * 0.04
                self._track(
                    self.canvas.create_line(
                        cx + inner * math.cos(rad),
                        cy + inner * math.sin(rad),
                        cx + ray_outer * math.cos(rad),
                        cy + ray_outer * math.sin(rad),
                        fill=color,
                        width=2 if size <= 24 else 2,
                    )
                )
            return

        if condition == "clear-night":
            # Crescent moon: full disc with an offset bite of background color
            radius = size * 0.34
            self._track(
                self.canvas.create_oval(
                    cx - radius,
                    cy - radius,
                    cx + radius,
                    cy + radius,
                    fill=color,
                    outline="",
                )
            )
            bite = radius * 0.92
            self._track(
                self.canvas.create_oval(
                    cx - bite + radius * 0.55,
                    cy - bite - radius * 0.25,
                    cx + bite + radius * 0.55,
                    cy + bite - radius * 0.25,
                    fill=self.config.get("overlayBackground", "#0f172a"),
                    outline="",
                )
            )
            return

        if condition == "windy":
            for offset in (-size * 0.18, 0, size * 0.18):
                self._track(
                    self.canvas.create_line(
                        cx - half * 0.75 + offset,
                        cy - size * 0.08,
                        cx + half * 0.75 + offset,
                        cy - size * 0.08,
                        fill=color,
                        width=3,
                        capstyle=tk.ROUND,
                    )
                )
                self._track(
                    self.canvas.create_line(
                        cx - half * 0.35 + offset,
                        cy + size * 0.12,
                        cx + half * 0.95 + offset,
                        cy + size * 0.12,
                        fill=color,
                        width=3,
                        capstyle=tk.ROUND,
                    )
                )
            return

        cloud_w = size * 0.92
        cloud_h = size * 0.52
        self._track(
            self.canvas.create_oval(
                cx - cloud_w * 0.38,
                cy - cloud_h * 0.05,
                cx + cloud_w * 0.12,
                cy + cloud_h * 0.48,
                fill=color,
                outline="",
            )
        )
        self._track(
            self.canvas.create_oval(
                cx - cloud_w * 0.08,
                cy - cloud_h * 0.42,
                cx + cloud_w * 0.42,
                cy + cloud_h * 0.28,
                fill=color,
                outline="",
            )
        )

        if condition in ("rainy", "stormy"):
            for offset in (-size * 0.18, 0, size * 0.18):
                self._track(
                    self.canvas.create_line(
                        cx + offset,
                        cy + half * 0.18,
                        cx + offset - size * 0.06,
                        cy + half * 0.48,
                        fill=self.config.get("accentColor", "#38bdf8"),
                        width=2,
                    )
                )
        if condition == "snowy":
            for offset in (-size * 0.16, 0, size * 0.16):
                self._track(
                    self.canvas.create_text(
                        cx + offset,
                        cy + half * 0.28,
                        text="*",
                        fill="#f8fafc",
                        font=self.shell.chip_label_font,
                    )
                )


class IndoorTemperaturePanel(BasePanel):
    COMFORT_COLORS = {
        "cold": "#38bdf8",
        "comfortable": "#4ade80",
        "hot": "#fb923c",
        "unknown": "#64748b",
    }

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        chip = self.config.get("chipBackground", "#141a24")
        accent = self.config.get("accentColor", "#38bdf8")

        location = payload.get("location") or {}
        reading = payload.get("reading") or {}
        spoken = payload.get("spokenResponse") or ""
        spoken_bits = parse_spoken_indoor(spoken)
        metric = payload.get("metric") or "temperature"
        indoor_config = self.config.get("indoorTemperature") or {}

        temp_f = reading.get("temperatureF")
        if temp_f is None and spoken_bits.get("temp_f") is not None:
            temp_f = spoken_bits["temp_f"]

        humidity = reading.get("humidity")
        if humidity is None and spoken_bits.get("humidity") is not None:
            humidity = spoken_bits["humidity"]

        comfort = reading.get("comfort") or indoor_comfort_band(
            temp_f,
            cold_below_f=indoor_config.get("coldBelowF", 68),
            hot_above_f=indoor_config.get("hotAboveF", 74),
        )
        comfort_color = self.COMFORT_COLORS.get(comfort, self.COMFORT_COLORS["unknown"])
        location_name = format_indoor_location(location)
        comfort_label = comfort.replace("_", " ").title()
        center_x = x + width // 2

        self._track(
            self.canvas.create_text(
                center_x,
                y,
                anchor="n",
                text=location_name,
                fill=text,
                font=self.shell.section_title_font,
            )
        )

        area_top = y + self.shell.section_title_font.metrics("linespace") + 28
        area_bottom = bottom - 28
        icon_size = 52
        icon_block = icon_size + 24
        value_block = self.shell.digital_time_font.metrics("linespace") + 8
        badge_block = self.shell.chip_label_font.metrics("linespace") + 24
        detail_block = self.shell.chip_value_font.metrics("linespace") if humidity is not None else 0
        block_height = icon_block + value_block + badge_block + detail_block + (12 if detail_block else 0)
        block_top = area_top + max(0, (area_bottom - area_top - block_height) // 2)

        if metric == "humidity" and humidity is not None:
            primary_value = f"{humidity}%"
            show_comfort_badge = temp_f is not None
            humidity_caption = None if temp_f is not None else "Indoor humidity"
            detail_line = format_temperature_f(temp_f) if temp_f is not None else None
        elif temp_f is not None:
            primary_value = format_temperature_f(temp_f)
            show_comfort_badge = True
            humidity_caption = None
            detail_line = f"Humidity {humidity}%" if humidity is not None else None
        else:
            primary_value = "—"
            show_comfort_badge = False
            humidity_caption = None
            detail_line = spoken_bits.get("summary") or reading.get("summary") or "Reading unavailable"

        icon_y = block_top + icon_size // 2 + 4
        self._draw_comfort_icon(center_x, icon_y, icon_size, comfort, comfort_color)

        value_y = block_top + icon_block + self.shell.digital_time_font.metrics("linespace") // 2
        self._track(
            self.canvas.create_text(
                center_x,
                value_y,
                anchor="center",
                text=primary_value,
                fill=text,
                font=self.shell.digital_time_font,
            )
        )

        cursor_y = block_top + icon_block + value_block
        if humidity_caption:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor_y,
                    anchor="n",
                    text=humidity_caption,
                    fill=muted,
                    font=self.shell.body_font,
                )
            )
            cursor_y += self.shell.body_font.metrics("linespace") + 10
        if show_comfort_badge:
            cursor_y = self._draw_comfort_badge(
                center_x,
                cursor_y,
                comfort_label,
                comfort_color,
                chip,
            )
        elif primary_value == "—" and detail_line:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor_y,
                    anchor="n",
                    text=detail_line,
                    fill=muted,
                    font=self.shell.body_font,
                    width=max(280, width - 80),
                    justify="center",
                )
            )

        if detail_line and primary_value != "—":
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor_y + 8,
                    anchor="n",
                    text=detail_line,
                    fill=accent,
                    font=self.shell.chip_value_font,
                )
            )

        entity = location.get("entity") or location.get("query")
        if entity and str(entity).lower() != str(location_name).lower():
            self._track(
                self.canvas.create_text(
                    center_x,
                    bottom - 8,
                    anchor="s",
                    text=str(entity),
                    fill=muted,
                    font=self.shell.chip_label_font,
                )
            )

    def _draw_comfort_badge(
        self,
        center_x: float,
        y: float,
        label: str,
        accent: str,
        chip: str,
    ) -> float:
        font = self.shell.chip_label_font
        pad_x = 18
        pad_y = 7
        text_w = font.measure(label)
        pill_w = text_w + pad_x * 2
        pill_h = font.metrics("linespace") + pad_y * 2
        left = center_x - pill_w / 2
        self._round_rect(
            left,
            y,
            left + pill_w,
            y + pill_h,
            radius=pill_h // 2,
            fill=chip,
            outline=accent,
        )
        self._track(
            self.canvas.create_text(
                center_x,
                y + pill_h / 2,
                anchor="center",
                text=label,
                fill=accent,
                font=font,
            )
        )
        return y + pill_h

    def _draw_comfort_icon(self, cx: float, cy: float, size: float, comfort: str, color: str):
        half = size / 2
        if comfort == "cold":
            for index in range(6):
                angle = math.radians(index * 60 - 90)
                self._track(
                    self.canvas.create_line(
                        cx + (half * 0.18) * math.cos(angle),
                        cy + (half * 0.18) * math.sin(angle),
                        cx + (half * 0.46) * math.cos(angle),
                        cy + (half * 0.46) * math.sin(angle),
                        fill=color,
                        width=3,
                        capstyle=tk.ROUND,
                    )
                )
            self._track(
                self.canvas.create_oval(
                    cx - half * 0.16,
                    cy - half * 0.16,
                    cx + half * 0.16,
                    cy + half * 0.16,
                    fill=color,
                    outline="",
                )
            )
            return

        if comfort == "hot":
            radius = size * 0.24
            self._track(
                self.canvas.create_oval(
                    cx - radius,
                    cy - radius,
                    cx + radius,
                    cy + radius,
                    fill=color,
                    outline="",
                )
            )
            for index in range(8):
                angle = math.radians(index * 45)
                self._track(
                    self.canvas.create_line(
                        cx + (radius + 4) * math.cos(angle),
                        cy + (radius + 4) * math.sin(angle),
                        cx + (radius + 14) * math.cos(angle),
                        cy + (radius + 14) * math.sin(angle),
                        fill=color,
                        width=3,
                        capstyle=tk.ROUND,
                    )
                )
            return

        tube_w = size * 0.18
        tube_h = size * 0.58
        bulb_r = size * 0.16
        self._track(
            self.canvas.create_rectangle(
                cx - tube_w / 2,
                cy - tube_h / 2,
                cx + tube_w / 2,
                cy + tube_h / 2 - bulb_r * 0.4,
                fill=self.config.get("chipBackground", "#141a24"),
                outline=color,
                width=3,
            )
        )
        self._track(
            self.canvas.create_oval(
                cx - bulb_r,
                cy + tube_h / 2 - bulb_r * 1.2,
                cx + bulb_r,
                cy + tube_h / 2 + bulb_r * 0.4,
                fill=color,
                outline=color,
            )
        )
        fill_top = cy + tube_h / 2 - bulb_r * 0.55
        fill_bottom = cy + tube_h / 2 - bulb_r * 1.05
        self._track(
            self.canvas.create_rectangle(
                cx - tube_w / 2 + 4,
                fill_top,
                cx + tube_w / 2 - 4,
                fill_bottom,
                fill=color,
                outline="",
            )
        )


class AirQualityPanel(BasePanel):
    """Indoor air quality — score ring hero (design-system §2.5 / §3.6 + HTML)."""

    # Named bands sized to real cutoffs (100→65→35→15→0), left→right.
    BAND_SEGMENTS = (
        ("good", 35, "GOOD 100–65"),
        ("fair", 30, "FAIR"),
        ("poor", 20, "POOR"),
        ("severe", 15, "SEVERE 0"),
    )
    METRICS = (
        ("temperatureF", "TEMP"),
        ("humidity", "HUMID"),
        ("pm25", "PM2.5"),
        ("co", "CO"),
        ("voc", "VOC"),
    )

    @staticmethod
    def display_band(score: int | float | None, fallback: str | None = None) -> str:
        """Map IAQ score onto the display scale (65 / 35 / 15)."""
        if score is not None:
            try:
                value = float(score)
            except (TypeError, ValueError):
                value = None
            else:
                if value >= 65:
                    return "good"
                if value >= 35:
                    return "fair"
                if value >= 15:
                    return "poor"
                return "severe"
        band = str(fallback or "unknown").lower()
        if band == "moderate":
            return "fair"
        if band in ("good", "fair", "poor", "severe", "unknown"):
            return band
        return "unknown"

    @staticmethod
    def band_color(band: str) -> str:
        from src.design_system import GOOD, WARN, ALERT, INK_3
        return {
            "good": GOOD,
            "fair": WARN,
            "poor": ALERT,
            "severe": ALERT,
            "unknown": INK_3,
        }.get(str(band or "unknown"), INK_3)

    @staticmethod
    def rating_word(band: str) -> str:
        if band == "severe":
            return "Severe"
        return air_quality_band_label(band)

    def _screen(self) -> tuple[int, int]:
        overlay = getattr(self.shell, "overlay", None)
        w = int(getattr(overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        h = int(getattr(overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        return w, h

    def _updated_label(self, payload: dict, reading: dict) -> str:
        updated = (
            reading.get("observedAt")
            or reading.get("updatedAt")
            or payload.get("receivedAt")
            or payload.get("timestamp")
        )
        try:
            if updated:
                text = format_chip_timestamp(updated)
                if "·" in text:
                    return text.split("·")[-1].strip()
                return text
        except Exception:
            pass
        return datetime.now().strftime("%I:%M %p").lstrip("0")

    def _paint_header(self, updated: str):
        from src.page_header import paint_page_header
        from src.design_system import page_chrome

        sw, sh = self._screen()
        chrome = page_chrome(sw, sh, timed=True)
        paint_page_header(
            self.canvas,
            screen_w=sw,
            screen_h=sh,
            pill="AIR QUALITY",
            left_label="SOURCE",
            left_value="Alexa",
            right_label="UPDATED",
            right_value=updated,
            track=self._track,
            sans_family=self.config.get("titleFontFamily", "Segoe UI"),
            mono_family="Consolas",
        )
        return chrome

    def _merge_monitor_metric_values(self, values: dict, monitors: list[dict]) -> None:
        for monitor in monitors:
            monitor_reading = monitor.get("reading")
            if not isinstance(monitor_reading, dict):
                continue
            for key in ("temperatureF", "humidity", "pm25", "co", "voc"):
                if values.get(key) is None and monitor_reading.get(key) is not None:
                    values[key] = monitor_reading.get(key)

    def _metric_text(self, key: str, value) -> str:
        if value is None:
            return "—"
        if key == "voc":
            return voc_band_label(value) or "—"
        if key == "temperatureF":
            try:
                numeric = float(value)
            except (TypeError, ValueError):
                return "—"
            return f"{int(numeric)}°" if numeric.is_integer() else f"{numeric:.1f}°"
        if key == "humidity":
            try:
                return f"{int(float(value))}%"
            except (TypeError, ValueError):
                return "—"
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return str(value)
        if numeric.is_integer():
            return str(int(numeric))
        return f"{numeric:g}"

    def _draw_score_ring(self, cx, cy, diameter, score, color, track_color, u):
        radius = diameter / 2
        stroke = max(4.0, 0.024 * diameter)  # ~13 at Ø540
        frac = 0.0
        if score is not None:
            try:
                frac = max(0.0, min(1.0, float(score) / 100.0))
            except (TypeError, ValueError):
                frac = 0.0
        bbox = (cx - radius, cy - radius, cx + radius, cy + radius)
        self._track(self.canvas.create_oval(
            *bbox, outline=track_color, width=stroke, fill="",
        ))
        if frac > 0:
            self._track(self.canvas.create_arc(
                *bbox, start=90, extent=-360.0 * frac, style=tk.ARC,
                outline=color, width=stroke,
            ))
        score_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(28, int(round(0.344 * diameter))),
            weight="bold",
        )
        rating_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(40 * u))),
        )
        score_text = "—" if score is None else str(int(float(score)))
        self._track(self.canvas.create_text(
            cx, cy - 8 * u, anchor="center", text=score_text,
            fill="#F2F7FF", font=score_font,
        ))
        return rating_font

    def _draw_band_scale(self, x, y, width, band, color, ink3, u) -> float:
        gap = 4 * u
        total_parts = sum(seg[1] for seg in self.BAND_SEGMENTS)
        usable = width - gap * (len(self.BAND_SEGMENTS) - 1)
        h = max(4.0, 14 * u)
        cursor = x
        for name, weight, _label in self.BAND_SEGMENTS:
            seg_w = usable * (weight / total_parts)
            fill = color if name == band else "#1a2438"
            self._track(self.canvas.create_rectangle(
                cursor, y, cursor + seg_w, y + h, fill=fill, outline="",
            ))
            cursor += seg_w + gap
        lab_font = ("Consolas", max(10, int(round(20 * u))))
        label_y = y + h + 10 * u
        cursor = x
        last = len(self.BAND_SEGMENTS) - 1
        for index, (_name, weight, label) in enumerate(self.BAND_SEGMENTS):
            seg_w = usable * (weight / total_parts)
            if index == 0:
                anchor, tx = "nw", cursor
            elif index == last:
                anchor, tx = "ne", cursor + seg_w
            else:
                anchor, tx = "n", cursor + seg_w / 2
            self._track(self.canvas.create_text(
                tx, label_y, anchor=anchor, text=label, fill=ink3, font=lab_font,
            ))
            cursor += seg_w + gap
        return label_y + 28 * u

    def _draw_metric_cell(self, x, y, w, h, label, value, accent, ink, line, u):
        self._track(self.canvas.create_rectangle(
            x, y, x + w, y + h, outline=line, width=max(1, int(round(u))), fill="",
        ))
        # Scale type to the cell so landscape 1×5 / 3+2 stay readable, not cramped.
        lab_u = min(20.0, max(14.0, h / u * 0.18))
        val_u = min(38.0, max(22.0, h / u * 0.34))
        lab_font = ("Consolas", max(10, int(round(lab_u * u))))
        val_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(val_u * u))),
            weight="bold",
        )
        self._track(self.canvas.create_text(
            x + w / 2, y + min(20 * u, h * 0.22), anchor="n",
            text=label, fill=accent, font=lab_font,
        ))
        self._track(self.canvas.create_text(
            x + w / 2, y + h - min(18 * u, h * 0.18), anchor="s",
            text=value, fill=ink, font=val_font,
        ))

    def _draw_room_row(self, x, y, w, h, name, score, color, ink, track, u):
        self._track(self.canvas.create_line(
            x, y + h - 1, x + w, y + h - 1, fill="#1e3050",
        ))
        cy = y + h / 2
        name_u = min(40.0, max(22.0, h / u * 0.42))
        score_u = min(36.0, max(20.0, h / u * 0.38))
        name_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(name_u * u))),
        )
        score_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(score_u * u))),
            weight="bold",
        )
        bar_w = min(220 * u, w * 0.32)
        bar_h = max(4.0, min(10 * u, h * 0.18))
        score_text = "—" if score is None else str(int(float(score)))
        score_slot = 70 * u
        display_name = name
        max_name_w = w - bar_w - score_slot - 40 * u
        while name_font.measure(display_name) > max(40, max_name_w) and len(display_name) > 4:
            display_name = display_name[:-2].rstrip() + "…"
        self._track(self.canvas.create_text(
            x, cy, anchor="w", text=display_name, fill=ink, font=name_font,
        ))
        bar_x1 = x + w - score_slot
        bar_x0 = bar_x1 - bar_w - 20 * u
        bar_y0 = cy - bar_h / 2
        self._track(self.canvas.create_rectangle(
            bar_x0, bar_y0, bar_x0 + bar_w, bar_y0 + bar_h, fill=track, outline="",
        ))
        frac = 0.0 if score is None else max(0.0, min(1.0, float(score) / 100.0))
        if frac > 0:
            self._track(self.canvas.create_rectangle(
                bar_x0, bar_y0, bar_x0 + bar_w * frac, bar_y0 + bar_h,
                fill=color, outline="",
            ))
        self._track(self.canvas.create_text(
            x + w, cy, anchor="e", text=score_text, fill=color, font=score_font,
        ))

    def _draw_rooms_block(self, x, y, w, avail_h, monitors, color_fallback, ink, ink3, track, u):
        rooms = []
        for monitor in monitors:
            label = str(monitor.get("label") or "Monitor")
            score = monitor.get("iaqScore")
            if score is None and isinstance(monitor.get("reading"), dict):
                score = monitor["reading"].get("iaqScore")
            mband = self.display_band(score, monitor.get("band"))
            rooms.append((label, score, self.band_color(mband)))
        if not rooms:
            return

        sec_font = ("Consolas", max(11, int(round(22 * u))))
        self._track(self.canvas.create_text(
            x, y, anchor="nw", text="BY ROOM", fill=ink3, font=sec_font,
        ))
        list_top = y + 32 * u
        max_rows = min(len(rooms), 8)
        # Pack from the top — never stretch a few rooms across the whole column.
        list_h = max(60 * u, avail_h - 32 * u)
        row_h = min(112 * u, max(72 * u, list_h / max(1, max_rows)))
        for index, (name, score, row_color) in enumerate(rooms[:max_rows]):
            self._draw_room_row(
                x, list_top + index * row_h, w, row_h,
                name, score, row_color or color_fallback, ink, track, u,
            )

    def _draw_metrics_row(self, x, y, width, values, *, accent, ink, line, u, cell_h: float | None = None) -> float:
        gap = 16 * u
        cell_w = (width - gap * 4) / 5
        met_h = cell_h if cell_h is not None else 120 * u
        for index, (key, label) in enumerate(self.METRICS):
            self._draw_metric_cell(
                x + index * (cell_w + gap), y, cell_w, met_h,
                label, self._metric_text(key, values.get(key)),
                accent, ink, line, u,
            )
        return y + met_h

    def _draw_metrics_grid(self, x, y, width, height, values, *, accent, ink, line, u) -> float:
        """Landscape metrics — one tight row of 5, or 3+2 wrap (no empty cell)."""
        gap = 16 * u
        # Prefer a single row when each cell has room for label + value.
        if width / 5 >= 150 * u:
            cell_h = min(130 * u, max(96 * u, height * 0.28))
            return self._draw_metrics_row(
                x, y, width, values,
                accent=accent, ink=ink, line=line, u=u, cell_h=cell_h,
            )
        # 3 on top, 2 below — both rows use the same cell width (⅓), bottom centered.
        cell_w = (width - gap * 2) / 3
        cell_h = min(120 * u, max(88 * u, (height * 0.42 - gap) / 2))
        top = self.METRICS[:3]
        bottom = self.METRICS[3:]
        for index, (key, label) in enumerate(top):
            self._draw_metric_cell(
                x + index * (cell_w + gap), y, cell_w, cell_h,
                label, self._metric_text(key, values.get(key)),
                accent, ink, line, u,
            )
        bottom_y = y + cell_h + gap
        bottom_span = len(bottom) * cell_w + gap * (len(bottom) - 1)
        bottom_x = x + max(0, (width - bottom_span) / 2)
        for index, (key, label) in enumerate(bottom):
            self._draw_metric_cell(
                bottom_x + index * (cell_w + gap), bottom_y, cell_w, cell_h,
                label, self._metric_text(key, values.get(key)),
                accent, ink, line, u,
            )
        return bottom_y + cell_h

    def _render(self, payload: dict):
        from src.design_system import ACCENT, INK, INK_2, INK_3, LINE, RING_TRACK

        reading = payload.get("reading") or {}
        spoken = payload.get("spokenResponse") or ""
        monitors = list(payload.get("monitors") or reading.get("monitors") or [])
        spoken_bits = parse_spoken_air_quality(spoken)
        air_config = self.config.get("airQuality") or {}

        iaq_score = reading.get("iaqScore")
        if iaq_score is None and spoken_bits.get("iaq_score") is not None:
            iaq_score = spoken_bits["iaq_score"]

        payload_band = reading.get("band") or spoken_bits.get("band")
        if not payload_band or payload_band == "unknown":
            payload_band = air_quality_band(
                iaq_score,
                good_min=air_config.get("goodMin", 80),
                fair_min=air_config.get("fairMin", 60),
                moderate_min=air_config.get("moderateMin", 40),
            )
            if payload_band == "unknown":
                qualitative = parse_qualitative_air_quality_band(spoken)
                if qualitative:
                    payload_band = qualitative
        band = self.display_band(iaq_score, payload_band)
        color = self.band_color(band)
        chrome = self._paint_header(self._updated_label(payload, reading))
        u = chrome.u

        values = {
            "temperatureF": reading.get("temperatureF") if reading.get("temperatureF") is not None else spoken_bits.get("temperature_f"),
            "humidity": reading.get("humidity") if reading.get("humidity") is not None else spoken_bits.get("humidity"),
            "pm25": reading.get("pm25") if reading.get("pm25") is not None else spoken_bits.get("pm25"),
            "co": reading.get("co") if reading.get("co") is not None else spoken_bits.get("co"),
            "voc": reading.get("voc") if reading.get("voc") is not None else spoken_bits.get("voc"),
        }
        self._merge_monitor_metric_values(values, monitors)

        if chrome.portrait:
            self._render_portrait(
                chrome, iaq_score, band, color, values, monitors,
                accent=ACCENT, ink=INK, ink3=INK_3, line=LINE, track=RING_TRACK,
            )
        else:
            self._render_landscape(
                chrome, iaq_score, band, color, values, monitors,
                accent=ACCENT, ink=INK, ink3=INK_3, line=LINE, track=RING_TRACK,
            )

    def _render_portrait(self, chrome, score, band, color, values, monitors, *, accent, ink, ink3, line, track):
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        bottom = chrome.content_bottom

        diameter = min(540 * u, width * 0.72)
        ring_cy = y0 + 30 * u + diameter / 2
        rating_font = self._draw_score_ring(
            x0 + width / 2, ring_cy, diameter, score, color, track, u,
        )
        self._track(self.canvas.create_text(
            x0 + width / 2,
            ring_cy + 0.18 * diameter,
            anchor="n",
            text=self.rating_word(band),
            fill=color,
            font=rating_font,
        ))

        scale_y = ring_cy + diameter / 2 + 40 * u
        after_scale = self._draw_band_scale(x0, scale_y, width, band, color, ink3, u)
        met_bottom = self._draw_metrics_row(
            x0, after_scale + 8 * u, width, values,
            accent=accent, ink=ink, line=line, u=u,
        )
        rooms_y = met_bottom + 30 * u
        self._draw_rooms_block(
            x0, rooms_y, width, bottom - rooms_y, monitors, color, ink, ink3, track, u,
        )

    def _render_landscape(self, chrome, score, band, color, values, monitors, *, accent, ink, ink3, line, track):
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        height = chrome.content_bottom - chrome.content_top
        gap = 36 * u
        # Wider right column — metrics + rooms need the real estate.
        left_w = width * 0.42
        right_w = width - left_w - gap
        right_x = x0 + left_w + gap

        diameter = min(560 * u, left_w * 0.92, height - 140 * u)
        block_h = diameter + 110 * u
        block_top = y0 + max(0, (height - block_h) / 2)
        cx = x0 + left_w / 2
        ring_cy = block_top + diameter / 2
        rating_font = self._draw_score_ring(cx, ring_cy, diameter, score, color, track, u)
        self._track(self.canvas.create_text(
            cx, ring_cy + 0.18 * diameter, anchor="n",
            text=self.rating_word(band), fill=color, font=rating_font,
        ))
        scale_y = ring_cy + diameter / 2 + 28 * u
        self._draw_band_scale(x0, scale_y, left_w, band, color, ink3, u)

        metrics_budget = min(height * 0.38, 280 * u)
        after_metrics = self._draw_metrics_grid(
            right_x, y0, right_w, metrics_budget, values,
            accent=accent, ink=ink, line=line, u=u,
        )
        rooms_top = after_metrics + 28 * u
        self._draw_rooms_block(
            right_x, rooms_top, right_w,
            chrome.content_bottom - rooms_top,
            monitors, color, ink, ink3, track, u,
        )

class TimerPanel(BasePanel):
    """Timers — count ladder (design-system §2.2 / HTML high-count modes).

    1–4: rings (size shrinks with count).
    5–9 (Mode B): soonest keeps a ring; rest are THEN rows (106–160 tall).
    10+ (Mode C): numeric strip + dense 3-col grid; timers >1h collapse to MORE.
    Always soonest-first. Only the next-to-fire uses accent (unless warn/alert).
    """

    WARN_SEC = 60
    ALERT_SEC = 10
    HERO_LIST_MAX = 9  # last count that keeps the hero ring (Mode B)
    COLLAPSE_SEC = 3600  # Mode C: collapse timers more than an hour out
    # Landscape ring Ø (design px). Portrait uses §2.2 sizes.
    LANDSCAPE_RING = {1: 760, 2: 700, 3: 560, 4: 420}
    PORTRAIT_RING = {1: 860, 2: 680, 3: 440, 4: 440}
    HERO_RING_L = 560
    HERO_RING_P = 420
    MODE_B_ROW_MIN = 106
    MODE_B_ROW_MAX = 160
    MODE_C_STRIP_H = 180
    MODE_C_ROW_H = 84

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._countdown_items: list[int] = []
        self._ring_arc_items: list[int] = []
        self._row_bar_items: list[tuple] = []
        self._color_roles: list[str] = []  # "soonest" | "muted" per tracked timer
        self._deadlines: list[float | None] = []
        self._durations: list[float] = []
        self._is_fired = False
        self._payload: dict | None = None
        self._timers: list[dict] = []
        self._local_fire_triggered = False
        self._on_local_fire = None
        self._chrome = None

    def set_on_local_fire(self, callback):
        self._on_local_fire = callback

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        self._payload = payload
        self._timers = list(payload.get("timers") or [])
        self._local_fire_triggered = False
        self._render(payload)
        if self._countdown_items and not self._is_fired:
            self._start_tick()

    def hide(self):
        super().hide()
        self._countdown_items.clear()
        self._ring_arc_items.clear()
        self._row_bar_items.clear()
        self._color_roles.clear()
        self._deadlines.clear()
        self._durations.clear()
        self._is_fired = False
        self._payload = None
        self._timers.clear()
        self._local_fire_triggered = False
        self._chrome = None

    def _start_tick(self):
        self._stop_tick()
        self._update_countdowns()
        self._tick_job = self.root.after(1000, self._tick)

    def _tick(self):
        if not self.visible:
            return
        self._update_countdowns()
        if self._local_fire_triggered or self._is_fired:
            return
        self._tick_job = self.root.after(1000, self._tick)

    @staticmethod
    def sort_soonest_first(timers: list[dict]) -> list[dict]:
        def key(timer: dict):
            rem = timer.get("remainingSec")
            fire_at = parse_iso_timestamp(timer.get("fireAt") or "")
            if fire_at is not None:
                return (0, fire_at.timestamp())
            if rem is not None:
                return (0, time.time() + max(0, int(rem)))
            return (1, 10**18)

        return sorted(timers, key=key)

    @classmethod
    def ring_diameter_u(cls, count: int, *, portrait: bool) -> float:
        """Design-px ring diameter for an all-rings layout (count 1–4)."""
        table = cls.PORTRAIT_RING if portrait else cls.LANDSCAPE_RING
        return float(table.get(max(1, min(4, count)), table[4]))

    @classmethod
    def layout_mode(cls, count: int) -> str:
        """`rings` | `hero` (Mode B, ≤9) | `dense` (Mode C, 10+)."""
        if count <= 4:
            return "rings"
        if count <= cls.HERO_LIST_MAX:
            return "hero"
        return "dense"

    @classmethod
    def remaining_now(cls, timer: dict) -> int:
        deadline = cls._deadline_for_timer(timer)
        if deadline is None:
            return max(0, int(timer.get("remainingSec") or 0))
        return max(0, int(math.ceil(deadline - time.time())))

    @classmethod
    def split_dense_timers(cls, timers: list[dict]) -> tuple[dict, list[dict], list[dict]]:
        """Soonest + under-1h rest + over-1h rest (Mode C collapse rule)."""
        hero = timers[0]
        near: list[dict] = []
        far: list[dict] = []
        for timer in timers[1:]:
            if cls.remaining_now(timer) > cls.COLLAPSE_SEC:
                far.append(timer)
            else:
                near.append(timer)
        return hero, near, far

    @staticmethod
    def format_more_collapse(count: int, next_timer: dict | None) -> str:
        """`+8 MORE · NEXT AT 10:47 PM`."""
        when = ""
        if next_timer:
            ends = format_timer_ends_label(next_timer)
            when = ends[5:] if ends.startswith("Ends ") else ends
        if when:
            return f"+{count} MORE · NEXT AT {when}"
        return f"+{count} MORE"

    def _arc_color(self, remaining: int, role: str) -> str:
        from src.design_system import ACCENT, WARN, ALERT, MUTE_ARC
        if remaining <= self.ALERT_SEC:
            return ALERT
        if remaining <= self.WARN_SEC:
            return WARN
        return ACCENT if role == "soonest" else MUTE_ARC

    def _update_countdowns(self):
        expired_index = None
        for index, deadline in enumerate(self._deadlines):
            if index >= len(self._countdown_items):
                continue
            remaining_id = self._countdown_items[index]
            if deadline is None:
                continue
            remaining = max(0, int(math.ceil(deadline - time.time())))
            role = self._color_roles[index] if index < len(self._color_roles) else "muted"
            color = self._arc_color(remaining, role)
            try:
                self.canvas.itemconfigure(remaining_id, text=format_timer_clock(remaining), fill=color)
            except Exception:
                pass
            if index < len(self._ring_arc_items):
                arc_id = self._ring_arc_items[index]
                if arc_id is not None and arc_id >= 0:
                    duration = self._durations[index] if index < len(self._durations) else 0
                    frac = 0.0 if duration <= 0 else max(0.0, min(1.0, remaining / duration))
                    try:
                        self.canvas.itemconfigure(arc_id, extent=-360.0 * frac, outline=color)
                    except Exception:
                        pass
            if index < len(self._row_bar_items):
                fill_id, x0, y0, x1, y1, duration = self._row_bar_items[index]
                if fill_id is not None:
                    frac = 0.0 if duration <= 0 else max(0.0, min(1.0, remaining / duration))
                    try:
                        self.canvas.coords(fill_id, x0, y0, x0 + (x1 - x0) * frac, y1)
                        self.canvas.itemconfigure(fill_id, fill=color)
                    except Exception:
                        pass
            if remaining == 0 and expired_index is None:
                expired_index = index

        if (
            expired_index is not None
            and not self._local_fire_triggered
            and self._on_local_fire
            and self._payload
            and expired_index < len(self._timers)
        ):
            self._local_fire_triggered = True
            self._stop_tick()
            self._on_local_fire(self._timers[expired_index], self._payload)

    @staticmethod
    def _deadline_for_timer(timer: dict) -> float | None:
        fire_at = parse_iso_timestamp(timer.get("fireAt") or "")
        if fire_at:
            return fire_at.timestamp()
        remaining = timer.get("remainingSec")
        if remaining is not None:
            return time.time() + max(0, int(remaining))
        return None

    def _screen(self) -> tuple[int, int]:
        overlay = getattr(self.shell, "overlay", None)
        w = int(getattr(overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        h = int(getattr(overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        return w, h

    def _paint_header(self, *, running: int, fired: bool):
        from src.page_header import paint_page_header
        from src.design_system import page_chrome

        sw, sh = self._screen()
        self._chrome = page_chrome(sw, sh, timed=True)
        paint_page_header(
            self.canvas,
            screen_w=sw,
            screen_h=sh,
            pill="TIMERS",
            left_label="SOURCE",
            left_value="Alexa",
            right_label="DONE" if fired else "RUNNING",
            right_value="1" if fired else str(running),
            track=self._track,
            sans_family=self.config.get("titleFontFamily", "Segoe UI"),
            mono_family="Consolas",
        )
        return self._chrome

    def _draw_ring(self, cx, cy, radius, stroke, frac, color, track):
        bbox = (cx - radius, cy - radius, cx + radius, cy + radius)
        self._track(self.canvas.create_oval(
            *bbox, outline=track, width=stroke, fill="",
        ))
        extent = -360.0 * max(0.0, min(1.0, frac))
        return self._track(self.canvas.create_arc(
            *bbox, start=90, extent=extent, style=tk.ARC, outline=color, width=stroke,
        ))

    def _ends_text(self, timer: dict, *, short: bool) -> str:
        full = format_timer_ends_label(timer)
        if not full:
            return ""
        if short and full.startswith("Ends "):
            return full[5:]
        return full

    def _paint_ring_block(
        self,
        timer: dict,
        *,
        cx: float,
        cy: float,
        diameter: float,
        u: float,
        role: str,
        short_ends: bool,
        long_clock: bool,
        ink2: str,
        ink3: str,
        track: str,
    ):
        radius = diameter / 2
        stroke = max(2.0, 0.023 * diameter)
        deadline = self._deadline_for_timer(timer)
        remaining = max(0, int(math.ceil((deadline or time.time()) - time.time())))
        duration = float(timer.get("durationSec") or remaining or 1)
        frac = remaining / duration if duration > 0 else 0.0
        color = self._arc_color(remaining, role)
        clock_scale = 0.18 if long_clock else 0.24
        clock_size = max(13, int(round(clock_scale * diameter)))
        lab_font = ("Consolas", max(11, int(round(26 * u))))
        clock_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=clock_size,
            weight="bold",
        )
        end_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(11, int(round(28 * u))),
        )

        self._track(self.canvas.create_text(
            cx, cy - radius - 14 * u, anchor="s",
            text=timer_display_label(timer), fill=ink3, font=lab_font,
        ))
        arc_id = self._draw_ring(cx, cy, radius, stroke, frac, color, track)
        remaining_id = self._track(self.canvas.create_text(
            cx, cy, anchor="center", text=format_timer_clock(remaining),
            fill=color, font=clock_font,
        ))
        ends = self._ends_text(timer, short=short_ends)
        if ends:
            self._track(self.canvas.create_text(
                cx, cy + radius + 14 * u, anchor="n", text=ends,
                fill=ink2, font=end_font,
            ))
        self._deadlines.append(deadline)
        self._durations.append(duration)
        self._countdown_items.append(remaining_id)
        self._ring_arc_items.append(arc_id)
        self._row_bar_items.append((None, 0, 0, 0, 0, duration))
        self._color_roles.append(role)

    @staticmethod
    def _row_display_name(timer: dict) -> str:
        """Title-case row name (HTML: `Pasta` / `10 min`)."""
        named = timer_label_name(timer)
        if named:
            return named
        chip = timer_display_label(timer)
        return chip.title() if chip != "TIMER" else chip

    def _paint_then_row(
        self,
        timer: dict,
        *,
        x: float,
        y: float,
        w: float,
        h: float,
        u: float,
        role: str,
        ink: str,
        ink2: str,
        ink3: str,
        track: str,
    ):
        """Mode B THEN row — clock · name · ends + drain bar (106–160 tall)."""
        deadline = self._deadline_for_timer(timer)
        remaining = max(0, int(math.ceil((deadline or time.time()) - time.time())))
        duration = float(timer.get("durationSec") or remaining or 1)
        frac = remaining / duration if duration > 0 else 0.0
        color = self._arc_color(remaining, role)
        # Mockup at the Mode B ceiling (9): 58 / 30 / 22 over 106-tall rows.
        time_font = ("Consolas", max(12, int(round(58 * u))))
        name_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(11, int(round(30 * u))),
        )
        end_font = ("Consolas", max(11, int(round(22 * u))))
        cy = y + h / 2
        time_col = 220 * u
        bar_h = max(2.0, 4 * u)
        bar_y1 = y + h
        bar_y0 = bar_y1 - bar_h

        self._track(self.canvas.create_rectangle(
            x, bar_y0, x + w, bar_y1, fill=track, outline="",
        ))
        fill_id = self._track(self.canvas.create_rectangle(
            x, bar_y0, x + w * frac, bar_y1, fill=color, outline="",
        ))

        remaining_id = self._track(self.canvas.create_text(
            x, cy, anchor="w", text=format_timer_clock(remaining),
            fill=color, font=time_font,
        ))
        display_name = self._row_display_name(timer)
        name_x = x + time_col + 18 * u
        ends = self._ends_text(timer, short=True)
        end_w = tkfont.Font(family="Consolas", size=max(11, int(round(22 * u)))).measure(ends or "")
        name_right = x + w - end_w - 16 * u
        while name_font.measure(display_name) > max(40, name_right - name_x) and len(display_name) > 4:
            display_name = display_name[:-2].rstrip() + "…"
        self._track(self.canvas.create_text(
            name_x, cy, anchor="w", text=display_name, fill=ink2, font=name_font,
        ))
        if ends:
            self._track(self.canvas.create_text(
                x + w, cy, anchor="e", text=ends, fill=ink3, font=end_font,
            ))

        self._deadlines.append(deadline)
        self._durations.append(duration)
        self._countdown_items.append(remaining_id)
        self._ring_arc_items.append(-1)  # no ring arc for list rows
        self._row_bar_items.append((fill_id, x, bar_y0, x + w, bar_y1, duration))
        self._color_roles.append(role)

    def _paint_dense_row(
        self,
        timer: dict,
        *,
        x: float,
        y: float,
        w: float,
        h: float,
        u: float,
        role: str,
        ink2: str,
        track: str,
    ):
        """Mode C compact cell — clock + name + thin drain bar (84 tall)."""
        deadline = self._deadline_for_timer(timer)
        remaining = max(0, int(math.ceil((deadline or time.time()) - time.time())))
        duration = float(timer.get("durationSec") or remaining or 1)
        frac = remaining / duration if duration > 0 else 0.0
        color = self._arc_color(remaining, role)
        time_font = ("Consolas", max(11, int(round(42 * u))))
        name_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(11, int(round(26 * u))),
        )
        cy = y + h / 2
        time_col = 150 * u
        bar_h = max(2.0, 3 * u)
        bar_y1 = y + h
        bar_y0 = bar_y1 - bar_h

        self._track(self.canvas.create_rectangle(
            x, bar_y0, x + w, bar_y1, fill=track, outline="",
        ))
        fill_id = self._track(self.canvas.create_rectangle(
            x, bar_y0, x + w * frac, bar_y1, fill=color, outline="",
        ))
        remaining_id = self._track(self.canvas.create_text(
            x, cy, anchor="w", text=format_timer_clock(remaining),
            fill=color, font=time_font,
        ))
        display_name = self._row_display_name(timer)
        name_x = x + time_col + 14 * u
        while name_font.measure(display_name) > max(30, x + w - name_x) and len(display_name) > 4:
            display_name = display_name[:-2].rstrip() + "…"
        self._track(self.canvas.create_text(
            name_x, cy, anchor="w", text=display_name, fill=ink2, font=name_font,
        ))

        self._deadlines.append(deadline)
        self._durations.append(duration)
        self._countdown_items.append(remaining_id)
        self._ring_arc_items.append(-1)
        self._row_bar_items.append((fill_id, x, bar_y0, x + w, bar_y1, duration))
        self._color_roles.append(role)

    def _paint_strip(
        self,
        timer: dict,
        *,
        x: float,
        y: float,
        w: float,
        h: float,
        u: float,
        ink2: str,
        ink3: str,
    ):
        """Mode C soonest strip — large clock + name + ENDS (no ring)."""
        deadline = self._deadline_for_timer(timer)
        remaining = max(0, int(math.ceil((deadline or time.time()) - time.time())))
        duration = float(timer.get("durationSec") or remaining or 1)
        color = self._arc_color(remaining, "soonest")
        clock_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(20, int(round(120 * u))),
            weight="bold",
        )
        name_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(13, int(round(40 * u))),
        )
        end_font = ("Consolas", max(11, int(round(24 * u))))
        cy = y + h / 2
        clock = format_timer_clock(remaining)
        remaining_id = self._track(self.canvas.create_text(
            x, cy, anchor="w", text=clock, fill=color, font=clock_font,
        ))
        clock_w = clock_font.measure(clock)
        name = self._row_display_name(timer)
        name_x = x + clock_w + 28 * u
        ends = self._ends_text(timer, short=True)
        ends_label = f"ENDS {ends}" if ends else ""
        end_w = tkfont.Font(family="Consolas", size=max(11, int(round(24 * u)))).measure(ends_label)
        name_right = x + w - end_w - 28 * u
        while name_font.measure(name) > max(40, name_right - name_x) and len(name) > 4:
            name = name[:-2].rstrip() + "…"
        self._track(self.canvas.create_text(
            name_x, cy, anchor="w", text=name, fill=ink2, font=name_font,
        ))
        if ends_label:
            self._track(self.canvas.create_text(
                x + w, cy, anchor="e", text=ends_label, fill=ink3, font=end_font,
            ))
        # Hairline under the strip (mockup border-bottom).
        from src.design_system import LINE
        self._track(self.canvas.create_rectangle(
            x, y + h - max(1.0, 1 * u), x + w, y + h,
            fill=LINE, outline="",
        ))

        self._deadlines.append(deadline)
        self._durations.append(duration)
        self._countdown_items.append(remaining_id)
        self._ring_arc_items.append(-1)
        self._row_bar_items.append((None, 0, 0, 0, 0, duration))
        self._color_roles.append("soonest")

    def _render(self, payload: dict):
        from src.design_system import INK, INK_2, INK_3, ALERT, RING_TRACK

        timers = list(payload.get("timers") or [])
        event = payload.get("event") or {}
        event_kind = event.get("kind", "list")
        self._is_fired = event_kind == "fired"
        if self._is_fired and not timers and event.get("timer"):
            timers = [event["timer"]]
        if not self._is_fired:
            timers = self.sort_soonest_first(timers)
        self._timers = timers

        chrome = self._paint_header(running=len(timers), fired=self._is_fired)
        u = chrome.u
        zone_x = chrome.content_x
        zone_y = chrome.content_top
        zone_w = chrome.content_w
        zone_h = chrome.content_bottom - chrome.content_top

        if self._is_fired:
            self._render_fired(timers, chrome, INK, ALERT, INK_2)
            return

        if not timers:
            self._track(self.canvas.create_text(
                zone_x + zone_w / 2, zone_y + zone_h / 2, anchor="center",
                text="No timers running", fill=INK_2, font=self.shell.body_font,
            ))
            return

        long_clock = any(
            (t.get("remainingSec") or 0) >= 3600
            or (t.get("durationSec") or 0) >= 3600
            for t in timers
        )
        mode = self.layout_mode(len(timers))
        if mode == "dense":
            self._render_dense(
                timers, chrome,
                ink2=INK_2, ink3=INK_3, track=RING_TRACK,
            )
            return
        if mode == "hero":
            self._render_hero_rows(
                timers, chrome, long_clock=long_clock,
                ink=INK, ink2=INK_2, ink3=INK_3, track=RING_TRACK,
            )
            return

        self._render_rings(
            timers, chrome, long_clock=long_clock,
            ink2=INK_2, ink3=INK_3, track=RING_TRACK,
        )

    def _render_rings(self, timers, chrome, *, long_clock, ink2, ink3, track):
        u = chrome.u
        count = len(timers)
        diameter = self.ring_diameter_u(count, portrait=chrome.portrait) * u
        # Cap by zone (label + ends ≈ 80 design px).
        max_d = max(120.0, chrome.content_bottom - chrome.content_top - 80 * u)
        diameter = min(diameter, max_d)
        gap = 24 * u
        zone_x = chrome.content_x
        zone_y = chrome.content_top
        zone_w = chrome.content_w
        zone_h = chrome.content_bottom - chrome.content_top

        if chrome.portrait:
            cols, rows = (2, 2) if count == 4 else (1, count)
        else:
            cols, rows = count, 1

        cell_w = (zone_w - gap * (cols - 1)) / max(1, cols)
        cell_h = (zone_h - gap * (rows - 1)) / max(1, rows)
        diameter = min(diameter, cell_w * 0.96, max(120.0, cell_h - 80 * u))
        diameter = max(120.0, diameter)
        short_ends = count >= 4 and not chrome.portrait

        for index, timer in enumerate(timers):
            if chrome.portrait and count == 4:
                row, col = divmod(index, cols)
            elif chrome.portrait:
                row, col = index, 0
            else:
                row, col = 0, index
            cx = zone_x + col * (cell_w + gap) + cell_w / 2
            cy = zone_y + row * (cell_h + gap) + cell_h / 2
            role = "soonest" if index == 0 else "muted"
            self._paint_ring_block(
                timer, cx=cx, cy=cy, diameter=diameter, u=u, role=role,
                short_ends=short_ends, long_clock=long_clock,
                ink2=ink2, ink3=ink3, track=track,
            )

    def _render_hero_rows(self, timers, chrome, *, long_clock, ink, ink2, ink3, track):
        """Mode B (5–9): hero ring + THEN rows compressed 106–160 tall."""
        u = chrome.u
        zone_x = chrome.content_x
        zone_y = chrome.content_top
        zone_w = chrome.content_w
        zone_h = chrome.content_bottom - chrome.content_top
        hero = timers[0]
        rest = timers[1:]

        if chrome.portrait:
            diameter = min(self.HERO_RING_P * u, zone_w * 0.7, zone_h * 0.38)
            hero_h = diameter + 80 * u
            self._paint_ring_block(
                hero,
                cx=zone_x + zone_w / 2,
                cy=zone_y + hero_h / 2,
                diameter=diameter,
                u=u,
                role="soonest",
                short_ends=False,
                long_clock=long_clock,
                ink2=ink2,
                ink3=ink3,
                track=track,
            )
            list_x = zone_x
            list_w = zone_w
            list_top = zone_y + hero_h + 12 * u
            list_h = chrome.content_bottom - list_top
        else:
            left_w = 736 * u
            gap = 24 * u
            diameter = min(self.HERO_RING_L * u, left_w * 0.92, zone_h - 80 * u)
            self._paint_ring_block(
                hero,
                cx=zone_x + left_w / 2,
                cy=zone_y + zone_h / 2,
                diameter=diameter,
                u=u,
                role="soonest",
                short_ends=False,
                long_clock=long_clock,
                ink2=ink2,
                ink3=ink3,
                track=track,
            )
            list_x = zone_x + left_w + gap
            list_w = zone_w - left_w - gap
            list_top = zone_y
            list_h = zone_h

        sec_font = ("Consolas", max(11, int(round(22 * u))))
        self._track(self.canvas.create_text(
            list_x, list_top, anchor="nw", text="THEN", fill=ink3, font=sec_font,
        ))
        rows_top = list_top + 36 * u
        avail = max(self.MODE_B_ROW_MIN * u, list_h - 36 * u)
        if not rest:
            return
        # Mode B shows every remaining timer (≤8 THEN rows at count 9).
        # clamp(avail / n, 106, 160) design px.
        row_h = max(
            self.MODE_B_ROW_MIN * u,
            min(self.MODE_B_ROW_MAX * u, avail / len(rest)),
        )

        for index, timer in enumerate(rest):
            self._paint_then_row(
                timer,
                x=list_x,
                y=rows_top + index * row_h,
                w=list_w,
                h=row_h,
                u=u,
                role="muted",
                ink=ink,
                ink2=ink2,
                ink3=ink3,
                track=track,
            )

    def _render_dense(self, timers, chrome, *, ink2, ink3, track):
        """Mode C (10+): strip + 3-col grid; collapse timers >1h (and space overflow)."""
        u = chrome.u
        zone_x = chrome.content_x
        zone_y = chrome.content_top
        zone_w = chrome.content_w
        zone_h = chrome.content_bottom - chrome.content_top
        hero, near, far = self.split_dense_timers(timers)

        strip_h = min(self.MODE_C_STRIP_H * u, zone_h * 0.28)
        self._paint_strip(
            hero, x=zone_x, y=zone_y, w=zone_w, h=strip_h, u=u,
            ink2=ink2, ink3=ink3,
        )

        grid_top = zone_y + strip_h + 20 * u
        grid_h = max(self.MODE_C_ROW_H * u, chrome.content_bottom - grid_top)
        cols = 2 if chrome.portrait else 3
        gap = 24 * u
        col_w = (zone_w - gap * (cols - 1)) / cols
        row_h = self.MODE_C_ROW_H * u
        rows_fit = max(1, int(grid_h // row_h))
        slots = cols * rows_fit

        collapsed = list(far)
        show = list(near)
        # Reserve last slot for the MORE row when anything is collapsed or overflows.
        if collapsed or len(show) > slots:
            show_slots = max(0, slots - 1)
        else:
            show_slots = slots
        if len(show) > show_slots:
            overflow = show[show_slots:]
            show = show[:show_slots]
            collapsed = overflow + collapsed

        for index, timer in enumerate(show):
            col = index // rows_fit
            row = index % rows_fit
            if col >= cols:
                break
            self._paint_dense_row(
                timer,
                x=zone_x + col * (col_w + gap),
                y=grid_top + row * row_h,
                w=col_w,
                h=row_h,
                u=u,
                role="muted",
                ink2=ink2,
                track=track,
            )

        if collapsed:
            # Place MORE in the next free cell (mockup: last column bottom).
            more_index = len(show)
            col = more_index // rows_fit
            row = more_index % rows_fit
            if col >= cols:
                col, row = cols - 1, rows_fit - 1
            label = self.format_more_collapse(len(collapsed), collapsed[0])
            self._track(self.canvas.create_text(
                zone_x + col * (col_w + gap),
                grid_top + row * row_h + row_h / 2,
                anchor="w",
                text=label,
                fill=ink3,
                font=("Consolas", max(11, int(round(26 * u)))),
            ))

    def _render_fired(self, timers, chrome, ink, alert, ink2):
        timer = timers[0] if timers else {}
        label = timer_label_name(timer)
        device = self._format_device_name(timer.get("device"))
        duration_sec = timer.get("durationSec")
        if label:
            headline = f'"{label}" timer finished!'
        elif duration_sec is not None:
            headline = f"{format_timer_set_label(duration_sec)} finished!"
        else:
            headline = "Timer finished!"
        cx = chrome.content_x + chrome.content_w / 2
        cy = chrome.content_top + (chrome.content_bottom - chrome.content_top) / 2
        self._track(self.canvas.create_text(
            cx, cy - 40, anchor="center", text=headline,
            fill=alert, font=self.shell.timer_alert_font,
        ))
        summary = timer_detail_line(timer, device, finished=True)
        self._track(self.canvas.create_text(
            cx, cy + 40, anchor="center", text=summary,
            fill=ink, font=self.shell.body_font,
        ))

    @staticmethod
    def _format_device_name(device: str | None) -> str:
        if not device:
            return "Unknown device"
        if len(device) >= 12 and device.isalnum() and device.upper() == device:
            return "Echo device"
        return device


class AlarmPanel(BasePanel):
    """Alarms — next alarm as hero + ALSO SET rows (landscape redesign)."""

    def _screen(self) -> tuple[int, int]:
        overlay = getattr(self.shell, "overlay", None)
        w = int(getattr(overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        h = int(getattr(overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        return w, h

    def _paint_header(self, count: int):
        from src.page_header import paint_page_header
        from src.design_system import page_chrome

        sw, sh = self._screen()
        chrome = page_chrome(sw, sh, timed=True)
        paint_page_header(
            self.canvas,
            screen_w=sw,
            screen_h=sh,
            pill="ALARMS",
            left_label="SOURCE",
            left_value="Alexa",
            right_label="SET",
            right_value=str(count),
            track=self._track,
            sans_family=self.config.get("titleFontFamily", "Segoe UI"),
            mono_family="Consolas",
        )
        return chrome

    def _render(self, payload: dict):
        from src.design_system import ACCENT, INK, INK_2, INK_3, LINE

        alarms = list(payload.get("alarms") or [])
        # Soonest first for the hero.
        alarms = sorted(
            alarms,
            key=lambda a: (
                a.get("remainingSec") is None,
                a.get("remainingSec") if a.get("remainingSec") is not None else 10**12,
            ),
        )
        chrome = self._paint_header(len(alarms))
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        height = chrome.content_bottom - chrome.content_top

        if not alarms:
            self._track(self.canvas.create_text(
                x0 + width / 2, y0 + height / 2, anchor="center",
                text="No active alarms", fill=INK_2, font=self.shell.body_font,
            ))
            return

        if chrome.portrait:
            self._render_portrait(alarms, chrome, ACCENT, INK, INK_2, INK_3, LINE)
        else:
            self._render_landscape(alarms, chrome, ACCENT, INK, INK_2, INK_3, LINE)

    def _render_landscape(self, alarms, chrome, accent, ink, ink2, ink3, line):
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        height = chrome.content_bottom - chrome.content_top
        left_w = 736 * u
        gap = 24 * u
        right_x = x0 + left_w + gap
        right_w = width - left_w - gap

        next_alarm = alarms[0]
        rest = alarms[1:]
        self._paint_next_hero(next_alarm, x0, y0, left_w, height, accent, ink, ink2, ink3, u)

        sec_font = ("Consolas", max(11, int(round(22 * u))))
        self._track(self.canvas.create_text(
            right_x, y0, anchor="nw", text="ALSO SET", fill=ink3, font=sec_font,
        ))
        list_top = y0 + 36 * u
        row_h = 140 * u
        max_rows = max(1, int((height - 36 * u) / row_h))
        for index, alarm in enumerate(rest[:max_rows]):
            self._paint_alarm_row(
                alarm,
                right_x,
                list_top + index * row_h,
                right_w,
                row_h,
                accent, ink, ink2, ink3, line, u,
            )

    def _render_portrait(self, alarms, chrome, accent, ink, ink2, ink3, line):
        u = chrome.u
        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        height = chrome.content_bottom - chrome.content_top
        hero_h = min(height * 0.42, 520 * u)
        self._paint_next_hero(alarms[0], x0, y0, width, hero_h, accent, ink, ink2, ink3, u)
        rest = alarms[1:]
        if not rest:
            return
        sec_font = ("Consolas", max(11, int(round(22 * u))))
        list_y = y0 + hero_h + 20 * u
        self._track(self.canvas.create_text(
            x0, list_y, anchor="nw", text="ALSO SET", fill=ink3, font=sec_font,
        ))
        list_y += 36 * u
        row_h = 120 * u
        max_rows = max(1, int((chrome.content_bottom - list_y) / row_h))
        for index, alarm in enumerate(rest[:max_rows]):
            self._paint_alarm_row(
                alarm, x0, list_y + index * row_h, width, row_h,
                accent, ink, ink2, ink3, line, u,
            )

    def _paint_next_hero(self, alarm, x, y, w, h, accent, ink, ink2, ink3, u):
        trigger = resolve_alarm_trigger_time(alarm)
        clock, ampm = format_alarm_clock_parts(trigger)
        primary, place = self._alarm_name_and_place(alarm)
        until = format_alarm_in_compact(alarm)
        sec_font = ("Consolas", max(11, int(round(22 * u))))
        hero_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(28, int(round(226 * u * min(1.0, w / max(1, 736 * u))))),
            weight="bold",
        )
        am_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(62 * u))),
            weight="bold",
        )
        lab_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(13, int(round(44 * u))),
        )
        place_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(32 * u))),
        )
        in_font = ("Consolas", max(11, int(round(26 * u))))

        cursor = y + max(0, (h - 420 * u) / 2)
        self._track(self.canvas.create_text(
            x, cursor, anchor="nw", text="NEXT ALARM", fill=ink3, font=sec_font,
        ))
        cursor += 40 * u
        self._track(self.canvas.create_text(
            x, cursor, anchor="nw", text=clock, fill=ink, font=hero_font,
        ))
        # AM/PM baseline-aligned to the right of the clock.
        clock_w = hero_font.measure(clock)
        self._track(self.canvas.create_text(
            x + clock_w + 16 * u, cursor + hero_font.metrics("ascent") - am_font.metrics("ascent"),
            anchor="nw", text=ampm, fill=ink2, font=am_font,
        ))
        cursor += hero_font.metrics("linespace") + 22 * u
        self._track(self.canvas.create_text(
            x, cursor, anchor="nw", text=primary, fill=ink, font=lab_font,
        ))
        if place:
            cursor += lab_font.metrics("linespace") + 8 * u
            self._track(self.canvas.create_text(
                x, cursor, anchor="nw", text=place, fill=ink2, font=place_font,
            ))
            last_font = place_font
        else:
            last_font = lab_font
        if until:
            cursor += last_font.metrics("linespace") + 14 * u
            self._track(self.canvas.create_text(
                x, cursor, anchor="nw", text=until, fill=accent, font=in_font,
            ))

    def _paint_alarm_row(self, alarm, x, y, w, h, accent, ink, ink2, ink3, line, u):
        off = str(alarm.get("status") or "").upper() == "OFF"
        trigger = resolve_alarm_trigger_time(alarm)
        clock, ampm = format_alarm_clock_parts(trigger)
        primary, place = self._alarm_name_and_place(alarm)
        chip = format_alarm_recurrence_chip(alarm)
        time_font = ("Consolas", max(13, int(round(46 * u))))
        am_font = ("Consolas", max(11, int(round(26 * u))))
        name_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(34 * u))),
        )
        place_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(10, int(round(24 * u))),
        )
        chip_font = ("Consolas", max(10, int(round(21 * u))))

        # Bottom hairline
        self._track(self.canvas.create_line(
            x, y + h - 1, x + w, y + h - 1, fill=line,
        ))
        cy = y + h / 2
        fill_time = ink3 if off else ink
        fill_name = ink3 if off else ink2
        fill_place = ink3 if off else ink3
        fill_chip = ink3 if off else accent
        chip_border = "#3a5070" if off else "#4a78a0"

        time_col_w = 230 * u
        self._track(self.canvas.create_text(
            x, cy, anchor="w", text=clock, fill=fill_time, font=time_font,
        ))
        tw = tkfont.Font(family="Consolas", size=max(13, int(round(46 * u)))).measure(clock)
        self._track(self.canvas.create_text(
            x + tw + 8 * u, cy + 6 * u, anchor="w", text=ampm,
            fill=ink3, font=am_font,
        ))
        name_x = x + time_col_w + 20 * u
        chip_pad_x, chip_pad_y = 13 * u, 6 * u
        chip_w = tkfont.Font(family="Consolas", size=max(10, int(round(21 * u)))).measure(chip) + chip_pad_x * 2
        chip_h = max(28 * u, 21 * u + chip_pad_y * 2)
        chip_x1 = x + w
        chip_x0 = chip_x1 - chip_w
        name_right = chip_x0 - 16 * u
        max_name_w = max(40, name_right - name_x)

        def _ellipsize(text: str, font) -> str:
            display = text
            while font.measure(display) > max_name_w and len(display) > 4:
                display = display[:-2].rstrip() + "…"
            return display

        if place:
            name_y = cy - (name_font.metrics("linespace") + place_font.metrics("linespace")) / 2
            self._track(self.canvas.create_text(
                name_x, name_y, anchor="nw",
                text=_ellipsize(primary, name_font), fill=fill_name, font=name_font,
            ))
            self._track(self.canvas.create_text(
                name_x, name_y + name_font.metrics("linespace") + 2 * u, anchor="nw",
                text=_ellipsize(place, place_font), fill=fill_place, font=place_font,
            ))
        else:
            self._track(self.canvas.create_text(
                name_x, cy, anchor="w",
                text=_ellipsize(primary, name_font), fill=fill_name, font=name_font,
            ))
        self._track(self.canvas.create_rectangle(
            chip_x0, cy - chip_h / 2, chip_x1, cy + chip_h / 2,
            outline=chip_border, width=max(1, int(round(u))), fill="",
        ))
        self._track(self.canvas.create_text(
            (chip_x0 + chip_x1) / 2, cy, anchor="center", text=chip,
            fill=fill_chip, font=chip_font,
        ))

    @classmethod
    def _alarm_name_and_place(cls, alarm: dict | None) -> tuple[str, str]:
        """Return (primary label, device place line). Place is empty when unknown."""
        place = cls._format_device_name((alarm or {}).get("device"))
        if place == "Unknown device":
            place = ""
        title = alarm_title(alarm)
        # Unlabeled alarms: promote the Echo name so the row isn't just "Alarm".
        if title == "Alarm" and place:
            return place, ""
        return title, place

    @staticmethod
    def _format_device_name(device: str | None) -> str:
        if not device:
            return "Unknown device"
        if len(device) >= 12 and device.isalnum() and device.upper() == device:
            return "Echo device"
        return device


class ShoppingListPanel(BasePanel):
    """Shopping list — large type for short lists; denser grid for 20–30+.

    Picks the largest (cols, font, row) that fits the whole list when possible;
    otherwise uses the densest layout and pages every PAGE_SECONDS.
    """

    PAGE_SECONDS = 12
    # (cols, font_u, row_u) — tried largest-first until everything fits.
    LANDSCAPE_DENSITY = (
        (2, 58, 170),
        (2, 46, 128),
        (2, 38, 100),
        (3, 34, 88),
        (3, 28, 72),
        (3, 24, 58),
    )
    PORTRAIT_DENSITY = (
        (1, 44, 120),
        (1, 36, 92),
        (1, 30, 74),
        (2, 28, 70),
        (2, 24, 58),
        (2, 20, 48),
    )

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._items: list[dict] = []
        self._page = 0
        self._page_size = 10
        self._added_item = None
        self._layout_cols = 2
        self._layout_font_u = 58
        self._layout_row_u = 170

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        self._items = list(payload.get("items") or [])
        self._added_item = (payload.get("addedItem") or "").strip().lower() or None
        self._page = 0
        self._apply_density()
        self._render_page()
        if self._page_count() > 1:
            self._tick_job = self.root.after(self.PAGE_SECONDS * 1000, self._next_page)

    def hide(self):
        super().hide()
        self._items = []
        self._page = 0

    def _screen(self) -> tuple[int, int]:
        overlay = getattr(self.shell, "overlay", None)
        w = int(getattr(overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        h = int(getattr(overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        return w, h

    @classmethod
    def pick_density(
        cls,
        count: int,
        *,
        portrait: bool,
        zone_h: float,
        u: float,
        reserve_cue: float = 0.0,
    ) -> tuple[int, float, float, int]:
        """Return (cols, font_u, row_u, page_cap) — largest layout that fits, else densest."""
        ladder = cls.PORTRAIT_DENSITY if portrait else cls.LANDSCAPE_DENSITY
        usable = max(80.0, zone_h - reserve_cue)
        best = None
        for cols, font_u, row_u in ladder:
            rows = max(1, int(usable / max(1.0, row_u * u)))
            cap = rows * cols
            best = (cols, font_u, row_u, cap)
            if count <= cap:
                return best
        return best or (2, 24, 58, max(1, count))

    def _apply_density(self):
        from src.design_system import page_chrome
        sw, sh = self._screen()
        chrome = page_chrome(sw, sh, timed=True)
        zone_h = chrome.content_bottom - chrome.content_top
        # Leave a little room for the page cue when we might need paging.
        reserve = 28 * chrome.u if len(self._items) > 12 else 0
        cols, font_u, row_u, cap = self.pick_density(
            len(self._items),
            portrait=chrome.portrait,
            zone_h=zone_h,
            u=chrome.u,
            reserve_cue=reserve,
        )
        self._layout_cols = cols
        self._layout_font_u = font_u
        self._layout_row_u = row_u
        self._page_size = max(1, cap)

    def _page_count(self) -> int:
        if not self._items:
            return 1
        return max(1, math.ceil(len(self._items) / self._page_size))

    def _next_page(self):
        self._tick_job = None
        if not self.visible:
            return
        self._page = (self._page + 1) % self._page_count()
        for item_id in self._item_ids:
            self.canvas.delete(item_id)
        self._item_ids.clear()
        self._render_page()
        if self._page_count() > 1:
            self._tick_job = self.root.after(self.PAGE_SECONDS * 1000, self._next_page)

    def _render(self, payload: dict):  # pragma: no cover - show() drives rendering
        self._render_page()

    def _render_page(self):
        from src.design_system import ACCENT, INK, INK_2, INK_3, LINE, page_chrome
        from src.page_header import paint_page_header

        sw, sh = self._screen()
        chrome = page_chrome(sw, sh, timed=True)
        u = chrome.u
        count = len(self._items)
        paint_page_header(
            self.canvas,
            screen_w=sw,
            screen_h=sh,
            pill="SHOPPING LIST",
            left_label="SOURCE",
            left_value="Alexa",
            right_label="ITEMS",
            right_value=str(count),
            track=self._track,
            sans_family=self.config.get("titleFontFamily", "Segoe UI"),
            mono_family="Consolas",
        )

        x0 = chrome.content_x
        y0 = chrome.content_top
        width = chrome.content_w
        height = chrome.content_bottom - chrome.content_top

        if not self._items:
            self._track(self.canvas.create_text(
                x0 + width / 2, y0 + height / 2, anchor="center",
                text="Nothing on the shopping list",
                fill=INK_2, font=self.shell.body_font,
            ))
            return

        cols = max(1, self._layout_cols)
        gap = 20 * u if cols >= 3 else 24 * u
        col_w = (width - gap * (cols - 1)) / cols
        pages = self._page_count()
        cue_reserve = 28 * u if pages > 1 else 0
        rows_per_col = max(1, math.ceil(self._page_size / cols))
        usable_h = max(80.0, height - cue_reserve)
        row_h = min(self._layout_row_u * u * 1.12, usable_h / rows_per_col)
        start = self._page * self._page_size
        page_items = self._items[start : start + self._page_size]

        item_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(self._layout_font_u * u))),
        )

        # Fill column-major (top→bottom, left→right) so short lists stay left-heavy.
        per_col = rows_per_col
        for col in range(cols):
            col_items = page_items[col * per_col : (col + 1) * per_col]
            cx = x0 + col * (col_w + gap)
            for index, item in enumerate(col_items):
                value = str(item.get("value") or "")
                is_new = (
                    self._added_item is not None
                    and value.strip().lower() == self._added_item
                )
                row_y = y0 + index * row_h
                self._track(self.canvas.create_line(
                    cx, row_y + row_h - 1, cx + col_w, row_y + row_h - 1, fill=LINE,
                ))
                display = value
                max_w = col_w - 8 * u
                while item_font.measure(display) > max_w and len(display) > 4:
                    display = display[:-2].rstrip() + "…"
                self._track(self.canvas.create_text(
                    cx, row_y + row_h / 2, anchor="w",
                    text=display,
                    fill=ACCENT if is_new else INK,
                    font=item_font,
                ))

        if pages > 1:
            cue = f"{self._page + 1} / {pages}"
            self._track(self.canvas.create_text(
                x0 + width / 2, chrome.content_bottom - 8 * u, anchor="s",
                text=cue, fill=INK_3,
                font=("Consolas", max(11, int(round(20 * u)))),
            ))

class MusicPanel(BasePanel):
    # Soft cap only — actual size is driven by available space (see
    # _render_stack/_render_landscape) so the art fills the screen instead of
    # sitting at a fixed size with hundreds of unused pixels around it.
    ART_SIZE = 900

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._art_image = None  # keep a reference or Tk garbage-collects it
        self._art_request = 0
        self._art_placeholder_ids: list[int] = []
        self._marquees: list[MarqueeLine] = []
        self._tick_job = None
        self._progress_text_id = None
        self._progress_fill_id = None
        self._progress_track = None  # (x0, y0, x1, y1)
        self._media_length_sec = None
        self._media_progress_sec = None
        self._progress_at = None
        self._playback_playing = True
        self._auto_dismissed = False

    def hide(self):
        self._stop_progress_tick()
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []
        self._progress_text_id = None
        self._progress_fill_id = None
        self._progress_track = None
        self._media_length_sec = None
        self._media_progress_sec = None
        self._progress_at = None
        self._auto_dismissed = False
        super().hide()

    def _stop_progress_tick(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None

    def _draw_marquee_line(self, center_x, y, text, font, fill, width) -> int:
        """Draws one line of Now Playing text (song/artist/album/detail)
        as a single line — long titles that don't fit scroll horizontally
        on a loop instead of wrapping, which could otherwise blow past the
        fixed vertical space reserved for these stacked lines."""
        marquee = MarqueeLine(self.root)
        self._marquees.append(marquee)
        height = font.metrics("linespace")
        viewport = marquee.build(
            parent=self.root,
            text=text,
            font=font,
            fill=fill,
            width=width,
            height=height,
            bg=self.config["overlayBackground"],
            center=True,
        )
        self._place_widget(viewport, x=center_x - width // 2, y=y)
        return height

    def _render(self, payload: dict):
        layout = self.shell.layout
        music = payload.get("music") or {}
        # Bridge emits `empty: true` (song null) when a "what's playing"
        # query couldn't resolve a track after retries — show a clear
        # empty state instead of the old "Unknown track" placeholder
        # that looked like a bug.
        if music.get("empty") or (
            not music.get("song") and payload.get("trigger") == "music-query"
        ):
            self._render_empty(layout, music.get("device") or payload.get("device"))
            return
        song = music.get("song") or "Unknown track"
        artist = music.get("artist")
        album = music.get("album")
        provider = music.get("provider")
        device = music.get("device") or payload.get("device")
        art_url = music.get("artUrl")
        self._bind_progress(music)

        if layout.portrait:
            self._render_stack(layout, song, artist, album, provider, device, art_url)
        else:
            self._render_landscape(layout, song, artist, album, provider, device, art_url)
        if self._media_length_sec is not None:
            self._start_progress_tick()

    def _bind_progress(self, music: dict):
        self._media_length_sec = None
        self._media_progress_sec = None
        self._progress_at = None
        self._playback_playing = str(music.get("state") or "PLAYING").upper() == "PLAYING"
        try:
            length = music.get("mediaLengthSec")
            if length is not None:
                self._media_length_sec = max(0, int(float(length)))
        except (TypeError, ValueError):
            self._media_length_sec = None
        try:
            progress = music.get("mediaProgressSec")
            if progress is not None:
                self._media_progress_sec = max(0, int(float(progress)))
        except (TypeError, ValueError):
            self._media_progress_sec = 0 if self._media_length_sec is not None else None
        self._progress_at = music.get("progressAt")

    def _progress_remaining(self) -> int | None:
        return music_remaining_seconds(
            media_length_sec=self._media_length_sec,
            media_progress_sec=self._media_progress_sec,
            progress_at=self._progress_at,
            playing=self._playback_playing,
        )

    def _progress_label(self, remaining: int | None) -> str:
        return format_music_progress_label(self._media_length_sec, remaining)

    def _draw_progress_block(self, x0, y, width, *, accent, muted) -> int:
        """Progress rail + `Length 3m49s - 1m37s left`. Returns height used."""
        if self._media_length_sec is None:
            return 0
        remaining = self._progress_remaining()
        label = self._progress_label(remaining)
        label_font = self.shell.chip_value_font
        label_h = label_font.metrics("linespace")
        self._progress_text_id = self._track(self.canvas.create_text(
            x0 + width / 2, y, anchor="n", text=label, fill=muted, font=label_font,
        ))
        rail_y = y + label_h + 10
        rail_h = max(4, 8)
        track_fill = "#1a2438"
        self._track(self.canvas.create_rectangle(
            x0, rail_y, x0 + width, rail_y + rail_h, fill=track_fill, outline="",
        ))
        length = max(1, int(self._media_length_sec))
        played = length - (remaining if remaining is not None else 0)
        frac = max(0.0, min(1.0, played / length))
        fill_w = width * frac
        self._progress_fill_id = self._track(self.canvas.create_rectangle(
            x0, rail_y, x0 + fill_w, rail_y + rail_h, fill=accent, outline="",
        ))
        self._progress_track = (x0, rail_y, x0 + width, rail_y + rail_h)
        return label_h + 10 + rail_h + 8

    def _start_progress_tick(self):
        self._stop_progress_tick()
        self._tick_job = self.root.after(1000, self._on_progress_tick)

    def _on_progress_tick(self):
        self._tick_job = None
        if not self.visible or self._auto_dismissed:
            return
        remaining = self._progress_remaining()
        if remaining is not None and remaining <= 0:
            self._auto_dismissed = True
            self._dismiss_overlay()
            return
        if self._progress_text_id is not None:
            try:
                self.canvas.itemconfigure(
                    self._progress_text_id, text=self._progress_label(remaining),
                )
            except Exception:
                pass
        if self._progress_fill_id is not None and self._progress_track is not None:
            x0, y0, x1, y1 = self._progress_track
            length = max(1, int(self._media_length_sec or 1))
            played = length - (remaining if remaining is not None else 0)
            frac = max(0.0, min(1.0, played / length))
            try:
                self.canvas.coords(self._progress_fill_id, x0, y0, x0 + (x1 - x0) * frac, y1)
            except Exception:
                pass
        self._tick_job = self.root.after(1000, self._on_progress_tick)

    def _dismiss_overlay(self):
        overlay = getattr(self.shell, "overlay", None)
        if overlay is not None and hasattr(overlay, "dismiss_immediately"):
            try:
                overlay.dismiss_immediately()
                return
            except Exception:
                pass
        self.hide()

    def _art_size_for_layout(self, layout) -> tuple[int, float, float]:
        """Return (art_size, art_cx, art_cy) matching the playing layouts."""
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        title_h = self.shell.section_title_font.metrics("linespace")
        body_h = self.shell.body_font.metrics("linespace")
        if layout.portrait:
            text_block = title_h + body_h + 10 + 24
            available = bottom - y - text_block
            art_size = min(self.ART_SIZE, max(330, min(width - 48, available - 16)))
            return art_size, x + width // 2, y + art_size // 2 + 8
        gap = 56
        text_col_width = max(300, int(width * 0.36))
        art_col_width = width - text_col_width - gap
        available_h = bottom - y
        art_size = min(self.ART_SIZE, max(280, min(art_col_width, available_h - 16)))
        return art_size, x + art_col_width // 2, y + available_h // 2

    def _render_empty(self, layout, device):
        x = layout.content_x
        width = layout.content_width
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#5FD0FF")
        art_size, art_cx, art_cy = self._art_size_for_layout(layout)
        self._draw_empty_album_art(art_cx, art_cy, art_size, accent)

        if layout.portrait:
            text_cx = art_cx
            cursor = art_cy + art_size // 2 + 28
            text_w = width - 40
        else:
            gap = 56
            text_col_width = max(300, int(width * 0.36))
            art_col_width = width - text_col_width - gap
            text_cx = x + art_col_width + gap + text_col_width // 2
            title_h = self.shell.section_title_font.metrics("linespace")
            body_h = self.shell.body_font.metrics("linespace")
            text_h = title_h + 10 + body_h
            cursor = art_cy - text_h // 2
            text_w = text_col_width

        self._track(
            self.canvas.create_text(
                text_cx, cursor, anchor="n", text="Nothing playing",
                fill=text, font=self.shell.section_title_font,
                width=text_w, justify=tk.CENTER,
            )
        )
        cursor += self.shell.section_title_font.metrics("linespace") + 10
        subtitle = f"Asked on {device}" if device else "No track is playing right now"
        self._track(
            self.canvas.create_text(
                text_cx, cursor, anchor="n", text=subtitle,
                fill=muted, font=self.shell.body_font,
                width=text_w, justify=tk.CENTER,
            )
        )

    def _draw_empty_album_art(self, cx, cy, size, accent):
        """Album-sized empty cover — two-tone field matching design mockups."""
        self._art_placeholder_ids = []
        size = max(120, int(size))
        photo = self._make_empty_album_photo(size, accent)
        if photo is not None:
            self._art_image = photo
            img_id = self._track(self.canvas.create_image(cx, cy, image=photo))
            self._art_placeholder_ids.append(img_id)
            # Soft edge plate so the field reads as a cover, not a floating bitmap.
            frame_id = self._round_rect(
                cx - size // 2, cy - size // 2, cx + size // 2, cy + size // 2,
                radius=0, fill="", outline=self.CARD_EDGE, width=1,
            )
            self._art_placeholder_ids.append(frame_id)
            return
        self._draw_art_placeholder(cx, cy, size, accent, False)

    @staticmethod
    def _make_empty_album_photo(size: int, accent: str):
        if Image is None or ImageTk is None:
            return None
        try:
            from PIL import ImageDraw
        except ImportError:
            return None
        size = max(64, int(size))
        # Neutral two-tone square (no lettering) — same language as photo mockups.
        dark = (20, 32, 52)
        mid = (36, 52, 78)
        try:
            hex_accent = (accent or "#5FD0FF").lstrip("#")
            ar, ag, ab = int(hex_accent[0:2], 16), int(hex_accent[2:4], 16), int(hex_accent[4:6], 16)
            tint = (
                int(dark[0] * 0.65 + ar * 0.35),
                int(dark[1] * 0.65 + ag * 0.35),
                int(dark[2] * 0.65 + ab * 0.35),
            )
        except (TypeError, ValueError, IndexError):
            tint = mid
        img = Image.new("RGB", (size, size), dark)
        draw = ImageDraw.Draw(img)
        # Diagonal wash + centred diamond so the plate reads as a cover, not a void.
        draw.polygon([(size, 0), (size, size), (0, size)], fill=tint)
        inset = max(10, size // 7)
        draw.rectangle((inset, inset, size - inset, size - inset), outline=mid, width=max(2, size // 80))
        cx = cy = size // 2
        r = max(18, size // 6)
        draw.polygon([(cx, cy - r), (cx + r, cy), (cx, cy + r), (cx - r, cy)], fill=dark, outline=mid)
        try:
            return ImageTk.PhotoImage(img)
        except Exception:
            return None

    def _draw_art_placeholder(self, cx, cy, size, accent, loading_art):
        # Empty stage plate only — nothing composited over artwork (§1.10).
        self._art_placeholder_ids = []
        rect_id = self._round_rect(
            cx - size // 2,
            cy - size // 2,
            cx + size // 2,
            cy + size // 2,
            radius=0,
            fill=self.CARD,
            outline=accent if not loading_art else self.CARD_EDGE,
            width=2 if not loading_art else 1,
        )
        self._art_placeholder_ids.append(rect_id)

    def _render_stack(self, layout, song, artist, album, provider, device, art_url):
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        center_x = x + width // 2

        text_block = self.shell.section_title_font.metrics("linespace")
        if artist:
            text_block += self.shell.body_font.metrics("linespace") + 8
        if album:
            text_block += self.shell.body_font.metrics("linespace") + 8
        text_block += self.shell.chip_value_font.metrics("linespace") + 24
        if self._media_length_sec is not None:
            text_block += self.shell.chip_value_font.metrics("linespace") + 30

        available = bottom - y - text_block
        art_size = min(self.ART_SIZE, max(330, min(width - 48, available - 16)))
        art_y = y + art_size // 2 + 8

        loading_art = bool(art_url and Image is not None)
        self._draw_art_placeholder(center_x, art_y, art_size, accent, loading_art)
        if loading_art:
            self._load_art_async(art_url, center_x, art_y, art_size)

        cursor = art_y + art_size // 2 + 28
        cursor += self._draw_marquee_line(
            center_x, cursor, song, self.shell.section_title_font, text, width - 40,
        ) + 10
        if artist:
            cursor += self._draw_marquee_line(
                center_x, cursor, artist, self.shell.body_font, accent, width - 40,
            ) + 8
        if album:
            cursor += self._draw_marquee_line(
                center_x, cursor, album, self.shell.body_font, muted, width - 40,
            ) + 12

        detail_parts = []
        if provider:
            detail_parts.append(provider)
        if device:
            detail_parts.append(f"on {device}")
        if detail_parts:
            cursor += self._draw_marquee_line(
                center_x,
                cursor,
                " · ".join(detail_parts),
                self.shell.chip_value_font,
                muted,
                width - 40,
            ) + 14
        self._draw_progress_block(
            x + 24, cursor, max(120, width - 48), accent=accent, muted=muted,
        )

    def _render_landscape(self, layout, song, artist, album, provider, device, art_url):
        # Landscape had the same single centered column as portrait, wasting
        # roughly half the screen's width. Split into art (left) + track info
        # (right), each vertically centered in the message area, so the art
        # can grow with the full available height instead of being squeezed
        # by the text stacked underneath it.
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")

        title_font = self.shell.section_title_font
        body_font = self.shell.body_font
        detail_font = self.shell.chip_value_font

        detail_parts = []
        if provider:
            detail_parts.append(provider)
        if device:
            detail_parts.append(f"on {device}")

        text_h = title_font.metrics("linespace")
        if artist:
            text_h += body_font.metrics("linespace") + 10
        if album:
            text_h += body_font.metrics("linespace") + 10
        if detail_parts:
            text_h += detail_font.metrics("linespace") + 14
        if self._media_length_sec is not None:
            text_h += detail_font.metrics("linespace") + 30

        gap = 56
        text_col_width = max(300, int(width * 0.36))
        art_col_width = width - text_col_width - gap
        available_h = bottom - y
        art_size = min(self.ART_SIZE, max(280, min(art_col_width, available_h - 16)))
        art_cx = x + art_col_width // 2
        art_cy = y + available_h // 2

        loading_art = bool(art_url and Image is not None)
        self._draw_art_placeholder(art_cx, art_cy, art_size, accent, loading_art)
        if loading_art:
            self._load_art_async(art_url, art_cx, art_cy, art_size)

        text_center_x = x + art_col_width + gap + text_col_width // 2
        cursor = art_cy - text_h // 2

        cursor += self._draw_marquee_line(
            text_center_x, cursor, song, title_font, text, text_col_width,
        ) + 10
        if artist:
            cursor += self._draw_marquee_line(
                text_center_x, cursor, artist, body_font, accent, text_col_width,
            ) + 10
        if album:
            cursor += self._draw_marquee_line(
                text_center_x, cursor, album, body_font, muted, text_col_width,
            ) + 14
        if detail_parts:
            cursor += self._draw_marquee_line(
                text_center_x,
                cursor,
                " · ".join(detail_parts),
                detail_font,
                muted,
                text_col_width,
            ) + 14
        self._draw_progress_block(
            x + art_col_width + gap, cursor, text_col_width, accent=accent, muted=muted,
        )

    def _load_art_async(self, url: str, cx: float, cy: float, size: int):
        self._art_request += 1
        request_id = self._art_request

        def fetch():
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "alexa-broadcast-client/1.0"})
                with urllib.request.urlopen(request, timeout=6) as response:
                    raw = response.read()
                image = Image.open(io.BytesIO(raw)).convert("RGB")
                image = image.resize((size, size), Image.LANCZOS)
            except Exception:
                return
            self.root.after(0, lambda: self._apply_art(request_id, image, cx, cy))

        threading.Thread(target=fetch, daemon=True).start()

    def _clear_art_placeholder(self):
        for item_id in self._art_placeholder_ids:
            self.canvas.delete(item_id)
            if item_id in self._item_ids:
                self._item_ids.remove(item_id)
        self._art_placeholder_ids.clear()

    @staticmethod
    def _round_image_corners(image, radius: int):
        try:
            from PIL import ImageDraw
        except ImportError:
            return image
        image = image.convert("RGBA")
        mask = Image.new("L", image.size, 0)
        draw = ImageDraw.Draw(mask)
        draw.rounded_rectangle((0, 0, image.size[0], image.size[1]), radius=radius, fill=255)
        image.putalpha(mask)
        return image

    def _apply_art(self, request_id: int, image, cx: float, cy: float):
        if not self.visible or request_id != self._art_request:
            return
        self._clear_art_placeholder()
        # Sharp album art (radius 0) — no glyph/scrim on the image (§1.10).
        self._art_image = ImageTk.PhotoImage(image.convert("RGBA") if hasattr(image, "convert") else image)
        self._track(self.canvas.create_image(cx, cy, image=self._art_image))


class TeslaBatteryPanel(BasePanel):
    IMAGE_NAME = "tesla-model-y.png"
    IMAGE_MAX_WIDTH = 760

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._photo = None

    def _render(self, payload: dict):
        from src.design_system import ACCENT, ALERT, GOOD, WARN, page_chrome
        from src.page_header import paint_page_header

        screen_w, screen_h = int(self.shell.screen_w), int(self.shell.screen_h)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        battery = payload.get("battery") or {}
        percent = battery.get("percent")
        if percent is None:
            percent = parse_spoken_battery_percent(payload.get("spokenResponse"))
        value = None if percent is None else max(0, min(100, int(round(float(percent)))))
        model = str(battery.get("model") or "Model Y")
        status = str(battery.get("status") or "ok")
        stale = bool(battery.get("stale"))
        is_error = not stale and (status not in ("ok", "") or (value is None and battery.get("error")))
        updated = payload.get("timestamp") or battery.get("cachedAt") or battery.get("fetchedAt") or ""
        paint_page_header(
            self.canvas, screen_w=screen_w, screen_h=screen_h, pill="Tesla Battery",
            left_label="Vehicle", left_value=model, right_label="Updated",
            right_value=format_chip_timestamp(updated).split("·")[-1].strip() if updated else "",
            track=self._track,
        )
        x, y, w, bottom = chrome.content_x, chrome.content_top, chrome.content_w, chrome.content_bottom
        bits = self._status_bits(
            battery, stale, format_limit_reset_time(battery.get("limitResetAt")),
            "",  # charging shown as chip in specs, not banner body
            is_error,
        )
        if bits:
            y = self._draw_battery_status(x, y, w, bits, chrome.u) + 18 * chrome.u
        color = GOOD if not is_error else (WARN if status == "rate_limited" else ALERT)
        text = str(battery.get("error")) if is_error and battery.get("error") else format_battery_percent(percent)
        if chrome.portrait:
            car_h = max(180 * chrome.u, min((bottom - y) * .38, 500 * chrome.u))
            self._place_car_image(x + w / 2, y, min(w - 40 * chrome.u, 760 * chrome.u), car_h, ACCENT, self.CARD)
            self._draw_battery_specs(x, y + car_h + 18 * chrome.u, w, text, value, color, battery, portrait=True)
        else:
            left_w, gap = min(1040 * chrome.u, w * .56), 24 * chrome.u
            self._place_car_image(x + left_w / 2, y, left_w - 20 * chrome.u, bottom - y, ACCENT, self.CARD)
            self._draw_battery_specs(x + left_w + gap, y, w - left_w - gap, text, value, color, battery, portrait=False)

    def _draw_battery_status(self, x, y, w, bits, u):
        # Pill + legend (stale/refreshing) and optional body lines (rate-limit retry).
        # Charging is drawn as a chip in specs, not here.
        cursor = y
        label_font = self.shell.forecast_label_font
        body_font = self.shell.body_font
        for bit in bits:
            kind = bit.get("kind")
            if kind == "pill":
                h = self._pill(
                    x, cursor, bit["text"],
                    fill=bit["fill"], fg=bit["fg"], outline=bit["outline"],
                    anchor="nw", font=label_font,
                )
                cursor += h + 6 * u
            elif kind == "legend":
                self._track(self.canvas.create_text(
                    x, cursor, anchor="nw", text=bit["text"], fill=bit["fill"],
                    font=label_font, width=w, justify="left",
                ))
                cursor += label_font.metrics("linespace") + 8 * u
            elif kind == "body":
                self._track(self.canvas.create_text(
                    x, cursor, anchor="nw", text=bit["text"], fill=bit["fill"],
                    font=body_font, width=w, justify="left",
                ))
                cursor += body_font.metrics("linespace") + 8 * u
        return cursor

    def _draw_battery_specs(self, x, y, w, percent_text, percent, color, battery, *, portrait):
        from src.design_system import INK, INK_2, LINE
        title, body, label = self.shell.section_title_font, self.shell.body_font, self.shell.forecast_label_font
        range_value = battery.get("batteryRange", battery.get("rangeMiles"))
        range_text = f"{range_value} mi" if range_value not in (None, "") else "— mi"
        self._track(self.canvas.create_text(x, y, anchor="nw", text=percent_text, fill=INK, font=title))
        self._track(self.canvas.create_text(x, y + title.metrics("linespace") + 4, anchor="nw", text=range_text, fill=INK_2, font=body))
        gauge_y = y + title.metrics("linespace") + body.metrics("linespace") + 22
        gauge_h = self.battery_bar_height(title.metrics("linespace"), portrait=portrait)
        self._draw_ticked_gauge(x, gauge_y, w, gauge_h, percent, color, battery)
        cursor = gauge_y + gauge_h + 16
        charging = str(battery.get("chargingLabel") or battery.get("chargingState") or "").strip()
        if charging:
            cursor += self._pill(x, cursor, charging, fill=self.CARD, fg=INK, outline=LINE,
                                 anchor="nw", font=label) + 14
        for row, raw, suffix in (
            ("CHARGE LIMIT", battery.get("chargeLimit", battery.get("chargeLimitSoc")), "%"),
            ("LAST CHARGE", battery.get("lastChargeKwh"), " kWh"),
            ("RANGE ADDED", battery.get("rangeAddedMiles"), " mi"),
        ):
            if raw in (None, ""):
                continue
            self._track(self.canvas.create_text(x, cursor, anchor="nw", text=row, fill=INK_2, font=label))
            self._track(self.canvas.create_text(x + w, cursor, anchor="ne", text=f"{raw}{suffix}", fill=INK, font=body))
            cursor += max(label.metrics("linespace"), body.metrics("linespace")) + 10

    def _draw_ticked_gauge(self, x, y, w, h, percent, fill, battery):
        from src.design_system import LINE
        self._round_rect(x, y, x + w, y + h, radius=0, fill=self.INNER, outline=LINE, width=2)
        if percent is not None:
            filled = max(0, min(w - 4, int((w - 4) * percent / 100)))
            if filled:
                self._round_rect(x + 2, y + 2, x + 2 + filled, y + h - 2, radius=0, fill=fill)
        for mark in range(0, 101, 20):
            tick_x = x + w * mark / 100
            self._track(self.canvas.create_line(tick_x, y + h - 12, tick_x, y + h, fill=LINE, width=2))
        limit = battery.get("chargeLimit", battery.get("chargeLimitSoc"))
        if isinstance(limit, (int, float)):
            tick_x = x + w * max(0, min(100, limit)) / 100
            self._track(self.canvas.create_line(tick_x, y - 8, tick_x, y + h + 8, fill="#F2F7FF", width=2))
            self._track(self.canvas.create_text(tick_x, y - 10, anchor="s", text="LIMIT",
                                                fill="#F2F7FF", font=self.shell.forecast_label_font))
        self._track(self.canvas.create_rectangle(x + w - 7, y + h * .28, x + w + 3, y + h * .72,
                                                 fill=LINE, outline=""))

    def _status_bits(self, battery, stale, limit_reset, charging_label, is_error):
        bits = []
        if stale:
            refreshing = bool(battery.get("refreshing"))
            cached_time = format_cached_time_label(battery.get("cachedAt") or battery.get("fetchedAt"))
            accent = self.config.get("accentColor", "#38bdf8")
            muted = self.config["mutedTextColor"]
            if refreshing:
                bits.append({
                    "kind": "pill",
                    "text": f"⟳ updating · cached {format_freshness_sec(battery.get('freshnessSec'))}",
                    "fill": self.CARD,
                    "fg": accent,
                    "outline": self.CARD_EDGE,
                })
                bits.append({
                    "kind": "legend",
                    "text": (
                        f"Showing saved data from {cached_time} — fetching live update…"
                        if cached_time
                        else "Showing saved data — fetching live update…"
                    ),
                    "fill": muted,
                })
            else:
                bits.append({
                    "kind": "pill",
                    "text": f"⚠ cached · {format_freshness_sec(battery.get('freshnessSec'))}",
                    "fill": self.AMBER_BG,
                    "fg": self.AMBER,
                    "outline": self.AMBER_BG,
                })
                reason = str(battery.get("staleReason") or "Tesla unreachable")
                bits.append({
                    "kind": "legend",
                    "text": (
                        f"{reason} — data from {cached_time}"
                        if cached_time
                        else f"{reason} — showing last known data"
                    ),
                    "fill": self.AMBER,
                })
        if limit_reset:
            bits.append({"kind": "body", "text": limit_reset, "fill": self.config["mutedTextColor"]})
        elif charging_label and not is_error:
            bits.append({
                "kind": "body",
                "text": str(charging_label),
                "fill": self.config.get("accentColor", "#38bdf8"),
            })
        return bits

    @staticmethod
    def battery_bar_height(percent_font_linespace: int, *, portrait: bool) -> int:
        """Large bordered battery gauge; the percent remains above it."""
        _ = percent_font_linespace
        return 120 if portrait else 92

    def _place_car_image(self, center_x, image_top, image_width, image_height, accent, chip):
        image_path = asset_path(self.IMAGE_NAME)
        if image_path.exists() and Image is not None and ImageTk is not None:
            try:
                image = Image.open(image_path).convert("RGBA")
                image.thumbnail((max(40, image_width), max(40, image_height)), Image.LANCZOS)
                self._photo = ImageTk.PhotoImage(image)
                self._track(
                    self.canvas.create_image(
                        center_x,
                        image_top + image.height // 2,
                        image=self._photo,
                    )
                )
                return image_top + image.height
            except OSError:
                pass
        self._draw_fallback_car(center_x, image_top + 20, image_width, accent, chip)
        return image_top + max(80, int(image_height * 0.55))

    def _draw_fallback_car(self, center_x: float, top_y: float, width: float, accent: str, chip: str):
        half_w = width * 0.42
        body_h = width * 0.16
        wheel_r = width * 0.055
        body_y = top_y + body_h
        self._track(
            self.canvas.create_rectangle(
                center_x - half_w,
                body_y - body_h,
                center_x + half_w,
                body_y,
                fill=chip,
                outline=accent,
                width=2,
            )
        )
        self._track(
            self.canvas.create_polygon(
                center_x - half_w * 0.55,
                body_y - body_h,
                center_x - half_w * 0.15,
                body_y - body_h * 1.8,
                center_x + half_w * 0.35,
                body_y - body_h * 1.8,
                center_x + half_w * 0.55,
                body_y - body_h,
                fill=accent,
                outline="",
            )
        )
        for offset in (-half_w * 0.62, half_w * 0.62):
            self._track(
                self.canvas.create_oval(
                    center_x + offset - wheel_r,
                    body_y - wheel_r * 0.2,
                    center_x + offset + wheel_r,
                    body_y + wheel_r * 1.8,
                    fill=accent,
                    outline="",
                )
            )


class TeslaDashboardPanel(BasePanel):
    LOGO_NAME = "tesla-logo.png"
    CAR_IMAGE_NAME = "tesla-model-y.png"
    TOP_DOWN_IMAGE_NAME = "tesla-top-down.png"
    # Wheel centers as fractions of the top-down render height (front/rear axle).
    WHEEL_SLOTS = {"fl": (-1, 0.15), "fr": (1, 0.15), "rl": (-1, 0.84), "rr": (1, 0.84)}
    MAP_ZOOM = 15

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._logo_photo = None
        self._car_photo = None
        self._top_down_photo = None
        self._map_photo = None
        self._map_request = 0
        self._map_cache: dict = {}
        self._map_overlay_floor = None
        self._pulse_job = None
        self._pulse_phase = 0
        self._pulse_items: list[int] = []
        self._pin_center = None

    def hide(self):
        if self._pulse_job:
            self.root.after_cancel(self._pulse_job)
            self._pulse_job = None
        self._pulse_items = []
        self._pin_center = None
        self._map_overlay_floor = None
        self._map_request += 1
        super().hide()

    def _render(self, payload: dict):
        dashboard = payload.get("dashboard") or {}
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        top = int(self.shell.overlay.screen_h * (0.035 if layout.portrait else 0.05))
        bottom = layout.message_area_bottom
        pad = 20
        self._round_rect(
            x - pad, top - 14, x + width + pad, bottom,
            radius=0, fill=self.CONTAINER, outline=self.CARD_EDGE,
        )

        if dashboard.get("status") not in (None, "ok", ""):
            self._render_error(dashboard, x, width, top)
            return

        if layout.portrait:
            self._render_portrait(dashboard, x, width, top, bottom)
        else:
            self._render_landscape(dashboard, x, width, top, bottom)

    def _render_error(self, dashboard: dict, x: int, width: int, top: int):
        text = self.config["textColor"]
        accent = self.AMBER if dashboard.get("status") == "rate_limited" else self.RED
        message = dashboard.get("error") or "Tesla dashboard unavailable"
        y = self._draw_header(x + 8, top, width - 16, dashboard)
        self._track(
            self.canvas.create_text(
                x + width // 2,
                y + 80,
                anchor="n",
                text=message,
                fill=accent,
                font=self.shell.body_font,
                width=width - 80,
                justify="center",
            )
        )
        limit_reset = format_limit_reset_time(dashboard.get("limitResetAt"))
        if limit_reset:
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    y + 150,
                    anchor="n",
                    text=limit_reset,
                    fill=self.config["mutedTextColor"],
                    font=self.shell.body_font,
                )
            )

    def _freshness_label(self, dashboard: dict) -> str:
        sec = dashboard.get("freshnessSec")
        if sec is None:
            return "just now"
        sec = max(0, int(sec))
        if sec < 60:
            return f"{sec}s ago"
        if sec < 3600:
            return f"{sec // 60}m ago"
        if sec < 86400:
            return f"{sec // 3600}h ago"
        return f"{sec // 86400}d ago"

    def _cached_time_label(self, dashboard: dict) -> str | None:
        stamp = dashboard.get("cachedAt") or dashboard.get("fetchedAt")
        if not stamp:
            return None
        try:
            cached = datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).astimezone()
        except ValueError:
            return None
        label = cached.strftime("%I:%M %p").lstrip("0")
        if cached.date() != datetime.now().astimezone().date():
            label = cached.strftime("%b %d, ") + label
        return label

    def _geofence_label(self, map_data: dict) -> str | None:
        if map_data.get("locatedAtHome"):
            return "At home"
        if map_data.get("locatedAtWork"):
            return "At work"
        if map_data.get("locatedAtFavorite"):
            return "Favorite"
        return None

    def _load_logo_image(self, size: int):
        path = asset_path(self.LOGO_NAME)
        if not path.exists() or Image is None or ImageTk is None:
            return None
        try:
            image = Image.open(path).convert("RGBA")
        except OSError:
            return None
        # Strip any white matte so the logo floats on the dark header.
        cleaned = [
            (r, g, b, 0) if (a == 0 or (r > 235 and g > 235 and b > 235)) else (r, g, b, a)
            for r, g, b, a in image.getdata()
        ]
        image.putdata(cleaned)
        image.thumbnail((size, size), Image.LANCZOS)
        return image

    def _start_map_fetch(self, lat: float, lon: float, box, *, retry: bool = True):
        if Image is None or ImageTk is None:
            return
        x0, y0, x1, y1 = box
        w = max(64, int(x1 - x0) - 4)
        h = max(64, int(y1 - y0) - 4)
        key = (round(lat, 4), round(lon, 4), self.MAP_ZOOM, w, h)
        self._map_request += 1
        request_id = self._map_request
        cached = self._map_cache.get(key)
        if cached is not None:
            self._apply_map(request_id, cached, box)
            return

        def fetch():
            try:
                image = map_tiles.fetch_map_tiles(lat, lon, self.MAP_ZOOM, w, h)
            except Exception as error:
                map_tiles.log_map_error(f"map fetch failed for {lat:.4f},{lon:.4f}: {error!r}")
                if retry:
                    # One delayed retry — transient network hiccups are common
                    # right after the display wakes.
                    self.root.after(
                        3000,
                        lambda: self.visible
                        and request_id == self._map_request
                        and self._start_map_fetch(lat, lon, box, retry=False),
                    )
                else:
                    self.root.after(0, lambda: self._show_map_error(request_id, box))
                return
            self._map_cache[key] = image
            if len(self._map_cache) > 8:
                self._map_cache.pop(next(iter(self._map_cache)))
            self.root.after(0, lambda: self._apply_map(request_id, image, box))

        threading.Thread(target=fetch, daemon=True).start()

    def _apply_map(self, request_id: int, image, box):
        if not self.visible or request_id != self._map_request:
            return
        x0, y0, x1, y1 = box
        self._map_photo = ImageTk.PhotoImage(image)
        img_id = self._track(
            self.canvas.create_image((x0 + x1) // 2, (y0 + y1) // 2, image=self._map_photo)
        )
        if self._map_overlay_floor is not None:
            self.canvas.tag_lower(img_id, self._map_overlay_floor)

    def _show_map_error(self, request_id: int, box):
        """Surface tile failures on screen instead of a silent placeholder."""
        if not self.visible or request_id != self._map_request:
            return
        x0, y0, x1, y1 = box
        self._track(
            self.canvas.create_text(
                (x0 + x1) // 2, y1 - 18, anchor="s",
                text="⚠ map offline — see map-errors.log",
                fill=self.AMBER,
                font=self.shell.forecast_label_font,
            )
        )

    def _draw_header(self, x, y, width, dashboard: dict):
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        vehicle = dashboard.get("vehicle") or {}

        circle_r = 28
        cx, cy = x + circle_r + 4, y + circle_r + 2
        self._track(
            self.canvas.create_oval(
                cx - circle_r, cy - circle_r, cx + circle_r, cy + circle_r,
                outline="#31415e", width=2, dash=(4, 4),
            )
        )
        logo = self._load_logo_image(circle_r * 2 - 16)
        if logo is not None:
            self._logo_photo = ImageTk.PhotoImage(logo)
            self._track(self.canvas.create_image(cx, cy, image=self._logo_photo))

        title_x = cx + circle_r + 18
        self._track(
            self.canvas.create_text(
                title_x, y + 4, anchor="nw",
                text="Tesla mission control",
                fill=text,
                font=self.shell.section_label_font,
            )
        )
        online = "online" if vehicle.get("online", True) else str(vehicle.get("state") or "offline")
        name = vehicle.get("name") or "Tesla"
        name_id = self._track(
            self.canvas.create_text(
                title_x, y + 36, anchor="nw",
                text=name,
                fill=accent,
                font=self.shell.forecast_label_font,
            )
        )
        bbox = self.canvas.bbox(name_id)
        dot_x = (bbox[2] if bbox else title_x) + 10
        status_color = self.GREEN if vehicle.get("online", True) else muted
        self._track(
            self.canvas.create_text(
                dot_x, y + 36, anchor="nw",
                text=f"· {online}",
                fill=status_color,
                font=self.shell.forecast_label_font,
            )
        )
        firmware = vehicle.get("firmware")
        if firmware:
            short_fw = str(firmware).split(" ")[-1][:16]
            self._track(
                self.canvas.create_text(
                    x + width - 16, y + 6, anchor="ne",
                    text=f"v{short_fw}",
                    fill=muted,
                    font=self.shell.forecast_label_font,
                )
            )
        if dashboard.get("stale"):
            refreshing = bool(dashboard.get("refreshing"))
            cached_time = self._cached_time_label(dashboard)
            if refreshing:
                pill_text = f"⟳ updating · cached {self._freshness_label(dashboard)}"
                pill_fill, pill_fg = self.CARD, accent
                pill_outline = self.CARD_EDGE
                legend_fill = muted
                legend = (
                    f"Showing saved data from {cached_time} — fetching live update…"
                    if cached_time
                    else "Showing saved data — fetching live update…"
                )
            else:
                pill_text = f"⚠ cached · {self._freshness_label(dashboard)}"
                pill_fill, pill_fg = self.AMBER_BG, self.AMBER
                pill_outline = self.AMBER_BG
                legend_fill = self.AMBER
                legend = "Tesla unreachable — showing last known data"
                if cached_time:
                    legend = f"Tesla unreachable — data from {cached_time}"
            self._pill(
                x + width - 16, y + 30,
                pill_text,
                fill=pill_fill,
                fg=pill_fg,
                outline=pill_outline,
                anchor="ne",
            )
            self._track(
                self.canvas.create_text(
                    x + width - 16, y + 62, anchor="ne",
                    text=legend,
                    fill=legend_fill,
                    font=self.shell.forecast_label_font,
                )
            )
        else:
            self._pill(
                x + width - 16, y + 30,
                f"⏱ {self._freshness_label(dashboard)}",
                fill=self.CARD,
                fg=muted,
                outline=self.CARD_EDGE,
                anchor="ne",
            )
        # The stale legend needs an extra row before the cards start.
        return y + circle_r * 2 + (30 if dashboard.get("stale") else 16)

    def _draw_map_card(self, x, y, width, height, dashboard: dict):
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        map_data = dashboard.get("map") or {}
        nav = map_data.get("navigation") or {}

        self._panel_card(x, y, width, height)
        footer_h = 40
        box = (x + 10, y + 10, x + width - 10, y + height - footer_h - 6)
        self._round_rect(*box, radius=0, fill=self.INNER, outline=self.CARD_EDGE)
        self._draw_map_placeholder(box)

        lat = map_data.get("latitude")
        lon = map_data.get("longitude")

        pin_x = (box[0] + box[2]) // 2
        pin_y = (box[1] + box[3]) // 2
        self._pin_center = (pin_x, pin_y)
        halo_id = self._track(
            self.canvas.create_oval(
                pin_x - 34, pin_y - 34, pin_x + 34, pin_y + 34,
                fill="#12233d", outline="",
            )
        )
        self._map_overlay_floor = halo_id
        self._track(
            self.canvas.create_oval(
                pin_x - 22, pin_y - 22, pin_x + 22, pin_y + 22,
                outline=accent, width=2,
            )
        )
        self._track(
            self.canvas.create_oval(
                pin_x - 9, pin_y - 9, pin_x + 9, pin_y + 9,
                fill=accent, outline="#0a111e", width=2,
            )
        )
        heading = map_data.get("heading")
        if heading is not None:
            # Compass-needle chevron riding the accent ring (not a cursor arrow):
            # a kite-shaped polygon pointing along the heading, just outside the ring.
            theta = math.radians(float(heading) - 90)

            def polar(radius, angle_offset_deg=0.0):
                a = theta + math.radians(angle_offset_deg)
                return pin_x + math.cos(a) * radius, pin_y + math.sin(a) * radius

            tip = polar(33)
            left = polar(21, -24)
            notch = polar(24)
            right = polar(21, 24)
            self._track(
                self.canvas.create_polygon(
                    *tip, *left, *notch, *right,
                    fill=accent, outline="#0a111e", width=1, joinstyle="round",
                )
            )

        # Speed/gear chip is the only allowed map furniture (§1.10). Geofence /
        # "location hidden" pills stay off the tiles — put them in the footer.
        driving = map_data.get("drivingChip") or "Parked"
        self._pill(x + width - 20, y + 20, driving, fill="#0d1830", fg=text, outline=self.CARD_EDGE, anchor="ne")

        location = map_data.get("locationLabel")
        if not location and lat is not None and lon is not None:
            location = f"{float(lat):.4f}, {float(lon):.4f}"
        location = location or "Location unavailable"
        geofence = self._geofence_label(map_data)
        if geofence:
            location = f"{geofence} · {location}"
        elif map_data.get("locationRestricted"):
            location = f"Location hidden · {location}"
        self._track(
            self.canvas.create_text(
                x + 20, y + height - footer_h // 2 - 4, anchor="w",
                text=f"📍 {location}",
                fill=text,
                font=self.shell.forecast_label_font,
            )
        )
        footer = nav.get("footer") or "No active route"
        self._track(
            self.canvas.create_text(
                x + width - 20, y + height - footer_h // 2 - 4, anchor="e",
                text=footer,
                fill=accent if nav.get("active") else muted,
                font=self.shell.forecast_label_font,
            )
        )

        if lat is not None and lon is not None:
            self._start_map_fetch(float(lat), float(lon), box)

        if not self._pulse_job:
            self._pulse_phase = 0
            self._schedule_pulse()

    def _draw_map_placeholder(self, box):
        """Faint street grid so the map card looks alive before tiles load."""
        x0, y0, x1, y1 = box
        road = "#152238"
        w, h = x1 - x0, y1 - y0
        for frac, slope in ((0.22, 0.06), (0.52, -0.04), (0.8, 0.08)):
            yy = y0 + h * frac
            self._track(
                self.canvas.create_line(x0 + 4, yy - h * slope, x1 - 4, yy + h * slope, fill=road, width=5)
            )
        for frac, slope in ((0.25, 0.05), (0.58, -0.06), (0.85, 0.03)):
            xx = x0 + w * frac
            self._track(
                self.canvas.create_line(xx - w * slope, y0 + 4, xx + w * slope, y1 - 4, fill=road, width=5)
            )

    def _schedule_pulse(self):
        if not self.visible:
            return
        self._pulse_job = self.root.after(420, self._pulse_tick)

    def _pulse_tick(self):
        # No pulsing glow rings — design system forbids decorative glow (§1.1).
        self._pulse_job = None
        self._pulse_items = []

    def _draw_car_card(self, x, y, width, height, dashboard: dict):
        muted = self.config["mutedTextColor"]
        security = dashboard.get("security") or {}
        secure = security.get("secureTheme") == "green"
        secure_color = self.GREEN if secure else self.AMBER
        secure_bg = self.GREEN_BG if secure else self.AMBER_BG

        self._round_rect(
            x, y, x + width, y + height,
            radius=0, fill=self.CARD, outline=self.CARD_EDGE,
        )

        badge_row_h = 44
        image_path = asset_path(self.CAR_IMAGE_NAME)
        img_w = min(width - 60, 460)
        img_h = max(80, height - badge_row_h - 28)
        img_bottom = y + 12 + img_h
        if image_path.exists() and Image is not None and ImageTk is not None:
            try:
                image = Image.open(image_path).convert("RGBA")
                image.thumbnail((int(img_w), int(img_h)), Image.LANCZOS)
                self._car_photo = ImageTk.PhotoImage(image)
                self._track(
                    self.canvas.create_image(
                        x + width // 2,
                        y + 12 + image.height // 2,
                        image=self._car_photo,
                    )
                )
                img_bottom = y + 12 + image.height
            except OSError:
                pass

        # Security status lives under the vehicle render — never on the art (§1.10).
        left_badges = []
        left_badges.append("🔒 Locked" if security.get("locked") else "🔓 Unlocked")
        if security.get("sentryOn"):
            left_badges.append("◉ Sentry on")
        right_badges = [
            ("Doors closed", True) if security.get("doorsClosed", True) else ("Door open", False),
            ("Windows up", True) if security.get("windowsUp", True) else ("Window open", False),
        ]

        badge_y = min(img_bottom + 10, y + height - badge_row_h)
        badge_x = x + 16
        for label in left_badges:
            h = self._pill(badge_x, badge_y, label, fill=secure_bg, fg=secure_color, outline=secure_bg)
            badge_x += self.shell.forecast_label_font.measure(label) + 36
            _ = h
        badge_x = x + width - 16
        for label, ok in right_badges:
            h = self._pill(
                badge_x, badge_y, label,
                fill=self.CARD, fg=muted if ok else self.AMBER,
                outline=self.CARD_EDGE, anchor="ne",
            )
            badge_x -= self.shell.forecast_label_font.measure(label) + 36
            _ = h

    def _draw_battery_card(self, x, y, width, height, dashboard: dict):
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        battery = dashboard.get("battery") or {}
        percent = battery.get("percent")
        charging = battery.get("charging")
        bar_color = battery_level_color(percent)
        value_font = self.shell.chip_value_font
        label_font = self.shell.forecast_label_font
        value_h = value_font.metrics("linespace")
        label_h = label_font.metrics("linespace")

        self._panel_card(x, y, width, height)
        headline = f"⚡ {percent if percent is not None else '—'}% · {battery.get('rangeMiles') if battery.get('rangeMiles') is not None else '—'} mi"
        plug_label = battery.get("chargingLabel") or ("Charging" if charging else "Not plugged in")
        pad_top = 12
        self._track(
            self.canvas.create_text(x + 18, y + pad_top, anchor="nw", text=headline, fill=text, font=value_font)
        )
        self._track(
            self.canvas.create_text(
                x + width - 18, y + pad_top + 2, anchor="ne",
                text=plug_label,
                fill=self.GREEN if charging else accent,
                font=label_font,
            )
        )

        bar_h = 14
        bar_y = y + pad_top + value_h + 10
        # Keep the bar + optional detail rows inside the card when height is tight.
        min_detail = label_h + 8
        if bar_y + bar_h + min_detail > y + height - 10:
            bar_y = max(y + pad_top + value_h + 6, y + height - bar_h - min_detail - 10)
        self._round_rect(x + 18, bar_y, x + width - 18, bar_y + bar_h, radius=0, fill=self.INNER)
        if percent is not None:
            pct = max(0, min(100, int(percent)))
            fill_w = (width - 36) * pct / 100
            if fill_w > 2:
                self._round_rect(
                    x + 18, bar_y, x + 18 + fill_w, bar_y + bar_h,
                    radius=0, fill=bar_color,
                )

        detail_y = bar_y + bar_h + 10
        if detail_y + label_h > y + height - 8:
            return

        if charging:
            charge_bits = []
            if battery.get("chargerPowerKw") is not None:
                charge_bits.append(f"{battery['chargerPowerKw']} kW")
            if battery.get("chargeCurrentAmp") is not None:
                charge_bits.append(f"{battery['chargeCurrentAmp']} A")
            if battery.get("chargerVoltage") is not None:
                charge_bits.append(f"{battery['chargerVoltage']} V")
            if battery.get("chargeRateMph") is not None:
                charge_bits.append(f"{battery['chargeRateMph']} mi/hr")
            if battery.get("timeToFullChargeMin") is not None:
                eta = format_charge_time_to_full(battery.get("timeToFullChargeMin"))
                if eta:
                    charge_bits.append(eta)
            if charge_bits:
                self._track(
                    self.canvas.create_text(
                        x + 18, detail_y, anchor="nw",
                        text=" · ".join(charge_bits),
                        fill=self.GREEN,
                        font=label_font,
                    )
                )
                detail_y += label_h + 8

        if detail_y + label_h > y + height - 8:
            return

        columns = []
        if battery.get("ratedRangeMiles") is not None:
            columns.append(f"Rated {battery['ratedRangeMiles']} mi")
        if battery.get("lastChargeKwh") is not None:
            columns.append(f"Last charge +{battery['lastChargeKwh']} kWh AC")
        if battery.get("lifetimeEnergy"):
            columns.append(f"Lifetime {battery['lifetimeEnergy']}")
        if columns:
            anchors = ["w", "center", "e"]
            for idx, value in enumerate(columns[:3]):
                if len(columns) == 1:
                    cx, anchor = x + 18, "w"
                else:
                    anchor = anchors[idx] if len(columns) == 3 else ("w" if idx == 0 else "e")
                    if anchor == "w":
                        cx = x + 18
                    elif anchor == "e":
                        cx = x + width - 18
                    else:
                        cx = x + width / 2
                self._track(
                    self.canvas.create_text(
                        cx, detail_y, anchor=anchor,
                        text=value,
                        fill=muted,
                        font=label_font,
                    )
                )

    def _stat_tile(self, x, y, w, h, icon, label):
        muted = self.config["mutedTextColor"]
        self._panel_card(x, y, w, h)
        self._track(
            self.canvas.create_text(
                x + 16, y + 14, anchor="nw",
                text=f"{icon} {label}",
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )

    def _draw_stat_grid(self, x, y, width, tile_h, gap, dashboard: dict):
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        climate = dashboard.get("climate") or {}
        tires = dashboard.get("tires") or {}
        odometer = dashboard.get("odometer") or {}
        software = dashboard.get("software") or {}

        tile_w = (width - gap) // 2
        value_font = self.shell.chip_value_font
        label_font = self.shell.forecast_label_font
        positions = {
            "climate": (x, y),
            "tires": (x + tile_w + gap, y),
            "odometer": (x, y + tile_h + gap),
            "software": (x + tile_w + gap, y + tile_h + gap),
        }

        self._draw_climate_tile(*positions["climate"], tile_w, tile_h, climate)
        self._draw_tires_tile(*positions["tires"], tile_w, tile_h, tires)
        self._draw_odometer_tile(*positions["odometer"], tile_w, tile_h, odometer)

        # Software
        tx, ty = positions["software"]
        self._stat_tile(tx, ty, tile_w, tile_h, "⬇", "Software")
        update_available = software.get("updateAvailable")
        sw_val = software.get("statusLabel") or ("Update ready" if update_available else "Up to date")
        sw_val_y = max(ty + tile_h // 2 + 2, ty + 44 + value_font.metrics("linespace") // 2)
        self._track(
            self.canvas.create_text(
                tx + 16, sw_val_y, anchor="w",
                text=sw_val, fill=text, font=value_font,
            )
        )
        if update_available:
            sw_sub = str(software.get("updateVersion") or "").strip()
            percent = software.get("downloadPercent")
            if percent is not None:
                sw_sub = f"{sw_sub} · {percent}% loaded".strip(" ·")
            sw_sub = sw_sub or "Update pending"
        else:
            current = str(software.get("currentVersion") or "").strip()
            sw_sub = f"v{current.split(' ')[0]}" if current else "No update pending"
        self._track(
            self.canvas.create_text(
                tx + 16, ty + tile_h - 14, anchor="sw",
                text=self._fit_text(sw_sub, label_font, tile_w - 32),
                fill=accent if update_available else muted,
                font=label_font,
            )
        )

    def _climate_color(self, temp_f):
        if temp_f is None:
            return self.config["mutedTextColor"]
        t = float(temp_f)
        if t < 45:
            return "#60a5fa"
        if t < 62:
            return "#38bdf8"
        if t <= 78:
            return self.GREEN
        if t <= 90:
            return self.AMBER
        return self.RED

    _TEMP_SCALE_STOPS = (
        (30, (59, 130, 246)),
        (60, (56, 189, 248)),
        (70, (74, 222, 128)),
        (85, (245, 158, 11)),
        (110, (239, 68, 68)),
    )

    def _draw_temp_scale(self, x, y, width, inside_f, outside_f):
        lo, hi = self._TEMP_SCALE_STOPS[0][0], self._TEMP_SCALE_STOPS[-1][0]

        def color_at(temp):
            temp = max(lo, min(hi, float(temp)))
            stops = self._TEMP_SCALE_STOPS
            for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
                if temp <= t1:
                    frac = (temp - t0) / (t1 - t0)
                    return "#%02x%02x%02x" % tuple(
                        int(a + (b - a) * frac) for a, b in zip(c0, c1)
                    )
            return "#%02x%02x%02x" % stops[-1][1]

        segments = 36
        seg_w = width / segments
        for i in range(segments):
            temp = lo + (hi - lo) * (i + 0.5) / segments
            self._track(
                self.canvas.create_rectangle(
                    x + i * seg_w, y, x + (i + 1) * seg_w + 1, y + 6,
                    fill=color_at(temp), outline="",
                )
            )

        def marker_x(temp):
            frac = (max(lo, min(hi, float(temp))) - lo) / (hi - lo)
            return x + frac * width

        if outside_f is not None:
            mx = marker_x(outside_f)
            self._track(
                self.canvas.create_oval(
                    mx - 6, y - 3, mx + 6, y + 9,
                    fill=self.INNER, outline="#94a3b8", width=2,
                )
            )
        if inside_f is not None:
            mx = marker_x(inside_f)
            self._track(
                self.canvas.create_oval(
                    mx - 7, y - 4, mx + 7, y + 10,
                    fill=color_at(inside_f), outline="#e2e8f0", width=2,
                )
            )

    def _draw_climate_tile(self, tx, ty, w, h, climate: dict):
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        label_font = self.shell.forecast_label_font
        self._stat_tile(tx, ty, w, h, "🌡", "Climate")

        inside = climate.get("insideTempF")
        outside = climate.get("outsideTempF")
        hvac_on = bool(climate.get("hvacOn"))
        inside_color = self._climate_color(inside)

        # Bottom-anchored rows first (pills, then scale), so the temperature
        # text above can adapt to whatever vertical space is actually left.
        pill_h = label_font.metrics("linespace") + 10
        pill_y = ty + h - 14 - pill_h
        scale_y = pill_y - 22

        content_top = ty + 40
        title_ls = self.shell.section_title_font.metrics("linespace")
        outside_ls = self.shell.forecast_value_font.metrics("linespace")
        temp_room = scale_y - 10 - content_top
        two_line = temp_room >= title_ls + outside_ls
        show_scale = temp_room >= title_ls * 0.9
        if not show_scale:
            scale_y = None

        value_id = self._track(
            self.canvas.create_text(
                tx + 18, content_top, anchor="nw",
                text=f"{inside if inside is not None else '—'}°",
                fill=inside_color,
                font=self.shell.section_title_font,
            )
        )
        bbox = self.canvas.bbox(value_id)
        anchor_x = (bbox[2] if bbox else tx + 90) + 8
        mid_y = content_top + title_ls // 2
        self._track(
            self.canvas.create_text(
                anchor_x, mid_y, anchor="w",
                text="cabin",
                fill=muted,
                font=label_font,
            )
        )
        if outside is not None:
            if two_line:
                self._track(
                    self.canvas.create_text(
                        tx + 18, content_top + title_ls + 2,
                        anchor="nw",
                        text=f"{outside}° outside",
                        fill=self._climate_color(outside),
                        font=self.shell.forecast_value_font,
                    )
                )
            else:
                # Compact tile: outside temp rides on the same line as "cabin".
                cabin_w = label_font.measure("cabin")
                self._track(
                    self.canvas.create_text(
                        anchor_x + cabin_w + 10, mid_y, anchor="w",
                        text=f"· {outside}° out",
                        fill=self._climate_color(outside),
                        font=self.shell.forecast_value_font,
                    )
                )

        if scale_y is not None:
            self._draw_temp_scale(tx + 18, scale_y, w - 36, inside, outside)

        pills = []
        if hvac_on:
            hot_cabin = inside is not None and outside is not None and inside > outside
            hvac_label = "☀ Heat on" if (inside is not None and outside is not None and outside < 55 and not hot_cabin) else "❄ AC on"
            pills.append((hvac_label, "❄ AC", "#0d2338", accent, "#1c4966"))
        else:
            pills.append(("HVAC off", "HVAC", self.INNER, muted, self.CARD_EDGE))
        cop = str(climate.get("cabinOverheatProtection") or "").lower()
        if cop and cop not in ("off", "false", "none"):
            pills.append(("☀ Cabin protect", "☀ Protect", self.AMBER_BG, self.AMBER, self.AMBER_BG))

        # Never let pills bleed past the tile edge — shorten, then drop if needed.
        pill_x = tx + 16
        right_limit = tx + w - 12
        for label, short_label, fill, fg, outline in pills:
            if pill_x + self._pill_width(label) > right_limit:
                label = short_label
            if pill_x + self._pill_width(label) > right_limit:
                break
            self._pill(pill_x, pill_y, label, fill=fill, fg=fg, outline=outline)
            pill_x += self._pill_width(label) + 10

    def _pill_width(self, label, font=None):
        font = font or self.shell.forecast_label_font
        return font.measure(label) + 24

    def _fit_text(self, label: str, font, max_width: int) -> str:
        if font.measure(label) <= max_width:
            return label
        while label and font.measure(label + "…") > max_width:
            label = label[:-1]
        return (label.rstrip() + "…") if label else ""

    def _load_top_down_image(self, max_w: int, max_h: int):
        path = asset_path(self.TOP_DOWN_IMAGE_NAME)
        if not path.exists() or Image is None or ImageTk is None:
            return None
        try:
            image = Image.open(path).convert("RGBA")
        except OSError:
            return None
        image.thumbnail((max(1, int(max_w)), max(1, int(max_h))), Image.LANCZOS)
        return image

    def _draw_tires_tile(self, tx, ty, w, h, tires: dict):
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        self._stat_tile(tx, ty, w, h, "◎", "Tires (psi)")
        warnings = tires.get("warnings") or {}
        alert = tires.get("alert")

        top_pad = 46
        bottom_pad = 38
        car_h = max(60, h - top_pad - bottom_pad)
        # Give the render most of the tile; psi numbers sit tight beside the wheels.
        label_room = self.shell.chip_value_font.measure("88.8") + 12
        car_w = max(40, min(w - 2 * label_room - 8, w * 0.44, car_h * 0.46))
        cx = tx + w / 2
        cy = ty + top_pad + car_h / 2

        image = self._load_top_down_image(car_w, car_h)
        if image is not None:
            self._top_down_photo = ImageTk.PhotoImage(image)
            self._track(self.canvas.create_image(cx, cy, image=self._top_down_photo))
            draw_w, draw_h = image.size
        else:
            draw_w, draw_h = car_w, car_h
            self._round_rect(
                cx - draw_w / 2, cy - draw_h / 2, cx + draw_w / 2, cy + draw_h / 2,
                radius=draw_w * 0.44, fill="#182741", outline="#3b4d6e", width=2,
            )
            self._round_rect(
                cx - draw_w * 0.30, cy - draw_h * 0.24, cx + draw_w * 0.30, cy + draw_h * 0.30,
                radius=draw_w * 0.24, fill="#0a111e",
            )

        img_top = cy - draw_h / 2
        for key, (side, frac) in self.WHEEL_SLOTS.items():
            psi = tires.get(key)
            warn = warnings.get(key)
            wy = img_top + draw_h * frac
            wheel_x = cx + side * (draw_w / 2 - max(3, draw_w * 0.05))
            # Wheel marker anchored on the render's wheel position.
            marker_h = max(14, draw_h * 0.075)
            self._round_rect(
                wheel_x - 3, wy - marker_h / 2, wheel_x + 3, wy + marker_h / 2,
                radius=3,
                fill=self.AMBER if warn else "#3b82f6",
            )
            label = f"{psi:g}" if isinstance(psi, (int, float)) else "—"
            label_x = cx + side * (draw_w / 2 + 8)
            self._track(
                self.canvas.create_text(
                    label_x, wy,
                    anchor="e" if side < 0 else "w",
                    text=label,
                    fill=self.AMBER if warn else text,
                    font=self.shell.chip_value_font,
                )
            )

        self._track(
            self.canvas.create_text(
                tx + 16, ty + h - 14, anchor="sw",
                text=self._fit_text(alert or "All nominal", self.shell.forecast_label_font, w - 32),
                fill=self.AMBER if alert else muted,
                font=self.shell.forecast_label_font,
            )
        )

    def _draw_odometer_tile(self, tx, ty, w, h, odometer: dict):
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        label_font = self.shell.forecast_label_font
        self._stat_tile(tx, ty, w, h, "🛣", "Odometer")

        miles = odometer.get("miles")
        odo_val = f"{miles:,}" if isinstance(miles, (int, float)) else "—"
        title_ls = self.shell.section_title_font.metrics("linespace")
        # Anchor below the tile title so the big number can't ride up over it.
        val_top = ty + 40
        value_id = self._track(
            self.canvas.create_text(
                tx + 18, val_top, anchor="nw",
                text=odo_val, fill=text, font=self.shell.section_title_font,
            )
        )
        bbox = self.canvas.bbox(value_id)
        self._track(
            self.canvas.create_text(
                (bbox[2] if bbox else tx + 120) + 8, val_top + title_ls // 2, anchor="w",
                text="mi", fill=muted, font=label_font,
            )
        )

        cursor = val_top + title_ls + 4

        fsd = odometer.get("fsdMilesPercent")
        if fsd is not None:
            # Donut chart: FSD share of miles as an accent arc on a muted ring.
            avail_h = (ty + h - 14 - label_font.metrics("linespace") * 2.4) - cursor
            if avail_h < 56:
                fsd = None
        if fsd is not None:
            pct = max(0, min(100, float(fsd)))
            avail_h = (ty + h - 14 - label_font.metrics("linespace") * 2.4) - cursor
            ring_r = max(26, min(w * 0.20, avail_h / 2 - 4))
            ring_w = max(7, int(ring_r * 0.30))
            donut_cx = tx + w - 18 - ring_r - ring_w / 2
            donut_cy = cursor + avail_h / 2 + 2
            arc_box = (
                donut_cx - ring_r, donut_cy - ring_r,
                donut_cx + ring_r, donut_cy + ring_r,
            )
            self._track(
                self.canvas.create_arc(
                    *arc_box, start=0, extent=359.9, style="arc",
                    outline=self.INNER, width=ring_w,
                )
            )
            if pct > 0.5:
                self._track(
                    self.canvas.create_arc(
                        *arc_box, start=90, extent=-3.6 * pct, style="arc",
                        outline=accent, width=ring_w,
                    )
                )
            self._track(
                self.canvas.create_text(
                    donut_cx, donut_cy - 7, anchor="center",
                    text=f"{pct:g}%", fill=text, font=self.shell.chip_value_font,
                )
            )
            self._track(
                self.canvas.create_text(
                    donut_cx, donut_cy + 11, anchor="center",
                    text="FSD", fill=accent, font=label_font,
                )
            )
            # Legend on the left of the donut.
            legend_x = tx + 18
            legend_y = donut_cy - label_font.metrics("linespace")
            self._track(
                self.canvas.create_oval(
                    legend_x, legend_y - 4, legend_x + 8, legend_y + 4,
                    fill=accent, outline="",
                )
            )
            self._track(
                self.canvas.create_text(
                    legend_x + 14, legend_y, anchor="w",
                    text=f"FSD {pct:g}%", fill=text, font=label_font,
                )
            )
            legend_y += label_font.metrics("linespace") + 8
            self._track(
                self.canvas.create_oval(
                    legend_x, legend_y - 4, legend_x + 8, legend_y + 4,
                    fill=self.INNER, outline=self.CARD_EDGE,
                )
            )
            self._track(
                self.canvas.create_text(
                    legend_x + 14, legend_y, anchor="w",
                    text=f"Manual {100 - pct:g}%", fill=muted, font=label_font,
                )
            )

        detail_lines = []
        service = odometer.get("serviceDueInMiles")
        if isinstance(service, (int, float)):
            detail_lines.append((f"🔧 Tire rotation in {int(service):,} mi", self.AMBER if service <= 500 else muted))
        added = odometer.get("lastChargeAddedMiles")
        if isinstance(added, (int, float)) and added > 0:
            detail_lines.append((f"⚡ +{int(added):,} mi last charge", muted))
        if not detail_lines and fsd is None:
            detail_lines.append(("Lifetime distance", muted))

        # Bottom-up detail rows; stop before they would collide with the value.
        line_y = ty + h - 14
        for label, color in reversed(detail_lines[:2]):
            if line_y - label_font.metrics("linespace") < cursor:
                break
            self._track(
                self.canvas.create_text(
                    tx + 16, line_y, anchor="sw",
                    text=self._fit_text(label, label_font, w - 32),
                    fill=color, font=label_font,
                )
            )
            line_y -= label_font.metrics("linespace") + 8

    def _draw_media_strip(self, x, y, width, height, dashboard: dict):
        muted = self.config["mutedTextColor"]
        text = self.config["textColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        media = dashboard.get("media") or {}
        playing = bool(media.get("playing"))
        title_font = self.shell.section_label_font
        sub_font = self.shell.forecast_label_font
        title_h = title_font.metrics("linespace")
        sub_h = sub_font.metrics("linespace")

        self._panel_card(x, y, width, height)
        icon_size = min(40, max(24, height - 18))
        icon_y = y + (height - icon_size) // 2
        self._round_rect(
            x + 16, icon_y, x + 16 + icon_size, icon_y + icon_size,
            radius=10,
            fill="#0d2338" if playing else self.INNER,
            outline=accent if playing else self.CARD_EDGE,
        )
        self._track(
            self.canvas.create_text(
                x + 16 + icon_size // 2, icon_y + icon_size // 2, anchor="center",
                text="♪",
                fill=accent if playing else muted,
                font=title_font,
            )
        )
        text_x = x + 16 + icon_size + 16
        # Stack title + subtitle inside the strip instead of fixed ±11/±13 offsets
        # that collide when fonts are large or the strip is short.
        block_h = title_h + 4 + sub_h
        mid_y = y + max(height // 2, (height - block_h) // 2 + title_h // 2)
        title_y = mid_y - (4 + sub_h) // 2
        sub_y = title_y + title_h // 2 + 4 + sub_h // 2
        if playing:
            title = media.get("title") or "Now playing"
            bits = [b for b in (media.get("artist"), media.get("source")) if b]
            vol_label = format_tesla_media_volume_label(media)
            if vol_label:
                bits.append(vol_label)
            self._track(self.canvas.create_text(text_x, title_y, anchor="w", text=title, fill=text, font=title_font))
            self._track(self.canvas.create_text(text_x, sub_y, anchor="w", text=" · ".join(bits), fill=accent, font=sub_font))
        else:
            self._track(self.canvas.create_text(text_x, title_y, anchor="w", text="Nothing playing", fill=text, font=title_font))
            source = media.get("source")
            bits = []
            # Only show a source when the bridge resolved a friendly name
            # (raw firmware codes like "5" are filtered out bridge-side).
            if source and not str(source).strip().replace(".", "").isdigit():
                bits.append(f"Last source: {source}")
            vol_label = format_tesla_media_volume_label(media)
            if vol_label:
                bits.append(vol_label)
            sub = " · ".join(bits) if bits else "Tesla audio idle"
            self._track(self.canvas.create_text(text_x, sub_y, anchor="w", text=sub, fill=muted, font=sub_font))

    def _render_portrait(self, dashboard: dict, x: int, width: int, top: int, bottom: int):
        gap = 14
        inner_x = x + 8
        inner_w = width - 16
        y = self._draw_header(inner_x, top, inner_w, dashboard) + 6

        charging = bool((dashboard.get("battery") or {}).get("charging"))
        media_h = 72
        # Gaps: after map, car, battery, between stat rows, before media (=5).
        stack_budget = max(280, bottom - y - media_h - gap * 5)
        map_h = int(stack_budget * (0.25 if charging else 0.28))
        car_h = int(stack_budget * 0.20)
        battery_h = int(stack_budget * (0.22 if charging else 0.16))
        map_h = max(140, map_h)
        car_h = max(120, car_h)
        battery_h = max(88 if charging else 80, battery_h)
        stats_h = (stack_budget - map_h - car_h - battery_h) // 2
        min_tile = 150
        if stats_h < min_tile:
            need = (min_tile - stats_h) * 2
            for attr, floor in (("map_h", 140), ("car_h", 120)):
                if need <= 0:
                    break
                current = map_h if attr == "map_h" else car_h
                shrink = min(need, max(0, current - floor))
                if attr == "map_h":
                    map_h -= shrink
                else:
                    car_h -= shrink
                need -= shrink
            stats_h = (stack_budget - map_h - car_h - battery_h) // 2
        stats_h = max(110, stats_h)

        # If floors still overshoot, shrink map then car then stats proportionally
        # so the stack always ends above the media strip.
        used = map_h + car_h + battery_h + stats_h * 2
        if used > stack_budget:
            overflow = used - stack_budget
            shrink = min(overflow, max(0, map_h - 120))
            map_h -= shrink
            overflow -= shrink
            if overflow > 0:
                shrink = min(overflow, max(0, car_h - 100))
                car_h -= shrink
                overflow -= shrink
            if overflow > 0:
                stats_h = max(96, stats_h - (overflow + 1) // 2)

        self._draw_map_card(inner_x, y, inner_w, map_h, dashboard)
        y += map_h + gap
        self._draw_car_card(inner_x, y, inner_w, car_h, dashboard)
        y += car_h + gap
        self._draw_battery_card(inner_x, y, inner_w, battery_h, dashboard)
        y += battery_h + gap
        self._draw_stat_grid(inner_x, y, inner_w, stats_h, gap, dashboard)
        media_y = y + stats_h * 2 + gap + gap
        # Clamp into the remaining band so the strip never covers the grid.
        media_y = min(media_y, bottom - media_h)
        media_y = max(media_y, y + stats_h * 2 + gap)
        self._draw_media_strip(inner_x, media_y, inner_w, media_h, dashboard)

    def _render_landscape(self, dashboard: dict, x: int, width: int, top: int, bottom: int):
        gap = 14
        inner_x = x + 8
        inner_w = width - 16
        y = self._draw_header(inner_x, top, inner_w, dashboard) + 6

        media_h = 68
        content_h = max(200, bottom - y - media_h - gap)
        col_w = (inner_w - gap * 2) // 3

        charging = bool((dashboard.get("battery") or {}).get("charging"))
        map_h = content_h if not charging else int(content_h * 0.9)
        battery_h = int(content_h * (0.46 if charging else 0.38))
        battery_h = min(max(100, battery_h), max(100, content_h // 2))
        car_h = max(100, content_h - battery_h - gap)

        self._draw_map_card(inner_x, y, col_w, map_h, dashboard)
        mid_x = inner_x + col_w + gap
        self._draw_car_card(mid_x, y, col_w, car_h, dashboard)
        self._draw_battery_card(mid_x, y + car_h + gap, col_w, min(battery_h, content_h - car_h - gap), dashboard)

        right_x = inner_x + (col_w + gap) * 2
        tile_h = max(110, (content_h - gap) // 2)
        self._draw_stat_grid(right_x, y, col_w, tile_h, gap, dashboard)
        self._draw_media_strip(inner_x, bottom - media_h, inner_w, media_h, dashboard)


class SmartHomePanel(BasePanel):
    TYPE_LABELS = {
        "light": "Light",
        "plug": "Smart Plug",
        "switch": "Switch",
        "fan": "Fan",
        "tv": "TV",
        "pc": "Computer",
        "lock": "Lock",
        "scene": "Scene",
        "thermostat": "Thermostat",
        "device": "Device",
    }

    @staticmethod
    def compute_stack_layout(area_h: int, portrait: bool, *, on_h: int, name_h: int, pill_h: int) -> dict:
        """Vertically balance icon + labels — unit-tested spacing math."""
        area_h = max(280, int(area_h))
        icon_size = 150 if portrait else 128
        # Prefer breathing room under the button; leftover space is shared
        # evenly above the stack and between the text rows (not dumped as a
        # huge empty band above a cramped label cluster).
        gap_icon_on = 56 if portrait else 40
        gap_on_name = 28 if portrait else 18
        gap_name_pill = 28 if portrait else 18
        stack_h = icon_size + gap_icon_on + on_h + gap_on_name + name_h + gap_name_pill + pill_h
        leftover = max(0, area_h - stack_h)
        if leftover > 0:
            # ~35% top inset, rest split across the three gaps.
            top_pad = int(leftover * 0.35)
            share = (leftover - top_pad) / 3
            gap_icon_on += int(share)
            gap_on_name += int(share)
            gap_name_pill += int(share)
        else:
            top_pad = 8
            # Shrink icon slightly before crushing text gaps.
            overflow = stack_h - area_h
            icon_size = max(96, icon_size - overflow)
            stack_h = icon_size + gap_icon_on + on_h + gap_on_name + name_h + gap_name_pill + pill_h
            top_pad = max(8, (area_h - stack_h) // 2)
        return {
            "icon_size": icon_size,
            "top_pad": top_pad,
            "gap_icon_on": gap_icon_on,
            "gap_on_name": gap_on_name,
            "gap_name_pill": gap_name_pill,
        }

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        alert = self.config.get("alertColor", "#f97316")

        command = payload.get("command") or {}
        action = str(command.get("action") or "").lower()
        spoken_target = command.get("spokenTarget") or command.get("target") or "Device"
        display_name = str(spoken_target).title()
        device_type = str(command.get("deviceType") or "device")
        origin = payload.get("device")

        is_on = action == "on"
        action_color = "#4ade80" if is_on else muted
        center_x = x + width // 2

        on_h = self.shell.hero_font.metrics("linespace")
        name_h = self.shell.section_title_font.metrics("linespace")
        pill_h = self.shell.body_font.metrics("linespace") + 18
        geo = self.compute_stack_layout(
            bottom - y,
            layout.portrait,
            on_h=on_h,
            name_h=name_h,
            pill_h=pill_h,
        )
        icon_size = geo["icon_size"]
        icon_y = y + geo["top_pad"] + icon_size // 2

        halo_r = int(icon_size * 0.85)
        self._track(
            self.canvas.create_oval(
                center_x - halo_r, icon_y - halo_r,
                center_x + halo_r, icon_y + halo_r,
                fill=self.GREEN_BG if is_on else self.CARD,
                outline=action_color if is_on else self.CARD_EDGE,
                width=2,
            )
        )
        self._draw_device_icon(center_x, icon_y, icon_size, device_type, action_color if is_on else muted)

        cursor = icon_y + icon_size // 2 + geo["gap_icon_on"]
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=f"{'ON' if is_on else 'OFF'}",
                fill=action_color if is_on else alert,
                font=self.shell.hero_font,
            )
        )
        cursor += on_h + geo["gap_on_name"]
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=display_name,
                fill=text,
                font=self.shell.section_title_font,
                width=width - 40,
            )
        )
        cursor += name_h + geo["gap_name_pill"]
        type_label = self.TYPE_LABELS.get(device_type, "Device")
        detail = type_label
        if origin:
            detail = f"{type_label} · asked on {origin}"
        self._pill(
            center_x, cursor, detail,
            fill=self.CARD, fg=muted, outline=self.CARD_EDGE,
            anchor="n", font=self.shell.body_font,
        )

    def _draw_device_icon(self, cx: float, cy: float, size: float, device_type: str, color: str):
        half = size / 2
        chip = self.config.get("chipBackground", "#141a24")

        if device_type == "light":
            radius = size * 0.30
            self._track(
                self.canvas.create_oval(
                    cx - radius, cy - radius - size * 0.08,
                    cx + radius, cy + radius - size * 0.08,
                    fill=color, outline="",
                )
            )
            # Bulb base
            self._track(
                self.canvas.create_rectangle(
                    cx - size * 0.10, cy + radius - size * 0.10,
                    cx + size * 0.10, cy + radius + size * 0.10,
                    fill=color, outline="",
                )
            )
            # Rays
            for angle in range(0, 360, 45):
                rad = math.radians(angle)
                inner = radius + size * 0.06
                outer = radius + size * 0.18
                self._track(
                    self.canvas.create_line(
                        cx + inner * math.cos(rad), cy - size * 0.08 + inner * math.sin(rad),
                        cx + outer * math.cos(rad), cy - size * 0.08 + outer * math.sin(rad),
                        fill=color, width=3,
                    )
                )
            return

        if device_type == "plug":
            self._track(
                self.canvas.create_oval(
                    cx - half * 0.8, cy - half * 0.8,
                    cx + half * 0.8, cy + half * 0.8,
                    fill=chip, outline=color, width=4,
                )
            )
            for offset in (-size * 0.12, size * 0.12):
                self._track(
                    self.canvas.create_rectangle(
                        cx + offset - size * 0.04, cy - size * 0.18,
                        cx + offset + size * 0.04, cy + size * 0.06,
                        fill=color, outline="",
                    )
                )
            self._track(
                self.canvas.create_oval(
                    cx - size * 0.05, cy + size * 0.14,
                    cx + size * 0.05, cy + size * 0.24,
                    fill=color, outline="",
                )
            )
            return

        if device_type in ("tv", "pc"):
            self._track(
                self.canvas.create_rectangle(
                    cx - half * 0.9, cy - half * 0.6,
                    cx + half * 0.9, cy + half * 0.35,
                    fill=chip, outline=color, width=4,
                )
            )
            self._track(
                self.canvas.create_rectangle(
                    cx - size * 0.16, cy + half * 0.35,
                    cx + size * 0.16, cy + half * 0.5,
                    fill=color, outline="",
                )
            )
            self._track(
                self.canvas.create_line(
                    cx - half * 0.5, cy + half * 0.55,
                    cx + half * 0.5, cy + half * 0.55,
                    fill=color, width=4,
                )
            )
            return

        if device_type == "fan":
            hub = size * 0.08
            for angle in range(0, 360, 120):
                rad = math.radians(angle)
                blade_x = cx + size * 0.26 * math.cos(rad)
                blade_y = cy + size * 0.26 * math.sin(rad)
                self._track(
                    self.canvas.create_oval(
                        blade_x - size * 0.16, blade_y - size * 0.16,
                        blade_x + size * 0.16, blade_y + size * 0.16,
                        fill=color, outline="",
                    )
                )
            self._track(
                self.canvas.create_oval(
                    cx - hub, cy - hub, cx + hub, cy + hub,
                    fill=chip, outline=color, width=3,
                )
            )
            return

        # Generic power symbol (switch, lock, scene, thermostat, device).
        radius = half * 0.7
        self._track(
            self.canvas.create_arc(
                cx - radius, cy - radius,
                cx + radius, cy + radius,
                start=115, extent=310,
                style=tk.ARC, outline=color, width=6,
            )
        )
        self._track(
            self.canvas.create_line(
                cx, cy - radius - size * 0.06,
                cx, cy - radius * 0.2,
                fill=color, width=6, capstyle=tk.ROUND,
            )
        )


class VivintAlarmPanel(BasePanel):
    SECURE_COLOR = "#4ade80"
    DISARMED_COLOR = "#94a3b8"

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        chip = self.config.get("chipBackground", "#141a24")

        alarm = payload.get("alarm") or {}
        status = str(alarm.get("status") or "unknown").lower()
        mode_label = alarm.get("modeLabel")
        headline = alarm.get("label") or "Security System Update"
        provider = alarm.get("provider") or "Vivint"
        center_x = x + width // 2

        if status == "armed":
            accent = self.SECURE_COLOR
            secure_text = "House Secured"
        elif status == "disarmed":
            accent = self.DISARMED_COLOR
            secure_text = "System Disarmed"
        else:
            accent = self.config.get("accentColor", "#38bdf8")
            secure_text = "Security Update"

        # Layout flows top-down from actual rendered bounds so wrapped text
        # never overlaps the lines below it (portrait screens wrap the headline).
        content_h = bottom - y
        icon_size = max(96, min(140, int(content_h * 0.16)))
        halo_r = int(icon_size * 0.8)
        icon_y = y + int(content_h * 0.24)
        self._track(
            self.canvas.create_oval(
                center_x - halo_r, icon_y - halo_r,
                center_x + halo_r, icon_y + halo_r,
                fill=self.GREEN_BG if status == "armed" else self.CARD,
                outline=accent if status == "armed" else self.CARD_EDGE,
                width=2,
            )
        )
        self._draw_lock_icon(center_x, icon_y, icon_size, accent, chip, locked=status == "armed")

        # Pick the largest headline font that fits on one line; fall back to
        # wrapping with bbox-tracked flow if even the section font is too wide.
        headline_font = self.shell.hero_font
        if headline_font.measure(headline) > width - 60:
            headline_font = self.shell.section_title_font

        cursor = icon_y + halo_r + 40
        headline_id = self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=headline,
                fill=accent,
                font=headline_font,
                width=width - 60,
                justify="center",
            )
        )
        bbox = self.canvas.bbox(headline_id)
        cursor = (bbox[3] if bbox else cursor + headline_font.metrics("linespace")) + 14

        if mode_label:
            mode_id = self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=mode_label,
                    fill=text,
                    font=self.shell.section_title_font,
                )
            )
            bbox = self.canvas.bbox(mode_id)
            cursor = (bbox[3] if bbox else cursor + self.shell.section_title_font.metrics("linespace")) + 12

        secure_id = self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=secure_text,
                fill=muted,
                font=self.shell.body_font,
            )
        )
        bbox = self.canvas.bbox(secure_id)
        cursor = (bbox[3] if bbox else cursor + self.shell.body_font.metrics("linespace")) + 20

        self._pill(
            center_x, cursor, provider,
            fill=self.CARD, fg=muted, outline=self.CARD_EDGE,
            anchor="n",
        )

    def _draw_lock_icon(self, cx: float, cy: float, size: float, color: str, chip: str, locked: bool):
        half = size / 2
        body_w = size * 0.52
        body_h = size * 0.42
        body_top = cy + size * 0.08
        body_bottom = body_top + body_h

        shackle_w = size * 0.34
        shackle_h = size * 0.34
        shackle_top = cy - half * 0.55
        if locked:
            self._track(
                self.canvas.create_arc(
                    cx - shackle_w,
                    shackle_top,
                    cx + shackle_w,
                    shackle_top + shackle_h * 2,
                    start=0,
                    extent=180,
                    style=tk.ARC,
                    outline=color,
                    width=8,
                )
            )
        else:
            self._track(
                self.canvas.create_arc(
                    cx - shackle_w * 0.2,
                    shackle_top,
                    cx + shackle_w * 1.4,
                    shackle_top + shackle_h * 2,
                    start=90,
                    extent=180,
                    style=tk.ARC,
                    outline=color,
                    width=8,
                )
            )

        self._track(
            self.canvas.create_rectangle(
                cx - body_w / 2,
                body_top,
                cx + body_w / 2,
                body_bottom,
                fill=chip,
                outline=color,
                width=4,
            )
        )
        self._track(
            self.canvas.create_oval(
                cx - size * 0.06,
                body_top + body_h * 0.35,
                cx + size * 0.06,
                body_top + body_h * 0.55,
                fill=color,
                outline="",
            )
        )


class NotificationsPanel(BasePanel):
    NOTIFICATION_ACCENT = "#FF9900"
    NOTIFICATION_GLOW = "#F59E0B"

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        chip = self.config.get("chipBackground", "#141a24")
        accent = payload.get("themeAccent") or self.NOTIFICATION_ACCENT

        notifications = payload.get("notifications") or {}
        items = [
            item for item in (notifications.get("items") or [])
            if not self._looks_like_empty_notification_message(item)
        ]
        empty = bool(notifications.get("empty"))
        summary = notifications.get("summary")
        spoken = payload.get("spokenResponse") or notifications.get("body") or ""

        if self._looks_like_empty_notification_message(spoken):
            empty = True
            summary = "0 notifications"
            items = []
        elif not items and spoken.strip() and not empty:
            items = [spoken.strip()]

        banner_h = 44
        self._round_rect(
            x,
            y,
            x + width,
            y + banner_h,
            radius=banner_h // 2,
            fill=accent,
        )
        self._draw_bell_icon(x + 28, y + banner_h // 2, 22, self.config.get("overlayBackground", "#0b0f14"))

        banner_text = summary or ("0 notifications" if empty else "Notification")
        self._track(
            self.canvas.create_text(
                x + 56,
                y + banner_h // 2,
                anchor="w",
                text=banner_text,
                fill=self.config.get("overlayBackground", "#0b0f14"),
                font=self.shell.section_label_font,
            )
        )

        cursor = y + banner_h + 24
        card_width = width - 8
        card_x = x + 4

        if empty:
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    cursor + 40,
                    anchor="n",
                    text="You're all caught up",
                    fill=muted,
                    font=self.shell.section_title_font,
                )
            )
            return

        for index, item in enumerate(items[:6]):
            card_text = str(item).strip()
            if not card_text:
                continue

            lines = max(1, min(4, len(card_text) // 42 + 1))
            card_h = 28 + lines * self.shell.body_font.metrics("linespace")
            if cursor + card_h > bottom - 12:
                remaining = len(items) - index
                if remaining > 0:
                    self._track(
                        self.canvas.create_text(
                            x + width // 2,
                            bottom - 24,
                            anchor="s",
                            text=f"+ {remaining} more",
                            fill=accent,
                            font=self.shell.forecast_label_font,
                        )
                    )
                break

            self._round_rect(
                card_x,
                cursor,
                card_x + card_width,
                cursor + card_h,
                radius=0,
                fill=self.CARD,
                outline=accent,
            )
            self._round_rect(
                card_x + 8,
                cursor + 8,
                card_x + 14,
                cursor + card_h - 8,
                radius=0,
                fill=accent,
            )
            self._track(
                self.canvas.create_text(
                    card_x + 26,
                    cursor + 14,
                    anchor="nw",
                    text=card_text,
                    fill=text,
                    font=self.shell.body_font,
                    width=card_width - 28,
                )
            )
            cursor += card_h + 12

    @staticmethod
    def _looks_like_empty_notification_message(text: str) -> bool:
        normalized = " ".join(str(text or "").split()).lower()
        if not normalized:
            return False
        patterns = (
            r"\bno(?:\s+\w+){0,6}\s+notifications?\b",
            r"\bzero notifications?\b",
            r"\bnotifications?\s+(?:are\s+)?(?:clear|empty)\b",
            r"\byou have no\b(?:\s+\w+){0,6}\s+notifications?\b",
            r"\bthere(?:'s| is| are) no\b(?:\s+\w+){0,6}\s+notifications?\b",
            r"\ball caught up\b",
        )
        return any(re.search(pattern, normalized) for pattern in patterns)

    def _draw_bell_icon(self, cx: float, cy: float, size: float, color: str):
        half = size / 2
        self._track(
            self.canvas.create_arc(
                cx - half * 0.85,
                cy - half,
                cx + half * 0.85,
                cy + half * 0.35,
                start=0,
                extent=180,
                style=tk.CHORD,
                fill=color,
                outline="",
            )
        )
        self._track(
            self.canvas.create_rectangle(
                cx - half * 0.95,
                cy + half * 0.05,
                cx + half * 0.95,
                cy + half * 0.55,
                fill=color,
                outline="",
            )
        )
        self._track(
            self.canvas.create_oval(
                cx - half * 0.22,
                cy + half * 0.48,
                cx + half * 0.22,
                cy + half * 0.78,
                fill=color,
                outline="",
            )
        )


class AuthPinPanel(BasePanel):
    """Show a one-time unlock PIN, or a brief green Authenticated flash."""

    def _render(self, payload: dict):
        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()

        layout = self.shell.layout
        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        auth = payload.get("auth") or {}
        status = str(auth.get("status") or "").strip().lower()
        authenticated = status in ("ok", "authenticated", "success")
        pin = str(auth.get("pin") or "").strip()
        if not pin and not authenticated:
            pin = "----"

        center_x = layout.content_x + layout.content_width // 2
        area_top = layout.message_area_top
        area_bottom = layout.message_area_bottom
        center_y = area_top + int((area_bottom - area_top) * 0.42)

        card_w = min(layout.content_width - 24, 520)
        card_h = min(int((area_bottom - area_top) * 0.55), 360)
        left = center_x - card_w // 2
        top = center_y - card_h // 2
        self._panel_card(left, top, card_w, card_h)

        if authenticated:
            success = "#22c55e"
            self._track(
                self.canvas.create_text(
                    center_x,
                    top + int(card_h * 0.48),
                    anchor="center",
                    text="Authenticated",
                    fill=success,
                    font=self.shell.hero_font,
                )
            )
            return

        self._track(
            self.canvas.create_text(
                center_x,
                top + int(card_h * 0.18),
                anchor="center",
                text="CONTROL UNLOCK",
                fill=accent,
                font=self.shell.chip_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                center_x,
                top + int(card_h * 0.48),
                anchor="center",
                text=pin,
                fill=text,
                font=self.shell.hero_font,
            )
        )
        self._track(
            self.canvas.create_text(
                center_x,
                top + int(card_h * 0.78),
                anchor="center",
                text="Enter this PIN on your phone to unlock\nmouse, keyboard, and power controls",
                fill=muted,
                font=self.shell.chip_value_font,
                justify=tk.CENTER,
            )
        )


class QrPanel(BasePanel):
    """Renders a QR code generated locally from the bridge's `qr.content` string.

    The bridge never renders a bitmap — it only sends a small content string
    (a URL, or a `WIFI:T:...;;` string), so the QR density/aspect ratio can
    vary a lot. This panel sizes the code to fit whatever room is left below
    the shared title, keeping a plain white quiet zone (the `qrcode` library
    bakes this into the image itself) so phone cameras can still lock on.

    Shared-photo pushes (`qrType: "photo"`, or a URL under `/qr-images/`)
    use the same full-bleed shared-photos page as the slideshow (upload mode).
    """

    _HEADINGS = {
        "url": "Scan to open",
        "wifi": "Scan to join Wi-Fi",
        "photo": "Shared photo",
    }

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._qr_image = None  # keep a reference or Tk garbage-collects it
        self._photo_image = None
        self._fetch_token = 0
        self._photo_mode = False
        self._shared_page = None
        self._status_job = None
        self._dismiss_sec = 15
        self._slide_started_at = 0.0

    def hide(self):
        self._fetch_token += 1
        self._photo_image = None
        self._photo_mode = False
        if self._status_job is not None:
            try:
                self.root.after_cancel(self._status_job)
            except Exception:
                pass
            self._status_job = None
        if self._shared_page is not None:
            self._shared_page.clear_refs()
            self._shared_page = None
        super().hide()

    @staticmethod
    def _build_qr_image(content: str, target_size: int):
        if Image is None or not content:
            return None
        try:
            import qrcode
            from qrcode.constants import ERROR_CORRECT_M
        except ImportError:
            return None
        try:
            qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=3, box_size=10)
            qr.add_data(content)
            qr.make(fit=True)
            modules = qr.modules_count + qr.border * 2
            qr.box_size = max(1, target_size // modules)
            return qr.make_image(fill_color="black", back_color="white").convert("RGB")
        except Exception as error:
            print(f"QR code generation failed: {error}", file=sys.stderr)
            return None

    @staticmethod
    def _is_shared_photo_url(content: str) -> bool:
        """Bridge serves uploaded photos at `/qr-images/<token>.<ext>`."""
        try:
            path = urllib.parse.urlparse(str(content or "")).path or ""
        except Exception:
            return False
        return "/qr-images/" in path

    def _overlay_display_seconds(self) -> int:
        overlay = getattr(self.shell, "overlay", None)
        try:
            sec = int(getattr(overlay, "_display_seconds", 0) or 0)
        except (TypeError, ValueError):
            sec = 0
        return sec if sec > 0 else 15

    def _render(self, payload: dict):
        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()
        self._qr_image = None
        self._photo_image = None
        self._fetch_token += 1
        self._photo_mode = False
        if self._shared_page is not None:
            self._shared_page.clear_refs()
            self._shared_page = None
        if self._status_job is not None:
            try:
                self.root.after_cancel(self._status_job)
            except Exception:
                pass
            self._status_job = None

        qr = payload.get("qr") or {}
        qr_type = str(qr.get("qrType") or "url").lower()
        content = str(qr.get("content") or "")
        label = str(qr.get("label") or "").strip()

        if qr_type == "photo" or self._is_shared_photo_url(content):
            self._photo_mode = True
            self._render_photo_with_corner_qr(content, label)
            return

        self._render_code_only(qr_type, content, label)

    def _render_code_only(self, qr_type: str, content: str, label: str):
        layout = self.shell.layout
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        heading = self._HEADINGS.get(qr_type, "Scan this code")

        x = layout.content_x
        width = layout.content_width
        top = layout.message_area_top
        bottom = layout.message_area_bottom
        center_x = x + width // 2

        heading_h = self.shell.section_title_font.metrics("linespace")
        caption_h = self.shell.body_font.metrics("linespace") if label else 0
        gaps = 16 + (16 if label else 0)
        available_h = max(120, (bottom - top) - heading_h - caption_h - gaps)
        available_w = width - 80
        qr_size = int(max(160, min(520, available_w, available_h)))

        cursor = top
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=heading,
                fill=accent,
                font=self.shell.section_title_font,
            )
        )
        cursor += heading_h + 16

        qr_top = cursor
        image = self._build_qr_image(content, qr_size)
        if image is not None:
            self._qr_image = ImageTk.PhotoImage(image)
            self._track(
                self.canvas.create_image(
                    center_x, qr_top + image.height // 2, image=self._qr_image,
                )
            )
            cursor = qr_top + image.height + 20
        else:
            # Pillow/qrcode unavailable (or empty content) — still say
            # something useful instead of an empty panel.
            self._panel_card(center_x - qr_size // 2, qr_top, qr_size, qr_size)
            self._track(
                self.canvas.create_text(
                    center_x,
                    qr_top + qr_size // 2,
                    anchor="center",
                    text="QR code unavailable",
                    fill=muted,
                    font=self.shell.body_font,
                    width=qr_size - 40,
                    justify=tk.CENTER,
                )
            )
            cursor = qr_top + qr_size + 20

        if label:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=label,
                    fill=text,
                    font=self.shell.body_font,
                    width=width - 40,
                    justify=tk.CENTER,
                )
            )

    def _render_photo_with_corner_qr(self, url: str, label: str):
        """Single-upload shared photo page (same layout as the slideshow)."""
        from src.shared_photos_page import SharedPhotosRenderer, NEUTRAL_MAT

        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()
        self._photo_image = None
        self._qr_image = None

        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        page = SharedPhotosRenderer(self.canvas, self.shell, self.config, self._track)
        layout = page.prepare(screen_w, screen_h, mode="upload")
        page.paint_mat(NEUTRAL_MAT, screen_w, screen_h)
        page.paint_header(mode="upload", index=0, total=1)

        muted = self.config["mutedTextColor"]
        cx = layout.x0 + layout.page_w / 2
        cy = (layout.stage[1] + layout.stage[3]) / 2
        self._track(self.canvas.create_text(
            cx, cy, anchor="center", text="Loading photo…",
            fill=muted, font=self.shell.body_font,
        ))

        self._shared_page = page
        token = self._fetch_token
        max_w = int(layout.photo_box[0]) * 2
        max_h = int(layout.photo_box[1]) * 2
        dismiss_sec = self._overlay_display_seconds()

        def worker():
            image = PhotoSlideshowPanel._fetch_photo(url, max_w, max_h)
            self.root.after(
                0,
                lambda: self._apply_photo_preview(token, image, url, label, dismiss_sec),
            )

        threading.Thread(target=worker, daemon=True).start()

    def _apply_photo_preview(self, token: int, image, url: str, label: str, dismiss_sec: int = 15):
        if token != self._fetch_token or not self.visible:
            return
        from src.shared_photos_page import (
            SharedPhotosRenderer, sample_mat_accent, NEUTRAL_MAT, NEUTRAL_ACCENT,
        )
        import time as _time

        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()

        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or getattr(self.shell, "screen_w", 0) or 1080)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or getattr(self.shell, "screen_h", 0) or 1920)
        page = SharedPhotosRenderer(self.canvas, self.shell, self.config, self._track)
        self._shared_page = page
        layout = page.prepare(screen_w, screen_h, mode="upload")
        mat, accent = sample_mat_accent(image) if image is not None else (NEUTRAL_MAT, NEUTRAL_ACCENT)
        muted = self.config["mutedTextColor"]

        page.paint_mat(mat, screen_w, screen_h)
        page.paint_header(mode="upload", index=0, total=1)

        if image is None:
            cx = layout.x0 + layout.page_w / 2
            cy = (layout.stage[1] + layout.stage[3]) / 2
            self._track(self.canvas.create_text(
                cx, cy, anchor="center", text="Could not load this photo",
                fill=muted, font=self.shell.body_font,
            ))
        else:
            self._photo_image = page.paint_photo(image)

        self._dismiss_sec = max(1, int(dismiss_sec))
        self._slide_started_at = _time.time()
        from src.shared_photos_page import next_in_seconds
        left = next_in_seconds(self._slide_started_at, self._dismiss_sec)
        page.paint_bar(
            mode="upload",
            index=0,
            total=1,
            uploaded_at=None,
            caption=label or "",
            qr_url=url,
            build_qr=QrPanel._build_qr_image,
            dwell_ms=self._dismiss_sec * 1000,
            status_text=f"Dismisses in {left}s",
            accent=accent,
            started_at=self._slide_started_at,
        )
        self._qr_image = page._qr_ref
        self._start_dismiss_clock()

    def _start_dismiss_clock(self):
        if self._status_job is not None:
            try:
                self.root.after_cancel(self._status_job)
            except Exception:
                pass
            self._status_job = None
        if not self._photo_mode or not self._shared_page:
            return

        from src.shared_photos_page import next_in_seconds, rail_remaining_fraction

        def tick():
            if not self.visible or not self._shared_page or not self._photo_mode:
                return
            left = next_in_seconds(self._slide_started_at, self._dismiss_sec)
            self._shared_page.set_status(f"Dismisses in {left}s")
            self._shared_page.set_rail_fraction(
                rail_remaining_fraction(
                    self._slide_started_at, self._dismiss_sec * 1000,
                ),
            )
            if left > 0:
                self._status_job = self.root.after(250, tick)

        self._status_job = self.root.after(250, tick)


class GuestPhotoboothPanel(BasePanel):
    """Guest Snaps welcome: Wi‑Fi QR + booth URL QR.

    Owns NETWORK/SSID + GUEST SNAPS chrome (shared title/backdrop hidden in
    overlay.py). Portrait stacks the two large white QR plates; landscape pairs
    them side-by-side. Gap is 24u; no connector/"then" band.
    """

    ACCENT = "#5FD0FF"
    QR_FRAME = "#FFFFFF"

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._wifi_qr_image = None
        self._booth_qr_image = None

    def hide(self):
        self._wifi_qr_image = None
        self._booth_qr_image = None
        super().hide()

    @staticmethod
    def compute_card_geometry(
        content_w: int,
        content_h: int,
        portrait: bool,
        *,
        header_h: int = 0,
        u: float = 1.0,
    ) -> dict:
        """Pure two-card geometry; the shared page header is outside content."""
        content_w = max(320, int(content_w))
        content_h = max(360, int(content_h))
        gap = int(round(24 * u))
        plate_target = int(round(620 * u))
        # Step row + caption + pads — leave the rest for the white plate.
        chrome_reserve = int(round(140 * u))
        side_pad = int(round(48 * u))
        if portrait:
            card_w = content_w
            card_h = max(200, (content_h - gap) // 2)
            cards = ({"x": 0, "y": 0}, {"x": 0, "y": card_h + gap})
        else:
            card_w = max(240, (content_w - gap) // 2)
            card_h = content_h
            cards = ({"x": 0, "y": 0}, {"x": card_w + gap, "y": 0})
        plate = int(max(
            200 * u,
            min(plate_target, card_w - side_pad, card_h - chrome_reserve),
        ))
        # Prefer plate ~620*u with QR at 560/620 of plate when space allows.
        qr_size = int(round(plate * 560 / 620))
        return {
            "portrait": portrait, "header_h": header_h, "gap": gap, "origin_y": 0,
            "card_w": card_w, "card_h": card_h, "plate": plate,
            "qr_size": qr_size, "connector_h": 0, "cards": cards,
        }

    def _render(self, payload: dict):
        from src.design_system import page_chrome
        from src.page_header import paint_page_header

        data = payload.get("guestPhotobooth") or {}
        wifi = data.get("wifi") or {}
        booth = data.get("booth") or {}
        ssid = str(wifi.get("ssid") or "Guest Wi‑Fi").strip()
        screen_w = int(getattr(self.shell, "screen_w", self.canvas.winfo_width()))
        screen_h = int(getattr(self.shell, "screen_h", self.canvas.winfo_height()))
        chrome = page_chrome(screen_w, screen_h, timed=True)
        paint_page_header(
            self.canvas, screen_w=screen_w, screen_h=screen_h, pill="Guest Snaps",
            left_label="Network", left_value=ssid, track=self._track,
        )
        geo = self.compute_card_geometry(
            int(chrome.content_w), int(chrome.content_bottom - chrome.content_top),
            chrome.portrait, u=chrome.u,
        )
        for index, (step, card) in enumerate(zip((wifi, booth), geo["cards"]), start=1):
            self._draw_guest_redesign_card(
                chrome.content_x + card["x"], chrome.content_top + card["y"],
                geo["card_w"], geo["card_h"], geo["plate"], geo["qr_size"], step,
                index=index, ssid=ssid,
                qr_attr="_wifi_qr_image" if index == 1 else "_booth_qr_image",
            )

    def _draw_guest_redesign_card(self, x, y, w, h, plate, qr_size, step, *, index, ssid, qr_attr):
        from src.design_system import ACCENT, INK, INK_2, LINE

        pad = max(16, int(w * .035))
        number = f"{index:02d}"
        heading = str(step.get("heading") or (
            "Join Wi‑Fi" if index == 1 else "Open Guest Snaps"
        )).strip()
        content = str(step.get("content") or "").strip()
        mono = self.shell.chip_value_font
        heading_font = self.shell.body_font
        caption_font = self.shell.forecast_label_font
        self._round_rect(x, y, x + w, y + h, radius=0, fill="", outline=LINE, width=2)
        header_y = y + pad
        self._track(self.canvas.create_text(
            x + pad, header_y, anchor="nw", text=number, fill=ACCENT, font=mono,
        ))
        self._track(self.canvas.create_text(
            x + pad + mono.measure(number) + 14, header_y, anchor="nw",
            text=heading, fill=INK, font=heading_font,
        ))
        caption_h = caption_font.metrics("linespace")
        plate_budget = min(
            w - 2 * pad,
            h - 3 * pad - caption_h - heading_font.metrics("linespace"),
        )
        plate_size = max(120, min(int(plate), plate_budget))
        draw_size = max(120, min(int(qr_size), int(plate_size * 560 / 620)))
        plate_x = x + (w - plate_size) / 2
        plate_y = y + heading_font.metrics("linespace") + 2 * pad
        self._round_rect(
            plate_x, plate_y, plate_x + plate_size, plate_y + plate_size,
            radius=0, fill=self.QR_FRAME, outline="#E2E8F0", width=1,
        )
        image = QrPanel._build_qr_image(content, draw_size)
        if image is not None and ImageTk is not None:
            photo = ImageTk.PhotoImage(image)
            setattr(self, qr_attr, photo)
            self._track(self.canvas.create_image(
                plate_x + plate_size / 2, plate_y + plate_size / 2, image=photo,
            ))
        elif image is None:
            self._track(self.canvas.create_text(
                plate_x + plate_size / 2, plate_y + plate_size / 2, anchor="center",
                text="QR unavailable", fill=INK_2, font=caption_font,
            ))
        caption_y = min(y + h - pad - caption_h, plate_y + plate_size + pad)
        if index == 1:
            prefix = "Network "
            total_w = caption_font.measure(prefix) + mono.measure(ssid)
            left = x + w / 2 - total_w / 2
            self._track(self.canvas.create_text(
                left, caption_y, anchor="nw", text=prefix, fill=INK_2, font=caption_font,
            ))
            self._track(self.canvas.create_text(
                left + caption_font.measure(prefix), caption_y,
                anchor="nw", text=ssid, fill=ACCENT, font=mono,
            ))
        else:
            self._track(self.canvas.create_text(
                x + w / 2, caption_y, anchor="n",
                text="Already connected? Start here",
                fill=INK_2, font=caption_font,
            ))


class PhotoSlideshowPanel(BasePanel):
    """Shared photos slideshow — one pass through the album (spec v2 layout)."""

    _UNVERIFIED_SSL = False

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._status_job = None
        self._photos: list[dict] = []
        self._index = 0
        self._seconds_per_photo = 5
        self._photo_image = None
        self._fetch_token = 0
        self._page = None
        self._mode = "slideshow"
        self._slide_started_at = 0.0

    def _screen_size(self):
        def _dim(obj, name: str) -> int:
            if obj is None:
                return 0
            try:
                return int(getattr(obj, name, 0) or 0)
            except (TypeError, ValueError):
                return 0

        overlay = getattr(self.shell, "overlay", None)
        screen_w = _dim(overlay, "screen_w")
        screen_h = _dim(overlay, "screen_h")
        if screen_w < 64:
            screen_w = _dim(self.shell, "screen_w") or int(self.root.winfo_screenwidth() or 1080)
        if screen_h < 64:
            screen_h = _dim(self.shell, "screen_h") or int(self.root.winfo_screenheight() or 1920)
        return screen_w, screen_h

    def _ensure_page(self):
        if self._page is None:
            from src.shared_photos_page import SharedPhotosRenderer
            self._page = SharedPhotosRenderer(
                self.canvas, self.shell, self.config, self._track,
            )
        return self._page

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        self._mode = "slideshow"
        slideshow = payload.get("slideshow") or {}
        photos = []
        for entry in slideshow.get("photos") or []:
            if isinstance(entry, dict):
                url = str(entry.get("url") or "").strip()
                uploaded_at = entry.get("uploadedAt")
                caption = str(entry.get("caption") or entry.get("message") or "").strip()
            else:
                url = str(entry or "").strip()
                uploaded_at = None
                caption = ""
            if url:
                photos.append({
                    "url": url,
                    "uploadedAt": uploaded_at,
                    "caption": caption,
                })
        self._photos = photos
        try:
            self._seconds_per_photo = max(1, int(slideshow.get("secondsPerPhoto") or 5))
        except (TypeError, ValueError):
            self._seconds_per_photo = 5
        self._index = 0
        self._render_current()

    def hide(self):
        if self._status_job is not None:
            try:
                self.root.after_cancel(self._status_job)
            except Exception:
                pass
            self._status_job = None
        super().hide()
        self._photos = []
        self._index = 0
        self._photo_image = None
        self._fetch_token += 1
        if self._page:
            self._page.clear_refs()

    def _render(self, payload: dict):  # pragma: no cover
        self._render_current()

    def _advance(self):
        self._tick_job = None
        if not self.visible or not self._photos:
            return
        if self._index + 1 >= len(self._photos):
            return
        self._index += 1
        self._render_current()

    def _clear_canvas_items(self):
        for item_id in list(self._item_ids):
            self.canvas.delete(item_id)
        self._item_ids.clear()
        if self._page:
            self._page.clear_refs()
        self._photo_image = None

    def _render_current(self):
        self._clear_canvas_items()
        page = self._ensure_page()
        screen_w, screen_h = self._screen_size()
        layout = page.prepare(screen_w, screen_h, mode=self._mode)
        from src.shared_photos_page import NEUTRAL_MAT, NEUTRAL_ACCENT

        page.paint_mat(NEUTRAL_MAT, screen_w, screen_h)
        muted = self.config.get("mutedTextColor", "#94a3b8")

        if not self._photos:
            page.paint_header(mode=self._mode, index=0, total=0)
            cx = layout.x0 + layout.page_w / 2
            cy = (layout.stage[1] + layout.stage[3]) / 2
            self._track(self.canvas.create_text(
                cx, cy, anchor="center",
                text="No saved photos yet",
                fill=muted, font=self.shell.body_font,
            ))
            return

        current = self._photos[self._index]
        url = current["url"]
        token = self._fetch_token
        max_w = int(layout.photo_box[0])
        max_h = int(layout.photo_box[1])

        def worker():
            image = self._fetch_photo(url, max_w * 2, max_h * 2)
            self.root.after(0, lambda: self._apply_fetched(token, image))

        threading.Thread(target=worker, daemon=True).start()

        page.paint_header(
            mode=self._mode, index=self._index, total=len(self._photos),
        )
        cx = layout.x0 + layout.page_w / 2
        cy = (layout.stage[1] + layout.stage[3]) / 2
        self._track(self.canvas.create_text(
            cx, cy, anchor="center", text="Loading photo…",
            fill=muted, font=self.shell.body_font,
        ))
        # Do not start the advance clock until the photo (and rail) are on
        # screen — otherwise NEXT IN / the drain rail lag the real slide.

    def _apply_fetched(self, token: int, image):
        if token != self._fetch_token or not self.visible:
            return
        self._clear_canvas_items()
        page = self._ensure_page()
        screen_w, screen_h = self._screen_size()
        layout = page.prepare(screen_w, screen_h, mode=self._mode)
        from src.shared_photos_page import sample_mat_accent, NEUTRAL_MAT, NEUTRAL_ACCENT

        muted = self.config.get("mutedTextColor", "#94a3b8")
        current = self._photos[self._index] if self._photos else {}
        total = len(self._photos)
        mat, accent = sample_mat_accent(image) if image is not None else (NEUTRAL_MAT, NEUTRAL_ACCENT)

        page.paint_mat(mat, screen_w, screen_h)
        page.paint_header(mode=self._mode, index=self._index, total=total)

        if image is None:
            cx = layout.x0 + layout.page_w / 2
            cy = (layout.stage[1] + layout.stage[3]) / 2
            self._track(self.canvas.create_text(
                cx, cy, anchor="center", text="Could not load this photo",
                fill=muted, font=self.shell.body_font,
            ))
        else:
            self._photo_image = page.paint_photo(image)

        import time as _time
        from src.shared_photos_page import next_in_seconds

        dwell_ms = self._seconds_per_photo * 1000
        self._slide_started_at = _time.time()
        active_dwell = (
            dwell_ms
            if self._index + 1 < total or self._mode == "upload"
            else 0
        )
        left = next_in_seconds(self._slide_started_at, self._seconds_per_photo)
        status = (
            f"Dismisses in {left}s" if self._mode == "upload"
            else f"NEXT IN {left}s"
        )
        if self._mode != "upload" and self._index + 1 >= total:
            status = "LAST PHOTO"

        page.paint_bar(
            mode=self._mode,
            index=self._index,
            total=total,
            uploaded_at=current.get("uploadedAt"),
            caption=current.get("caption") or "",
            qr_url=current.get("url") or "",
            build_qr=QrPanel._build_qr_image,
            dwell_ms=active_dwell,
            status_text=status,
            accent=accent,
            started_at=self._slide_started_at,
        )
        self._start_status_clock()
        if self._tick_job:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None
        if self._mode != "upload" and self._index + 1 < total:
            # Advance when the same wall clock that drives NEXT IN / the rail hits 0.
            self._tick_job = self.root.after(active_dwell, self._advance)

    def _start_status_clock(self):
        if self._status_job is not None:
            try:
                self.root.after_cancel(self._status_job)
            except Exception:
                pass
            self._status_job = None
        if not self._photos or not self._page:
            return
        if self._mode != "upload" and self._index + 1 >= len(self._photos):
            return

        from src.shared_photos_page import next_in_seconds, rail_remaining_fraction

        prefix = "Dismisses in" if self._mode == "upload" else "NEXT IN"

        def tick():
            if not self.visible or not self._page:
                return
            left = next_in_seconds(self._slide_started_at, self._seconds_per_photo)
            self._page.set_status(f"{prefix} {left}s")
            # Keep rail glued to the same clock even if its after(33) loop jittered.
            self._page.set_rail_fraction(
                rail_remaining_fraction(
                    self._slide_started_at, self._seconds_per_photo * 1000,
                ),
            )
            if left > 0:
                self._status_job = self.root.after(250, tick)

        self._status_job = self.root.after(250, tick)

    @staticmethod
    def _is_ssl_failure(error) -> bool:
        import ssl

        seen = set()
        current = error
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if isinstance(current, ssl.SSLError):
                return True
            current = getattr(current, "reason", None) or getattr(current, "__cause__", None)
        return "CERTIFICATE_VERIFY_FAILED" in str(error) or "SSL" in str(error)

    @classmethod
    def _fetch_photo(cls, url: str, max_w: int, max_h: int):
        if Image is None or not url:
            return None
        import ssl

        request = urllib.request.Request(
            url, headers={"User-Agent": "alexa-broadcast-client/1.0 (personal home display)"},
        )

        def download(context):
            with urllib.request.urlopen(request, timeout=10, context=context) as response:
                return response.read()

        try:
            context = (
                ssl._create_unverified_context()
                if cls._UNVERIFIED_SSL
                else ssl.create_default_context()
            )
            try:
                data = download(context)
            except Exception as error:
                if not cls._UNVERIFIED_SSL and cls._is_ssl_failure(error):
                    data = download(ssl._create_unverified_context())
                    cls._UNVERIFIED_SSL = True
                else:
                    raise
            image = Image.open(io.BytesIO(data)).convert("RGB")
            # Soft ceiling so we don't keep multi‑MB bitmaps around; final
            # contain+border happens in shared_photos_page.fit_photo_for_box.
            image.thumbnail((max(max_w, 1), max(max_h, 1)), Image.LANCZOS)
            return image
        except Exception as error:
            print(f"Photo slideshow fetch failed: {error}", file=sys.stderr, flush=True)
            return None


class RoutePlannerPanel(BasePanel):
    """Route Planner — renders the bridge's lean `route-planner.query`
    payload (names/coords/mode/distance/duration/route-line) instantly, then
    independently fetches five slower tiles (map, two place-facts, two
    weather) off the Tk thread, each swapping its own spinner for real
    content the moment it lands — mirrors `TeslaDashboardPanel`'s async map
    fetch and `MusicPanel`'s async album-art fetch (request-id fenced so a
    stale fetch from a previous query can't render over a newer one).
    """

    TICK_MS = 90
    PIN_RADIUS = 8
    # Reuse WeatherPanel's condition palette/labels so the mini weather tiles
    # match the main WeatherPanel look (see `_apply_weather` below, which
    # borrows `WeatherPanel._draw_condition_icon` directly).
    CONDITION_COLORS = WeatherPanel.CONDITION_COLORS
    CONDITION_LABELS = WeatherPanel.CONDITION_LABELS

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._request_id = 0
        self._pending_tiles: set[str] = set()
        self._spinner_items: dict[str, tuple[int, int]] = {}
        self._tile_item_ids: dict[str, list[int]] = {}
        self._tile_boxes: dict[str, tuple[float, float, float, float]] = {}
        self._weather_snapshots: dict[str, dict | None] = {}
        self._weather_done: dict[str, bool] = {}
        self._spinner_angle = 0.0
        self._map_photo = None
        self._duration_min = None
        # Facts tiles get their own nested viewport + scroller (reusing the
        # broadcast message's pause/scroll/pause controller) so long facts
        # scroll in place instead of overflowing the card and overlapping
        # the tile below — see `_apply_facts`.
        self._fact_scrollers: dict[str, MessageScrollController] = {}
        self._fact_widgets: dict[str, tk.Canvas] = {}

    def hide(self):
        self._request_id += 1
        self._pending_tiles = set()
        self._spinner_items = {}
        self._tile_item_ids = {}
        self._tile_boxes = {}
        self._weather_snapshots = {}
        self._weather_done = {}
        self._map_photo = None
        for scroller in self._fact_scrollers.values():
            scroller.stop()
        self._fact_scrollers = {}
        self._fact_widgets = {}
        super().hide()

    # -- per-tile bookkeeping -------------------------------------------------

    def _track_tile(self, key: str, item_id: int) -> int:
        self._track(item_id)
        self._tile_item_ids.setdefault(key, []).append(item_id)
        return item_id

    def _clear_tile(self, key: str):
        for item_id in self._tile_item_ids.get(key, []):
            self.canvas.delete(item_id)
            if item_id in self._item_ids:
                self._item_ids.remove(item_id)
        self._tile_item_ids[key] = []
        self._spinner_items.pop(key, None)
        self._pending_tiles.discard(key)
        scroller = self._fact_scrollers.pop(key, None)
        if scroller is not None:
            scroller.stop()
        widget = self._fact_widgets.pop(key, None)
        if widget is not None:
            widget.place_forget()
            if widget in self._widgets:
                self._widgets.remove(widget)

    def _draw_tile_placeholder(self, key: str, box, label: str):
        x0, y0, x1, y1 = box
        self._panel_card(x0, y0, x1 - x0, y1 - y0)
        muted = self.config["mutedTextColor"]
        label_id = self.canvas.create_text(
            x0 + 14, y0 + 12, anchor="nw", text=label, fill=muted,
            font=self.shell.chip_label_font, width=max(40, (x1 - x0) - 28),
        )
        self._track_tile(key, label_id)
        cx = (x0 + x1) / 2
        cy = (y0 + y1) / 2 + 8
        radius = max(14, min(24, (y1 - y0) / 4, (x1 - x0) / 6))
        self._start_tile_spinner(key, cx, cy, radius)

    def _start_tile_spinner(self, key: str, cx: float, cy: float, radius: float):
        accent = self.config.get("accentColor", "#38bdf8")
        arc1 = self.canvas.create_arc(
            cx - radius, cy - radius, cx + radius, cy + radius,
            start=self._spinner_angle, extent=100, style=tk.ARC, outline=accent, width=4,
        )
        arc2 = self.canvas.create_arc(
            cx - radius, cy - radius, cx + radius, cy + radius,
            start=self._spinner_angle + 180, extent=60, style=tk.ARC, outline=accent, width=3,
        )
        self._track_tile(key, arc1)
        self._track_tile(key, arc2)
        self._spinner_items[key] = (arc1, arc2)
        self._pending_tiles.add(key)

    def _schedule_tick(self):
        self._stop_tick()
        self._tick_job = self.root.after(self.TICK_MS, self._tick)

    def _tick(self):
        self._tick_job = None
        if not self.visible or not self._pending_tiles:
            return
        self._spinner_angle = (self._spinner_angle - 9) % 360
        for arc1, arc2 in self._spinner_items.values():
            self.canvas.itemconfigure(arc1, start=self._spinner_angle)
            self.canvas.itemconfigure(arc2, start=self._spinner_angle + 180)
        self._schedule_tick()

    def _show_tile_error(self, request_id: int, key: str, box, message: str):
        if not self.visible or request_id != self._request_id:
            return
        self._clear_tile(key)
        x0, y0, x1, y1 = box
        muted = self.config["mutedTextColor"]
        text_id = self.canvas.create_text(
            (x0 + x1) / 2, (y0 + y1) / 2, anchor="center", text=message, fill=muted,
            font=self.shell.forecast_label_font, width=max(60, (x1 - x0) - 24), justify=tk.CENTER,
        )
        self._track_tile(key, text_id)

    # -- layout ---------------------------------------------------------------

    def _compute_tile_boxes(self, x: float, width: float, top: float, bottom: float, portrait: bool):
        # Weather and the local-times strip only ever hold a couple of
        # short, fixed-size lines, so they get compact fixed-ish shares of
        # the budget; the facts tiles get whatever's left over since their
        # prose is the thing most likely to need room (and now scrolls in
        # place — see `_apply_facts` — instead of overflowing onto the tile
        # below it, which is what caused the old overlap bug).
        gap = 14
        boxes = {}
        if portrait:
            available_h = max(1, bottom - top)
            map_h = max(160, int(available_h * 0.32))
            weather_h = max(84, int(available_h * 0.15))
            time_h = max(70, int(available_h * 0.13))
            facts_h = max(130, available_h - map_h - weather_h - time_h - gap * 3)
            y = top
            boxes["map"] = (x, y, x + width, y + map_h)
            y += map_h + gap
            col_w = (width - gap) / 2
            boxes["facts_origin"] = (x, y, x + col_w, y + facts_h)
            boxes["facts_destination"] = (x + col_w + gap, y, x + width, y + facts_h)
            y += facts_h + gap
            boxes["weather_origin"] = (x, y, x + col_w, y + weather_h)
            boxes["weather_destination"] = (x + col_w + gap, y, x + width, y + weather_h)
            y += weather_h + gap
            boxes["time"] = (x, y, x + width, y + time_h)
        else:
            left_w = int(width * 0.52)
            right_x = x + left_w + gap
            right_w = width - left_w - gap
            boxes["map"] = (x, top, x + left_w, bottom)
            available_h = max(1, bottom - top)
            weather_h = max(84, int(available_h * 0.20))
            time_h = max(70, int(available_h * 0.18))
            facts_h = max(130, available_h - weather_h - time_h - gap * 2)
            y = top
            col_w = (right_w - gap) / 2
            boxes["facts_origin"] = (right_x, y, right_x + col_w, y + facts_h)
            boxes["facts_destination"] = (right_x + col_w + gap, y, right_x + right_w, y + facts_h)
            y += facts_h + gap
            boxes["weather_origin"] = (right_x, y, right_x + col_w, y + weather_h)
            boxes["weather_destination"] = (right_x + col_w + gap, y, right_x + right_w, y + weather_h)
            y += weather_h + gap
            boxes["time"] = (right_x, y, right_x + right_w, y + time_h)
        return boxes

    # -- render -----------------------------------------------------------------

    def _render(self, payload: dict):
        request_id = self._request_id
        self._weather_done = {"origin": False, "destination": False}

        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        top = int(self.shell.overlay.screen_h * (0.035 if layout.portrait else 0.05))
        bottom = layout.message_area_bottom
        self._container_frame(x, top, width, bottom - top)

        mode = payload.get("mode") if payload.get("mode") in ("driving", "flight") else "driving"
        origin = payload.get("origin") or {}
        destination = payload.get("destination") or {}
        distance_miles = payload.get("distanceMiles")
        duration_min = payload.get("durationMin")
        geometry = (payload.get("route") or {}).get("geometry") or []
        self._duration_min = duration_min

        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")

        badge_label = "Flight-Path Estimate" if mode == "flight" else "Driving Estimate"
        badge_fill = self.AMBER_BG if mode == "flight" else self.GREEN_BG
        badge_fg = self.AMBER if mode == "flight" else self.GREEN
        pill_h = self._pill(x, top, badge_label, fill=badge_fill, fg=badge_fg)

        origin_name = shorten_route_place_name(origin.get("name") or "Origin")
        dest_name = shorten_route_place_name(destination.get("name") or "Destination")
        title_y = top + pill_h + 14
        # `width=` makes Tk wrap long "A → B" titles onto multiple lines. Stats
        # must sit below the *actual* wrapped bbox — using a single linespace
        # put "395 mi · about 5h 42m" on top of the destination line.
        title_id = self.canvas.create_text(
            x, title_y, anchor="nw", text=f"{origin_name}  \u2192  {dest_name}",
            fill=text, font=self.shell.section_title_font, width=width,
        )
        self._track(title_id)
        title_bbox = self.canvas.bbox(title_id)
        if title_bbox:
            stat_y = title_bbox[3] + 10
        else:
            stat_y = title_y + self.shell.section_title_font.metrics("linespace") + 10

        distance_label = format_route_distance(distance_miles)
        duration_label = format_route_duration(duration_min)
        stat_text = (
            f"{distance_label}  \u00b7  about {duration_label}"
            if duration_min is not None
            else distance_label
        )
        stat_id = self.canvas.create_text(
            x, stat_y, anchor="nw", text=stat_text, fill=accent,
            font=self.shell.body_font, width=width,
        )
        self._track(stat_id)
        stat_bbox = self.canvas.bbox(stat_id)
        if stat_bbox:
            tiles_top = stat_bbox[3] + 18
        else:
            tiles_top = stat_y + self.shell.body_font.metrics("linespace") + 18
        tiles_bottom = bottom - 6
        boxes = self._compute_tile_boxes(x, width, tiles_top, tiles_bottom, layout.portrait)
        self._tile_boxes = boxes

        for key, label in (
            ("map", "Route Map"),
            ("facts_origin", origin_name),
            ("facts_destination", dest_name),
            ("weather_origin", f"Weather \u00b7 {origin_name}"),
            ("weather_destination", f"Weather \u00b7 {dest_name}"),
            ("time", "Local Times"),
        ):
            self._draw_tile_placeholder(key, boxes[key], label)

        self._schedule_tick()

        self._start_map_fetch(origin, destination, geometry, mode, boxes["map"], request_id)
        self._start_facts_fetch("facts_origin", origin_name, boxes["facts_origin"], request_id)
        self._start_facts_fetch("facts_destination", dest_name, boxes["facts_destination"], request_id)
        self._start_weather_fetch("origin", origin, boxes["weather_origin"], request_id)
        self._start_weather_fetch("destination", destination, boxes["weather_destination"], request_id)

    # -- map tile -----------------------------------------------------------------

    def _start_map_fetch(self, origin: dict, destination: dict, geometry, mode: str, box, request_id: int):
        if Image is None or ImageTk is None:
            self._show_tile_error(request_id, "map", box, "Map unavailable")
            return

        lat1, lon1 = origin.get("latitude"), origin.get("longitude")
        lat2, lon2 = destination.get("latitude"), destination.get("longitude")
        if None in (lat1, lon1, lat2, lon2):
            self._show_tile_error(request_id, "map", box, "Map unavailable")
            return

        w = max(64, int(box[2] - box[0]) - 4)
        h = max(64, int(box[3] - box[1]) - 4)

        def fetch():
            try:
                zoom, center_lat, center_lon = map_tiles.zoom_to_fit(lat1, lon1, lat2, lon2, w, h)
                image = map_tiles.fetch_map_tiles(center_lat, center_lon, zoom, w, h)
                points = geometry if len(geometry) >= 2 else [[lat1, lon1], [lat2, lon2]]
                pixels = map_tiles.project_points_to_pixels(points, center_lat, center_lon, zoom, w, h)
            except Exception as error:
                map_tiles.log_map_error(f"route map fetch failed: {error!r}")
                self.root.after(0, lambda: self._show_tile_error(request_id, "map", box, "Map offline"))
                return
            self.root.after(0, lambda: self._apply_map(request_id, image, pixels, mode, box))

        threading.Thread(target=fetch, daemon=True).start()

    def _apply_map(self, request_id: int, image, pixels, mode: str, box):
        if not self.visible or request_id != self._request_id:
            return
        self._clear_tile("map")
        x0, y0, x1, y1 = box
        photo = ImageTk.PhotoImage(image)
        self._map_photo = photo
        img_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, image=photo)
        self._track_tile("map", img_id)

        accent = self.config.get("accentColor", "#38bdf8")
        flat = []
        for px, py in pixels:
            flat.extend([x0 + px, y0 + py])
        if len(flat) >= 4:
            line_kwargs = {"fill": accent, "width": 4, "capstyle": tk.ROUND, "joinstyle": tk.ROUND}
            if mode == "flight":
                line_kwargs["dash"] = (8, 6)
            else:
                line_kwargs["smooth"] = True
            line_id = self.canvas.create_line(*flat, **line_kwargs)
            self._track_tile("map", line_id)

            for index, color in ((0, self.GREEN), (len(pixels) - 1, self.RED)):
                px, py = pixels[index]
                cx, cy = x0 + px, y0 + py
                pin_id = self.canvas.create_oval(
                    cx - self.PIN_RADIUS, cy - self.PIN_RADIUS, cx + self.PIN_RADIUS, cy + self.PIN_RADIUS,
                    fill=color, outline="#0d1524", width=2,
                )
                self._track_tile("map", pin_id)

    # -- place facts -----------------------------------------------------------

    def _start_facts_fetch(self, key: str, name: str, box, request_id: int):
        def fetch():
            result = place_facts.fetch_place_summary(name)
            self.root.after(0, lambda: self._apply_facts(request_id, key, name, result, box))

        threading.Thread(target=fetch, daemon=True).start()

    def _apply_facts(self, request_id: int, key: str, name: str, result: dict | None, box):
        if not self.visible or request_id != self._request_id:
            return
        self._clear_tile(key)
        x0, y0, x1, y1 = box
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]

        header_id = self.canvas.create_text(
            x0 + 14, y0 + 12, anchor="nw", text=name, fill=muted,
            font=self.shell.chip_label_font, width=max(40, (x1 - x0) - 28),
        )
        self._track_tile(key, header_id)
        body_top = y0 + 12 + self.shell.chip_label_font.metrics("linespace") + 8
        body_left = x0 + 14
        body_width = max(60, (x1 - x0) - 28)
        body_height = max(30, (y1 - 10) - body_top)

        if not result or not result.get("extract"):
            text_id = self.canvas.create_text(
                body_left + body_width / 2, body_top + body_height / 2, anchor="center",
                text="No facts available", fill=muted, font=self.shell.forecast_label_font,
                width=body_width, justify=tk.CENTER,
            )
            self._track_tile(key, text_id)
            return

        # Clipped nested-canvas viewport so long facts scroll in place
        # (pause / scroll / pause, looping indefinitely) instead of
        # overflowing the card and overlapping the tile below it.
        viewport = tk.Canvas(
            self.root, width=max(1, int(body_width)), height=max(1, int(body_height)),
            highlightthickness=0, bd=0, bg=self.CARD,
        )
        text_id = viewport.create_text(
            body_width / 2, 0, anchor="n", text="", fill=text,
            font=self.shell.body_font, width=body_width, justify=tk.CENTER,
        )
        scroller = MessageScrollController(viewport, text_id, self.config, self.root, on_finish=lambda: None)
        needs_scroll = scroller.configure(
            result["extract"], center_x=body_width / 2, viewport_height=body_height,
        )
        if needs_scroll:
            scroller.start()
        self._fact_scrollers[key] = scroller
        self._fact_widgets[key] = viewport
        self._place_widget(viewport, x=body_left, y=body_top)

    # -- weather + local times ---------------------------------------------------

    def _start_weather_fetch(self, key: str, location: dict, box, request_id: int):
        lat, lon = location.get("latitude"), location.get("longitude")

        def fetch():
            weather = None
            if lat is not None and lon is not None:
                try:
                    weather = weather_fetch.fetch_weather_forecast({"latitude": lat, "longitude": lon})
                except Exception as error:
                    print(f"Route planner weather fetch failed: {error}", file=sys.stderr, flush=True)
            self.root.after(0, lambda: self._apply_weather(request_id, key, weather, box))

        threading.Thread(target=fetch, daemon=True).start()

    def _apply_weather(self, request_id: int, key: str, weather: dict | None, box):
        if not self.visible or request_id != self._request_id:
            return
        self._weather_snapshots[key] = weather
        self._weather_done[key] = True

        tile_key = f"weather_{key}"
        self._clear_tile(tile_key)
        x0, y0, x1, y1 = box
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        current = (weather or {}).get("current") or {}
        temp_f = current.get("temperatureF")

        if temp_f is None:
            text_id = self.canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, anchor="center", text="Weather unavailable", fill=muted,
                font=self.shell.forecast_label_font, width=max(60, (x1 - x0) - 24), justify=tk.CENTER,
            )
            self._track_tile(tile_key, text_id)
        else:
            condition = normalize_condition(current.get("condition"))
            icon_cx = x0 + 34
            icon_cy = (y0 + y1) / 2 + 8
            WeatherPanel._draw_condition_icon(self, icon_cx, icon_cy, 40, condition)
            temp_id = self.canvas.create_text(
                x0 + 64, icon_cy - 12, anchor="w", text=f"{round(temp_f)}\u00b0F",
                fill=text, font=self.shell.chip_value_font,
            )
            self._track_tile(tile_key, temp_id)
            label = WeatherPanel.CONDITION_LABELS.get(condition, condition.title())
            label_id = self.canvas.create_text(
                x0 + 64, icon_cy + 16, anchor="w", text=label, fill=muted, font=self.shell.forecast_label_font,
            )
            self._track_tile(tile_key, label_id)

        if self._weather_done.get("origin") and self._weather_done.get("destination"):
            self._render_time_strip(request_id)

    def _render_time_strip(self, request_id: int):
        if not self.visible or request_id != self._request_id:
            return
        box = self._tile_boxes.get("time")
        if not box:
            return
        self._clear_tile("time")
        x0, y0, x1, y1 = box
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]

        origin_offset = (self._weather_snapshots.get("origin") or {}).get("utcOffsetSeconds")
        dest_offset = (self._weather_snapshots.get("destination") or {}).get("utcOffsetSeconds")

        if origin_offset is None or dest_offset is None:
            text_id = self.canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, anchor="center", text="Local times unavailable", fill=muted,
                font=self.shell.forecast_label_font,
            )
            self._track_tile("time", text_id)
            return

        entries = (
            ("Now (origin)", format_local_time_at_offset(origin_offset)),
            ("Now (destination)", format_local_time_at_offset(dest_offset)),
            ("Est. arrival", format_local_time_at_offset(dest_offset, self._duration_min)),
        )
        col_w = (x1 - x0) / 3
        label_h = self.shell.chip_label_font.metrics("linespace")
        value_h = self.shell.chip_value_font.metrics("linespace")
        block_top = (y0 + y1) / 2 - (label_h + value_h + 6) / 2
        for index, (label, value) in enumerate(entries):
            cx = x0 + col_w * index + col_w / 2
            label_id = self.canvas.create_text(
                cx, block_top, anchor="n", text=label, fill=muted, font=self.shell.chip_label_font,
            )
            value_id = self.canvas.create_text(
                cx, block_top + label_h + 6, anchor="n", text=value, fill=text, font=self.shell.chip_value_font,
            )
            self._track_tile("time", label_id)
            self._track_tile("time", value_id)
