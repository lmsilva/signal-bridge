"""Shared dismiss footer — band + draining rail + countdown (spec).

Used by the overlay for every timed page. Shared-photos slideshow/upload keep
their own content rails and must not use this component.
"""

from __future__ import annotations

import math
import time
import tkinter as tk
import tkinter.font as tkfont
from typing import Callable


from src.design_system import design_u


# Design canvas: 1080 × 1920. All geometry derives from --u (§8).
# Slightly tighter than the 96u design band — wall displays read better with
# a compact chrome strip (still full-bleed; content clears via footer_height).
BAND_H_U = 64
RAIL_H_U = 4
LABEL_SIZE_U = 22
ENDING_SEC = 10
EXTEND_MS = 300

# Approximate rgba() with solid hex (Tk canvas has no alpha fills).
BAND_FILL = "#000000"  # rgba(0,0,0,0.22) intent — solid system chrome plate
RAIL_TRACK = "#242428"  # ≈ white @ 0.14 over dark
RAIL_FILL = "#8c8c8c"  # ≈ white @ 0.55
RAIL_FILL_ENDING = "#d9d9d9"  # ≈ white @ 0.85
LABEL_COLOR = "#9e9e9e"  # ≈ white @ 0.62
LABEL_COLOR_ENDING = "#d9d9d9"  # ≈ white @ 0.85

PREFIX = "Dismisses in "
# Longest value form in the fixed slot ("2:56", "12:05", …).
SLOT_SAMPLE = "59:59"


def dismiss_u(screen_w: int, screen_h: int) -> float:
    """`--u` scale factor (vmin — same physical size in both orientations)."""
    return design_u(screen_w, screen_h)


def footer_height(screen_w: int, screen_h: int) -> int:
    return max(48, int(round(BAND_H_U * dismiss_u(screen_w, screen_h))))


def format_dismiss_value(remaining_seconds: int) -> str:
    """Format the value slot only (`43s` / `2:56`). Never returns `0s`."""
    remaining_seconds = max(1, int(remaining_seconds))
    minutes, seconds = divmod(remaining_seconds, 60)
    if minutes:
        return f"{minutes}:{seconds:02d}"
    return f"{remaining_seconds}s"


def format_dismiss_parts(
    remaining_seconds: int, *, finishing: bool = False,
) -> tuple[str, str]:
    """Return `(prefix, value)`. Finishing uses a single full-line string in prefix."""
    if finishing:
        return ("Finishing…", "")
    if remaining_seconds <= 0:
        return (PREFIX, format_dismiss_value(1))
    return (PREFIX, format_dismiss_value(remaining_seconds))


class DismissFooter:
    """Full-bleed bottom dismiss chrome. Props: timeout only — no theming knobs."""

    def __init__(
        self,
        canvas: tk.Canvas,
        root: tk.Misc,
        *,
        screen_w: int,
        screen_h: int,
        font_family: str = "Segoe UI",
        on_click: Callable | None = None,
    ):
        self.canvas = canvas
        self.root = root
        self.screen_w = int(screen_w)
        self.screen_h = int(screen_h)
        self.font_family = font_family
        self.on_click = on_click

        self._item_ids: list[int] = []
        self._visible = False
        self._timeout_ms = 0
        self._expires_at = 0.0
        self._started_at = 0.0
        self._tick_job = None
        self._rail_job = None
        self._extend_until = 0.0
        self._extend_from_frac = 1.0
        self._ending = False
        self._finishing = False

        self._rail_fill_id = None
        self._prefix_id = None
        self._value_id = None
        self._band_id = None
        self._track_id = None

        u = dismiss_u(self.screen_w, self.screen_h)
        size = max(12, int(round(LABEL_SIZE_U * u)))
        self._label_font = tkfont.Font(family=font_family, size=size, weight="normal")
        self._slot_w = max(self._label_font.measure(SLOT_SAMPLE), self._label_font.measure("99s"))
        self._prefix_w = self._label_font.measure(PREFIX)

    @property
    def band_top(self) -> int:
        return self.screen_h - footer_height(self.screen_w, self.screen_h)

    @property
    def rail_h(self) -> int:
        return max(2, int(round(RAIL_H_U * dismiss_u(self.screen_w, self.screen_h))))

    def _clear_items(self):
        for item_id in self._item_ids:
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
        self._item_ids.clear()
        self._rail_fill_id = None
        self._prefix_id = None
        self._value_id = None
        self._band_id = None
        self._track_id = None

    def _track(self, item_id: int) -> int:
        self._item_ids.append(item_id)
        try:
            self.canvas.itemconfigure(item_id, tags=("dismiss_footer",))
        except Exception:
            pass
        return item_id

    def _cancel_jobs(self):
        for attr in ("_tick_job", "_rail_job"):
            job = getattr(self, attr)
            if job is not None:
                try:
                    self.root.after_cancel(job)
                except Exception:
                    pass
                setattr(self, attr, None)

    def hide(self):
        self._cancel_jobs()
        self._clear_items()
        self._visible = False
        self._finishing = False
        self._ending = False
        self._timeout_ms = 0
        self._expires_at = 0.0

    def show(
        self,
        timeout_ms: int,
        *,
        expires_at: float | None = None,
        extend: bool = False,
    ):
        """Mount / remount. `timeout_ms` is the only page-facing prop."""
        timeout_ms = max(0, int(timeout_ms))
        if timeout_ms <= 0:
            self.hide()
            return

        now = time.time()
        new_expires = float(expires_at) if expires_at is not None else now + timeout_ms / 1000.0

        if extend and self._visible and self._timeout_ms > 0:
            # Grow rail back over 300ms ease-out, then drain at the new duration.
            old_frac = self._rail_fraction(now)
            self._extend_from_frac = max(0.0, min(1.0, old_frac))
            self._extend_until = now + EXTEND_MS / 1000.0
        else:
            self._extend_until = 0.0
            self._extend_from_frac = 1.0

        self._timeout_ms = timeout_ms
        self._expires_at = new_expires
        self._started_at = now
        self._finishing = False
        self._ending = False
        self._cancel_jobs()
        self._paint_shell()
        self._visible = True
        self._refresh(now)
        self._schedule_rail()
        self._schedule_tick()

    def set_finishing(self, finishing: bool = True):
        self._finishing = bool(finishing)
        if self._visible:
            self._refresh(time.time())

    def raise_(self):
        try:
            self.canvas.tag_raise("dismiss_footer")
        except Exception:
            pass

    def _paint_shell(self):
        self._clear_items()
        top = self.band_top
        rail_h = self.rail_h
        sw = self.screen_w
        sh = self.screen_h

        self._band_id = self._track(self.canvas.create_rectangle(
            0, top, sw, sh, fill=BAND_FILL, outline="",
        ))
        # Soft translucency cue — stipple over the solid plate.
        self._track(self.canvas.create_rectangle(
            0, top, sw, sh, fill=BAND_FILL, outline="", stipple="gray50",
        ))
        self._track_id = self._track(self.canvas.create_rectangle(
            0, top, sw, top + rail_h, fill=RAIL_TRACK, outline="",
        ))
        self._rail_fill_id = self._track(self.canvas.create_rectangle(
            0, top, sw, top + rail_h, fill=RAIL_FILL, outline="",
        ))

        cy = top + rail_h + (sh - top - rail_h) / 2
        total_w = self._prefix_w + self._slot_w
        left = sw / 2 - total_w / 2
        self._prefix_id = self._track(self.canvas.create_text(
            left, cy, anchor="w", text=PREFIX,
            fill=LABEL_COLOR, font=self._label_font,
        ))
        self._value_id = self._track(self.canvas.create_text(
            left + self._prefix_w, cy, anchor="w", text="",
            fill=LABEL_COLOR, font=self._label_font,
        ))

        if self.on_click:
            for item_id in self._item_ids:
                self.canvas.tag_bind(item_id, "<Button-1>", self.on_click)

        self.raise_()

    def _rail_fraction(self, now: float) -> float:
        """1.0 = full rail (just started), 0.0 = drained."""
        if self._timeout_ms <= 0:
            return 0.0
        remaining_ms = max(0.0, (self._expires_at - now) * 1000.0)
        return max(0.0, min(1.0, remaining_ms / self._timeout_ms))

    def _ease_out_cubic(self, t: float) -> float:
        t = max(0.0, min(1.0, t))
        return 1.0 - (1.0 - t) ** 3

    def _current_fill_fraction(self, now: float) -> float:
        target = self._rail_fraction(now)
        if self._extend_until and now < self._extend_until:
            t = 1.0 - (self._extend_until - now) / (EXTEND_MS / 1000.0)
            grown = self._extend_from_frac + (1.0 - self._extend_from_frac) * self._ease_out_cubic(t)
            return max(grown, target) if grown > target else grown
        return target

    def _refresh(self, now: float | None = None):
        if not self._visible:
            return
        now = time.time() if now is None else now
        remaining = max(0, int(math.ceil(self._expires_at - now)))
        ending = (not self._finishing) and 0 < remaining <= ENDING_SEC
        self._ending = ending

        fill_color = RAIL_FILL_ENDING if ending else RAIL_FILL
        label_color = LABEL_COLOR_ENDING if ending else LABEL_COLOR

        frac = self._current_fill_fraction(now)
        top = self.band_top
        rail_h = self.rail_h
        fill_w = self.screen_w * frac
        if self._rail_fill_id is not None:
            try:
                self.canvas.coords(self._rail_fill_id, 0, top, fill_w, top + rail_h)
                self.canvas.itemconfigure(self._rail_fill_id, fill=fill_color)
            except Exception:
                pass

        prefix, value = format_dismiss_parts(remaining, finishing=self._finishing)
        if self._finishing:
            if self._prefix_id is not None:
                try:
                    self.canvas.coords(
                        self._prefix_id,
                        self.screen_w / 2,
                        top + rail_h + (self.screen_h - top - rail_h) / 2,
                    )
                    self.canvas.itemconfigure(
                        self._prefix_id, text=prefix, fill=label_color, anchor="center",
                    )
                except Exception:
                    pass
            if self._value_id is not None:
                try:
                    self.canvas.itemconfigure(self._value_id, text="")
                except Exception:
                    pass
        else:
            cy = top + rail_h + (self.screen_h - top - rail_h) / 2
            total_w = self._prefix_w + self._slot_w
            left = self.screen_w / 2 - total_w / 2
            if self._prefix_id is not None:
                try:
                    self.canvas.coords(self._prefix_id, left, cy)
                    self.canvas.itemconfigure(
                        self._prefix_id, text=PREFIX, fill=label_color, anchor="w",
                    )
                except Exception:
                    pass
            if self._value_id is not None:
                try:
                    self.canvas.coords(self._value_id, left + self._prefix_w, cy)
                    self.canvas.itemconfigure(
                        self._value_id, text=value, fill=label_color, anchor="w",
                    )
                except Exception:
                    pass

        self.raise_()

    def _schedule_rail(self):
        def tick():
            if not self._visible:
                return
            self._refresh()
            self._rail_job = self.root.after(33, tick)

        self._rail_job = self.root.after(33, tick)

    def _schedule_tick(self):
        """Second-boundary text refresh (rail already ticks at 33ms)."""
        def tick():
            if not self._visible:
                return
            self._refresh()
            remaining = self._expires_at - time.time()
            if remaining > 0:
                delay = max(50, int((remaining - math.floor(remaining)) * 1000) or 1000)
                self._tick_job = self.root.after(min(1000, delay), tick)
            else:
                self._tick_job = None

        self._tick_job = self.root.after(200, tick)
