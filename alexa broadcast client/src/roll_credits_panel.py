"""Roll Credits dashboard + image-only game showcase tour."""

from __future__ import annotations

import threading
import time
from datetime import datetime

try:
    from PIL import Image, ImageEnhance, ImageFilter, ImageTk
except ImportError:  # pragma: no cover - portable/runtime dependency
    Image = ImageEnhance = ImageFilter = ImageTk = None

from src.design_system import ACCENT, BG, FILL, INK, INK_2, INK_3, LINE, WARN, is_portrait, page_chrome
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


def months_chart_geom(box_h: float, pad: float = 22) -> dict:
    """Reserved title / count / plot / axis bands so bars never strike the title."""
    height = max(120.0, float(box_h))
    title_y = pad
    title_bottom = pad + 24
    count_band = 18
    axis_band = 36
    chart_top = title_bottom + count_band
    chart_bottom = height - axis_band
    if chart_bottom < chart_top + 24:
        chart_bottom = chart_top + 24
    return {
        "title_y": title_y,
        "title_bottom": title_bottom,
        "count_y": chart_top - 3,
        "chart_top": chart_top,
        "chart_bottom": chart_bottom,
        "axis_y": chart_bottom + 8,
        "bars_clear_of_title": chart_top >= title_bottom + 16,
    }


def title_card_layout(box_h: float, pad: float = 16) -> dict:
    """Title + one meta line only — companion/facts live in the facts card."""
    height = max(70.0, float(box_h))
    title_y = pad
    meta_y = pad + 50
    return {
        "title_y": title_y,
        "meta_y": meta_y,
        "meta_fits": meta_y + 22 <= height - 6,
    }


def facts_card_layout(box_h: float, *, pad: float = 16, has_companion: bool = False) -> dict:
    height = max(80.0, float(box_h))
    companion_h = 24 if has_companion else 0
    facts_reserve = 36
    desc_top = pad + companion_h
    desc_bottom = height - pad - facts_reserve
    if desc_bottom < desc_top + 18:
        desc_bottom = desc_top + 18
    return {
        "companion_y": pad if has_companion else None,
        "desc_top": desc_top,
        "desc_bottom": desc_bottom,
        "desc_h": max(18.0, desc_bottom - desc_top),
        "facts_y": height - pad,
        "desc_clear_of_facts": desc_bottom <= height - pad - facts_reserve + 2,
    }


def clip_text_to_lines(text: str, *, width_px: float, font_size: int, max_lines: int) -> str:
    """Word-wrap then hard-clip so Tk cannot stack description over the facts row."""
    cleaned = " ".join(str(text or "").split())
    if not cleaned:
        return ""
    max_lines = max(1, int(max_lines))
    chars_per_line = max(8, int(float(width_px) / max(6.0, float(font_size) * 0.58)))
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


def tour_progress_layout(box, *, index: int = 0, total: int = 1) -> dict:
    """Slideshow-style chrome: counter + NEXT IN + segmented or continuous rail."""
    x0, y0, x1, y1 = box
    pad = 8
    label_y = y0 + 14
    rail_top = y0 + 30
    rail_h = max(8.0, min(14.0, (y1 - rail_top) - 8))
    rail = (x0 + pad, rail_top, x1 - pad, rail_top + rail_h)
    try:
        total_n = max(1, int(total or 1))
        index_n = max(0, min(total_n - 1, int(index or 0)))
    except (TypeError, ValueError):
        total_n, index_n = 1, 0
    segmented = total_n <= RAIL_SEGMENT_CAP
    segments = []
    if segmented:
        gap = 4
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
            hero_h = min(340 * u, avail * 0.24)
            counters_h = 260 * u
            months_h = min(240 * u, max(200 * u, avail * 0.18))
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
        title_h = 96 * u
        facts_h = 200 * u
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
        "title": (x0 + hero_w + gap, y0, x1, y0 + 140 * u),
        "facts": (x0 + hero_w + gap, y0 + 156 * u, x1, y0 + 480 * u),
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


def title_needs_marquee(title: str, available_px: float, average_glyph_px: float = 16) -> bool:
    return len(str(title or "")) * average_glyph_px > max(1, available_px)


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
        return ("Segoe UI", max(10, int(size)), "bold" if bold else "normal")

    def _card(self, box):
        return self._track(self.canvas.create_rectangle(*box, fill=FILL, outline=LINE, width=2))

    def _draw_dashboard(self):
        self._phase = "dashboard"
        self._clear_page()
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
        self._draw_latest(boxes["hero"], latest, stats)
        self._draw_counters(
            boxes["counters"], stats, notes_from_latest=portrait, latest=latest, portrait=portrait,
        )
        self._draw_months(boxes["months"], stats.get("months") or [], stats.get("undatedCount") or 0)
        self._draw_systems(boxes["systems"], stats.get("bySystem") or [], stats.get("beatenWith") or [])
        self._draw_tour_chrome(boxes["progress"], dashboard=True)

    def _draw_latest(self, box, latest, stats=None):
        stats = stats or {}
        x0, y0, x1, y1 = box
        pad = 18
        self._track(self.canvas.create_text(x0 + pad, y0 + pad, anchor="nw", text="LATEST INDUCTED",
                                            fill=INK_2, font=self._font(16, True)))
        portrait_box = (x1 - x0) < 700
        # Keep all hero copy inside this card — overflow used to paint over COUNTERS.
        art_w = min((x1 - x0) * (0.38 if portrait_box else 0.5), max(80, y1 - y0 - 70))
        art = (x0 + pad, y0 + 48, x0 + pad + art_w, y1 - pad)
        self._draw_image_stage(art, choose_image_hero(latest))
        tx = art[2] + 18
        text_bottom = y1 - pad
        cursor = y0 + 52
        self._track(self.canvas.create_text(tx, cursor, anchor="nw", text=latest.get("title") or "No games yet",
                                            fill=INK, font=self._font(22 if portrait_box else 28, True),
                                            width=max(100, x1 - tx - pad)))
        cursor += 46 if portrait_box else 70
        if cursor < text_bottom - 20:
            self._track(self.canvas.create_text(tx, cursor, anchor="nw",
                                                text=str(latest.get("systemLabel") or latest.get("system") or "").upper(),
                                                fill=ACCENT, font=self._font(14, True)))
            cursor += 28
        if cursor < text_bottom - 20:
            self._track(self.canvas.create_text(tx, cursor, anchor="nw", text=format_beaten(latest.get("beatenAt")),
                                                fill=INK_2, font=self._font(14)))
            cursor += 28
        induction = latest.get("induction")
        if cursor < text_bottom - 20:
            self._track(self.canvas.create_text(tx, cursor, anchor="nw",
                                                text=f"GAME #{int(induction):03d}" if induction else "GAME #—",
                                                fill=WARN, font=self._font(22 if portrait_box else 27, True)))
            cursor += 40
        # Landscape hero has room for secondary notes; portrait moves them to counters.
        if not portrait_box:
            if latest.get("beatenWith") and cursor < text_bottom - 20:
                self._track(self.canvas.create_text(tx, cursor, anchor="nw",
                                                    text=f"beaten with {latest['beatenWith']}",
                                                    fill=INK_2, font=self._font(15)))
                cursor += 36
            best = stats.get("bestMonth") or {}
            if best.get("label") and best.get("count") and cursor < text_bottom - 20:
                self._track(self.canvas.create_text(tx, cursor, anchor="nw",
                                                    text=f"Best month · {best['label']} ({best['count']})",
                                                    fill=INK_3, font=self._font(14)))
                cursor += 30
            milestone = stats.get("latestMilestone")
            if milestone and cursor < text_bottom - 20:
                self._track(self.canvas.create_text(tx, cursor, anchor="nw",
                                                    text=f"Milestone · {milestone} games beaten",
                                                    fill=WARN, font=self._font(14, True)))

    def _draw_counters(self, box, stats, *, notes_from_latest=False, latest=None, portrait=False):
        x0, y0, x1, y1 = box
        pad = 16
        latest = latest or {}
        notes = []
        if notes_from_latest:
            if latest.get("beatenWith"):
                notes.append(f"beaten with {latest['beatenWith']}")
            best = stats.get("bestMonth") or {}
            if best.get("label") and best.get("count"):
                notes.append(f"Best month · {best['label']} ({best['count']})")
            milestone = stats.get("latestMilestone")
            if milestone:
                notes.append(f"Milestone · {milestone} games beaten")
        note_h = 0
        if notes:
            note_h = min(22 * len(notes) + 8, max(28, (y1 - y0) * 0.34))
            cy = y0 + pad
            for note in notes:
                fill = WARN if note.startswith("Milestone") else INK_2
                self._track(self.canvas.create_text(
                    x0 + pad, cy, anchor="nw", text=note,
                    fill=fill, font=self._font(13, True),
                    width=max(80, int(x1 - x0 - pad * 2)),
                ))
                cy += 22
                if cy > y0 + pad + note_h:
                    break
        top = stats.get("topBeatenWith") or {}
        buddy = str(top.get("name") or "").strip()
        values = [
            (stats.get("total") or 0, "TOTAL"),
            (stats.get("thisYear") or 0, "THIS YEAR"),
            (stats.get("systemsCount") or 0, "SYSTEMS"),
        ]
        if buddy:
            values.append((top.get("count") or 0, f"WITH {buddy.upper()[:10]}"))
        band_top = y0 + pad + note_h
        band_h = max(60, y1 - band_top - pad)
        cols, rows = choose_counter_grid(portrait, len(values))
        if rows > 1:
            cell_w = (x1 - x0 - pad * 2) / cols
            cell_h = band_h / rows
            for index, (value, label) in enumerate(values[: cols * rows]):
                col, row = index % cols, index // cols
                cx = x0 + pad + cell_w * (col + 0.5)
                cy = band_top + cell_h * (row + 0.5)
                self._track(self.canvas.create_text(cx, cy - 14, text=str(value),
                                                    fill=INK, font=self._font(26, True)))
                self._track(self.canvas.create_text(cx, cy + 16, text=label,
                                                    fill=INK_3, font=self._font(12, True)))
            return
        width = (x1 - x0) / max(1, len(values))
        for index, (value, label) in enumerate(values):
            x = x0 + width * (index + 0.5)
            self._track(self.canvas.create_text(x, band_top + band_h * 0.38, text=str(value),
                                                fill=INK, font=self._font(32, True)))
            self._track(self.canvas.create_text(x, band_top + band_h * 0.72, text=label,
                                                fill=INK_3, font=self._font(12, True)))

    def _draw_months(self, box, months, undated):
        x0, y0, x1, y1 = box
        pad = 22
        geom = months_chart_geom(y1 - y0, pad)
        self._track(self.canvas.create_text(
            x0 + pad, y0 + geom["title_y"], anchor="nw", text="BEATEN PER MONTH",
            fill=INK_2, font=self._font(15, True),
        ))
        rows = list(months)[-12:]
        max_count = max([int(row.get("count") or 0) for row in rows] or [1]) or 1
        chart_top = y0 + geom["chart_top"]
        chart_bottom = y0 + geom["chart_bottom"]
        usable = max(16.0, chart_bottom - chart_top)
        slot = (x1 - x0 - pad * 2) / max(1, len(rows))
        label_size = month_axis_font_size(slot)
        for index, row in enumerate(rows):
            count = int(row.get("count") or 0)
            height = max(2, usable * 0.88 * count / max_count)
            cx = x0 + pad + slot * (index + 0.5)
            color = month_bar_color(index, len(rows))
            bar_half = min(slot * 0.28, 18)
            self._track(self.canvas.create_rectangle(
                cx - bar_half, chart_bottom - height, cx + bar_half, chart_bottom,
                fill=color, outline="",
            ))
            count_y = max(y0 + geom["count_y"], chart_bottom - height - 4)
            count_y = max(count_y, y0 + geom["title_bottom"] + 2)
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
                fill=INK_3, font=self._font(12),
            ))

    def _draw_systems(self, box, systems, beaten_with=None):
        x0, y0, x1, y1 = box
        pad = 22
        companions = list(beaten_with or [])[:4]
        split = bool(companions) and (y1 - y0) > 220
        systems_bottom = y1 - ((y1 - y0) * 0.38 if split else 0)
        self._track(self.canvas.create_text(x0 + pad, y0 + pad, anchor="nw", text="BY SYSTEM",
                                            fill=INK_2, font=self._font(16, True)))
        rows = list(systems)[: (5 if split else 9)]
        max_count = max([int(row.get("count") or 0) for row in rows] or [1])
        row_h = max(22, min(48, (systems_bottom - y0 - 70) / max(1, len(rows))))
        for index, row in enumerate(rows):
            cy = y0 + 62 + row_h * (index + 0.5)
            if cy > systems_bottom - 8:
                break
            label = str(row.get("label") or row.get("id") or "Other")
            count = int(row.get("count") or 0)
            self._track(self.canvas.create_text(x0 + pad, cy, anchor="w", text=label[:12],
                                                fill=INK_2, font=self._font(12, True)))
            bar_x = x0 + min(150, (x1 - x0) * 0.32)
            bar_w = max(20, (x1 - bar_x - 55) * count / max_count)
            self._track(self.canvas.create_rectangle(bar_x, cy - 7, bar_x + bar_w, cy + 7,
                                                     fill=ACCENT, outline=""))
            self._track(self.canvas.create_text(x1 - pad, cy, anchor="e", text=str(count),
                                                fill=INK, font=self._font(12, True)))
        if not companions:
            return
        band_top = systems_bottom + 8
        self._track(self.canvas.create_text(x0 + pad, band_top, anchor="nw", text="BEATEN WITH",
                                            fill=INK_2, font=self._font(16, True)))
        max_buddy = max([int(row.get("count") or 0) for row in companions] or [1])
        buddy_h = max(22, min(40, (y1 - band_top - 50) / max(1, len(companions))))
        for index, row in enumerate(companions):
            cy = band_top + 42 + buddy_h * (index + 0.5)
            name = str(row.get("name") or "—")
            count = int(row.get("count") or 0)
            self._track(self.canvas.create_text(x0 + pad, cy, anchor="w", text=name[:16],
                                                fill=INK_2, font=self._font(12, True)))
            bar_x = x0 + min(150, (x1 - x0) * 0.32)
            bar_w = max(20, (x1 - bar_x - 55) * count / max_buddy)
            self._track(self.canvas.create_rectangle(bar_x, cy - 7, bar_x + bar_w, cy + 7,
                                                     fill=WARN, outline=""))
            self._track(self.canvas.create_text(x1 - pad, cy, anchor="e", text=str(count),
                                                fill=INK, font=self._font(12, True)))

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
        tick = 24
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
        pad = 16
        layout = title_card_layout(y1 - y0, pad)
        title = card.get("title") or "Loading game…"
        title_w = max(80, int(x1 - x0 - pad * 2))
        title_font = self._font(26, True)
        title_h = max(36, int(layout["meta_y"] - layout["title_y"] - 4))
        if title_needs_marquee(title, title_w):
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
                text=format_game_meta(card), fill=WARN, font=self._font(14, True),
            ))

    def _draw_facts(self, box, card):
        x0, y0, x1, y1 = box
        pad = 16
        companion = str(card.get("beatenWith") or "").strip()
        layout = facts_card_layout(y1 - y0, pad=pad, has_companion=bool(companion))
        text_w = max(80, int(x1 - x0 - pad * 2))
        if companion and layout["companion_y"] is not None:
            self._track(self.canvas.create_text(
                x0 + pad, y0 + layout["companion_y"], anchor="nw",
                text=f"beaten with {companion}", fill=INK_2, font=self._font(14, True),
            ))
        description = str(card.get("description") or "No description available.").strip()
        max_lines = max(1, int(layout["desc_h"] // 20))
        clipped = clip_text_to_lines(
            description, width_px=text_w, font_size=14, max_lines=max_lines,
        )
        self._track(self.canvas.create_text(
            x0 + pad, y0 + layout["desc_top"], anchor="nw", text=clipped,
            fill=INK_2, font=self._font(14), width=text_w,
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
                x0 + pad, y0 + layout["facts_y"], anchor="sw",
                text=fact_line, fill=ACCENT, font=self._font(12, True),
            ))

    def _draw_shots(self, box, card):
        shots = choose_showcase_shots(card, limit=3)
        if not shots:
            return
        x0, y0, x1, y1 = box
        gap = 12
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
        layout = tour_progress_layout(box, index=index, total=1 if dashboard else total)
        count_text = tour_counter_label(index, total, dashboard=dashboard)
        left = next_in_seconds(self._phase_started or time.time(), self._phase_dwell or 1)
        self._chrome_count_id = self._track(self.canvas.create_text(
            *layout["counter_xy"], anchor="w", text=count_text,
            fill=INK_2, font=self._font(14, True),
        ))
        self._chrome_next_id = self._track(self.canvas.create_text(
            *layout["next_xy"], anchor="e", text=next_in_label(left),
            fill=WARN, font=self._font(14, True),
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
