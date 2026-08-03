"""Dedicated PlayStation Now Playing overlay panel.

Looks related to Steam Now Playing (same art stage + header rhythm) but is a
separate layout: Store description when Chihiro enrich works, status line,
adaptive 1–3 screenshot gallery, and PSN footer stats (no concurrent players).

Artwork fetch/cache helpers are inherited from SteamNowPlayingPanel so we do
not duplicate SSL/cache plumbing; all geometry and chrome copy are owned here.
"""

from __future__ import annotations

from src.design_system import (
    ACCENT as DS_ACCENT,
    STEAM_INK_DIM,
    STEAM_LINE,
    STEAM_TAG_BG,
    STEAM_TAG_BORDER,
)
from src.payload_utils import parse_iso_timestamp
from src.steam_now_playing_panel import SteamNowPlayingPanel


class PsnNowPlayingPanel(SteamNowPlayingPanel):
    """PSN-owned Now Playing — similar stage, different data bands + footer."""

    SOURCE_CHIP = "PSN"
    PAYLOAD_KEY = "psn"
    DEFAULT_TITLE = "PlayStation Game"
    ACCENT = DS_ACCENT
    STATUS_H_PORTRAIT = 44
    STATUS_H_LANDSCAPE = 48
    DESC_H_PORTRAIT = 272
    DESC_H_LANDSCAPE = 200

    def __init__(self, root, shell, config):
        super().__init__(root, shell, config)
        self._psn = {}

    def _render(self, payload: dict):
        psn = payload.get("psn") or {}
        self._psn = psn
        # Parent helpers (elapsed, last-played, image fetch) read `_steam`.
        self._steam = psn
        started = psn.get("startedAt")
        self._started_at = parse_iso_timestamp(started) if started else None
        self._stop_enrich_spinner()

        rect = self._content_rect()
        self._draw_background(0, 0, rect["screen_w"], rect["screen_h"])
        shots = [u for u in (psn.get("screenshots") or []) if u][:3]
        enrich_pending = self._enrich_pending(psn)
        # Thin library-tour cards reserve desc + gallery while Chihiro enrich runs.
        has_shots = bool(shots) or enrich_pending
        has_desc = bool(str(psn.get("shortDescription") or "").strip()) or enrich_pending
        has_status = bool(str(psn.get("statusLine") or "").strip())
        if rect["portrait"]:
            self._layout_boxes = self._compute_portrait_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_shots=has_shots, has_desc=has_desc, has_status=has_status,
            )
        else:
            self._layout_boxes = self._compute_landscape_boxes(
                rect["x0"], rect["y0"], rect["x1"], rect["y1"],
                u=rect["u"], has_shots=has_shots, has_desc=has_desc, has_status=has_status,
            )
        self._draw_chrome(self._layout_boxes)
        self._draw_meta(self._layout_boxes, psn)
        self._draw_footer(self._layout_boxes, psn)
        self._start_image_fetches(psn)
        self._schedule_elapsed_tick()

    def _compute_portrait_boxes(
        self, x0, y0, x1, y1, *, u=1.0, has_shots=True, has_desc=False, has_status=True,
    ):
        """Hero grows when gallery/description absent; desc band only when Store text exists."""
        u = float(u or 1.0)
        header_h = 84 * u
        title_h = 74 * u
        tags_h = 40 * u
        status_h = (self.STATUS_H_PORTRAIT * u) if has_status else 0
        desc_h = (self.DESC_H_PORTRAIT * u) if has_desc else 0
        shots_h = (self.SHOTS_H_PORTRAIT * u) if has_shots else 0
        footer_h = 101 * u
        g_header = 20 * u
        g_stage = 24 * u
        g_title = 16 * u
        g_tags = 12 * u
        g_status = 8 * u if has_status else 0
        g_desc = 12 * u if has_desc else 0
        g_shots = 22 * u if has_shots else 0

        header = (x0, y0, x1, y0 + header_h)
        hero_top = y0 + header_h + g_header
        # Every band below the stage is sized to its own content, so the stage
        # simply takes what is left: absent Store copy or a missing gallery grows
        # the artwork, and a short column shrinks it, with no padded meta row.
        meta_h = title_h + g_title + tags_h
        fixed_below = (
            g_stage + meta_h + g_tags
            + g_status + status_h + g_desc + desc_h
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
        desc_top = desc_bottom - desc_h if has_desc else desc_bottom
        status_bottom = desc_top - (g_desc if has_desc else 0)
        status_top = status_bottom - status_h if has_status else status_bottom
        meta_top = hero[3] + g_stage
        meta_bottom = max(meta_top, status_top - g_status)
        meta = (x0, meta_top, x1, meta_bottom)
        status = (x0, status_top, x1, status_bottom) if has_status else (x0, status_top, x1, status_top)
        desc = (x0, desc_top, x1, desc_bottom) if has_desc else (x0, desc_top, x1, desc_top)
        shots = (x0, shots_top, x1, shots_top + shots_h) if has_shots else (x0, shots_top, x1, shots_top)
        footer = (x0, footer_top, x1, y1)
        return {
            "header": header,
            "hero": hero,
            "meta": meta,
            "status": status,
            "desc": desc,
            "shots": shots,
            "footer": footer,
            "title_h": title_h,
            "tags_h": tags_h,
            "desc_h": desc_h,
            "u": u,
        }

    def _compute_landscape_boxes(
        self, x0, y0, x1, y1, *, u=1.0, has_shots=True, has_desc=False, has_status=True,
    ):
        u = float(u or 1.0)
        gutter = 24 * u
        col_w = (x1 - x0 - gutter) / 2
        left_x1 = x0 + col_w
        right_x0 = left_x1 + gutter
        header_h = 84 * u
        header = (x0, y0, x1, y0 + header_h)
        zone_top = y0 + header_h + 20 * u
        zone_bottom = y1
        footer_h = 100 * u
        status_h = (self.STATUS_H_LANDSCAPE * u) if has_status else 0
        desc_h = (self.DESC_H_LANDSCAPE * u) if has_desc else 0
        shots_h = (158 * u) if has_shots else 0
        g_status = 8 * u if has_status else 0
        g_desc = 12 * u if has_desc else 0
        g_shots = 22 * u if has_shots else 0
        footer_top = zone_bottom - footer_h
        shots_top = footer_top - (g_shots + shots_h if has_shots else 0)
        desc_bottom = shots_top
        desc_top = desc_bottom - desc_h if has_desc else desc_bottom
        status_bottom = desc_top - (g_desc if has_desc else 0)
        status_top = status_bottom - status_h if has_status else status_bottom
        meta_top = zone_top
        meta_bottom = max(meta_top, status_top - g_status)
        hero = (x0, zone_top, left_x1, zone_bottom)
        meta = (right_x0, meta_top, x1, meta_bottom)
        status = (
            (right_x0, status_top, x1, status_bottom)
            if has_status else (right_x0, status_top, x1, status_top)
        )
        desc = (
            (right_x0, desc_top, x1, desc_bottom)
            if has_desc else (right_x0, desc_top, x1, desc_top)
        )
        shots = (
            (right_x0, shots_top, x1, shots_top + shots_h)
            if has_shots else (right_x0, shots_top, x1, shots_top)
        )
        footer = (right_x0, footer_top, x1, zone_bottom)
        return {
            "header": header,
            "hero": hero,
            "meta": meta,
            "status": status,
            "desc": desc,
            "shots": shots,
            "footer": footer,
            "title_h": 104 * u,
            "tags_h": 40 * u,
            "desc_h": desc_h,
            "u": u,
        }

    def _draw_meta(self, boxes, psn):
        text = self.config.get("textColor", "#f8fafc")
        tags = list(psn.get("tags") or [])[:4]
        mx0, my0, mx1, my1 = boxes["meta"]
        title = str(psn.get("name") or self.DEFAULT_TITLE)

        title_font = getattr(self.shell, "section_title_font", None) or self.shell.chip_value_font
        self._item_ids.append(self.canvas.create_text(
            mx0, my0 + 2, anchor="nw", text=title, fill=text,
            font=title_font,
        ))
        try:
            title_h = int(title_font.metrics("linespace"))
        except Exception:
            title_h = 32

        tags_top = my0 + title_h + self.TAG_FONT_GAP
        self._draw_tags(
            tags, mx0, tags_top, mx1,
            min(my1, tags_top + int(boxes.get("tags_h") or self.TAG_PILL_H)),
        )

        status = str(psn.get("statusLine") or "").strip()
        status_box = boxes.get("status")
        if status and status_box and status_box[3] > status_box[1] + 8:
            sx0, sy0, sx1, sy1 = status_box
            status_font = getattr(self.shell, "body_font", None) or self.shell.chip_label_font
            self._item_ids.append(self.canvas.create_text(
                sx0, (sy0 + sy1) / 2, anchor="w",
                text=status, fill=STEAM_INK_DIM, font=status_font,
                width=max(40, int(sx1 - sx0)),
            ))

        desc = str(psn.get("shortDescription") or "").strip()
        desc_box = boxes.get("desc")
        enrich_pending = self._enrich_pending(psn)
        self._clear_description_viewport()
        if desc and desc_box and desc_box[3] > desc_box[1] + 20:
            dx0, dy0, dx1, dy1 = desc_box
            self._place_description_viewport(desc, dx0, dy0, dx1, max(0, int(dy1 - dy0)))
        elif enrich_pending and desc_box and desc_box[3] > desc_box[1] + 20:
            self._draw_loading_band(desc_box)

        shots = [u for u in (psn.get("screenshots") or []) if u][:3]
        shots_box = boxes.get("shots") or (0, 0, 0, 0)
        self._shot_ids = []
        if shots and shots_box[3] > shots_box[1] + 20:
            sx0, sy0, sx1, sy1 = shots_box
            self._place_screenshot_row(shots, sx0, sy0, sx1, sy1)
        elif enrich_pending and shots_box[3] > shots_box[1] + 20:
            self._draw_loading_shot_row(shots_box)

    def _place_screenshot_row(self, shots, x0, y0, x1, y1):
        """Size cells to the real count (1–3) — never leave empty placeholder plates."""
        urls = [u for u in (shots or []) if u][:3]
        count = len(urls)
        if count < 1 or y1 <= y0 + 8:
            return
        gap = 12
        cell_w = (x1 - x0 - gap * (count - 1)) / count
        for i, url in enumerate(urls):
            sx0 = x0 + i * (cell_w + gap)
            sx1 = sx0 + cell_w
            self._round_rect(sx0, y0, sx1, y1, 0, fill="#101b2d", outline=STEAM_LINE)
            img_id = self.canvas.create_image((sx0 + sx1) / 2, (y0 + y1) / 2, anchor="center")
            self._item_ids.append(img_id)
            self._shot_ids.append((img_id, sx1 - sx0 - 4, y1 - y0 - 4))

    def _draw_footer(self, boxes, psn):
        """PLAYTIME · TROPHIES · PROGRESS — no concurrent-players column."""
        text = self.config.get("textColor", "#f8fafc")
        muted = self.config.get("mutedTextColor", "#94a3b8")
        fx0, fy0, fx1, fy1 = boxes["footer"]
        self._item_ids.append(self.canvas.create_line(fx0, fy0, fx1, fy0, fill=self.FOOTER_LINE))

        enrich_pending = self._enrich_pending(psn)
        trophies = psn.get("trophies") or psn.get("achievements") or {}
        playtime = psn.get("playtimeLabel") or "—"
        if trophies.get("available") and trophies.get("earned") is not None:
            trophy_text = f"{trophies.get('earned')} / {trophies.get('total') or '?'}"
        elif enrich_pending:
            trophy_text = None
        else:
            trophy_text = "—"

        progress = str(psn.get("progressLabel") or "").strip()
        if not progress and trophies.get("available"):
            prog = trophies.get("progress")
            if prog is not None:
                try:
                    progress = f"{int(round(float(prog)))}%"
                except (TypeError, ValueError):
                    progress = "—"
            else:
                progress = "—"
        if not progress:
            if enrich_pending:
                progress = None
            else:
                # Fall back to platform when trophy % is unavailable.
                progress = str(psn.get("platform") or "—")

        cols = (
            ("PLAYTIME", playtime),
            ("TROPHIES", trophy_text),
            ("PROGRESS", progress),
        )
        col_w = (fx1 - fx0) / 3
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

    def _draw_tags(self, tags, tx0, ty0, tx1, ty1, *, include_source: bool = True):
        """PSN source chip + platform tags (never painted on artwork)."""
        if ty1 <= ty0 + 8:
            return ty0
        pill_gap = 10
        x = tx0
        row_y0 = ty0
        row_h = min(self.TAG_PILL_H, max(22, ty1 - ty0))
        tag_font = self._tag_font()
        chips = []
        if include_source:
            chips.append((str(self.SOURCE_CHIP), True))
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
