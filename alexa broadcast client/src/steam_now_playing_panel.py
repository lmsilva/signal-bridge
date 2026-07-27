"""Steam Now Playing overlay panel (portrait-first)."""

from __future__ import annotations

import io
import ssl
import threading
import tkinter as tk
import urllib.request
from datetime import datetime, timezone

try:
    from PIL import Image, ImageTk
except ImportError:
    Image = None
    ImageTk = None

from src.display_panels import BasePanel
from src.message_scroll import MessageScrollController
from src.payload_utils import parse_iso_timestamp


class SteamNowPlayingPanel(BasePanel):
    """Portrait-first Steam Now Playing card (header / hero / tags / facts / footer)."""

    ACCENT = "#38bdf8"
    PILL_BG = "#1a2740"
    FOOTER_LINE = "#243147"
    DESC_BG = "#070b14"

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self.needs_scroll = False
        self.scroller = None
        self._fetch_token = 0
        self._photo_refs = []
        self._tick_job = None
        self._started_at = None
        self._steam = {}
        self._layout_boxes = {}
        self._elapsed_value_id = None
        self._hero_image_id = None
        self._shot_ids = []

    def hide(self):
        self._fetch_token += 1
        self._stop_elapsed_tick()
        if self.scroller:
            self.scroller.stop()
        self.scroller = None
        self.needs_scroll = False
        self._photo_refs = []
        super().hide()

    def _stop_elapsed_tick(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None

    def _content_rect(self):
        """Use OverlayShell layout / screen size — never canvas.winfo_* (often 1 pre-map)."""
        layout = self.shell.layout
        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or 0)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or 0)
        if screen_w < 64:
            screen_w = int(self.root.winfo_screenwidth() or 1920)
        if screen_h < 64:
            screen_h = int(self.root.winfo_screenheight() or 1080)
        x0 = int(layout.content_x)
        width = int(layout.content_width)
        top = int(screen_h * (0.03 if layout.portrait else 0.05))
        # Sit close to the dismiss clock so portrait doesn't strand empty band.
        countdown_y = int(getattr(layout, "countdown_y", 0) or 0)
        if countdown_y > 0:
            bottom = countdown_y - 24
        else:
            bottom = int(layout.message_area_bottom)
        if width < 64:
            width = int(screen_w * (0.82 if layout.portrait else 0.68))
            x0 = (screen_w - width) // 2
        if bottom <= top + 120:
            bottom = screen_h - 64
        return {
            "screen_w": screen_w,
            "screen_h": screen_h,
            "x0": x0,
            "y0": top,
            "x1": x0 + width,
            "y1": bottom,
            "portrait": bool(layout.portrait),
        }

    def _render(self, payload: dict):
        steam = payload.get("steam") or {}
        self._steam = steam
        started = steam.get("startedAt")
        self._started_at = parse_iso_timestamp(started) if started else None

        rect = self._content_rect()
        margin = max(12, int(min(rect["x1"] - rect["x0"], rect["y1"] - rect["y0"]) * 0.02))
        self._draw_background(0, 0, rect["screen_w"], rect["screen_h"])
        if rect["portrait"]:
            self._layout_boxes = self._compute_portrait_boxes(
                margin, rect["x0"], rect["y0"], rect["x1"], rect["y1"],
            )
        else:
            self._layout_boxes = self._compute_landscape_boxes(
                margin, rect["x0"], rect["y0"], rect["x1"], rect["y1"],
            )
        self._draw_chrome(self._layout_boxes)
        self._draw_meta(self._layout_boxes, steam)
        self._draw_footer(self._layout_boxes, steam)
        self._start_image_fetches(steam)
        self._schedule_elapsed_tick()

    def _draw_background(self, x0, y0, x1, y1):
        self._item_ids.append(self.canvas.create_rectangle(
            x0, y0, x1, y1, fill="#070b14", outline="",
        ))

    def _compute_portrait_boxes(self, margin, x0, y0, x1, y1):
        """Stack chrome → capped hero → tags → roomy meta → footer at the bottom."""
        height = max(200, y1 - y0)
        width = max(200, x1 - x0)
        header_h = max(56, int(height * 0.085))
        footer_h = max(70, int(height * 0.095))
        tags_h = max(34, int(height * 0.045))
        gap = 8
        # Cap the poster so title / description / screenshots get real space.
        usable = height - margin * 2 - header_h - footer_h - tags_h - gap * 4
        hero_h = min(
            int(height * 0.36),
            int(width * 0.92),
            max(160, int(usable * 0.48)),
        )
        hero_top = y0 + margin + header_h + gap
        hero_bottom = hero_top + hero_h
        tags_top = hero_bottom + gap
        tags_bottom = tags_top + tags_h
        meta_top = tags_bottom + gap
        meta_bottom = y1 - margin - footer_h - gap
        if meta_bottom < meta_top + 120:
            # Steal from hero when the screen is short.
            shrink = (meta_top + 120) - meta_bottom
            hero_bottom = max(hero_top + 140, hero_bottom - shrink)
            tags_top = hero_bottom + gap
            tags_bottom = tags_top + tags_h
            meta_top = tags_bottom + gap
            meta_bottom = y1 - margin - footer_h - gap
        return {
            "header": (x0 + margin, y0 + margin, x1 - margin, y0 + margin + header_h),
            "hero": (x0 + margin, hero_top, x1 - margin, hero_bottom),
            "tags": (x0 + margin, tags_top, x1 - margin, tags_bottom),
            "meta": (x0 + margin, meta_top, x1 - margin, meta_bottom),
            "footer": (x0 + margin, y1 - margin - footer_h, x1 - margin, y1 - margin),
            "_width": width,
            "_height": height,
        }

    def _compute_landscape_boxes(self, margin, x0, y0, x1, y1):
        height = max(200, y1 - y0)
        width = max(200, x1 - x0)
        header_h = int(height * 0.14)
        footer_h = int(height * 0.16)
        left_w = int((width - margin * 3) * 0.42)
        return {
            "header": (x0 + margin, y0 + margin, x1 - margin, y0 + margin + header_h),
            "hero": (
                x0 + margin,
                y0 + margin + header_h + 10,
                x0 + margin + left_w,
                y1 - margin - footer_h - 10,
            ),
            "tags": (
                x0 + margin + left_w + margin,
                y0 + margin + header_h + 10,
                x1 - margin,
                y0 + margin + header_h + 10 + int(height * 0.08),
            ),
            "meta": (
                x0 + margin + left_w + margin,
                y0 + margin + header_h + 10 + int(height * 0.08) + 6,
                x1 - margin,
                y1 - margin - footer_h - 10,
            ),
            "footer": (x0 + margin, y1 - margin - footer_h, x1 - margin, y1 - margin),
            "_width": width,
            "_height": height,
        }

    @staticmethod
    def _meta_band_heights(meta_box, has_shots: bool):
        """Split meta into title/credit, clipped description, and screenshot row."""
        _mx0, my0, _mx1, my1 = meta_box
        meta_h = max(0, my1 - my0)
        shot_h = 0
        if has_shots:
            shot_h = min(130, max(72, int(meta_h * 0.28)))
        title_band = min(96, max(56, int(meta_h * 0.22)))
        desc_h = max(0, meta_h - title_band - shot_h - (10 if has_shots else 0))
        return title_band, desc_h, shot_h

    def _fmt_clock(self, dt):
        if not dt:
            return "--:--"
        local = dt.astimezone() if dt.tzinfo else dt
        return local.strftime("%I:%M %p").lstrip("0")

    def _elapsed_seconds(self) -> int:
        """Seconds since this play session started (client clock vs startedAt)."""
        if self._started_at:
            start = self._started_at
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            return max(
                0,
                int((datetime.now(timezone.utc) - start.astimezone(timezone.utc)).total_seconds()),
            )
        return max(0, int(self._steam.get("elapsedSec") or 0))

    @staticmethod
    def format_elapsed(seconds: int) -> str:
        """Human elapsed for an active session: 45s → 12m 05s → 1h 03m."""
        seconds = max(0, int(seconds))
        hours, rem = divmod(seconds, 3600)
        minutes, secs = divmod(rem, 60)
        if hours:
            return f"{hours}h {minutes:02d}m"
        if minutes:
            return f"{minutes}m {secs:02d}s"
        return f"{secs}s"

    def _fmt_elapsed(self):
        return self.format_elapsed(self._elapsed_seconds())

    @staticmethod
    def format_ago(dt, *, now=None) -> str:
        """Relative age for last-played header (not a live session timer)."""
        if not dt:
            return "—"
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        now = now or datetime.now(timezone.utc)
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        seconds = max(0, int((now.astimezone(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds()))
        if seconds < 60:
            return "just now"
        if seconds < 3600:
            return f"{seconds // 60}m ago"
        if seconds < 86400:
            hours = seconds // 3600
            return f"{hours}h ago"
        days = seconds // 86400
        if days < 14:
            return f"{days}d ago"
        local = dt.astimezone()
        return local.strftime("%b %d").lstrip("0")

    def _round_rect(self, x0, y0, x1, y1, _radius, **kwargs):
        item = self.canvas.create_rectangle(x0, y0, x1, y1, **kwargs)
        self._item_ids.append(item)
        return item

    def _is_last_played(self):
        return str(self._steam.get("mode") or "playing") == "last-played"

    def _fmt_last_played_date(self, dt):
        if not dt:
            return "—"
        local = dt.astimezone() if dt.tzinfo else dt
        return local.strftime("%b %d · %I:%M %p").lstrip("0").replace(" 0", " ")

    def _draw_chrome(self, boxes):
        hx0, hy0, hx1, hy1 = boxes["header"]
        text = self.config.get("textColor", "#f8fafc")
        mid_x = (hx0 + hx1) / 2
        cy = (hy0 + hy1) / 2
        last_played = self._is_last_played()
        start_dt = self._started_at
        if last_played:
            last_raw = self._steam.get("lastPlayedAt") or self._steam.get("startedAt")
            start_dt = parse_iso_timestamp(last_raw) if last_raw else start_dt
        # Avoid duplicating "LAST PLAYED" on both the left chip and center badge.
        left_label = "WHEN" if last_played else "START TIME"
        left_value = self._fmt_last_played_date(start_dt) if last_played else self._fmt_clock(start_dt)
        badge = "LAST PLAYED" if last_played else "NOW PLAYING"
        # Same cool slate/cyan language as tags + chrome (not amber).
        badge_outline = self.ACCENT if last_played else "#e2e8f0"
        badge_fill = "#0b1220"
        badge_text = self.ACCENT if last_played else text
        badge_font = (
            getattr(self.shell, "section_label_font", None)
            or getattr(self.shell, "body_font", None)
            or self.shell.chip_value_font
        )
        pad_x = 28
        pad_y = 16
        try:
            text_w = int(badge_font.measure(badge))
            text_h = int(badge_font.metrics("linespace"))
        except Exception:
            text_w = 200 if last_played else 180
            text_h = 28
        badge_w = text_w + pad_x * 2
        badge_h = max(48, text_h + pad_y * 2)
        self._item_ids.append(self.canvas.create_text(
            hx0, cy - 10, anchor="w", text=left_label, fill=self.ACCENT,
            font=self.shell.chip_label_font,
        ))
        self._item_ids.append(self.canvas.create_text(
            hx0, cy + 12, anchor="w", text=left_value, fill=text,
            font=self.shell.chip_value_font,
        ))
        self._round_rect(
            mid_x - badge_w / 2, cy - badge_h / 2, mid_x + badge_w / 2, cy + badge_h / 2,
            12, outline=badge_outline, fill=badge_fill,
        )
        self._item_ids.append(self.canvas.create_text(
            mid_x, cy, anchor="center", text=badge, fill=badge_text,
            font=badge_font,
        ))
        if last_played:
            # Relative age since Steam's last-played stamp (session end / last
            # activity — Steam does not expose an exact "quit" time).
            right_label = "LAST PLAYED"
            right_value = self.format_ago(start_dt)
            self._elapsed_value_id = None
        else:
            right_label = "ELAPSED"
            right_value = self._fmt_elapsed()
        self._item_ids.append(self.canvas.create_text(
            hx1, cy - 10, anchor="e", text=right_label, fill=self.ACCENT,
            font=self.shell.chip_label_font,
        ))
        value_id = self.canvas.create_text(
            hx1, cy + 12, anchor="e", text=right_value, fill=text,
            font=self.shell.chip_value_font,
        )
        self._item_ids.append(value_id)
        if not last_played:
            self._elapsed_value_id = value_id

        x0, y0, x1, y1 = boxes["hero"]
        self._round_rect(x0, y0, x1, y1, 18, fill="#0d1524", outline="#1d2a40")
        self._hero_image_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_image_id)
        self._draw_steam_chip(x0, y0, x1, y1)

    def _draw_steam_chip(self, x0, y0, x1, y1):
        """Tiny corner badge — must not dominate the poster."""
        steam_font = (
            getattr(self.shell, "forecast_label_font", None)
            or self.shell.chip_label_font
        )
        label = "STEAM"
        pad_x, pad_y = 7, 2
        try:
            text_w = int(steam_font.measure(label))
            text_h = int(steam_font.metrics("linespace"))
        except Exception:
            text_w, text_h = 36, 11
        chip_w = min(text_w + pad_x * 2, max(40, int((x1 - x0) * 0.14)))
        chip_h = min(text_h + pad_y * 2, 18)
        inset = 8
        self._round_rect(
            x0 + inset, y0 + inset, x0 + inset + chip_w, y0 + inset + chip_h,
            6, fill="#0b1220", outline="#334155",
        )
        self._item_ids.append(self.canvas.create_text(
            x0 + inset + chip_w / 2, y0 + inset + chip_h / 2,
            anchor="center", text=label, fill="#94a3b8", font=steam_font,
        ))

    def _draw_meta(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        tags = list(steam.get("tags") or [])[:4]
        tx0, ty0, tx1, ty1 = boxes["tags"]
        if tags and ty1 > ty0 + 8:
            pill_gap = 8
            x = tx0
            for tag in tags:
                label = str(tag)
                tw = self.shell.chip_label_font.measure(label) + 24
                if x + tw > tx1:
                    break
                self._round_rect(x, ty0 + 4, x + tw, ty1 - 4, 12, fill=self.PILL_BG, outline="")
                self._item_ids.append(self.canvas.create_text(
                    x + tw / 2, (ty0 + ty1) / 2, anchor="center", text=label,
                    fill=self.ACCENT, font=self.shell.chip_label_font,
                ))
                x += tw + pill_gap

        mx0, my0, mx1, my1 = boxes["meta"]
        title = str(steam.get("name") or "Steam Game")
        developers = steam.get("developers") or []
        year = steam.get("releaseYear")
        credit_bits = []
        if developers:
            credit_bits.append(str(developers[0]))
        if year:
            credit_bits.append(str(year))
        credit = " · ".join(credit_bits)
        shots = list(steam.get("screenshots") or [])[:3]
        title_band, desc_h, shot_h = self._meta_band_heights(boxes["meta"], bool(shots))

        title_font = getattr(self.shell, "section_title_font", None) or self.shell.chip_value_font
        self._item_ids.append(self.canvas.create_text(
            mx0, my0 + 2, anchor="nw", text=title, fill=text,
            font=title_font, width=max(40, int(mx1 - mx0)),
        ))
        title_h = title_font.metrics("linespace") + 6
        credit_bottom = my0 + title_h
        if credit:
            self._item_ids.append(self.canvas.create_text(
                mx0, my0 + title_h, anchor="nw", text=credit, fill=muted,
                font=self.shell.chip_label_font,
            ))
            credit_bottom = my0 + title_h + self.shell.chip_label_font.metrics("linespace") + 8
        else:
            credit_bottom = my0 + title_h + 6

        # Description viewport is clipped so long copy never paints over shots.
        desc_top = min(credit_bottom, my0 + title_band)
        shot_top = my1 - shot_h if shot_h else my1
        desc_bottom = shot_top - (10 if shot_h else 0)
        desc_h = max(0, desc_bottom - desc_top)
        desc = str(steam.get("shortDescription") or "")
        desc_font = getattr(self.shell, "body_font", None) or self.shell.chip_label_font
        self.needs_scroll = False
        self.scroller = None
        if desc and desc_h >= 24:
            body_width = max(40, int(mx1 - mx0))
            viewport = tk.Canvas(
                self.root,
                width=body_width,
                height=max(1, int(desc_h)),
                highlightthickness=0,
                bd=0,
                bg=self.DESC_BG,
            )
            text_id = viewport.create_text(
                body_width / 2, 0, anchor="n", text="",
                fill=muted, font=desc_font, width=body_width, justify=tk.LEFT,
            )
            scroller = MessageScrollController(
                viewport, text_id, self.config, self.root, on_finish=lambda: None,
            )
            needs = scroller.configure(
                desc, center_x=body_width / 2, viewport_height=desc_h,
            )
            self.scroller = scroller
            self.needs_scroll = needs
            self._place_widget(viewport, x=int(mx0), y=int(desc_top))

        self._shot_ids = []
        if shots and shot_h >= 40:
            gap = 10
            count = len(shots)
            cell_w = (mx1 - mx0 - gap * (count - 1)) / count
            for i in range(count):
                sx0 = mx0 + i * (cell_w + gap)
                sx1 = sx0 + cell_w
                sy0 = shot_top
                sy1 = my1
                self._round_rect(sx0, sy0, sx1, sy1, 10, fill="#101b2d", outline="#1d2a40")
                img_id = self.canvas.create_image((sx0 + sx1) / 2, (sy0 + sy1) / 2, anchor="center")
                self._item_ids.append(img_id)
                self._shot_ids.append((img_id, sx1 - sx0 - 8, sy1 - sy0 - 8))

    def _draw_footer(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        fx0, fy0, fx1, fy1 = boxes["footer"]
        self._item_ids.append(self.canvas.create_line(fx0, fy0, fx1, fy0, fill=self.FOOTER_LINE))
        achievements = steam.get("achievements") or {}
        playtime = steam.get("playtimeLabel") or "—"
        if achievements.get("available") and achievements.get("earned") is not None:
            ach_text = f"{achievements.get('earned')} / {achievements.get('total') or '?'}"
        else:
            ach_text = "—"
        players = steam.get("currentPlayers")
        if players is not None:
            count = int(players)
            unit = "player" if count == 1 else "players"
            players_text = f"{count:,} {unit}"
        else:
            players_text = "—"
        cols = (
            ("YOUR PLAYTIME", playtime),
            ("ACHIEVEMENTS", ach_text),
            # Steam GetNumberOfCurrentPlayers — worldwide concurrent players.
            ("PLAYING NOW", players_text),
        )
        col_w = (fx1 - fx0) / 3
        for i, (label, value) in enumerate(cols):
            cx = fx0 + col_w * i + col_w / 2
            self._item_ids.append(self.canvas.create_text(
                cx, fy0 + 14, anchor="n", text=label, fill=muted,
                font=self.shell.chip_label_font,
            ))
            self._item_ids.append(self.canvas.create_text(
                cx, fy0 + 36, anchor="n", text=value, fill=text,
                font=self.shell.chip_value_font,
            ))

    def _schedule_elapsed_tick(self):
        self._stop_elapsed_tick()
        if self._is_last_played() or self._elapsed_value_id is None:
            return

        def tick():
            if not self.visible or self._elapsed_value_id is None:
                return
            try:
                self.canvas.itemconfigure(self._elapsed_value_id, text=self._fmt_elapsed())
            except Exception:
                pass
            # 1s cadence so the counter tracks the real session length.
            self._tick_job = self.root.after(1_000, tick)

        self._tick_job = self.root.after(1_000, tick)

    def _start_image_fetches(self, steam):
        self._fetch_token += 1
        token = self._fetch_token
        hero_box = self._layout_boxes.get("hero")
        if hero_box:
            x0, y0, x1, y1 = hero_box
            max_w = max(40, int(x1 - x0 - 24))
            max_h = max(40, int(y1 - y0 - 24))
            candidates = list(steam.get("posterCandidates") or [])
            if steam.get("headerImage"):
                candidates.append(steam["headerImage"])
            threading.Thread(
                target=self._fetch_first_image,
                args=(token, candidates, max_w, max_h, "hero"),
                daemon=True,
            ).start()
        for index, (img_id, max_w, max_h) in enumerate(self._shot_ids):
            urls = list(steam.get("screenshots") or [])
            if index >= len(urls):
                continue
            threading.Thread(
                target=self._fetch_first_image,
                args=(token, [urls[index]], int(max_w), int(max_h), ("shot", index, img_id)),
                daemon=True,
            ).start()

    def _fetch_first_image(self, token, urls, max_w, max_h, target):
        image = None
        for url in urls:
            image = self._fetch_photo(url, max_w, max_h)
            if image is not None:
                break
        self.root.after(0, lambda: self._apply_image(token, image, target))

    def _apply_image(self, token, image, target):
        if token != self._fetch_token or not self.visible or image is None or ImageTk is None:
            return
        photo = ImageTk.PhotoImage(image)
        self._photo_refs.append(photo)
        if target == "hero":
            try:
                self.canvas.itemconfigure(self._hero_image_id, image=photo)
            except Exception:
                pass
            return
        _kind, _index, img_id = target
        try:
            self.canvas.itemconfigure(img_id, image=photo)
        except Exception:
            pass

    @classmethod
    def _fetch_photo(cls, url: str, max_w: int, max_h: int):
        if not url or Image is None:
            return None
        try:
            context = ssl.create_default_context()
            request = urllib.request.Request(
                url, headers={"User-Agent": "alexa-broadcast-client/1.0"},
            )
            with urllib.request.urlopen(request, timeout=10, context=context) as response:
                data = response.read()
            image = Image.open(io.BytesIO(data)).convert("RGB")
            image.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
            return image
        except Exception:
            return None
