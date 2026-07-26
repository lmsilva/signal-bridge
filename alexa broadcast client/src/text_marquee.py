"""Reusable single-line horizontal marquee for "now playing"-style text
that's too wide for its column.

Mirrors the pause/scroll/pause cadence of the vertical broadcast-message
scroller (`message_scroll.py`) — pause at the start so it's readable,
scroll left until the tail comes into view, pause there, then snap back
to the start and repeat. That's the same marquee behavior most media
players and car head units use for long track/artist/album titles, and
it loops indefinitely (there's no dismiss timer to sync with here — the
panel just keeps looping until it's hidden).
"""

from __future__ import annotations

import time
import tkinter as tk


class MarqueeLine:
    """Owns one nested viewport ``tk.Canvas`` + text item for a single
    line of text.

    If the text fits within ``width`` it's drawn once, centered (or
    left-aligned), and left completely static — no animation, no tick
    overhead. If it overflows, the text is left-aligned inside the
    viewport (which clips anything outside its own bounds) and animated
    on a loop.
    """

    TICK_MS = 33
    START_PAUSE_MS = 1400
    END_PAUSE_MS = 1200
    PIXELS_PER_SECOND = 60

    def __init__(self, root: tk.Tk):
        self.root = root
        self.viewport: tk.Canvas | None = None
        self._text_id = None
        self._tick_job = None
        self._offset = 0.0
        self._max_scroll = 0.0
        self._state = "idle"
        self._height = 0
        self._last_tick_at = 0.0

    def stop(self):
        if self._tick_job:
            self.root.after_cancel(self._tick_job)
            self._tick_job = None
        self._state = "idle"
        self.viewport = None
        self._text_id = None

    def build(
        self,
        *,
        parent: tk.Widget,
        text: str,
        font,
        fill: str,
        width: int,
        height: int,
        bg: str,
        center: bool = True,
    ) -> tk.Canvas:
        """Creates (and returns, unplaced) the viewport widget for this
        line — the caller places it (e.g. via ``BasePanel._place_widget``)
        so it's tracked/torn down like any other panel widget."""
        self.stop()
        self._height = height
        self.viewport = tk.Canvas(
            parent, width=width, height=height, highlightthickness=0, bd=0, bg=bg,
        )
        text_width = font.measure(text)
        if text_width <= width:
            anchor = "center" if center else "w"
            x = width // 2 if center else 0
            self.viewport.create_text(x, height // 2, anchor=anchor, text=text, font=font, fill=fill)
            return self.viewport

        self._text_id = self.viewport.create_text(
            0, height // 2, anchor="w", text=text, font=font, fill=fill,
        )
        self._max_scroll = float(text_width - width)
        self._offset = 0.0
        self._apply_position()
        self._state = "start_pause"
        self._schedule_tick(self.START_PAUSE_MS)
        return self.viewport

    def _apply_position(self):
        if self._text_id is None or self.viewport is None:
            return
        self.viewport.coords(self._text_id, -int(round(self._offset)), self._height // 2)

    def _schedule_tick(self, delay_ms: int):
        self._last_tick_at = time.monotonic()
        self._tick_job = self.root.after(delay_ms, self._tick)

    def _tick(self):
        self._tick_job = None
        if self.viewport is None:
            return
        now = time.monotonic()
        elapsed_ms = max(0.0, (now - self._last_tick_at) * 1000)
        self._last_tick_at = now

        if self._state == "start_pause":
            self._state = "scrolling"
            self._schedule_tick(self.TICK_MS)
            return

        if self._state == "scrolling":
            step = self.PIXELS_PER_SECOND * (elapsed_ms / 1000.0)
            self._offset = min(self._max_scroll, self._offset + step)
            self._apply_position()
            if self._offset >= self._max_scroll:
                self._state = "end_pause"
                self._schedule_tick(self.END_PAUSE_MS)
            else:
                self._schedule_tick(self.TICK_MS)
            return

        if self._state == "end_pause":
            self._offset = 0.0
            self._apply_position()
            self._state = "start_pause"
            self._schedule_tick(self.START_PAUSE_MS)
            return
