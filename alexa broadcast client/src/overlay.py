import math
import sys
import time
import tkinter as tk
from dataclasses import dataclass
from tkinter import font as tkfont

from src.display_panels import (
    AirQualityPanel,
    AlarmPanel,
    AuthPinPanel,
    BroadcastPanel,
    IndoorTemperaturePanel,
    MusicPanel,
    ProcessingPanel,
    QrPanel,
    ShoppingListPanel,
    NotificationsPanel,
    PhotoSlideshowPanel,
    SmartHomePanel,
    TeslaBatteryPanel,
    TeslaDashboardPanel,
    TimePanel,
    TimerPanel,
    VivintAlarmPanel,
    WeatherPanel,
)
from src.payload_utils import resolve_display_type, title_for_display_type, title_for_payload
from src.weather_fetch import enrich_weather_payload


@dataclass
class OverlayLayout:
    content_x: int
    content_width: int
    chip_gap: int
    chip_width: int
    chip_height: int
    chip_y: int
    message_area_top: int
    message_area_bottom: int
    message_content_width: int
    message_viewport_height: int
    message_center_x: int
    countdown_y: int
    portrait: bool


class OverlayShell:
    _FONT_ATTRS = (
        "message_font",
        "chip_label_font",
        "chip_value_font",
        "digital_time_font",
        "date_font",
        "section_title_font",
        "hero_font",
        "body_font",
        "section_label_font",
    )

    def __init__(self, overlay: "OverlayWindow"):
        self.overlay = overlay
        self.content_canvas = overlay.canvas
        self.layout = overlay.layout
        for name in self._FONT_ATTRS:
            setattr(self, name, getattr(overlay, name))

    def __getattr__(self, name):
        return getattr(self.overlay, name)


class OverlayWindow:
    def __init__(self, root: tk.Tk, config: dict, on_user_dismiss=None, on_local_timer_fired=None):
        self.root = root
        self.config = config
        self.on_user_dismiss = on_user_dismiss
        self.on_local_timer_fired = on_local_timer_fired
        self.visible = False
        self._fade_job = None
        self._hide_job = None
        self._countdown_job = None
        self._expires_at = 0.0
        self._alpha = 0.0
        self._display_seconds = 0
        self._on_closed = None
        self._active_panel = None
        self._active_panel_key = None
        self._opacity_override = None

        self.root.withdraw()
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.configure(bg=self.config["overlayBackground"])
        self.root.attributes("-alpha", 0.0)

        self.screen_w = self.root.winfo_screenwidth()
        self.screen_h = self.root.winfo_screenheight()
        self.portrait = self.screen_h > self.screen_w
        self.root.geometry(f"{self.screen_w}x{self.screen_h}+0+0")

        self.canvas = tk.Canvas(
            self.root,
            width=self.screen_w,
            height=self.screen_h,
            highlightthickness=0,
            bd=0,
            bg=self.config["overlayBackground"],
        )
        self.canvas.pack(fill="both", expand=True)

        self._build_fonts()
        self.layout = self._compute_layout()
        self.shell = OverlayShell(self)
        self._build_shell()
        self._build_countdown_widget()
        self._bind_dismiss_events()

        self.panels = {
            "broadcast": BroadcastPanel(self.root, self.shell, self.config),
            "time.query": TimePanel(self.root, self.shell, self.config),
            "weather.query": WeatherPanel(self.root, self.shell, self.config),
            "indoor-temperature.query": IndoorTemperaturePanel(self.root, self.shell, self.config),
            "air-quality.query": AirQualityPanel(self.root, self.shell, self.config),
            "timer.snapshot": TimerPanel(self.root, self.shell, self.config),
            "alarm.snapshot": AlarmPanel(self.root, self.shell, self.config),
            "shopping-list.snapshot": ShoppingListPanel(self.root, self.shell, self.config),
            "music.playing": MusicPanel(self.root, self.shell, self.config),
            "smart-home.command": SmartHomePanel(self.root, self.shell, self.config),
            "tesla-battery.query": TeslaBatteryPanel(self.root, self.shell, self.config),
            "tesla-dashboard.query": TeslaDashboardPanel(self.root, self.shell, self.config),
            "vivint-alarm.query": VivintAlarmPanel(self.root, self.shell, self.config),
            "alexa-notifications.query": NotificationsPanel(self.root, self.shell, self.config),
            "request.processing": ProcessingPanel(self.root, self.shell, self.config),
            "display.auth": AuthPinPanel(self.root, self.shell, self.config),
            "qr.display": QrPanel(self.root, self.shell, self.config),
            "photo.slideshow": PhotoSlideshowPanel(self.root, self.shell, self.config),
        }
        self.panels["timer.snapshot"].set_on_local_fire(self._on_timer_panel_local_fire)

    @property
    def active_display_type(self) -> str | None:
        return self._active_panel_key

    def _on_timer_panel_local_fire(self, timer: dict, base_payload: dict):
        if self.on_local_timer_fired:
            self.on_local_timer_fired(timer, base_payload)

    def _build_fonts(self):
        title_family = self.config.get("titleFontFamily", "Segoe UI")
        portrait = self.portrait
        self.title_primary_font = tkfont.Font(family=title_family, size=34 if portrait else 40, weight="bold")
        self.title_accent_font = tkfont.Font(family=title_family, size=28 if portrait else 32)
        self.chip_label_font = tkfont.Font(family=title_family, size=11 if portrait else 12, weight="bold")
        self.chip_value_font = tkfont.Font(family=title_family, size=15 if portrait else 17)
        self.message_font = tkfont.Font(family=title_family, size=36 if portrait else 42, weight="bold")
        self.countdown_font = tkfont.Font(family=title_family, size=15 if portrait else 16)
        self.digital_time_font = tkfont.Font(family=title_family, size=54 if portrait else 64, weight="bold")
        self.date_font = tkfont.Font(family=title_family, size=22 if portrait else 26)
        self.section_title_font = tkfont.Font(family=title_family, size=28 if portrait else 32, weight="bold")
        self.section_label_font = tkfont.Font(family=title_family, size=16 if portrait else 18, weight="bold")
        self.hero_font = tkfont.Font(family=title_family, size=42 if portrait else 48, weight="bold")
        self.body_font = tkfont.Font(family=title_family, size=18 if portrait else 20)
        self.forecast_label_font = tkfont.Font(family=title_family, size=10 if portrait else 11)
        self.forecast_value_font = tkfont.Font(family=title_family, size=13 if portrait else 14, weight="bold")
        self.forecast_detail_font = tkfont.Font(family=title_family, size=10 if portrait else 11)
        self.timer_remaining_font = tkfont.Font(family=title_family, size=30 if portrait else 34, weight="bold")
        self.timer_meta_font = tkfont.Font(family=title_family, size=13 if portrait else 14)
        self.timer_alert_font = tkfont.Font(family=title_family, size=38 if portrait else 44, weight="bold")

    def _compute_layout(self) -> OverlayLayout:
        content_width = int(self.screen_w * (0.82 if self.portrait else 0.68))
        content_x = (self.screen_w - content_width) // 2
        top_y = int(self.screen_h * (0.12 if self.portrait else 0.14))
        accent_line_height = self.title_accent_font.metrics("linespace")
        received_y = top_y + self.title_primary_font.metrics("linespace") + 6
        # message_area_top starts right under the title stack (not after the
        # chip row) since most panels don't render chips. BroadcastPanel is the
        # exception — it still shows the FROM/TO/TIME chip row and computes its
        # own message top (chip_y + chip_height + gap) from these chip_* fields
        # so its scrolling text never overlaps the chips.
        chip_gap = 16
        chip_count = 3
        chip_width = (content_width - chip_gap * (chip_count - 1)) // chip_count
        chip_height = 72 if self.portrait else 78
        chip_y = received_y + accent_line_height + 24
        message_area_top = chip_y
        countdown_y = self.screen_h - 40
        message_area_bottom = countdown_y - 48
        message_content_width = content_width - 48
        message_viewport_height = max(120, message_area_bottom - message_area_top)
        message_center_x = message_content_width // 2

        return OverlayLayout(
            content_x=content_x,
            content_width=content_width,
            chip_gap=chip_gap,
            chip_width=chip_width,
            chip_height=chip_height,
            chip_y=chip_y,
            message_area_top=message_area_top,
            message_area_bottom=message_area_bottom,
            message_content_width=message_content_width,
            message_viewport_height=message_viewport_height,
            message_center_x=message_center_x,
            countdown_y=countdown_y,
            portrait=self.portrait,
        )

    def _bind_dismiss_events(self):
        for widget in (self.root, self.canvas):
            widget.bind("<Button-1>", self._on_dismiss_input)

    def _on_dismiss_input(self, _event=None):
        if self.visible and self.on_user_dismiss:
            self.on_user_dismiss()

    def _create_round_rect(self, x0, y0, x1, y1, *, radius, fill, outline):
        points = [
            x0 + radius, y0, x1 - radius, y0, x1, y0, x1, y0 + radius,
            x1, y1 - radius, x1, y1, x1 - radius, y1, x0 + radius, y1,
            x0, y1, x0, y1 - radius, x0, y0 + radius, x0, y0,
        ]
        return self.canvas.create_polygon(
            points, smooth=True, fill=fill, outline=outline, width=1
        )

    def _build_shell(self):
        self.canvas.delete("all")
        self.canvas.create_rectangle(
            0,
            0,
            self.screen_w,
            self.screen_h,
            fill=self.config["overlayBackground"],
            outline="",
        )

        layout = self.layout
        title_center_x = layout.content_x + layout.content_width // 2
        top_y = int(self.screen_h * (0.12 if self.portrait else 0.14))

        # Rounded backdrop frame shared by every panel (mission-control look).
        frame_pad = 26
        self.frame_top = top_y - int(self.screen_h * 0.045)
        self.frame_bottom = layout.message_area_bottom + 30
        self.backdrop_frame_id = self._create_round_rect(
            layout.content_x - frame_pad,
            self.frame_top,
            layout.content_x + layout.content_width + frame_pad,
            self.frame_bottom,
            radius=28,
            fill="#0d1524",
            outline="#1d2a40",
        )
        title_color = self.config.get("titleColor", self.config["textColor"])
        self._default_title_accent_color = self.config.get("titleAccentColor", self.config["accentColor"])
        title_accent_color = self._default_title_accent_color

        self.title_primary_id = self.canvas.create_text(
            title_center_x,
            top_y,
            anchor="n",
            text="Alexa Broadcast",
            fill=title_color,
            font=self.title_primary_font,
            tags=("overlay_chrome",),
        )
        self.title_accent_id = self.canvas.create_text(
            title_center_x,
            top_y + self.title_primary_font.metrics("linespace") + 6,
            anchor="n",
            text="Received",
            fill=title_accent_color,
            font=self.title_accent_font,
            tags=("overlay_chrome",),
        )

    def _build_countdown_widget(self):
        pill_bg = self.config.get("chipBackground", "#141a24")
        self.countdown_label = tk.Label(
            self.root,
            text="",
            bg=pill_bg,
            fg=self.config["textColor"],
            font=self.countdown_font,
            bd=0,
            highlightthickness=0,
            padx=20,
            pady=10,
        )
        self.countdown_label.bind("<Button-1>", self._on_dismiss_input)

    def _position_countdown(self):
        layout = self.layout
        center_x = layout.content_x + layout.content_width // 2
        self.countdown_label.place(x=center_x, y=layout.countdown_y, anchor="center")
        self.countdown_label.lift()

    def _set_countdown_text(self, text: str):
        if text:
            self.countdown_label.configure(text=text)
            self._position_countdown()
        else:
            self.countdown_label.place_forget()
            self.countdown_label.configure(text="")

    def _raise_overlay_chrome(self):
        self.canvas.tag_raise("overlay_chrome")
        if self.countdown_label.winfo_ismapped():
            self.countdown_label.lift()

    def hide(self):
        if not self.visible:
            return
        self._cancel_countdown()
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None
        self._stop_active_panel()
        self._fade_to(0.0, self.config["fadeOutMs"], on_done=self._finish_hide)

    def _finish_hide(self):
        self._stop_active_panel()
        self.root.withdraw()
        self.visible = False
        self._hide_job = None
        self._set_countdown_text("")
        self._notify_closed()

    def _notify_closed(self):
        callback = self._on_closed
        self._on_closed = None
        if callback:
            callback()

    def _set_title(self, display_type: str, payload: dict | None = None):
        if payload:
            primary, accent = title_for_payload(payload)
        else:
            primary, accent = title_for_display_type(display_type)
        accent_color = self._default_title_accent_color
        if payload:
            theme = payload.get("themeAccent")
            if theme:
                accent_color = theme
            elif display_type == "alexa-notifications.query":
                accent_color = "#FF9900"
            elif display_type == "vivint-alarm.query":
                alarm = payload.get("alarm") or {}
                status = str(alarm.get("status") or "").lower()
                if status == "armed":
                    accent_color = "#4ade80"
                elif status == "disarmed":
                    accent_color = self.config.get("mutedTextColor", "#94a3b8")
            elif display_type == "display.auth":
                auth = payload.get("auth") or {}
                status = str(auth.get("status") or "").strip().lower()
                if status in ("ok", "authenticated", "success"):
                    accent_color = "#22c55e"
        self.canvas.itemconfigure(self.title_primary_id, text=primary)
        self.canvas.itemconfigure(self.title_accent_id, text=accent, fill=accent_color)
        self.canvas.tag_raise("overlay_chrome")

    def _stop_active_panel(self):
        if self._active_panel:
            self._active_panel.hide()
            self._active_panel = None
            self._active_panel_key = None

    @property
    def _scroller(self):
        panel = self.panels.get("broadcast")
        return panel.scroller if panel else None

    def _needs_scroll(self) -> bool:
        if self._active_panel_key == "broadcast" and self._active_panel:
            return self._active_panel.needs_scroll
        return False

    def _apply_payload(self, payload: dict):
        display_type = resolve_display_type(payload)
        if not display_type:
            return

        if display_type == "weather.query":
            try:
                payload = enrich_weather_payload(payload, self.config)
            except Exception as error:
                print(f"Weather enrich failed: {error}", file=sys.stderr)

        self._stop_active_panel()
        if display_type == "tesla-dashboard.query":
            self.canvas.itemconfigure(self.title_primary_id, text="")
            self.canvas.itemconfigure(self.title_accent_id, text="")
            # The dashboard draws its own full-size container, so hide the shared
            # backdrop frame to avoid a double-box outline.
            self.canvas.itemconfigure(self.backdrop_frame_id, state="hidden")
        else:
            self.canvas.itemconfigure(self.backdrop_frame_id, state="normal")
            self._set_title(display_type, payload)

        # Fullscreen overlays stay opaque so desktop media never bleeds through
        # sparse canvas regions (Tesla battery over a movie poster, etc.).
        self._opacity_override = 1.0

        panel = self.panels[display_type]
        self._active_panel = panel
        self._active_panel_key = display_type
        panel.show(payload)
        self.canvas.tag_raise("overlay_chrome")
        if self.countdown_label.cget("text"):
            self.countdown_label.lift()

        if display_type == "broadcast" and panel.message_viewport:
            panel.message_viewport.bind("<Button-1>", self._on_dismiss_input)

    def _cancel_countdown(self):
        if self._countdown_job:
            self.root.after_cancel(self._countdown_job)
            self._countdown_job = None

    def _format_remaining(self, remaining_seconds: int, finishing: bool = False) -> str:
        if finishing:
            return "Finishing…"
        remaining_seconds = max(0, remaining_seconds)
        minutes, seconds = divmod(remaining_seconds, 60)
        if minutes:
            return f"Dismisses in {minutes}:{seconds:02d}"
        return f"Dismisses in {seconds}s"

    def _update_countdown(self):
        remaining = max(0, int(math.ceil(self._expires_at - time.time())))
        finishing = remaining <= 0 and self._needs_scroll()
        self._set_countdown_text(self._format_remaining(remaining, finishing=finishing))
        self._raise_overlay_chrome()

        if remaining <= 0:
            self._on_display_timer_expired()
            if finishing:
                self._countdown_job = self.root.after(1000, self._update_countdown)
            return

        self._countdown_job = self.root.after(1000, self._update_countdown)

    def _on_display_timer_expired(self):
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None

        scroller = self._scroller
        if scroller and scroller.needs_scroll:
            scroller.mark_timer_expired()
            return

        self.hide()

    def _start_countdown(self, display_seconds: int):
        self._cancel_countdown()
        self._expires_at = time.time() + display_seconds
        self._update_countdown()

    def _on_show_ready(self):
        scroller = self._scroller
        if scroller and scroller.needs_scroll:
            scroller.start()
            return

        self._hide_job = self.root.after(self._display_seconds * 1000, self._on_display_timer_expired)

    def _stop_timers(self):
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None
        if self._fade_job:
            self.root.after_cancel(self._fade_job)
            self._fade_job = None
        self._cancel_countdown()
        scroller = self._scroller
        if scroller:
            scroller.stop()

    def show(self, payload: dict, display_seconds: int, on_closed=None):
        self._on_closed = on_closed
        self._stop_timers()

        self._display_seconds = display_seconds
        self._apply_payload(payload)

        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.visible = True
        self._fade_to(
            1.0,
            self.config["fadeInMs"],
            on_done=self._on_show_ready,
        )
        self._start_countdown(display_seconds)

    def advance(self, payload: dict, display_seconds: int):
        self._stop_timers()

        self._display_seconds = display_seconds
        self._apply_payload(payload)

        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.visible = True
        self._alpha = 1.0
        self.root.attributes("-alpha", self._effective_opacity())
        self._on_show_ready()
        self._start_countdown(display_seconds)

    def dismiss_immediately(self):
        if not self.visible:
            return

        self._stop_timers()
        self._stop_active_panel()

        self._alpha = 0.0
        self.root.attributes("-alpha", 0.0)
        self.root.withdraw()
        self.visible = False
        self._set_countdown_text("")
        self._notify_closed()

    def _effective_opacity(self) -> float:
        if self._opacity_override is not None:
            return float(self._opacity_override)
        return float(self.config.get("overlayOpacity", 0.88))

    def _fade_to(self, target: float, duration_ms: int, on_done=None):
        if self._fade_job:
            self.root.after_cancel(self._fade_job)
            self._fade_job = None

        start = self._alpha
        steps = max(int(duration_ms / 16), 1)
        delta = (target - start) / steps
        step_index = {"value": 0}

        def step():
            step_index["value"] += 1
            self._alpha = start + delta * step_index["value"]
            self._alpha = max(0.0, min(1.0, self._alpha))
            self.root.attributes("-alpha", self._alpha * self._effective_opacity())

            if step_index["value"] >= steps:
                self._alpha = target
                self.root.attributes("-alpha", target * self._effective_opacity())
                if on_done:
                    on_done()
                return

            self._fade_job = self.root.after(16, step)

        step()
