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
    GuestPhotoboothPanel,
    QrPanel,
    ShoppingListPanel,
    NotificationsPanel,
    PhotoSlideshowPanel,
    RoutePlannerPanel,
    SmartHomePanel,
    TeslaBatteryPanel,
    TeslaDashboardPanel,
    TimePanel,
    TimerPanel,
    VivintAlarmPanel,
    WeatherPanel,
)
from src.design_system import ACCENT, BG, page_chrome
from src.design_system import design_u as dismiss_u
from src.dismiss_footer import DismissFooter, footer_height
from src.page_header import paint_page_header
from src.payload_utils import resolve_display_type, title_for_display_type, title_for_payload
from src.steam_now_playing_panel import SteamNowPlayingPanel
from src.psn_now_playing_panel import PsnNowPlayingPanel
from src.youtube_now_playing_panel import YoutubeNowPlayingPanel
from src.trivia_panel import TriviaPanel
from src.upside_news_panel import UpsideNewsPanel
from src.wiki_common_knowledge_panel import WikiCommonKnowledgePanel
from src.overhead_panel import OverheadPanel
from src.game_library_tour_panel import GameLibraryTourPanel
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
            "guest.photobooth": GuestPhotoboothPanel(self.root, self.shell, self.config),
            "photo.slideshow": PhotoSlideshowPanel(self.root, self.shell, self.config),
            "route-planner.query": RoutePlannerPanel(self.root, self.shell, self.config),
            "steam.now-playing": SteamNowPlayingPanel(self.root, self.shell, self.config),
            "psn.now-playing": PsnNowPlayingPanel(self.root, self.shell, self.config),
            "youtube.now-playing": YoutubeNowPlayingPanel(self.root, self.shell, self.config),
            "trivia.round": TriviaPanel(self.root, self.shell, self.config),
            "upside-news.round": UpsideNewsPanel(self.root, self.shell, self.config),
            "wiki-common-knowledge.round": WikiCommonKnowledgePanel(self.root, self.shell, self.config),
            "overhead.round": OverheadPanel(self.root, self.shell, self.config),
            "game.library-tour": GameLibraryTourPanel(self.root, self.shell, self.config),
        }
        self.panels["timer.snapshot"].set_on_local_fire(self._on_timer_panel_local_fire)

    @property
    def active_display_type(self) -> str | None:
        return self._active_panel_key

    def _on_timer_panel_local_fire(self, timer: dict, base_payload: dict):
        if self.on_local_timer_fired:
            self.on_local_timer_fired(timer, base_payload)

    def _build_fonts(self):
        # Design system: weights 400/500 only. Tk's "bold" stands in for medium.
        title_family = self.config.get("titleFontFamily", "Segoe UI")
        portrait = self.portrait
        self.title_primary_font = tkfont.Font(family=title_family, size=34 if portrait else 40, weight="bold")
        self.title_accent_font = tkfont.Font(family=title_family, size=28 if portrait else 32, weight="bold")
        self.chip_label_font = tkfont.Font(family=title_family, size=11 if portrait else 12)
        self.chip_value_font = tkfont.Font(family=title_family, size=15 if portrait else 17, weight="bold")
        self.message_font = tkfont.Font(family=title_family, size=36 if portrait else 42, weight="bold")
        self.digital_time_font = tkfont.Font(family=title_family, size=54 if portrait else 64, weight="bold")
        self.date_font = tkfont.Font(family=title_family, size=22 if portrait else 26)
        self.section_title_font = tkfont.Font(family=title_family, size=28 if portrait else 32, weight="bold")
        self.section_label_font = tkfont.Font(family=title_family, size=16 if portrait else 18)
        self.hero_font = tkfont.Font(family=title_family, size=42 if portrait else 48, weight="bold")
        self.body_font = tkfont.Font(family=title_family, size=18 if portrait else 20)
        self.forecast_label_font = tkfont.Font(family=title_family, size=10 if portrait else 11)
        self.forecast_value_font = tkfont.Font(family=title_family, size=13 if portrait else 14, weight="bold")
        self.forecast_detail_font = tkfont.Font(family=title_family, size=10 if portrait else 11)
        self.timer_remaining_font = tkfont.Font(family=title_family, size=30 if portrait else 34, weight="bold")
        self.timer_meta_font = tkfont.Font(family=title_family, size=13 if portrait else 14)
        self.timer_alert_font = tkfont.Font(family=title_family, size=38 if portrait else 44, weight="bold")

    def _compute_layout(self) -> OverlayLayout:
        # Shared page frame (design-system §1.7): header 32–116, content 136–footer.
        chrome = page_chrome(self.screen_w, self.screen_h, timed=True)
        content_width = max(200, int(round(chrome.content_w)))
        content_x = int(round(chrome.content_x))
        message_area_top = int(round(chrome.content_top))
        message_area_bottom = int(round(chrome.content_bottom))
        # BroadcastPanel still shows FROM/TO/TIME chips at content top and
        # computes its own message top below them from chip_* fields.
        chip_gap = 16
        chip_count = 3
        chip_width = (content_width - chip_gap * (chip_count - 1)) // chip_count
        chip_height = 72 if self.portrait else 78
        chip_y = message_area_top
        footer_h = footer_height(self.screen_w, self.screen_h)
        u = dismiss_u(self.screen_w, self.screen_h)
        rail_h = max(2, int(round(6 * u)))
        countdown_y = message_area_bottom + rail_h + (footer_h - rail_h) // 2
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
        """Click-to-dismiss. Deferred so panel teardown cannot abort mid-handler.

        Destroying nested marquees/scroll canvases during the Button-1 callback
        has left the shell empty with the dismiss footer still ticking.
        """
        if not self.visible or not self.on_user_dismiss:
            return
        if getattr(self, "_dismiss_pending", False):
            return
        self._dismiss_pending = True
        try:
            self.root.after(0, self._run_user_dismiss)
        except Exception:
            self._dismiss_pending = False
            self._run_user_dismiss()

    def _run_user_dismiss(self):
        self._dismiss_pending = False
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
        # Flat design-system surface — no rounded card framing the chrome.
        # Keep the id: trivia (and similar) must stack *above* this floor.
        # A bare `tag_lower` on panel art used to slip under it and vanish.
        self.shell_bg_id = self.canvas.create_rectangle(
            0,
            0,
            self.screen_w,
            self.screen_h,
            fill=self.config.get("overlayBackground", BG),
            outline="",
            tags=("shell_bg",),
        )

        layout = self.layout

        # Kept as a no-op id so chrome-owning panels can still "hide" it safely.
        self.frame_top = 0
        self.frame_bottom = layout.message_area_bottom
        self.backdrop_frame_id = self.canvas.create_rectangle(
            0, 0, 0, 0, fill="", outline="", state="hidden",
            tags=("shell_bg",),
        )
        self._default_title_accent_color = self.config.get("titleAccentColor", ACCENT)
        if self._default_title_accent_color in ("#38bdf8", "#0ea5e9"):
            self._default_title_accent_color = ACCENT
        # Shared 3-column header lives in the 32–116 band; content starts at 136.
        self._header_ids: list[int] = []
        # Back-compat placeholders (tests / older call sites may itemconfigure).
        self.title_primary_id = self.canvas.create_text(
            0, 0, text="", state="hidden", tags=("overlay_chrome",),
        )
        self.title_accent_id = self.canvas.create_text(
            0, 0, text="", state="hidden", tags=("overlay_chrome",),
        )
        self._paint_shell_header("Alexa Broadcast", "Received")

    def _clear_shell_header(self):
        for item_id in getattr(self, "_header_ids", []) or []:
            try:
                self.canvas.delete(item_id)
            except tk.TclError:
                pass
        self._header_ids = []

    def _paint_shell_header(self, primary: str, accent: str):
        """Shared page header — center pill is the page type (design-system §1.7)."""
        self._clear_shell_header()
        family = self.config.get("titleFontFamily", "Segoe UI")
        left_value = ""
        if primary and primary not in ("Alexa", "Signal", "Steam", "Tesla", "Unlock"):
            left_value = primary
        self._header_ids = paint_page_header(
            self.canvas,
            screen_w=self.screen_w,
            screen_h=self.screen_h,
            pill=accent or "Display",
            left_label="",
            left_value=left_value,
            right_label="",
            right_value="",
            sans_family=family,
            mono_family="Consolas",
        )
        for item_id in self._header_ids:
            self.canvas.addtag_withtag("overlay_chrome", item_id)

    def _build_countdown_widget(self):
        family = self.config.get("titleFontFamily", "Segoe UI")
        self.dismiss_footer = DismissFooter(
            self.canvas,
            self.root,
            screen_w=self.screen_w,
            screen_h=self.screen_h,
            font_family=family,
            on_click=self._on_dismiss_input,
        )
        # Back-compat alias for older tests / call sites.
        self.countdown_label = self.dismiss_footer

    def _set_countdown_text(self, text: str):
        """Show/hide the shared dismiss footer. Non-empty text is ignored —
        the footer owns formatting from the deadline."""
        if text:
            if self._display_seconds > 0 and not self._suppress_dismiss_footer():
                self.dismiss_footer.show(
                    self._display_seconds * 1000,
                    expires_at=self._expires_at or None,
                )
                if text.startswith("Finishing"):
                    self.dismiss_footer.set_finishing(True)
        else:
            self.dismiss_footer.hide()

    def _raise_overlay_chrome(self):
        self.canvas.tag_raise("overlay_chrome")
        if getattr(self.dismiss_footer, "_visible", False):
            self.dismiss_footer.raise_()

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
        self._scrub_canvas_debris()
        self.root.withdraw()
        self.visible = False
        self._hide_job = None
        self.dismiss_footer.hide()
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
        # accent_color kept for theme hooks (notifications / vivint / auth);
        # shared header uses ink/pill chrome rather than coloured title text.
        _ = accent_color
        self.canvas.itemconfigure(self.title_primary_id, text=primary)
        self.canvas.itemconfigure(self.title_accent_id, text=accent)
        self._paint_shell_header(primary, accent)
        self.canvas.tag_raise("overlay_chrome")

    def _stop_active_panel(self):
        panel = self._active_panel
        self._active_panel = None
        self._active_panel_key = None
        if panel is None:
            return
        try:
            panel.hide()
        except Exception as error:
            print(f"Overlay panel hide failed: {error}", file=sys.stderr)

    def _cancel_pending_dismiss(self):
        self._dismiss_pending = False

    def _scrub_canvas_debris(self):
        """Drop untracked leftovers so the next page cannot inherit ghosts.

        Panels should track every item they create, but a missed oval / image
        (or trivia art parked under the shell) used to linger as a faint circle
        on weather and other house-blue pages.
        """
        keep_tags = {"shell_bg", "overlay_chrome", "dismiss_footer"}
        keep_ids = {
            getattr(self, "shell_bg_id", None),
            getattr(self, "backdrop_frame_id", None),
            getattr(self, "title_primary_id", None),
            getattr(self, "title_accent_id", None),
        }
        keep_ids.discard(None)
        try:
            for item in self.canvas.find_all():
                if item in keep_ids:
                    continue
                try:
                    tags = set(self.canvas.gettags(item))
                except tk.TclError:
                    continue
                if tags & keep_tags:
                    continue
                try:
                    self.canvas.delete(item)
                except tk.TclError:
                    pass
        except tk.TclError:
            pass

    @property
    def _scroller(self):
        panel = self.panels.get("broadcast")
        return panel.scroller if panel else None

    def _needs_scroll(self) -> bool:
        if self._active_panel_key == "broadcast" and self._active_panel:
            return self._active_panel.needs_scroll
        return False

    def apply_overhead_update(self, payload: dict) -> bool:
        """Refresh aircraft on the active overhead panel without a full teardown."""
        if self._active_panel_key != "overhead.round" or not self._active_panel:
            return False
        updater = getattr(self._active_panel, "apply_update", None)
        if not callable(updater):
            return False
        try:
            updater(payload)
        except Exception as error:
            print(f"Overhead update failed: {error}", file=sys.stderr)
            return False
        return True

    def _apply_payload(self, payload: dict):
        display_type = resolve_display_type(payload)
        if not display_type:
            return

        # A deferred click-dismiss from the previous page must not tear down
        # the page we are about to show.
        self._cancel_pending_dismiss()

        if display_type == "weather.query":
            try:
                payload = enrich_weather_payload(payload, self.config)
            except Exception as error:
                print(f"Weather enrich failed: {error}", file=sys.stderr)

        self._stop_active_panel()
        self._scrub_canvas_debris()
        owns_chrome = display_type in (
            "tesla-dashboard.query",
            "tesla-battery.query",
            "route-planner.query",
            "guest.photobooth",
            "steam.now-playing",
            "psn.now-playing",
            "youtube.now-playing",
            "trivia.round",
            "upside-news.round",
            "wiki-common-knowledge.round",
            "overhead.round",
            "game.library-tour",
            "photo.slideshow",
            "weather.query",
            "timer.snapshot",
            "alarm.snapshot",
            "shopping-list.snapshot",
            "air-quality.query",
        ) or self._is_shared_photo_qr(display_type, payload)
        if owns_chrome:
            self.canvas.itemconfigure(self.title_primary_id, text="")
            self.canvas.itemconfigure(self.title_accent_id, text="")
            self._clear_shell_header()
            # These panels draw their own header — hide the shared backdrop +
            # generic title so we never get "frame inside a frame" / duplicate titles.
            self.canvas.itemconfigure(self.backdrop_frame_id, state="hidden")
        else:
            self.canvas.itemconfigure(self.backdrop_frame_id, state="normal")
            self._set_title(display_type, payload)

        # Fullscreen overlays stay opaque so desktop media never bleeds through
        # sparse canvas regions (Tesla battery over a movie poster, etc.).
        self._opacity_override = 1.0

        panel = self.panels.get(display_type)
        if panel is None:
            print(f"No overlay panel registered for type {display_type!r}", file=sys.stderr)
            return
        self._active_panel = panel
        self._active_panel_key = display_type
        try:
            panel.show(payload)
        except Exception as error:
            print(f"Overlay panel {display_type!r} failed: {error}", file=sys.stderr)
            self._active_panel = None
            self._active_panel_key = None
            raise
        self.canvas.tag_raise("overlay_chrome")
        # Shared-photos + persistent Steam own their own chrome — hide the
        # system dismiss footer. Everything else gets it from `_start_countdown`.
        if self._suppress_dismiss_footer():
            self.dismiss_footer.hide()
        else:
            self.dismiss_footer.raise_()

        if display_type == "broadcast" and panel.message_viewport:
            panel.message_viewport.bind("<Button-1>", self._on_dismiss_input)

    def _cancel_countdown(self):
        if self._countdown_job:
            self.root.after_cancel(self._countdown_job)
            self._countdown_job = None

    @staticmethod
    def _is_shared_photo_qr(display_type: str, payload: dict | None) -> bool:
        """Single-upload shared photo preview (`qr.display` with photo content)."""
        if display_type != "qr.display":
            return False
        qr = (payload or {}).get("qr") or {}
        if str(qr.get("qrType") or "").lower() == "photo":
            return True
        return QrPanel._is_shared_photo_url(str(qr.get("content") or ""))

    def _is_shared_photo_qr_active(self) -> bool:
        if self._active_panel_key != "qr.display":
            return False
        panel = self._active_panel
        return bool(panel and getattr(panel, "_photo_mode", False))

    def _suppress_dismiss_footer(self) -> bool:
        """Shared-photos pages keep their own rails; persistent Steam has no timer."""
        if self._active_panel_key == "photo.slideshow":
            return True
        if self._active_panel_key == "game.library-tour":
            return True
        if self._is_shared_photo_qr_active():
            return True
        if self._active_panel_key == "steam.now-playing" and self._display_seconds <= 0:
            return True
        if self._active_panel_key == "psn.now-playing" and self._display_seconds <= 0:
            return True
        if self._active_panel_key == "youtube.now-playing" and self._display_seconds <= 0:
            return True
        return False

    def _format_remaining(self, remaining_seconds: int, finishing: bool = False) -> str:
        from src.dismiss_footer import format_dismiss_parts

        if finishing:
            return "Finishing…"
        prefix, value = format_dismiss_parts(max(1, remaining_seconds))
        return f"{prefix}{value}"

    def _update_countdown(self):
        remaining = max(0, int(math.ceil(self._expires_at - time.time())))
        finishing = remaining <= 0 and self._needs_scroll()

        if self._suppress_dismiss_footer() or self._display_seconds <= 0:
            self.dismiss_footer.hide()
        elif finishing:
            self.dismiss_footer.set_finishing(True)
            self.dismiss_footer.pulse()
        else:
            # Drive the rail from the overlay clock too — if the footer's
            # 33ms after-job stalls, the bar used to freeze mid-drain.
            self.dismiss_footer.pulse()

        self._raise_overlay_chrome()

        if self._display_seconds <= 0:
            # Persistent overlays (auto Steam Now Playing) — no auto-dismiss clock.
            self._countdown_job = None
            return

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

    def _start_countdown(self, display_seconds: int, *, extend: bool = False):
        self._cancel_countdown()
        if display_seconds <= 0:
            self._expires_at = 0
            self.dismiss_footer.hide()
            return
        self._expires_at = time.time() + display_seconds
        if self._suppress_dismiss_footer():
            self.dismiss_footer.hide()
        else:
            self.dismiss_footer.show(
                display_seconds * 1000,
                expires_at=self._expires_at,
                extend=extend,
            )
        self._update_countdown()

    def _on_show_ready(self):
        scroller = self._scroller
        if scroller and scroller.needs_scroll:
            scroller.start()
            return

        if self._display_seconds <= 0:
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
        # Footer visibility is owned by `_start_countdown` / `_apply_payload`
        # (so `advance()` can extend the rail instead of hard-resetting).
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
        # Replacing an active timed page extends the rail (spec §5) rather than
        # hard-resetting from empty.
        self._start_countdown(display_seconds, extend=True)

    def dismiss_immediately(self):
        if not self.visible:
            return

        # Mark hidden first so a second click / nested destroy cannot re-enter
        # and leave the shell half-torn-down (empty content + live footer).
        self.visible = False
        try:
            self._stop_timers()
        except Exception as error:
            print(f"Overlay dismiss timers failed: {error}", file=sys.stderr)
        try:
            self._stop_active_panel()
        except Exception as error:
            print(f"Overlay dismiss panel failed: {error}", file=sys.stderr)
        try:
            self._alpha = 0.0
            self.root.attributes("-alpha", 0.0)
        except Exception:
            pass
        try:
            self.root.withdraw()
        except Exception:
            pass
        try:
            self.dismiss_footer.hide()
        except Exception:
            pass
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
