"""Display design-system tokens and geometry (1080×1920 / 1920×1080).

`--u` uses vmin so 1 design px is the same physical size in both orientations
(see display-design-system.md §1.5).
"""

from __future__ import annotations

from dataclasses import dataclass


# --- Colour tokens -----------------------------------------------------------
BG = "#0B1730"
BG_LIFT = "#16294F"  # optional top wash
INK = "#F2F7FF"
INK_2 = "#A4ACC0"  # ≈ rgba(242,247,255,.68) on dark
INK_3 = "#6B7388"  # ≈ rgba(242,247,255,.42)
ACCENT = "#5FD0FF"
GOOD = "#6EE7A8"
WARN = "#F5C453"
ALERT = "#FF7A6B"
LINE = "#264060"  # ≈ rgba(150,200,255,.18)
FILL = "#141F35"  # ≈ rgba(255,255,255,.045) over BG
CARD = FILL
CARD_EDGE = LINE
CONTAINER = BG
# Timer rings — muted arc for non-soonest; track under every ring.
MUTE_ARC = "#606878"  # ≈ rgba(255,255,255,.35) on BG
RING_TRACK = "#232E45"  # ≈ rgba(255,255,255,.10) on BG

# Steam-specific (steam-panel-redesign-spec §8)
STEAM_BG = "#08183A"
STEAM_STAGE_BG = "#061230"
STEAM_INK_DIM = "#B8C8E0"  # ≈ rgba(226,238,255,.80)
STEAM_INK_MUTED = "#8FB6E8"
STEAM_LINE = "#4A6A8A"
STEAM_TAG_BG = "#1A3A5C"
STEAM_TAG_BORDER = "#4A78A0"

# Shared photos print border
PRINT_BORDER = "#F4F2ED"


@dataclass(frozen=True)
class PageChrome:
    """Shared page frame geometry in screen px."""

    u: float
    portrait: bool
    screen_w: int
    screen_h: int
    margin_x: float
    content_w: float
    content_x: float
    header_top: float
    header_h: float
    content_top: float
    content_bottom: float  # exclusive of dismiss footer
    footer_h: float


def design_u(screen_w: int, screen_h: int) -> float:
    """`--u: calc(100vmin / 1080)`."""
    screen_w = max(64, int(screen_w))
    screen_h = max(64, int(screen_h))
    return min(screen_w, screen_h) / 1080.0


def is_portrait(screen_w: int, screen_h: int) -> bool:
    return int(screen_h) >= int(screen_w)


def footer_band_h(u: float) -> float:
    # Keep in sync with dismiss_footer.BAND_H_U (compact chrome strip).
    return 64 * u


def page_chrome(screen_w: int, screen_h: int, *, timed: bool = True) -> PageChrome:
    """Shared header + content zone + optional dismiss footer."""
    u = design_u(screen_w, screen_h)
    portrait = is_portrait(screen_w, screen_h)
    footer_h = footer_band_h(u) if timed else 0.0
    if portrait:
        margin_x = 40 * u
        content_w = 1000 * u
        header_top = 32 * u
        header_h = 84 * u
        content_top = 136 * u
        # Design: content 136–1824 when footer present.
        content_bottom = screen_h - footer_h
    else:
        margin_x = 60 * u
        content_w = 1800 * u
        header_top = 28 * u
        header_h = 84 * u
        content_top = 132 * u
        content_bottom = screen_h - footer_h
    content_x = (screen_w - content_w) / 2
    return PageChrome(
        u=u,
        portrait=portrait,
        screen_w=screen_w,
        screen_h=screen_h,
        margin_x=margin_x,
        content_w=content_w,
        content_x=content_x,
        header_top=header_top,
        header_h=header_h,
        content_top=content_top,
        content_bottom=content_bottom,
        footer_h=footer_h,
    )


def approx_rgba_white(alpha: float, *, on: str = BG) -> str:
    """Blend white over `on` for Tk (no real alpha fills)."""
    a = max(0.0, min(1.0, float(alpha)))
    on = (on or BG).lstrip("#")
    if len(on) != 6:
        on = "0B1730"
    br, bg, bb = int(on[0:2], 16), int(on[2:4], 16), int(on[4:6], 16)
    r = int(round(br * (1 - a) + 255 * a))
    g = int(round(bg * (1 - a) + 255 * a))
    b = int(round(bb * (1 - a) + 255 * a))
    return f"#{r:02x}{g:02x}{b:02x}"
