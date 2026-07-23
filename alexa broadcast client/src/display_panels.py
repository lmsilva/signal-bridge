import io
import math
import re
import sys
import threading
import time
import tkinter as tk
import urllib.request
from datetime import datetime, timezone
from tkinter import font as tkfont

try:
    from PIL import Image, ImageTk
except ImportError:  # Pillow ships with the client, but degrade gracefully.
    Image = None
    ImageTk = None

from src.message_scroll import MessageScrollController
from src.paths import asset_path
from src.payload_utils import (
    battery_level_color,
    format_battery_percent,
    format_chip_timestamp,
    format_duration,
    format_indoor_location,
    format_timer_clock,
    format_timer_set_label,
    format_alarm_time,
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

    # Shared dark "mission control" palette used by all panels.
    GREEN = "#4ade80"
    GREEN_BG = "#123524"
    AMBER = "#f59e0b"
    AMBER_BG = "#3a2605"
    RED = "#ef4444"
    RED_BG = "#3f1220"
    CONTAINER = "#0d1524"
    CARD = "#101b2d"
    CARD_EDGE = "#1d2a40"
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

    def _round_rect(self, x0, y0, x1, y1, *, radius=14, fill="", outline="", width=1, dash=None):
        radius = max(2, min(int(radius), int(x1 - x0) // 2, int(y1 - y0) // 2))
        points = [
            x0 + radius, y0, x1 - radius, y0, x1, y0, x1, y0 + radius,
            x1, y1 - radius, x1, y1, x1 - radius, y1, x0 + radius, y1,
            x0, y1, x0, y1 - radius, x0, y0 + radius, x0, y0,
        ]
        kwargs = {"smooth": True, "fill": fill, "outline": outline, "width": width}
        if dash:
            kwargs["dash"] = dash
        return self._track(self.canvas.create_polygon(points, **kwargs))

    def _panel_card(self, x, y, w, h, *, radius=18, fill=None, outline=None, dash=None):
        return self._round_rect(
            x, y, x + w, y + h,
            radius=radius,
            fill=self.CARD if fill is None else fill,
            outline=self.CARD_EDGE if outline is None else outline,
            dash=dash,
        )

    def _container_frame(self, x, y, w, h, *, pad=20, radius=26):
        """Large rounded backdrop that frames the whole panel."""
        return self._round_rect(
            x - pad, y - 14, x + w + pad, y + h + 12,
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
        self._round_rect(x0, y, x0 + w, y + h, radius=h // 2, fill=fill, outline=outline or fill)
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
    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self.needs_scroll = False
        self.scroller = None
        self.chip_value_ids = []
        self._build_viewport()

    def _build_viewport(self):
        layout = self.shell.layout
        self.message_viewport = tk.Canvas(
            self.root,
            width=layout.message_content_width,
            height=layout.message_viewport_height,
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
                radius=16,
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
            viewport_height=layout.message_viewport_height,
        )
        self._place_widget(
            self.message_viewport,
            x=layout.content_x + 24,
            y=layout.message_area_top,
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

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")

        location = payload.get("location") or {}
        weather = payload.get("weather") or {}
        current = weather.get("current") or {}
        hourly = weather.get("next24Hours") or []
        daily = weather.get("next7Days") or []
        spoken = payload.get("spokenResponse") or ""
        spoken_bits = parse_spoken_weather(spoken)
        location_name = format_weather_location(location)

        self._track(
            self.canvas.create_text(
                x + width // 2,
                y,
                anchor="n",
                text=location_name,
                fill=text,
                font=self.shell.section_title_font,
            )
        )
        y += 42

        # Alexa's spoken current temperature is what the user just heard — it
        # wins over the Open-Meteo model value for the hero number. Spoken
        # numbers that may be forecast highs/lows are only a last resort.
        temp_f = spoken_bits.get("temp_f") if spoken_bits.get("temp_is_current") else None
        if temp_f is None:
            temp_f = current.get("temperatureF")
        if temp_f is None:
            temp_f = spoken_bits.get("temp_f")
        temp_c = round((temp_f - 32) * 5 / 9) if temp_f is not None else None

        condition = normalize_condition(current.get("condition") or spoken_bits.get("condition"))
        if condition == "unknown" and spoken_bits.get("condition"):
            condition = normalize_condition(spoken_bits.get("condition"))

        icon_x = x + 72
        icon_y = y + 54
        self._draw_condition_icon(icon_x, icon_y, 54, condition)

        if temp_f is not None:
            temp_line = f"{round(temp_f)}°F"
            condition_label = self.CONDITION_LABELS.get(condition, condition.title())
            sub_line = f"{temp_c}°C · {condition_label}" if condition_label else f"{temp_c}°C"
        else:
            temp_line = "—"
            sub_line = spoken_bits.get("summary") or "Forecast unavailable"

        self._track(
            self.canvas.create_text(
                x + 130,
                y + 18,
                anchor="nw",
                text=temp_line,
                fill=text,
                font=self.shell.hero_font,
            )
        )
        self._track(
            self.canvas.create_text(
                x + 130,
                y + 88,
                anchor="nw",
                text=sub_line,
                fill=muted,
                font=self.shell.body_font,
                width=max(240, width - 150),
            )
        )

        wind = current.get("windSpeedMph")
        rain = hourly[0].get("precipitationProbability") if hourly else None
        humidity = current.get("humidity")
        feels_like = current.get("feelsLikeF")
        detail_parts = []
        if feels_like is not None and temp_f is not None and abs(feels_like - temp_f) >= 3:
            detail_parts.append(f"Feels like {round(feels_like)}°")
        if wind is not None:
            detail_parts.append(f"Wind {round(wind)} mph")
        if rain is not None:
            detail_parts.append(f"Rain {rain}%")
        if humidity is not None:
            detail_parts.append(f"Humidity {humidity}%")
        if detail_parts:
            detail_y = y + 136
            self._track(
                self.canvas.create_text(
                    x + 130,
                    detail_y,
                    anchor="nw",
                    text=" · ".join(detail_parts),
                    fill=accent,
                    font=self.shell.chip_value_font,
                )
            )
            y = detail_y + self.shell.chip_value_font.metrics("linespace") + 40
        else:
            y += 148

        slot_height, day_height = self._fit_forecast_heights(layout, y, bool(hourly), bool(daily))

        self._track(
            self.canvas.create_text(
                x,
                y,
                anchor="nw",
                text="Next 24 hours",
                fill=text,
                font=self.shell.section_label_font,
            )
        )
        y += self.shell.section_label_font.metrics("linespace") + 16

        icon_box = 22
        if hourly:
            slot_count = min(8, max(4, width // 90))
            # Sample the FULL 24h window: first tile is "Now", the rest are
            # spread evenly so the last tile lands ~24h out (not just the
            # next few hours).
            picks = sample_hourly_indices(len(hourly), slot_count)
            slot_width = width // len(picks)
            for index, hour_index in enumerate(picks):
                slot = hourly[hour_index]
                slot_x = x + index * slot_width
                inner_w = slot_width - 10
                center_x = slot_x + inner_w // 2
                is_now = hour_index == 0
                label = "Now" if is_now else "—"
                if not is_now and slot.get("time"):
                    try:
                        # Times are already in the forecast location's local
                        # time — format directly, no timezone shifting.
                        label = (
                            datetime.fromisoformat(slot["time"].replace("Z", "+00:00"))
                            .strftime("%I%p")
                            .lstrip("0")
                        )
                    except ValueError:
                        label = slot["time"][-5:]
                temp = slot.get("temperatureF")
                rain_chance = slot.get("precipitationProbability")
                self._round_rect(
                    slot_x,
                    y,
                    slot_x + inner_w,
                    y + slot_height,
                    radius=14,
                    fill=self.CARD,
                    outline=accent if is_now else self.CARD_EDGE,
                    width=2 if is_now else 1,
                )
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 4,
                        anchor="n",
                        text=label,
                        fill=accent if is_now else muted,
                        font=self.shell.forecast_label_font,
                    )
                )
                icon_center_y = y + 20 + icon_box / 2
                self._draw_condition_icon(center_x, icon_center_y, icon_box, slot.get("condition", "unknown"))
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 20 + icon_box + 10,
                        anchor="n",
                        text=f"{temp}°" if temp is not None else "—",
                        fill=text,
                        font=self.shell.forecast_value_font,
                    )
                )
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + slot_height - 8,
                        anchor="s",
                        text=f"{rain_chance}%" if rain_chance is not None else "",
                        fill=accent,
                        font=self.shell.forecast_detail_font,
                    )
                )
        else:
            self._track(
                self.canvas.create_text(
                    x,
                    y + 24,
                    anchor="nw",
                    text="Hourly forecast unavailable",
                    fill=muted,
                    font=self.shell.body_font,
                )
            )

        y += slot_height + 22 if hourly else 96
        self._track(
            self.canvas.create_text(
                x,
                y,
                anchor="nw",
                text="7-day forecast",
                fill=text,
                font=self.shell.section_label_font,
            )
        )
        # Same header-to-tile spacing as the "Next 24 hours" section.
        y += self.shell.section_label_font.metrics("linespace") + 16

        if daily:
            day_count = min(7, max(5, width // 100))
            day_width = width // day_count
            for index, day in enumerate(daily[:day_count]):
                day_x = x + index * day_width
                inner_w = day_width - 10
                center_x = day_x + inner_w // 2
                is_today = index == 0
                label = "Today" if is_today else day.get("date", "")[-5:]
                if not is_today and day.get("date"):
                    try:
                        label = datetime.fromisoformat(day["date"]).strftime("%a")
                    except ValueError:
                        pass
                high = day.get("highF")
                low = day.get("lowF")
                rain_chance = day.get("precipitationProbability")
                self._round_rect(
                    day_x,
                    y,
                    day_x + inner_w,
                    y + day_height,
                    radius=14,
                    fill=self.CARD,
                    outline=accent if is_today else self.CARD_EDGE,
                    width=2 if is_today else 1,
                )
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 4,
                        anchor="n",
                        text=label,
                        fill=accent if is_today else muted,
                        font=self.shell.forecast_label_font,
                    )
                )
                day_icon_y = y + 20 + icon_box / 2
                self._draw_condition_icon(center_x, day_icon_y, icon_box, day.get("condition", "unknown"))
                high_low = "—"
                if high is not None and low is not None:
                    high_low = f"{high}° / {low}°"
                elif high is not None:
                    high_low = f"{high}°"
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 20 + icon_box + 10,
                        anchor="n",
                        text=high_low,
                        fill=text,
                        font=self.shell.forecast_value_font,
                    )
                )
                if rain_chance is not None:
                    self._track(
                        self.canvas.create_text(
                            center_x,
                            y + day_height - 8,
                            anchor="s",
                            text=f"Rain {rain_chance}%",
                            fill=accent,
                            font=self.shell.forecast_detail_font,
                        )
                    )
        else:
            self._track(
                self.canvas.create_text(
                    x,
                    y,
                    anchor="nw",
                    text="Daily forecast unavailable",
                    fill=muted,
                    font=self.shell.body_font,
                )
            )

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
    BAND_COLORS = {
        "good": "#2dd4bf",
        "fair": "#84cc16",
        "moderate": "#fbbf24",
        "poor": "#f97316",
        "unknown": "#64748b",
    }

    METRICS = (
        ("temperatureF", "Temp", "°F"),
        ("humidity", "Humidity", "%"),
        ("pm25", "PM 2.5", "µg/m³"),
        ("co", "CO", "ppm"),
        ("voc", "VOCs", ""),
    )

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        chip = self.config.get("chipBackground", "#141a24")
        center_x = x + width // 2

        location = payload.get("location") or {}
        reading = payload.get("reading") or {}
        spoken = payload.get("spokenResponse") or ""
        monitors = list(payload.get("monitors") or reading.get("monitors") or [])
        spoken_bits = parse_spoken_air_quality(spoken)
        air_config = self.config.get("airQuality") or {}

        iaq_score = reading.get("iaqScore")
        if iaq_score is None and spoken_bits.get("iaq_score") is not None:
            iaq_score = spoken_bits["iaq_score"]

        band = reading.get("band") or spoken_bits.get("band") or air_quality_band(
            iaq_score,
            good_min=air_config.get("goodMin", 80),
            fair_min=air_config.get("fairMin", 60),
            moderate_min=air_config.get("moderateMin", 40),
        )
        if band == "unknown":
            qualitative = parse_qualitative_air_quality_band(spoken)
            if qualitative:
                band = qualitative
        band_color = self.BAND_COLORS.get(band, self.BAND_COLORS["unknown"])
        location_name = format_air_quality_location(location)

        values = {
            "temperatureF": reading.get("temperatureF") if reading.get("temperatureF") is not None else spoken_bits.get("temperature_f"),
            "humidity": reading.get("humidity") if reading.get("humidity") is not None else spoken_bits.get("humidity"),
            "pm25": reading.get("pm25") if reading.get("pm25") is not None else spoken_bits.get("pm25"),
            "co": reading.get("co") if reading.get("co") is not None else spoken_bits.get("co"),
            "voc": reading.get("voc") if reading.get("voc") is not None else spoken_bits.get("voc"),
        }
        self._merge_monitor_metric_values(values, monitors)

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

        area_top = y + self.shell.section_title_font.metrics("linespace") + 24
        stat_row_h = 78
        stat_gap = 24
        available_metrics = [
            (key, label, unit)
            for key, label, unit in self.METRICS
            if values.get(key) is not None
        ]
        monitor_rows = min(len(monitors), 4)
        metrics_h = (stat_gap + stat_row_h) if available_metrics else 0
        monitors_h = monitor_rows * 64 if monitor_rows else 0
        hero_h = 220
        content_h = hero_h + metrics_h + (18 if metrics_h and monitors_h else 0) + monitors_h
        block_top = area_top + max(0, (bottom - area_top - content_h) // 2)

        hero_bottom = self._draw_iaq_hero(
            center_x,
            block_top,
            iaq_score,
            band,
            band_color,
            text,
            muted,
            chip,
        )

        cursor = hero_bottom + stat_gap
        if available_metrics:
            cursor = self._draw_air_quality_metrics(
                x,
                width,
                cursor,
                available_metrics,
                values,
                stat_row_h,
                chip=chip,
                text=text,
                muted=muted,
            ) + stat_gap

        if monitors:
            self._draw_monitor_rows(
                x,
                width,
                cursor,
                bottom - 48,
                monitors,
                chip=chip,
                text=text,
                muted=muted,
            )

        if iaq_score is None:
            summary = spoken_bits.get("summary") or reading.get("summary")
            if summary and not monitors:
                self._track(
                    self.canvas.create_text(
                        center_x,
                        bottom - 8,
                        anchor="s",
                        text=summary,
                        fill=muted,
                        font=self.shell.chip_label_font,
                        width=max(280, width - 80),
                        justify="center",
                    )
                )
            elif summary and monitors:
                self._track(
                    self.canvas.create_text(
                        center_x,
                        bottom - 8,
                        anchor="s",
                        text=summary if len(summary) <= 120 else f"{summary[:117].rstrip()}…",
                        fill=muted,
                        font=self.shell.chip_label_font,
                        width=max(280, width - 80),
                        justify="center",
                    )
                )

    def _merge_monitor_metric_values(self, values: dict, monitors: list[dict]) -> None:
        for monitor in monitors:
            monitor_reading = monitor.get("reading")
            if not isinstance(monitor_reading, dict):
                continue
            for key in ("temperatureF", "humidity", "pm25", "co", "voc"):
                if values.get(key) is None and monitor_reading.get(key) is not None:
                    values[key] = monitor_reading.get(key)

    def _draw_air_quality_metrics(
        self,
        x: float,
        width: float,
        y: float,
        available_metrics: list[tuple[str, str, str]],
        values: dict,
        stat_row_h: float,
        *,
        chip: str,
        text: str,
        muted: str,
    ) -> float:
        col_count = len(available_metrics)
        col_gap = 10
        col_w = max(110, (width - col_gap * (col_count - 1)) // col_count)
        grid_w = col_count * col_w + (col_count - 1) * col_gap
        stat_x = x + max(0, (width - grid_w) // 2)

        for index, (key, label, unit) in enumerate(available_metrics):
            tile_x = stat_x + index * (col_w + col_gap)
            value = values.get(key)
            if key == "voc":
                band_word = voc_band_label(value)
                value_text = band_word or "—"
            else:
                value_text = self._format_metric_value(value, unit)
            self._draw_air_quality_stat(
                tile_x,
                y,
                col_w,
                stat_row_h,
                label,
                value_text,
                chip=chip,
                text=text,
                muted=muted,
                value_color=text,
            )

        return y + stat_row_h

    def _draw_monitor_rows(
        self,
        x: float,
        width: float,
        y: float,
        bottom: float,
        monitors: list[dict],
        *,
        chip: str,
        text: str,
        muted: str,
    ) -> float:
        cursor = y
        row_h = 54
        gap = 10
        card_x = x + 4
        card_w = width - 8

        for monitor in monitors[:4]:
            if cursor + row_h > bottom:
                break

            label = str(monitor.get("label") or "Monitor")
            score = monitor.get("iaqScore")
            if score is None and isinstance(monitor.get("reading"), dict):
                score = monitor["reading"].get("iaqScore")
            band = str(monitor.get("band") or "unknown")
            band_color = self.BAND_COLORS.get(band, self.BAND_COLORS["unknown"])
            status = air_quality_band_label(band)
            if score is not None:
                status = f"{status} · {int(float(score))}"

            self._round_rect(
                card_x,
                cursor,
                card_x + card_w,
                cursor + row_h,
                radius=14,
                fill=self.CARD,
                outline=band_color,
                width=2,
            )
            self._round_rect(
                card_x + 8,
                cursor + 10,
                card_x + 14,
                cursor + row_h - 10,
                radius=3,
                fill=band_color,
            )
            self._track(
                self.canvas.create_text(
                    card_x + 26,
                    cursor + row_h / 2,
                    anchor="w",
                    text=label,
                    fill=text,
                    font=self.shell.section_label_font,
                )
            )
            self._track(
                self.canvas.create_text(
                    card_x + card_w - 16,
                    cursor + row_h / 2,
                    anchor="e",
                    text=status,
                    fill=band_color,
                    font=self.shell.body_font,
                )
            )
            cursor += row_h + gap

        return cursor

    def _draw_air_quality_stat(
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
        value_color: str,
    ):
        self._round_rect(
            x,
            y,
            x + width,
            y + height,
            radius=14,
            fill=self.CARD,
            outline=self.CARD_EDGE,
        )
        self._track(
            self.canvas.create_text(
                x + width / 2,
                y + 12,
                anchor="n",
                text=label,
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                x + width / 2,
                y + height - 16,
                anchor="s",
                text=value,
                fill=value_color,
                font=self.shell.chip_value_font,
            )
        )

    def _format_metric_value(self, value: int | float | None, unit: str) -> str:
        if value is None:
            return "—"
        if unit == "°F":
            return format_temperature_f(value)
        if isinstance(value, float) and not float(value).is_integer():
            return f"{value:g}{unit}"
        return f"{int(float(value))}{unit}"

    def _draw_iaq_hero(
        self,
        center_x: float,
        y: float,
        score: int | float | None,
        band: str,
        band_color: str,
        text: str,
        muted: str,
        chip: str,
    ) -> float:
        radius = 52
        cy = y + radius + 4
        self._track(
            self.canvas.create_oval(
                center_x - radius,
                cy - radius,
                center_x + radius,
                cy + radius,
                fill=band_color,
                outline=band_color,
                width=2,
            )
        )
        if score is not None:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cy - 4,
                    anchor="center",
                    text=str(int(float(score))),
                    fill=self.config["overlayBackground"],
                    font=self.shell.digital_time_font,
                )
            )
        else:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cy,
                    anchor="center",
                    text="—",
                    fill=self.config["overlayBackground"],
                    font=self.shell.hero_font,
                )
            )

        label_y = cy + radius + 14
        self._track(
            self.canvas.create_text(
                center_x,
                label_y,
                anchor="n",
                text=air_quality_band_label(band),
                fill=text,
                font=self.shell.body_font,
            )
        )
        indoor_label_y = label_y + self.shell.body_font.metrics("linespace") + 8
        self._track(
            self.canvas.create_text(
                center_x,
                indoor_label_y,
                anchor="n",
                text="Indoor Air Quality",
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )

        scale_y = indoor_label_y + self.shell.chip_label_font.metrics("linespace") + 16
        scale_w = min(320, radius * 2 + 80)
        scale_x = center_x - scale_w / 2
        self._draw_scale_bar(scale_x, scale_y, scale_w, score, 0, 100, (100, 65, 35, 0), chip, band_color, muted, invert=True)
        tick_y = scale_y + 14
        for tick in (100, 65, 35, 0):
            tick_x = scale_x + self._scale_position(tick, 0, 100, scale_w, invert=True)
            self._track(
                self.canvas.create_text(
                    tick_x,
                    tick_y,
                    anchor="n",
                    text=str(tick),
                    fill=muted,
                    font=self.shell.forecast_detail_font,
                )
            )
        return tick_y + self.shell.forecast_detail_font.metrics("linespace") + 8

    def _scale_position(self, value: float, scale_min: float, scale_max: float, width: float, *, invert: bool = False) -> float:
        if scale_max <= scale_min:
            return 0.0
        ratio = max(0.0, min(1.0, (float(value) - scale_min) / (scale_max - scale_min)))
        if invert:
            ratio = 1.0 - ratio
        return ratio * width

    def _draw_scale_bar(
        self,
        x: float,
        y: float,
        width: float,
        value: int | float | None,
        scale_min: float,
        scale_max: float,
        ticks: tuple[int | float, ...],
        track: str,
        fill: str,
        muted: str,
        *,
        invert: bool = False,
    ):
        height = 8
        self._round_rect(
            x,
            y,
            x + width,
            y + height,
            radius=height // 2,
            fill=track,
        )
        if value is not None:
            marker_x = x + self._scale_position(value, scale_min, scale_max, width, invert=invert)
            if marker_x - x > height:
                self._round_rect(
                    x,
                    y,
                    marker_x,
                    y + height,
                    radius=height // 2,
                    fill=fill,
                )
            self._track(
                self.canvas.create_oval(
                    marker_x - 6,
                    y - 2,
                    marker_x + 6,
                    y + height + 2,
                    fill=fill,
                    outline="",
                )
            )
        for tick in ticks:
            tick_x = x + self._scale_position(tick, scale_min, scale_max, width, invert=invert)
            self._track(
                self.canvas.create_line(
                    tick_x,
                    y - 2,
                    tick_x,
                    y + height + 2,
                    fill=muted,
                    width=1,
                )
            )

    def _draw_metric_row(
        self,
        x: float,
        y: float,
        width: float,
        label: str,
        value: int | float | None,
        scale_min: float,
        scale_max: float,
        ticks: tuple[int | float, ...],
        track: str,
        text: str,
        muted: str,
        fill: str,
    ):
        value_text = "—"
        if value is not None:
            if isinstance(value, float) and not float(value).is_integer():
                value_text = f"{value:g}"
            else:
                value_text = str(int(float(value)))

        self._track(
            self.canvas.create_text(
                x,
                y,
                anchor="nw",
                text=label,
                fill=text,
                font=self.shell.chip_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                x + width,
                y,
                anchor="ne",
                text=value_text,
                fill=fill if value is not None else text,
                font=self.shell.chip_value_font,
            )
        )
        bar_y = y + self.shell.chip_label_font.metrics("linespace") + 8
        self._draw_scale_bar(x, bar_y, width, value, scale_min, scale_max, ticks, track, fill, muted)


class TimerPanel(BasePanel):
    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._countdown_items: list[int] = []
        self._countdown_suffix_items: list[int] = []
        self._deadlines: list[float | None] = []
        self._is_fired = False
        self._payload: dict | None = None
        self._timers: list[dict] = []
        self._local_fire_triggered = False
        self._on_local_fire = None

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
        self._countdown_suffix_items.clear()
        self._deadlines.clear()
        self._is_fired = False
        self._payload = None
        self._timers.clear()
        self._local_fire_triggered = False

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

    def _update_countdowns(self):
        expired_index = None
        for index, deadline in enumerate(self._deadlines):
            if index >= len(self._countdown_items):
                continue
            remaining_id = self._countdown_items[index]
            suffix_id = self._countdown_suffix_items[index] if index < len(self._countdown_suffix_items) else None
            if deadline is None:
                continue
            remaining = max(0, int(math.ceil(deadline - time.time())))
            self.canvas.itemconfigure(remaining_id, text=format_timer_clock(remaining))
            if suffix_id is not None:
                suffix = "Finished!" if remaining == 0 else "left"
                self.canvas.itemconfigure(suffix_id, text=suffix)
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

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        alert = self.config.get("alertColor", "#f97316")
        chip_fill = self.config.get("chipBackground", "#141a24")

        timers = list(payload.get("timers") or [])
        event = payload.get("event") or {}
        event_kind = event.get("kind", "list")
        self._is_fired = event_kind == "fired"

        if self._is_fired and not timers and event.get("timer"):
            timers = [event["timer"]]

        fired_timer = timers[0] if self._is_fired and timers else None
        if self._is_fired:
            label = timer_label_name(fired_timer)
            device = self._format_device_name((fired_timer or {}).get("device"))
            duration_sec = (fired_timer or {}).get("durationSec")
            if label:
                headline = f'"{label}" timer finished!'
            elif duration_sec is not None:
                headline = f"{format_timer_set_label(duration_sec)} finished!"
            else:
                headline = "Timer finished!"
            headline_color = alert
            headline_font = self.shell.timer_alert_font
        else:
            headline = {
                "started": "Timer started",
                "updated": "Timer updated",
                "cancelled": "Timer cancelled",
                "paused": "Timer paused",
                "resumed": "Timer resumed",
                "list": "Active timers",
            }.get(event_kind, "Active timers")
            headline_color = text
            headline_font = self.shell.section_title_font

        self._track(
            self.canvas.create_text(
                x + width // 2,
                y,
                anchor="n",
                text=headline,
                fill=headline_color,
                font=headline_font,
            )
        )
        y += 64 if self._is_fired else 68

        if self._is_fired and fired_timer:
            summary = timer_detail_line(
                fired_timer,
                self._format_device_name(fired_timer.get("device")),
                finished=True,
            )
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    y,
                    anchor="n",
                    text=summary,
                    fill=text,
                    font=self.shell.body_font,
                )
            )
            y += 34

        if not timers:
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    y + 40,
                    anchor="n",
                    text="No active timers",
                    fill=muted,
                    font=self.shell.body_font,
                )
            )
            return

        row_height = 112 if self._is_fired else 96
        for index, timer in enumerate(timers):
            row_y = y + index * (row_height + 14)
            row_fill = "#2a1808" if self._is_fired else self.CARD
            outline = alert if self._is_fired else self.CARD_EDGE
            outline_width = 3 if self._is_fired else 1
            self._round_rect(
                x,
                row_y,
                x + width,
                row_y + row_height,
                radius=18,
                fill=row_fill,
                outline=outline,
                width=outline_width,
            )

            label = timer_label_name(timer)
            device = self._format_device_name(timer.get("device"))
            duration_sec = timer.get("durationSec")
            status = timer.get("status", "ON")
            row_center_y = row_y + row_height // 2

            title = timer_title(timer)
            title_font = self.shell.section_label_font if label else self.shell.body_font
            subtitle = timer_detail_line(timer, device, finished=self._is_fired)
            if status == "PAUSED" and not self._is_fired:
                subtitle = f"{subtitle} · Paused"

            set_time = format_timer_clock(duration_sec) if duration_sec is not None else None
            deadline = self._deadline_for_timer(timer)
            if self._is_fired:
                deadline = time.time()
            remaining = max(0, int(math.ceil((deadline or time.time()) - time.time())))
            remaining_text = format_timer_clock(remaining)

            self._deadlines.append(deadline)
            remaining_font = self.shell.timer_alert_font if self._is_fired else self.shell.timer_remaining_font
            remaining_color = alert if self._is_fired else accent

            self._track(
                self.canvas.create_text(
                    x + 24,
                    row_center_y - 16,
                    anchor="w",
                    text=title,
                    fill=alert if self._is_fired and label else text,
                    font=title_font if not self._is_fired or not label else self.shell.section_title_font,
                )
            )
            self._track(
                self.canvas.create_text(
                    x + 24,
                    row_center_y + 18,
                    anchor="w",
                    text=subtitle,
                    fill=muted,
                    font=self.shell.timer_meta_font,
                )
            )

            if set_time and not self._is_fired:
                self._track(
                    self.canvas.create_text(
                        x + width - 24,
                        row_center_y - 22,
                        anchor="e",
                        text=set_time,
                        fill=muted,
                        font=self.shell.timer_meta_font,
                    )
                )

            remaining_id = self._track(
                self.canvas.create_text(
                    x + width - 24,
                    row_center_y + (6 if self._is_fired else 2),
                    anchor="e",
                    text=remaining_text,
                    fill=remaining_color,
                    font=remaining_font,
                )
            )
            suffix_id = self._track(
                self.canvas.create_text(
                    x + width - 24,
                    row_center_y + (38 if self._is_fired else 28),
                    anchor="e",
                    text="Finished!" if self._is_fired else "left",
                    fill=alert if self._is_fired else muted,
                    font=self.shell.timer_meta_font if self._is_fired else self.shell.forecast_label_font,
                )
            )
            self._countdown_items.append(remaining_id)
            self._countdown_suffix_items.append(suffix_id)

    @staticmethod
    def _format_device_name(device: str | None) -> str:
        if not device:
            return "Unknown device"
        if len(device) >= 12 and device.isalnum() and device.upper() == device:
            return "Echo device"
        return device


class AlarmPanel(BasePanel):
    ROW_HEIGHT = 96
    ROW_GAP = 14
    ACCENT_WIDTH = 4

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        chip_fill = self.config.get("chipBackground", "#141a24")

        alarms = list(payload.get("alarms") or [])
        event = payload.get("event") or {}
        event_kind = event.get("kind", "list")

        headline = {
            "started": "Alarm set",
            "cancelled": "Alarm cancelled",
            "list": "Active alarms",
        }.get(event_kind, "Active alarms")

        self._track(
            self.canvas.create_text(
                x + width // 2,
                y,
                anchor="n",
                text=headline,
                fill=text,
                font=self.shell.section_title_font,
            )
        )
        y += 68

        if not alarms:
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    y + 40,
                    anchor="n",
                    text="No active alarms",
                    fill=muted,
                    font=self.shell.body_font,
                )
            )
            return

        for index, alarm in enumerate(alarms):
            row_y = y + index * (self.ROW_HEIGHT + self.ROW_GAP)
            is_new = bool(alarm.get("isNew"))
            row_outline = accent if is_new else self.CARD_EDGE
            outline_width = 2 if is_new else 1

            self._round_rect(
                x,
                row_y,
                x + width,
                row_y + self.ROW_HEIGHT,
                radius=16,
                fill=self.CARD,
                outline=row_outline,
                width=outline_width,
            )
            self._round_rect(
                x + 8,
                row_y + 10,
                x + 8 + self.ACCENT_WIDTH,
                row_y + self.ROW_HEIGHT - 10,
                radius=self.ACCENT_WIDTH // 2,
                fill=accent if is_new else muted,
            )

            device = self._format_device_name(alarm.get("device"))
            row_center_y = row_y + self.ROW_HEIGHT // 2
            title = alarm_title(alarm)
            subtitle = alarm_detail_line(alarm, device)
            time_text = format_alarm_time(resolve_alarm_trigger_time(alarm))
            until_text = alarm_until_line(alarm)

            self._track(
                self.canvas.create_text(
                    x + 24,
                    row_center_y - 16,
                    anchor="w",
                    text=title,
                    fill=accent if is_new else text,
                    font=self.shell.section_label_font,
                )
            )
            self._track(
                self.canvas.create_text(
                    x + 24,
                    row_center_y + 18,
                    anchor="w",
                    text=subtitle,
                    fill=muted,
                    font=self.shell.timer_meta_font,
                )
            )
            self._track(
                self.canvas.create_text(
                    x + width - 24,
                    row_center_y - 18,
                    anchor="e",
                    text=time_text,
                    fill=accent if is_new else text,
                    font=self.shell.timer_remaining_font,
                )
            )
            if until_text:
                self._track(
                    self.canvas.create_text(
                        x + width - 24,
                        row_center_y + 16,
                        anchor="e",
                        text=until_text,
                        fill=muted,
                        font=self.shell.forecast_label_font,
                    )
                )
            if is_new:
                self._track(
                    self.canvas.create_text(
                        x + width - 24,
                        row_y + 12,
                        anchor="ne",
                        text="NEW",
                        fill=accent,
                        font=self.shell.forecast_label_font,
                    )
                )

    @staticmethod
    def _format_device_name(device: str | None) -> str:
        if not device:
            return "Unknown device"
        if len(device) >= 12 and device.isalnum() and device.upper() == device:
            return "Echo device"
        return device


class ShoppingListPanel(BasePanel):
    PAGE_SECONDS = 15
    ROW_GAP = 6
    CARD_INSET = 0
    ACCENT_WIDTH = 4
    TEXT_PAD_X = 18

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._tick_job = None
        self._items: list[dict] = []
        self._page = 0
        self._page_size = 8
        self._added_item = None

    def show(self, payload: dict):
        self.hide()
        self.visible = True
        self._items = list(payload.get("items") or [])
        self._added_item = (payload.get("addedItem") or "").strip().lower() or None
        self._page = 0
        self._page_size = self._compute_page_size()
        self._render_page()
        if self._page_count() > 1:
            self._tick_job = self.root.after(self.PAGE_SECONDS * 1000, self._next_page)

    def hide(self):
        super().hide()
        self._items = []
        self._page = 0

    def _item_font(self):
        return self.shell.body_font

    def _compute_page_size(self) -> int:
        layout = self.shell.layout
        header = self.shell.section_title_font.metrics("linespace") + 28
        dots_reserve = 40
        row_block = self._row_height() + self.ROW_GAP
        available = layout.message_area_bottom - layout.message_area_top - header - dots_reserve
        return max(3, available // row_block)

    def _row_height(self) -> int:
        return self._item_font().metrics("linespace") + 14

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
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        chip = self.config.get("chipBackground", "#141a24")

        count = len(self._items)
        header = f"{count} item{'s' if count != 1 else ''}" if count else "List is empty"
        self._track(
            self.canvas.create_text(
                x + width // 2,
                y,
                anchor="n",
                text=header,
                fill=muted if count else text,
                font=self.shell.section_title_font,
            )
        )
        y += self.shell.section_title_font.metrics("linespace") + 28

        if not self._items:
            self._track(
                self.canvas.create_text(
                    x + width // 2,
                    y + 40,
                    anchor="n",
                    text="Nothing on the shopping list",
                    fill=muted,
                    font=self.shell.body_font,
                )
            )
            return

        item_font = self._item_font()
        row_height = self._row_height()
        card_x0 = x + self.CARD_INSET
        card_x1 = x + width - self.CARD_INSET
        text_x = card_x0 + self.ACCENT_WIDTH + self.TEXT_PAD_X
        start = self._page * self._page_size
        page_items = self._items[start : start + self._page_size]

        for index, item in enumerate(page_items):
            row_y = y + index * (row_height + self.ROW_GAP)
            value = str(item.get("value") or "")
            is_new = self._added_item is not None and value.strip().lower() == self._added_item
            row_color = accent if is_new else text
            card_outline = accent if is_new else muted

            self._round_rect(
                card_x0,
                row_y,
                card_x1,
                row_y + row_height,
                radius=12,
                fill=self.CARD,
                outline=accent if is_new else self.CARD_EDGE,
                width=2 if is_new else 1,
            )
            self._round_rect(
                card_x0 + 8,
                row_y + 8,
                card_x0 + 8 + self.ACCENT_WIDTH,
                row_y + row_height - 8,
                radius=self.ACCENT_WIDTH // 2,
                fill=accent if is_new else card_outline,
            )
            self._track(
                self.canvas.create_text(
                    text_x,
                    row_y + row_height // 2,
                    anchor="w",
                    text=value,
                    fill=row_color,
                    font=item_font,
                )
            )
            if is_new:
                self._track(
                    self.canvas.create_text(
                        card_x1 - 16,
                        row_y + row_height // 2,
                        anchor="e",
                        text="New",
                        fill=accent,
                        font=self.shell.chip_label_font,
                    )
                )

        pages = self._page_count()
        if pages > 1:
            dot_gap = 22
            dots_width = (pages - 1) * dot_gap
            dot_y = bottom - 16
            start_x = x + width // 2 - dots_width // 2
            for page_index in range(pages):
                dot_x = start_x + page_index * dot_gap
                radius = 7 if page_index == self._page else 4
                self._track(
                    self.canvas.create_oval(
                        dot_x - radius,
                        dot_y - radius,
                        dot_x + radius,
                        dot_y + radius,
                        fill=accent if page_index == self._page else muted,
                        outline="",
                    )
                )


class MusicPanel(BasePanel):
    ART_SIZE = 510

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._art_image = None  # keep a reference or Tk garbage-collects it
        self._art_request = 0
        self._art_placeholder_ids: list[int] = []

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        chip = self.config.get("chipBackground", "#141a24")
        center_x = x + width // 2

        music = payload.get("music") or {}
        song = music.get("song") or "Unknown track"
        artist = music.get("artist")
        album = music.get("album")
        provider = music.get("provider")
        device = music.get("device") or payload.get("device")

        text_block = self.shell.section_title_font.metrics("linespace")
        if artist:
            text_block += self.shell.body_font.metrics("linespace") + 8
        if album:
            text_block += self.shell.body_font.metrics("linespace") + 8
        text_block += self.shell.chip_value_font.metrics("linespace") + 24

        available = bottom - y - text_block
        art_size = min(self.ART_SIZE, max(330, min(width - 80, available - 20)))
        art_y = y + art_size // 2 + 8

        art_url = music.get("artUrl")
        loading_art = bool(art_url and Image is not None)
        self._art_placeholder_ids = []
        rect_id = self._round_rect(
            center_x - art_size // 2,
            art_y - art_size // 2,
            center_x + art_size // 2,
            art_y + art_size // 2,
            radius=22,
            fill=self.CARD,
            outline=accent if not loading_art else self.CARD_EDGE,
            width=2 if not loading_art else 1,
        )
        note_id = self._track(
            self.canvas.create_text(
                center_x,
                art_y,
                anchor="center",
                text="♪",
                fill=accent,
                font=self.shell.hero_font,
            )
        )
        self._art_placeholder_ids.extend((rect_id, note_id))

        if loading_art:
            self._load_art_async(art_url, center_x, art_y, art_size)

        cursor = art_y + art_size // 2 + 28
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=song,
                fill=text,
                font=self.shell.section_title_font,
                width=width - 40,
            )
        )
        cursor += self.shell.section_title_font.metrics("linespace") + 10
        if artist:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=artist,
                    fill=accent,
                    font=self.shell.body_font,
                    width=width - 40,
                )
            )
            cursor += self.shell.body_font.metrics("linespace") + 8
        if album:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=album,
                    fill=muted,
                    font=self.shell.body_font,
                    width=width - 40,
                )
            )
            cursor += self.shell.body_font.metrics("linespace") + 12

        detail_parts = []
        if provider:
            detail_parts.append(provider)
        if device:
            detail_parts.append(f"on {device}")
        if detail_parts:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=" · ".join(detail_parts),
                    fill=muted,
                    font=self.shell.chip_value_font,
                    width=width - 40,
                )
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
        self._art_image = ImageTk.PhotoImage(self._round_image_corners(image, 22))
        self._track(self.canvas.create_image(cx, cy, image=self._art_image))


class TeslaBatteryPanel(BasePanel):
    IMAGE_NAME = "tesla-model-y.png"
    IMAGE_MAX_WIDTH = 760

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._photo = None

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
        chip = self.config.get("chipBackground", "#141a24")
        center_x = x + width // 2

        battery = payload.get("battery") or {}
        percent = battery.get("percent")
        if percent is None:
            percent = parse_spoken_battery_percent(payload.get("spokenResponse"))
        model = battery.get("model") or "Model Y"
        status = str(battery.get("status") or "ok")
        error_text = battery.get("error")
        limit_reset = format_limit_reset_time(battery.get("limitResetAt"))
        charging_label = battery.get("chargingLabel") or battery.get("chargingState")
        stale = bool(battery.get("stale"))
        is_error = not stale and (status not in ("ok", "") or (percent is None and error_text))

        percent_text = format_battery_percent(percent)
        if is_error and error_text:
            percent_text = str(error_text)
        percent_value = None if percent is None else max(0, min(100, int(round(float(percent)))))
        bar_color = battery_level_color(percent_value)
        if is_error:
            bar_color = "#f59e0b" if status == "rate_limited" else "#ef4444"
        headline_color = "#ffffff" if percent_value is not None and not is_error else (
            "#f59e0b" if status == "rate_limited" else "#ef4444" if is_error else text
        )

        status_bits = self._status_bits(battery, stale, limit_reset, charging_label, is_error)
        title_font = self.shell.section_title_font
        body_font = self.shell.body_font
        label_font = self.shell.forecast_label_font
        bar_height = 36 if layout.portrait else 32
        bar_gap = 18 if layout.portrait else 12
        footer_h = title_font.metrics("linespace") + 6 + body_font.metrics("linespace")
        status_h = self._status_block_height(status_bits, width - 80)
        # Bar block: 0%/100% labels + bar + gap before status/footer.
        bar_block_h = label_font.metrics("linespace") + 6 + bar_height + bar_gap

        if layout.portrait:
            self._render_stack(
                x=x,
                width=width,
                top=y,
                bottom=bottom,
                center_x=center_x,
                accent=accent,
                chip=chip,
                muted=muted,
                text=text,
                model=model,
                percent_text=percent_text,
                percent_value=percent_value,
                bar_color=bar_color,
                headline_color=headline_color,
                status_bits=status_bits,
                bar_height=bar_height,
                bar_gap=bar_gap,
                bar_block_h=bar_block_h,
                status_h=status_h,
                footer_h=footer_h,
                image_frac=0.62,
                image_max=self.IMAGE_MAX_WIDTH,
            )
        else:
            self._render_landscape(
                x=x,
                width=width,
                top=y,
                bottom=bottom,
                accent=accent,
                chip=chip,
                muted=muted,
                text=text,
                model=model,
                percent_text=percent_text,
                percent_value=percent_value,
                bar_color=bar_color,
                headline_color=headline_color,
                status_bits=status_bits,
                bar_height=bar_height,
                bar_gap=bar_gap,
                bar_block_h=bar_block_h,
                status_h=status_h,
                footer_h=footer_h,
            )

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

    def _status_block_height(self, status_bits, wrap_width: int) -> int:
        if not status_bits:
            return 0
        label_font = self.shell.forecast_label_font
        body_font = self.shell.body_font
        height = 0
        for bit in status_bits:
            if bit["kind"] == "pill":
                height += label_font.metrics("linespace") + 14 + 8
            elif bit["kind"] == "legend":
                # Estimate wrapped lines from measured width.
                lines = max(1, int(math.ceil(label_font.measure(bit["text"]) / max(1, wrap_width))))
                height += label_font.metrics("linespace") * lines + 8
            else:
                height += body_font.metrics("linespace") + 8
        return height

    def _draw_status_bits(self, center_x, cursor, width, status_bits):
        label_font = self.shell.forecast_label_font
        body_font = self.shell.body_font
        for bit in status_bits:
            if bit["kind"] == "pill":
                h = self._pill(
                    center_x,
                    cursor,
                    bit["text"],
                    fill=bit["fill"],
                    fg=bit["fg"],
                    outline=bit["outline"],
                    anchor="n",
                )
                cursor += h + 8
            elif bit["kind"] == "legend":
                item = self._track(
                    self.canvas.create_text(
                        center_x,
                        cursor,
                        anchor="n",
                        text=bit["text"],
                        fill=bit["fill"],
                        font=label_font,
                        width=width - 80,
                        justify="center",
                    )
                )
                bbox = self.canvas.bbox(item)
                cursor = (bbox[3] if bbox else cursor + label_font.metrics("linespace")) + 8
            else:
                self._track(
                    self.canvas.create_text(
                        center_x,
                        cursor,
                        anchor="n",
                        text=bit["text"],
                        fill=bit["fill"],
                        font=body_font,
                    )
                )
                cursor += body_font.metrics("linespace") + 8
        return cursor

    def _draw_footer(self, center_x, cursor, model, text, muted):
        title_font = self.shell.section_title_font
        body_font = self.shell.body_font
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=model,
                fill=text,
                font=title_font,
            )
        )
        cursor += title_font.metrics("linespace") + 6
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text="Tesla Battery",
                fill=muted,
                font=body_font,
            )
        )
        return cursor + body_font.metrics("linespace")

    def _draw_battery_bar(
        self,
        center_x,
        bar_y0,
        bar_width,
        bar_height,
        percent_text,
        percent_value,
        bar_color,
        headline_color,
        muted,
    ):
        bar_x0 = center_x - bar_width // 2
        bar_x1 = bar_x0 + bar_width
        bar_y1 = bar_y0 + bar_height
        label_font = self.shell.forecast_label_font
        self._track(
            self.canvas.create_text(
                bar_x0, bar_y0 - 6, anchor="sw", text="0%", fill=muted, font=label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                bar_x1, bar_y0 - 6, anchor="se", text="100%", fill=muted, font=label_font,
            )
        )
        self._round_rect(
            bar_x0, bar_y0, bar_x1, bar_y1,
            radius=bar_height // 2,
            fill=self.INNER,
            outline=self.CARD_EDGE,
            width=2,
        )
        if percent_value is not None and bar_width > 0:
            fill_width = max(bar_height, int((bar_width - 6) * (percent_value / 100)))
            self._round_rect(
                bar_x0 + 3,
                bar_y0 + 3,
                bar_x0 + 3 + fill_width,
                bar_y1 - 3,
                radius=max(2, (bar_height - 6) // 2),
                fill=bar_color,
            )
        self._track(
            self.canvas.create_text(
                center_x,
                bar_y0 + bar_height // 2,
                anchor="center",
                text=percent_text,
                fill=headline_color,
                font=self.shell.section_title_font,
            )
        )
        return bar_y1

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

    def _render_stack(
        self,
        *,
        x,
        width,
        top,
        bottom,
        center_x,
        accent,
        chip,
        muted,
        text,
        model,
        percent_text,
        percent_value,
        bar_color,
        headline_color,
        status_bits,
        bar_height,
        bar_gap,
        bar_block_h,
        status_h,
        footer_h,
        image_frac,
        image_max,
    ):
        gap_after_image = 20
        reserved = bar_block_h + status_h + footer_h + gap_after_image + 8
        available = max(100, bottom - top - reserved)
        image_width = min(image_max, width - 60, max(220, int(width * 0.78)))
        image_height = max(90, min(int(available * image_frac), int(image_width * 0.52), available))

        image_bottom = self._place_car_image(center_x, top + 4, image_width, image_height, accent, chip)
        cursor = image_bottom + gap_after_image

        # If the image still overshoots (font metrics / wrap), pull the bar up.
        content_tail = bar_block_h + status_h + footer_h
        if cursor + content_tail > bottom:
            cursor = max(top + 40, bottom - content_tail)

        bar_width = min(width - 100, 560)
        bar_y1 = self._draw_battery_bar(
            center_x, cursor, bar_width, bar_height,
            percent_text, percent_value, bar_color, headline_color, muted,
        )
        cursor = bar_y1 + bar_gap
        cursor = self._draw_status_bits(center_x, cursor, width, status_bits)
        self._draw_footer(center_x, cursor, model, text, muted)

    def _render_landscape(
        self,
        *,
        x,
        width,
        top,
        bottom,
        accent,
        chip,
        muted,
        text,
        model,
        percent_text,
        percent_value,
        bar_color,
        headline_color,
        status_bits,
        bar_height,
        bar_gap,
        bar_block_h,
        status_h,
        footer_h,
    ):
        gap = 28
        # Car on the left, status column on the right — keeps short landscape
        # height free for cache / rate-limit copy without clipping the footer.
        col_gap = gap
        left_w = int(width * 0.46)
        right_x = x + left_w + col_gap
        right_w = width - left_w - col_gap
        right_cx = right_x + right_w // 2
        area_h = max(160, bottom - top)

        image_width = min(520, left_w - 10)
        image_height = max(100, min(int(area_h * 0.92), int(image_width * 0.55)))
        image_top = top + max(0, (area_h - image_height) // 2)
        self._place_car_image(x + left_w // 2, image_top, image_width, image_height, accent, chip)

        info_h = bar_block_h + status_h + footer_h
        cursor = top + max(0, (area_h - info_h) // 2)
        # Keep the info column inside the message band even if wrap estimates are low.
        if cursor + info_h > bottom:
            cursor = max(top, bottom - info_h)
        bar_width = min(right_w - 20, 420)
        bar_y1 = self._draw_battery_bar(
            right_cx, cursor, bar_width, bar_height,
            percent_text, percent_value, bar_color, headline_color, muted,
        )
        cursor = bar_y1 + bar_gap
        cursor = self._draw_status_bits(right_cx, cursor, right_w, status_bits)
        self._draw_footer(right_cx, cursor, model, text, muted)

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
            x - pad, top - 14, x + width + pad, bottom + 12,
            radius=26, fill=self.CONTAINER, outline=self.CARD_EDGE,
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

    @staticmethod
    def _latlon_to_global_px(lat: float, lon: float, zoom: int):
        scale = 256 * (1 << zoom)
        x = (lon + 180.0) / 360.0 * scale
        lat = max(-85.05112878, min(85.05112878, float(lat)))
        siny = math.sin(math.radians(lat))
        y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
        return x, y

    _MAP_UNVERIFIED_SSL = False

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
    def _map_tile_cache_dir(cls):
        from src.paths import app_root

        return app_root() / "map-tiles"

    def _log_map_error(self, message: str):
        from src.paths import app_root

        line = f"{datetime.now().isoformat(timespec='seconds')} {message}"
        print(line, file=sys.stderr)
        try:
            log_path = app_root() / "map-errors.log"
            if log_path.exists() and log_path.stat().st_size > 200_000:
                log_path.unlink()
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass

    def _fetch_map_tile(self, zoom: int, tx: int, ty: int):
        import ssl

        cache_dir = self._map_tile_cache_dir()
        cache_file = cache_dir / f"{zoom}_{tx}_{ty}.png"
        if cache_file.exists():
            try:
                return Image.open(cache_file).convert("RGB")
            except OSError:
                pass

        url = f"https://tile.openstreetmap.org/{zoom}/{tx}/{ty}.png"
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "alexa-broadcast-client/1.0 (personal home display)"},
        )

        def download(context):
            with urllib.request.urlopen(request, timeout=8, context=context) as response:
                return response.read()

        last_error = None
        for attempt in range(2):
            context = (
                ssl._create_unverified_context()
                if TeslaDashboardPanel._MAP_UNVERIFIED_SSL
                else ssl.create_default_context()
            )
            try:
                data = download(context)
            except Exception as error:
                # urllib wraps cert failures in URLError; unwrap before deciding.
                if not TeslaDashboardPanel._MAP_UNVERIFIED_SSL and self._is_ssl_failure(error):
                    try:
                        data = download(ssl._create_unverified_context())
                        # Frozen builds without a CA bundle: remember the fallback.
                        TeslaDashboardPanel._MAP_UNVERIFIED_SSL = True
                    except Exception as fallback_error:
                        last_error = fallback_error
                        time.sleep(0.4)
                        continue
                else:
                    last_error = error
                    time.sleep(0.4)
                    continue
            try:
                cache_dir.mkdir(parents=True, exist_ok=True)
                cache_file.write_bytes(data)
            except OSError:
                pass
            return Image.open(io.BytesIO(data)).convert("RGB")
        raise last_error if last_error else RuntimeError("tile fetch failed")

    def _fetch_map_tiles(self, lat: float, lon: float, zoom: int, w: int, h: int):
        from concurrent.futures import ThreadPoolExecutor

        from PIL import ImageEnhance

        center_x, center_y = self._latlon_to_global_px(lat, lon, zoom)
        left = int(center_x - w / 2)
        top = int(center_y - h / 2)
        tile_x0, tile_y0 = left // 256, top // 256
        tile_x1, tile_y1 = (left + w) // 256, (top + h) // 256
        stitched = Image.new(
            "RGB",
            ((tile_x1 - tile_x0 + 1) * 256, (tile_y1 - tile_y0 + 1) * 256),
            (10, 17, 30),
        )
        max_tile = (1 << zoom) - 1
        coords = [
            (tx, ty)
            for tx in range(tile_x0, tile_x1 + 1)
            for ty in range(tile_y0, tile_y1 + 1)
            if 0 <= tx <= max_tile and 0 <= ty <= max_tile
        ]
        fetched = 0
        last_error = None
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(self._fetch_map_tile, zoom, tx, ty): (tx, ty) for tx, ty in coords}
            for future, (tx, ty) in futures.items():
                try:
                    tile = future.result()
                except Exception as error:
                    last_error = error
                    self._log_map_error(f"map tile {zoom}/{tx}/{ty} failed: {error!r}")
                    continue
                stitched.paste(tile, ((tx - tile_x0) * 256, (ty - tile_y0) * 256))
                fetched += 1
        if not fetched:
            raise RuntimeError(f"no map tiles could be downloaded ({last_error!r})")
        crop_left = left - tile_x0 * 256
        crop_top = top - tile_y0 * 256
        image = stitched.crop((crop_left, crop_top, crop_left + w, crop_top + h))
        # Tone the map toward the dark theme while keeping streets clearly readable.
        image = ImageEnhance.Color(image).enhance(0.75)
        image = ImageEnhance.Contrast(image).enhance(1.12)
        image = ImageEnhance.Brightness(image).enhance(0.88)
        navy = Image.new("RGB", image.size, (16, 27, 48))
        return Image.blend(image, navy, 0.12)

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
                image = self._fetch_map_tiles(lat, lon, self.MAP_ZOOM, w, h)
            except Exception as error:
                self._log_map_error(f"map fetch failed for {lat:.4f},{lon:.4f}: {error!r}")
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
        self._round_rect(*box, radius=12, fill=self.INNER, outline=self.CARD_EDGE)
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

        geofence = self._geofence_label(map_data)
        if geofence:
            self._pill(x + 20, y + 20, f"⌂ {geofence}", fill=self.GREEN_BG, fg=self.GREEN, outline="#1d5c38")
        elif map_data.get("locationRestricted"):
            self._pill(x + 20, y + 20, "Location hidden", fill=self.AMBER_BG, fg=self.AMBER)
        driving = map_data.get("drivingChip") or "Parked"
        self._pill(x + width - 20, y + 20, driving, fill="#0d1830", fg=text, outline=self.CARD_EDGE, anchor="ne")

        location = map_data.get("locationLabel")
        if not location and lat is not None and lon is not None:
            location = f"{float(lat):.4f}, {float(lon):.4f}"
        location = location or "Location unavailable"
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
        self._pulse_job = None
        if not self.visible or not self._pin_center:
            return
        for item in self._pulse_items:
            self.canvas.delete(item)
        self._pulse_items = []
        self._pulse_phase = (self._pulse_phase + 1) % 4
        pin_x, pin_y = self._pin_center
        radius = 24 + self._pulse_phase * 7
        shades = ["#38bdf8", "#2e9dd2", "#2379a5", "#17527a"]
        ring = self.canvas.create_oval(
            pin_x - radius, pin_y - radius, pin_x + radius, pin_y + radius,
            outline=shades[self._pulse_phase], width=2,
        )
        self._pulse_items.append(self._track(ring))
        self._schedule_pulse()

    def _draw_car_card(self, x, y, width, height, dashboard: dict):
        muted = self.config["mutedTextColor"]
        security = dashboard.get("security") or {}
        secure = security.get("secureTheme") == "green"
        secure_color = self.GREEN if secure else self.AMBER
        secure_bg = self.GREEN_BG if secure else self.AMBER_BG

        self._round_rect(
            x, y, x + width, y + height,
            radius=18, fill=self.CARD, outline="#31415e", dash=(6, 5),
        )

        image_path = asset_path(self.CAR_IMAGE_NAME)
        img_w = min(width - 60, 460)
        img_h = max(80, height - 52)
        if image_path.exists() and Image is not None and ImageTk is not None:
            try:
                image = Image.open(image_path).convert("RGBA")
                image.thumbnail((int(img_w), int(img_h)), Image.LANCZOS)
                self._car_photo = ImageTk.PhotoImage(image)
                self._track(
                    self.canvas.create_image(
                        x + width // 2,
                        y + height // 2,
                        image=self._car_photo,
                    )
                )
            except OSError:
                pass

        left_badges = []
        left_badges.append("🔒 Locked" if security.get("locked") else "🔓 Unlocked")
        if security.get("sentryOn"):
            left_badges.append("◉ Sentry on")
        right_badges = [
            ("Doors closed", True) if security.get("doorsClosed", True) else ("Door open", False),
            ("Windows up", True) if security.get("windowsUp", True) else ("Window open", False),
        ]

        badge_y = y + 16
        for label in left_badges:
            h = self._pill(x + 16, badge_y, label, fill=secure_bg, fg=secure_color, outline=secure_bg)
            badge_y += h + 8
        badge_y = y + 16
        for label, ok in right_badges:
            h = self._pill(
                x + width - 16, badge_y, label,
                fill=self.CARD, fg=muted if ok else self.AMBER,
                outline=self.CARD_EDGE, anchor="ne",
            )
            badge_y += h + 8

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
        self._round_rect(x + 18, bar_y, x + width - 18, bar_y + bar_h, radius=bar_h // 2, fill=self.INNER)
        if percent is not None:
            pct = max(0, min(100, int(percent)))
            fill_w = (width - 36) * pct / 100
            if fill_w > bar_h:
                self._round_rect(
                    x + 18, bar_y, x + 18 + fill_w, bar_y + bar_h,
                    radius=bar_h // 2, fill=bar_color,
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

    def _render(self, payload: dict):
        layout = self.shell.layout
        x = layout.content_x
        width = layout.content_width
        y = layout.message_area_top
        bottom = layout.message_area_bottom
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]
        accent = self.config.get("accentColor", "#38bdf8")
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
        icon_size = 120
        icon_y = y + (bottom - y) // 2 - 90

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

        cursor = icon_y + icon_size // 2 + 34
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
        cursor += self.shell.hero_font.metrics("linespace") + 10
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
        cursor += self.shell.section_title_font.metrics("linespace") + 16
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
                radius=14,
                fill=self.CARD,
                outline=accent,
            )
            self._round_rect(
                card_x + 8,
                cursor + 8,
                card_x + 14,
                cursor + card_h - 8,
                radius=3,
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
