import math
import time
import tkinter as tk
from datetime import datetime, timezone
from tkinter import font as tkfont

from src.message_scroll import MessageScrollController
from src.payload_utils import (
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
    parse_spoken_air_quality,
    parse_spoken_indoor,
    parse_spoken_weather,
    format_temperature_f,
    timer_detail_line,
    timer_label_name,
    timer_title,
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
        "cloudy": "#94a3b8",
        "rainy": "#38bdf8",
        "snowy": "#e2e8f0",
        "stormy": "#a78bfa",
        "windy": "#cbd5e1",
        "unknown": "#64748b",
    }

    def _fit_forecast_heights(self, layout, y_before_hourly: int, has_hourly: bool, has_daily: bool) -> tuple[int, int]:
        min_slot, max_slot = 72, 114
        min_day, max_day = 72, 122
        hourly_gap = 22
        hourly_header = self.shell.section_label_font.metrics("linespace") + 16
        day_header = 28

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

        temp_f = current.get("temperatureF")
        temp_c = current.get("temperatureC")
        condition = normalize_condition(current.get("condition") or spoken_bits.get("condition"))

        if temp_f is None and spoken_bits.get("temp_f") is not None:
            temp_f = spoken_bits["temp_f"]
            temp_c = round((temp_f - 32) * 5 / 9)
        if condition == "unknown" and spoken_bits.get("condition"):
            condition = normalize_condition(spoken_bits.get("condition"))

        icon_x = x + 72
        icon_y = y + 54
        self._draw_condition_icon(icon_x, icon_y, 54, condition)

        if temp_f is not None and temp_c is not None:
            temp_line = f"{temp_f}°F"
            sub_line = f"{temp_c}°C · {condition.replace('_', ' ').title()}"
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
        detail_parts = []
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

        daily = weather.get("next7Days") or []
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
            slot_width = width // slot_count
            for index, slot in enumerate(hourly[:slot_count]):
                slot_x = x + index * slot_width
                inner_w = slot_width - 10
                center_x = slot_x + inner_w // 2
                label = "—"
                if slot.get("time"):
                    try:
                        label = datetime.fromisoformat(slot["time"].replace("Z", "+00:00")).astimezone().strftime("%I%p").lstrip("0")
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
                        outline="",
                    )
                )
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 4,
                        anchor="n",
                        text=label,
                        fill=muted,
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
        y += 28

        if daily:
            day_count = min(7, max(5, width // 100))
            day_width = width // day_count
            for index, day in enumerate(daily[:day_count]):
                day_x = x + index * day_width
                inner_w = day_width - 10
                center_x = day_x + inner_w // 2
                label = day.get("date", "")[-5:]
                if day.get("date"):
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
                        outline="",
                    )
                )
                self._track(
                    self.canvas.create_text(
                        center_x,
                        y + 4,
                        anchor="n",
                        text=label,
                        fill=muted,
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
        "comfortable": "#22c55e",
        "hot": "#f97316",
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
        accent = self.COMFORT_COLORS.get(comfort, self.COMFORT_COLORS["unknown"])
        location_name = format_indoor_location(location)
        comfort_label = comfort.replace("_", " ").title()

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
        y += 44

        dashboard_top = y
        dashboard_height = max(180, bottom - dashboard_top - 8)
        left_width = min(300, int(width * 0.38))
        gap = 20
        right_x = x + left_width + gap
        right_width = max(180, width - left_width - gap)

        hero_cx = x + left_width // 2
        hero_cy = dashboard_top + dashboard_height // 2
        radius = min(78, dashboard_height // 2 - 12, left_width // 2 - 16)

        self._track(
            self.canvas.create_oval(
                hero_cx - radius,
                hero_cy - radius,
                hero_cx + radius,
                hero_cy + radius,
                fill=chip,
                outline=accent,
                width=3,
            )
        )
        self._draw_comfort_icon(hero_cx - radius * 0.62, hero_cy, radius * 0.34, comfort, accent)

        if metric == "humidity" and humidity is not None:
            hero_value = f"{humidity}%"
            hero_sub = "Indoor humidity"
        elif temp_f is not None:
            hero_value = format_temperature_f(temp_f)
            hero_sub = comfort_label
        else:
            hero_value = "—"
            hero_sub = spoken_bits.get("summary") or reading.get("summary") or "Reading unavailable"

        self._track(
            self.canvas.create_text(
                hero_cx + radius * 0.08,
                hero_cy - 8,
                anchor="center",
                text=hero_value,
                fill=accent,
                font=self.shell.digital_time_font,
            )
        )
        self._track(
            self.canvas.create_text(
                hero_cx,
                hero_cy + radius + 18,
                anchor="n",
                text=hero_sub,
                fill=text,
                font=self.shell.body_font,
            )
        )

        tile_gap = 14
        tile_h = (dashboard_height - tile_gap) // 2
        tile_w = (right_width - tile_gap) // 2

        tiles = []
        if temp_f is not None and metric != "humidity":
            tiles.append(("Temperature", format_temperature_f(temp_f), comfort_label))
        if humidity is not None:
            tiles.append(("Humidity", f"{humidity}%", "Relative humidity"))
        if temp_f is not None:
            tiles.append(("Comfort", comfort_label, format_temperature_f(temp_f)))
        elif metric == "humidity":
            tiles.append(("Comfort", comfort_label, None))

        if not tiles:
            tiles.append(("Status", "—", hero_sub))

        for index, (label, value, sublabel) in enumerate(tiles[:4]):
            row = index // 2
            col = index % 2
            tile_x = right_x + col * (tile_w + tile_gap)
            tile_y = dashboard_top + row * (tile_h + tile_gap)
            self._draw_dashboard_tile(
                tile_x,
                tile_y,
                tile_w,
                tile_h,
                label,
                value,
                chip=chip,
                text=text,
                muted=muted,
                accent=accent if label != "Humidity" else self.config.get("accentColor", "#38bdf8"),
                sublabel=sublabel,
            )

        entity = location.get("entity") or location.get("query")
        if entity and str(entity).lower() != str(location_name).lower():
            self._track(
                self.canvas.create_text(
                    x,
                    bottom - 8,
                    anchor="sw",
                    text=str(entity),
                    fill=muted,
                    font=self.shell.chip_label_font,
                )
            )

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
        ("temperatureF", "Temperature", "°F", 50, 90, (50, 70, 90)),
        ("humidity", "Humidity", "%", 0, 100, (0, 50, 100)),
        ("pm25", "PM 2.5", "µg/m³", 0, 500, (0, 35, 150, 500)),
        ("co", "Carbon Monoxide", "ppm", 0, 50, (0, 10, 50)),
        ("voc", "VOCs", "index", 0, 500, (0, 100, 500)),
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
        accent = self.config.get("accentColor", "#38bdf8")

        location = payload.get("location") or {}
        reading = payload.get("reading") or {}
        spoken = payload.get("spokenResponse") or ""
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
        band_color = self.BAND_COLORS.get(band, self.BAND_COLORS["unknown"])
        location_name = format_air_quality_location(location)
        entity = location.get("entity") or location.get("query")

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
        y += 44

        dashboard_top = y
        dashboard_height = max(220, bottom - dashboard_top - 24)
        left_width = min(290, int(width * 0.34))
        gap = 18
        right_x = x + left_width + gap
        right_width = max(220, width - left_width - gap)

        values = {
            "temperatureF": reading.get("temperatureF") if reading.get("temperatureF") is not None else spoken_bits.get("temperature_f"),
            "humidity": reading.get("humidity") if reading.get("humidity") is not None else spoken_bits.get("humidity"),
            "pm25": reading.get("pm25") if reading.get("pm25") is not None else spoken_bits.get("pm25"),
            "co": reading.get("co") if reading.get("co") is not None else spoken_bits.get("co"),
            "voc": reading.get("voc") if reading.get("voc") is not None else spoken_bits.get("voc"),
        }

        self._draw_iaq_hero(
            x + left_width // 2,
            dashboard_top,
            dashboard_height,
            iaq_score,
            band,
            band_color,
            text,
            muted,
            chip,
        )

        tile_gap = 12
        cols = 2
        rows = 3
        tile_w = (right_width - tile_gap) // cols
        tile_h = (dashboard_height - (rows - 1) * tile_gap) // rows

        for index, (key, label, unit, scale_min, scale_max, ticks) in enumerate(self.METRICS):
            row = index // cols
            col = index % cols
            tile_x = right_x + col * (tile_w + tile_gap)
            tile_y = dashboard_top + row * (tile_h + tile_gap)
            value = values.get(key)
            value_text = self._format_metric_value(value, unit)
            sublabel = None
            if value is not None:
                sublabel = self._metric_scale_hint(value, scale_min, scale_max, ticks)
            self._draw_dashboard_tile(
                tile_x,
                tile_y,
                tile_w,
                tile_h,
                label,
                value_text,
                chip=chip,
                text=text,
                muted=muted,
                accent=band_color if value is not None else muted,
                sublabel=sublabel,
            )

        footer_y = bottom - 8
        if entity:
            subtitle = str(entity).title() if str(entity).lower() == str(entity) else str(entity)
            self._track(
                self.canvas.create_text(
                    x,
                    footer_y,
                    anchor="sw",
                    text=subtitle,
                    fill=muted,
                    font=self.shell.chip_label_font,
                )
            )
            footer_y -= 18

        if iaq_score is None:
            summary = spoken_bits.get("summary") or reading.get("summary")
            if summary:
                self._track(
                    self.canvas.create_text(
                        x,
                        footer_y,
                        anchor="sw",
                        text=summary,
                        fill=muted,
                        font=self.shell.chip_label_font,
                        width=width,
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

    def _metric_scale_hint(
        self,
        value: int | float,
        scale_min: float,
        scale_max: float,
        ticks: tuple[int | float, ...],
    ) -> str:
        if scale_max <= scale_min:
            return ""
        ratio = max(0.0, min(1.0, (float(value) - scale_min) / (scale_max - scale_min)))
        if ratio <= 0.33:
            return "Low"
        if ratio <= 0.66:
            return "Mid"
        return "High"

    def _draw_iaq_hero(
        self,
        center_x: float,
        y: float,
        height: float,
        score: int | float | None,
        band: str,
        band_color: str,
        text: str,
        muted: str,
        chip: str,
    ) -> None:
        radius = min(58, int(height * 0.28))
        cy = y + radius + 6
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
        self._track(
            self.canvas.create_text(
                center_x,
                label_y + self.shell.body_font.metrics("linespace") + 8,
                anchor="n",
                text="Indoor Air Quality",
                fill=muted,
                font=self.shell.chip_label_font,
            )
        )

        scale_y = label_y + self.shell.body_font.metrics("linespace") + 34
        scale_w = min(240, radius * 2 + 40)
        scale_x = center_x - scale_w / 2
        self._draw_scale_bar(scale_x, scale_y, scale_w, score, 0, 100, (100, 65, 35, 0), chip, band_color, muted, invert=True)
        tick_y = scale_y + 16
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
