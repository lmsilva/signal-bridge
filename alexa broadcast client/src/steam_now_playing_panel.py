"""Steam Now Playing overlay panel (portrait-first)."""

from __future__ import annotations

import hashlib
import io
import ssl
import threading
import time
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

from src.design_system import (
    ACCENT as DS_ACCENT,
    INK_3,
    STEAM_BG,
    STEAM_STAGE_BG,
    STEAM_INK_DIM,
    STEAM_INK_MUTED,
    STEAM_LINE,
    STEAM_TAG_BG,
    STEAM_TAG_BORDER,
    design_u,
    page_chrome,
)
from src.display_panels import BasePanel
from src.message_scroll import MessageScrollController
from src.payload_utils import parse_iso_timestamp
from src.paths import app_root
from src.text_marquee import MarqueeLine

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
    """Steam Now Playing — fixed art stage, nothing composited over artwork."""

    ACCENT = DS_ACCENT
    PILL_BG = STEAM_TAG_BG
    FOOTER_LINE = STEAM_LINE
    DESC_BG = STEAM_BG
    SOURCE_CHIP = "STEAM"
    PAYLOAD_KEY = "steam"
    DEFAULT_TITLE = "Steam Game"
    # Seconds between image download attempts while a card is on screen. Long
    # cards (a feature-length video) outlive a router blip, so the last gap is
    # generous rather than giving up inside the first minute.
    IMAGE_RETRY_DELAYS = (3, 10, 30, 90)
    # Spec §3.2: 32px crisp inset so corner ticks never touch the poster.
    HERO_FG_PAD = 32
    HERO_BLUR_RADIUS = 8
    HERO_BLUR_BRIGHTNESS = 0.5
    TAG_PILL_H = 40
    TAG_FONT_GAP = 16
    # Steam blurbs are longer than broadcast chips — half the global scroll rate.
    DESC_SCROLL_SPEED_FACTOR = 0.5
    # Portrait bands. The stage is mostly blurred backdrop once a wide capsule is
    # contained inside it, so it yields height to the blurb and the shot row —
    # both of which show strictly more content as their band grows.
    DESC_H_PORTRAIT = 272
    SHOTS_H_PORTRAIT = 248
    STAGE_MIN_PORTRAIT = 400
    STAGE_MAX_PORTRAIT = 1100

    ENRICH_SPINNER_MS = 45

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self.needs_scroll = False
        self.scroller = None
        self._desc_viewport = None
        self._desc_window_id = None
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
        self._enrich_spinner_arcs: list[tuple[int, int]] = []
        self._enrich_spinner_job = None
        self._enrich_spinner_angle = 0.0
        self._marquees: list[MarqueeLine] = []

    def hide(self):
        self._fetch_token += 1
        self._stop_elapsed_tick()
        self._stop_enrich_spinner()
        self._stop_title_marquees()
        self._clear_description_viewport()
        self._photo_refs = []
        super().hide()

    def _stop_title_marquees(self):
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []

    def _place_title_marquee(self, text, x0, y0, x1, y1, font, fill):
        """Single-line game title; scrolls horizontally when it outruns the band.

        Same contract as YouTube / music: if it fits, sit still; if not, pause →
        scroll → pause → reset. Never ellipsis or clip mid-glyph.
        """
        self._stop_title_marquees()
        width = max(40, int(x1 - x0))
        try:
            line_h = int(font.metrics("linespace"))
        except Exception:
            line_h = 40
        height = max(line_h + 4, min(max(1, int(y1 - y0)), line_h + 12))
        y = int(y0 + max(0, ((y1 - y0) - height) / 2))
        marquee = MarqueeLine(self.root)
        self._marquees.append(marquee)
        viewport = marquee.build(
            parent=self.canvas,
            text=text,
            font=font,
            fill=fill,
            width=width,
            height=height,
            bg=STEAM_BG,
            center=False,
        )
        win_id = self.canvas.create_window(
            int(x0), y, anchor="nw", window=viewport, width=width, height=height,
        )
        self._item_ids.append(win_id)
        self._widgets.append(viewport)

    @staticmethod
    def _enrich_pending(card: dict | None) -> bool:
        return bool((card or {}).get("enrichPending"))

    def _stop_enrich_spinner(self):
        if self._enrich_spinner_job is not None:
            try:
                self.root.after_cancel(self._enrich_spinner_job)
            except Exception:
                pass
            self._enrich_spinner_job = None
        self._enrich_spinner_arcs = []

    def _schedule_enrich_spinner(self):
        if self._enrich_spinner_job is not None:
            return
        if not self._enrich_spinner_arcs:
            return
        self._enrich_spinner_job = self.root.after(
            self.ENRICH_SPINNER_MS, self._tick_enrich_spinner,
        )

    def _tick_enrich_spinner(self):
        self._enrich_spinner_job = None
        if not self.visible or not self._enrich_spinner_arcs:
            return
        self._enrich_spinner_angle = (self._enrich_spinner_angle - 9) % 360
        for arc1, arc2 in self._enrich_spinner_arcs:
            try:
                self.canvas.itemconfigure(arc1, start=self._enrich_spinner_angle)
                self.canvas.itemconfigure(arc2, start=self._enrich_spinner_angle + 180)
            except Exception:
                pass
        self._schedule_enrich_spinner()

    def _draw_enrich_spinner(self, cx: float, cy: float, radius: float):
        """Route-planner-style dual-arc spinner for pending enrich bands."""
        accent = self.config.get("accentColor", self.ACCENT)
        radius = max(8.0, float(radius))
        arc1 = self.canvas.create_arc(
            cx - radius, cy - radius, cx + radius, cy + radius,
            start=self._enrich_spinner_angle, extent=100, style=tk.ARC,
            outline=accent, width=max(2, int(radius / 5)),
        )
        arc2 = self.canvas.create_arc(
            cx - radius, cy - radius, cx + radius, cy + radius,
            start=self._enrich_spinner_angle + 180, extent=60, style=tk.ARC,
            outline=accent, width=max(2, int(radius / 6)),
        )
        self._item_ids.extend([arc1, arc2])
        self._enrich_spinner_arcs.append((arc1, arc2))
        self._schedule_enrich_spinner()

    def _draw_loading_band(self, box) -> bool:
        """Centered spinner inside a reserved description / meta band."""
        if not box:
            return False
        x0, y0, x1, y1 = box
        height = y1 - y0
        width = x1 - x0
        if height < 20 or width < 20:
            return False
        radius = max(12.0, min(22.0, height / 4.0, width / 10.0))
        self._draw_enrich_spinner((x0 + x1) / 2, (y0 + y1) / 2, radius)
        return True

    def _draw_loading_shot_row(self, shots_box, *, count: int = 3):
        """Reserve screenshot plates with a spinner in each cell."""
        if not shots_box:
            return
        x0, y0, x1, y1 = shots_box
        if y1 <= y0 + 8:
            return
        count = max(1, min(3, int(count or 3)))
        gap = 12
        cell_w = (x1 - x0 - gap * (count - 1)) / count
        radius = max(10.0, min(18.0, (y1 - y0) / 4.0, cell_w / 5.0))
        for i in range(count):
            sx0 = x0 + i * (cell_w + gap)
            sx1 = sx0 + cell_w
            self._round_rect(sx0, y0, sx1, y1, 0, fill="#101b2d", outline=STEAM_LINE)
            self._draw_enrich_spinner((sx0 + sx1) / 2, (y0 + y1) / 2, radius)

    def _clear_description_viewport(self):
        if self.scroller:
            self.scroller.stop()
        self.scroller = None
        self.needs_scroll = False
        win_id = self._desc_window_id
        self._desc_window_id = None
        if win_id is not None:
            try:
                self.canvas.delete(win_id)
            except Exception:
                pass
            if win_id in self._item_ids:
                self._item_ids.remove(win_id)
        viewport = self._desc_viewport
        self._desc_viewport = None
        if viewport is None:
            return
        try:
            viewport.place_forget()
        except Exception:
            pass
        if viewport in self._widgets:
            self._widgets.remove(viewport)
        try:
            viewport.destroy()
        except Exception:
            pass

    def _stop_elapsed_tick(self):
        if self._tick_job is not None:
            try:
                self.root.after_cancel(self._tick_job)
            except Exception:
                pass
            self._tick_job = None

    def _content_rect(self):
        """Fixed 1000-wide column (40 pad) in portrait; 1800 / two 888 cols in landscape."""
        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or 0)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or 0)
        if screen_w < 64:
            screen_w = int(self.root.winfo_screenwidth() or 1920)
        if screen_h < 64:
            screen_h = int(self.root.winfo_screenheight() or 1080)
        overlay = getattr(self.shell, "overlay", None)
        timed = bool(overlay and int(getattr(overlay, "_display_seconds", 0) or 0) > 0)
        chrome = page_chrome(screen_w, screen_h, timed=timed)
        # Timed last-played / preview sessions show the shared dismiss band —
        # keep an air gap so the hero border + stats strip are not covered.
        # Persistent auto sessions (displaySeconds 0) keep the full height.
        footer_clear = max(14, int(round(chrome.u * 18))) if timed else 0
        # Steam paints its own header — start at the page header band, not at
        # content_top (that left a ~100px empty strip above the panel in landscape).
        if chrome.portrait:
            pad = 40 * chrome.u
            x0 = pad
            x1 = screen_w - pad
            y0 = pad
            y1 = screen_h - (chrome.footer_h if timed else pad) - footer_clear
        else:
            # Spec §9.1: header at header_top; content clears dismiss footer.
            x0 = chrome.content_x
            x1 = x0 + chrome.content_w
            y0 = chrome.header_top
            if timed:
                y1 = chrome.content_bottom - footer_clear
            else:
                y1 = screen_h - 40 * chrome.u
        if y1 <= y0 + 120:
            y1 = screen_h - 64 - footer_clear
        return {
            "screen_w": screen_w,
            "screen_h": screen_h,
            "x0": int(x0),
            "y0": int(y0),
            "x1": int(x1),
            "y1": int(y1),
            "portrait": chrome.portrait,
            "u": chrome.u,
            "timed": timed,
            "footer_clear": int(footer_clear),
        }

    def _render(self, payload: dict):
        steam = payload.get(self.PAYLOAD_KEY) or payload.get("steam") or {}
        self._steam = steam
        started = steam.get("startedAt")
        self._started_at = parse_iso_timestamp(started) if started else None
        self._stop_enrich_spinner()

        rect = self._content_rect()
        self._draw_background(0, 0, rect["screen_w"], rect["screen_h"])
        # Library-tour thin cards reserve the screenshot row while enrich runs
        # so the layout does not jump when screenshots arrive.
        has_shots = bool(steam.get("screenshots")) or self._enrich_pending(steam)
        if rect["portrait"]:
            self._layout_boxes = self._compute_portrait_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_shots=has_shots,
            )
        else:
            self._layout_boxes = self._compute_landscape_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_shots=has_shots,
            )
        self._draw_chrome(self._layout_boxes)
        self._draw_meta(self._layout_boxes, steam)
        self._draw_footer(self._layout_boxes, steam)
        self._start_image_fetches(steam)
        self._schedule_elapsed_tick()

    def _draw_background(self, x0, y0, x1, y1):
        self._item_ids.append(self.canvas.create_rectangle(
            x0, y0, x1, y1, fill=STEAM_BG, outline="",
        ))

    def _compute_portrait_boxes(self, x0, y0, x1, y1, *, u=1.0, has_shots=True):
        """Fixed stage 1000×1100; desc+screenshots+footer pinned to the bottom.

        Description is its own band directly above screenshots so title/tag
        growth cannot push copy into the shot row.
        """
        u = float(u or 1.0)
        header_h = 84 * u
        title_h = 74 * u
        # Long titles put developer · year on its own line under the name —
        # reserve that credit band so the tag row is never squeezed into desc.
        credit_h = 28 * u
        tags_h = 40 * u
        desc_h = self.DESC_H_PORTRAIT * u
        shots_h = (self.SHOTS_H_PORTRAIT * u) if has_shots else 0
        footer_h = 101 * u
        g_header = 20 * u
        g_stage = 24 * u
        g_title = 16 * u
        g_tags = 18 * u
        g_desc = 12 * u
        g_shots = 22 * u

        header = (x0, y0, x1, y0 + header_h)
        hero_top = y0 + header_h + g_header
        # The stage is the flexible band and everything under it is sized to its
        # own content, so a tall column grows the artwork rather than padding the
        # title row — and a short one shrinks the artwork instead of pushing copy
        # through the footer.
        meta_h = title_h + credit_h + g_title + tags_h
        fixed_below = (
            g_stage + meta_h + g_tags + g_desc + desc_h
            + (g_shots + shots_h if has_shots else 0) + footer_h
        )
        stage_h = max(
            self.STAGE_MIN_PORTRAIT * u,
            min(self.STAGE_MAX_PORTRAIT * u, (y1 - hero_top) - fixed_below),
        )
        hero = (x0, hero_top, x1, hero_top + stage_h)

        footer_top = y1 - footer_h
        shots_top = footer_top - (g_shots + shots_h if has_shots else 0)
        desc_bottom = shots_top
        desc_top = desc_bottom - desc_h
        meta_top = hero[3] + g_stage
        meta_bottom = max(meta_top, desc_top - g_desc)
        # Title/tags only above the pinned description band.
        meta = (x0, meta_top, x1, meta_bottom)
        desc = (x0, desc_top, x1, desc_bottom)
        shots = (x0, shots_top, x1, shots_top + shots_h) if has_shots else (x0, shots_top, x1, shots_top)
        footer = (x0, footer_top, x1, y1)
        return {
            "header": header,
            "hero": hero,
            "meta": meta,
            "desc": desc,
            "shots": shots,
            "footer": footer,
            "title_h": title_h,
            "tags_h": tags_h,
            "desc_h": desc_h,
            "u": u,
        }

    def _compute_landscape_boxes(self, x0, y0, x1, y1, *, u=1.0, has_shots=True):
        """Two 888×908 columns under the shared header (spec §9).

        `y0` is the header top (28u). Columns fill the content zone beneath
        (132u → bottom), so the stage uses the full available height.
        """
        u = float(u or 1.0)
        gutter = 24 * u
        col_w = (x1 - x0 - gutter) / 2
        left_x1 = x0 + col_w
        right_x0 = left_x1 + gutter
        header_h = 84 * u
        header = (x0, y0, x1, y0 + header_h)
        zone_top = y0 + header_h + 20 * u
        zone_bottom = y1
        # Right column: title/tags above a pinned desc band; shots + stats at bottom.
        footer_h = 100 * u
        desc_h = 256 * u
        shots_h = (158 * u) if has_shots else 0
        g_desc = 12 * u
        g_shots = 22 * u
        footer_top = zone_bottom - footer_h
        shots_top = footer_top - (g_shots + shots_h if has_shots else 0)
        desc_bottom = shots_top
        desc_top = desc_bottom - desc_h
        meta_top = zone_top
        meta_bottom = max(meta_top, desc_top - g_desc)
        hero = (x0, zone_top, left_x1, zone_bottom)
        meta = (right_x0, meta_top, x1, meta_bottom)
        desc = (right_x0, desc_top, x1, desc_bottom)
        shots = (
            (right_x0, shots_top, x1, shots_top + shots_h)
            if has_shots else (right_x0, shots_top, x1, shots_top)
        )
        footer = (right_x0, footer_top, x1, zone_bottom)
        return {
            "header": header,
            "hero": hero,
            "meta": meta,
            "desc": desc,
            "shots": shots,
            "footer": footer,
            "title_h": 104 * u,
            "tags_h": 40 * u,
            "desc_h": desc_h,
            "u": u,
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
        mode = str(self._steam.get("mode") or "playing")
        # Library tour cards reuse last-played chrome (WHEN / AGO), not ELAPSED.
        return mode in ("last-played", "library-tour")

    def _is_library_tour(self):
        return str(self._steam.get("mode") or "") == "library-tour"

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
        library_tour = self._is_library_tour()
        start_dt = self._started_at
        if last_played:
            last_raw = self._steam.get("lastPlayedAt") or self._steam.get("startedAt")
            start_dt = parse_iso_timestamp(last_raw) if last_raw else start_dt
        playtime = str(self._steam.get("playtimeLabel") or "").strip()
        if library_tour and playtime:
            left_label = "PLAYTIME"
            left_value = playtime
        elif last_played:
            left_label = "WHEN"
            left_value = self._fmt_last_played_date(start_dt)
        else:
            left_label = "START TIME"
            left_value = self._fmt_clock(start_dt)
        if library_tour:
            badge = "LIBRARY"
        elif last_played:
            badge = "LAST PLAYED"
        else:
            badge = "NOW PLAYING"
        badge_outline = self.ACCENT if (last_played or library_tour) else "#e2e8f0"
        badge_fill = "#0b1220"
        badge_text = self.ACCENT if (last_played or library_tour) else text
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
        # Labels use muted ink (not accent) — accent is reserved for identity/status.
        self._item_ids.append(self.canvas.create_text(
            hx0, cy - 10, anchor="w", text=left_label, fill=INK_3,
            font=self.shell.chip_label_font,
        ))
        self._item_ids.append(self.canvas.create_text(
            hx0, cy + 12, anchor="w", text=left_value, fill=text,
            font=self.shell.chip_value_font,
        ))
        self._round_rect(
            mid_x - badge_w / 2, cy - badge_h / 2, mid_x + badge_w / 2, cy + badge_h / 2,
            0, outline=badge_outline, fill=badge_fill,
        )
        self._item_ids.append(self.canvas.create_text(
            mid_x, cy, anchor="center", text=badge, fill=badge_text,
            font=badge_font,
        ))
        if library_tour:
            right_label = "IN LIBRARY"
            right_value = self.format_ago(start_dt) if start_dt else "—"
            self._elapsed_value_id = None
        elif last_played:
            right_label = "LAST PLAYED"
            right_value = self.format_ago(start_dt)
            self._elapsed_value_id = None
        else:
            right_label = "ELAPSED"
            right_value = self._fmt_elapsed()
        self._item_ids.append(self.canvas.create_text(
            hx1, cy - 10, anchor="e", text=right_label, fill=INK_3,
            font=self.shell.chip_label_font,
        ))
        value_id = self.canvas.create_text(
            hx1, cy + 12, anchor="e", text=right_value, fill=text,
            font=self.shell.chip_value_font,
        )
        self._item_ids.append(value_id)
        if not last_played and not library_tour:
            self._elapsed_value_id = value_id

        x0, y0, x1, y1 = boxes["hero"]
        # Stage plate + ambient/crisp slots. Corner ticks on the stage edge only.
        # Nothing else (no STEAM chip, no badges) is drawn on the artwork.
        self._round_rect(x0, y0, x1, y1, 0, fill=STEAM_STAGE_BG, outline=STEAM_LINE)
        self._hero_glow_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_glow_id)
        self._hero_image_id = self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2, anchor="center")
        self._item_ids.append(self._hero_image_id)
        tick = max(16, int(round(26 * float(boxes.get("u") or 1))))
        self._draw_corner_brackets(x0, y0, x1, y1, length=tick, color=self.ACCENT)

    def _draw_steam_chip(self, x0, y0, x1, y1):
        """Deprecated — STEAM lives in the tag row (spec §3.4 / §10)."""
        return

    def _tag_font(self):
        return (
            getattr(self.shell, "forecast_label_font", None)
            or self.shell.chip_label_font
        )

    def _draw_tags(self, tags, tx0, ty0, tx1, ty1, *, include_source: bool = True):
        """Tag row: STEAM source chip first, then up to 4 genre tags. Never on art.

        The pill height is strictly `min(TAG_PILL_H, ty1 - ty0)`. A previous
        `max(22, …)` floor painted 22px pills into the description whenever the
        title/credit stack left less than 22px above the meta floor.
        """
        available = float(ty1) - float(ty0)
        if available < 16:
            return ty0
        pill_gap = 10
        x = tx0
        row_y0 = ty0
        row_h = min(float(self.TAG_PILL_H), available)
        tag_font = self._tag_font()
        chips = []
        if include_source:
            chips.append((str(self.SOURCE_CHIP or "STEAM"), True))
        for tag in (tags or [])[:4]:
            chips.append((str(tag), False))
        for label, is_source in chips:
            try:
                tw = int(tag_font.measure(label)) + 26
            except Exception:
                tw = len(label) * 8 + 26
            if x + tw > tx1:
                break
            if is_source:
                self._round_rect(
                    x, row_y0, x + tw, row_y0 + row_h, 0,
                    fill="", outline=self.ACCENT,
                )
                fill = self.ACCENT
            else:
                self._round_rect(
                    x, row_y0, x + tw, row_y0 + row_h, 0,
                    fill=STEAM_TAG_BG, outline=STEAM_TAG_BORDER,
                )
                fill = self.config.get("textColor", "#f2f7ff")
            self._item_ids.append(self.canvas.create_text(
                x + tw / 2, row_y0 + row_h / 2, anchor="center", text=label,
                fill=fill, font=tag_font,
            ))
            x += tw + pill_gap
        return row_y0 + row_h

    def _draw_meta(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        tags = list(steam.get("tags") or [])[:4]
        mx0, my0, mx1, my1 = boxes["meta"]
        title = str(steam.get("name") or self.DEFAULT_TITLE)
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
        _title_band, _desc_unused, shot_h = self._meta_band_heights(
            boxes["meta"], bool(shots) and not shots_separate, shots_separate=shots_separate,
        )

        title_font = getattr(self.shell, "section_title_font", None) or self.shell.chip_value_font
        credit_font = self.shell.chip_label_font
        try:
            title_h = int(title_font.metrics("linespace"))
            title_w = int(title_font.measure(title))
        except Exception:
            title_h = 32
            title_w = 200
        title_line_h = title_h

        # Mockup: developer · year flush to the right edge of the meta column
        # when the title leaves room; otherwise under the title so the marquee
        # can own the full width.
        title_right = mx1
        if credit:
            try:
                credit_ls = int(credit_font.metrics("linespace"))
                credit_w = int(credit_font.measure(credit))
            except Exception:
                credit_ls = 14
                credit_w = 120
            if title_w + credit_w + 24 < (mx1 - mx0):
                self._item_ids.append(self.canvas.create_text(
                    mx1, my0 + 2 + max(0, (title_h - credit_ls) // 2),
                    anchor="ne", text=credit, fill=muted, font=credit_font,
                ))
                title_right = mx1 - credit_w - 24
            else:
                self._item_ids.append(self.canvas.create_text(
                    mx0, my0 + title_h + 4, anchor="nw", text=credit, fill=muted,
                    font=credit_font,
                ))
                title_h += credit_ls + 4

        self._place_title_marquee(
            title, mx0, my0, title_right, my0 + title_line_h,
            title_font, text,
        )

        tags_top = my0 + title_h + self.TAG_FONT_GAP
        tags_h = int(boxes.get("tags_h") or self.TAG_PILL_H)
        desc_box = boxes.get("desc")
        # Entire pill row must clear both the meta floor and the desc band —
        # never paint tags over the description copy below.
        tags_ceiling = float(my1)
        if desc_box:
            tags_ceiling = min(tags_ceiling, float(desc_box[1]))
        if tags_top + 16 > tags_ceiling:
            tags_bottom = tags_top
        else:
            tags_bottom = self._draw_tags(
                tags, mx0, tags_top, mx1, min(tags_ceiling, tags_top + tags_h),
            )
        # Pinned description band (layout `desc`) — embedded via create_window so
        # it shares the main canvas coordinate system / clip with screenshots.
        if desc_box:
            dx0, dy0, dx1, dy1 = desc_box
        else:
            # Legacy fallback if a caller omits `desc` (tests / older boxes).
            reserved_desc = float(boxes.get("desc_h") or 128)
            dy0 = min(float(my1), float(tags_bottom) + 12)
            hard_floor = float(my1)
            if shots_separate:
                hard_floor = min(hard_floor, float(shots_box[1]))
            dy1 = min(hard_floor, dy0 + reserved_desc)
            dx0, dx1 = mx0, mx1
        desc = str(steam.get("shortDescription") or "").strip()
        enrich_pending = self._enrich_pending(steam)
        if desc:
            self._place_description_viewport(desc, dx0, dy0, dx1, max(0, int(dy1 - dy0)))
        elif enrich_pending:
            self._clear_description_viewport()
            self._draw_loading_band((dx0, dy0, dx1, dy1))
        else:
            self._clear_description_viewport()

        if shots_separate and shots:
            self._draw_shot_placeholders(shots_box, shots)
        elif shots and not shots_separate:
            # Should not happen with the new geometry (shots are always separate).
            pass

        self._shot_ids = []
        if shots_separate and shots:
            sx0, sy0, sx1, sy1 = shots_box
            self._place_screenshot_row(shots, sx0, sy0, sx1, sy1)
        elif shots_separate and enrich_pending and shots_box[3] > shots_box[1] + 20:
            self._draw_loading_shot_row(shots_box)

    def _place_description_viewport(
        self, desc: str, x0: float, y0: float, x1: float, height: int, *, font=None,
    ):
        """Clipped description band; long text loops via MessageScrollController.

        Embedded with ``canvas.create_window`` (not root ``place``) so the band
        cannot drift relative to screenshot images drawn on the same canvas.
        """
        self._clear_description_viewport()
        if not desc or height < 20:
            return

        body_width = max(40, int(x1 - x0))
        viewport_h = max(1, int(height))
        desc_font = font or getattr(self.shell, "body_font", None) or self.shell.chip_label_font
        # Parent the nested canvas to the overlay canvas so create_window clips
        # correctly inside the panel coordinate space.
        viewport = tk.Canvas(
            self.canvas,
            width=body_width,
            height=viewport_h,
            highlightthickness=0,
            bd=0,
            bg=self.DESC_BG,
        )
        text_id = viewport.create_text(
            0, 0, anchor="nw", text="",
            fill=STEAM_INK_DIM, font=desc_font,
            width=body_width, justify=tk.LEFT,
        )
        # on_finish hides when a timed session waits for one full scroll cycle
        # after the dismiss timer (same contract as BroadcastPanel).
        on_finish = getattr(getattr(self.shell, "overlay", None), "hide", lambda: None)
        scroll_config = dict(self.config)
        base_pps = float(scroll_config.get("scrollPixelsPerSecond", 28) or 28)
        scroll_config["scrollPixelsPerSecond"] = max(
            1.0, base_pps * float(self.DESC_SCROLL_SPEED_FACTOR),
        )
        scroller = MessageScrollController(
            viewport, text_id, scroll_config, self.root, on_finish=on_finish,
        )
        needs_scroll = scroller.configure(
            desc, center_x=0, viewport_height=viewport_h,
        )
        win_id = self.canvas.create_window(
            int(x0), int(y0),
            anchor="nw",
            window=viewport,
            width=body_width,
            height=viewport_h,
        )
        self._item_ids.append(win_id)
        self._desc_window_id = win_id
        self._desc_viewport = viewport
        self._widgets.append(viewport)
        self.scroller = scroller
        self.needs_scroll = bool(needs_scroll)
        # Start immediately so persistent Steam (no dismiss timer) still scrolls;
        # overlay._on_show_ready may call start() again (idempotent via stop).
        if needs_scroll:
            scroller.start()

    def _draw_shot_placeholders(self, shots_box, shots):
        """Empty cells stay as flat plates when fewer than 3 screenshots."""
        return

    def _place_screenshot_row(self, shots, x0, y0, x1, y1):
        gap = 12
        count = 3  # always 3 columns (spec §3.6 / §5)
        if y1 <= y0 + 8:
            return
        cell_w = (x1 - x0 - gap * (count - 1)) / count
        urls = list(shots)[:3]
        for i in range(count):
            sx0 = x0 + i * (cell_w + gap)
            sx1 = sx0 + cell_w
            self._round_rect(sx0, y0, sx1, y1, 0, fill="#101b2d", outline=STEAM_LINE)
            if i < len(urls):
                img_id = self.canvas.create_image((sx0 + sx1) / 2, (y0 + y1) / 2, anchor="center")
                self._item_ids.append(img_id)
                self._shot_ids.append((img_id, sx1 - sx0 - 4, y1 - y0 - 4))

    def _draw_footer(self, boxes, steam):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        fx0, fy0, fx1, fy1 = boxes["footer"]
        self._item_ids.append(self.canvas.create_line(fx0, fy0, fx1, fy0, fill=self.FOOTER_LINE))
        enrich_pending = self._enrich_pending(steam)
        achievements = steam.get("achievements") or {}
        playtime = steam.get("playtimeLabel") or "—"
        if achievements.get("available") and achievements.get("earned") is not None:
            ach_text = f"{achievements.get('earned')} / {achievements.get('total') or '?'}"
        elif enrich_pending:
            ach_text = None  # spinner while Store enrich loads
        else:
            ach_text = "—"
        players = steam.get("currentPlayers")
        if players is not None:
            players_text = f"{int(players):,}"
        elif enrich_pending:
            players_text = None
        else:
            players_text = "—"
        cols = (
            ("PLAYTIME", playtime),
            ("ACHIEVEMENTS", ach_text),
            ("PLAYING NOW", players_text),
        )
        col_w = (fx1 - fx0) / 3
        # Compact vertical rhythm — label + value with little padding (footer is short).
        label_y = fy0 + max(6, int((fy1 - fy0) * 0.18))
        value_y = fy0 + max(22, int((fy1 - fy0) * 0.52))
        for i, (label, value) in enumerate(cols):
            cx = fx0 + col_w * i + col_w / 2
            if i > 0:
                div_x = fx0 + col_w * i
                self._item_ids.append(self.canvas.create_line(
                    div_x, fy0 + 6, div_x, fy1 - 6, fill=self.FOOTER_LINE,
                ))
            self._item_ids.append(self.canvas.create_text(
                cx, label_y, anchor="n", text=label, fill=muted,
                font=self.shell.chip_label_font,
            ))
            if value is None:
                self._draw_enrich_spinner(cx, value_y + 10, 9)
            else:
                self._item_ids.append(self.canvas.create_text(
                    cx, value_y, anchor="n", text=value, fill=text,
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
            # Fetch a large source; blur-fill + contain-fit happen in _apply_image.
            max_w = max(40, int(x1 - x0))
            max_h = max(40, int(y1 - y0))
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
        """Fetch the first candidate that works, and keep trying if none do.

        A single failed download used to leave the frame empty for as long as
        the card was up — which for a feature-length video is the whole thing,
        even though the image was there the moment anyone looked again.
        """
        # Hero: keep near-full source so we can blur-fill the frame + contain the poster.
        cover = False
        raw = target == "hero"
        candidates = [url for url in urls if url]
        if not candidates:
            return

        for attempt in range(len(self.IMAGE_RETRY_DELAYS) + 1):
            if attempt:
                time.sleep(self.IMAGE_RETRY_DELAYS[attempt - 1])
                # hide() bumps the token, so this is also how we stop retrying
                # for a card nobody is looking at any more.
                if token != self._fetch_token:
                    return
            for url in candidates:
                cached = self._load_cached_photo(url, max_w, max_h, cover=cover, raw=raw)
                if cached is not None:
                    self.root.after(0, lambda img=cached: self._apply_image(token, img, target))
                    threading.Thread(
                        target=self._refresh_cached_photo,
                        args=(token, url, max_w, max_h, target),
                        daemon=True,
                    ).start()
                    return
                image = self._fetch_photo(
                    url, max_w, max_h, force_network=True, cover=cover, raw=raw,
                )
                if image is not None:
                    self.root.after(0, lambda img=image: self._apply_image(token, img, target))
                    return

    def _refresh_cached_photo(self, token, url, max_w, max_h, target):
        raw = target == "hero"
        image = self._fetch_photo(
            url, max_w, max_h, force_network=True, cover=False, raw=raw,
        )
        if image is None:
            return
        self.root.after(0, lambda: self._apply_image(token, image, target))

    def _make_blur_backdrop(self, image, box_w, box_h):
        """Cover-fill the hero frame with a blurred copy of the same art."""
        if image is None or Image is None or ImageFilter is None:
            return None
        try:
            filled = fit_image_cover(image, box_w, box_h)
            blurred = filled.filter(ImageFilter.GaussianBlur(radius=self.HERO_BLUR_RADIUS))
            if ImageEnhance is not None:
                blurred = ImageEnhance.Brightness(blurred).enhance(self.HERO_BLUR_BRIGHTNESS)
            return blurred
        except Exception:
            return None

    def _apply_image(self, token, image, target):
        if token != self._fetch_token or not self.visible or image is None or ImageTk is None:
            return
        if target == "hero":
            hero_box = self._layout_boxes.get("hero")
            if not hero_box:
                return
            x0, y0, x1, y1 = hero_box
            box_w = max(40, int(x1 - x0))
            box_h = max(40, int(y1 - y0))
            # Backdrop: same image, cover-fitted + blurred, fills the whole frame.
            backdrop = self._make_blur_backdrop(image, box_w, box_h)
            if backdrop is not None and self._hero_glow_id:
                glow_photo = ImageTk.PhotoImage(backdrop)
                self._photo_refs.append(glow_photo)
                try:
                    self.canvas.itemconfigure(self._hero_glow_id, image=glow_photo)
                except Exception:
                    pass
            # Foreground: full poster contained (letterbox filled by blur behind).
            fg_w = max(40, box_w - self.HERO_FG_PAD * 2)
            fg_h = max(40, box_h - self.HERO_FG_PAD * 2)
            foreground = fit_image_contain(image, fg_w, fg_h)
            if foreground is None:
                return
            photo = ImageTk.PhotoImage(foreground)
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
    def _load_cached_photo(cls, url: str, max_w: int, max_h: int, cover: bool = False, raw: bool = False):
        if not url or Image is None:
            return None
        cache_file = steam_image_cache_path(url)
        if not cache_file.exists():
            return None
        try:
            image = Image.open(cache_file).convert("RGB")
            if raw:
                # Downscale huge sources for Tk memory, but keep aspect for later fits.
                max_edge = max(max_w, max_h) * 2
                if max(image.size) > max_edge > 0:
                    image = image.copy()
                    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                return image
            if cover:
                return fit_image_cover(image, max_w, max_h)
            return fit_image_contain(image, max_w, max_h)
        except Exception:
            return None

    @classmethod
    def _fetch_photo(
        cls, url: str, max_w: int, max_h: int, force_network: bool = False,
        cover: bool = False, raw: bool = False,
    ):
        global _unverified_ssl
        if not url or Image is None:
            return None
        if not force_network:
            cached = cls._load_cached_photo(url, max_w, max_h, cover=cover, raw=raw)
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
        except Exception:
            # The network failed, which says nothing about the copy already on
            # disk. Deleting it here meant one blip during the background
            # refresh threw away good art and forced the next card to re-fetch.
            return None

        try:
            image = Image.open(io.BytesIO(data)).convert("RGB")
        except Exception:
            # These bytes are not an image. Drop any cached copy, or a bad
            # download would keep being served from disk forever.
            try:
                steam_image_cache_path(url).unlink(missing_ok=True)
            except OSError:
                pass
            return None

        try:
            cache_dir = steam_image_cache_dir()
            cache_dir.mkdir(parents=True, exist_ok=True)
            steam_image_cache_path(url).write_bytes(data)
        except OSError:
            pass
        try:
            if raw:
                max_edge = max(max_w, max_h) * 2
                if max(image.size) > max_edge > 0:
                    image = image.copy()
                    image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                return image
            return fit_image_cover(image, max_w, max_h) if cover else fit_image_contain(image, max_w, max_h)
        except Exception:
            return None
