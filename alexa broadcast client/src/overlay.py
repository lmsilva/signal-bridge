import math
import time
import tkinter as tk
from datetime import datetime
from tkinter import font as tkfont

from src.message_scroll import MessageScrollController


class OverlayWindow:
    def __init__(self, root: tk.Tk, config: dict, on_user_dismiss=None):
        self.root = root
        self.config = config
        self.on_user_dismiss = on_user_dismiss
        self.visible = False
        self._fade_job = None
        self._hide_job = None
        self._countdown_job = None
        self._expires_at = 0.0
        self._alpha = 0.0
        self._display_seconds = 0
        self._scroller = None
        self._on_closed = None

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

        self._build_layout()
        self._bind_dismiss_events()

        self._scroller = MessageScrollController(
            self.message_viewport,
            self.message_text_id,
            self.config,
            self.root,
            on_finish=self.hide,
        )

    def _bind_dismiss_events(self):
        for widget in (self.root, self.canvas, self.message_viewport):
            widget.bind("<Button-1>", self._on_dismiss_input)

    def _on_dismiss_input(self, _event=None):
        if self.visible and self.on_user_dismiss:
            self.on_user_dismiss()

    def _build_layout(self):
        self.canvas.delete("all")

        self.canvas.create_rectangle(
            0,
            0,
            self.screen_w,
            self.screen_h,
            fill=self.config["overlayBackground"],
            outline="",
        )

        content_width = int(self.screen_w * (0.82 if self.portrait else 0.68))
        self.content_x = (self.screen_w - content_width) // 2
        top_y = int(self.screen_h * (0.12 if self.portrait else 0.14))

        title_primary_size = 34 if self.portrait else 40
        title_accent_size = 28 if self.portrait else 32
        label_size = 11 if self.portrait else 12
        value_size = 15 if self.portrait else 17
        message_size = 36 if self.portrait else 42
        countdown_size = 14 if self.portrait else 15

        title_family = self.config.get("titleFontFamily", "Segoe UI")
        self.title_primary_font = tkfont.Font(
            family=title_family,
            size=title_primary_size,
            weight="bold",
        )
        self.title_accent_font = tkfont.Font(
            family=title_family,
            size=title_accent_size,
            weight="normal",
        )
        self.chip_label_font = tkfont.Font(family=title_family, size=label_size, weight="bold")
        self.chip_value_font = tkfont.Font(family=title_family, size=value_size)
        self.message_font = tkfont.Font(family=title_family, size=message_size, weight="bold")
        self.countdown_font = tkfont.Font(family=title_family, size=countdown_size)

        title_center_x = self.content_x + content_width // 2
        title_color = self.config.get("titleColor", self.config["textColor"])
        title_accent_color = self.config.get("titleAccentColor", self.config["accentColor"])

        primary_line_height = self.title_primary_font.metrics("linespace")
        accent_line_height = self.title_accent_font.metrics("linespace")
        received_y = top_y + primary_line_height + 6

        self.canvas.create_text(
            title_center_x,
            top_y,
            anchor="n",
            text="Alexa Broadcast",
            fill=title_color,
            font=self.title_primary_font,
        )
        self.canvas.create_text(
            title_center_x,
            received_y,
            anchor="n",
            text="Received",
            fill=title_accent_color,
            font=self.title_accent_font,
        )

        chip_gap = 16
        chip_count = 3
        chip_width = (content_width - chip_gap * (chip_count - 1)) // chip_count
        chip_height = 72 if self.portrait else 78
        chip_y = received_y + accent_line_height + 32

        chip_fill = self.config.get("chipBackground", "#141a24")
        self.chip_value_ids = []

        for index, label in enumerate(("FROM", "TO", "TIME")):
            chip_x = self.content_x + index * (chip_width + chip_gap)
            self.canvas.create_rectangle(
                chip_x,
                chip_y,
                chip_x + chip_width,
                chip_y + chip_height,
                fill=chip_fill,
                outline="",
            )
            self.canvas.create_text(
                chip_x + chip_width // 2,
                chip_y + 22,
                anchor="center",
                text=label,
                fill=self.config["mutedTextColor"],
                font=self.chip_label_font,
            )
            value_id = self.canvas.create_text(
                chip_x + chip_width // 2,
                chip_y + chip_height // 2 + 10,
                anchor="center",
                text="—",
                fill=self.config["textColor"],
                font=self.chip_value_font,
                width=chip_width - 20,
                justify="center",
            )
            self.chip_value_ids.append(value_id)

        self.message_area_top = chip_y + chip_height + 36
        countdown_y = int(self.screen_h * (0.82 if self.portrait else 0.84))
        self.message_area_bottom = countdown_y - 36
        self.message_content_width = content_width - 48
        self.message_viewport_height = max(120, self.message_area_bottom - self.message_area_top)
        self.message_center_x = self.message_content_width // 2

        self.message_viewport = tk.Canvas(
            self.root,
            width=self.message_content_width,
            height=self.message_viewport_height,
            highlightthickness=0,
            bd=0,
            bg=self.config["overlayBackground"],
        )
        self.message_viewport.place(
            x=self.content_x + 24,
            y=self.message_area_top,
        )

        self.message_text_id = self.message_viewport.create_text(
            self.message_center_x,
            0,
            anchor="n",
            text="",
            fill=self.config["textColor"],
            font=self.message_font,
            width=self.message_content_width,
            justify="center",
        )

        self.countdown_text = self.canvas.create_text(
            title_center_x,
            countdown_y,
            anchor="center",
            text="",
            fill=self.config.get("accentColor", self.config.get("mutedTextColor")),
            font=self.countdown_font,
        )

    def _format_timestamp(self, value: str) -> str:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.strftime("%b %d · %I:%M %p")
        except ValueError:
            return value or datetime.now().strftime("%b %d · %I:%M %p")

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
        finishing = remaining <= 0 and self._scroller and self._scroller.needs_scroll
        self.canvas.itemconfigure(
            self.countdown_text,
            text=self._format_remaining(remaining, finishing=finishing),
        )

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

        if self._scroller and self._scroller.needs_scroll:
            self._scroller.mark_timer_expired()
            return

        self.hide()

    def _start_countdown(self, display_seconds: int):
        self._cancel_countdown()
        self._expires_at = time.time() + display_seconds
        self._update_countdown()

    def _on_show_ready(self):
        if self._scroller.needs_scroll:
            self._scroller.start()
            return

        self._hide_job = self.root.after(self._display_seconds * 1000, self._on_display_timer_expired)

    def _stop_active_display(self):
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None
        if self._fade_job:
            self.root.after_cancel(self._fade_job)
            self._fade_job = None
        self._cancel_countdown()
        if self._scroller:
            self._scroller.stop()

    def _apply_payload(self, payload: dict):
        sender = payload.get("sender", "Unknown")
        destination = payload.get("destination", "All devices")
        timestamp = self._format_timestamp(payload.get("timestamp", ""))
        message = payload.get("message", "")

        values = (sender, destination, timestamp)
        for item_id, value in zip(self.chip_value_ids, values):
            self.canvas.itemconfigure(item_id, text=value)

        self._scroller.configure(
            message,
            center_x=self.message_center_x,
            viewport_height=self.message_viewport_height,
        )

        self.message_viewport.place(
            x=self.content_x + 24,
            y=self.message_area_top,
        )

    def _notify_closed(self):
        callback = self._on_closed
        self._on_closed = None
        if callback:
            callback()

    def show(self, payload: dict, display_seconds: int, on_closed=None):
        self._on_closed = on_closed
        self._stop_active_display()

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
        self._stop_active_display()

        self._display_seconds = display_seconds
        self._apply_payload(payload)

        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()
        self.visible = True
        self._alpha = 1.0
        opacity = float(self.config.get("overlayOpacity", 0.88))
        self.root.attributes("-alpha", opacity)
        self._on_show_ready()
        self._start_countdown(display_seconds)

    def dismiss_immediately(self):
        if not self.visible:
            return

        self._stop_active_display()

        self._alpha = 0.0
        self.root.attributes("-alpha", 0.0)
        self.root.withdraw()
        self.visible = False
        self.canvas.itemconfigure(self.countdown_text, text="")
        self.message_viewport.place_forget()
        self._notify_closed()

    def hide(self):
        if not self.visible:
            return
        self._cancel_countdown()
        if self._hide_job:
            self.root.after_cancel(self._hide_job)
            self._hide_job = None
        if self._scroller:
            self._scroller.stop()
        self._fade_to(0.0, self.config["fadeOutMs"], on_done=self._finish_hide)

    def _finish_hide(self):
        self.root.withdraw()
        self.visible = False
        self._hide_job = None
        self.canvas.itemconfigure(self.countdown_text, text="")
        self.message_viewport.place_forget()
        self._notify_closed()

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
            opacity = self._alpha * float(self.config.get("overlayOpacity", 0.88))
            self.root.attributes("-alpha", opacity)

            if step_index["value"] >= steps:
                self._alpha = target
                self.root.attributes("-alpha", target * float(self.config.get("overlayOpacity", 0.88)))
                if on_done:
                    on_done()
                return

            self._fade_job = self.root.after(16, step)

        step()
