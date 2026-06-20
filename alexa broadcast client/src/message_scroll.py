import time


class MessageScrollController:
    """Scrolls long broadcast text vertically with timer-aware dismissal."""

    TICK_MS = 33

    def __init__(self, viewport, text_id, config, root, on_finish):
        self.viewport = viewport
        self.text_id = text_id
        self.config = config
        self.root = root
        self.on_finish = on_finish

        self._tick_job = None
        self._state = "idle"
        self._offset = 0.0
        self._max_scroll = 0.0
        self._needs_scroll = False
        self._timer_expired = False
        self._completed_a_cycle = False
        self._center_x = 0
        self._last_tick_at = 0.0

    def stop(self):
        if self._tick_job:
            self.root.after_cancel(self._tick_job)
            self._tick_job = None
        self._state = "idle"

    def configure(self, message: str, center_x: int, viewport_height: int) -> bool:
        max_chars = int(self.config.get("maxMessageCharacters", 8000))
        if len(message) > max_chars:
            message = f"{message[: max_chars - 1].rstrip()}…"

        self._center_x = center_x
        self.viewport.itemconfigure(self.text_id, text=message)
        self.viewport.update_idletasks()

        bbox = self.viewport.bbox(self.text_id)
        text_height = (bbox[3] - bbox[1]) if bbox else 0
        self._max_scroll = max(0.0, float(text_height - viewport_height))
        self._needs_scroll = self._max_scroll > 0
        self._offset = 0.0
        self._timer_expired = False
        self._completed_a_cycle = False
        self._apply_position()
        return self._needs_scroll

    def mark_timer_expired(self):
        self._timer_expired = True

    @property
    def needs_scroll(self) -> bool:
        return self._needs_scroll

    def start(self):
        self.stop()
        if not self._needs_scroll:
            return
        self._state = "start_pause"
        self._offset = 0.0
        self._completed_a_cycle = False
        self._apply_position()
        self._schedule_tick(self._start_pause_ms())

    def _start_pause_ms(self) -> int:
        return int(self.config.get("scrollStartPauseMs", 1800))

    def _end_pause_ms(self) -> int:
        return int(self.config.get("scrollEndPauseMs", 2500))

    def _pixels_per_second(self) -> float:
        return float(self.config.get("scrollPixelsPerSecond", 28))

    def _apply_position(self):
        if not self._needs_scroll:
            bbox = self.viewport.bbox(self.text_id)
            text_height = (bbox[3] - bbox[1]) if bbox else 0
            viewport_height = int(self.viewport["height"])
            y = max(0, (viewport_height - text_height) // 2)
        else:
            y = -int(round(self._offset))
        self.viewport.coords(self.text_id, self._center_x, y)

    def _schedule_tick(self, delay_ms: int):
        self._last_tick_at = time.monotonic()
        self._tick_job = self.root.after(delay_ms, self._tick)

    def _tick(self):
        self._tick_job = None
        now = time.monotonic()
        elapsed_ms = max(0.0, (now - self._last_tick_at) * 1000)
        self._last_tick_at = now

        if self._state == "start_pause":
            if self._timer_expired and self._completed_a_cycle:
                self.stop()
                self.on_finish()
                return
            self._state = "scrolling"
            self._schedule_tick(self.TICK_MS)
            return

        if self._state == "scrolling":
            step = self._pixels_per_second() * (elapsed_ms / 1000.0)
            self._offset = min(self._max_scroll, self._offset + step)
            self._apply_position()

            if self._offset >= self._max_scroll:
                self._state = "end_pause"
                self._schedule_tick(self._end_pause_ms())
            else:
                self._schedule_tick(self.TICK_MS)
            return

        if self._state == "end_pause":
            if self._timer_expired:
                self.stop()
                self.on_finish()
                return

            self._completed_a_cycle = True
            self._offset = 0.0
            self._apply_position()
            self._state = "start_pause"
            self._schedule_tick(self._start_pause_ms())
