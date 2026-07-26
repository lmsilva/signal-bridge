"""Steam Now Playing overlay panel (portrait-first)."""

from __future__ import annotations

import io
import ssl
import threading
import urllib.request
from datetime import datetime, timezone

try:
    from PIL import Image, ImageTk
except ImportError:
    Image = None
    ImageTk = None

from src.display_panels import BasePanel
from src.payload_utils import parse_iso_timestamp


class SteamNowPlayingPanel(BasePanel):
    """Portrait-first Steam Now Playing card (header / hero / tags / facts / footer)."""

    ACCENT = "#38bdf8"
    PILL_BG = "#1a2740"
    FOOTER_LINE = "#243147"

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
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
        self._photo_refs = []
        super().hide()

    def _stop_elapsed_tick(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None

    def _render(self, payload: dict):
        steam = payload.get("steam") or {}
        self._steam = steam
        started = steam.get("startedAt")
        self._started_at = parse_iso_timestamp(started) if started else None

        w = self.canvas.winfo_width() or self.root.winfo_screenwidth()
        h = self.canvas.winfo_height() or self.root.winfo_screenheight()
        portrait = h >= w
        margin = max(18, int(min(w, h) * 0.035))
        self._draw_background(0, 0, w, h)
        if portrait:
            self._layout_boxes = self._compute_portrait_boxes(margin, w, h)
        else:
            self._layout_boxes = self._compute_landscape_boxes(margin, w, h)
        self._draw_chrome(self._layout_boxes)
        self._draw_meta(self._layout_boxes, steam)
        self._draw_footer(self._layout_boxes, steam)
        self._start_image_fetches(steam)
        self._schedule_elapsed_tick()

    def _draw_background(self, x0, y0, x1, y1):
        self._item_ids.append(self.canvas.create_rectangle(
            x0, y0, x1, y1, fill="#070b14", outline="",
        ))

    def _compute_portrait_boxes(self, margin, w, h):
        header_h = int(h * 0.08)
        footer_h = int(h * 0.11)
        tags_h = int(h * 0.055)
        meta_h = int(h * 0.22)
        hero_top = margin + header_h + 8
        hero_bottom = h - margin - footer_h - meta_h - tags_h - 16
        if hero_bottom < hero_top + 120:
            hero_bottom = hero_top + 120
        return {
            "header": (margin, margin, w - margin, margin + header_h),
            "hero": (margin, hero_top, w - margin, hero_bottom),
            "tags": (margin, hero_bottom + 8, w - margin, hero_bottom + 8 + tags_h),
            "meta": (margin, hero_bottom + 8 + tags_h + 4, w - margin, h - margin - footer_h - 8),
            "footer": (margin, h - margin - footer_h, w - margin, h - margin),
        }

    def _compute_landscape_boxes(self, margin, w, h):
        header_h = int(h * 0.12)
        footer_h = int(h * 0.16)
        left_w = int((w - margin * 3) * 0.42)
        return {
            "header": (margin, margin, w - margin, margin + header_h),
            "hero": (margin, margin + header_h + 10, margin + left_w, h - margin - footer_h - 10),
            "tags": (
                margin + left_w + margin,
                margin + header_h + 10,
                w - margin,
                margin + header_h + 10 + int(h * 0.08),
            ),
            "meta": (
                margin + left_w + margin,
                margin + header_h + 10 + int(h * 0.08) + 6,
                w - margin,
                h - margin - footer_h - 10,
            ),
            "footer": (margin, h - margin - footer_h, w - margin, h - margin),
        }

    def _fmt_clock(self, dt):
        if not dt:
            return "--:--"
        local = dt.astimezone() if dt.tzinfo else dt
        return local.strftime("%I:%M %p").lstrip("0")

    def _fmt_elapsed(self):
        if self._started_at:
            start = self._started_at
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            seconds = max(
                0,
                int((datetime.now(timezone.utc) - start.astimezone(timezone.utc)).total_seconds()),
            )
        else:
            seconds = int(self._steam.get("elapsedSec") or 0)
        hours, rem = divmod(seconds, 3600)
        minutes = rem // 60
        if hours:
            return f"{hours}h {minutes}m"
        return f"{minutes}m"

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
        left_label = "LAST PLAYED" if last_played else "START TIME"
        left_value = self._fmt_last_played_date(start_dt) if last_played else self._fmt_clock(start_dt)
        badge = "LAST PLAYED" if last_played else "NOW PLAYING"
        badge_w = 168 if last_played else 160
        badge_outline = "#fbbf24" if last_played else "#e2e8f0"
        badge_fill = "#1c1408" if last_played else "#0b1220"
        badge_text = "#fde68a" if last_played else text
        self._item_ids.append(self.canvas.create_text(
            hx0, cy - 10, anchor="w", text=left_label, fill=self.ACCENT,
            font=self.shell.chip_label_font,
        ))
        self._item_ids.append(self.canvas.create_text(
            hx0, cy + 12, anchor="w", text=left_value, fill=text,
            font=self.shell.chip_value_font,
        ))
        badge_h = 36
        self._round_rect(
            mid_x - badge_w / 2, cy - badge_h / 2, mid_x + badge_w / 2, cy + badge_h / 2,
            8, outline=badge_outline, fill=badge_fill,
        )
        self._item_ids.append(self.canvas.create_text(
            mid_x, cy, anchor="center", text=badge, fill=badge_text,
            font=self.shell.chip_value_font,
        ))
        right_label = "PLAYTIME" if last_played else "ELAPSED"
        right_value = (self._steam.get("playtimeLabel") or "—") if last_played else self._fmt_elapsed()
        self._item_ids.append(self.canvas.create_text(
            hx1, cy - 10, anchor="e", text=right_label, fill=self.ACCENT,
            font=self.shell.chip_label_font,
        ))
        self._elapsed_value_id = self.canvas.create_text(
            hx1, cy + 12, anchor="e", text=right_value, fill=text,
            font=self.shell.chip_value_font,
        )
        self._item_ids.append(self._elapsed_value_id)

        x0, y0, x1, y1 = boxes["hero"]
        self._round_rect(x0, y0, x1, y1, 18, fill="#0d1524", outline="#1d2a40")
        self._hero_image_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_image_id)
        self._round_rect(x0 + 14, y0 + 14, x0 + 100, y0 + 42, 14, fill="#111827", outline="#334155")
        self._item_ids.append(self.canvas.create_text(
            x0 + 57, y0 + 28, anchor="center", text="STEAM", fill="#e2e8f0",
            font=self.shell.chip_label_font,
        ))

    def _draw_meta(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        tags = list(steam.get("tags") or [])[:4]
        tx0, ty0, tx1, ty1 = boxes["tags"]
        if tags:
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
        title_font = getattr(self.shell, "title_accent_font", None) or self.shell.chip_value_font
        self._item_ids.append(self.canvas.create_text(
            mx0, my0 + 4, anchor="nw", text=title, fill=text,
            font=title_font, width=int(mx1 - mx0),
        ))
        title_h = 32
        if credit:
            self._item_ids.append(self.canvas.create_text(
                mx0, my0 + title_h, anchor="nw", text=credit, fill=muted,
                font=self.shell.chip_label_font,
            ))
            desc_top = my0 + title_h + 22
        else:
            desc_top = my0 + title_h + 8
        desc = str(steam.get("shortDescription") or "")
        shots = list(steam.get("screenshots") or [])[:3]
        shot_h = int((my1 - desc_top) * 0.42) if shots else 0
        desc_bottom = my1 - shot_h - (12 if shots else 0)
        desc_font = getattr(self.shell, "forecast_label_font", None) or self.shell.chip_label_font
        if desc and desc_bottom > desc_top + 20:
            self._item_ids.append(self.canvas.create_text(
                mx0, desc_top, anchor="nw", text=desc, fill=muted,
                font=desc_font, width=int(mx1 - mx0),
            ))
        self._shot_ids = []
        if shots and shot_h > 40:
            gap = 10
            count = len(shots)
            cell_w = (mx1 - mx0 - gap * (count - 1)) / count
            for i in range(count):
                sx0 = mx0 + i * (cell_w + gap)
                sx1 = sx0 + cell_w
                sy0 = my1 - shot_h
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
        players_text = f"{int(players):,}" if players is not None else "—"
        cols = (
            ("YOUR PLAYTIME", playtime),
            ("ACHIEVEMENTS", ach_text),
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
        if self._is_last_played():
            return

        def tick():
            if not self.visible or self._elapsed_value_id is None:
                return
            try:
                self.canvas.itemconfigure(self._elapsed_value_id, text=self._fmt_elapsed())
            except Exception:
                pass
            self._tick_job = self.root.after(15_000, tick)

        self._tick_job = self.root.after(15_000, tick)

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
