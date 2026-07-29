"""Shared photos display page — slideshow + single-upload (spec v2).

Portrait: 1080×1920 stack (header / stage / bottom bar).
Landscape: 1920×1080 with stage + vertical rail + right sidebar (§11).
"""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

try:
    from PIL import Image, ImageTk, ImageOps
except ImportError:
    Image = None
    ImageTk = None
    ImageOps = None

from src.design_system import design_u
from src.page_header import paint_page_header
from src.payload_utils import format_chip_timestamp


NEUTRAL_MAT = "#101215"
NEUTRAL_ACCENT = "#8fa0b0"
PRINT_BORDER = "#f4f2ed"


@dataclass
class SharedPhotosLayout:
    u: float
    portrait: bool
    x0: float
    y0: float
    page_w: float
    page_h: float
    header: tuple[float, float, float, float]
    stage: tuple[float, float, float, float]
    photo_box: tuple[float, float]
    bar: tuple[float, float, float, float]
    rail: tuple[float, float, float, float]
    rail_vertical: bool
    rail_h: float
    qr_plate: float
    qr_size: float
    print_border: float


def compute_layout(
    screen_w: int,
    screen_h: int,
    *,
    mode: str = "slideshow",
) -> SharedPhotosLayout:
    """Portrait stack or landscape stage+sidebar (spec §3 / §11)."""
    screen_w = max(64, int(screen_w))
    screen_h = max(64, int(screen_h))
    u = design_u(screen_w, screen_h)
    portrait = screen_h >= screen_w
    upload = str(mode or "").lower() == "upload"

    if portrait:
        page_w = 1080 * u
        page_h = 1920 * u
        if page_h > screen_h:
            page_h = float(screen_h)
            page_w = page_h * 1080 / 1920
            u = page_w / 1080
        if page_w > screen_w:
            page_w = float(screen_w)
            page_h = page_w * 1920 / 1080
            u = page_w / 1080
        x0 = (screen_w - page_w) / 2
        y0 = (screen_h - page_h) / 2

        def px(n: float) -> float:
            return n * u

        header = (x0 + px(40), y0 + px(32), x0 + page_w - px(40), y0 + px(32 + 84))
        stage = (x0, y0 + px(136), x0 + page_w, y0 + px(136 + 1464))
        photo_box = (px(1032), px(1416))
        bar = (x0, y0 + px(1600), x0 + page_w, y0 + page_h)
        rail = (bar[0], bar[1], bar[2], bar[1] + px(5))
        return SharedPhotosLayout(
            u=u,
            portrait=True,
            x0=x0,
            y0=y0,
            page_w=page_w,
            page_h=page_h,
            header=header,
            stage=stage,
            photo_box=photo_box,
            bar=bar,
            rail=rail,
            rail_vertical=False,
            rail_h=px(5),
            qr_plate=px(260),
            qr_size=px(208),
            print_border=px(18),
        )

    # Landscape — full-bleed page using vmin --u (spec §11).
    page_w = float(screen_w)
    page_h = float(screen_h)
    x0 = 0.0
    y0 = 0.0
    # Centre a 1800-wide content column when the panel is wider than design.
    content_w = min(page_w, 1800 * u)
    content_x = (page_w - content_w) / 2
    # Map design X (60…1860 on 1920) into the content column.
    scale_x = content_w / (1800 * u) if u else 1.0

    def lx(design_x: float) -> float:
        return content_x + (design_x - 60) * u * scale_x

    header_top = 28 * u
    header_h = 84 * u
    content_top = 132 * u
    # Slideshow: zone to 1048 (+32 bottom margin). Upload: zone to 952 (footer band).
    zone_bottom = (952 if upload else 1048) * u
    # Clamp to screen so shorter panels still fit.
    zone_bottom = min(zone_bottom, page_h - (8 * u if upload else 24 * u))
    zone_bottom = max(zone_bottom, content_top + 200 * u)

    # Match landscape mockup: stage 1388, rail at 1420 (6 wide), sidebar 380.
    stage = (lx(60), content_top, lx(60 + 1388), zone_bottom)
    rail = (lx(60 + 1420), content_top, lx(60 + 1420 + 6), zone_bottom)
    bar = (lx(60 + 1420), content_top, lx(60 + 1800), zone_bottom)
    stage_w = max(40.0, stage[2] - stage[0])
    stage_h = max(40.0, stage[3] - stage[1])
    inset = 24 * u
    photo_box = (max(40.0, stage_w - 2 * inset), max(40.0, stage_h - 2 * inset))
    header = (
        content_x,
        header_top,
        content_x + content_w,
        header_top + header_h,
    )
    return SharedPhotosLayout(
        u=u,
        portrait=False,
        x0=x0,
        y0=y0,
        page_w=page_w,
        page_h=page_h,
        header=header,
        stage=stage,
        photo_box=photo_box,
        bar=bar,
        rail=rail,
        rail_vertical=True,
        rail_h=max(2.0, 6 * u),
        qr_plate=300 * u,
        qr_size=232 * u,
        print_border=18 * u,
    )


def rgb_to_hsl(r: float, g: float, b: float) -> tuple[float, float, float]:
    mx = max(r, g, b)
    mn = min(r, g, b)
    d = mx - mn
    h = 0.0
    if d:
        if mx == r:
            h = ((g - b) / d + (6.0 if g < b else 0.0))
        elif mx == g:
            h = (b - r) / d + 2.0
        else:
            h = (r - g) / d + 4.0
        h *= 60.0
    l = (mx + mn) / 2.0
    s = (d / (1.0 - abs(2.0 * l - 1.0))) if d else 0.0
    return h, s, l


def sample_mat_accent(image) -> tuple[str, str]:
    """Return (mat, accent) per spec §7. Neutral fallback if dull."""
    if image is None or Image is None:
        return NEUTRAL_MAT, NEUTRAL_ACCENT
    try:
        small = image.convert("RGB").resize(
            (16, 16),
            getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS),
        )
        pixels = list(small.getdata())
        rs = gs = bs = 0.0
        n = 0
        for r, g, b in pixels:
            R, G, B = r / 255.0, g / 255.0, b / 255.0
            luma = 0.2126 * R + 0.7152 * G + 0.0722 * B
            if luma < 0.08 or luma > 0.92:
                continue
            rs += R
            gs += G
            bs += B
            n += 1
        if n < 0.2 * 256:
            return NEUTRAL_MAT, NEUTRAL_ACCENT
        h, s, _l = rgb_to_hsl(rs / n, gs / n, bs / n)
        if s < 0.06:
            return NEUTRAL_MAT, NEUTRAL_ACCENT
        mat_s = min(s, 0.32)
        acc_s = max(0.35, min(s, 0.60))
        mat = f"#{_hsl_to_hex(h, mat_s, 0.11)}"
        accent = f"#{_hsl_to_hex(h, acc_s, 0.72)}"
        return mat, accent
    except Exception:
        return NEUTRAL_MAT, NEUTRAL_ACCENT


def _hsl_to_hex(h: float, s: float, l: float) -> str:
    """HSL → RRGGBB (Tk-safe solid colors; hsl() strings are unreliable in Tk)."""
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    if 0 <= h < 60:
        rp, gp, bp = c, x, 0
    elif 60 <= h < 120:
        rp, gp, bp = x, c, 0
    elif 120 <= h < 180:
        rp, gp, bp = 0, c, x
    elif 180 <= h < 240:
        rp, gp, bp = 0, x, c
    elif 240 <= h < 300:
        rp, gp, bp = x, 0, c
    else:
        rp, gp, bp = c, 0, x
    r = int(round((rp + m) * 255))
    g = int(round((gp + m) * 255))
    b = int(round((bp + m) * 255))
    return f"{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"


def fit_photo_for_box(image, max_w: int, max_h: int, *, border_px: int = 0):
    """Contain into box with ≤2× upscale; optional print border baked in."""
    if image is None or Image is None:
        return None
    max_w = max(1, int(max_w))
    max_h = max(1, int(max_h))
    inner_w = max(1, max_w - border_px * 2)
    inner_h = max(1, max_h - border_px * 2)
    src_w, src_h = image.size
    if src_w < 1 or src_h < 1:
        return None
    scale = min(inner_w / src_w, inner_h / src_h, 2.0)
    new_w = max(1, int(round(src_w * scale)))
    new_h = max(1, int(round(src_h * scale)))
    resample = getattr(getattr(Image, "Resampling", Image), "LANCZOS", Image.LANCZOS)
    resized = image.resize((new_w, new_h), resample)
    if border_px > 0 and ImageOps is not None:
        resized = ImageOps.expand(resized, border=border_px, fill=PRINT_BORDER)
    return resized


def format_shared_date(uploaded_at) -> str:
    if not uploaded_at:
        return datetime.now().strftime("%b %d").upper()
    try:
        text = format_chip_timestamp(uploaded_at)
        if "·" in text:
            return text.split("·")[0].strip().upper()
        return text.upper()
    except Exception:
        return datetime.now().strftime("%b %d").upper()


def format_shared_time(uploaded_at) -> str:
    if not uploaded_at:
        return datetime.now().strftime("%I:%M %p").lstrip("0")
    try:
        text = format_chip_timestamp(uploaded_at)
        if "·" in text:
            return text.split("·")[1].strip()
        return text
    except Exception:
        return datetime.now().strftime("%I:%M %p").lstrip("0")


def counter_label(index: int, total: int) -> str:
    return f"{index + 1:02d} / {total:02d}"


class SharedPhotosRenderer:
    """Draws mat / header / stage / bar onto a Tk canvas."""

    def __init__(
        self,
        canvas: tk.Canvas,
        shell,
        config: dict,
        track: Callable[[int], int],
    ):
        self.canvas = canvas
        self.shell = shell
        self.config = config
        self.track = track
        self._photo_refs: list = []
        self._qr_ref = None
        self._rail_fill_id = None
        self._status_id = None
        self._layout: SharedPhotosLayout | None = None
        self._accent = NEUTRAL_ACCENT
        self._rail_token = 0
        self._mode = "slideshow"

    def clear_refs(self):
        self._photo_refs = []
        self._qr_ref = None
        self._rail_fill_id = None
        self._status_id = None
        self._rail_token += 1

    def _u_font(self, *, mono: bool, size_u: float, weight: str = "normal"):
        """Return a Tk font *spec* (tuple) so painting works without Font()."""
        layout = self._layout
        size = max(8, int(round(size_u * (layout.u if layout else 1))))
        if mono:
            family = "Consolas"
        else:
            family = "Segoe UI"
            try:
                family = self.shell.chip_value_font.actual("family") or family
            except Exception:
                pass
        if weight == "bold":
            return (family, size, "bold")
        return (family, size)

    def _measure(self, font_spec, text: str) -> int:
        try:
            font = tkfont.Font(
                family=font_spec[0],
                size=font_spec[1],
                weight="bold" if len(font_spec) > 2 and font_spec[2] == "bold" else "normal",
            )
            return int(font.measure(text))
        except Exception:
            size = font_spec[1] if len(font_spec) > 1 else 16
            return int(len(text) * size * 0.55)

    def _linespace(self, font_spec) -> int:
        try:
            font = tkfont.Font(
                family=font_spec[0],
                size=font_spec[1],
                weight="bold" if len(font_spec) > 2 and font_spec[2] == "bold" else "normal",
            )
            return int(font.metrics("linespace"))
        except Exception:
            return int(font_spec[1] if len(font_spec) > 1 else 16) + 4

    def prepare(self, screen_w: int, screen_h: int, *, mode: str = "slideshow") -> SharedPhotosLayout:
        self._mode = mode or "slideshow"
        self._layout = compute_layout(screen_w, screen_h, mode=self._mode)
        return self._layout

    def paint_mat(self, mat_color: str, screen_w: int, screen_h: int):
        layout = self._layout
        assert layout
        self.track(self.canvas.create_rectangle(
            0, 0, screen_w, screen_h, fill=mat_color, outline="",
        ))
        # No stage vignette — a stippled black floor read as a hard bar behind
        # the print-bordered photo in landscape.

    def paint_header(self, *, mode: str, index: int, total: int):
        layout = self._layout
        assert layout
        pill = "SHARED PHOTO" if mode == "upload" else "SHARED PHOTOS"
        right_label = ""
        right_value = ""
        if mode != "upload" and total > 1:
            right_label = "PHOTO"
            right_value = counter_label(index, total)

        if layout.portrait:
            paint_page_header(
                self.canvas,
                screen_w=int(layout.page_w),
                screen_h=int(layout.page_h),
                pill=pill,
                left_label="SOURCE",
                left_value="Signal",
                right_label=right_label,
                right_value=right_value,
                track=lambda item_id: self._offset_header_item(item_id, layout.x0, layout.y0),
                sans_family="Segoe UI",
                mono_family="Consolas",
                y0=32 * layout.u,
            )
            return

        # Landscape: header spans the real screen (no letterbox offset).
        paint_page_header(
            self.canvas,
            screen_w=int(layout.page_w),
            screen_h=int(layout.page_h),
            pill=pill,
            left_label="SOURCE",
            left_value="Signal",
            right_label=right_label,
            right_value=right_value,
            track=self.track,
            sans_family="Segoe UI",
            mono_family="Consolas",
            y0=28 * layout.u,
        )

    def _offset_header_item(self, item_id: int, dx: float, dy: float) -> int:
        """Translate header items from page-local (0,0) into screen space."""
        self.track(item_id)
        try:
            self.canvas.move(item_id, dx, dy)
        except Exception:
            pass
        return item_id

    def paint_photo(self, image) -> object | None:
        layout = self._layout
        assert layout
        sx0, sy0, sx1, sy1 = layout.stage
        stage_cx = (sx0 + sx1) / 2
        stage_cy = (sy0 + sy1) / 2
        max_w, max_h = layout.photo_box
        border = max(0, int(round(layout.print_border)))
        fitted = fit_photo_for_box(image, int(max_w), int(max_h), border_px=border)
        if fitted is None or ImageTk is None:
            return None
        pw, ph = fitted.size
        self.track(self.canvas.create_rectangle(
            stage_cx - pw / 2 - 1, stage_cy - ph / 2 - 1,
            stage_cx + pw / 2 + 1, stage_cy + ph / 2 + 1,
            outline="#000000", width=1,
        ))
        photo = ImageTk.PhotoImage(fitted)
        self._photo_refs.append(photo)
        self.track(self.canvas.create_image(stage_cx, stage_cy, image=photo))
        return photo

    def paint_bar(
        self,
        *,
        mode: str,
        index: int,
        total: int,
        uploaded_at,
        caption: str,
        qr_url: str,
        build_qr,
        dwell_ms: int,
        status_text: str,
        accent: str,
    ):
        layout = self._layout
        assert layout
        self._accent = accent or NEUTRAL_ACCENT
        if layout.portrait:
            self._paint_bar_portrait(
                mode=mode, index=index, total=total, uploaded_at=uploaded_at,
                caption=caption, qr_url=qr_url, build_qr=build_qr,
                dwell_ms=dwell_ms, status_text=status_text,
            )
        else:
            self._paint_bar_landscape(
                mode=mode, index=index, total=total, uploaded_at=uploaded_at,
                caption=caption, qr_url=qr_url, build_qr=build_qr,
                dwell_ms=dwell_ms, status_text=status_text,
            )

    def _paint_rail(
        self,
        *,
        mode: str,
        index: int,
        total: int,
        dwell_ms: int,
        accent: str,
    ):
        layout = self._layout
        assert layout
        rx0, ry0, rx1, ry1 = layout.rail
        self._rail_token += 1
        rail_token = self._rail_token
        show_rail = not (mode != "upload" and total <= 1)
        # Upload keeps a draining rail in the photos chrome (system footer suppressed).
        if not show_rail and mode != "upload":
            return
        if layout.rail_vertical:
            if mode == "upload" or total > 20 or total <= 1:
                self.track(self.canvas.create_rectangle(
                    rx0, ry0, rx1, ry1, fill="#3a4048", outline="",
                ))
                # Start full; drain with remaining time (matches NEXT IN Xs).
                fill_id = self.canvas.create_rectangle(
                    rx0, ry0, rx1, ry1, fill=accent, outline="",
                )
                self.track(fill_id)
                self._rail_fill_id = fill_id
                if dwell_ms > 0:
                    self.canvas.after(
                        16,
                        lambda: self._animate_rail_vertical(
                            rail_token, rx0, rx1, ry0, ry1, dwell_ms,
                        ),
                    )
            else:
                gap = 4 * layout.u
                seg_h = (ry1 - ry0 - gap * (total - 1)) / max(1, total)
                for i in range(total):
                    sy = ry0 + i * (seg_h + gap)
                    ey = sy + seg_h
                    fill = "#6a7380" if i < index else "#3a4048"
                    self.track(self.canvas.create_rectangle(
                        rx0, sy, rx1, ey, fill=fill, outline="",
                    ))
                    if i == index:
                        fill_id = self.canvas.create_rectangle(
                            rx0, sy, rx1, ey, fill=accent, outline="",
                        )
                        self.track(fill_id)
                        self._rail_fill_id = fill_id
                        if dwell_ms > 0:
                            self.canvas.after(
                                16,
                                lambda s=sy, e=ey: self._animate_rail_vertical(
                                    rail_token, rx0, rx1, s, e, dwell_ms,
                                ),
                            )
            return

        # Portrait horizontal rail along the top of the bar.
        rail_top = ry0
        rail_h = max(2, layout.rail_h)
        bx0, bx1 = rx0, rx1
        if mode == "upload" or total > 20:
            self.track(self.canvas.create_rectangle(
                bx0, rail_top, bx1, rail_top + rail_h,
                fill="#3a4048", outline="",
            ))
            fill_id = self.canvas.create_rectangle(
                bx0, rail_top, bx1, rail_top + rail_h,
                fill=accent, outline="",
            )
            self.track(fill_id)
            self._rail_fill_id = fill_id
            if dwell_ms > 0:
                self.canvas.after(
                    16,
                    lambda: self._animate_rail(rail_token, bx0, bx1, rail_top, rail_h, dwell_ms),
                )
        else:
            gap = 4 * layout.u
            seg_w = (bx1 - bx0 - gap * (total - 1)) / max(1, total)
            for i in range(total):
                sx = bx0 + i * (seg_w + gap)
                ex = sx + seg_w
                fill = "#6a7380" if i < index else "#3a4048"
                self.track(self.canvas.create_rectangle(
                    sx, rail_top, ex, rail_top + rail_h, fill=fill, outline="",
                ))
                if i == index:
                    fill_id = self.canvas.create_rectangle(
                        sx, rail_top, ex, rail_top + rail_h, fill=accent, outline="",
                    )
                    self.track(fill_id)
                    self._rail_fill_id = fill_id
                    if dwell_ms > 0:
                        self.canvas.after(
                            16,
                            lambda s=sx, e=ex: self._animate_rail(
                                rail_token, s, e, rail_top, rail_h, dwell_ms,
                            ),
                        )

    def _meta_strings(self, mode: str, uploaded_at, caption: str) -> tuple[str, str]:
        date = format_shared_date(uploaded_at)
        time_s = format_shared_time(uploaded_at)
        verb = "UPLOADED" if mode == "upload" else "SHARED"
        cap = (caption or "").strip()
        if cap:
            return f"{verb} {date} · {time_s}", cap
        return f"{verb} {date}", time_s

    def _paint_qr_plate(self, qr_x0, qr_y0, plate, qr_size, qr_url, build_qr):
        layout = self._layout
        assert layout
        self.track(self.canvas.create_rectangle(
            qr_x0, qr_y0, qr_x0 + plate, qr_y0 + plate,
            fill="#ffffff", outline="",
        ))
        pad = 20 * layout.u
        qr_img = build_qr(qr_url, int(qr_size)) if qr_url else None
        if qr_img is not None and ImageTk is not None:
            target = int(qr_size)
            if Image is not None and (qr_img.width != target or qr_img.height != target):
                qr_img = qr_img.resize((target, target), Image.Resampling.NEAREST)
            photo = ImageTk.PhotoImage(qr_img)
            self._qr_ref = photo
            self._photo_refs.append(photo)
            self.track(self.canvas.create_image(
                qr_x0 + plate / 2,
                qr_y0 + pad + qr_size / 2,
                image=photo,
            ))
        qrl_font = self._u_font(mono=False, size_u=21)
        self.track(self.canvas.create_text(
            qr_x0 + plate / 2,
            qr_y0 + plate - 14 * layout.u,
            anchor="s", text="Scan to open", fill="#12161f", font=qrl_font,
        ))

    def _paint_bar_portrait(
        self,
        *,
        mode: str,
        index: int,
        total: int,
        uploaded_at,
        caption: str,
        qr_url: str,
        build_qr,
        dwell_ms: int,
        status_text: str,
    ):
        layout = self._layout
        assert layout
        accent = self._accent
        bx0, by0, bx1, by1 = layout.bar
        self._paint_rail(
            mode=mode, index=index, total=total, dwell_ms=dwell_ms, accent=accent,
        )

        bin_top = by0 + 32 * layout.u
        bin_left = bx0 + 40 * layout.u
        bin_right = bx1 - 40 * layout.u
        bin_bottom = by1 - 27 * layout.u
        bin_cy = (bin_top + bin_bottom) / 2

        plate = layout.qr_plate
        qr_x1 = bin_right
        qr_x0 = qr_x1 - plate
        left_right = qr_x0 - 24 * layout.u

        eyeb_font = self._u_font(mono=True, size_u=22)
        primary_font = self._u_font(mono=False, size_u=36)
        status_font = self._u_font(mono=True, size_u=24)
        eyebrow, primary = self._meta_strings(mode, uploaded_at, caption)

        self.track(self.canvas.create_text(
            bin_left, bin_cy - 40 * layout.u, anchor="w", text=eyebrow,
            fill="#8a93a0", font=eyeb_font,
        ))
        max_primary_w = max(40, left_right - bin_left)
        display_primary = primary
        while self._measure(primary_font, display_primary) > max_primary_w and len(display_primary) > 4:
            display_primary = display_primary[:-2].rstrip() + "…"
        self.track(self.canvas.create_text(
            bin_left, bin_cy, anchor="w", text=display_primary,
            fill="#ffffff", font=primary_font,
        ))
        self._status_id = self.canvas.create_text(
            bin_left, bin_cy + 40 * layout.u, anchor="w", text=status_text,
            fill=accent, font=status_font,
        )
        self.track(self._status_id)
        self._paint_qr_plate(qr_x0, bin_cy - plate / 2, plate, layout.qr_size, qr_url, build_qr)

    def _paint_bar_landscape(
        self,
        *,
        mode: str,
        index: int,
        total: int,
        uploaded_at,
        caption: str,
        qr_url: str,
        build_qr,
        dwell_ms: int,
        status_text: str,
    ):
        """Right sidebar: meta at top, QR plate pinned to the bottom (§11.4)."""
        layout = self._layout
        assert layout
        accent = self._accent
        bx0, by0, bx1, by1 = layout.bar
        self._paint_rail(
            mode=mode, index=index, total=total, dwell_ms=dwell_ms, accent=accent,
        )

        pad = 20 * layout.u
        plate = layout.qr_plate
        qr_x0 = bx0 + (bx1 - bx0 - plate) / 2
        qr_y0 = by1 - pad - plate

        eyeb_font = self._u_font(mono=True, size_u=22)
        primary_font = self._u_font(mono=False, size_u=36)
        status_font = self._u_font(mono=True, size_u=24)
        eyebrow, primary = self._meta_strings(mode, uploaded_at, caption)

        text_x = bx0 + pad
        text_w = max(40, bx1 - bx0 - pad * 2)
        cursor = by0 + pad
        self.track(self.canvas.create_text(
            text_x, cursor, anchor="nw", text=eyebrow,
            fill="#8a93a0", font=eyeb_font, width=text_w,
        ))
        cursor += self._linespace(eyeb_font) + 10 * layout.u
        display_primary = primary
        while self._measure(primary_font, display_primary) > text_w and len(display_primary) > 4:
            display_primary = display_primary[:-2].rstrip() + "…"
        self.track(self.canvas.create_text(
            text_x, cursor, anchor="nw", text=display_primary,
            fill="#ffffff", font=primary_font, width=text_w,
        ))
        cursor += self._linespace(primary_font) + 12 * layout.u
        self._status_id = self.canvas.create_text(
            text_x, cursor, anchor="nw", text=status_text,
            fill=accent, font=status_font, width=text_w,
        )
        self.track(self._status_id)
        self._paint_qr_plate(qr_x0, qr_y0, plate, layout.qr_size, qr_url, build_qr)

    def _animate_rail(self, token: int, x0, x1, y0, h, dwell_ms: int):
        """Drain left→right remaining (1.0 full → 0.0 empty)."""
        fill_id = self._rail_fill_id
        if fill_id is None or token != self._rail_token or dwell_ms <= 0:
            return
        steps = max(1, int(dwell_ms / 33))
        width = x1 - x0
        state = {"i": 0}

        def tick():
            if fill_id != self._rail_fill_id or token != self._rail_token:
                return
            state["i"] += 1
            remaining = max(0.0, 1.0 - state["i"] / steps)
            try:
                self.canvas.coords(fill_id, x0, y0, x0 + width * remaining, y0 + h)
            except Exception:
                return
            if remaining > 0.0:
                self.canvas.after(33, tick)

        tick()

    def _animate_rail_vertical(self, token: int, x0, x1, y0, y1, dwell_ms: int):
        """Drain top→bottom remaining so the accent length matches NEXT IN Xs."""
        fill_id = self._rail_fill_id
        if fill_id is None or token != self._rail_token or dwell_ms <= 0:
            return
        steps = max(1, int(dwell_ms / 33))
        height = y1 - y0
        state = {"i": 0}

        def tick():
            if fill_id != self._rail_fill_id or token != self._rail_token:
                return
            state["i"] += 1
            remaining = max(0.0, 1.0 - state["i"] / steps)
            try:
                self.canvas.coords(fill_id, x0, y0, x1, y0 + height * remaining)
            except Exception:
                return
            if remaining > 0.0:
                self.canvas.after(33, tick)

        tick()

    def set_status(self, text: str):
        if self._status_id is None:
            return
        try:
            self.canvas.itemconfigure(self._status_id, text=text, fill=self._accent)
        except Exception:
            pass
