import io
import math
import re
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
    format_weather_location,
    format_air_quality_location,
    air_quality_band,
    air_quality_band_label,
    indoor_comfort_band,
    normalize_condition,
    parse_iso_timestamp,
    parse_qualitative_air_quality_band,
    parse_spoken_air_quality,
    parse_spoken_battery_percent,
    parse_spoken_indoor,
    parse_spoken_weather,
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
        self._track(
            self.canvas.create_rectangle(
                x,
                y,
                x + width,
                y + height,
                fill=chip,
                outline=muted,
                width=1,
            )
        )
        self._track(
            self.canvas.create_text(
                x + 14,
                y + 12,
                anchor="nw",
                text=label,
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                x + 14,
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
                    x + 14,
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
            self._track(
                self.canvas.create_rectangle(
                    chip_x,
                    layout.chip_y,
                    chip_x + layout.chip_width,
                    layout.chip_y + layout.chip_height,
                    fill=chip_fill,
                    outline="",
                )
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
        parsed = payload.get("parsedTime") or {}
        if parsed.get("iso"):
            dt = parse_iso_timestamp(parsed["iso"])
            if dt:
                return dt.astimezone()

        spoken = payload.get("spokenResponse") or ""
        for fmt in ("%I:%M %p", "%I:%M:%S %p", "%H:%M"):
            try:
                clock = datetime.strptime(spoken.strip().split("It's")[-1].strip(), fmt)
                now = datetime.now().astimezone()
                return now.replace(hour=clock.hour, minute=clock.minute, second=clock.second, microsecond=0)
            except ValueError:
                continue

        ts = parse_iso_timestamp(payload.get("timestamp", ""))
        return (ts or datetime.now(timezone.utc)).astimezone()

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

        face = self.config.get("chipBackground", "#141a24")
        accent = self.config.get("accentColor", "#38bdf8")
        text = self.config["textColor"]
        muted = self.config["mutedTextColor"]

        self._track(
            self.canvas.create_oval(
                center_x - radius,
                center_y - radius,
                center_x + radius,
                center_y + radius,
                fill=face,
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
        self._track(
            self.canvas.create_text(
                center_x,
                layout.message_area_bottom - 12,
                anchor="s",
                text=f"Asked on {device}",
                fill=muted,
                font=self.shell.chip_value_font,
            )
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
                self._track(
                    self.canvas.create_rectangle(
                        slot_x,
                        y,
                        slot_x + inner_w,
                        y + slot_height,
                        fill=self.config.get("chipBackground", "#141a24"),
                        outline=accent if is_now else "",
                        width=2 if is_now else 0,
                    )
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
                self._track(
                    self.canvas.create_rectangle(
                        day_x,
                        y,
                        day_x + inner_w,
                        y + day_height,
                        fill=self.config.get("chipBackground", "#141a24"),
                        outline=accent if is_today else "",
                        width=2 if is_today else 0,
                    )
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
        self._track(
            self.canvas.create_rectangle(
                left,
                y,
                left + pill_w,
                y + pill_h,
                fill=chip,
                outline=accent,
                width=1,
            )
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

            self._track(
                self.canvas.create_rectangle(
                    card_x,
                    cursor,
                    card_x + card_w,
                    cursor + row_h,
                    fill=chip,
                    outline=band_color,
                    width=2,
                )
            )
            self._track(
                self.canvas.create_rectangle(
                    card_x,
                    cursor,
                    card_x + 6,
                    cursor + row_h,
                    fill=band_color,
                    outline="",
                )
            )
            self._track(
                self.canvas.create_text(
                    card_x + 18,
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
        self._track(
            self.canvas.create_rectangle(
                x,
                y,
                x + width,
                y + height,
                fill=chip,
                outline=muted,
                width=1,
            )
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
        self._track(
            self.canvas.create_rectangle(
                x,
                y,
                x + width,
                y + height,
                fill=track,
                outline="",
            )
        )
        if value is not None:
            marker_x = x + self._scale_position(value, scale_min, scale_max, width, invert=invert)
            self._track(
                self.canvas.create_rectangle(
                    x,
                    y,
                    marker_x,
                    y + height,
                    fill=fill,
                    outline="",
                )
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
            row_fill = "#2a1808" if self._is_fired else chip_fill
            outline = alert if self._is_fired else ""
            outline_width = 3 if self._is_fired else 0
            self._track(
                self.canvas.create_rectangle(
                    x,
                    row_y,
                    x + width,
                    row_y + row_height,
                    fill=row_fill,
                    outline=outline,
                    width=outline_width,
                )
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

            self._track(
                self.canvas.create_rectangle(
                    card_x0,
                    row_y,
                    card_x1,
                    row_y + row_height,
                    fill=chip,
                    outline=card_outline,
                    width=2 if is_new else 1,
                )
            )
            self._track(
                self.canvas.create_rectangle(
                    card_x0,
                    row_y,
                    card_x0 + self.ACCENT_WIDTH,
                    row_y + row_height,
                    fill=accent if is_new else card_outline,
                    outline="",
                )
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
        rect_id = self._track(
            self.canvas.create_rectangle(
                center_x - art_size // 2,
                art_y - art_size // 2,
                center_x + art_size // 2,
                art_y + art_size // 2,
                fill=chip,
                outline=accent if not loading_art else "",
                width=2 if not loading_art else 0,
            )
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

    def _apply_art(self, request_id: int, image, cx: float, cy: float):
        if not self.visible or request_id != self._art_request:
            return
        self._clear_art_placeholder()
        self._art_image = ImageTk.PhotoImage(image)
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

        percent_text = format_battery_percent(percent)
        percent_value = None if percent is None else max(0, min(100, int(round(float(percent)))))
        bar_color = battery_level_color(percent_value)

        footer_block = (
            self.shell.section_title_font.metrics("linespace")
            + self.shell.body_font.metrics("linespace")
            + 96
        )
        available_height = bottom - y - footer_block
        image_width = min(self.IMAGE_MAX_WIDTH, width - 60, max(320, int(width * 0.82)))
        image_height = max(180, min(int(available_height * 0.72), int(image_width * 0.56)))

        image_path = asset_path(self.IMAGE_NAME)
        image_top = y + 8
        if image_path.exists() and Image is not None and ImageTk is not None:
            try:
                image = Image.open(image_path).convert("RGBA")
                image.thumbnail((image_width, image_height), Image.LANCZOS)
                self._photo = ImageTk.PhotoImage(image)
                image_center_y = image_top + image.height // 2
                self._track(
                    self.canvas.create_image(
                        center_x,
                        image_center_y,
                        image=self._photo,
                    )
                )
                cursor = image_top + image.height + 52
            except OSError:
                cursor = y + 40
                self._draw_fallback_car(center_x, cursor, image_width, accent, chip)
                cursor += int(image_height * 0.55) + 52
        else:
            cursor = y + 40
            self._draw_fallback_car(center_x, cursor, image_width, accent, chip)
            cursor += int(image_height * 0.55) + 52

        bar_width = min(width - 100, 560)
        bar_height = 42
        bar_x0 = center_x - bar_width // 2
        bar_y0 = cursor
        bar_x1 = bar_x0 + bar_width
        bar_y1 = bar_y0 + bar_height

        self._track(
            self.canvas.create_text(
                bar_x0,
                bar_y0 - 8,
                anchor="sw",
                text="0%",
                fill=muted,
                font=self.shell.forecast_label_font,
            )
        )
        self._track(
            self.canvas.create_text(
                bar_x1,
                bar_y0 - 8,
                anchor="se",
                text="100%",
                fill=muted,
                font=self.shell.forecast_label_font,
            )
        )
        self._track(
            self.canvas.create_rectangle(
                bar_x0,
                bar_y0,
                bar_x1,
                bar_y1,
                fill=chip,
                outline=muted,
                width=2,
            )
        )

        if percent_value is not None and bar_width > 0:
            fill_width = max(4, int((bar_width - 4) * (percent_value / 100)))
            self._track(
                self.canvas.create_rectangle(
                    bar_x0 + 2,
                    bar_y0 + 2,
                    bar_x0 + 2 + fill_width,
                    bar_y1 - 2,
                    fill=bar_color,
                    outline="",
                )
            )

        self._track(
            self.canvas.create_text(
                center_x,
                bar_y0 + bar_height // 2,
                anchor="center",
                text=percent_text,
                fill="#ffffff" if percent_value is not None else text,
                font=self.shell.section_title_font,
            )
        )

        cursor = bar_y1 + 28
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=model,
                fill=text,
                font=self.shell.section_title_font,
            )
        )
        cursor += self.shell.section_title_font.metrics("linespace") + 8
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text="Tesla Battery",
                fill=muted,
                font=self.shell.body_font,
            )
        )

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
        cursor += self.shell.section_title_font.metrics("linespace") + 12
        type_label = self.TYPE_LABELS.get(device_type, "Device")
        detail = type_label
        if origin:
            detail = f"{type_label} · asked on {origin}"
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=detail,
                fill=muted,
                font=self.shell.body_font,
            )
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

        icon_size = 140
        icon_y = y + (bottom - y) // 2 - 110
        self._draw_lock_icon(center_x, icon_y, icon_size, accent, chip, locked=status == "armed")

        cursor = icon_y + icon_size // 2 + 36
        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=headline,
                fill=accent,
                font=self.shell.hero_font,
                width=width - 40,
            )
        )
        cursor += self.shell.hero_font.metrics("linespace") + 8

        if mode_label:
            self._track(
                self.canvas.create_text(
                    center_x,
                    cursor,
                    anchor="n",
                    text=mode_label,
                    fill=text,
                    font=self.shell.section_title_font,
                )
            )
            cursor += self.shell.section_title_font.metrics("linespace") + 10

        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=secure_text,
                fill=text,
                font=self.shell.body_font,
            )
        )
        cursor += self.shell.body_font.metrics("linespace") + 14

        self._track(
            self.canvas.create_text(
                center_x,
                cursor,
                anchor="n",
                text=provider,
                fill=muted,
                font=self.shell.forecast_label_font,
            )
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
        self._track(
            self.canvas.create_rectangle(
                x,
                y,
                x + width,
                y + banner_h,
                fill=accent,
                outline="",
            )
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

            self._track(
                self.canvas.create_rectangle(
                    card_x,
                    cursor,
                    card_x + card_width,
                    cursor + card_h,
                    fill=chip,
                    outline=accent,
                    width=1,
                )
            )
            self._track(
                self.canvas.create_rectangle(
                    card_x,
                    cursor,
                    card_x + 6,
                    cursor + card_h,
                    fill=accent,
                    outline="",
                )
            )
            self._track(
                self.canvas.create_text(
                    card_x + 18,
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
