"""The Upside News overlay (upside-news.round).

One UDP packet carries the whole index → stories cycle; this panel pages
locally on ``root.after`` like ``TriviaPanel``. Category artwork is composed
for legibility — **do not add a scrim** over the JPEG field.
"""

from __future__ import annotations

import hashlib
import io
import ssl
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

try:
    from PIL import Image, ImageTk
except ImportError:
    Image = None
    ImageTk = None

from src.design_system import INK, INK_2, INK_3, page_chrome
from src.display_panels import BasePanel
from src.paths import app_root, asset_path
from src.trivia_panel import (
    artwork_url_candidates,
    fit_text_font,
    looks_like_image,
    mix_hex,
    wrap_text,
)

_unverified_ssl = False

DEFAULT_INDEX_BACKGROUND = "#7A2396"
DEFAULT_INDEX_ACCENT = "#E897FF"
WARN_ACCENT = "#F5C453"
# Until-dismissed rounds loop locally; cap planned cycles for v1.
INFINITE_LOOP_CYCLES = 20
# Overlay ``after`` drift can shave a second or two off the last page. Still
# show the story when enough time remains; only hold the index when it would
# flash for a blink.
MIN_STORY_SHOW_SECONDS = 4
ARTWORK_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")


def upside_news_artwork_cache_dir() -> Path:
    return app_root() / "upside-news-artwork-cache"


def upside_news_artwork_cache_path(url: str) -> Path:
    text = str(url or "")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]
    ext = Path(urlsplit(text).path).suffix.lower()
    if ext not in {".webp", ".png", ".jpg", ".jpeg"}:
        ext = ".jpg"
    return upside_news_artwork_cache_dir() / f"{digest}{ext}"


def upside_news_artwork_asset_path(section_id: str, portrait: bool) -> Path | None:
    """Bundled topic pack under assets/upside-news-artwork/."""
    key = str(section_id or "").strip().lower() or "general"
    orientation = "portrait" if portrait else "landscape"
    for ext in ARTWORK_EXTENSIONS:
        candidate = asset_path(Path("upside-news-artwork") / f"{key}-{orientation}{ext}")
        try:
            if candidate.exists():
                return candidate
        except Exception:
            continue
    return None


def build_phase_plan(upside: dict) -> list[dict]:
    """Flatten a round into ordered index/story cards (pure, no Tk).

    ``loopCount`` 0 means until-dismissed — plan many cycles for v1; the
    overlay ``displaySeconds`` / dismiss still ends the round.

    The index summary is its own phase — it is never counted as a story page.
    """
    upside = upside or {}
    stories = list(upside.get("stories") or [])
    index_seconds = max(1, int(upside.get("indexSeconds") or 12))
    story_seconds = max(1, int(upside.get("storySeconds") or 15))
    try:
        loop_count = int(upside.get("loopCount"))
    except (TypeError, ValueError):
        loop_count = 1

    if not stories:
        return [{"phase": "empty", "seconds": index_seconds, "index": None, "cycle": 0}]

    cycles = INFINITE_LOOP_CYCLES if loop_count == 0 else max(1, loop_count)
    plan: list[dict] = []
    for cycle in range(cycles):
        plan.append({
            "phase": "index",
            "seconds": index_seconds,
            "index": None,
            "cycle": cycle,
        })
        for index in range(len(stories)):
            plan.append({
                "phase": "story",
                "seconds": story_seconds,
                "index": index,
                "cycle": cycle,
            })
    return plan


def resolve_story_phase_seconds(
    planned_seconds: int,
    remaining: float | None,
    *,
    min_show: int = MIN_STORY_SHOW_SECONDS,
) -> tuple[str, int]:
    """Decide how long to air a story when the overlay clock is tight.

    Returns ``('story', seconds)``, ``('hold', seconds)`` (index hold), or
    ``('stop', 0)`` when the overlay is already expired.
    """
    planned = max(1, int(planned_seconds or 1))
    if remaining is None:
        return ("story", planned)
    left = float(remaining)
    if left <= 0.5:
        return ("stop", 0)
    # Slack so after()-drift across earlier pages does not drop/short-change
    # the final story when we are only a couple of seconds short.
    if left + 3.0 >= planned:
        return ("story", planned)
    if left >= min_show:
        return ("story", max(min_show, int(left)))
    return ("hold", max(1, int(left + 0.5)))


def resolve_index_title(upside: dict) -> str:
    """Prefer bridge ``indexTitle``; fall back to period-based copy."""
    upside = upside or {}
    explicit = str(upside.get("indexTitle") or "").strip()
    if explicit:
        return explicit
    count = len(upside.get("stories") or [])
    period = str(upside.get("period") or "daily").lower()
    word = {3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight"}.get(count, str(count))
    if period == "weekly":
        return f"This week's {word}"
    if period == "monthly":
        return "This month's picks"
    if period == "yearly":
        return "This year's highlights"
    return f"Today's {word}"


def index_list_top(
    header_bottom: float,
    *,
    u: float,
    portrait: bool,
    title_bottom: float | None = None,
) -> float:
    """Y where index cards may start — always clear of the dateline.

    Tk ``linespace`` can under-report on DPI-unaware Windows sessions, so we
    add a hard design-unit pad and never start above the reserved title band.
    """
    pad = (48 * u) if portrait else (44 * u)
    top = float(header_bottom) + pad
    if title_bottom is not None:
        top = max(top, float(title_bottom) + (20 * u))
    return top


def format_index_dateline(upside: dict | None = None) -> str:
    """Mockup subtitle: ``Tuesday 4 August · The Guardian``."""
    from datetime import datetime
    now = datetime.now()
    date_part = f"{now.strftime('%A')} {now.day} {now.strftime('%B')}"
    return f"{date_part} · The Guardian"


def story_accent(story: dict, fallback: str = DEFAULT_INDEX_ACCENT) -> str:
    color = str((story or {}).get("accent") or "").strip()
    return color if color.startswith("#") and len(color) == 7 else fallback


def credit_line(card: dict) -> str:
    byline = str(card.get("byline") or "").strip()
    source = str(card.get("sourceLabel") or "").strip()
    if byline and source and byline.lower() == source.lower():
        return byline
    return " · ".join(part for part in (byline, source) if part)


class UpsideNewsPanel(BasePanel):
    """Owns chrome: full-bleed artwork, title, per-page countdown ring."""

    # Type ramp — mockup hierarchy (brand eyebrow → hero title → cards).
    BRAND_U = 22
    INDEX_HERO_U = (68, 56)
    INDEX_DATE_U = 22
    INDEX_HEADER_PAD_U = (48, 44)
    INDEX_ROW_U = (30, 26)
    INDEX_META_U = 16
    INDEX_NUM_U = (48, 42)
    INDEX_MAX_LINES = 2
    HEADLINE_U_PORTRAIT = (68, 44)
    HEADLINE_U_LANDSCAPE = (56, 40)
    STANDFIRST_U = (28, 24)
    CHIP_U = 18
    META_U = 18
    PROGRESS_U = 18
    ATTRIBUTION_U = 13
    CONTENT_INSET_PORTRAIT_U = 36
    CONTENT_INSET_LANDSCAPE_U = 20
    COUNTDOWN_U = 32
    QR_LANDSCAPE_U = 200
    QR_PORTRAIT_U = 180
    CARD_RADIUS_U = 18
    CARD_PAD_U = 22
    ACCENT_BAR_U = 8

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._upside = {}
        self._plan = []
        self._step = 0
        self._phase_job = None
        self._tick_job = None
        self._phase_ends_at = 0.0
        self._phase_seconds = 0
        self._fetch_token = 0
        self._photo_refs = []
        self._artwork_id = None
        self._artwork_key = None
        self._color_id = None
        self._fallback_ids = []
        self._ring_ids = []
        self._countdown_text_id = None
        self._palette = {
            "background": DEFAULT_INDEX_BACKGROUND,
            "accent": DEFAULT_INDEX_ACCENT,
            "ring_track": mix_hex(DEFAULT_INDEX_BACKGROUND, "#FFFFFF", 0.14),
        }

    def hide(self):
        self._fetch_token += 1
        self._cancel_jobs()
        self._drop_background()
        self._photo_refs = []
        self._artwork_key = None
        try:
            self.canvas.configure(bg=self.config.get("overlayBackground", "#0B1730"))
        except Exception:
            pass
        super().hide()

    def _cancel_jobs(self):
        for attr in ("_phase_job", "_tick_job"):
            job = getattr(self, attr, None)
            if job is not None:
                try:
                    self.root.after_cancel(job)
                except Exception:
                    pass
                setattr(self, attr, None)

    def _render(self, payload: dict):
        self._upside = payload.get("upsideNews") or {}
        self._plan = build_phase_plan(self._upside)
        self._step = 0
        if not self._plan:
            self._draw_empty_round()
            return
        self._enter_step(0)

    def _enter_step(self, step: int):
        self._cancel_jobs()
        if step >= len(self._plan):
            return

        entry = self._plan[step]
        seconds = int(entry["seconds"])
        if entry["phase"] == "story":
            action, seconds = resolve_story_phase_seconds(
                entry["seconds"],
                self._remaining_overlay_seconds(),
            )
            if action == "stop":
                self._on_display_expired()
                return
            if action == "hold":
                # Only when almost no time remains — do NOT treat the index as
                # a story or skip the last headline because of timer drift.
                index_entry = {
                    "phase": "index",
                    "seconds": seconds,
                    "index": None,
                    "cycle": entry.get("cycle", 0),
                }
                self._step = step
                self._phase_seconds = seconds
                self._phase_ends_at = self._now() + seconds
                self._paint_step(index_entry)
                self._phase_job = self.root.after(
                    seconds * 1000,
                    lambda: self._on_display_expired(),
                )
                self._schedule_countdown_tick()
                return

        self._step = step
        self._phase_seconds = seconds
        self._phase_ends_at = self._now() + seconds
        self._paint_step(entry)
        self._phase_job = self.root.after(
            seconds * 1000, lambda: self._enter_step(step + 1),
        )
        self._schedule_countdown_tick()

    def _on_display_expired(self):
        """Index hold finished — stop stepping; overlay dismiss handles exit."""
        self._cancel_jobs()

    def _now(self) -> float:
        # OverlayWindow._expires_at is stamped with time.time(), not monotonic.
        import time
        return time.time()

    def _remaining_overlay_seconds(self) -> float | None:
        overlay = getattr(self.shell, "overlay", None)
        if overlay is None:
            return None
        expires = float(getattr(overlay, "_expires_at", 0) or 0)
        if expires <= 0:
            return None
        return max(0.0, expires - self._now())

    def _schedule_countdown_tick(self):
        self._tick_job = self.root.after(250, self._on_countdown_tick)

    def _on_countdown_tick(self):
        if not self.visible:
            return
        self._update_countdown()
        self._schedule_countdown_tick()

    def _paint_step(self, entry: dict):
        self._clear_foreground()
        geometry = self.compute_geometry()
        card = self._card_for(entry)
        self._set_palette(entry, card)
        self._paint_artwork(geometry, entry, card)
        if entry["phase"] == "index":
            self._draw_index(geometry)
        elif entry["phase"] == "empty":
            self._draw_empty_round(geometry)
        else:
            self._draw_story(geometry, card, entry["index"])
        self._draw_attribution(geometry)
        self._lower_background()

    def _card_for(self, entry: dict) -> dict:
        if entry["phase"] != "story":
            return {}
        stories = self._upside.get("stories") or []
        if not stories:
            return {}
        index = entry.get("index") or 0
        return stories[max(0, min(len(stories) - 1, index))]

    def _set_palette(self, entry: dict, card: dict):
        if entry["phase"] == "index":
            background = str(self._upside.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._upside.get("indexAccent") or DEFAULT_INDEX_ACCENT)
        elif entry["phase"] == "empty":
            background = str(self._upside.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._upside.get("indexAccent") or DEFAULT_INDEX_ACCENT)
        else:
            background = str(card.get("background") or DEFAULT_INDEX_BACKGROUND)
            accent = str(card.get("accent") or DEFAULT_INDEX_ACCENT)
        self._palette = {
            "background": background,
            "accent": accent,
            "ring_track": mix_hex(background, "#FFFFFF", 0.14),
        }
        try:
            self.canvas.configure(bg=background)
        except Exception:
            pass

    def _clear_foreground(self):
        keep = {self._artwork_id, self._color_id, *self._fallback_ids}
        for item_id in list(self._item_ids):
            if item_id in keep:
                continue
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
            self._item_ids.remove(item_id)
        self._ring_ids = []
        self._countdown_text_id = None

    def compute_geometry(self) -> dict:
        screen_w = int(getattr(self.shell.overlay, "screen_w", 0) or 0)
        screen_h = int(getattr(self.shell.overlay, "screen_h", 0) or 0)
        if screen_w < 64:
            screen_w = int(self.root.winfo_screenwidth() or 1920)
        if screen_h < 64:
            screen_h = int(self.root.winfo_screenheight() or 1080)
        chrome = page_chrome(screen_w, screen_h, timed=True)
        boxes = (
            self.compute_portrait_boxes if chrome.portrait else self.compute_landscape_boxes
        )(chrome)
        return {
            "screen_w": screen_w, "screen_h": screen_h,
            "portrait": chrome.portrait, "u": chrome.u, **boxes,
        }

    @classmethod
    def compute_portrait_boxes(cls, chrome) -> dict:
        """Portrait: generous index header; story text above bottom-right QR."""
        u = chrome.u
        inset = cls.CONTENT_INSET_PORTRAIT_U * u
        x0 = chrome.content_x + inset
        x1 = chrome.content_x + chrome.content_w - inset
        top = chrome.content_top
        bottom = chrome.content_bottom - 10 * u
        gap = 22 * u

        attribution_h = 28 * u
        progress_h = 56 * u
        # brand + hero + dateline (extra room — cards measure clearance at draw)
        title_h = 240 * u
        qr_size = min(cls.QR_PORTRAIT_U * u, (x1 - x0) * 0.36)

        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, x1, attribution[1])
        title = (x0, top, x1, top + title_h)
        content_bottom = progress[1] - gap
        # QR bottom-right; credit/pips share the left of that band.
        story_qr = (x1 - qr_size, content_bottom - qr_size, x1, content_bottom)
        story_main = (x0, title[3] + gap, x1, story_qr[1] - gap)
        story_credit = (x0, story_qr[1], story_qr[0] - gap, content_bottom)
        body = (x0, title[3] + gap, x1, content_bottom)
        return {
            "title": title,
            "body": body,
            "body_right": None,
            "story_text": story_main,
            "story_credit": story_credit,
            "story_qr": story_qr,
            "progress": progress,
            "attribution": attribution,
            "columns": 1,
        }

    @classmethod
    def compute_landscape_boxes(cls, chrome) -> dict:
        """Landscape: two index columns; story QR anchored bottom-right."""
        u = chrome.u
        inset = cls.CONTENT_INSET_LANDSCAPE_U * u
        x0 = chrome.content_x + inset
        x1 = chrome.content_x + chrome.content_w - inset
        top = chrome.content_top
        bottom = chrome.content_bottom - 10 * u
        gutter = 36 * u
        gap = 20 * u

        attribution_h = 26 * u
        progress_h = 56 * u
        # brand + hero + dateline (cards clear this via measured list_top)
        title_h = 200 * u
        qr_size = min(cls.QR_LANDSCAPE_U * u, (x1 - x0) * 0.22)

        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, x1, attribution[1])
        title = (x0, top, x1, top + title_h)
        content_top = title[3] + gap
        content_bottom = progress[1] - gap

        col_w = (x1 - x0 - gutter) / 2
        left_x1 = x0 + col_w
        right_x0 = left_x1 + gutter
        body_left = (x0, content_top, left_x1, content_bottom)
        body_right = (right_x0, content_top, x1, content_bottom)

        story_qr = (x1 - qr_size, content_bottom - qr_size, x1, content_bottom)
        story_main = (x0, content_top, x1, story_qr[1] - gap)
        story_credit = (x0, story_qr[1], story_qr[0] - gap, content_bottom)
        return {
            "title": title,
            "body": body_left,
            "body_right": body_right,
            "story_text": story_main,
            "story_credit": story_credit,
            "story_qr": story_qr,
            "progress": progress,
            "attribution": attribution,
            "columns": 2,
        }

    def _draw_index(self, geometry):
        u = geometry["u"]
        portrait = geometry["portrait"]
        accent = self._palette["accent"]
        family = self.config.get("titleFontFamily", "Segoe UI")
        x0, y0, x1, y1 = geometry["title"]

        brand_font = tkfont.Font(family=family, size=max(11, int(round(self.BRAND_U * u))))
        hero_u = self.INDEX_HERO_U[0] if portrait else self.INDEX_HERO_U[1]
        hero_font = tkfont.Font(
            family=family, size=max(22, int(round(hero_u * u))), weight="bold",
        )
        date_font = tkfont.Font(
            family=family, size=max(11, int(round(self.INDEX_DATE_U * u))),
        )

        y = y0
        header_ids = []
        header_ids.append(self._track(self.canvas.create_text(
            x0, y, anchor="nw", text="good news", fill=INK_2, font=brand_font,
        )))
        y += brand_font.metrics("linespace") + 10 * u
        hero = resolve_index_title(self._upside)
        header_ids.append(self._track(self.canvas.create_text(
            x0, y, anchor="nw", text=hero, fill=INK, font=hero_font,
        )))
        # Prefer ascent+descent — linespace alone can under-clear on some DPI setups.
        hero_h = max(
            hero_font.metrics("linespace"),
            hero_font.metrics("ascent") + hero_font.metrics("descent") + 4,
        )
        y += hero_h + 14 * u
        header_ids.append(self._track(self.canvas.create_text(
            x0, y, anchor="nw",
            text=format_index_dateline(self._upside), fill=INK_2, font=date_font,
        )))
        date_h = max(
            date_font.metrics("linespace"),
            date_font.metrics("ascent") + date_font.metrics("descent") + 4,
            int(round(self.INDEX_DATE_U * u * 1.35)),
        )
        list_top = index_list_top(
            y + date_h,
            u=u,
            portrait=portrait,
            title_bottom=geometry["title"][3],
        )
        body_bottom = geometry["body"][3]

        stories = self._upside.get("stories") or []
        if geometry["columns"] == 1 or not geometry.get("body_right"):
            columns = [((geometry["body"][0], list_top, geometry["body"][2], body_bottom), stories)]
        else:
            left = [s for i, s in enumerate(stories) if i % 2 == 0]
            right = [s for i, s in enumerate(stories) if i % 2 == 1]
            lb = geometry["body"]
            rb = geometry["body_right"]
            columns = [
                ((lb[0], list_top, lb[2], body_bottom), left),
                ((rb[0], list_top, rb[2], body_bottom), right),
            ]

        for box, column_stories in columns:
            self._draw_index_column(box, column_stories, geometry)

        # Keep header copy above any card that still collides.
        for item in header_ids:
            try:
                self.canvas.tag_raise(item)
            except Exception:
                pass

        self._draw_countdown_ring(geometry, accent)

    def _draw_index_column(self, box, column_stories, geometry):
        u = geometry["u"]
        portrait = geometry["portrait"]
        family = self.config.get("titleFontFamily", "Segoe UI")
        bx0, by0, bx1, by1 = box
        row_hi, row_lo = self.INDEX_ROW_U
        row_font = tkfont.Font(
            family=family,
            size=max(13, int(round((row_hi if portrait else row_lo) * u))),
            weight="bold",
        )
        num_u = self.INDEX_NUM_U[0] if portrait else self.INDEX_NUM_U[1]
        num_font = tkfont.Font(
            family=family, size=max(18, int(round(num_u * u))), weight="bold",
        )
        meta_font = tkfont.Font(
            family=family, size=max(10, int(round(self.INDEX_META_U * u))),
        )

        count = max(1, len(column_stories))
        available = max(40.0, by1 - by0)
        gap = 14 * u if portrait else 12 * u
        # Fit the column — do not force a tall min that overflows into the header.
        card_h = (available - gap * (count - 1)) / count
        card_h = max(72 * u, min(148 * u, card_h))
        pad = self.CARD_PAD_U * u
        bar_w = self.ACCENT_BAR_U * u
        radius = self.CARD_RADIUS_U * u
        card_fill = mix_hex(self._palette["background"], "#000000", 0.42)

        y = by0
        for story in column_stories:
            if y + 64 * u > by1:
                break
            draw_h = min(card_h, max(64 * u, by1 - y))
            accent = story_accent(story, self._palette["accent"])
            number = int(story.get("index", 0)) + 1
            self._round_rect(
                bx0, y, bx1, y + draw_h,
                radius=min(radius, draw_h / 3), fill=card_fill,
                outline=mix_hex(accent, card_fill, 0.35),
                width=max(1, int(round(1.5 * u))),
            )
            self._track(self.canvas.create_rectangle(
                bx0, y + radius * 0.25, bx0 + bar_w, y + draw_h - radius * 0.25,
                fill=accent, outline=accent,
            ))

            inner_x = bx0 + bar_w + pad
            num_w = num_font.measure(str(number)) + 16 * u
            text_x = inner_x + num_w
            text_w = max(40.0, bx1 - pad - text_x)
            headline = str(story.get("headline") or "")
            lines = wrap_text(row_font, headline, text_w)[: self.INDEX_MAX_LINES]
            if len(wrap_text(row_font, headline, text_w)) > self.INDEX_MAX_LINES and lines:
                lines[-1] = self._ellipsise(row_font, lines[-1], text_w)

            self._track(self.canvas.create_text(
                inner_x, y + pad * 0.7, anchor="nw",
                text=str(number), fill=accent, font=num_font,
            ))
            ly = y + pad * 0.7
            for line in lines or [""]:
                if ly + row_font.metrics("linespace") > y + draw_h - pad:
                    break
                self._track(self.canvas.create_text(
                    text_x, ly, anchor="nw", text=line, fill=INK, font=row_font,
                ))
                ly += row_font.metrics("linespace")

            section = str(story.get("sectionName") or story.get("sectionId") or "").upper()
            published = str(story.get("publishedLabel") or "").strip()
            meta = "  ".join(part for part in (section, published) if part)
            if meta:
                meta_y = y + draw_h - pad - meta_font.metrics("linespace")
                if meta_y > ly:
                    self._track(self.canvas.create_text(
                        text_x, meta_y,
                        anchor="nw", text=meta, fill=accent, font=meta_font,
                    ))
            y += draw_h + gap

    def _draw_story(self, geometry, card: dict, index: int):
        u = geometry["u"]
        portrait = geometry["portrait"]
        accent = self._palette["accent"]
        family = self.config.get("titleFontFamily", "Segoe UI")
        stories = self._upside.get("stories") or []
        total = len(stories)

        tx0, ty0, tx1, ty1 = geometry["story_text"]
        cx0, cy0, cx1, cy1 = geometry.get("story_credit") or (tx0, ty1, tx1, ty1)
        qx0, qy0, qx1, qy1 = geometry["story_qr"]
        show_qr = bool(self._upside.get("showQr", True) and card.get("url"))
        qr_size = int(max(0, min(qx1 - qx0, qy1 - qy0))) if show_qr else 0
        if not show_qr:
            # Reclaim QR band for copy + credit.
            ty1 = max(ty1, qy1)
            cx1 = max(cx1, qx1)

        brand_font = tkfont.Font(family=family, size=max(11, int(round(self.BRAND_U * u))))
        progress_font = tkfont.Font(
            family=family, size=max(11, int(round(self.PROGRESS_U * u))),
        )
        self._track(self.canvas.create_text(
            tx0, ty0, anchor="nw", text="good news", fill=INK_2, font=brand_font,
        ))
        self._track(self.canvas.create_text(
            tx1, ty0, anchor="ne",
            text=f"{index + 1} of {total}", fill=INK_2, font=progress_font,
        ))

        y = ty0 + brand_font.metrics("linespace") + 18 * u
        chip_h = 40 * u
        chip_w = self._draw_section_chip(tx0, y, chip_h, card, accent, u)

        meta_parts = []
        published = str(card.get("publishedLabel") or "").strip()
        if published:
            meta_parts.append(published)
        if self._upside.get("showReadingTime", True):
            minutes = card.get("readingMinutes")
            if minutes is not None:
                try:
                    mins = int(minutes)
                    if mins > 0:
                        meta_parts.append(f"{mins} min read")
                except (TypeError, ValueError):
                    pass
        meta_font = tkfont.Font(family=family, size=max(11, int(round(self.META_U * u))))
        if meta_parts:
            self._track(self.canvas.create_text(
                tx0 + chip_w + 18 * u, y + chip_h / 2, anchor="w",
                text=" · ".join(meta_parts), fill=INK_2, font=meta_font,
            ))

        y += chip_h + 22 * u
        text_w = max(80.0, tx1 - tx0)
        floor_y = ty1

        hi, lo = self.HEADLINE_U_PORTRAIT if portrait else self.HEADLINE_U_LANDSCAPE
        headline_font = tkfont.Font(
            family=family, size=max(16, int(round(hi * u))), weight="bold",
        )
        max_headline_lines = 5 if portrait else 4
        headline_font, headline_lines = fit_text_font(
            headline_font, card.get("headline", ""),
            max_width=text_w, max_lines=max_headline_lines,
            min_size=max(14, int(round(lo * u))),
        )
        for line in headline_lines:
            line_h = headline_font.metrics("linespace")
            if y + line_h > floor_y:
                break
            self._track(self.canvas.create_text(
                tx0, y, anchor="nw", text=line, fill=INK, font=headline_font,
            ))
            y += line_h

        # Hairline rule under the headline (mockup).
        if y + 28 * u < floor_y:
            y += 18 * u
            self._track(self.canvas.create_line(
                tx0, y, tx0 + min(text_w, 520 * u), y,
                fill=mix_hex(INK, self._palette["background"], 0.55),
                width=max(1, int(round(2 * u))),
            ))
            y += 18 * u

        standfirst = str(card.get("standfirst") or "").strip()
        if standfirst and y + 20 * u < floor_y:
            sf_hi, sf_lo = self.STANDFIRST_U
            stand_font = tkfont.Font(
                family=family,
                size=max(12, int(round((sf_hi if portrait else sf_lo) * u))),
            )
            remaining_h = floor_y - y
            line_est = max(1, int(stand_font.metrics("linespace") or 20))
            max_stand_lines = max(1, min(5 if portrait else 4, int(remaining_h // line_est)))
            stand_font, stand_lines = fit_text_font(
                stand_font, standfirst,
                max_width=text_w, max_lines=max_stand_lines,
                min_size=max(11, int(round(16 * u))),
            )
            for line in stand_lines:
                line_h = stand_font.metrics("linespace")
                if y + line_h > floor_y:
                    break
                self._track(self.canvas.create_text(
                    tx0, y, anchor="nw", text=line, fill=INK_2, font=stand_font,
                ))
                y += line_h

        # Bottom credit + pips (left of QR), QR bottom-right.
        credit = credit_line(card)
        byline_font = tkfont.Font(
            family=family, size=max(12, int(round(22 * u))), weight="bold",
        )
        source_font = tkfont.Font(family=family, size=max(11, int(round(18 * u))))
        credit_y = cy0 + 8 * u
        if credit:
            byline = str(card.get("byline") or "").strip()
            source = str(card.get("sourceLabel") or "").strip()
            if byline and source and byline.lower() != source.lower():
                self._track(self.canvas.create_text(
                    cx0, credit_y, anchor="nw", text=byline, fill=INK, font=byline_font,
                ))
                credit_y += byline_font.metrics("linespace") + 4 * u
                self._track(self.canvas.create_text(
                    cx0, credit_y, anchor="nw",
                    text=self._ellipsise(source_font, source, cx1 - cx0),
                    fill=INK_2, font=source_font,
                ))
                credit_y += source_font.metrics("linespace") + 12 * u
            else:
                self._track(self.canvas.create_text(
                    cx0, credit_y, anchor="nw",
                    text=self._ellipsise(byline_font, credit, cx1 - cx0),
                    fill=INK, font=byline_font,
                ))
                credit_y += byline_font.metrics("linespace") + 12 * u

        if total > 1:
            self._draw_story_pips_at(cx0, credit_y + 10 * u, index, accent, u, max_x=cx1)

        if qr_size > 0:
            label_font = tkfont.Font(family=family, size=max(10, int(round(16 * u))))
            label = "Scan to read"
            label_w = label_font.measure(label)
            label_x = qx0 - 14 * u
            if label_x - label_w >= cx0:
                self._track(self.canvas.create_text(
                    label_x, qy0 + qr_size / 2, anchor="e",
                    text=label, fill=INK_2, font=label_font,
                ))
            else:
                self._track(self.canvas.create_text(
                    qx0 + qr_size / 2, qy0 - 8 * u, anchor="s",
                    text=label, fill=INK_2, font=label_font,
                ))
            self._draw_story_qr(qx0, qy0, qr_size, str(card.get("url") or ""))

        self._draw_countdown_ring(geometry, accent)

    def _draw_section_chip(self, x0, y0, chip_h, card, accent, u) -> float:
        label = str(card.get("sectionName") or card.get("sectionId") or "").upper()
        if not label:
            return 0.0
        font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(10, int(round(self.CHIP_U * u))),
            weight="bold",
        )
        pad_x = 18 * u
        width = font.measure(label) + pad_x * 2
        fill = mix_hex(accent, self._palette["background"], 0.28)
        self._round_rect(
            x0, y0, x0 + width, y0 + chip_h,
            radius=chip_h / 2, fill=fill, outline=accent,
            width=max(1, int(round(1.5 * u))),
        )
        self._track(self.canvas.create_text(
            x0 + pad_x, y0 + chip_h / 2, anchor="w", text=label, fill=INK, font=font,
        ))
        return width

    def _draw_story_pips(self, geometry, index: int, accent):
        u = geometry["u"]
        x0, y0, x1, _y1 = geometry["progress"]
        self._draw_story_pips_at(x0, y0 + 18 * u, index, accent, u, max_x=x1 - 110 * u)

    def _draw_story_pips_at(self, x0, cy, index: int, accent, u, *, max_x):
        stories = self._upside.get("stories") or []
        total = len(stories)
        r = 6 * u
        span = min(total, 8)
        x = x0 + r
        for i in range(span):
            if x + r > max_x:
                break
            self._track(self.canvas.create_oval(
                x - r, cy - r, x + r, cy + r,
                fill=INK if i == index else "",
                outline=INK if i == index else mix_hex(INK, self._palette["background"], 0.55),
                width=max(1, int(round(1.5 * u))),
            ))
            x += r * 3.0

    def _draw_countdown_ring(self, geometry, accent):
        u = geometry["u"]
        _x0, y0, x1, y1 = geometry["progress"]
        cy = (y0 + y1) / 2
        cx = x1 - 44 * u
        radius = 34 * u
        width = max(2, int(round(6 * u)))
        self._ring_ids = []
        self._track(self.canvas.create_oval(
            cx - radius, cy - radius, cx + radius, cy + radius,
            outline=self._palette["ring_track"], width=width,
        ))
        arc = self.canvas.create_arc(
            cx - radius, cy - radius, cx + radius, cy + radius,
            start=90, extent=-359.9, style="arc", outline=accent, width=width,
        )
        self._track(arc)
        self._ring_ids = [arc]
        font = tkfont.Font(family="Consolas", size=max(10, int(round(self.COUNTDOWN_U * u))))
        self._countdown_text_id = self._track(self.canvas.create_text(
            cx, cy, anchor="center", text=str(self._phase_seconds), fill=INK, font=font,
        ))
        self._ring_accent = accent

    def _update_countdown(self):
        if not self._ring_ids and self._countdown_text_id is None:
            return
        remaining = max(0.0, self._phase_ends_at - self._now())
        fraction = remaining / self._phase_seconds if self._phase_seconds else 0.0
        try:
            if self._ring_ids:
                self.canvas.itemconfigure(
                    self._ring_ids[0],
                    extent=-max(0.1, 359.9 * fraction),
                    outline=WARN_ACCENT if remaining <= 3 else self._ring_accent,
                )
            if self._countdown_text_id is not None:
                self.canvas.itemconfigure(
                    self._countdown_text_id, text=str(int(remaining + 0.5)),
                )
        except Exception:
            pass

    def _draw_attribution(self, geometry):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["attribution"]
        label = str(self._upside.get("attribution") or "").strip()
        if not label:
            return
        font = tkfont.Font(
            family="Consolas", size=max(8, int(round(self.ATTRIBUTION_U * u))),
        )
        # Stay clear of the countdown ring above-right.
        max_w = max(40.0, (x1 - x0) - 120 * u)
        label = self._ellipsise(font, label, max_w)
        self._track(self.canvas.create_text(
            x0, (y0 + y1) / 2, anchor="w", text=label, fill=INK_3, font=font,
        ))

    def _draw_empty_round(self, geometry=None):
        if geometry is None:
            geometry = self.compute_geometry()
        u = geometry["u"]
        box = geometry.get("story_text") or geometry["body"]
        x0, y0, x1, y1 = box
        title_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(56 * u))), weight="bold",
        )
        sub_font = tkfont.Font(family="Consolas", size=max(10, int(round(24 * u))))
        cy = (y0 + y1) / 2
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy, anchor="s",
            text="No stories yet", fill=INK, font=title_font,
        ))
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy + 16 * u, anchor="n",
            text="Check back after the next archive poll", fill=INK_2, font=sub_font,
        ))

    @staticmethod
    def _ellipsise(font, text: str, max_width: float) -> str:
        text = str(text or "")
        try:
            if font.measure(text) <= max_width:
                return text
        except Exception:
            return text
        trimmed = text
        while trimmed and font.measure(f"{trimmed}…") > max_width:
            trimmed = trimmed[:-1]
        return f"{trimmed.rstrip()}…" if trimmed else "…"

    @staticmethod
    def _build_qr_image(content: str, target_size: int):
        if Image is None or not content:
            return None
        try:
            import qrcode
            from qrcode.constants import ERROR_CORRECT_M
        except ImportError:
            return None
        try:
            qr = qrcode.QRCode(error_correction=ERROR_CORRECT_M, border=2, box_size=10)
            qr.add_data(content)
            qr.make(fit=True)
            modules = qr.modules_count + qr.border * 2
            qr.box_size = max(1, target_size // modules)
            return qr.make_image(fill_color="black", back_color="white").convert("RGB")
        except Exception as error:
            print(f"Upside News QR generation failed: {error}", file=sys.stderr)
            return None

    def _draw_story_qr(self, x, y, size, url: str):
        image = self._build_qr_image(url, size)
        if image is None or ImageTk is None:
            return
        try:
            photo = ImageTk.PhotoImage(image)
        except Exception:
            return
        self._photo_refs.append(photo)
        self._track(self.canvas.create_image(x, y, anchor="nw", image=photo))

    # -------------------------------------------------------------- artwork

    def _artwork_context(self, entry: dict, card: dict) -> tuple[str, dict | None, str, str]:
        if entry["phase"] == "index":
            section_id = "general"
            artwork = self._upside.get("indexArtwork") or {}
            background = str(self._upside.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._upside.get("indexAccent") or DEFAULT_INDEX_ACCENT)
        elif entry["phase"] == "empty":
            section_id = "general"
            artwork = self._upside.get("indexArtwork") or {}
            background = str(self._upside.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._upside.get("indexAccent") or DEFAULT_INDEX_ACCENT)
        else:
            section_id = str(card.get("sectionId") or "general")
            artwork = card.get("artwork") or {}
            background = str(card.get("background") or DEFAULT_INDEX_BACKGROUND)
            accent = str(card.get("accent") or DEFAULT_INDEX_ACCENT)
        return section_id, artwork, background, accent

    def _paint_artwork(self, geometry, entry: dict, card: dict):
        section_id, artwork, background, accent = self._artwork_context(entry, card)
        key = f"{entry['phase']}:{section_id}"
        if key == self._artwork_key and self._background_ids():
            self._lower_background()
            return
        self._artwork_key = key
        self._drop_background()

        self._draw_colour_field(geometry, background)
        self._draw_gradient_fallback(geometry, background, accent)

        portrait = bool(geometry["portrait"])
        url = (artwork or {}).get("portrait" if portrait else "landscape")
        if Image is None or not (url or upside_news_artwork_asset_path(section_id, portrait)):
            return
        self._fetch_token += 1
        token = self._fetch_token
        local = self._load_local_artwork(
            section_id, portrait, geometry["screen_w"], geometry["screen_h"],
        )
        if local is not None:
            self._apply_artwork(token, local)
        threading.Thread(
            target=self._fetch_artwork,
            args=(token, url, geometry["screen_w"], geometry["screen_h"], section_id, portrait),
            daemon=True,
        ).start()

    def _background_ids(self):
        return [
            item for item in (self._artwork_id, self._color_id, *self._fallback_ids)
            if item is not None
        ]

    def _shell_floor_id(self):
        overlay = getattr(self.shell, "overlay", None)
        return getattr(overlay, "shell_bg_id", None)

    def _stack_above(self, item, below):
        if item is None:
            return
        try:
            if below is not None:
                self.canvas.tag_raise(item, below)
            else:
                self.canvas.tag_lower(item)
        except Exception:
            pass

    def _lower_background(self):
        below = self._shell_floor_id()
        self._stack_above(self._color_id, below)
        if self._color_id is not None:
            below = self._color_id
        for item in self._fallback_ids:
            self._stack_above(item, below)
            below = item
        self._stack_above(self._artwork_id, below)

    def _drop_background(self):
        for item in self._background_ids():
            try:
                self.canvas.delete(item)
            except Exception:
                pass
            if item in self._item_ids:
                self._item_ids.remove(item)
        self._artwork_id = None
        self._color_id = None
        self._fallback_ids = []

    def _draw_colour_field(self, geometry, background):
        item = self.canvas.create_rectangle(
            0, 0, geometry["screen_w"], geometry["screen_h"],
            fill=background, outline="",
        )
        self._track(item)
        self._color_id = item
        self._stack_above(item, self._shell_floor_id())

    def _draw_gradient_fallback(self, geometry, background, accent):
        height = geometry["screen_h"]
        bands = 24
        below = self._color_id if self._color_id is not None else self._shell_floor_id()
        for i in range(bands):
            y0 = height * i / bands
            y1 = height * (i + 1) / bands
            colour = mix_hex(background, mix_hex(accent, background, 0.55), i / (bands - 1) * 0.55)
            item = self.canvas.create_rectangle(
                0, y0, geometry["screen_w"], y1 + 1, fill=colour, outline="",
            )
            self._track(item)
            self._stack_above(item, below)
            self._fallback_ids.append(item)
            below = item

    def _fetch_artwork(self, token, url, width, height, section_id=None, portrait=True):
        image = None
        for candidate in artwork_url_candidates(url, self.config):
            image = self._load_one_url(candidate, width, height)
            if image is not None:
                break
        if image is None:
            image = self._load_local_artwork(section_id, portrait, width, height)
        if image is None:
            print(
                "Upside News artwork unavailable over HTTP and from the bundled pack "
                f"(section={section_id or '?'}, url={url or 'none'})",
                file=sys.stderr, flush=True,
            )
            return
        self.root.after(0, lambda: self._apply_artwork(token, image))

    @classmethod
    def _load_local_artwork(cls, section_id, portrait, width, height):
        path = upside_news_artwork_asset_path(section_id, portrait)
        if path is None:
            return None
        try:
            return cls._scale_cover(Image.open(path).convert("RGB"), width, height)
        except Exception:
            return None

    @classmethod
    def _load_one_url(cls, url, width, height):
        global _unverified_ssl
        cache_file = upside_news_artwork_cache_path(url)
        if cache_file.exists():
            cached = cls._decode_cached(cache_file, width, height)
            if cached is not None:
                return cached
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": "alexa-broadcast-client/1.0"},
            )

            def download(context):
                kwargs = {"timeout": 12}
                if context is not None:
                    kwargs["context"] = context
                with urllib.request.urlopen(request, **kwargs) as response:
                    return response.read()

            contexts = []
            if _unverified_ssl or str(url).lower().startswith("https://"):
                contexts.append(ssl._create_unverified_context())
            contexts.append(None if not str(url).lower().startswith("https://") else ssl.create_default_context())
            seen = set()
            ordered = []
            for ctx in contexts:
                key = id(ctx)
                if key in seen:
                    continue
                seen.add(key)
                ordered.append(ctx)

            data = None
            last_error = None
            for context in ordered:
                try:
                    data = download(context)
                    if context is not None:
                        _unverified_ssl = True
                    break
                except Exception as error:
                    last_error = error
                    continue
            if data is None:
                raise last_error or RuntimeError("artwork download failed")
            if not looks_like_image(data):
                raise RuntimeError(f"artwork response was not an image ({url})")
            image = cls._scale_cover(Image.open(io.BytesIO(data)).convert("RGB"), width, height)
            try:
                cache_file.parent.mkdir(parents=True, exist_ok=True)
                cache_file.write_bytes(data)
            except Exception:
                pass
            return image
        except Exception:
            return None

    @classmethod
    def _decode_cached(cls, cache_file, width, height):
        try:
            data = cache_file.read_bytes()
            if not looks_like_image(data):
                raise RuntimeError("cached artwork is not an image")
            return cls._scale_cover(Image.open(io.BytesIO(data)).convert("RGB"), width, height)
        except Exception:
            try:
                cache_file.unlink()
            except Exception:
                pass
            return None

    @staticmethod
    def _scale_cover(image, width, height):
        width = max(1, int(width))
        height = max(1, int(height))
        src_w, src_h = image.size
        scale = max(width / src_w, height / src_h)
        resized = image.resize(
            (max(1, int(src_w * scale)), max(1, int(src_h * scale))),
            Image.Resampling.LANCZOS,
        )
        left = max(0, (resized.width - width) // 2)
        top = max(0, (resized.height - height) // 2)
        return resized.crop((left, top, left + width, top + height))

    def _apply_artwork(self, token, image):
        if token != self._fetch_token or not self.visible or ImageTk is None:
            return
        try:
            photo = ImageTk.PhotoImage(image)
        except Exception:
            return
        self._photo_refs.append(photo)
        self._drop_gradient_only()
        if self._artwork_id is not None:
            try:
                self.canvas.delete(self._artwork_id)
            except Exception:
                pass
            if self._artwork_id in self._item_ids:
                self._item_ids.remove(self._artwork_id)
            self._artwork_id = None
        item = self.canvas.create_image(0, 0, anchor="nw", image=photo)
        self._track(item)
        self._artwork_id = item
        self._lower_background()

    def _drop_gradient_only(self):
        for item in list(self._fallback_ids):
            try:
                self.canvas.delete(item)
            except Exception:
                pass
            if item in self._item_ids:
                self._item_ids.remove(item)
        self._fallback_ids = []
