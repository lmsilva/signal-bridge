"""Trivia round overlay (trivia.md §6).

One `trivia.round` UDP packet carries the whole sequence; this panel runs the
intro → question → answer → … → summary state machine locally on `root.after`.
Nothing is fetched mid-round, so a dropped datagram cannot freeze the display on
a question whose answer never arrives.

The category artwork is already normalised so its brightest pixel sits at 5.2:1
against white (§6.5.2). **Do not add a scrim** — a second overlay would only
make the art invisible while buying no legibility.
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

from src.design_system import INK, INK_2, INK_3, design_u, page_chrome
from src.display_panels import BasePanel
from src.paths import app_root, asset_path

# Frozen builds hit the bridge's self-signed cert; once unverified works, keep it.
_unverified_ssl = False

OPTION_LETTERS = ("A", "B", "C", "D", "E", "F")
# §6.7: the ring warms in the last three seconds. No flashing, no sound.
WARN_ACCENT = "#F5C453"
# Defaults only — every card overrides these from the category palette (§6.5).
DEFAULT_BACKGROUND = "#101820"
DEFAULT_ACCENT = "#8BB7FF"


def trivia_artwork_cache_dir() -> Path:
    return app_root() / "trivia-artwork-cache"


def trivia_artwork_cache_path(url: str) -> Path:
    text = str(url or "")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:40]
    ext = Path(urlsplit(text).path).suffix.lower()
    if ext not in {".webp", ".png", ".jpg", ".jpeg"}:
        ext = ".jpg"
    return trivia_artwork_cache_dir() / f"{digest}{ext}"


ARTWORK_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")


def trivia_artwork_asset_path(category_id: str, portrait: bool) -> Path | None:
    """Bundled copy of the category pack, used when the bridge is unreachable."""
    key = str(category_id or "").strip().lower()
    if not key:
        return None
    orientation = "portrait" if portrait else "landscape"
    for ext in ARTWORK_EXTENSIONS:
        candidate = asset_path(Path("trivia-artwork") / f"{key}-{orientation}{ext}")
        try:
            if candidate.exists():
                return candidate
        except Exception:
            continue
    return None


def looks_like_image(data: bytes) -> bool:
    """Reject captive-portal HTML and error pages before they poison the cache."""
    blob = bytes(data or b"")
    if len(blob) < 12:
        return False
    if blob[:2] == b"\xff\xd8":
        return True
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return True
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return True
    if blob[:6] in (b"GIF87a", b"GIF89a"):
        return True
    return False


def _is_ssl_failure(error: BaseException) -> bool:
    current: BaseException | None = error
    while current is not None:
        if "CERTIFICATE_VERIFY_FAILED" in str(current) or "SSL" in str(current):
            return True
        current = getattr(current, "reason", None) or getattr(current, "__cause__", None)
    return False


def mix_hex(a: str, b: str, t: float) -> str:
    """Blend two #rrggbb colours — used for the artwork-failure gradient."""
    def parse(value):
        value = (value or "#000000").lstrip("#")
        if len(value) != 6:
            value = "000000"
        return [int(value[i:i + 2], 16) for i in (0, 2, 4)]

    ca, cb = parse(a), parse(b)
    t = max(0.0, min(1.0, float(t)))
    return "#" + "".join(f"{round(x + (y - x) * t):02X}" for x, y in zip(ca, cb))


def format_trivia_sources(sources) -> str:
    """On-screen credit: source names only — no licence parentheticals."""
    names = []
    for source in sources or []:
        text = str(source or "").strip()
        if not text:
            continue
        # Strip legacy "Open Trivia DB (CC BY-SA 4.0)" payloads.
        if "(" in text:
            text = text.split("(", 1)[0].strip()
        if text and text not in names:
            names.append(text)
    if not names:
        return ""
    return "Sources: " + " | ".join(names)


def _with_alt_image_extensions(url: str) -> list[str]:
    """Prefer JPEG (portable Pillow builds often lack WebP), then other formats."""
    text = str(url or "").strip()
    if not text:
        return []
    try:
        parts = urlsplit(text)
    except Exception:
        return [text]
    path = parts.path or ""
    lower = path.lower()
    stem = path
    for ext in (".webp", ".png", ".jpeg", ".jpg"):
        if lower.endswith(ext):
            stem = path[: -len(ext)]
            break
    ordered_exts = [".jpg", ".jpeg", ".png", ".webp"]
    # Keep the original extension first so a correct URL wins, then try JPEG.
    original_ext = Path(path).suffix.lower()
    if original_ext in ordered_exts:
        ordered_exts = [original_ext] + [ext for ext in ordered_exts if ext != original_ext]
    out = []
    for ext in ordered_exts:
        new_path = f"{stem}{ext}"
        rebuilt = urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment))
        if rebuilt not in out:
            out.append(rebuilt)
    return out or [text]


def artwork_url_candidates(url: str, config: dict | None = None) -> list[str]:
    """LAN `bridgeHosts` rewrites first, then the URL the bridge sent.

    Displays live on the bridge's LAN, so a `bridgeHosts` address is both the
    shortest path and the one least likely to be answered by something other
    than the bridge (a CDN or a captive portal in front of the public host).
    """
    text = str(url or "").strip()
    if not text:
        return []
    seeds = _with_alt_image_extensions(text)
    out = []
    for seed in seeds:
        try:
            parts = urlsplit(seed)
        except Exception:
            if seed not in out:
                out.append(seed)
            continue
        if not parts.scheme or not parts.path:
            if seed not in out:
                out.append(seed)
            continue
        hosts = []
        for host in (config or {}).get("bridgeHosts") or []:
            host = str(host or "").strip()
            if host and host not in hosts:
                hosts.append(host)
        for host in hosts:
            # Keep the bridge HTTPS port when rewriting a public hostname to LAN.
            port = parts.port
            if port:
                netloc = f"{host}:{port}"
            elif parts.scheme == "https":
                netloc = f"{host}:47810"
            else:
                netloc = host
            rewritten = f"{parts.scheme}://{netloc}{parts.path}"
            if parts.query:
                rewritten += f"?{parts.query}"
            if rewritten not in out:
                out.append(rewritten)
            # Self-signed LAN often only answers on https; still try http last.
            if parts.scheme == "https":
                http_netloc = (
                    f"{host}:47810"
                    if not parts.port or parts.port == 443
                    else f"{host}:{parts.port}"
                )
                http_url = f"http://{http_netloc}{parts.path}"
                if parts.query:
                    http_url += f"?{parts.query}"
                if http_url not in out:
                    out.append(http_url)
        if seed not in out:
            out.append(seed)
    return out


def build_phase_plan(trivia: dict) -> list[dict]:
    """Flatten a round into the ordered cards the state machine walks.

    Kept pure so the whole sequence is assertable without a Tk clock.
    """
    trivia = trivia or {}
    questions = list(trivia.get("questions") or [])
    count = len(questions)
    question_seconds = max(1, int(trivia.get("questionSeconds") or 15))
    answer_seconds = max(1, int(trivia.get("answerSeconds") or 7))
    plan: list[dict] = []

    if trivia.get("showIntro") and count:
        plan.append({
            "phase": "intro",
            "seconds": max(1, int(trivia.get("introSeconds") or 4)),
            "index": None,
        })
    for index in range(count):
        plan.append({"phase": "question", "seconds": question_seconds, "index": index})
        plan.append({"phase": "answer", "seconds": answer_seconds, "index": index})
    # A one-question round has nothing to summarise (§6.9).
    if trivia.get("showSummary") and count > 1:
        plan.append({
            "phase": "summary",
            "seconds": max(1, int(trivia.get("summarySeconds") or 6)),
            "index": None,
        })
    return plan


def fit_text_font(
    font: tkfont.Font,
    text: str,
    *,
    max_width: float,
    max_lines: int = 4,
    min_size: int,
) -> tuple[tkfont.Font, list[str]]:
    """Shrink `font` until `text` wraps into `max_lines`, then ellipsise.

    Question lengths vary enormously; a fixed size either overflows the long
    ones or looks absurd on the short ones (§6.6). Mutates and returns `font`.
    """
    text = str(text or "")
    while True:
        lines = wrap_text(font, text, max_width)
        if len(lines) <= max_lines:
            return font, lines
        try:
            size = int(font.cget("size"))
        except Exception:
            return font, lines[:max_lines]
        if size <= min_size:
            # At the floor: keep the first N lines and mark the truncation, so a
            # clipped question reads as clipped instead of as a wrong question.
            lines = lines[:max_lines]
            if lines:
                lines[-1] = _truncate_with_ellipsis(font, lines[-1], max_width)
            return font, lines
        font.configure(size=size - 2)


def wrap_text(font, text: str, max_width: float) -> list[str]:
    words = str(text or "").split()
    if not words:
        return []
    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if _measure(font, candidate) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def _ellipsise(font, text: str, max_width: float) -> str:
    if _measure(font, text) <= max_width:
        return text
    return _truncate_with_ellipsis(font, text, max_width)


def _truncate_with_ellipsis(font, text: str, max_width: float) -> str:
    trimmed = str(text or "")
    while trimmed and _measure(font, f"{trimmed}…") > max_width:
        trimmed = trimmed[:-1]
    return f"{trimmed.rstrip()}…"


def _measure(font, text: str) -> float:
    try:
        return float(font.measure(text))
    except Exception:
        size = 16
        try:
            size = int(font.cget("size"))
        except Exception:
            pass
        return len(text) * size * 0.55


class TriviaPanel(BasePanel):
    """Owns its chrome: full-bleed artwork, own title, own countdown ring."""

    # §6.6 type ramp, in design units (multiplied by `u`).
    QUESTION_U_PORTRAIT = (72, 56)
    QUESTION_U_LANDSCAPE = (64, 48)
    OPTION_U_PORTRAIT = (44, 36)
    OPTION_U_LANDSCAPE = (40, 32)
    CHIP_U = 20
    COUNTDOWN_U = 32
    ATTRIBUTION_U = 13

    def __init__(self, root: tk.Tk, shell, config: dict):
        super().__init__(root, shell, config)
        self._trivia = {}
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
            "background": DEFAULT_BACKGROUND,
            "accent": DEFAULT_ACCENT,
            "tile_fill": mix_hex(DEFAULT_BACKGROUND, "#000000", 0.4),
            "tile_edge": mix_hex(DEFAULT_ACCENT, DEFAULT_BACKGROUND, 0.55),
            "ring_track": mix_hex(DEFAULT_BACKGROUND, "#FFFFFF", 0.14),
        }

    # ------------------------------------------------------------- lifecycle

    def hide(self):
        self._fetch_token += 1
        self._cancel_jobs()
        self._photo_refs = []
        self._artwork_key = None
        # `super().hide()` wipes the canvas, so holding on to these ids would
        # leave `_clear_foreground` protecting items that no longer exist.
        self._artwork_id = None
        self._color_id = None
        self._fallback_ids = []
        try:
            # Restore the house canvas colour when trivia leaves the stage.
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
        self._trivia = payload.get("trivia") or {}
        self._plan = build_phase_plan(self._trivia)
        self._step = 0
        if not self._plan:
            self._draw_empty_round()
            return
        self._enter_step(0)

    # -------------------------------------------------------- state machine

    def _enter_step(self, step: int):
        self._cancel_jobs()
        if step >= len(self._plan):
            return
        self._step = step
        entry = self._plan[step]
        self._phase_seconds = entry["seconds"]
        self._phase_ends_at = self._monotonic() + entry["seconds"]
        self._paint_step(entry)
        self._phase_job = self.root.after(
            entry["seconds"] * 1000, lambda: self._enter_step(step + 1),
        )
        self._schedule_countdown_tick()

    def _monotonic(self) -> float:
        import time
        return time.monotonic()

    def _schedule_countdown_tick(self):
        self._tick_job = self.root.after(250, self._on_countdown_tick)

    def _on_countdown_tick(self):
        if not self.visible:
            return
        self._update_countdown()
        self._schedule_countdown_tick()

    def _paint_step(self, entry: dict):
        # Everything but the artwork is redrawn per card; the background is kept
        # when the category has not changed so the reveal reads as one object.
        self._clear_foreground()
        geometry = self.compute_geometry()
        card = self._card_for(entry)
        self._set_palette(card)
        self._paint_artwork(geometry, card)
        if entry["phase"] == "intro":
            self._draw_intro(geometry)
        elif entry["phase"] == "summary":
            self._draw_summary(geometry)
        else:
            self._draw_question_card(
                geometry, card, entry["index"], reveal=entry["phase"] == "answer",
            )
        self._draw_attribution(geometry)
        # Drawing text/tiles can stack above the artwork; keep the field behind.
        self._lower_background()

    def _card_for(self, entry: dict) -> dict:
        questions = self._trivia.get("questions") or []
        index = entry.get("index")
        if index is None:
            index = 0
        if not questions:
            return {}
        return questions[max(0, min(len(questions) - 1, index))]

    def _set_palette(self, card: dict):
        """Drive chip / tiles / ring from the category colours in the payload (§6.5)."""
        background = str(card.get("background") or DEFAULT_BACKGROUND)
        accent = str(card.get("accent") or DEFAULT_ACCENT)
        self._palette = {
            "background": background,
            "accent": accent,
            # Darken the category field for idle tiles so they keep the hue
            # instead of the house STEAM blue (#0D1526) that washed every card.
            "tile_fill": mix_hex(background, "#000000", 0.42),
            "tile_edge": mix_hex(accent, background, 0.55),
            "ring_track": mix_hex(background, "#FFFFFF", 0.14),
        }
        try:
            self.canvas.configure(bg=background)
        except Exception:
            pass

    def _clear_foreground(self):
        # The background survives the card change; the colour field + gradient
        # count as background until the real artwork lands.
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

    # -------------------------------------------------------------- geometry

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

    @staticmethod
    def compute_portrait_boxes(chrome) -> dict:
        """Stacked: chip, question, full-width option tiles, progress row."""
        u = chrome.u
        x0 = chrome.content_x
        x1 = x0 + chrome.content_w
        top = chrome.content_top
        bottom = chrome.content_bottom - 16 * u
        # Attribution sits below everything, quiet and always present (§2.5).
        attribution_h = 28 * u
        progress_h = 76 * u
        chip_h = 44 * u
        pips_h = 30 * u
        gap = 26 * u

        chip = (x0, top, x1, top + chip_h)
        pips = (x0, chip[3] + 8 * u, x1, chip[3] + 8 * u + pips_h)
        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, x1, attribution[1])
        body_top = pips[3] + gap
        body_bottom = progress[1] - gap
        # Options take the lower ~55% so a long question can grow upward.
        options_h = (body_bottom - body_top) * 0.55
        options = (x0, body_bottom - options_h, x1, body_bottom)
        question = (x0, body_top, x1, options[1] - gap)
        return {
            "chip": chip, "pips": pips, "question": question,
            "options": options, "progress": progress, "attribution": attribution,
            "option_columns": 1,
        }

    @staticmethod
    def compute_landscape_boxes(chrome) -> dict:
        """Two columns: question and metadata left, option tiles right (§6.3).

        A wide short question box would force the type to shrink; splitting keeps
        it large.
        """
        u = chrome.u
        x0 = chrome.content_x
        x1 = x0 + chrome.content_w
        top = chrome.content_top
        bottom = chrome.content_bottom - 16 * u
        gutter = 40 * u
        col_w = (x1 - x0 - gutter) / 2
        left_x1 = x0 + col_w
        right_x0 = left_x1 + gutter

        attribution_h = 26 * u
        progress_h = 72 * u
        chip_h = 44 * u
        pips_h = 30 * u
        gap = 22 * u

        chip = (x0, top, left_x1, top + chip_h)
        pips = (x0, chip[3] + 8 * u, left_x1, chip[3] + 8 * u + pips_h)
        attribution = (x0, bottom - attribution_h, x1, bottom)
        progress = (x0, attribution[1] - progress_h, left_x1, attribution[1])
        question = (x0, pips[3] + gap, left_x1, progress[1] - gap)
        options = (right_x0, top, x1, attribution[1] - gap)
        return {
            "chip": chip, "pips": pips, "question": question,
            "options": options, "progress": progress, "attribution": attribution,
            "option_columns": 1,
        }

    @staticmethod
    def compute_option_tiles(box, count: int, u: float) -> list[tuple]:
        """Evenly split the options box. True/false gets two large tiles, not
        two lonely ones in a four-slot grid (§6.3)."""
        x0, y0, x1, y1 = box
        count = max(1, int(count))
        gap = 18 * u
        total = (y1 - y0) - gap * (count - 1)
        tile_h = total / count
        return [
            (x0, y0 + i * (tile_h + gap), x1, y0 + i * (tile_h + gap) + tile_h)
            for i in range(count)
        ]

    # ----------------------------------------------------------- card paints

    def _draw_question_card(self, geometry, card, index: int, *, reveal: bool):
        u = geometry["u"]
        portrait = geometry["portrait"]
        accent = self._palette["accent"]

        self._draw_chip(geometry, card, accent)
        self._draw_difficulty_pips(geometry, card, accent)

        qx0, qy0, qx1, qy1 = geometry["question"]
        hi, lo = self.QUESTION_U_PORTRAIT if portrait else self.QUESTION_U_LANDSCAPE
        question_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(12, int(round(hi * u))), weight="bold",
        )
        question_font, lines = fit_text_font(
            question_font, card.get("text", ""),
            max_width=qx1 - qx0, max_lines=4, min_size=max(10, int(round(lo * u))),
        )
        line_h = question_font.metrics("linespace")
        block_h = line_h * len(lines)
        # Bottom-anchored so a short question sits near its options rather than
        # floating in the middle of the card.
        y = max(qy0, qy1 - block_h)
        for line in lines:
            self._track(self.canvas.create_text(
                qx0, y, anchor="nw", text=line, fill=INK, font=question_font,
            ))
            y += line_h

        answers = list(card.get("answers") or [])
        tiles = self.compute_option_tiles(geometry["options"], len(answers), u)
        correct = card.get("correctIndex", -1)
        opt_hi, opt_lo = self.OPTION_U_PORTRAIT if portrait else self.OPTION_U_LANDSCAPE
        for i, (answer, tile) in enumerate(zip(answers, tiles)):
            self._draw_option_tile(
                tile, OPTION_LETTERS[i] if i < len(OPTION_LETTERS) else "?", answer,
                accent=accent, u=u, hi=opt_hi, lo=opt_lo,
                state=("correct" if i == correct else "dim") if reveal else "idle",
            )

        if reveal and card.get("funFact"):
            self._draw_fun_fact(geometry, card, u)

        self._draw_progress(geometry, index, accent)

    def _draw_option_tile(self, tile, letter, text, *, accent, u, hi, lo, state):
        x0, y0, x1, y1 = tile
        tile_fill = self._palette["tile_fill"]
        tile_edge = self._palette["tile_edge"]
        if state == "correct":
            # §6.4: accent fill, white text — not the house navy ink.
            fill, edge, ink, letter_ink = accent, accent, INK, INK
        elif state == "dim":
            # 35% opacity, desaturated, no border (§6.4).
            fill, edge = mix_hex(tile_fill, "#000000", 0.35), ""
            ink, letter_ink = INK_3, INK_3
        else:
            fill, edge, ink, letter_ink = tile_fill, tile_edge, INK, accent

        self._track(self.canvas.create_rectangle(
            x0, y0, x1, y1, fill=fill, outline=edge or fill,
            width=max(1, int(round(2 * u))),
        ))
        letter_font = tkfont.Font(family="Consolas", size=max(10, int(round(28 * u))))
        pad = 26 * u
        self._track(self.canvas.create_text(
            x0 + pad, (y0 + y1) / 2, anchor="w",
            text=letter, fill=letter_ink, font=letter_font,
        ))
        text_x = x0 + pad + letter_font.measure("W") * 1.8
        # Long answers wrap to two lines rather than breaking the grid (§6.9).
        option_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(10, int(round(hi * u))), weight="bold",
        )
        option_font, lines = fit_text_font(
            option_font, text, max_width=x1 - text_x - pad, max_lines=2,
            min_size=max(10, int(round(lo * u))),
        )
        line_h = option_font.metrics("linespace")
        y = (y0 + y1) / 2 - (line_h * len(lines)) / 2
        for line in lines:
            self._track(self.canvas.create_text(
                text_x, y, anchor="nw", text=line, fill=ink, font=option_font,
            ))
            y += line_h

    def _draw_chip(self, geometry, card, accent):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["chip"]
        label = str(card.get("categoryLabel") or "").upper()
        font = tkfont.Font(family="Consolas", size=max(9, int(round(self.CHIP_U * u))))
        pad_x = 20 * u
        width = font.measure(label) + pad_x * 2
        self._track(self.canvas.create_rectangle(
            x0, y0, x0 + width, y1, fill="", outline=accent,
            width=max(1, int(round(2 * u))),
        ))
        self._track(self.canvas.create_text(
            x0 + pad_x, (y0 + y1) / 2, anchor="w", text=label, fill=accent, font=font,
        ))

    def _draw_difficulty_pips(self, geometry, card, accent):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["pips"]
        difficulty = str(card.get("difficulty") or "medium").lower()
        filled = {"easy": 1, "medium": 2, "hard": 3}.get(difficulty, 2)
        r = 7 * u
        cy = (y0 + y1) / 2
        x = x0 + r
        for i in range(3):
            self._track(self.canvas.create_oval(
                x - r, cy - r, x + r, cy + r,
                fill=accent if i < filled else "", outline=accent,
                width=max(1, int(round(1.5 * u))),
            ))
            x += r * 3.2
        font = tkfont.Font(family="Consolas", size=max(9, int(round(18 * u))))
        self._track(self.canvas.create_text(
            x + 8 * u, cy, anchor="w", text=difficulty, fill=INK_2, font=font,
        ))

    def _draw_progress(self, geometry, index: int, accent):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["progress"]
        total = len(self._trivia.get("questions") or [])
        cy = (y0 + y1) / 2
        # A single-question round has no progress to show (§6.9).
        if total > 1:
            r = 8 * u
            x = x0 + r
            for i in range(total):
                self._track(self.canvas.create_oval(
                    x - r, cy - r, x + r, cy + r,
                    fill=accent if i <= index else "", outline=accent,
                    width=max(1, int(round(1.5 * u))),
                ))
                x += r * 3.4
        self._draw_countdown_ring(x1 - 44 * u, cy, 34 * u, accent, u)

    def _draw_countdown_ring(self, cx, cy, radius, accent, u):
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
        # Tabular figures so the numeral does not jitter as it counts down.
        font = tkfont.Font(family="Consolas", size=max(10, int(round(self.COUNTDOWN_U * u))))
        self._countdown_text_id = self._track(self.canvas.create_text(
            cx, cy, anchor="center", text=str(self._phase_seconds), fill=INK, font=font,
        ))
        self._ring_accent = accent

    def _update_countdown(self):
        if not self._ring_ids and self._countdown_text_id is None:
            return
        remaining = max(0.0, self._phase_ends_at - self._monotonic())
        fraction = remaining / self._phase_seconds if self._phase_seconds else 0.0
        try:
            if self._ring_ids:
                self.canvas.itemconfigure(
                    self._ring_ids[0],
                    extent=-max(0.1, 359.9 * fraction),
                    # Last three seconds warm, never flash (§6.7).
                    outline=WARN_ACCENT if remaining <= 3 else self._ring_accent,
                )
            if self._countdown_text_id is not None:
                self.canvas.itemconfigure(
                    self._countdown_text_id, text=str(int(remaining + 0.5)),
                )
        except Exception:
            pass

    def _draw_intro(self, geometry):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["question"]
        total = len(self._trivia.get("questions") or [])
        title_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(16, int(round(96 * u))), weight="bold",
        )
        sub_font = tkfont.Font(family="Consolas", size=max(10, int(round(30 * u))))
        cy = (y0 + y1) / 2
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy, anchor="s", text="TRIVIA", fill=INK, font=title_font,
        ))
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy + 18 * u, anchor="n",
            text=f"{total} question{'s' if total != 1 else ''}",
            fill=INK_2, font=sub_font,
        ))

    def _draw_summary(self, geometry):
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["question"]
        questions = self._trivia.get("questions") or []
        title_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(64 * u))), weight="bold",
        )
        line_font = tkfont.Font(family="Consolas", size=max(10, int(round(26 * u))))
        self._track(self.canvas.create_text(
            x0, y0, anchor="nw", text="THAT'S THE ROUND", fill=INK, font=title_font,
        ))
        y = y0 + title_font.metrics("linespace") + 24 * u
        line_h = line_font.metrics("linespace") + 10 * u
        for card in questions:
            answers = card.get("answers") or []
            index = card.get("correctIndex", -1)
            answer = answers[index] if 0 <= index < len(answers) else ""
            self._track(self.canvas.create_text(
                x0, y, anchor="nw",
                text=_ellipsise(line_font, f"{card.get('categoryLabel', '')} — {answer}", x1 - x0),
                fill=INK_2, font=line_font,
            ))
            y += line_h

    def _draw_fun_fact(self, geometry, card, u):
        x0, y0, x1, y1 = geometry["question"]
        font = tkfont.Font(family="Consolas", size=max(9, int(round(22 * u))))
        _, lines = fit_text_font(
            font, card["funFact"], max_width=x1 - x0, max_lines=2,
            min_size=max(9, int(round(16 * u))),
        )
        y = y1 + 10 * u
        for line in lines:
            self._track(self.canvas.create_text(
                x0, y, anchor="nw", text=line, fill=INK_3, font=font,
            ))
            y += font.metrics("linespace")

    def _draw_attribution(self, geometry):
        """Small source credit — names only, no licence clutter on the wall."""
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["attribution"]
        label = format_trivia_sources(self._trivia.get("attribution") or [])
        if not label:
            return
        font = tkfont.Font(
            family="Consolas", size=max(8, int(round(self.ATTRIBUTION_U * u))),
        )
        self._track(self.canvas.create_text(
            x0, (y0 + y1) / 2, anchor="w",
            text=label,
            fill=INK_3, font=font,
        ))

    def _draw_empty_round(self):
        """A clean card explaining trivia is stocking up, not a broken round."""
        geometry = self.compute_geometry()
        u = geometry["u"]
        x0, y0, x1, y1 = geometry["question"]
        title_font = tkfont.Font(
            family=self.config.get("titleFontFamily", "Segoe UI"),
            size=max(14, int(round(56 * u))), weight="bold",
        )
        sub_font = tkfont.Font(family="Consolas", size=max(10, int(round(24 * u))))
        cy = (y0 + y1) / 2
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy, anchor="s",
            text="Trivia is stocking up", fill=INK, font=title_font,
        ))
        self._track(self.canvas.create_text(
            (x0 + x1) / 2, cy + 16 * u, anchor="n",
            text="Questions will be ready shortly", fill=INK_2, font=sub_font,
        ))

    # -------------------------------------------------------------- artwork

    def _paint_artwork(self, geometry, card):
        """Full-bleed category field + artwork, kept across cards in one category."""
        key = card.get("categoryId")
        if key and key == self._artwork_key and self._background_ids():
            self._lower_background()
            return
        self._artwork_key = key
        self._drop_background()

        # Solid category colour first so the card never falls back to the house
        # navy canvas — even when the webp fetch is slow or fails (§6.5).
        self._draw_colour_field(geometry, card)
        self._draw_gradient_fallback(geometry, card)

        artwork = card.get("artwork") or {}
        portrait = bool(geometry["portrait"])
        url = artwork.get("portrait" if portrait else "landscape")
        # A missing URL is still worth a pass when the bundled pack has the art.
        if Image is None or not (url or trivia_artwork_asset_path(key, portrait)):
            return
        self._fetch_token += 1
        token = self._fetch_token
        threading.Thread(
            target=self._fetch_artwork,
            args=(token, url, geometry["screen_w"], geometry["screen_h"], key, portrait),
            daemon=True,
        ).start()

    def _background_ids(self):
        return [
            item for item in (self._artwork_id, self._color_id, *self._fallback_ids)
            if item is not None
        ]

    def _lower_background(self):
        """Stack colour → gradient → artwork under all foreground chrome.

        Prefer `tag_raise(above, below)` so the artwork cannot lose a race to
        an opaque colour field that was lowered last.
        """
        if self._color_id is not None:
            try:
                self.canvas.tag_lower(self._color_id)
            except Exception:
                pass
        below = self._color_id
        for item in self._fallback_ids:
            try:
                if below is not None:
                    self.canvas.tag_raise(item, below)
                else:
                    self.canvas.tag_lower(item)
                below = item
            except Exception:
                pass
        if self._artwork_id is not None:
            try:
                if below is not None:
                    self.canvas.tag_raise(self._artwork_id, below)
                else:
                    self.canvas.tag_lower(self._artwork_id)
            except Exception:
                pass

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

    def _draw_colour_field(self, geometry, card):
        background = str(card.get("background") or self._palette["background"])
        item = self.canvas.create_rectangle(
            0, 0, geometry["screen_w"], geometry["screen_h"],
            fill=background, outline="",
        )
        self._track(item)
        self.canvas.tag_lower(item)
        self._color_id = item

    def _draw_gradient_fallback(self, geometry, card):
        background = str(card.get("background") or self._palette["background"])
        accent = str(card.get("accent") or self._palette["accent"])
        height = geometry["screen_h"]
        bands = 24
        for i in range(bands):
            y0 = height * i / bands
            y1 = height * (i + 1) / bands
            # Keep the category hue dominant — only a soft wash toward a darkened
            # accent, not a dive into navy.
            colour = mix_hex(background, mix_hex(accent, background, 0.55), i / (bands - 1) * 0.55)
            item = self.canvas.create_rectangle(
                0, y0, geometry["screen_w"], y1 + 1, fill=colour, outline="",
            )
            self._track(item)
            self.canvas.tag_lower(item)
            self._fallback_ids.append(item)

    def _fetch_artwork(self, token, url, width, height, category_id=None, portrait=True):
        image = self._load_or_download(
            url, width, height,
            config=self.config, category_id=category_id, portrait=portrait,
        )
        if image is None:
            return
        self.root.after(0, lambda: self._apply_artwork(token, image))

    @classmethod
    def _load_or_download(cls, url, width, height, config=None, category_id=None, portrait=True):
        if Image is None:
            return None
        for candidate in artwork_url_candidates(url, config):
            image = cls._load_one_url(candidate, width, height)
            if image is not None:
                return image
        image = cls._load_local_artwork(category_id, portrait, width, height)
        if image is not None:
            return image
        print(
            "Trivia artwork unavailable over HTTP and from the bundled pack "
            f"(category={category_id or '?'}, url={url or 'none'})",
            file=sys.stderr, flush=True,
        )
        return None

    @classmethod
    def _load_local_artwork(cls, category_id, portrait, width, height):
        path = trivia_artwork_asset_path(category_id, portrait)
        if path is None:
            return None
        try:
            return cls._scale_cover(Image.open(path).convert("RGB"), width, height)
        except Exception:
            return None

    @classmethod
    def _load_one_url(cls, url, width, height):
        global _unverified_ssl
        cache_file = trivia_artwork_cache_path(url)
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

            # LAN bridges use a self-signed cert; try unverified first once we
            # know that path works, otherwise verified then unverified.
            contexts = []
            if _unverified_ssl or str(url).lower().startswith("https://"):
                contexts.append(ssl._create_unverified_context())
            contexts.append(None if not str(url).lower().startswith("https://") else ssl.create_default_context())
            # De-dupe while preserving order.
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
                    if context is None and _is_ssl_failure(error):
                        continue
                    continue
            if data is None:
                raise last_error or RuntimeError("artwork download failed")
            # An HTML error page caches just as happily as a JPEG and then wins
            # every later attempt, so nothing but real image bytes is kept.
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
        """Return the cached image, discarding the file when it is not one."""
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
        """Fill the screen. Portrait and landscape are separately composed —
        never rotate or letterbox one into the other (§6.5.3)."""
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
        # Opaque gradient bands would hide the image; keep the solid colour
        # field underneath in case cover-crop leaves a sliver of canvas.
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
