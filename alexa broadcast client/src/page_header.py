"""Shared 3-column page header (design-system §1.7 / shared-photos §2).

Import once — do not reimplement per panel.
"""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont
from typing import Callable

from src.design_system import (
    ACCENT,
    CARD_LO,
    INK,
    PX_PER_POINT,
    design_u,
    mix,
    paint_round_rect,
)


def _font_spec(family: str, size: int, *, weight: str = "normal") -> tuple:
    if weight == "bold" or weight == "500":
        # Spec allows 400 and 500 only; Tk maps medium → bold on many faces.
        return (family, size, "bold")
    return (family, size)


def _tk_font(font_spec) -> tkfont.Font:
    return tkfont.Font(
        family=font_spec[0],
        size=font_spec[1],
        weight="bold" if len(font_spec) > 2 else "normal",
    )


def _measure(font_spec, text: str) -> int:
    # Fall back in *px*: font sizes are points, so an estimate that forgets the
    # px-per-point ratio draws a pill narrower than the glyphs it must hold.
    try:
        return int(_tk_font(font_spec).measure(text))
    except Exception:
        size = font_spec[1] if len(font_spec) > 1 else 16
        return int(len(text) * size * PX_PER_POINT * 0.62)


def _linespace(font_spec) -> int:
    try:
        return int(_tk_font(font_spec).metrics("linespace"))
    except Exception:
        size = font_spec[1] if len(font_spec) > 1 else 16
        return int(size * PX_PER_POINT)


def _stack_column(
    canvas: tk.Canvas,
    *,
    x: float,
    cy: float,
    u: float,
    label: str,
    value: str,
    label_font,
    value_font,
    label_fill: str,
    value_fill: str,
    anchor_e: bool,
    add: Callable[[int], int],
):
    """Label above value with 4u gap — never overlapping (HTML `.lb` + `.hv`)."""
    gap = 4 * u
    lab = (label or "").upper()
    val = value or ""
    lab_h = _linespace(label_font) if lab else 0
    val_h = _linespace(value_font) if val else 0
    if not lab and not val:
        return
    block_h = lab_h + (gap if lab and val else 0) + val_h
    top = cy - block_h / 2
    anchor = "ne" if anchor_e else "nw"
    y = top
    if lab:
        add(canvas.create_text(
            x, y, anchor=anchor, text=lab, fill=label_fill, font=label_font,
        ))
        y += lab_h + gap
    if val:
        add(canvas.create_text(
            x, y, anchor=anchor, text=val, fill=value_fill, font=value_font,
        ))


def pill_frame(
    text: str, *, mid_x: float, cy: float, u: float, text_w: float, text_h: float,
) -> tuple[float, float, float, float]:
    """Rounded frame around the page title, sized from the *painted* string.

    Font sizes are points and the box is px, so a box sized from the point
    size clips the caps once Windows display scaling stretches the glyphs.
    """
    pad_x, pad_y = 26 * u, 8 * u
    width = max(0.0, float(text_w)) + pad_x * 2
    height = max(max(18 * u, float(text_h)) + pad_y * 2, 36 * u)
    return (mid_x - width / 2, cy - height / 2, mid_x + width / 2, cy + height / 2)


def paint_page_header(
    canvas: tk.Canvas,
    *,
    screen_w: int,
    screen_h: int,
    pill: str,
    left_label: str = "",
    left_value: str = "",
    right_label: str = "",
    right_value: str = "",
    track: Callable[[int], int] | None = None,
    sans_family: str = "Segoe UI",
    mono_family: str = "Consolas",
    y0: float | None = None,
) -> list[int]:
    """Draw the shared header. Returns canvas item ids."""
    u = design_u(screen_w, screen_h)
    portrait = screen_h >= screen_w
    margin_x = (40 if portrait else 60) * u
    header_top = (32 if portrait else 28) * u if y0 is None else float(y0)
    header_h = 84 * u
    x0 = margin_x
    x1 = screen_w - margin_x
    cy = header_top + header_h / 2
    mid_x = screen_w / 2

    lab_font = _font_spec(mono_family, max(10, int(round(20 * u))))
    val_font = _font_spec(sans_family, max(12, int(round(32 * u))), weight="500")
    pill_font = _font_spec(mono_family, max(11, int(round(24 * u))))

    ids: list[int] = []

    def add(item_id: int) -> int:
        ids.append(item_id)
        if track:
            track(item_id)
        return item_id

    _stack_column(
        canvas,
        x=x0,
        cy=cy,
        u=u,
        label=left_label,
        value=left_value,
        label_font=lab_font,
        value_font=val_font,
        label_fill=ACCENT,
        value_fill=INK,
        anchor_e=False,
        add=add,
    )

    pill_text = (pill or "").upper()
    border = max(1, int(round(2 * u)))
    pill_box = pill_frame(
        pill_text, mid_x=mid_x, cy=cy, u=u,
        text_w=_measure(pill_font, pill_text),
        text_h=_linespace(pill_font),
    )
    bh = pill_box[3] - pill_box[1]
    add(paint_round_rect(
        canvas, pill_box, radius=bh / 2,
        fill=mix(CARD_LO, ACCENT, 0.08), outline=mix("#a8b0bc", ACCENT, 0.45), width=border,
    ))
    add(canvas.create_text(
        mid_x, cy, anchor="center", text=pill_text, fill=INK, font=pill_font,
    ))

    _stack_column(
        canvas,
        x=x1,
        cy=cy,
        u=u,
        label=right_label,
        value=right_value,
        label_font=lab_font,
        value_font=val_font,
        label_fill=ACCENT,
        value_fill=INK,
        anchor_e=True,
        add=add,
    )

    return ids
