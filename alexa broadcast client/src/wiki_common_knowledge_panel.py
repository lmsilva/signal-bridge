"""Wiki Common Knowledge overlay (wiki-common-knowledge.round).

One UDP packet carries the whole index → articles cycle; this panel pages
locally on ``root.after`` like ``UpsideNewsPanel``. Topic artwork is composed
for legibility — **do not add a scrim** over the JPEG field.
"""

from __future__ import annotations

import hashlib
import io
import re
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

from src.design_system import BG, INK, INK_2, INK_3, page_chrome
from src.display_panels import BasePanel
from src.message_scroll import MessageScrollController
from src.paths import app_root, asset_path
from src.text_marquee import MarqueeLine
from src.trivia_panel import (
    artwork_url_candidates,
    looks_like_image,
    mix_hex,
)

# Nested text widgets must sit on the shell navy — never the category purple —
# or they read as opaque bars across the artwork.
PANEL_INK_BG = BG

# Wikimedia rejects anonymous scrapers; keep a descriptive contactable UA.
WIKIMEDIA_USER_AGENT = (
    "SignalDisplayClient/1.0 (Alexa Broadcast Client; "
    "https://github.com/local/signal-bridge)"
)

# Wikimedia CDN only serves these thumbnail widths (others are blocked).
WIKIMEDIA_THUMB_STEPS = (320, 500, 960, 1280, 1920)

_unverified_ssl = False


def should_apply_fetched_image(*, fetch_gen: int, current_gen: int, visible: bool) -> bool:
    """True when an async image still belongs to the active paint generation."""
    return bool(visible) and int(fetch_gen) == int(current_gen)


def pick_wikimedia_thumb_step(min_width: int = 960) -> int:
    want = max(1, int(min_width or 960))
    for step in WIKIMEDIA_THUMB_STEPS:
        if step >= want:
            return step
    return WIKIMEDIA_THUMB_STEPS[-1]


def wikimedia_display_url(url: str, *, min_width: int = 960) -> str:
    """Rewrite upload.wikimedia.org URLs to a bounded standard thumb size."""
    raw = str(url or "").strip()
    if not raw:
        return ""
    step = pick_wikimedia_thumb_step(min_width)
    try:
        parts = urlsplit(raw)
    except Exception:
        return raw
    host = (parts.hostname or "").lower()
    if host != "upload.wikimedia.org":
        return raw
    path = parts.path or ""

    thumb_px = re.search(r"/(\d+)px-", path)
    if thumb_px:
        current = int(thumb_px.group(1))
        if current >= step:
            return raw
        new_path = re.sub(r"/\d+px-", f"/{step}px-", path, count=1)
        return urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment))

    original = re.match(
        r"^/wikipedia/([^/]+)/([0-9a-f])/([0-9a-f]{2})/([^/]+)$",
        path,
        flags=re.IGNORECASE,
    )
    if not original:
        return raw
    project, a, ab, file_name = original.groups()
    lower = file_name.lower()
    if lower.endswith((".tif", ".tiff")):
        new_path = (
            f"/wikipedia/{project}/thumb/{a}/{ab}/{file_name}/"
            f"lossy-page1-{step}px-{file_name}.jpg"
        )
    elif lower.endswith(".svg"):
        new_path = (
            f"/wikipedia/{project}/thumb/{a}/{ab}/{file_name}/"
            f"{step}px-{file_name}.png"
        )
    elif lower.endswith((".pdf", ".djvu")):
        return raw
    else:
        new_path = (
            f"/wikipedia/{project}/thumb/{a}/{ab}/{file_name}/"
            f"{step}px-{file_name}"
        )
    return urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment))


def hero_image_urls(card: dict | None, *, min_width: int = 960) -> list[str]:
    """Prefer thumbnail (sized up) over multi-MB originals for article heroes."""
    card = card or {}
    thumb = str(card.get("thumbnailUrl") or "").strip()
    image = str(card.get("imageUrl") or "").strip()
    out: list[str] = []
    for raw in (thumb, image):
        if not raw:
            continue
        sized = wikimedia_display_url(raw, min_width=min_width)
        for candidate in (sized, raw):
            if candidate and candidate not in out:
                out.append(candidate)
    return out


DEFAULT_INDEX_BACKGROUND = "#7A2396"
DEFAULT_INDEX_ACCENT = "#E897FF"
WARN_ACCENT = "#F5C453"
INFINITE_LOOP_CYCLES = 20
MIN_ARTICLE_SHOW_SECONDS = 4
ARTWORK_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
WIKI_COUNT_WORDS = {3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight"}


def wiki_ck_artwork_cache_dir() -> Path:
    return app_root() / "wiki-common-knowledge-artwork-cache"


def wiki_ck_artwork_cache_path(url: str) -> Path:
    text = str(url or "")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]
    ext = Path(urlsplit(text).path).suffix.lower()
    if ext not in {".webp", ".png", ".jpg", ".jpeg"}:
        ext = ".jpg"
    return wiki_ck_artwork_cache_dir() / f"{digest}{ext}"


def wiki_ck_artwork_asset_path(category_id: str) -> Path | None:
    """Bundled topic pack under assets/wiki-common-knowledge-artwork/."""
    key = str(category_id or "").strip().lower() or "misc"
    for ext in ARTWORK_EXTENSIONS:
        candidate = asset_path(Path("wiki-common-knowledge-artwork") / f"{key}{ext}")
        try:
            if candidate.exists():
                return candidate
        except Exception:
            continue
    for orientation in ("landscape", "portrait"):
        for ext in ARTWORK_EXTENSIONS:
            candidate = asset_path(
                Path("wiki-common-knowledge-artwork") / f"{key}-{orientation}{ext}",
            )
            try:
                if candidate.exists():
                    return candidate
            except Exception:
                continue
    return None


def build_phase_plan(wiki: dict) -> list[dict]:
    """Flatten a round into ordered index/article cards (pure, no Tk)."""
    wiki = wiki or {}
    stories = list(wiki.get("stories") or [])
    index_seconds = max(1, int(wiki.get("indexSeconds") or 12))
    article_seconds = max(1, int(wiki.get("articleSeconds") or 15))
    try:
        loop_count = int(wiki.get("loopCount"))
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
                "phase": "article",
                "seconds": article_seconds,
                "index": index,
                "cycle": cycle,
            })
    return plan


def resolve_article_phase_seconds(
    planned_seconds: int,
    remaining: float | None,
    *,
    min_show: int = MIN_ARTICLE_SHOW_SECONDS,
) -> tuple[str, int]:
    """Decide how long to air an article when the overlay clock is tight."""
    planned = max(1, int(planned_seconds or 1))
    if remaining is None:
        return ("article", planned)
    left = float(remaining)
    if left <= 0.5:
        return ("stop", 0)
    if left + 3.0 >= planned:
        return ("article", planned)
    if left >= min_show:
        return ("article", max(min_show, int(left)))
    return ("hold", max(1, int(left + 0.5)))


def resolve_index_title(wiki: dict) -> str:
    """Prefer bridge ``indexTitle``; fall back to period-based copy."""
    wiki = wiki or {}
    explicit = str(wiki.get("indexTitle") or "").strip()
    if explicit:
        return explicit
    count = len(wiki.get("stories") or [])
    period = str(wiki.get("period") or "daily").lower()
    word = WIKI_COUNT_WORDS.get(count, str(count))
    if period == "weekly":
        return f"This week's {word}"
    if period == "monthly":
        return "This month's most-read"
    if period == "yearly":
        return "This year's most-read"
    return f"What the world looked up — {word}"


def format_index_dateline(wiki: dict | None = None) -> str:
    wiki = wiki or {}
    explicit = str(wiki.get("dateline") or "").strip()
    if explicit:
        return explicit
    from datetime import datetime
    now = datetime.now()
    date_part = f"{now.strftime('%A')} {now.day} {now.strftime('%B')}"
    return f"{date_part} · Wikipedia"


def index_list_top(
    header_bottom: float,
    *,
    u: float,
    portrait: bool,
    title_bottom: float | None = None,
) -> float:
    pad = (48 * u) if portrait else (44 * u)
    top = float(header_bottom) + pad
    if title_bottom is not None:
        top = max(top, float(title_bottom) + (20 * u))
    return top


def index_card_row_layout(
    card_y: float,
    card_h: float,
    *,
    pad: float,
    thumb_size: float,
    num_h: float,
    title_h: float,
    desc_h: float = 0.0,
    meta_h: float = 0.0,
    gap_title_desc: float = 6.0,
    gap_desc_meta: float = 6.0,
) -> dict:
    """Vertically center number, thumbnail, and text stack as one content band.

    Returns y positions so rank / thumb / copy share a common mid-line inside
    the card (equal breathing room above and below).
    """
    card_y = float(card_y)
    card_h = max(1.0, float(card_h))
    pad = max(0.0, float(pad))
    thumb_size = max(1.0, float(thumb_size))
    title_h = max(0.0, float(title_h))
    desc_h = max(0.0, float(desc_h))
    meta_h = max(0.0, float(meta_h))
    gap_td = max(0.0, float(gap_title_desc))
    gap_dm = max(0.0, float(gap_desc_meta))

    text_stack = title_h
    if desc_h > 0:
        text_stack += gap_td + desc_h
    if meta_h > 0:
        text_stack += gap_dm + meta_h

    band_h = max(thumb_size, float(num_h), text_stack)
    inner_top = card_y + pad
    inner_bottom = card_y + card_h - pad
    inner_h = max(band_h, inner_bottom - inner_top)
    band_top = inner_top + max(0.0, (inner_h - band_h) / 2)
    if band_top + band_h > inner_bottom:
        band_top = max(inner_top, inner_bottom - band_h)

    mid = band_top + band_h / 2
    thumb_y = mid - thumb_size / 2
    text_top = mid - text_stack / 2
    title_y = text_top
    cursor = title_y + title_h
    if desc_h > 0:
        cursor += gap_td
        desc_y = cursor
        cursor += desc_h
    else:
        desc_y = title_y
    if meta_h > 0:
        cursor += gap_dm
        meta_y = cursor
    else:
        meta_y = title_y

    return {
        "band_top": band_top,
        "band_h": band_h,
        "mid_y": mid,
        "thumb_y": thumb_y,
        "num_cy": mid,
        "title_y": title_y,
        "desc_y": desc_y,
        "meta_y": meta_y,
        "text_stack_h": text_stack,
    }


def article_accent(story: dict, fallback: str = DEFAULT_INDEX_ACCENT) -> str:
    color = str((story or {}).get("accent") or "").strip()
    return color if color.startswith("#") and len(color) == 7 else fallback


def format_view_count(value) -> str:
    try:
        n = int(value or 0)
    except (TypeError, ValueError):
        return "0"
    if n >= 1_000_000:
        text = f"{n / 1_000_000:.1f}M"
        return text.replace(".0M", "M")
    if n >= 10_000:
        return f"{n // 1_000:,}K".replace(",", "")
    if n >= 1_000:
        text = f"{n / 1_000:.1f}K"
        return text.replace(".0K", "K")
    return f"{n:,}".replace(",", ",")


def format_views_line(story: dict) -> str:
    story = story or {}
    views = format_view_count(story.get("views"))
    parts = [f"{views} views"]
    try:
        delta_pct = story.get("viewsDeltaPct")
        if delta_pct is not None:
            pct = float(delta_pct)
            sign = "+" if pct >= 0 else ""
            parts.append(f"{sign}{pct:.0f}%")
    except (TypeError, ValueError):
        pass
    if len(parts) == 1:
        try:
            delta = int(story.get("viewsDelta") or 0)
            if delta:
                sign = "+" if delta >= 0 else ""
                parts.append(f"{sign}{format_view_count(abs(delta))}")
        except (TypeError, ValueError):
            pass
    return " · ".join(parts)


def hero_box_in_region(region: tuple, *, portrait: bool) -> tuple:
    """16:9 hero rectangle inside a content region (pure geometry)."""
    x0, y0, x1, y1 = region
    width = max(40.0, x1 - x0)
    height_avail = max(40.0, y1 - y0)
    if portrait:
        hero_w = width
        hero_h = hero_w * 9 / 16
        # Cap so portrait still leaves room for title + extract below.
        hero_h = min(hero_h, height_avail * 0.42)
        hero_w = hero_h * 16 / 9
        if hero_w > width:
            hero_w = width
            hero_h = hero_w * 9 / 16
        return (x0, y0, x0 + hero_w, y0 + hero_h)
    hero_h = height_avail
    hero_w = min(width, hero_h * 16 / 9)
    return (x0, y0, x0 + hero_w, y0 + hero_h)


def estimate_wrapped_lines(text: str, font, width: float, *, max_lines: int = 8) -> int:
    """Rough word-wrap line count for sizing text bands without a Tk measure pass."""
    text = str(text or "").strip()
    if not text:
        return 0
    max_lines = max(1, int(max_lines))
    width = max(40.0, float(width))
    words = text.replace("\n", " \n ").split()
    if not words:
        return 1
    lines = 1
    current = 0.0
    space = float(font.measure(" "))
    for word in words:
        if word == "\n":
            lines += 1
            current = 0.0
            if lines >= max_lines:
                return max_lines
            continue
        word_w = float(font.measure(word))
        needed = word_w if current <= 0 else current + space + word_w
        if needed <= width:
            current = needed
        else:
            lines += 1
            current = word_w
            if lines >= max_lines:
                return max_lines
    return lines


class WikiCommonKnowledgePanel(BasePanel):
    """Owns chrome: full-bleed artwork, title, per-page countdown ring."""

    BRAND_LABEL = "Wikipedia Common Knowledge"
    BRAND_U = 18
    INDEX_HERO_U = (68, 56)
    INDEX_DATE_U = 22
    INDEX_ROW_U = (28, 24)
    INDEX_DESC_U = (18, 16)
    INDEX_META_U = 16
    INDEX_NUM_U = (48, 42)
    HEADLINE_U_PORTRAIT = (52, 40)
    HEADLINE_U_LANDSCAPE = (48, 36)
    STANDFIRST_U = (24, 20)
    EXTRACT_U = (22, 20)
    CHIP_U = 18
    META_U = 18
    PROGRESS_U = 18
    ATTRIBUTION_U = 13
    CONTENT_INSET_PORTRAIT_U = 28
    CONTENT_INSET_LANDSCAPE_U = 16
    COUNTDOWN_U = 28
    QR_LANDSCAPE_U = 160
    QR_PORTRAIT_U = 150
    CARD_RADIUS_U = 18
    CARD_PAD_U = 22
    ACCENT_BAR_U = 8
    THUMB_U = (72, 64)
    FOOTER_U = 56
    HERO_ASPECT = 16 / 9

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._wiki = {}
        self._plan = []
        self._step = 0
        self._phase_job = None
        self._tick_job = None
        self._phase_ends_at = 0.0
        self._phase_seconds = 0
        # One generation per paint/hide — shared by artwork + every thumbnail so
        # concurrent fetches do not invalidate each other (old bug: only the
        # last card's image ever applied).
        self._fetch_token = 0
        self._photo_refs = []
        self._artwork_id = None
        self._artwork_key = None
        self._color_id = None
        self._fallback_ids = []
        self._ring_ids = []
        self._countdown_text_id = None
        self._marquees: list[MarqueeLine] = []
        self._scrollers: list[MessageScrollController] = []
        self._palette = {
            "background": DEFAULT_INDEX_BACKGROUND,
            "accent": DEFAULT_INDEX_ACCENT,
            "ring_track": mix_hex(DEFAULT_INDEX_BACKGROUND, "#FFFFFF", 0.14),
        }

    def hide(self):
        self._fetch_token += 1
        self._cancel_jobs()
        self._stop_text_motion()
        self._drop_background()
        self._photo_refs = []
        self._artwork_key = None
        try:
            self.canvas.configure(bg=self.config.get("overlayBackground", "#0B1730"))
        except Exception:
            pass
        super().hide()

    def _stop_text_motion(self):
        for marquee in self._marquees:
            # Capture before stop() — MarqueeLine.stop() nulls ``viewport``.
            viewport = getattr(marquee, "viewport", None)
            try:
                marquee.stop()
            except Exception:
                pass
            if viewport is not None:
                try:
                    viewport.destroy()
                except Exception:
                    pass
        self._marquees = []
        for scroller in self._scrollers:
            viewport = getattr(scroller, "viewport", None)
            try:
                scroller.stop()
            except Exception:
                pass
            if viewport is not None:
                try:
                    viewport.destroy()
                except Exception:
                    pass
        self._scrollers = []

    def _bind_dismiss(self, widget):
        """Nested marquees/scrollers eat clicks — forward them to overlay dismiss."""
        overlay = getattr(self.shell, "overlay", None)
        handler = getattr(overlay, "_on_dismiss_input", None)
        if widget is None or handler is None:
            return
        try:
            widget.bind("<Button-1>", handler)
        except Exception:
            pass

    def _bump_image_generation(self) -> int:
        self._fetch_token += 1
        return self._fetch_token

    def _ink_bg(self) -> str:
        return PANEL_INK_BG

    def _place_marquee(
        self, text: str, x0, y0, x1, y1, font, fill: str, *, bg: str | None = None, center: bool = False,
    ):
        text = str(text or "").strip()
        if not text:
            return
        width = max(40, int(x1 - x0))
        try:
            line_h = int(font.metrics("linespace"))
        except Exception:
            line_h = 28
        band_h = max(1, int(y1 - y0))
        height = max(line_h + 2, min(band_h, line_h + 10))
        y = int(y0 + max(0, (band_h - height) / 2))
        # Prefer a plain canvas text item when the line fits — nested marquees
        # with category-coloured backgrounds were painting purple bars.
        if font.measure(text) <= width:
            cy = y + height // 2
            if center:
                self._track(self.canvas.create_text(
                    int(x0 + width / 2), cy, anchor="center", text=text, fill=fill, font=font,
                ))
            else:
                # West anchor centers the glyph box on ``cy`` — nw + mid-y was
                # shifting fitting lines down by half a line (index cards looked top-heavy).
                self._track(self.canvas.create_text(
                    int(x0), cy, anchor="w", text=text, fill=fill, font=font,
                ))
            return
        fill_bg = bg or self._ink_bg()
        marquee = MarqueeLine(self.root)
        self._marquees.append(marquee)
        viewport = marquee.build(
            parent=self.canvas,
            text=text,
            font=font,
            fill=fill,
            width=width,
            height=height,
            bg=fill_bg,
            center=center,
        )
        self._bind_dismiss(viewport)
        win_id = self.canvas.create_window(
            int(x0), y, anchor="nw", window=viewport, width=width, height=height,
        )
        self._item_ids.append(win_id)
        self._widgets.append(viewport)

    def _place_vertical_scroll(
        self, text: str, x0, y0, x1, y1, font, fill: str, *, bg: str | None = None,
    ):
        text = str(text or "").strip()
        if not text:
            return
        width = max(40, int(x1 - x0))
        height = max(20, int(y1 - y0))
        fill_bg = bg or self._ink_bg()
        # Fast path: draw wrapped canvas text when it fits the band.
        probe = self.canvas.create_text(
            0, 0, anchor="nw", text=text, fill=fill, font=font, width=width, justify=tk.LEFT,
        )
        try:
            bbox = self.canvas.bbox(probe)
            text_h = (bbox[3] - bbox[1]) if bbox else 0
        except Exception:
            text_h = height + 1
        finally:
            try:
                self.canvas.delete(probe)
            except Exception:
                pass
        if text_h <= height:
            self._track(self.canvas.create_text(
                int(x0), int(y0), anchor="nw", text=text, fill=fill, font=font,
                width=width, justify=tk.LEFT,
            ))
            return
        viewport = tk.Canvas(
            self.canvas,
            width=width,
            height=height,
            highlightthickness=0,
            bd=0,
            bg=fill_bg,
        )
        text_id = viewport.create_text(
            0, 0, anchor="nw", text="", fill=fill, font=font, width=width, justify=tk.LEFT,
        )
        scroll_config = dict(self.config)
        base_pps = float(scroll_config.get("scrollPixelsPerSecond", 28) or 28)
        scroll_config["scrollPixelsPerSecond"] = max(1.0, base_pps * 0.65)
        scroller = MessageScrollController(
            viewport, text_id, scroll_config, self.root, on_finish=lambda: None,
        )
        needs_scroll = scroller.configure(text, center_x=0, viewport_height=height)
        self._bind_dismiss(viewport)
        win_id = self.canvas.create_window(
            int(x0), int(y0), anchor="nw", window=viewport, width=width, height=height,
        )
        self._item_ids.append(win_id)
        self._widgets.append(viewport)
        self._scrollers.append(scroller)
        if needs_scroll:
            scroller.start()

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
        self._wiki = payload.get("wikiCommonKnowledge") or {}
        self._plan = build_phase_plan(self._wiki)
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
        if entry["phase"] == "article":
            action, seconds = resolve_article_phase_seconds(
                entry["seconds"],
                self._remaining_overlay_seconds(),
            )
            if action == "stop":
                self._on_display_expired()
                return
            if action == "hold":
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
        self._cancel_jobs()

    def _now(self) -> float:
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
        self._stop_text_motion()
        self._clear_foreground()
        # Invalidate in-flight images from the previous step, then share one
        # generation across artwork + every index thumbnail.
        self._bump_image_generation()
        geometry = self.compute_geometry()
        card = self._card_for(entry)
        self._set_palette(entry, card)
        self._paint_artwork(geometry, entry, card)
        if entry["phase"] == "index":
            self._draw_index(geometry)
        elif entry["phase"] == "empty":
            self._draw_empty_round(geometry)
        else:
            self._draw_article(geometry, card, entry["index"])
        self._draw_attribution(geometry)
        self._lower_background()

    def _card_for(self, entry: dict) -> dict:
        if entry["phase"] != "article":
            return {}
        stories = self._wiki.get("stories") or []
        if not stories:
            return {}
        index = entry.get("index") or 0
        return stories[max(0, min(len(stories) - 1, index))]

    def _set_palette(self, entry: dict, card: dict):
        if entry["phase"] in ("index", "empty"):
            background = str(self._wiki.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._wiki.get("indexAccent") or DEFAULT_INDEX_ACCENT)
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
        u = chrome.u
        inset = cls.CONTENT_INSET_PORTRAIT_U * u
        x0 = chrome.content_x + inset
        x1 = chrome.content_x + chrome.content_w - inset
        top = chrome.content_top
        bottom = chrome.content_bottom - 8 * u
        gap = 16 * u

        attribution_h = 22 * u
        progress_h = 48 * u
        # Index header only — article pages start at `top` (no empty title band).
        title_h = 150 * u
        qr_size = min(cls.QR_PORTRAIT_U * u, (x1 - x0) * 0.30)

        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, x1, attribution[1])
        title = (x0, top, x1, top + title_h)
        content_bottom = progress[1] - gap
        # QR defines the bottom of the article stack so it cannot cover copy.
        story_qr = (x1 - qr_size, content_bottom - qr_size, x1, content_bottom)
        footer_top = story_qr[1]
        article_footer = (x0, footer_top, story_qr[0] - gap, content_bottom)
        article_main = (x0, top, x1, footer_top - gap)
        body = (x0, title[3] + gap, x1, content_bottom)
        return {
            "title": title,
            "body": body,
            "body_right": None,
            "article_main": article_main,
            "article_footer": article_footer,
            "story_qr": story_qr,
            "progress": progress,
            "attribution": attribution,
            "columns": 1,
        }

    @classmethod
    def compute_landscape_boxes(cls, chrome) -> dict:
        u = chrome.u
        inset = cls.CONTENT_INSET_LANDSCAPE_U * u
        x0 = chrome.content_x + inset
        x1 = chrome.content_x + chrome.content_w - inset
        top = chrome.content_top
        bottom = chrome.content_bottom - 8 * u
        gutter = 28 * u
        gap = 14 * u

        attribution_h = 20 * u
        progress_h = 48 * u
        title_h = 130 * u
        qr_size = min(cls.QR_LANDSCAPE_U * u, (x1 - x0) * 0.18)

        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, x1, attribution[1])
        title = (x0, top, x1, top + title_h)
        index_top = title[3] + gap
        content_bottom = progress[1] - gap

        col_w = (x1 - x0 - gutter) / 2
        left_x1 = x0 + col_w
        right_x0 = left_x1 + gutter
        body_left = (x0, index_top, left_x1, content_bottom)
        body_right = (right_x0, index_top, x1, content_bottom)

        # Article uses the full content height from `top` — no empty title void.
        story_qr = (x1 - qr_size, content_bottom - qr_size, x1, content_bottom)
        footer_top = story_qr[1]
        article_footer = (x0, footer_top, story_qr[0] - gap, content_bottom)
        hero_w = (x1 - x0 - gutter) * 0.44
        article_hero = (x0, top, x0 + hero_w, footer_top - gap)
        # Keep copy clear of the QR column.
        article_body = (
            article_hero[2] + gutter,
            top,
            story_qr[0] - gap,
            footer_top - gap,
        )
        article_main = (x0, top, x1, footer_top - gap)

        return {
            "title": title,
            "body": body_left,
            "body_right": body_right,
            "article_main": article_main,
            "article_hero": article_hero,
            "article_body": article_body,
            "article_footer": article_footer,
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
        title_w = max(80.0, float(x1 - x0))

        brand_font = tkfont.Font(family=family, size=max(11, int(round(self.BRAND_U * u))))
        hero_u = self.INDEX_HERO_U[0] if portrait else self.INDEX_HERO_U[1]
        hero_px = max(22, int(round(hero_u * u)))
        hero_font = tkfont.Font(
            family=family, size=hero_px, weight="bold",
        )
        date_font = tkfont.Font(
            family=family, size=max(11, int(round(self.INDEX_DATE_U * u))),
        )

        y = y0
        header_ids = []
        header_ids.append(self._track(self.canvas.create_text(
            x0, y, anchor="nw", text=self.BRAND_LABEL, fill=INK_2, font=brand_font,
        )))
        y += brand_font.metrics("linespace") + 10 * u
        hero = resolve_index_title(self._wiki)
        # Shrink until the hero fits in two wrapped lines, then draw with Tk wrap.
        while (
            estimate_wrapped_lines(hero, hero_font, title_w, max_lines=3) > 2
            and int(hero_font.cget("size")) > 18
        ):
            hero_font.configure(size=int(hero_font.cget("size")) - 2)
        hero_id = self._track(self.canvas.create_text(
            x0, y, anchor="nw", text=hero, fill=INK, font=hero_font,
            width=int(title_w), justify=tk.LEFT,
        ))
        header_ids.append(hero_id)
        try:
            bbox = self.canvas.bbox(hero_id)
            hero_h = max(1.0, float(bbox[3] - bbox[1])) if bbox else float(hero_font.metrics("linespace"))
        except Exception:
            hero_h = float(hero_font.metrics("linespace")) * max(
                1, estimate_wrapped_lines(hero, hero_font, title_w, max_lines=2),
            )
        y += hero_h + 14 * u
        header_ids.append(self._track(self.canvas.create_text(
            x0, y, anchor="nw",
            text=format_index_dateline(self._wiki), fill=INK_2, font=date_font,
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
        stories = self._wiki.get("stories") or []

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
        desc_hi, desc_lo = self.INDEX_DESC_U
        desc_font = tkfont.Font(
            family=family,
            size=max(10, int(round((desc_hi if portrait else desc_lo) * u))),
        )
        num_u = self.INDEX_NUM_U[0] if portrait else self.INDEX_NUM_U[1]
        # Cap rank size to the thumb so the pair reads as one aligned unit.
        thumb_u = self.THUMB_U[0] if portrait else self.THUMB_U[1]
        thumb_size = thumb_u * u
        num_px = max(18, min(int(round(num_u * u)), int(round(thumb_size * 0.78))))
        num_font = tkfont.Font(
            family=family, size=num_px, weight="bold",
        )
        meta_font = tkfont.Font(
            family=family, size=max(10, int(round(self.INDEX_META_U * u))),
        )

        count = max(1, len(column_stories))
        available = max(40.0, by1 - by0)
        gap = 14 * u if portrait else 12 * u
        card_h = (available - gap * (count - 1)) / count
        card_h = max(88 * u, min(168 * u, card_h))
        pad = self.CARD_PAD_U * u
        bar_w = self.ACCENT_BAR_U * u
        radius = self.CARD_RADIUS_U * u
        card_fill = mix_hex(self._palette["background"], "#000000", 0.42)

        title_h = float(row_font.metrics("linespace"))
        desc_line_h = float(desc_font.metrics("linespace"))
        meta_h = float(meta_font.metrics("linespace"))
        num_h = float(num_font.metrics("ascent") + num_font.metrics("descent"))
        gap_td = max(4.0, 6 * u)
        gap_dm = max(4.0, 6 * u)

        y = by0
        for story in column_stories:
            if y + 72 * u > by1:
                break
            draw_h = min(card_h, max(72 * u, by1 - y))
            accent = article_accent(story, self._palette["accent"])
            number = int(story.get("rank") or story.get("index", 0) + 1)
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

            desc = str(story.get("description") or "").strip()
            meta = format_views_line(story)
            layout = index_card_row_layout(
                y, draw_h,
                pad=pad,
                thumb_size=thumb_size,
                num_h=num_h,
                title_h=title_h,
                desc_h=desc_line_h if desc else 0.0,
                meta_h=meta_h if meta else 0.0,
                gap_title_desc=gap_td,
                gap_desc_meta=gap_dm,
            )

            inner_x = bx0 + bar_w + pad
            num_w = num_font.measure(str(number)) + 14 * u
            thumb_x = inner_x + num_w
            thumb_y = layout["thumb_y"]
            self._track(self.canvas.create_text(
                inner_x, layout["num_cy"], anchor="w",
                text=str(number), fill=accent, font=num_font,
            ))
            self._draw_thumb_placeholder(
                thumb_x, thumb_y, thumb_size, story, accent, card_fill,
            )
            self._fetch_thumb_async(story, thumb_x, thumb_y, thumb_size)

            text_x = thumb_x + thumb_size + pad * 0.75
            text_right = bx1 - pad
            title = str(story.get("title") or "")
            self._place_marquee(
                title,
                text_x, layout["title_y"], text_right, layout["title_y"] + title_h,
                row_font, INK, bg=card_fill, center=False,
            )
            if desc:
                self._place_marquee(
                    desc,
                    text_x, layout["desc_y"], text_right, layout["desc_y"] + desc_line_h,
                    desc_font, INK_2, bg=card_fill, center=False,
                )
            if meta:
                self._place_marquee(
                    meta,
                    text_x, layout["meta_y"], text_right, layout["meta_y"] + meta_h,
                    meta_font, accent, bg=card_fill, center=False,
                )
            y += draw_h + gap

    def _draw_thumb_placeholder(self, x, y, size, story, accent, fill):
        self._round_rect(
            x, y, x + size, y + size,
            radius=8, fill=mix_hex(accent, fill, 0.35),
            outline=mix_hex(accent, fill, 0.55),
            width=1,
        )

    def _fetch_thumb_async(self, story, x, y, size):
        url = str(story.get("thumbnailUrl") or story.get("imageUrl") or "").strip()
        if not url or Image is None or ImageTk is None:
            return
        # Share the paint-step generation — do not bump per thumbnail.
        token = self._fetch_token
        # Size up tiny feed thumbs so index cards stay sharp on large displays.
        load_urls = hero_image_urls(
            {"thumbnailUrl": url, "imageUrl": str(story.get("imageUrl") or "")},
            min_width=max(500, int(size) * 2),
        ) or [url]

        def worker():
            image = None
            for candidate in load_urls:
                image = self._load_cover_url(candidate, int(size), int(size))
                if image is not None:
                    break
            if image is None:
                return
            self.root.after(0, lambda: self._apply_inline_image(token, x, y, image))

        threading.Thread(target=worker, daemon=True).start()

    def _draw_article(self, geometry, card: dict, index: int):
        u = geometry["u"]
        portrait = geometry["portrait"]
        accent = self._palette["accent"]
        family = self.config.get("titleFontFamily", "Segoe UI")
        stories = self._wiki.get("stories") or []
        total = len(stories)
        ink_bg = self._ink_bg()

        show_qr = bool(self._wiki.get("showQr", True) and card.get("contentUrl"))
        qx0, qy0, qx1, qy1 = geometry["story_qr"]
        qr_size = int(max(0, min(qx1 - qx0, qy1 - qy0))) if show_qr else 0

        brand_font = tkfont.Font(family=family, size=max(11, int(round(self.BRAND_U * u))))
        progress_font = tkfont.Font(
            family=family, size=max(11, int(round(self.PROGRESS_U * u))),
        )

        if portrait:
            main = geometry["article_main"]
            mx0, my0, mx1, my1 = main
            self._track(self.canvas.create_text(
                mx0, my0, anchor="nw", text=self.BRAND_LABEL, fill=INK_2, font=brand_font,
            ))
            self._track(self.canvas.create_text(
                mx1, my0, anchor="ne",
                text=f"{index + 1} of {total}", fill=INK_2, font=progress_font,
            ))
            y = my0 + brand_font.metrics("linespace") + 10 * u
            hero = hero_box_in_region((mx0, y, mx1, my1), portrait=True)
            self._draw_hero_image(hero, card)
            self._draw_rank_pill(hero, card, accent, u)
            copy_top = hero[3] + 14 * u
            copy_box = (mx0, copy_top, mx1, my1)
        else:
            hero = geometry["article_hero"]
            cx0, cy0, cx1, cy1 = geometry["article_body"]
            # Page index lives in the copy column; brand sits above the chip.
            self._track(self.canvas.create_text(
                cx0, cy0, anchor="nw", text=self.BRAND_LABEL, fill=INK_2, font=brand_font,
            ))
            self._track(self.canvas.create_text(
                geometry["story_qr"][0] - 8 * u, cy0, anchor="ne",
                text=f"{index + 1} of {total}", fill=INK_2, font=progress_font,
            ))
            self._draw_hero_image(hero, card)
            self._draw_rank_pill(hero, card, accent, u)
            copy_box = (cx0, cy0 + brand_font.metrics("linespace") + 10 * u, cx1, cy1)

        tx0, ty0, tx1, ty1 = copy_box
        y = ty0
        chip_h = 34 * u
        self._draw_category_chip(tx0, y, chip_h, card, accent, u)
        y += chip_h + 12 * u
        text_w = max(80.0, tx1 - tx0)
        floor_y = ty1

        hi = self.HEADLINE_U_PORTRAIT[0] if portrait else self.HEADLINE_U_LANDSCAPE[0]
        headline_font = tkfont.Font(
            family=family, size=max(16, int(round(hi * u))), weight="bold",
        )
        headline = str(card.get("title") or "")
        line_h = max(1, int(headline_font.metrics("linespace") or 24))
        max_headline_lines = 3 if portrait else 2
        lines = estimate_wrapped_lines(headline, headline_font, text_w, max_lines=max_headline_lines)
        headline_band = max(line_h, lines * line_h + 4)
        headline_band = min(headline_band, max(line_h, floor_y - y - 100 * u))
        if headline and headline_band >= line_h:
            self._place_vertical_scroll(
                headline, tx0, y, tx1, y + headline_band, headline_font, INK, bg=ink_bg,
            )
            y += headline_band + 8 * u

        if y + 20 * u < floor_y:
            self._track(self.canvas.create_line(
                tx0, y, tx0 + min(text_w, 420 * u), y,
                fill=mix_hex(INK, ink_bg, 0.45),
                width=max(1, int(round(2 * u))),
            ))
            y += 12 * u

        description = str(card.get("description") or "").strip()
        if description and y + 18 * u < floor_y:
            sf_hi, sf_lo = self.STANDFIRST_U
            desc_font = tkfont.Font(
                family=family,
                size=max(12, int(round((sf_hi if portrait else sf_lo) * u))),
            )
            desc_lines = estimate_wrapped_lines(description, desc_font, text_w, max_lines=3)
            desc_h = max(
                desc_font.metrics("linespace"),
                desc_lines * desc_font.metrics("linespace") + 4,
            )
            desc_h = min(desc_h, max(20.0, floor_y - y - 60 * u))
            self._place_vertical_scroll(
                description, tx0, y, tx1, y + desc_h, desc_font, INK_2, bg=ink_bg,
            )
            y += desc_h + 10 * u

        extract = str(card.get("extract") or "").strip()
        if extract and y + 18 * u < floor_y:
            ex_hi, ex_lo = self.EXTRACT_U
            extract_font = tkfont.Font(
                family=family,
                size=max(11, int(round((ex_hi if portrait else ex_lo) * u))),
            )
            extract_h = max(20.0, floor_y - y)
            self._place_vertical_scroll(
                extract, tx0, y, tx1, y + extract_h, extract_font, INK_2, bg=ink_bg,
            )

        self._draw_article_footer(geometry, card, accent, u, show_qr, qr_size)
        if total > 1:
            fx0, fy0, fx1, _fy1 = geometry["article_footer"]
            # Pips sit under the hero in landscape; under the stats in portrait.
            pip_x = geometry["article_hero"][0] if not portrait else fx0
            self._draw_story_pips_at(pip_x, fy0 + 6 * u, index, accent, u, max_x=fx1 - 20 * u)

        self._draw_countdown_ring(geometry, accent)

    def _draw_hero_image(self, box, card: dict):
        x0, y0, x1, y1 = box
        w = max(1, int(x1 - x0))
        h = max(1, int(y1 - y0))
        fill = mix_hex(self._palette["background"], "#000000", 0.35)
        self._round_rect(x0, y0, x1, y1, radius=12, fill=fill, outline=self._palette["accent"], width=2)
        # Prefer thumbnail (sized up) — imageUrl used to point at multi-MB originals.
        urls = hero_image_urls(card, min_width=max(960, w))
        if not urls:
            cat = str(card.get("categoryId") or "misc")
            local = self._load_local_topic_image(cat, w, h)
            if local is not None:
                self._place_inline_photo(x0, y0, local)
            return
        token = self._fetch_token

        def worker():
            image = None
            for url in urls:
                image = self._load_cover_url(url, w, h)
                if image is not None:
                    break
            if image is None:
                image = self._load_local_topic_image(
                    str(card.get("categoryId") or "misc"), w, h,
                )
            if image is None:
                return
            self.root.after(0, lambda: self._apply_inline_image(token, x0, y0, image))

        threading.Thread(target=worker, daemon=True).start()

    def _draw_rank_pill(self, hero_box, card, accent, u):
        x0, y0, x1, y1 = hero_box
        family = self.config.get("titleFontFamily", "Segoe UI")
        rank = int(card.get("rank") or 1)
        font = tkfont.Font(family=family, size=max(11, int(round(20 * u))), weight="bold")
        label = f"#{rank}"
        pad_x, pad_y = 16 * u, 8 * u
        w = font.measure(label) + pad_x * 2
        h = font.metrics("linespace") + pad_y * 2
        px, py = x0 + 12 * u, y0 + 12 * u
        fill = mix_hex(accent, self._palette["background"], 0.18)
        self._round_rect(px, py, px + w, py + h, radius=h / 2, fill=fill, outline=accent, width=2)
        self._track(self.canvas.create_text(
            px + w / 2, py + h / 2, anchor="center", text=label, fill=INK, font=font,
        ))

    def _draw_article_footer(self, geometry, card, accent, u, show_qr, qr_size):
        family = self.config.get("titleFontFamily", "Segoe UI")
        ink_bg = self._ink_bg()
        fx0, fy0, fx1, fy1 = geometry["article_footer"]
        stats_font = tkfont.Font(family=family, size=max(11, int(round(18 * u))), weight="bold")
        views_text = format_views_line(card)
        spark_w = max(40.0, (fx1 - fx0) * 0.55)
        if self._wiki.get("showSparkline", True) and card.get("history"):
            spark_w = max(40.0, (fx1 - fx0) * 0.42)
        if views_text:
            self._place_marquee(
                views_text, fx0, fy0 + 4 * u, fx0 + (fx1 - fx0) * 0.38, fy1,
                stats_font, INK, bg=ink_bg, center=False,
            )
        if self._wiki.get("showSparkline", True):
            history = list(card.get("history") or [])
            if history:
                sx = fx0 + (fx1 - fx0) * 0.38 + 12 * u
                self._draw_views_sparkline(
                    sx, fy0 + 6 * u, spark_w, max(16.0, fy1 - fy0 - 12 * u),
                    history, accent, u,
                )

        if show_qr and qr_size > 0:
            qx0, qy0, _, _ = geometry["story_qr"]
            self._draw_story_qr(qx0, qy0, qr_size, str(card.get("contentUrl") or ""))

    def _draw_views_sparkline(self, x, y, w, h, history, accent, u):
        values = []
        for point in history:
            if isinstance(point, dict):
                try:
                    values.append(float(point.get("views") or point.get("value") or 0))
                except (TypeError, ValueError):
                    continue
            else:
                try:
                    values.append(float(point))
                except (TypeError, ValueError):
                    continue
        if len(values) < 2:
            return
        v_min, v_max = min(values), max(values)
        n = len(values)
        xs = [x + (w * i / (n - 1)) for i in range(n)]
        ys = []
        for val in values:
            frac = 0.5 if v_max == v_min else (val - v_min) / (v_max - v_min)
            ys.append(y + h * (1 - frac))
        for i in range(n - 1):
            self._track(self.canvas.create_line(
                xs[i], ys[i], xs[i + 1], ys[i + 1],
                fill=accent, width=max(2, int(3 * u)),
            ))
        for i, val in enumerate(values):
            r = max(2, int(4 * u))
            self._track(self.canvas.create_oval(
                xs[i] - r, ys[i] - r, xs[i] + r, ys[i] + r,
                fill=accent, outline="",
            ))

    def _draw_category_chip(self, x0, y0, chip_h, card, accent, u) -> float:
        label = str(card.get("categoryName") or card.get("categoryId") or "").upper()
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

    def _draw_story_pips_at(self, x0, cy, index: int, accent, u, *, max_x):
        stories = self._wiki.get("stories") or []
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
        label = str(self._wiki.get("attribution") or "").strip()
        if not label:
            return
        font = tkfont.Font(
            family="Consolas", size=max(8, int(round(self.ATTRIBUTION_U * u))),
        )
        # Plain text — a full-width marquee here was drawing a purple strip.
        cy = (y0 + y1) / 2
        self._track(self.canvas.create_text(
            x0, cy, anchor="w", text=label, fill=INK_3, font=font,
        ))

    def _draw_empty_round(self, geometry=None):
        if geometry is None:
            geometry = self.compute_geometry()
        u = geometry["u"]
        box = geometry.get("article_main") or geometry["body"]
        x0, y0, x1, y1 = box
        title_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(56 * u))), weight="bold",
        )
        sub_font = tkfont.Font(family="Consolas", size=max(10, int(round(24 * u))))
        cy = (y0 + y1) / 2
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy, anchor="s",
            text="No articles yet", fill=INK, font=title_font,
        ))
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy + 16 * u, anchor="n",
            text="Check back after the next Wikipedia poll", fill=INK_2, font=sub_font,
        ))

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
            print(f"Wiki Common Knowledge QR generation failed: {error}", file=sys.stderr)
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

    def _place_inline_photo(self, x, y, image):
        if ImageTk is None:
            return
        try:
            photo = ImageTk.PhotoImage(image)
        except Exception:
            return
        self._photo_refs.append(photo)
        self._track(self.canvas.create_image(x, y, anchor="nw", image=photo))

    def _apply_inline_image(self, token, x, y, image):
        if ImageTk is None:
            return
        if not should_apply_fetched_image(
            fetch_gen=token, current_gen=self._fetch_token, visible=self.visible,
        ):
            return
        self._place_inline_photo(x, y, image)

    def _artwork_context(self, entry: dict, card: dict) -> tuple[str, dict | None, str, str]:
        if entry["phase"] in ("index", "empty"):
            category_id = "misc"
            artwork = self._wiki.get("indexArtwork") or {}
            background = str(self._wiki.get("indexBackground") or DEFAULT_INDEX_BACKGROUND)
            accent = str(self._wiki.get("indexAccent") or DEFAULT_INDEX_ACCENT)
        else:
            category_id = str(card.get("categoryId") or "misc")
            artwork = card.get("artwork") or {}
            background = str(card.get("background") or DEFAULT_INDEX_BACKGROUND)
            accent = str(card.get("accent") or DEFAULT_INDEX_ACCENT)
        return category_id, artwork, background, accent

    def _artwork_url(self, artwork: dict | None) -> str:
        artwork = artwork or {}
        return str(artwork.get("topic") or artwork.get("fallback") or "").strip()

    def _paint_artwork(self, geometry, entry: dict, card: dict):
        category_id, artwork, background, accent = self._artwork_context(entry, card)
        key = f"{entry['phase']}:{category_id}"
        if key == self._artwork_key and self._background_ids():
            self._lower_background()
            return
        self._artwork_key = key
        self._drop_background()

        self._draw_colour_field(geometry, background)
        self._draw_gradient_fallback(geometry, background, accent)

        url = self._artwork_url(artwork)
        if Image is None or not (url or wiki_ck_artwork_asset_path(category_id)):
            return
        token = self._fetch_token
        local = self._load_local_topic_image(
            category_id, geometry["screen_w"], geometry["screen_h"],
        )
        if local is not None:
            self._apply_artwork(token, local)
        threading.Thread(
            target=self._fetch_artwork,
            args=(token, url, geometry["screen_w"], geometry["screen_h"], category_id),
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

    def _fetch_artwork(self, token, url, width, height, category_id=None):
        image = None
        for candidate in artwork_url_candidates(url, self.config):
            image = self._load_one_url(candidate, width, height)
            if image is not None:
                break
        if image is None:
            image = self._load_local_topic_image(category_id, width, height)
        if image is None:
            print(
                "Wiki Common Knowledge artwork unavailable over HTTP and from the bundled pack "
                f"(category={category_id or '?'}, url={url or 'none'})",
                file=sys.stderr, flush=True,
            )
            return
        self.root.after(0, lambda: self._apply_artwork(token, image))

    @classmethod
    def _load_local_topic_image(cls, category_id, width, height):
        path = wiki_ck_artwork_asset_path(category_id)
        if path is None:
            return None
        try:
            return cls._scale_cover(Image.open(path).convert("RGB"), width, height)
        except Exception:
            return None

    @classmethod
    def _load_cover_url(cls, url, width, height):
        for candidate in artwork_url_candidates(url, {}):
            image = cls._load_one_url(candidate, width, height)
            if image is not None:
                return image
        return None

    @classmethod
    def _load_one_url(cls, url, width, height):
        global _unverified_ssl
        if not url:
            return None
        cache_file = wiki_ck_artwork_cache_path(url)
        if cache_file.exists():
            cached = cls._decode_cached(cache_file, width, height)
            if cached is not None:
                return cached
        try:
            request = urllib.request.Request(
                url, headers={"User-Agent": WIKIMEDIA_USER_AGENT},
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
        if ImageTk is None:
            return
        if not should_apply_fetched_image(
            fetch_gen=token, current_gen=self._fetch_token, visible=self.visible,
        ):
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
