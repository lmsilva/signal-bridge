"""Steam Now Playing overlay panel (portrait-first)."""

from __future__ import annotations

import hashlib
import io
import ssl
import threading
import tkinter as tk
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

try:
    from PIL import Image, ImageTk, ImageFilter, ImageEnhance
except ImportError:
    Image = None
    ImageTk = None
    ImageFilter = None
    ImageEnhance = None

from src.display_panels import BasePanel
from src.message_scroll import MessageScrollController
from src.payload_utils import parse_iso_timestamp
from src.paths import app_root

# Frozen builds / bridge self-signed certs: once unverified works, stick with it.
_unverified_ssl = False

# Portrait library capsule vs landscape header / hero art.
_PORTRAIT_HERO_WH = 600 / 900  # width / height ≈ 0.667
_LANDSCAPE_HERO_WH = 460 / 215  # Steam header ≈ 2.14


def _is_ssl_failure(error: BaseException) -> bool:
    current: BaseException | None = error
    while current is not None:
        if "CERTIFICATE_VERIFY_FAILED" in str(current) or "SSL" in str(current):
            return True
        current = getattr(current, "reason", None) or getattr(current, "__cause__", None)
    return False


def steam_image_cache_dir() -> Path:
    return app_root() / "steam-artwork-cache"


def steam_image_cache_path(url: str) -> Path:
    text = str(url or "")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]
    # Keep a hint of the original extension for easier debugging on disk.
    ext = Path(urlsplit(text).path).suffix.lower()
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".img"
    return steam_image_cache_dir() / f"{digest}{ext}"


def hero_aspect_hint(steam: dict | None) -> float:
    """
    Guess hero width/height from Steam CDN URL names before pixels land.

    Portrait library capsules → tall box that the art can fill.
    Header / library_hero → short wide box (avoids letterboxing landscape art
    inside a tall portrait frame — the Denshattack regression).
    """
    steam = steam or {}
    urls = []
    for key in ("posterCandidates",):
        urls.extend(steam.get(key) or [])
    if steam.get("headerImage"):
        urls.append(steam["headerImage"])
    if steam.get("capsuleImage"):
        urls.append(steam["capsuleImage"])
    joined = " ".join(str(u).lower() for u in urls)
    if any(
        token in joined
        for token in ("library_600x900", "library_capsule", "portrait.png")
    ):
        return _PORTRAIT_HERO_WH
    if any(
        token in joined
        for token in ("header.jpg", "header_image", "library_hero", "capsule_616x353")
    ):
        return _LANDSCAPE_HERO_WH
    # Default: assume portrait library (Steam almost always has 600x900).
    return _PORTRAIT_HERO_WH


def fit_image_cover(image, max_w: int, max_h: int):
    """Scale + center-crop so the image fills the target box (no letterboxing)."""
    if image is None or Image is None:
        return None
    max_w = max(1, int(max_w))
    max_h = max(1, int(max_h))
    src_w, src_h = image.size
    if src_w < 1 or src_h < 1:
        return None
    scale = max(max_w / src_w, max_h / src_h)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resized = image.resize((new_w, new_h), Image.Resampling.LANCZOS)
    left = max(0, (new_w - max_w) // 2)
    top = max(0, (new_h - max_h) // 2)
    return resized.crop((left, top, left + max_w, top + max_h))


def fit_image_contain(image, max_w: int, max_h: int):
    """Scale to fit inside the box (may letterbox — used for screenshots)."""
    if image is None or Image is None:
        return None
    max_w = max(1, int(max_w))
    max_h = max(1, int(max_h))
    copy = image.copy()
    copy.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    return copy


class SteamNowPlayingPanel(BasePanel):
    """Portrait-first Steam Now Playing card — large aspect-aware hero + dense meta."""

    ACCENT = "#38bdf8"
    PILL_BG = "#1a2740"
    FOOTER_LINE = "#243147"
    DESC_BG = "#070b14"
    HERO_PAD = 2  # near-flush art inside the hero frame (was 24 → tiny poster)

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
        self._hero_glow_id = None
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
        # Steam panel uses a wider column than generic overlays — mockups keep
        # only a slim gutter so the poster can dominate.
        if layout.portrait:
            width = int(screen_w * 0.90)
            x0 = (screen_w - width) // 2
        else:
            x0 = int(layout.content_x)
            width = int(layout.content_width)
            if width < 64:
                width = int(screen_w * 0.78)
                x0 = (screen_w - width) // 2
        top = int(screen_h * (0.022 if layout.portrait else 0.04))
        countdown_y = int(getattr(layout, "countdown_y", 0) or 0)
        if countdown_y > 0:
            bottom = countdown_y - 18
        else:
            bottom = int(layout.message_area_bottom)
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
        margin = max(10, int(min(rect["x1"] - rect["x0"], rect["y1"] - rect["y0"]) * 0.015))
        self._draw_background(0, 0, rect["screen_w"], rect["screen_h"])
        aspect = hero_aspect_hint(steam)
        if rect["portrait"]:
            self._layout_boxes = self._compute_portrait_boxes(
                margin, rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                aspect_wh=aspect,
                has_shots=bool(steam.get("screenshots")),
            )
        else:
            self._layout_boxes = self._compute_landscape_boxes(
                margin, rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                aspect_wh=aspect,
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

    def _compute_portrait_boxes(self, margin, x0, y0, x1, y1, *, aspect_wh=None, has_shots=True):
        """
        Stack: header → large aspect-aware hero → meta (title/tags/desc)
        → big screenshot row → stats footer.

        Hero height follows artwork aspect so landscape headers are not
        letterboxed inside a tall portrait frame.
        """
        height = max(200, y1 - y0)
        width = max(200, x1 - x0)
        aspect_wh = float(aspect_wh or _PORTRAIT_HERO_WH)
        header_h = max(48, int(height * 0.07))
        footer_h = max(64, int(height * 0.085))
        gap = 8
        content_w = width - margin * 2

        shots_h = 0
        if has_shots:
            shots_h = min(168, max(96, int(height * 0.13)))

        meta_min = max(140, int(height * 0.16))
        usable = height - margin * 2 - header_h - footer_h - shots_h - gap * (4 if has_shots else 3)

        ideal_hero = int(content_w / max(0.35, aspect_wh))
        max_hero = max(180, usable - meta_min)
        soft_cap = int(height * (0.52 if aspect_wh < 1.0 else 0.34))
        hero_h = max(160, min(ideal_hero, max_hero, soft_cap))

        hero_top = y0 + margin + header_h + gap
        hero_bottom = hero_top + hero_h
        meta_top = hero_bottom + gap
        meta_bottom = y1 - margin - footer_h - gap - (shots_h + gap if shots_h else 0)
        if meta_bottom < meta_top + meta_min:
            shrink = (meta_top + meta_min) - meta_bottom
            hero_bottom = max(hero_top + 140, hero_bottom - shrink)
            meta_top = hero_bottom + gap
            meta_bottom = y1 - margin - footer_h - gap - (shots_h + gap if shots_h else 0)

        shots_top = meta_bottom + gap if shots_h else meta_bottom
        shots_bottom = shots_top + shots_h if shots_h else shots_top
        footer_top = y1 - margin - footer_h

        return {
            "header": (x0 + margin, y0 + margin, x1 - margin, y0 + margin + header_h),
            "hero": (x0 + margin, hero_top, x1 - margin, hero_bottom),
            "meta": (x0 + margin, meta_top, x1 - margin, meta_bottom),
            "shots": (x0 + margin, shots_top, x1 - margin, shots_bottom),
            "footer": (x0 + margin, footer_top, x1 - margin, y1 - margin),
            "_width": width,
            "_height": height,
            "_aspect_wh": aspect_wh,
        }

    def _compute_landscape_boxes(self, margin, x0, y0, x1, y1, *, aspect_wh=None):
        height = max(200, y1 - y0)
        width = max(200, x1 - x0)
        aspect_wh = float(aspect_wh or _PORTRAIT_HERO_WH)
        header_h = int(height * 0.12)
        footer_h = int(height * 0.14)
        left_frac = 0.46 if aspect_wh < 1.0 else 0.50
        left_w = int((width - margin * 3) * left_frac)
        return {
            "header": (x0 + margin, y0 + margin, x1 - margin, y0 + margin + header_h),
            "hero": (
                x0 + margin,
                y0 + margin + header_h + 8,
                x0 + margin + left_w,
                y1 - margin - footer_h - 8,
            ),
            "meta": (
                x0 + margin + left_w + margin,
                y0 + margin + header_h + 8,
                x1 - margin,
                y1 - margin - footer_h - 8,
            ),
            "shots": (0, 0, 0, 0),
            "footer": (x0 + margin, y1 - margin - footer_h, x1 - margin, y1 - margin),
            "_width": width,
            "_height": height,
            "_aspect_wh": aspect_wh,
        }

    @staticmethod
    def _meta_band_heights(meta_box, has_shots: bool, *, shots_separate: bool = False):
        """Split meta into title/credit+tags and clipped description (+ optional shots)."""
        _mx0, my0, _mx1, my1 = meta_box
        meta_h = max(0, my1 - my0)
        shot_h = 0
        if has_shots and not shots_separate:
            shot_h = min(150, max(88, int(meta_h * 0.34)))
        title_band = min(110, max(64, int(meta_h * 0.30)))
        desc_h = max(0, meta_h - title_band - shot_h - (8 if shot_h else 0))
        return title_band, desc_h, shot_h

    def _fmt_clock(self, dt):
        if not dt:
            return "--:--"
        local = dt.astimezone() if dt.tzinfo else dt
        return local.strftime("%I:%M %p").lstrip("0")

    def _elapsed_seconds(self) -> int:
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

    def _draw_corner_brackets(self, x0, y0, x1, y1, length=22, color="#e2e8f0"):
        """Mockup-style L brackets instead of a heavy full-bleed frame."""
        w = 2
        self._item_ids.append(self.canvas.create_line(x0, y0, x0 + length, y0, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x0, y0, x0, y0 + length, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x1 - length, y0, x1, y0, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x1, y0, x1, y0 + length, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x0, y1, x0 + length, y1, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x0, y1 - length, x0, y1, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x1 - length, y1, x1, y1, fill=color, width=w))
        self._item_ids.append(self.canvas.create_line(x1, y1 - length, x1, y1, fill=color, width=w))

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
        left_label = "WHEN" if last_played else "START TIME"
        left_value = self._fmt_last_played_date(start_dt) if last_played else self._fmt_clock(start_dt)
        badge = "LAST PLAYED" if last_played else "NOW PLAYING"
        badge_outline = self.ACCENT if last_played else "#e2e8f0"
        badge_fill = "#0b1220"
        badge_text = self.ACCENT if last_played else text
        badge_font = (
            getattr(self.shell, "section_label_font", None)
            or getattr(self.shell, "body_font", None)
            or self.shell.chip_value_font
        )
        pad_x = 28
        pad_y = 14
        try:
            text_w = int(badge_font.measure(badge))
            text_h = int(badge_font.metrics("linespace"))
        except Exception:
            text_w = 200 if last_played else 180
            text_h = 28
        badge_w = text_w + pad_x * 2
        badge_h = max(44, text_h + pad_y * 2)
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
        self._round_rect(x0, y0, x1, y1, 14, fill="#0a101c", outline="")
        self._hero_glow_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_glow_id)
        self._hero_image_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_image_id)
        self._draw_corner_brackets(x0, y0, x1, y1)
        self._draw_steam_chip(x0, y0, x1, y1)

    def _draw_steam_chip(self, x0, y0, x1, y1):
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
        inset = 10
        self._round_rect(
            x0 + inset, y0 + inset, x0 + inset + chip_w, y0 + inset + chip_h,
            6, fill="#0b1220", outline="#334155",
        )
        self._item_ids.append(self.canvas.create_text(
            x0 + inset + chip_w / 2, y0 + inset + chip_h / 2,
            anchor="center", text=label, fill="#94a3b8", font=steam_font,
        ))

    def _draw_tags(self, tags, tx0, ty0, tx1, ty1):
        if not tags or ty1 <= ty0 + 8:
            return ty0
        pill_gap = 8
        x = tx0
        row_y0 = ty0
        row_h = max(22, ty1 - ty0)
        for tag in tags:
            label = str(tag)
            try:
                tw = self.shell.chip_label_font.measure(label) + 22
            except Exception:
                tw = len(label) * 8 + 22
            if x + tw > tx1:
                break
            self._round_rect(
                x, row_y0, x + tw, row_y0 + row_h, 10,
                fill="", outline=self.ACCENT,
            )
            self._item_ids.append(self.canvas.create_text(
                x + tw / 2, row_y0 + row_h / 2, anchor="center", text=label,
                fill=self.ACCENT, font=self.shell.chip_label_font,
            ))
            x += tw + pill_gap
        return row_y0 + row_h

    def _draw_meta(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        tags = list(steam.get("tags") or [])[:4]
        mx0, my0, mx1, my1 = boxes["meta"]
        title = str(steam.get("name") or "Steam Game")
        developers = steam.get("developers") or []
        year = steam.get("releaseYear")
        credit_bits = []
        if developers:
            credit_bits.append(str(developers[0]).upper())
        if year:
            credit_bits.append(str(year))
        credit = " · ".join(credit_bits)

        shots_box = boxes.get("shots") or (0, 0, 0, 0)
        shots_separate = shots_box[3] > shots_box[1] + 20
        shots = list(steam.get("screenshots") or [])[:3]
        title_band, _desc_unused, shot_h = self._meta_band_heights(
            boxes["meta"], bool(shots) and not shots_separate, shots_separate=shots_separate,
        )

        title_font = getattr(self.shell, "section_title_font", None) or self.shell.chip_value_font
        credit_font = self.shell.chip_label_font
        self._item_ids.append(self.canvas.create_text(
            mx0, my0 + 2, anchor="nw", text=title, fill=text,
            font=title_font,
        ))
        try:
            title_h = title_font.metrics("linespace")
            title_w = title_font.measure(title)
        except Exception:
            title_h = 32
            title_w = 200
        if credit:
            credit_x = mx0 + title_w + 16
            if credit_x + 40 < mx1:
                try:
                    credit_ls = credit_font.metrics("linespace")
                except Exception:
                    credit_ls = 14
                self._item_ids.append(self.canvas.create_text(
                    credit_x, my0 + 2 + max(0, (title_h - credit_ls) // 2),
                    anchor="nw", text=credit, fill=muted, font=credit_font,
                ))
            else:
                self._item_ids.append(self.canvas.create_text(
                    mx0, my0 + title_h + 4, anchor="nw", text=credit, fill=muted,
                    font=credit_font,
                ))
                try:
                    title_h += credit_font.metrics("linespace") + 4
                except Exception:
                    title_h += 18

        tags_top = my0 + title_h + 10
        tags_bottom = self._draw_tags(tags, mx0, tags_top, mx1, tags_top + 28)
        credit_bottom = max(tags_bottom + 8, my0 + title_h + 8)

        desc_top = min(credit_bottom, my0 + title_band)
        if shots_separate:
            shot_top = my1
            desc_bottom = my1
        else:
            shot_top = my1 - shot_h if shot_h else my1
            desc_bottom = shot_top - (8 if shot_h else 0)
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
                0, 0, anchor="nw", text="",
                fill=text, font=desc_font, width=body_width, justify=tk.LEFT,
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
        if shots_separate and shots:
            sx0, sy0, sx1, sy1 = shots_box
            self._place_screenshot_row(shots, sx0, sy0, sx1, sy1)
        elif shots and shot_h >= 40:
            self._place_screenshot_row(shots, mx0, shot_top, mx1, my1)

    def _place_screenshot_row(self, shots, x0, y0, x1, y1):
        gap = 12
        count = min(3, len(shots))
        if count < 1 or y1 <= y0 + 8:
            return
        cell_w = (x1 - x0 - gap * (count - 1)) / count
        for i in range(count):
            sx0 = x0 + i * (cell_w + gap)
            sx1 = sx0 + cell_w
            self._round_rect(sx0, y0, sx1, y1, 10, fill="#101b2d", outline="#1d2a40")
            img_id = self.canvas.create_image((sx0 + sx1) / 2, (y0 + y1) / 2, anchor="center")
            self._item_ids.append(img_id)
            self._shot_ids.append((img_id, sx1 - sx0 - 4, y1 - y0 - 4))

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
            players_text = f"{int(players):,}"
        else:
            players_text = "—"
        cols = (
            ("PLAYTIME", playtime),
            ("ACHIEVEMENTS", ach_text),
            ("PLAYING NOW", players_text),
        )
        col_w = (fx1 - fx0) / 3
        for i, (label, value) in enumerate(cols):
            cx = fx0 + col_w * i + col_w / 2
            if i > 0:
                div_x = fx0 + col_w * i
                self._item_ids.append(self.canvas.create_line(
                    div_x, fy0 + 10, div_x, fy1 - 8, fill=self.FOOTER_LINE,
                ))
            self._item_ids.append(self.canvas.create_text(
                cx, fy0 + 12, anchor="n", text=label, fill=muted,
                font=self.shell.chip_label_font,
            ))
            self._item_ids.append(self.canvas.create_text(
                cx, fy0 + 34, anchor="n", text=value, fill=text,
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
            self._tick_job = self.root.after(1_000, tick)

        self._tick_job = self.root.after(1_000, tick)

    def _start_image_fetches(self, steam):
        self._fetch_token += 1
        token = self._fetch_token
        hero_box = self._layout_boxes.get("hero")
        if hero_box:
            x0, y0, x1, y1 = hero_box
            max_w = max(40, int(x1 - x0 - self.HERO_PAD * 2))
            max_h = max(40, int(y1 - y0 - self.HERO_PAD * 2))
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
            cached = self._load_cached_photo(url, max_w, max_h, cover=(target == "hero"))
            if cached is not None:
                self.root.after(0, lambda img=cached: self._apply_image(token, img, target))
                threading.Thread(
                    target=self._refresh_cached_photo,
                    args=(token, url, max_w, max_h, target),
                    daemon=True,
                ).start()
                return
            image = self._fetch_photo(url, max_w, max_h, force_network=True, cover=(target == "hero"))
            if image is not None:
                break
        self.root.after(0, lambda: self._apply_image(token, image, target))

    def _refresh_cached_photo(self, token, url, max_w, max_h, target):
        image = self._fetch_photo(url, max_w, max_h, force_network=True, cover=(target == "hero"))
        if image is None:
            return
        self.root.after(0, lambda: self._apply_image(token, image, target))

    def _make_glow(self, image, max_w, max_h):
        if image is None or Image is None or ImageFilter is None:
            return None
        try:
            glow_w = max(8, int(max_w * 1.08))
            glow_h = max(8, int(max_h * 1.08))
            base = image.copy().resize((glow_w, glow_h), Image.Resampling.LANCZOS)
            base = base.filter(ImageFilter.GaussianBlur(radius=18))
            if ImageEnhance is not None:
                base = ImageEnhance.Brightness(base).enhance(0.55)
            return base
        except Exception:
            return None

    def _apply_image(self, token, image, target):
        if token != self._fetch_token or not self.visible or image is None or ImageTk is None:
            return
        if target == "hero":
            hero_box = self._layout_boxes.get("hero")
            if hero_box:
                x0, y0, x1, y1 = hero_box
                max_w = max(40, int(x1 - x0 - self.HERO_PAD * 2))
                max_h = max(40, int(y1 - y0 - self.HERO_PAD * 2))
                glow = self._make_glow(image, max_w, max_h)
                if glow is not None and self._hero_glow_id:
                    glow_photo = ImageTk.PhotoImage(glow)
                    self._photo_refs.append(glow_photo)
                    try:
                        self.canvas.itemconfigure(self._hero_glow_id, image=glow_photo)
                    except Exception:
                        pass
            photo = ImageTk.PhotoImage(image)
            self._photo_refs.append(photo)
            try:
                self.canvas.itemconfigure(self._hero_image_id, image=photo)
            except Exception:
                pass
            return
        photo = ImageTk.PhotoImage(image)
        self._photo_refs.append(photo)
        _kind, _index, img_id = target
        try:
            self.canvas.itemconfigure(img_id, image=photo)
        except Exception:
            pass

    @classmethod
    def _load_cached_photo(cls, url: str, max_w: int, max_h: int, cover: bool = False):
        if not url or Image is None:
            return None
        cache_file = steam_image_cache_path(url)
        if not cache_file.exists():
            return None
        try:
            image = Image.open(cache_file).convert("RGB")
            if cover:
                return fit_image_cover(image, max_w, max_h)
            return fit_image_contain(image, max_w, max_h)
        except Exception:
            return None

    @classmethod
    def _fetch_photo(cls, url: str, max_w: int, max_h: int, force_network: bool = False, cover: bool = False):
        global _unverified_ssl
        if not url or Image is None:
            return None
        if not force_network:
            cached = cls._load_cached_photo(url, max_w, max_h, cover=cover)
            if cached is not None:
                return cached
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "alexa-broadcast-client/1.0"},
            )

            def download(context):
                with urllib.request.urlopen(request, timeout=10, context=context) as response:
                    return response.read()

            context = (
                ssl._create_unverified_context()
                if _unverified_ssl
                else ssl.create_default_context()
            )
            try:
                data = download(context)
            except Exception as error:
                if not _unverified_ssl and _is_ssl_failure(error):
                    data = download(ssl._create_unverified_context())
                    _unverified_ssl = True
                else:
                    raise
            image = Image.open(io.BytesIO(data)).convert("RGB")
            fitted = fit_image_cover(image, max_w, max_h) if cover else fit_image_contain(image, max_w, max_h)
            try:
                cache_dir = steam_image_cache_dir()
                cache_dir.mkdir(parents=True, exist_ok=True)
                steam_image_cache_path(url).write_bytes(data)
            except OSError:
                pass
            return fitted
        except Exception:
            try:
                steam_image_cache_path(url).unlink(missing_ok=True)
            except OSError:
                pass
            return None
