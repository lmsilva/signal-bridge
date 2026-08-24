"""Roll Credits dashboard + image-only game showcase tour."""

from __future__ import annotations

import threading
import time
from datetime import datetime

try:
    from PIL import Image, ImageEnhance, ImageFilter, ImageTk
except ImportError:  # pragma: no cover - portable/runtime dependency
    Image = ImageEnhance = ImageFilter = ImageTk = None

from src.design_system import (
    ACCENT,
    BG,
    FILL,
    INK,
    INK_2,
    INK_3,
    LINE,
    PX_PER_POINT,
    WARN,
    design_u,
    is_portrait,
    measure_px_per_point,
    page_chrome,
    stack_rows,
    text_line_h,
    text_measurer,
)
from src.display_panels import BasePanel
from src.game_library_tour_panel import _http_get_json
from src.page_header import paint_page_header
from src.shared_photos_page import next_in_seconds, rail_remaining_fraction
from src.steam_now_playing_panel import SteamNowPlayingPanel, fit_image_contain, fit_image_cover
from src.text_marquee import MarqueeLine

TOUR_CHROME_H_U = 70
RAIL_TRACK = "#3a4048"
RAIL_DONE = "#6a7380"
RAIL_SEGMENT_CAP = 20

MONTH_ABBREVS = (
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
)


def clamp_seconds(value, fallback, minimum=1, maximum=300):
    try:
        return max(minimum, min(maximum, int(value)))
    except (TypeError, ValueError):
        return fallback


def choose_image_hero(card: dict) -> dict | None:
    """Prefer cover as hero when screenshots exist so the strip can show gameplay."""
    media = (card or {}).get("media") or {}
    hero = media.get("hero")
    shots = [shot for shot in (media.get("screenshots") or [])
             if isinstance(shot, dict) and shot.get("url")]
    if isinstance(hero, dict) and hero.get("kind") == "cover" and hero.get("url"):
        return hero
    # If the bridge still picked a screenshot as hero, keep it when no cover URL.
    if isinstance(hero, dict) and hero.get("kind") in ("screenshot", "cover") and hero.get("url"):
        return hero
    for shot in shots:
        return shot
    return None


def choose_showcase_shots(card: dict, *, limit: int = 3) -> list:
    """Screenshots for the strip — never leave portrait empty when shots exist."""
    media = (card or {}).get("media") or {}
    hero = media.get("hero") if isinstance(media.get("hero"), dict) else {}
    hero_id = hero.get("id")
    hero_url = hero.get("url")
    shots = []
    for shot in media.get("screenshots") or []:
        if not isinstance(shot, dict) or not shot.get("url"):
            continue
        if hero_id and shot.get("id") == hero_id:
            continue
        if hero_url and shot.get("url") == hero_url and hero.get("kind") == "screenshot":
            continue
        shots.append(shot)
        if len(shots) >= limit:
            break
    return shots


def format_month_axis_label(label=None, key=None) -> str:
    """Three-letter month for the dashboard axis (JAN…DEC) — never a lone J."""
    letters = "".join(ch for ch in str(label or "") if ch.isalpha())
    if len(letters) >= 3:
        return letters[:3].upper()
    key_text = str(key or "").strip()
    if len(key_text) >= 7 and key_text[4] == "-":
        try:
            month = int(key_text[5:7])
            if 1 <= month <= 12:
                return MONTH_ABBREVS[month - 1]
        except ValueError:
            pass
    if letters:
        return f"{letters.upper()}---"[:3]
    return "—"


def month_axis_font_size(slot_px: float) -> int:
    if slot_px >= 58:
        return 11
    if slot_px >= 44:
        return 10
    return 9


def tour_chrome_h(u: float) -> float:
    return TOUR_CHROME_H_U * float(u)


def next_in_label(remaining) -> str:
    try:
        left = max(0, int(remaining))
    except (TypeError, ValueError):
        left = 0
    return f"NEXT IN {left}s"


def tour_counter_label(index, total, *, dashboard=False) -> str:
    if dashboard:
        return "DASHBOARD"
    try:
        total_n = max(1, int(total or 1))
        index_n = max(0, int(index or 0))
    except (TypeError, ValueError):
        total_n, index_n = 1, 0
    return f"{index_n + 1:02d} / {total_n:02d}"


def choose_counter_grid(portrait: bool, value_count: int) -> tuple[int, int]:
    """Portrait with 4 stats must be 2×2 — a 1000px-wide 4-col row overlaps."""
    n = max(1, int(value_count or 1))
    if portrait and n >= 4:
        return 2, 2
    return n, 1


def months_chart_geom(
    box_h: float, pad: float = 20, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Reserved title / count / plot / axis bands so bars never strike the title."""
    height = max(120.0, float(box_h))
    pad_px = pad * u
    title_h = text_line_h(14, u=u, px_per_pt=px_per_pt)
    count_h = text_line_h(11, u=u, px_per_pt=px_per_pt)
    axis_h = text_line_h(11, u=u, px_per_pt=px_per_pt)
    title_bottom = pad_px + title_h
    chart_top = title_bottom + 8 * u + count_h
    chart_bottom = height - pad_px * 0.6 - axis_h - 8 * u
    if chart_bottom < chart_top + 24 * u:
        chart_bottom = chart_top + 24 * u
    return {
        "title_y": pad_px,
        "title_h": title_h,
        "title_bottom": title_bottom,
        "count_y": chart_top - 2 * u,
        "count_h": count_h,
        "chart_top": chart_top,
        "chart_bottom": chart_bottom,
        "axis_y": chart_bottom + 6 * u,
        "axis_h": axis_h,
        "bars_clear_of_title": chart_top >= title_bottom + count_h * 0.5,
        "fits": chart_bottom + 6 * u + axis_h <= height + 0.5,
    }


def counters_layout(
    box_h: float,
    *,
    note_count: int = 0,
    value_count: int = 4,
    portrait: bool = True,
    pad: float = 16,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Notes band + stat grid with real text heights (grid used to sit on notes)."""
    height = max(120.0, float(box_h))
    pad_px = pad * u
    cols, rows = choose_counter_grid(portrait, value_count)
    notes = max(0, int(note_count or 0))
    grid_gap = 12 * u
    # One stack for notes + every grid row keeps the type in step and the
    # numbers off the notes even when the card is short.
    spec = [(f"note{i}", 12, 4 if i < notes - 1 else 12) for i in range(notes)]
    for row in range(rows):
        spec.append((f"value{row}", 24, 2))
        spec.append((f"label{row}", 11, 12 if row < rows - 1 else 0))
    stack = stack_rows(
        spec, top=pad_px, available=height - pad_px * 2, u=u, px_per_pt=px_per_pt,
    )
    # Pin the grid to the bottom edge so spare height becomes breathing room
    # under the notes rather than a gap below the numbers.
    drop = max(0.0, height - pad_px - stack["bottom"])
    cells = [
        {
            "value_y": stack["y"][f"value{row}"] + drop,
            "value_h": stack["h"][f"value{row}"],
            "label_y": stack["y"][f"label{row}"] + drop,
            "label_h": stack["h"][f"label{row}"],
        }
        for row in range(rows)
    ]
    notes_bottom = (
        stack["y"][f"note{notes - 1}"] + stack["h"][f"note{notes - 1}"] if notes else pad_px
    )
    return {
        "notes": {f"note{i}": stack["y"][f"note{i}"] for i in range(notes)},
        "note_h": {f"note{i}": stack["h"][f"note{i}"] for i in range(notes)},
        "notes_bottom": notes_bottom,
        "cols": cols,
        "rows": rows,
        "cells": cells,
        "grid_top": cells[0]["value_y"],
        "grid_gap": grid_gap,
        "font_scale": stack["font_scale"],
        "grid_clear_of_notes": cells[0]["value_y"] >= notes_bottom - 0.5,
        "fits": stack["fits"] and cells[-1]["label_y"] + cells[-1]["label_h"]
        <= height - pad_px * 0.5 + 0.5,
    }


def latest_layout(
    box_w: float,
    box_h: float,
    *,
    note_count: int = 0,
    pad: float = 18,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> dict:
    """LATEST INDUCTED: cover on the left, a vertically centred copy stack right."""
    width = max(200.0, float(box_w))
    height = max(160.0, float(box_h))
    pad_px = pad * u
    header_h = text_line_h(15, u=u, px_per_pt=px_per_pt)
    art_top = pad_px + header_h + 10 * u
    art_h = max(60.0, height - art_top - pad_px)
    art_w = min(width * 0.38, art_h)
    rows = [("title", 24, 8), ("system", 14, 6), ("beaten", 13, 10), ("game", 22, 12)]
    for index in range(max(0, int(note_count or 0))):
        rows.append((f"note{index}", 13, 6))
    rows[-1] = (rows[-1][0], rows[-1][1], 0)
    band_h = height - art_top - pad_px
    stack = stack_rows(rows, top=art_top, available=band_h, u=u, px_per_pt=px_per_pt)
    drop = max(0.0, (band_h - (stack["bottom"] - art_top)) / 2)
    return {
        "art": (pad_px, art_top, pad_px + art_w, art_top + art_h),
        "header_y": pad_px,
        "text_x": pad_px + art_w + 18 * u,
        "y": {key: y + drop for key, y in stack["y"].items()},
        "h": stack["h"],
        "bottom": stack["bottom"] + drop,
        "font_scale": stack["font_scale"],
        "fits": stack["bottom"] + drop <= height - pad_px * 0.5 + 0.5,
    }


def title_card_layout(
    box_h: float, pad: float = 14, *, u: float = 1.0, px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Title + one meta line only — companion/facts live in the facts card."""
    height = max(70.0, float(box_h))
    stack = stack_rows(
        [("title", 24, 8), ("meta", 13, 0)],
        top=pad * u, available=height - pad * 2 * u, u=u, px_per_pt=px_per_pt,
    )
    return {
        "title_y": stack["y"]["title"],
        "title_h": stack["h"]["title"],
        "meta_y": stack["y"]["meta"],
        "meta_h": stack["h"]["meta"],
        "font_scale": stack["font_scale"],
        "meta_fits": stack["fits"],
        "fits": stack["fits"],
    }


def facts_card_layout(
    box_h: float,
    *,
    pad: float = 14,
    has_companion: bool = False,
    u: float = 1.0,
    px_per_pt: float = PX_PER_POINT,
) -> dict:
    height = max(80.0, float(box_h))
    pad_px = pad * u
    spec = []
    if has_companion:
        spec.append(("companion", 13, 8))
    spec.extend([("desc", 13, 10), ("facts", 11, 0)])
    stack = stack_rows(
        spec, top=pad_px, available=height - pad_px * 2, u=u, px_per_pt=px_per_pt,
    )
    line_h = stack["h"]["desc"]
    facts_h = stack["h"]["facts"]
    companion_h = stack["h"].get("companion", 0.0)
    desc_top = stack["y"]["desc"]
    facts_top = max(stack["y"]["facts"], height - pad_px - facts_h)
    desc_bottom = max(desc_top + line_h, facts_top - 10 * u)
    desc_h = desc_bottom - desc_top
    return {
        "companion_y": stack["y"].get("companion") if has_companion else None,
        "companion_h": companion_h,
        "desc_top": desc_top,
        "desc_bottom": desc_bottom,
        "desc_h": desc_h,
        "desc_line_h": line_h,
        "desc_lines": max(1, int(desc_h // line_h)),
        "facts_y": facts_top,
        "facts_h": facts_h,
        "font_scale": stack["font_scale"],
        "desc_clear_of_facts": desc_bottom <= facts_top + 0.5,
        "fits": stack["fits"] and facts_top + facts_h <= height - pad_px * 0.5 + 0.5,
    }


def clip_text_to_lines(
    text: str,
    *,
    width_px: float,
    font_size: int,
    max_lines: int,
    measure=None,
) -> str:
    """Word-wrap then hard-clip so Tk cannot stack description over the facts row.

    ``measure`` should report painted px width; without it we assume a wide
    glyph so the clip errs toward fewer lines rather than an overflow.
    """
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return ""
    max_lines = max(1, int(max_lines))
    if measure is None:
        def measure(value, _size=float(font_size)):
            return len(value) * _size * 0.72
    limit = max(40.0, float(width_px))
    chars_per_line = 8
    while chars_per_line < len(cleaned) and measure("M" * (chars_per_line + 1)) <= limit:
        chars_per_line += 1
    words = cleaned.split(" ")
    lines: list[str] = []
    current = ""
    overflow = False
    for word in words:
        trial = word if not current else f"{current} {word}"
        if len(trial) <= chars_per_line:
            current = trial
            continue
        if current:
            lines.append(current)
        current = word
        if len(lines) >= max_lines:
            overflow = True
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    elif current and len(lines) >= max_lines:
        overflow = True
    if overflow or " ".join(lines) != cleaned:
        last = lines[-1] if lines else ""
        clipped = last[: max(1, chars_per_line - 1)].rstrip(".,;: ")
        if lines:
            lines[-1] = f"{clipped}…"
        else:
            lines = [f"{clipped}…"]
    return "\n".join(lines[:max_lines])


def format_game_meta(card: dict) -> str:
    induction = (card or {}).get("induction")
    try:
        game_no = f"GAME #{int(induction):03d}" if induction else "GAME #—"
    except (TypeError, ValueError):
        game_no = "GAME #—"
    bits = [
        str((card or {}).get("systemLabel") or (card or {}).get("system") or "").upper(),
        game_no,
        format_beaten((card or {}).get("beatenAt")),
    ]
    return "  ·  ".join(bit for bit in bits if bit)


def tour_progress_layout(
    box, *, index: int = 0, total: int = 1, u: float = 1.0, px_per_pt: float = PX_PER_POINT,
) -> dict:
    """Slideshow-style chrome: counter + NEXT IN + segmented or continuous rail."""
    x0, y0, x1, y1 = box
    pad = 8 * u
    label_h = text_line_h(13, u=u, px_per_pt=px_per_pt)
    label_y = y0 + 2 * u + label_h / 2
    rail_top = y0 + 4 * u + label_h + 6 * u
    rail_h = max(6.0 * u, min(14.0 * u, (y1 - rail_top) - 6 * u))
    rail = (x0 + pad, rail_top, x1 - pad, rail_top + rail_h)
    try:
        total_n = max(1, int(total or 1))
        index_n = max(0, min(total_n - 1, int(index or 0)))
    except (TypeError, ValueError):
        total_n, index_n = 1, 0
    segmented = total_n <= RAIL_SEGMENT_CAP
    segments = []
    if segmented:
        gap = 4 * u
        inner_w = max(8.0, rail[2] - rail[0])
        seg_w = (inner_w - gap * (total_n - 1)) / total_n
        for i in range(total_n):
            sx = rail[0] + i * (seg_w + gap)
            segments.append((sx, rail[1], sx + seg_w, rail[3]))
    return {
        "counter_xy": (x0 + pad, label_y),
        "next_xy": (x1 - pad, label_y),
        "rail": rail,
        "segmented": segmented,
        "segments": segments,
        "current": index_n,
        "total": total_n,
        "rail_h": rail_h,
        "label_h": label_h,
        "fits": rail_top + rail_h <= y1 + 0.5,
    }


def layout_boxes(screen_w: int, screen_h: int, *, dashboard=False, timed=True) -> dict:
    chrome = page_chrome(screen_w, screen_h, timed=timed)
    u = chrome.u
    x0, x1 = chrome.content_x, chrome.content_x + chrome.content_w
    y0, y1 = chrome.content_top + 14 * u, chrome.content_bottom - 18 * u
    gap = 16 * u
    # Looping tours hide the overlay footer — always reserve in-panel NEXT IN chrome.
    progress_h = tour_chrome_h(u)
    y_body = y1 - progress_h - gap
    if dashboard:
        if chrome.portrait:
            avail = max(400.0, y_body - y0)
            hero_h = min(340 * u, avail * 0.26)
            counters_h = 276 * u
            months_h = min(240 * u, max(236 * u, avail * 0.18))
            systems_top = y0 + hero_h + counters_h + months_h + gap * 3
            return {
                "hero": (x0, y0, x1, y0 + hero_h),
                "counters": (x0, y0 + hero_h + gap, x1, y0 + hero_h + gap + counters_h),
                "months": (x0, y0 + hero_h + counters_h + gap * 2, x1,
                           y0 + hero_h + counters_h + gap * 2 + months_h),
                "systems": (x0, systems_top, x1, y_body),
                "progress": (x0, y1 - progress_h, x1, y1),
            }
        left_w = chrome.content_w * 0.36
        top_h = 180 * u
        mid = x0 + left_w + (x1 - x0 - left_w) / 2
        return {
            "hero": (x0, y0, x0 + left_w, y_body),
            "counters": (x0 + left_w + gap, y0, x1, y0 + top_h),
            "months": (x0 + left_w + gap, y0 + top_h + gap, mid, y_body),
            "systems": (mid + gap, y0 + top_h + gap, x1, y_body),
            "progress": (x0, y1 - progress_h, x1, y1),
        }
    if chrome.portrait:
        avail = max(400.0, y_body - y0)
        hero_h = min(480 * u, avail * 0.34)
        title_h = 116 * u
        facts_h = 196 * u
        shots_top = y0 + hero_h + title_h + facts_h + gap * 3
        return {
            "hero": (x0, y0, x1, y0 + hero_h),
            "title": (x0, y0 + hero_h + gap, x1, y0 + hero_h + gap + title_h),
            "facts": (x0, y0 + hero_h + title_h + gap * 2, x1,
                      y0 + hero_h + title_h + gap * 2 + facts_h),
            "shots": (x0, shots_top, x1, y_body),
            "progress": (x0, y1 - progress_h, x1, y1),
        }
    hero_w = chrome.content_w * 0.55
    return {
        "hero": (x0, y0, x0 + hero_w, y_body),
        "title": (x0 + hero_w + gap, y0, x1, y0 + 132 * u),
        "facts": (x0 + hero_w + gap, y0 + 148 * u, x1, y0 + 480 * u),
        "shots": (x0 + hero_w + gap, y0 + 496 * u, x1, y_body),
        "progress": (x0, y1 - progress_h, x1, y1),
    }


def format_beaten(value) -> str:
    if not value:
        return "DATE UNKNOWN"
    try:
        return f"BEATEN {datetime.strptime(str(value), '%Y-%m-%d').strftime('%b %d %Y').upper()}"
    except ValueError:
        return f"BEATEN {str(value).upper()}"


def month_bar_color(index: int, count: int) -> str:
    return WARN if count > 0 and index == count - 1 else ACCENT


def title_needs_marquee(title: str, available_px: float, measure=None) -> bool:
    """Marquee decision — measured when Tk is available, estimated otherwise."""
    text = str(title or "")
    width = measure(text) if measure else len(text) * 16
    return width > max(1, available_px)


class RollCreditsPanel(BasePanel):
    def __init__(self, root, shell, config: dict):
        super().__init__(root, shell, config)
        self._job = None
        self._token = 0
        self._tour = {}
        self._games = []
        self._cards = {}
        self._prefetching = set()
        self._index = 0
        self._phase = "dashboard"
        self._photo_refs = []
        self._image_ids = {}
        self._marquees = []
        self._dashboard_until = 0.0
        self._phase_started = 0.0
        self._phase_dwell = 0
        self._chrome_job = None
        self._chrome_token = 0
        self._chrome_next_id = None
        self._chrome_count_id = None
        self._chrome_fill_id = None
        self._chrome_geom = None
        self._scale = 1.0
        self._px_per_pt = PX_PER_POINT
        self._font_cache = {}

    def hide(self):
        self._cancel_chrome_tick()
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except Exception:
                pass
            self._job = None
        self._token += 1
        self._phase = "dashboard"
        self._dashboard_until = 0.0
        self._photo_refs = []
        self._image_ids = {}
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []
        for widget in list(self._widgets):
            try:
                widget.destroy()
            except Exception:
                pass
        self._widgets = []
        self._chrome_next_id = None
        self._chrome_count_id = None
        self._chrome_fill_id = None
        self._chrome_geom = None
        super().hide()

    def _track(self, item_id):
        self._item_ids.append(item_id)
        return item_id

    def _screen(self):
        overlay = getattr(self.shell, "overlay", None)
        return (
            int(getattr(overlay, "screen_w", 0) or self.root.winfo_screenwidth() or 1080),
            int(getattr(overlay, "screen_h", 0) or self.root.winfo_screenheight() or 1920),
        )

    def _render(self, payload: dict):
        self._tour = dict(payload or {})
        self._tour["secondsPerGame"] = clamp_seconds(payload.get("secondsPerGame"), 12, 5, 300)
        self._tour["dashboardSeconds"] = clamp_seconds(payload.get("dashboardSeconds"), 25, 10, 120)
        self._games = []
        self._cards = {}
        self._prefetching = set()
        self._index = 0
        self._phase = "dashboard"
        # Absolute deadline so playlist/prefetch races cannot leave the stats page early
        # (manual push was skipping the dashboard while scheduled walk-once looked fine).
        self._dashboard_until = time.monotonic() + self._tour["dashboardSeconds"]
        self._phase_started = time.time()
        self._phase_dwell = self._tour["dashboardSeconds"]
        self._draw_dashboard()
        self._schedule(self._tour["dashboardSeconds"], self._start_games)
        base = str(payload.get("cardBaseUrl") or "").rstrip("/")
        path = str(payload.get("playlistPath") or "")
        if base and path:
            token = self._token
            threading.Thread(target=self._playlist_worker, args=(token, f"{base}{path}"), daemon=True).start()

    def _schedule(self, seconds, callback):
        if self._job is not None:
            try:
                self.root.after_cancel(self._job)
            except Exception:
                pass
        dwell = max(1, int(seconds))
        self._phase_started = time.time()
        self._phase_dwell = dwell
        self._start_chrome_tick()
        self._job = self.root.after(dwell * 1000, callback)

    def _playlist_worker(self, token, url):
        data = _http_get_json(url, timeout=45, config=self.config)
        games = data.get("games") if data and data.get("ok") else None
        self.root.after(0, lambda: self._apply_playlist(token, games))

    def _apply_playlist(self, token, games):
        if token != self._token or not self.visible or not isinstance(games, list):
            return
        self._games = [row for row in games if isinstance(row, dict) and row.get("id")]
        # Prefetch only once showcase starts — early card fetches used to paint
        # game #1 over the dashboard on fast LAN pushes.
        if self._phase == "showcase":
            self._prefetch(self._index)

    def _paint_header(self):
        screen_w, screen_h = self._screen()
        paint_page_header(
            self.canvas, screen_w=screen_w, screen_h=screen_h, pill="roll credits",
            left_label="SOURCE", left_value="Signal",
            right_label="GAMES", right_value=str(self._tour.get("count") or len(self._games) or "—"),
            track=self._track,
        )

    def _clear_page(self):
        for item_id in list(self._item_ids):
            try:
                self.canvas.delete(item_id)
            except Exception:
                pass
        self._item_ids.clear()
        self._photo_refs = []
        self._image_ids = {}
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []
        for widget in list(self._widgets):
            try:
                widget.destroy()
            except Exception:
                pass
        self._widgets = []
        self._chrome_next_id = None
        self._chrome_count_id = None
        self._chrome_fill_id = None
        self._chrome_geom = None

    def _font(self, size, bold=False):
        scaled = max(8, int(round(float(size) * float(getattr(self, "_scale", 1.0) or 1.0))))
        return ("Segoe UI", scaled, "bold" if bold else "normal")

    def _sync_metrics(self):
        """Fonts are points, boxes are px — measure the ratio for this display."""
        screen_w, screen_h = self._screen()
        self._scale = design_u(screen_w, screen_h)
        self._font_cache = {}
        self._px_per_pt = measure_px_per_point(self.root, self._scale)

    def _measure(self, size, bold=False):
        """Painted width callable for a font, for description clipping."""
        key = (int(size), bool(bold))
        cached = self._font_cache.get(key)
        if cached is None:
            cached = text_measurer(self.root, self._font(size, bold))
            self._font_cache[key] = cached
        return cached

    def _card(self, box):
        return self._track(self.canvas.create_rectangle(*box, fill=FILL, outline=LINE, width=2))

    def _draw_dashboard(self):
        self._phase = "dashboard"
        self._clear_page()
        self._sync_metrics()
        self._paint_header()
        screen_w, screen_h = self._screen()
        timed = self._tour.get("loop") is False
        boxes = layout_boxes(screen_w, screen_h, dashboard=True, timed=timed)
        stats = self._tour.get("stats") or {}
        latest = stats.get("latest") or {}
        for name, box in boxes.items():
            if name == "progress" or not isinstance(box, tuple) or len(box) != 4:
                continue
            self._card(box)
        portrait = is_portrait(screen_w, screen_h)
        self._draw_latest(boxes["hero"], latest, stats, notes=not portrait)
        self._draw_counters(
            boxes["counters"], stats, notes_from_latest=portrait, latest=latest, portrait=portrait,
        )
        self._draw_months(boxes["months"], stats.get("months") or [], stats.get("undatedCount") or 0)
        self._draw_systems(boxes["systems"], stats.get("bySystem") or [], stats.get("beatenWith") or [])
        self._draw_tour_chrome(boxes["progress"], dashboard=True)

    def _draw_latest(self, box, latest, stats=None, *, notes=False):
        stats = stats or {}
        x0, y0, x1, y1 = box
        u = self._scale
        note_lines = list(self._stat_notes(stats, latest)) if notes else []
        layout = latest_layout(
            x1 - x0, y1 - y0, note_count=len(note_lines), u=u, px_per_pt=self._px_per_pt,
        )
        fs = layout["font_scale"]
        self._track(self.canvas.create_text(
            x0 + 18 * u, y0 + layout["header_y"], anchor="nw", text="LATEST INDUCTED",
            fill=INK_2, font=self._font(15 * fs, True),
        ))
        ax0, ay0, ax1, ay1 = layout["art"]
        self._draw_image_stage((x0 + ax0, y0 + ay0, x0 + ax1, y0 + ay1), choose_image_hero(latest))
        tx = x0 + layout["text_x"]
        text_w = max(100, int(x1 - tx - 18 * u))
        induction = latest.get("induction")
        rows = [
            ("title", latest.get("title") or "No games yet", INK, 24, True),
            ("system", str(latest.get("systemLabel") or latest.get("system") or "").upper(),
             ACCENT, 14, True),
            ("beaten", format_beaten(latest.get("beatenAt")), INK_2, 13, False),
            ("game", f"GAME #{int(induction):03d}" if induction else "GAME #—", WARN, 22, True),
        ]
        for index, (text, fill) in enumerate(note_lines):
            rows.append((f"note{index}", text, fill, 13, text.startswith("Milestone")))
        for key, text, fill, size, bold in rows:
            if key not in layout["y"] or not text:
                continue
            # One line per row — Tk wrapping would push the stack past the card.
            line = clip_text_to_lines(
                text, width_px=text_w, font_size=size * fs, max_lines=1,
                measure=self._measure(size * fs, bold),
            )
            self._track(self.canvas.create_text(
                tx, y0 + layout["y"][key], anchor="nw", text=line,
                fill=fill, font=self._font(size * fs, bold),
            ))

    @staticmethod
    def _stat_notes(stats, latest):
        latest = latest or {}
        stats = stats or {}
        notes = []
        if latest.get("beatenWith"):
            notes.append((f"beaten with {latest['beatenWith']}", INK_2))
        best = stats.get("bestMonth") or {}
        if best.get("label") and best.get("count"):
            notes.append((f"Best month · {best['label']} ({best['count']})", INK_3))
        milestone = stats.get("latestMilestone")
        if milestone:
            notes.append((f"Milestone · {milestone} games beaten", WARN))
        return notes

    def _draw_counters(self, box, stats, *, notes_from_latest=False, latest=None, portrait=False):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 16 * u
        notes = list(self._stat_notes(stats, latest)) if notes_from_latest else []
        top = stats.get("topBeatenWith") or {}
        buddy = str(top.get("name") or "").strip()
        values = [
            (stats.get("total") or 0, "TOTAL"),
            (stats.get("thisYear") or 0, "THIS YEAR"),
            (stats.get("systemsCount") or 0, "SYSTEMS"),
        ]
        if buddy:
            values.append((top.get("count") or 0, f"WITH {buddy.upper()[:10]}"))
        layout = counters_layout(
            y1 - y0, note_count=len(notes), value_count=len(values),
            portrait=portrait, u=u, px_per_pt=self._px_per_pt,
        )
        fs = layout["font_scale"]
        for index, (note, fill) in enumerate(notes):
            key = f"note{index}"
            if key not in layout["notes"]:
                continue
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["notes"][key], anchor="nw", text=note,
                fill=fill, font=self._font(12 * fs, True),
            ))
        cols, rows = layout["cols"], layout["rows"]
        cell_w = (x1 - x0 - pad * 2) / max(1, cols)
        for index, (value, label) in enumerate(values[: cols * rows]):
            col, row = index % cols, index // cols
            cx = x0 + pad + cell_w * (col + 0.5)
            cell = layout["cells"][row]
            self._track(self.canvas.create_text(
                cx, y0 + cell["value_y"], anchor="n", text=str(value),
                fill=INK, font=self._font(24 * fs, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + cell["label_y"], anchor="n", text=label,
                fill=INK_3, font=self._font(11 * fs, True),
            ))

    def _draw_months(self, box, months, undated):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        geom = months_chart_geom(y1 - y0, 20, u=u, px_per_pt=self._px_per_pt)
        self._track(self.canvas.create_text(
            x0 + pad, y0 + geom["title_y"], anchor="nw", text="BEATEN PER MONTH",
            fill=INK_2, font=self._font(14, True),
        ))
        rows = list(months)[-12:]
        max_count = max([int(row.get("count") or 0) for row in rows] or [1]) or 1
        chart_top = y0 + geom["chart_top"]
        chart_bottom = y0 + geom["chart_bottom"]
        usable = max(16.0, chart_bottom - chart_top)
        slot = (x1 - x0 - pad * 2) / max(1, len(rows))
        label_size = month_axis_font_size(slot / max(0.05, u))
        for index, row in enumerate(rows):
            count = int(row.get("count") or 0)
            height = max(2, usable * 0.88 * count / max_count)
            cx = x0 + pad + slot * (index + 0.5)
            color = month_bar_color(index, len(rows))
            bar_half = min(slot * 0.28, 18 * u)
            self._track(self.canvas.create_rectangle(
                cx - bar_half, chart_bottom - height, cx + bar_half, chart_bottom,
                fill=color, outline="",
            ))
            count_y = min(chart_bottom - height - 2 * u, y0 + geom["count_y"])
            count_y = max(count_y, y0 + geom["title_bottom"] + 2 * u)
            self._track(self.canvas.create_text(
                cx, count_y, anchor="s", text=str(count),
                fill=INK_2, font=self._font(11, True),
            ))
            self._track(self.canvas.create_text(
                cx, y0 + geom["axis_y"], anchor="n",
                text=format_month_axis_label(row.get("label"), row.get("key")),
                fill=INK_3 if index < len(rows) - 1 else WARN,
                font=self._font(label_size, True),
            ))
        if undated:
            self._track(self.canvas.create_text(
                x1 - pad, y0 + geom["title_y"], anchor="ne", text=f"+{undated} undated",
                fill=INK_3, font=self._font(11),
            ))

    def _draw_systems(self, box, systems, beaten_with=None):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 20 * u
        companions = list(beaten_with or [])[:4]
        title_h = text_line_h(14, u=u, px_per_pt=self._px_per_pt)
        row_min = text_line_h(12, u=u, px_per_pt=self._px_per_pt) + 8 * u
        band_h = (y1 - y0) - pad * 2
        companion_band = 0.0
        if companions:
            companion_band = title_h + 10 * u + row_min * len(companions)
            companion_band = min(companion_band, band_h * 0.45)
        systems_bottom = y1 - pad - (companion_band + 12 * u if companions else 0)
        self._track(self.canvas.create_text(
            x0 + pad, y0 + pad, anchor="nw", text="BY SYSTEM",
            fill=INK_2, font=self._font(14, True),
        ))
        rows_top = y0 + pad + title_h + 10 * u
        rows = list(systems)[: (5 if companions else 9)]
        max_count = max([int(row.get("count") or 0) for row in rows] or [1])
        room = max(row_min, systems_bottom - rows_top)
        row_h = max(row_min, min(48 * u, room / max(1, len(rows))))
        bar_half = min(7 * u, row_h * 0.28)
        for index, row in enumerate(rows):
            cy = rows_top + row_h * (index + 0.5)
            if cy + row_h * 0.5 > systems_bottom + 0.5:
                break
            label = str(row.get("label") or row.get("id") or "Other")
            count = int(row.get("count") or 0)
            self._track(self.canvas.create_text(
                x0 + pad, cy, anchor="w", text=label[:12],
                fill=INK_2, font=self._font(12, True),
            ))
            bar_x = x0 + min(150 * u, (x1 - x0) * 0.32)
            bar_w = max(20 * u, (x1 - bar_x - 55 * u) * count / max_count)
            self._track(self.canvas.create_rectangle(
                bar_x, cy - bar_half, bar_x + bar_w, cy + bar_half, fill=ACCENT, outline="",
            ))
            self._track(self.canvas.create_text(
                x1 - pad, cy, anchor="e", text=str(count), fill=INK, font=self._font(12, True),
            ))
        if not companions:
            return
        band_top = systems_bottom + 12 * u
        self._track(self.canvas.create_text(
            x0 + pad, band_top, anchor="nw", text="BEATEN WITH",
            fill=INK_2, font=self._font(14, True),
        ))
        max_buddy = max([int(row.get("count") or 0) for row in companions] or [1])
        buddy_top = band_top + title_h + 10 * u
        buddy_h = max(row_min, min(40 * u, (y1 - pad - buddy_top) / max(1, len(companions))))
        for index, row in enumerate(companions):
            cy = buddy_top + buddy_h * (index + 0.5)
            if cy + buddy_h * 0.5 > y1 - pad * 0.5 + 0.5:
                break
            name = str(row.get("name") or "—")
            count = int(row.get("count") or 0)
            self._track(self.canvas.create_text(
                x0 + pad, cy, anchor="w", text=name[:16],
                fill=INK_2, font=self._font(12, True),
            ))
            bar_x = x0 + min(150 * u, (x1 - x0) * 0.32)
            bar_w = max(20 * u, (x1 - bar_x - 55 * u) * count / max_buddy)
            self._track(self.canvas.create_rectangle(
                bar_x, cy - bar_half, bar_x + bar_w, cy + bar_half, fill=WARN, outline="",
            ))
            self._track(self.canvas.create_text(
                x1 - pad, cy, anchor="e", text=str(count), fill=INK, font=self._font(12, True),
            ))

    def _start_games(self):
        self._job = None
        if not self.visible:
            return
        remaining = self._dashboard_until - time.monotonic()
        if self._phase == "dashboard" and remaining > 0.2:
            self._schedule(remaining, self._start_games)
            return
        if not self._games:
            self._schedule(2, self._start_games)
            return
        self._index = 0
        self._show_game()

    def _card_url(self, game_id):
        base = str(self._tour.get("cardBaseUrl") or "").rstrip("/")
        return f"{base}/api/roll-credits/card?id={game_id}"

    def _prefetch(self, index):
        if not self._games or self._phase != "showcase":
            return
        for offset in (0, 1):
            target = index + offset
            if target >= len(self._games):
                if self._tour.get("loop") is False:
                    continue
                target %= len(self._games)
            game_id = str(self._games[target].get("id") or "")
            if not game_id or game_id in self._cards or game_id in self._prefetching:
                continue
            self._prefetching.add(game_id)
            token = self._token
            threading.Thread(target=self._card_worker, args=(token, game_id), daemon=True).start()

    def _card_worker(self, token, game_id):
        data = _http_get_json(self._card_url(game_id), timeout=20, config=self.config)
        card = data.get("card") if data and data.get("ok") else None
        self.root.after(0, lambda: self._store_card(token, game_id, card))

    def _store_card(self, token, game_id, card):
        self._prefetching.discard(game_id)
        if token != self._token or not isinstance(card, dict):
            return
        self._cards[game_id] = card
        # Prefetch during the dashboard must never wipe the stats page.
        if self._phase != "showcase" or not self.visible or not self._games:
            return
        current_id = str(self._games[self._index].get("id") or "")
        if current_id == str(game_id):
            self._draw_showcase(card)

    def _show_game(self):
        if not self._games:
            return
        self._phase = "showcase"
        self._prefetch(self._index)
        game = self._games[self._index]
        card = self._cards.get(str(game.get("id") or ""))
        self._draw_showcase(card or {
            "id": game.get("id"), "title": game.get("title"), "system": game.get("system"),
            "induction": game.get("induction"), "media": {},
        })
        self._schedule(self._tour["secondsPerGame"], self._advance)

    def _advance(self):
        self._job = None
        self._index += 1
        if self._index >= len(self._games):
            if self._tour.get("loop") is False:
                return
            self._index = 0
            self._dashboard_until = time.monotonic() + self._tour["dashboardSeconds"]
            self._draw_dashboard()
            self._schedule(self._tour["dashboardSeconds"], self._show_game)
            return
        self._show_game()

    def _draw_showcase(self, card):
        self._phase = "showcase"
        self._clear_page()
        self._sync_metrics()
        self._paint_header()
        screen_w, screen_h = self._screen()
        boxes = layout_boxes(screen_w, screen_h, timed=self._tour.get("loop") is False)
        self._draw_image_stage(boxes["hero"], choose_image_hero(card))
        for key in ("title", "facts", "shots"):
            self._card(boxes[key])
        self._draw_title(boxes["title"], card)
        self._draw_facts(boxes["facts"], card)
        self._draw_shots(boxes["shots"], card)
        self._draw_tour_chrome(boxes["progress"], dashboard=False)

    def _draw_image_stage(self, box, hero):
        x0, y0, x1, y1 = box
        self._track(self.canvas.create_rectangle(*box, fill="#061230", outline=LINE, width=2))
        self._image_ids["hero_bg"] = self._track(self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2))
        self._image_ids["hero"] = self._track(self.canvas.create_image((x0 + x1) / 2, (y0 + y1) / 2))
        tick = 24 * self._scale
        for ax, ay, bx, by in (
            (x0, y0 + tick, x0, y0), (x0, y0, x0 + tick, y0),
            (x1 - tick, y0, x1, y0), (x1, y0, x1, y0 + tick),
            (x0, y1 - tick, x0, y1), (x0, y1, x0 + tick, y1),
            (x1 - tick, y1, x1, y1), (x1, y1 - tick, x1, y1),
        ):
            self._track(self.canvas.create_line(ax, ay, bx, by, fill=ACCENT, width=3))
        if hero and hero.get("url"):
            token = self._token
            threading.Thread(
                target=self._image_worker,
                args=(token, str(hero["url"]), tuple(box)),
                daemon=True,
            ).start()

    def _image_worker(self, token, url, box):
        width, height = max(40, int(box[2] - box[0])), max(40, int(box[3] - box[1]))
        image = SteamNowPlayingPanel._fetch_photo(url, width, height, raw=True)
        self.root.after(0, lambda: self._apply_hero(token, image, width, height))

    def _apply_hero(self, token, image, width, height):
        if token != self._token or not self.visible or image is None or ImageTk is None:
            return
        try:
            backdrop = fit_image_cover(image, width, height).filter(ImageFilter.GaussianBlur(24))
            if ImageEnhance is not None:
                backdrop = ImageEnhance.Brightness(backdrop).enhance(0.42)
            foreground = fit_image_contain(image, max(40, width - 28), max(40, height - 28))
            bg_photo, fg_photo = ImageTk.PhotoImage(backdrop), ImageTk.PhotoImage(foreground)
            self._photo_refs.extend([bg_photo, fg_photo])
            self.canvas.itemconfigure(self._image_ids.get("hero_bg"), image=bg_photo)
            self.canvas.itemconfigure(self._image_ids.get("hero"), image=fg_photo)
        except Exception:
            return

    def _draw_title(self, box, card):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 14 * u
        layout = title_card_layout(y1 - y0, 14, u=u, px_per_pt=self._px_per_pt)
        fs = layout["font_scale"]
        title = card.get("title") or "Loading game…"
        title_w = max(80, int(x1 - x0 - pad * 2))
        title_font = self._font(24 * fs, True)
        title_h = max(24, int(layout["title_h"]))
        if title_needs_marquee(title, title_w, measure=self._measure(24 * fs, True)):
            marquee = MarqueeLine(self.root)
            viewport = marquee.build(
                parent=self.canvas, text=title, font=title_font, fill=INK,
                width=title_w, height=title_h, bg=FILL, center=False,
            )
            self._marquees.append(marquee)
            self._widgets.append(viewport)
            self._track(self.canvas.create_window(
                x0 + pad, y0 + layout["title_y"], anchor="nw",
                window=viewport, width=title_w, height=title_h,
            ))
        else:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["title_y"], anchor="nw",
                text=title, fill=INK, font=title_font,
            ))
        if layout["meta_fits"]:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["meta_y"], anchor="nw",
                text=format_game_meta(card), fill=WARN, font=self._font(13 * fs, True),
            ))

    def _draw_facts(self, box, card):
        x0, y0, x1, y1 = box
        u = self._scale
        pad = 14 * u
        companion = str(card.get("beatenWith") or "").strip()
        layout = facts_card_layout(
            y1 - y0, pad=14, has_companion=bool(companion), u=u, px_per_pt=self._px_per_pt,
        )
        fs = layout["font_scale"]
        text_w = max(80, int(x1 - x0 - pad * 2))
        if companion and layout["companion_y"] is not None:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["companion_y"], anchor="nw",
                text=f"beaten with {companion}", fill=INK_2, font=self._font(13 * fs, True),
            ))
        description = str(card.get("description") or "No description available.").strip()
        clipped = clip_text_to_lines(
            description, width_px=text_w, font_size=13 * fs,
            max_lines=layout["desc_lines"], measure=self._measure(13 * fs),
        )
        self._track(self.canvas.create_text(
            x0 + pad, y0 + layout["desc_top"], anchor="nw", text=clipped,
            fill=INK_2, font=self._font(13 * fs), width=text_w,
        ))
        facts = [
            f"{card.get('maxPlayers')} players" if card.get("maxPlayers") else None,
            card.get("difficulty"),
            str(card.get("releaseDate") or "")[:4] or None,
            card.get("developer"),
            card.get("publisher"),
            " · ".join(card.get("genres") or []),
        ]
        fact_line = "  ·  ".join(str(value) for value in facts if value)
        if fact_line:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["facts_y"], anchor="nw",
                text=fact_line, fill=ACCENT, font=self._font(11 * fs, True),
            ))

    def _draw_shots(self, box, card):
        shots = choose_showcase_shots(card, limit=3)
        if not shots:
            return
        x0, y0, x1, y1 = box
        gap = 12 * self._scale
        width = (x1 - x0 - gap * (len(shots) + 1)) / len(shots)
        for index, shot in enumerate(shots):
            sx0 = x0 + gap + index * (width + gap)
            stage = (sx0, y0 + gap, sx0 + width, y1 - gap)
            self._track(self.canvas.create_rectangle(*stage, fill=BG, outline=LINE))
            image_id = self._track(self.canvas.create_image((stage[0] + stage[2]) / 2,
                                                            (stage[1] + stage[3]) / 2))
            token = self._token
            threading.Thread(target=self._shot_worker,
                             args=(token, shot.get("thumbUrl") or shot["url"], image_id, stage),
                             daemon=True).start()

    def _shot_worker(self, token, url, image_id, box):
        image = SteamNowPlayingPanel._fetch_photo(
            url, max(40, int(box[2] - box[0])), max(40, int(box[3] - box[1])), cover=True,
        )
        self.root.after(0, lambda: self._apply_shot(token, image_id, image))

    def _apply_shot(self, token, image_id, image):
        if token != self._token or not self.visible or image is None or ImageTk is None:
            return
        photo = ImageTk.PhotoImage(image)
        self._photo_refs.append(photo)
        try:
            self.canvas.itemconfigure(image_id, image=photo)
        except Exception:
            pass

    def _cancel_chrome_tick(self):
        job = getattr(self, "_chrome_job", None)
        if job is not None:
            try:
                self.root.after_cancel(job)
            except Exception:
                pass
        self._chrome_job = None

    def _start_chrome_tick(self):
        self._cancel_chrome_tick()
        self._chrome_token = getattr(self, "_chrome_token", 0) + 1
        token = self._chrome_token
        self._tick_chrome(token)

    def _tick_chrome(self, token):
        if token != getattr(self, "_chrome_token", 0) or not getattr(self, "visible", False):
            return
        self._refresh_tour_chrome()
        try:
            self._chrome_job = self.root.after(33, lambda: self._tick_chrome(token))
        except Exception:
            self._chrome_job = None

    def _draw_tour_chrome(self, box, *, dashboard=False):
        self._chrome_next_id = None
        self._chrome_count_id = None
        self._chrome_fill_id = None
        self._chrome_geom = None
        if not box:
            return
        total = max(1, len(self._games) or int(self._tour.get("count") or self._tour.get("walkedCount") or 1))
        index = 0 if dashboard else max(0, int(self._index or 0))
        layout = tour_progress_layout(
            box, index=index, total=1 if dashboard else total,
            u=self._scale, px_per_pt=self._px_per_pt,
        )
        count_text = tour_counter_label(index, total, dashboard=dashboard)
        left = next_in_seconds(self._phase_started or time.time(), self._phase_dwell or 1)
        self._chrome_count_id = self._track(self.canvas.create_text(
            *layout["counter_xy"], anchor="w", text=count_text,
            fill=INK_2, font=self._font(13, True),
        ))
        self._chrome_next_id = self._track(self.canvas.create_text(
            *layout["next_xy"], anchor="e", text=next_in_label(left),
            fill=WARN, font=self._font(13, True),
        ))
        rx0, ry0, rx1, ry1 = layout["rail"]
        if layout["segmented"] and layout["segments"]:
            for i, (sx, sy, ex, ey) in enumerate(layout["segments"]):
                fill = RAIL_DONE if i < layout["current"] else RAIL_TRACK
                self._track(self.canvas.create_rectangle(sx, sy, ex, ey, fill=fill, outline=""))
                if i == layout["current"]:
                    fill_id = self.canvas.create_rectangle(sx, sy, sx, ey, fill=ACCENT, outline="")
                    self._track(fill_id)
                    self._chrome_fill_id = fill_id
                    self._chrome_geom = ("h", sx, ex, sy, ey - sy)
        else:
            self._track(self.canvas.create_rectangle(rx0, ry0, rx1, ry1, fill=RAIL_TRACK, outline=""))
            fill_id = self.canvas.create_rectangle(rx0, ry0, rx0, ry1, fill=ACCENT, outline="")
            self._track(fill_id)
            self._chrome_fill_id = fill_id
            self._chrome_geom = ("h", rx0, rx1, ry0, ry1 - ry0)
        self._refresh_tour_chrome()

    def _refresh_tour_chrome(self):
        next_id = getattr(self, "_chrome_next_id", None)
        geom = getattr(self, "_chrome_geom", None)
        fill_id = getattr(self, "_chrome_fill_id", None)
        started = getattr(self, "_phase_started", 0.0) or time.time()
        dwell = getattr(self, "_phase_dwell", 0) or 1
        now = time.time()
        if next_id is not None:
            try:
                self.canvas.itemconfigure(
                    next_id, text=next_in_label(next_in_seconds(started, dwell, now=now)),
                )
            except Exception:
                pass
        if fill_id is None or geom is None:
            return
        remaining = rail_remaining_fraction(started, dwell * 1000, now=now)
        elapsed = 1.0 - remaining
        try:
            _kind, x0, x1, y0, h = geom
            self.canvas.coords(fill_id, x0, y0, x0 + (x1 - x0) * elapsed, y0 + h)
        except Exception:
            pass
