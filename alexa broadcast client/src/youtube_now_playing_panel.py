"""YouTube Now Playing / Last Played overlay panel.

A sibling of the Steam and PSN panels rather than a subclass of either in
spirit: it reuses their artwork fetch/cache plumbing (so we do not duplicate
the SSL fallback and disk cache), but every band is its own.

The one thing that is easier here than on the Steam panel: YouTube thumbnails
are always 16:9, so the portrait/landscape aspect variance that complicated the
game hero simply does not exist (youtube.md §4). Everything else — the position
bar, the channel row, the collapsing stats row — is new.
"""

from __future__ import annotations

import threading
import tkinter.font as tkfont
from datetime import datetime, timezone

from src.design_system import (
    INK_3,
    STEAM_BG,
    STEAM_INK_DIM,
    STEAM_LINE,
    STEAM_STAGE_BG,
)
from src.payload_utils import parse_iso_timestamp
from src.steam_now_playing_panel import SteamNowPlayingPanel, fit_image_cover
from src.text_marquee import MarqueeLine

YOUTUBE_RED = "#FF3B30"
LIVE_RED = "#FF2D55"

# 16:9, exactly. Everything downstream derives from this one number.
THUMBNAIL_ASPECT = 16 / 9


def abbreviate_count(value) -> str | None:
    """`4.2M`, `312K`, `9,481`.

    Raw seven-digit numbers on a wall display are noise, not information
    (§4.4). Below 10,000 the exact figure still reads at a glance, so it is
    kept — with thousands separators.
    """
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    if n < 10_000:
        return f"{int(round(n)):,}"
    for scale, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if n >= scale:
            scaled = n / scale
            if scaled >= 100:
                return f"{int(round(scaled))}{suffix}"
            text = f"{scaled:.1f}".rstrip("0").rstrip(".")
            return f"{text}{suffix}"
    return str(int(round(n)))


def format_position(seconds) -> str:
    """`12:04`, or `1:02:04` past an hour. Always minutes:seconds at minimum."""
    try:
        total = max(0, int(round(float(seconds))))
    except (TypeError, ValueError):
        total = 0
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def live_position_seconds(
    base_position,
    duration,
    *,
    anchored_at: datetime | None,
    now: datetime | None = None,
) -> int:
    """Scrubber position that keeps walking while the overlay is up.

    Lounge only samples occasionally, so the UDP payload's `positionSeconds` is
    a snapshot. From the moment the card paints, advance that snapshot by wall
    clock until it hits `duration` (or forever when duration is unknown).
    """
    try:
        base = max(0, int(round(float(base_position or 0))))
    except (TypeError, ValueError):
        base = 0
    try:
        length = max(0, int(round(float(duration or 0))))
    except (TypeError, ValueError):
        length = 0
    if anchored_at is None:
        return min(base, length) if length > 0 else base
    clock = now or datetime.now(timezone.utc)
    if anchored_at.tzinfo is None and clock.tzinfo is not None:
        anchored_at = anchored_at.replace(tzinfo=timezone.utc)
    elif anchored_at.tzinfo is not None and clock.tzinfo is None:
        clock = clock.replace(tzinfo=timezone.utc)
    elapsed = max(0.0, (clock - anchored_at).total_seconds())
    position = int(round(base + elapsed))
    if length > 0:
        return min(position, length)
    return max(0, position)


def last_played_watched_seconds(yt: dict | None) -> int:
    """Seconds to show on a last-played card ("Watched X of Y").

    Prefer the final scrubber position (how far into the video), then the
    pause-aware watched total, then the wall-clock session span — never a
    silent 0:00 when we know they watched something.
    """
    source = yt or {}
    for key in ("positionSeconds", "watchedSeconds"):
        try:
            value = int(round(float(source.get(key))))
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value
    started = parse_iso_timestamp(source.get("startedAt")) if source.get("startedAt") else None
    ended = parse_iso_timestamp(source.get("endedAt")) if source.get("endedAt") else None
    if started and ended:
        span = int(round((ended - started).total_seconds()))
        if span > 0:
            try:
                duration = int(round(float(source.get("durationSeconds") or 0)))
            except (TypeError, ValueError):
                duration = 0
            return min(span, duration) if duration > 0 else span
    return 0


def format_upload_date(raw) -> str | None:
    dt = parse_iso_timestamp(raw) if raw else None
    if not dt:
        return None
    local = dt.astimezone() if dt.tzinfo else dt
    return local.strftime("%d %b %Y").lstrip("0")


class YoutubeNowPlayingPanel(SteamNowPlayingPanel):
    """Owns its chrome: 16:9 hero, position bar, channel row, stats row."""

    SOURCE_CHIP = "YOUTUBE"
    PAYLOAD_KEY = "youtube"
    DEFAULT_TITLE = "YouTube"
    ACCENT = YOUTUBE_RED

    # §4.4 type ramp, in design units (multiplied by `u`).
    # Title is a single marquee line — long names scroll instead of wrapping.
    TITLE_SIZE_PORTRAIT = 52
    TITLE_SIZE_LANDSCAPE = 46
    CHANNEL_SIZE_PORTRAIT = 32
    CHANNEL_SIZE_LANDSCAPE = 28
    SUBS_SIZE_PORTRAIT = 26
    SUBS_SIZE_LANDSCAPE = 24
    DESC_SIZE_PORTRAIT = 26
    DESC_SIZE_LANDSCAPE = 24
    STAT_VALUE_PORTRAIT = 40
    STAT_VALUE_LANDSCAPE = 26
    STAT_LABEL_PORTRAIT = 20
    STAT_LABEL_LANDSCAPE = 18
    UPLOAD_SIZE_PORTRAIT = 22
    UPLOAD_SIZE_LANDSCAPE = 20
    DEVICE_SIZE = 18

    AVATAR_DIAMETER = 52
    POSITION_BAR_H = 8

    # Portrait description band: the floor keeps a couple of lines on a short
    # column, the ceiling stops a tall one turning the card into a wall of copy.
    DESC_MIN_PORTRAIT = 140
    DESC_MAX_PORTRAIT = 460
    HERO_MIN_PORTRAIT = 200
    GAP_MAX_PORTRAIT = 48

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self._yt = {}
        self._avatar_id = None
        self._position_fill_id = None
        self._position_caption_id = None
        self._position_track = None
        self._position_base = 0
        self._position_duration = 0
        self._position_anchored_at = None
        self._position_tick_job = None
        self._marquees: list[MarqueeLine] = []

    def hide(self):
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []
        self._stop_position_tick()
        super().hide()

    # -------------------------------------------------------------- render

    def _render(self, payload: dict):
        yt = payload.get("youtube") or {}
        self._yt = yt
        # Parent helpers (elapsed tick, image fetch, last-played) read `_steam`.
        self._steam = yt
        started = yt.get("startedAt")
        self._started_at = parse_iso_timestamp(started) if started else None

        rect = self._content_rect()
        self._draw_background(0, 0, rect["screen_w"], rect["screen_h"])

        has_desc = bool(str(yt.get("description") or "").strip())
        if rect["portrait"]:
            self._layout_boxes = self._compute_portrait_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_desc=has_desc,
            )
        else:
            self._layout_boxes = self._compute_landscape_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_desc=has_desc,
            )
        self._layout_boxes["portrait"] = rect["portrait"]
        self._draw_chrome(self._layout_boxes)
        self._draw_position(self._layout_boxes, yt)
        self._draw_meta(self._layout_boxes, yt)
        self._draw_stats(self._layout_boxes, yt)
        self._start_image_fetches(yt)
        self._schedule_elapsed_tick()
        self._schedule_position_tick()

    # ------------------------------------------------------------ geometry

    def _compute_portrait_boxes(self, x0, y0, x1, y1, *, u=1.0, has_desc=True, **_kwargs):
        """Stacked: header, 16:9 hero, position bar, title, channel, desc, stats.

        The hero height is derived from the column width, never chosen: a 16:9
        box whose height is guessed will letterbox, and a letterboxed thumbnail
        on a wall display looks like a bug.

        Because the hero is width-capped and every other band is text at a fixed
        ramp, a tall portrait column ends up with height nobody claimed. Left
        alone that surplus collects in one place — a ~600px void above the stat
        tiles — so it is handed out deliberately instead.
        """
        u = float(u or 1.0)
        width = max(1.0, x1 - x0)
        height = max(1.0, y1 - y0)
        header_h = 84 * u
        bar_h = 34 * u
        title_h = 72 * u
        channel_h = 64 * u
        # An empty description must close the gap, not leave a hole (§4.5).
        desc_h = (self.DESC_MIN_PORTRAIT * u) if has_desc else 0
        stats_h = 118 * u
        upload_h = 34 * u
        device_h = 30 * u

        g = 18 * u
        # header→hero, hero→bar, bar→title, title→channel, channel→desc, desc→stats
        gaps = [g, 10 * u, g, g, (g if has_desc else 0), g]
        bands = (
            header_h + bar_h + title_h + channel_h + desc_h
            + stats_h + upload_h + device_h
        )

        # The hero is the one flexible band: everything else is text at a fixed
        # ramp, so a short screen shrinks the picture rather than the words.
        hero_h = max(
            self.HERO_MIN_PORTRAIT * u,
            min(width / THUMBNAIL_ASPECT, height - bands - sum(gaps)),
        )

        slack = height - (bands + sum(gaps) + hero_h)
        # Spend the surplus on copy before air: the description is a clipped
        # scrolling viewport, so a taller band is simply more of it on screen.
        if slack > 0 and has_desc:
            grow = max(0.0, min(slack, self.DESC_MAX_PORTRAIT * u - desc_h))
            desc_h += grow
            slack -= grow
        # Then let the stack breathe, up to a ceiling. Index 1 is skipped: the
        # position bar is the hero's scrubber and has to stay against it.
        loose = [i for i, gap in enumerate(gaps) if gap > 0 and i != 1]
        if slack > 0 and loose:
            room = sum(max(0.0, self.GAP_MAX_PORTRAIT * u - gaps[i]) for i in loose)
            grow = min(slack, room)
            if room > 0:
                for i in loose:
                    gaps[i] += grow * (self.GAP_MAX_PORTRAIT * u - gaps[i]) / room
            slack -= grow
        # Anything still unclaimed goes back to the copy, or — with no
        # description to grow — spreads out rather than pooling above the stats.
        if slack > 0:
            if has_desc:
                desc_h += slack
            elif loose:
                for i in loose:
                    gaps[i] += slack / len(loose)

        cursor = y0
        header = (x0, cursor, x1, cursor + header_h)
        cursor = header[3] + gaps[0]
        # Keep 16:9 by narrowing rather than squashing when height is the limit.
        hero_w = min(width, hero_h * THUMBNAIL_ASPECT)
        hero_x0 = x0 + (width - hero_w) / 2
        hero = (hero_x0, cursor, hero_x0 + hero_w, cursor + hero_h)
        cursor = hero[3] + gaps[1]
        bar = (x0, cursor, x1, cursor + bar_h)
        cursor = bar[3] + gaps[2]
        title = (x0, cursor, x1, cursor + title_h)
        cursor = title[3] + gaps[3]
        channel = (x0, cursor, x1, cursor + channel_h)
        cursor = channel[3] + gaps[4]
        desc = (x0, cursor, x1, cursor + desc_h)
        cursor = desc[3] + gaps[5]

        device_top = y1 - device_h
        upload_top = device_top - upload_h
        stats_top = max(cursor, upload_top - stats_h)
        stats = (x0, stats_top, x1, stats_top + stats_h)
        upload = (x0, upload_top, x1, device_top)
        device = (x0, device_top, x1, y1)

        return {
            "header": header,
            "hero": hero,
            "bar": bar,
            "title": title,
            "channel": channel,
            "desc": desc,
            "stats": stats,
            "upload": upload,
            "device": device,
            "u": u,
            "has_desc": has_desc,
            "stats_inline": False,
        }

    def _compute_landscape_boxes(self, x0, y0, x1, y1, *, u=1.0, has_desc=True, **_kwargs):
        """Hero left at ~55%, text stacked right.

        A full-width 16:9 thumbnail would consume the entire landscape screen
        (§4.2), and three stat tiles in the narrow right column look cramped —
        so the stats collapse to one inline row.
        """
        u = float(u or 1.0)
        header_h = 84 * u
        gutter = 28 * u
        total_w = max(1.0, x1 - x0)
        left_w = total_w * 0.55 - gutter / 2
        left_x1 = x0 + left_w
        right_x0 = left_x1 + gutter

        zone_top = y0 + header_h + 16 * u
        bar_h = 34 * u
        device_h = 30 * u

        hero_h = min(left_w / THUMBNAIL_ASPECT, (y1 - zone_top) - bar_h - device_h - 20 * u)
        hero_w = hero_h * THUMBNAIL_ASPECT
        hero = (x0, zone_top, x0 + hero_w, zone_top + hero_h)
        bar = (x0, hero[3] + 10 * u, x0 + hero_w, hero[3] + 10 * u + bar_h)
        device = (x0, y1 - device_h, left_x1, y1)

        title_h = 64 * u
        channel_h = 56 * u
        stats_h = 40 * u
        upload_h = 32 * u
        g = 14 * u
        g_desc = g if has_desc else 0

        upload_top = y1 - upload_h
        stats_top = upload_top - stats_h
        # Description fills whatever remains between the channel and the stats
        # — and is clamped so it can never paint over them.
        cursor = zone_top
        title = (right_x0, cursor, x1, cursor + title_h)
        cursor += title_h + g
        channel = (right_x0, cursor, x1, cursor + channel_h)
        cursor += channel_h + g_desc
        desc_ceiling = stats_top - g
        if has_desc and desc_ceiling > cursor + 24 * u:
            desc = (right_x0, cursor, x1, desc_ceiling)
        else:
            desc = (right_x0, cursor, x1, cursor)

        stats = (right_x0, stats_top, x1, upload_top)
        upload = (right_x0, upload_top, x1, y1)

        return {
            "header": (x0, y0, x1, y0 + header_h),
            "hero": hero,
            "bar": bar,
            "title": title,
            "channel": channel,
            "desc": desc,
            "stats": stats,
            "upload": upload,
            "device": device,
            "u": u,
            "has_desc": has_desc and desc[3] > desc[1],
            "stats_inline": True,
        }

    # -------------------------------------------------------------- chrome

    def _is_last_played(self, yt=None):
        source = yt if yt is not None else self._yt
        return str((source or {}).get("mode") or "playing") == "last-played"

    def _draw_chrome(self, boxes):
        text = self.config.get("textColor", "#f8fafc")
        hx0, hy0, hx1, hy1 = boxes["header"]
        cy = (hy0 + hy1) / 2
        mid_x = (hx0 + hx1) / 2
        last_played = self._is_last_played()
        live = bool(self._yt.get("live"))

        start_dt = self._started_at
        if last_played:
            raw = self._yt.get("endedAt") or self._yt.get("startedAt")
            start_dt = parse_iso_timestamp(raw) if raw else start_dt

        self._item_ids.append(self.canvas.create_text(
            hx0, cy - 10, anchor="w",
            text="WATCHED" if last_played else "STARTED",
            fill=INK_3, font=self.shell.chip_label_font,
        ))
        self._item_ids.append(self.canvas.create_text(
            hx0, cy + 12, anchor="w",
            text=self._fmt_last_played_date(start_dt) if last_played else self._fmt_clock(start_dt),
            fill=text, font=self.shell.chip_value_font,
        ))

        if live:
            badge, badge_outline, badge_text = "LIVE", LIVE_RED, LIVE_RED
        elif last_played:
            badge, badge_outline, badge_text = "LAST PLAYED", self.ACCENT, self.ACCENT
        else:
            badge, badge_outline, badge_text = "NOW PLAYING", "#e2e8f0", text

        badge_font = (
            getattr(self.shell, "section_label_font", None)
            or getattr(self.shell, "body_font", None)
            or self.shell.chip_value_font
        )
        try:
            text_w = int(badge_font.measure(badge))
            text_h = int(badge_font.metrics("linespace"))
        except Exception:
            text_w, text_h = 190, 28
        badge_w = text_w + 56
        badge_h = max(44, text_h + 28)
        self._round_rect(
            mid_x - badge_w / 2, cy - badge_h / 2, mid_x + badge_w / 2, cy + badge_h / 2,
            0, outline=badge_outline, fill="#0b1220",
        )
        self._item_ids.append(self.canvas.create_text(
            mid_x, cy, anchor="center", text=badge, fill=badge_text, font=badge_font,
        ))

        if last_played:
            right_label, right_value = "WHEN", self.format_ago(start_dt)
            self._elapsed_value_id = None
        else:
            right_label, right_value = "ELAPSED", self._fmt_elapsed()
        self._item_ids.append(self.canvas.create_text(
            hx1, cy - 10, anchor="e", text=right_label, fill=INK_3,
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
        self._round_rect(x0, y0, x1, y1, 0, fill=STEAM_STAGE_BG, outline=STEAM_LINE)
        self._hero_glow_id = None
        self._hero_image_id = self.canvas.create_image(
            (x0 + x1) / 2, (y0 + y1) / 2, anchor="center",
        )
        self._item_ids.append(self._hero_image_id)
        tick = max(16, int(round(24 * float(boxes.get("u") or 1))))
        self._draw_corner_brackets(x0, y0, x1, y1, length=tick, color=self.ACCENT)

    # ------------------------------------------------------- position band

    def _draw_position(self, boxes, yt):
        """Progress bar while playing; a static "watched" line afterwards.

        A live stream has no meaningful position, so the bar is replaced by the
        concurrent viewer count (§4.5). While now-playing, the fill and counter
        keep walking with the wall clock so a long-lived overlay does not freeze
        at the snapshot Lounge happened to report.
        """
        self._stop_position_tick()
        bx0, by0, bx1, by1 = boxes["bar"]
        u = float(boxes.get("u") or 1)
        text = self.config.get("textColor", "#f8fafc")
        self._position_fill_id = None
        self._position_caption_id = None
        self._position_track = None
        self._position_base = 0
        self._position_duration = 0
        self._position_anchored_at = None

        if by1 <= by0 + 4:
            return

        duration = int(yt.get("durationSeconds") or 0)
        label_font = self._sized_font(int(round(22 * u)), weight="normal")

        if yt.get("live"):
            viewers = abbreviate_count(yt.get("concurrentViewers"))
            self._item_ids.append(self.canvas.create_text(
                bx0, (by0 + by1) / 2, anchor="w",
                text=f"{viewers} watching now" if viewers else "Live now",
                fill=LIVE_RED, font=label_font,
            ))
            return

        if self._is_last_played(yt):
            watched = last_played_watched_seconds(yt)
            if yt.get("completed"):
                caption = "Watched to the end"
            elif watched > 0 and duration > 0:
                caption = f"Watched {format_position(watched)} of {format_position(duration)}"
            elif watched > 0:
                caption = f"Watched {format_position(watched)}"
            elif duration > 0:
                caption = f"Watched · {format_position(duration)}"
            else:
                caption = "Watched"
            self._item_ids.append(self.canvas.create_text(
                bx0, (by0 + by1) / 2, anchor="w", text=caption,
                fill=STEAM_INK_DIM, font=label_font,
            ))
            return

        try:
            base_position = int(round(float(yt.get("positionSeconds") or 0)))
        except (TypeError, ValueError):
            base_position = 0
        self._position_base = max(0, base_position)
        self._position_duration = max(0, duration)
        self._position_anchored_at = datetime.now(timezone.utc)
        position = live_position_seconds(
            self._position_base, self._position_duration,
            anchored_at=self._position_anchored_at,
        )
        caption = (
            f"{format_position(position)} / {format_position(duration)}"
            if duration else format_position(position)
        )
        try:
            caption_w = int(label_font.measure(caption)) + int(18 * u) if caption else 0
        except Exception:
            caption_w = len(caption) * 12

        bar_h = max(4, int(round(self.POSITION_BAR_H * u)))
        bar_cy = (by0 + by1) / 2
        track_x1 = bx1 - caption_w
        self._position_track = (bx0, bar_cy - bar_h / 2, track_x1, bar_cy + bar_h / 2)
        self._round_rect(bx0, bar_cy - bar_h / 2, track_x1, bar_cy + bar_h / 2, 0,
                         fill="#1d2635", outline="")
        if duration > 0:
            fraction = max(0.0, min(1.0, position / duration))
            fill_x1 = bx0 + (track_x1 - bx0) * fraction
            # Always allocate a fill item so the tick can grow it from zero.
            self._position_fill_id = self._round_rect(
                bx0, bar_cy - bar_h / 2, max(bx0, fill_x1), bar_cy + bar_h / 2, 0,
                fill=self.ACCENT, outline="",
            )
        if caption:
            self._position_caption_id = self.canvas.create_text(
                bx1, bar_cy, anchor="e", text=caption, fill=text, font=label_font,
            )
            self._item_ids.append(self._position_caption_id)

    def _stop_position_tick(self):
        if self._position_tick_job is not None:
            try:
                self.root.after_cancel(self._position_tick_job)
            except Exception:
                pass
            self._position_tick_job = None

    def _schedule_position_tick(self):
        """Advance the scrubber once a second while a now-playing card is up."""
        self._stop_position_tick()
        if (
            self._is_last_played()
            or self._yt.get("live")
            or self._position_track is None
            or self._position_anchored_at is None
        ):
            return

        def tick():
            if not self.visible or self._position_track is None:
                self._position_tick_job = None
                return
            self._apply_live_position()
            # Keep ticking at the end so a late duration update is not needed;
            # the helper caps at duration so the bar simply sits full.
            self._position_tick_job = self.root.after(1_000, tick)

        self._position_tick_job = self.root.after(1_000, tick)

    def _apply_live_position(self, now=None):
        track = self._position_track
        if not track:
            return
        bx0, by0, track_x1, by1 = track
        duration = self._position_duration
        position = live_position_seconds(
            self._position_base, duration,
            anchored_at=self._position_anchored_at,
            now=now,
        )
        if duration > 0 and self._position_fill_id is not None:
            fraction = max(0.0, min(1.0, position / duration))
            fill_x1 = bx0 + (track_x1 - bx0) * fraction
            try:
                self.canvas.coords(
                    self._position_fill_id, bx0, by0, max(bx0, fill_x1), by1,
                )
            except Exception:
                pass
        if self._position_caption_id is not None:
            caption = (
                f"{format_position(position)} / {format_position(duration)}"
                if duration else format_position(position)
            )
            try:
                self.canvas.itemconfigure(self._position_caption_id, text=caption)
            except Exception:
                pass

    # ------------------------------------------------------- title / meta

    def _sized_font(self, size: int, *, weight: str = "normal"):
        """Derive a resized copy of a shell font.

        Copying rather than constructing keeps the family and any platform
        fallbacks the shell already resolved, and does not need a Tk root — so
        the layout is unit-testable without opening a window.
        """
        base = getattr(self.shell, "body_font", None) or self.shell.chip_value_font
        try:
            font = base.copy()
            font.configure(size=max(8, int(size)), weight=weight)
            return font
        except Exception:
            return tkfont.Font(
                family=self.config.get("titleFontFamily", "Segoe UI"),
                size=max(8, int(size)), weight=weight,
            )

    def _place_title_marquee(self, text, x0, y0, x1, y1, font, fill):
        """Single-line title; scrolls horizontally when it outruns the band."""
        for marquee in self._marquees:
            marquee.stop()
        self._marquees = []
        width = max(40, int(x1 - x0))
        try:
            line_h = int(font.metrics("linespace"))
        except Exception:
            line_h = 40
        height = max(line_h + 4, min(int(y1 - y0), line_h + 12))
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

    def _draw_meta(self, boxes, yt):
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        u = float(boxes.get("u") or 1)
        portrait = boxes.get("portrait", True)

        # ---- title: one marquee line (scrolls instead of ellipsising)
        tx0, ty0, tx1, ty1 = boxes["title"]
        title_size = self.TITLE_SIZE_PORTRAIT if portrait else self.TITLE_SIZE_LANDSCAPE
        title_font = self._sized_font(int(round(title_size * u)), weight="bold")
        self._place_title_marquee(
            str(yt.get("title") or self.DEFAULT_TITLE),
            tx0, ty0, tx1, ty1, title_font, text,
        )

        # ---- channel row: avatar · name · subscriber count
        cx0, cy0, cx1, cy1 = boxes["channel"]
        row_cy = (cy0 + cy1) / 2
        diameter = max(28, int(round(self.AVATAR_DIAMETER * u)))
        self._avatar_id = None
        if yt.get("avatarUrl"):
            self.canvas.create_oval(
                cx0, row_cy - diameter / 2, cx0 + diameter, row_cy + diameter / 2,
                fill="#1d2635", outline="",
            )
            self._avatar_id = self.canvas.create_image(
                cx0 + diameter / 2, row_cy, anchor="center",
            )
            self._item_ids.append(self._avatar_id)
            name_x = cx0 + diameter + 16 * u
        else:
            name_x = cx0

        channel_size = self.CHANNEL_SIZE_PORTRAIT if portrait else self.CHANNEL_SIZE_LANDSCAPE
        subs_size = self.SUBS_SIZE_PORTRAIT if portrait else self.SUBS_SIZE_LANDSCAPE
        subs_font = self._sized_font(int(round(subs_size * u)))
        subs = abbreviate_count(yt.get("subscriberCount"))
        subs_text = f"{subs} subs" if subs else ""
        try:
            subs_w = int(subs_font.measure(subs_text)) if subs_text else 0
        except Exception:
            subs_w = len(subs_text) * 12

        channel_font = self._sized_font(int(round(channel_size * u)), weight="bold")
        channel_name = str(yt.get("channelTitle") or "")
        if channel_name:
            # The subs figure is right-aligned, so the name gets whatever is
            # left — ellipsised rather than allowed to collide.
            available = max(40, (cx1 - subs_w - 20 * u) - name_x)
            self._item_ids.append(self.canvas.create_text(
                name_x, row_cy, anchor="w", text=channel_name, fill=text,
                font=channel_font, width=int(available),
            ))
        if subs_text:
            self._item_ids.append(self.canvas.create_text(
                cx1, row_cy, anchor="e", text=subs_text, fill=muted, font=subs_font,
            ))

        # ---- description: clipped band that scrolls when it outruns the box
        if boxes.get("has_desc"):
            dx0, dy0, dx1, dy1 = boxes["desc"]
            desc = str(yt.get("description") or "").strip()
            if desc and dy1 > dy0 + 8:
                desc_size = self.DESC_SIZE_PORTRAIT if portrait else self.DESC_SIZE_LANDSCAPE
                desc_font = self._sized_font(int(round(desc_size * u)))
                self._place_description_viewport(
                    desc, dx0, dy0, dx1, max(0, int(dy1 - dy0)), font=desc_font,
                )

        # ---- upload date and device label
        ux0, uy0, ux1, uy1 = boxes["upload"]
        uploaded = format_upload_date(yt.get("publishedAt"))
        if uploaded:
            upload_size = self.UPLOAD_SIZE_PORTRAIT if portrait else self.UPLOAD_SIZE_LANDSCAPE
            self._item_ids.append(self.canvas.create_text(
                (ux0 if not portrait else (ux0 + ux1) / 2), (uy0 + uy1) / 2,
                anchor="w" if not portrait else "center",
                text=f"Uploaded {uploaded}", fill=muted,
                font=self._sized_font(int(round(upload_size * u))),
            ))

        device_label = str(yt.get("deviceLabel") or "").strip()
        if device_label:
            dvx0, dvy0, dvx1, dvy1 = boxes["device"]
            self._item_ids.append(self.canvas.create_text(
                dvx0, (dvy0 + dvy1) / 2, anchor="w", text=device_label,
                fill=INK_3, font=self._sized_font(int(round(self.DEVICE_SIZE * u))),
            ))

    # --------------------------------------------------------- stats row

    def _stat_columns(self, yt):
        """Views / likes / dislikes, dropping whatever is unavailable.

        Metadata for a private or deleted video is simply absent, and RYD can
        be down — in both cases the row collapses rather than showing zeros or
        an error (§4.5, §6.9).
        """
        columns = []
        if yt.get("metadataMissing"):
            return columns
        views = abbreviate_count(yt.get("viewCount"))
        if views:
            columns.append(("VIEWS", views))
        likes = abbreviate_count(yt.get("likeCount"))
        if likes:
            columns.append(("LIKES", likes))
        dislikes = abbreviate_count(yt.get("dislikeCount"))
        if dislikes:
            # Tilde and the "est." label: RYD is archived data plus
            # extrapolation, never a hard figure (§2.2).
            columns.append(("DISLIKES est.", f"~{dislikes}"))
        return columns

    def _draw_stats(self, boxes, yt):
        columns = self._stat_columns(yt)
        if not columns:
            return
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        u = float(boxes.get("u") or 1)
        portrait = boxes.get("portrait", True)
        sx0, sy0, sx1, sy1 = boxes["stats"]
        if sy1 <= sy0 + 8:
            return

        value_size = self.STAT_VALUE_PORTRAIT if portrait else self.STAT_VALUE_LANDSCAPE
        label_size = self.STAT_LABEL_PORTRAIT if portrait else self.STAT_LABEL_LANDSCAPE
        value_font = self._sized_font(int(round(value_size * u)), weight="bold")
        label_font = self._sized_font(int(round(label_size * u)))

        if boxes.get("stats_inline"):
            # Landscape: one compact sentence. No `width=` — wrapping here used
            # to drop "dislikes" onto the upload-date line underneath.
            parts = []
            for label, value in columns:
                word = "dislikes" if label.upper().startswith("DISLIKE") else label.split()[0].lower()
                parts.append(f"{value} {word}")
            line = "  ·  ".join(parts)
            available = max(40, int(sx1 - sx0))
            try:
                while value_font.cget("size") > 14 and value_font.measure(line) > available:
                    value_font.configure(size=int(value_font.cget("size")) - 1)
            except Exception:
                pass
            self._item_ids.append(self.canvas.create_text(
                sx0, (sy0 + sy1) / 2, anchor="w", text=line, fill=text, font=value_font,
            ))
            return

        count = len(columns)
        cell_w = (sx1 - sx0) / count
        self._round_rect(sx0, sy0, sx1, sy1, 0, fill="#101b2d", outline=STEAM_LINE)
        value_y = sy0 + (sy1 - sy0) * 0.34
        label_y = sy0 + (sy1 - sy0) * 0.70
        for index, (label, value) in enumerate(columns):
            cx = sx0 + cell_w * index + cell_w / 2
            if index > 0:
                divider = sx0 + cell_w * index
                self._item_ids.append(self.canvas.create_line(
                    divider, sy0 + 10, divider, sy1 - 10, fill=STEAM_LINE,
                ))
            self._item_ids.append(self.canvas.create_text(
                cx, value_y, anchor="center", text=value, fill=text, font=value_font,
            ))
            self._item_ids.append(self.canvas.create_text(
                cx, label_y, anchor="center", text=label, fill=muted, font=label_font,
            ))

    # ------------------------------------------------------------- images

    def _start_image_fetches(self, yt):
        self._fetch_token += 1
        token = self._fetch_token

        hero_box = self._layout_boxes.get("hero")
        thumbnail = yt.get("thumbnailUrl")
        if hero_box and thumbnail:
            x0, y0, x1, y1 = hero_box
            threading.Thread(
                target=self._fetch_first_image,
                args=(token, [thumbnail], max(40, int(x1 - x0)), max(40, int(y1 - y0)), "hero"),
                daemon=True,
            ).start()

        avatar = yt.get("avatarUrl")
        if self._avatar_id and avatar:
            size = max(28, int(round(self.AVATAR_DIAMETER * float(self._layout_boxes.get("u") or 1))))
            threading.Thread(
                target=self._fetch_first_image,
                args=(token, [avatar], size, size, ("avatar", 0, self._avatar_id)),
                daemon=True,
            ).start()

    def _apply_image(self, token, image, target):
        """Cover-fill the hero.

        The parent contains the poster inside a blurred backdrop because game
        art has unpredictable aspect. A YouTube thumbnail is always 16:9 and
        the frame is built to match, so a plain cover fill is exact — and skips
        the blur pass entirely.
        """
        if target != "hero":
            super()._apply_image(token, image, target)
            return
        if token != self._fetch_token or not self.visible or image is None:
            return
        hero_box = self._layout_boxes.get("hero")
        if not hero_box:
            return
        x0, y0, x1, y1 = hero_box
        try:
            filled = fit_image_cover(image, max(40, int(x1 - x0)), max(40, int(y1 - y0)))
        except Exception:
            filled = image
        super()._apply_image(token, filled, ("hero-image", 0, self._hero_image_id))
