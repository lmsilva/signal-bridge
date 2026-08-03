#!/usr/bin/env python3
"""
Trivia category artwork generator.

Direction: "instrument plots". Each category is a near-black field carrying one
geometric system drawn as fine luminous linework with additive bloom - a readout
from an instrument rather than a photograph. One hue per category, no secondary
decoration. Every output is validated to stay under a luminance ceiling so white
display type clears 4.5:1 anywhere on the card.

Deterministic: same seed -> same art. Regenerate freely.
"""

import json
import math
import os
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 1  # linework is drawn at output res; bloom does the softening
TARGET_CONTRAST = 5.2
FIELD_SHARE = 0.66
CONTRAST_FLOOR = 5.05  # verified on the encoded file, not the buffer  # share of the luminance budget reserved for the colour field  # every card is normalised to exactly this vs #FFF

# --------------------------------------------------------------------------
# Category table: canonical id, label, hue (deg), family
# --------------------------------------------------------------------------
CATEGORIES = [
    # canonical_id,        label,                    pattern,          background, tone
    ("general-knowledge",     "General Knowledge",       "compass",         "#003F71", 0.8),
    ("books",                 "Books",                   "textblocks",      "#623000", 0.8),
    ("film",                  "Film",                    "sprockets",       "#8F0043", 0.9),
    ("music",                 "Music",                   "waveform",        "#7A2396", 0.97),
    ("musicals-theatre",      "Musicals & Theatre",      "stagelights",     "#730047", 0.75),
    ("television",            "Television",              "scanlines",       "#321785", 0.65),
    ("video-games",           "Video Games",             "isogrid",         "#005D56", 1.0),
    ("board-games",           "Board Games",             "hexfield",        "#8C3300", 1.0),
    ("science-nature",        "Science & Nature",        "branching",       "#00582A", 0.95),
    ("computers",             "Computers",               "circuit",         "#005362", 0.95),
    ("mathematics",           "Mathematics",             "lissajous",       "#3F41B2", 1.0),
    ("mythology",             "Mythology",               "sunburst",        "#614700", 0.95),
    ("sports",                "Sports",                  "courtarcs",       "#2A4A00", 0.85),
    ("geography",             "Geography",               "contours",        "#003829", 0.65),
    ("history",               "History",                 "strata",          "#3F2700", 0.6),
    ("politics",              "Politics",                "chamber",         "#002966", 0.6),
    ("art",                   "Art",                     "ribbons",         "#9C0018", 0.95),
    ("celebrities",           "Celebrities",             "starfield",       "#413A00", 0.75),
    ("animals",               "Animals",                 "cells",           "#003A01", 0.65),
    ("vehicles",              "Vehicles",                "speedlines",      "#002E40", 0.57),
    ("comics",                "Comics",                  "halftone",        "#67001F", 0.65),
    ("gadgets",               "Gadgets",                 "exploded",        "#004044", 0.75),
    ("anime-manga",           "Anime & Manga",           "radialburst",     "#8F0072", 0.95),
    ("cartoons",              "Cartoons",                "bounce",          "#4D5500", 1.0),
    ("food-drink",            "Food & Drink",            "concentricpour",  "#6D0D00", 0.7),
    ("society-culture",       "Society & Culture",       "network",         "#5B005C", 0.65),
]


_lin = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
_SRGB_LUT = np.where(_lin <= 0.0031308, _lin * 12.92,
                     1.055 * np.power(np.maximum(_lin, 1e-8), 1 / 2.4) - 0.055
                     ).astype(np.float32)
_GRID_CACHE = {}


def _grid(W, H):
    key = (W, H)
    if key not in _GRID_CACHE:
        yy, xx = np.mgrid[0:H, 0:W]
        _GRID_CACHE[key] = (xx.astype(np.float32) / W, yy.astype(np.float32) / H)
    return _GRID_CACHE[key]


def accent_from_bg(bg_hex):
    """Bright, high-chroma sibling of the background hue — used for the chip,
    the correct-answer fill and the countdown ring."""
    lin = hex_lin(bg_hex).astype(np.float64)
    M = np.array([[.4124, .3576, .1805], [.2126, .7152, .0722], [.0193, .1192, .9505]])
    wp = np.array([.95047, 1.0, 1.08883])
    xyz = (M @ lin) / wp
    f = np.where(xyz > .008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    a, b = 500 * (f[0] - f[1]), 200 * (f[1] - f[2])
    h = math.degrees(math.atan2(b, a))
    L = 74.0
    lo, hi = 0.0, 90.0
    for _ in range(40):
        mid = (lo + hi) / 2
        aa, bb = mid * math.cos(math.radians(h)), mid * math.sin(math.radians(h))
        fy = (L + 16) / 116
        ff = np.array([fy + aa / 500, fy, fy - bb / 200])
        x2 = np.where(ff ** 3 > .008856, ff ** 3, (ff - 16 / 116) / 7.787) * wp
        l2 = np.linalg.inv(M) @ x2
        if l2.min() >= -0.002 and l2.max() <= 1.002:
            lo = mid
        else:
            hi = mid
    aa, bb = lo * math.cos(math.radians(h)), lo * math.sin(math.radians(h))
    fy = (L + 16) / 116
    ff = np.array([fy + aa / 500, fy, fy - bb / 200])
    x2 = np.where(ff ** 3 > .008856, ff ** 3, (ff - 16 / 116) / 7.787) * wp
    l2 = np.clip(np.linalg.inv(M) @ x2, 0, 1)
    s = np.where(l2 <= .0031308, l2 * 12.92, 1.055 * l2 ** (1 / 2.4) - .055)
    return "#%02X%02X%02X" % tuple(int(round(v * 255)) for v in np.clip(s, 0, 1))


def hex_lin(h):
    """sRGB hex -> linear-light RGB."""
    h = h.lstrip("#")
    s = np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float32)
    return np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4).astype(np.float32)


def hue_to_rgb(h_deg, s, v):
    import colorsys
    r, g, b = colorsys.hsv_to_rgb((h_deg % 360) / 360.0, s, v)
    return np.array([r, g, b], dtype=np.float32)


# --------------------------------------------------------------------------
# Pattern painters. Each draws white linework into an ImageDraw at scale W,H.
# --------------------------------------------------------------------------

def p_compass(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.5
    for i in range(9):
        r = (0.08 + i * 0.085) * max(W, H)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=255, width=2)
    for i in range(32):
        a = i * math.pi / 16
        ln = max(W, H) * (0.86 if i % 4 == 0 else 0.5)
        d.line([cx, cy, cx + math.cos(a) * ln, cy + math.sin(a) * ln],
               fill=110 if i % 4 else 200, width=2)


def p_textblocks(d, W, H, rng):
    y = H * 0.06
    col_w = W * 0.72
    x0 = W * 0.14
    while y < H * 0.94:
        block = rng.randint(4, 11)
        for _ in range(block):
            w = col_w * rng.uniform(0.55, 1.0)
            d.line([x0, y, x0 + w, y], fill=190, width=3)
            y += H * 0.016
            if y > H * 0.94:
                break
        y += H * 0.030


def p_sprockets(d, W, H, rng):
    band = min(W, H) * 0.11
    for k in range(-2, int(max(W, H) / band) + 3):
        y = k * band * 1.9
        d.line([0, y, W, y + W * 0.28], fill=90, width=3)
        n = 26
        for i in range(n):
            t = i / n
            px = t * W
            py = y + px * 0.28
            s = band * 0.16
            d.rounded_rectangle([px - s, py - s, px + s, py + s],
                                radius=s * 0.35, outline=210, width=3)


def p_waveform(d, W, H, rng):
    for lane in range(7):
        cy = H * (0.10 + lane * 0.133)
        amp = H * 0.055 * rng.uniform(0.4, 1.0)
        f1, f2 = rng.uniform(3, 9), rng.uniform(11, 26)
        ph = rng.uniform(0, 6.28)
        pts = []
        for i in range(0, W + 1, 3):
            t = i / W
            env = math.sin(math.pi * t) ** 0.6
            v = (math.sin(t * f1 * 6.283 + ph) * 0.7
                 + math.sin(t * f2 * 6.283 + ph * 2) * 0.3)
            pts.append((i, cy + v * amp * env))
        d.line(pts, fill=210, width=3, joint="curve")


def p_stagelights(d, W, H, rng):
    sources = [(W * 0.5, -H * 0.06)]
    for sx, sy in sources:
        for i in range(26):
            a = math.radians(-88 + i * (176 / 25))
            spread = math.radians(2.0)
            ln = max(W, H) * 1.5
            p1 = (sx + math.sin(a - spread) * ln, sy + math.cos(a - spread) * ln)
            p2 = (sx + math.sin(a + spread) * ln, sy + math.cos(a + spread) * ln)
            d.polygon([(sx, sy), p1, p2], outline=None, fill=52)
            d.line([(sx, sy), ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)],
                   fill=150, width=2)


def p_scanlines(d, W, H, rng):
    step = max(4, int(H / 190))
    for i, y in enumerate(range(0, H, step)):
        v = 150 if i % 2 == 0 else 60
        d.line([0, y, W, y], fill=v, width=1)
    # a few dropout bands
    for _ in range(9):
        y = rng.uniform(0, H)
        h = rng.uniform(H * 0.004, H * 0.02)
        d.rectangle([0, y, W, y + h], fill=225)


def p_isogrid(d, W, H, rng):
    s = min(W, H) * 0.062
    dx, dy = s * math.cos(math.radians(30)), s * math.sin(math.radians(30))
    for i in range(-int(H / dy) - 4, int(W / dx) + 4):
        d.line([i * dx * 2, -H, i * dx * 2 + W * 2, H * 2], fill=120, width=2)
        d.line([i * dx * 2, H * 2, i * dx * 2 + W * 2, -H], fill=120, width=2)
    for i in range(int(H / (dy * 2)) + 2):
        d.line([0, i * dy * 2, W, i * dy * 2], fill=70, width=2)
    # a few filled voxels
    for _ in range(14):
        cx, cy = rng.uniform(0, W), rng.uniform(0, H)
        d.polygon([(cx, cy - dy), (cx + dx, cy), (cx, cy + dy), (cx - dx, cy)],
                  fill=190)


def p_hexfield(d, W, H, rng):
    r = min(W, H) * 0.055
    hstep = r * 1.5
    vstep = r * math.sqrt(3)
    for row in range(int(H / vstep) + 3):
        for col in range(int(W / hstep) + 3):
            cx = col * hstep
            cy = row * vstep + (vstep / 2 if col % 2 else 0)
            pts = [(cx + r * math.cos(math.radians(60 * k)),
                    cy + r * math.sin(math.radians(60 * k))) for k in range(6)]
            if rng.random() < 0.13:
                d.polygon(pts, fill=180)
            else:
                d.polygon(pts, outline=120)


def p_branching(d, W, H, rng):
    def branch(x, y, ang, ln, depth):
        if depth == 0 or ln < min(W, H) * 0.012:
            return
        x2 = x + math.cos(ang) * ln
        y2 = y + math.sin(ang) * ln
        d.line([x, y, x2, y2], fill=90 + depth * 22, width=max(1, depth))
        for s in (-1, 1):
            branch(x2, y2, ang + s * rng.uniform(0.28, 0.52),
                   ln * rng.uniform(0.62, 0.78), depth - 1)
    for i in range(4):
        branch(W * (0.16 + i * 0.24), H * 1.02, -math.pi / 2 + rng.uniform(-.3, .3),
               min(W, H) * 0.17, 7)


def p_circuit(d, W, H, rng):
    grid = min(W, H) * 0.038
    for _ in range(70):
        x = round(rng.uniform(0, W) / grid) * grid
        y = round(rng.uniform(0, H) / grid) * grid
        pts = [(x, y)]
        for _ in range(rng.randint(3, 9)):
            if rng.random() < 0.5:
                x += rng.choice([-1, 1]) * grid * rng.randint(1, 5)
            else:
                y += rng.choice([-1, 1]) * grid * rng.randint(1, 5)
            pts.append((x, y))
        d.line(pts, fill=130, width=2, joint="curve")
        vr = grid * 0.20
        d.ellipse([pts[-1][0] - vr, pts[-1][1] - vr,
                   pts[-1][0] + vr, pts[-1][1] + vr], fill=215)


def p_lissajous(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.5
    for k in range(6):
        a, b = rng.randint(2, 7), rng.randint(2, 7)
        ph = rng.uniform(0, 6.28)
        rx, ry = W * (0.20 + k * 0.052), H * (0.14 + k * 0.052)
        pts = []
        for i in range(721):
            t = i * math.pi / 360
            pts.append((cx + math.sin(a * t + ph) * rx, cy + math.sin(b * t) * ry))
        d.line(pts, fill=100 + k * 20, width=2, joint="curve")


def p_sunburst(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.42
    for i in range(64):
        a = i * math.pi / 32
        ln = max(W, H) * (0.95 if i % 2 == 0 else 0.62)
        d.line([cx, cy, cx + math.cos(a) * ln, cy + math.sin(a) * ln],
               fill=170 if i % 2 == 0 else 70, width=3 if i % 2 == 0 else 2)
    for i in range(7):
        r = min(W, H) * (0.10 + i * 0.075)
        d.arc([cx - r, cy - r, cx + r, cy + r], 0, 360, fill=190, width=3)


def p_courtarcs(d, W, H, rng):
    m = min(W, H)
    anchors = [(W * 0.5, -m * 0.12), (W * 0.5, H + m * 0.12),
               (-m * 0.1, H * 0.5), (W + m * 0.1, H * 0.5)]
    for ax, ay in anchors:
        for i in range(6):
            r = m * (0.20 + i * 0.11)
            d.arc([ax - r, ay - r, ax + r, ay + r], 0, 360, fill=125, width=3)
    d.line([0, H * 0.5, W, H * 0.5], fill=90, width=3)
    d.line([W * 0.5, 0, W * 0.5, H], fill=90, width=3)


def p_contours(d, W, H, rng):
    rw = 480
    rh = max(8, int(rw * H / W))
    gx, gy = np.meshgrid(np.linspace(0, 1, rw, dtype=np.float32),
                         np.linspace(0, 1, rh, dtype=np.float32))
    field = np.zeros_like(gx)
    for _ in range(6):
        px, py = rng.uniform(0, 1), rng.uniform(0, 1)
        amp = rng.uniform(0.5, 1.4) * rng.choice([-1, 1])
        sig = rng.uniform(0.10, 0.34)
        field += amp * np.exp(-(((gx - px) ** 2 + (gy - py) ** 2) / (2 * sig ** 2)))
    field = (field - field.min()) / (field.max() - field.min() + 1e-9)
    acc = np.zeros((rh, rw), dtype=np.float32)
    levels = 24
    for li in range(levels):
        band = np.abs(field - li / levels) < 0.0045
        acc = np.maximum(acc, band * (255.0 if li % 5 == 0 else 130.0))
    small = Image.fromarray(acc.astype(np.uint8)).filter(ImageFilter.MaxFilter(3))
    img = small.resize((W, H), Image.BILINEAR)
    d._image.paste(img, (0, 0), img)


def p_strata(d, W, H, rng):
    y = 0.0
    while y < H:
        th = H * rng.uniform(0.012, 0.055)
        pts_top, pts_bot = [], []
        f = rng.uniform(1.2, 3.4)
        ph = rng.uniform(0, 6.28)
        for i in range(0, W + 1, 6):
            t = i / W
            wob = math.sin(t * f * 6.283 + ph) * H * 0.012
            pts_top.append((i, y + wob))
            pts_bot.append((i, y + th + wob))
        d.line(pts_top, fill=190, width=3, joint="curve")
        if rng.random() < 0.45:
            d.line(pts_bot, fill=80, width=2, joint="curve")
        y += th + H * rng.uniform(0.01, 0.035)


def p_chamber(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.78
    for ring in range(9):
        r = min(W, H) * (0.16 + ring * 0.058)
        seats = 18 + ring * 5
        for i in range(seats + 1):
            a = math.pi + i * math.pi / seats
            x, y = cx + math.cos(a) * r, cy + math.sin(a) * r
            s = min(W, H) * 0.0075
            d.ellipse([x - s, y - s, x + s, y + s],
                      fill=200 if (i + ring) % 3 else 90)
        d.arc([cx - r, cy - r, cx + r, cy + r], 180, 360, fill=55, width=2)


def p_ribbons(d, W, H, rng):
    for k in range(9):
        x0, y0 = rng.uniform(-W * .2, W * 1.2), rng.uniform(-H * .1, H * 1.1)
        ang = rng.uniform(0, 6.283)
        pts = [(x0, y0)]
        curl = rng.uniform(-0.09, 0.09)
        for i in range(190):
            ang += curl + rng.uniform(-0.035, 0.035)
            x0 += math.cos(ang) * min(W, H) * 0.014
            y0 += math.sin(ang) * min(W, H) * 0.014
            pts.append((x0, y0))
        d.line(pts, fill=rng.randint(90, 205),
               width=rng.randint(3, 14), joint="curve")


def p_starfield(d, W, H, rng):
    for _ in range(1500):
        x, y = rng.uniform(0, W), rng.uniform(0, H)
        s = rng.uniform(0.4, 1.6) * min(W, H) * 0.0018
        d.ellipse([x - s, y - s, x + s, y + s], fill=rng.randint(45, 130))
    for _ in range(16):
        x, y = rng.uniform(W * .1, W * .9), rng.uniform(H * .1, H * .9)
        r = min(W, H) * rng.uniform(0.006, 0.014)
        d.ellipse([x - r, y - r, x + r, y + r], fill=245)
        for a in (0, math.pi / 2):
            ln = r * 7
            d.line([x - math.cos(a) * ln, y - math.sin(a) * ln,
                    x + math.cos(a) * ln, y + math.sin(a) * ln], fill=190, width=2)


def p_cells(d, W, H, rng):
    n = 46
    sx = np.array([rng.uniform(0, W) for _ in range(n)], dtype=np.float32)
    sy = np.array([rng.uniform(0, H) for _ in range(n)], dtype=np.float32)
    rw = 300
    rh = max(8, int(rw * H / W))
    GX, GY = np.meshgrid(np.linspace(0, W, rw, dtype=np.float32),
                         np.linspace(0, H, rh, dtype=np.float32))
    idx = np.argmin((GX[..., None] - sx) ** 2 + (GY[..., None] - sy) ** 2, axis=2)
    edge = np.zeros((rh, rw), dtype=bool)
    edge[:, :-1] |= idx[:, :-1] != idx[:, 1:]
    edge[:-1, :] |= idx[:-1, :] != idx[1:, :]
    small = Image.fromarray((edge * 185).astype(np.uint8))
    small = small.filter(ImageFilter.MaxFilter(3))
    img = small.resize((W, H), Image.BILINEAR)
    d._image.paste(img, (0, 0), img)


def p_speedlines(d, W, H, rng):
    vx, vy = W * 1.15, H * 0.46
    for _ in range(230):
        a = rng.uniform(0, 6.283)
        r0 = min(W, H) * rng.uniform(0.06, 1.5)
        r1 = r0 + min(W, H) * rng.uniform(0.06, 0.4)
        d.line([vx + math.cos(a) * r0, vy + math.sin(a) * r0,
                vx + math.cos(a) * r1, vy + math.sin(a) * r1],
               fill=rng.randint(60, 200), width=rng.randint(2, 5))


def p_halftone(d, W, H, rng):
    step = min(W, H) * 0.030
    rows = int(H / step) + 2
    cols = int(W / step) + 2
    for r in range(rows):
        for c in range(cols):
            x, y = c * step, r * step
            t = (x / W) * 0.6 + (y / H) * 0.4
            rad = step * 0.46 * (0.12 + 0.88 * (1 - t))
            if rad < 0.6:
                continue
            d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=175)


def p_exploded(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.5
    for i in range(9):
        s = min(W, H) * (0.06 + i * 0.028)
        off = min(W, H) * 0.052 * i
        x, y = cx + off * 0.65, cy - off * 0.42
        d.rounded_rectangle([x - s, y - s * 0.62, x + s, y + s * 0.62],
                            radius=s * 0.14, outline=145, width=3)
        if i:
            d.line([x - off * 0.65, y + off * 0.42, x, y], fill=70, width=2)
    for i in range(7):
        y = H * (0.08 + i * 0.13)
        d.line([W * 0.06, y, W * 0.20, y], fill=110, width=2)
        d.ellipse([W * 0.19, y - 4, W * 0.21, y + 4], fill=200)


def p_radialburst(d, W, H, rng):
    cx, cy = W * 0.5, H * 0.45
    for _ in range(320):
        a = rng.uniform(0, 6.283)
        r0 = min(W, H) * rng.uniform(0.10, 0.30)
        r1 = max(W, H) * rng.uniform(0.6, 1.2)
        w = rng.randint(2, 7)
        d.line([cx + math.cos(a) * r0, cy + math.sin(a) * r0,
                cx + math.cos(a) * r1, cy + math.sin(a) * r1],
               fill=rng.randint(70, 210), width=w)


def p_bounce(d, W, H, rng):
    for lane in range(5):
        y0 = H * (0.16 + lane * 0.18)
        x = -W * 0.05
        amp = H * 0.09 * rng.uniform(0.6, 1.2)
        span = W * rng.uniform(0.16, 0.26)
        while x < W * 1.05:
            pts = []
            for i in range(41):
                t = i / 40
                pts.append((x + t * span, y0 - math.sin(t * math.pi) * amp))
            d.line(pts, fill=150, width=3, joint="curve")
            r = min(W, H) * 0.016
            d.ellipse([x + span - r, y0 - r, x + span + r, y0 + r], outline=225, width=3)
            x += span
            amp *= 0.86


def p_concentricpour(d, W, H, rng):
    for k in range(5):
        cx = W * rng.uniform(0.15, 0.85)
        cy = H * rng.uniform(0.15, 0.85)
        for i in range(14):
            r = min(W, H) * (0.02 + i * 0.026) * rng.uniform(0.95, 1.05)
            d.ellipse([cx - r, cy - r * 0.92, cx + r, cy + r * 0.92],
                      outline=190 - i * 8, width=3)


def p_network(d, W, H, rng):
    n = 60
    nodes = [(rng.uniform(W * .04, W * .96), rng.uniform(H * .04, H * .96))
             for _ in range(n)]
    for i, (x, y) in enumerate(nodes):
        dists = sorted(range(n), key=lambda j: (nodes[j][0] - x) ** 2 + (nodes[j][1] - y) ** 2)
        for j in dists[1:4]:
            d.line([x, y, nodes[j][0], nodes[j][1]], fill=95, width=2)
    for x, y in nodes:
        r = min(W, H) * rng.uniform(0.004, 0.011)
        d.ellipse([x - r, y - r, x + r, y + r], fill=215)


PAINTERS = {k[len("p_"):]: v for k, v in list(globals().items()) if k.startswith("p_")}


# --------------------------------------------------------------------------
# Compositing
# --------------------------------------------------------------------------

def base_field(W, H, bg_hex, rng):
    """The category's own colour, washed from a deep corner to a fuller centre."""
    xx, yy = _grid(W, H)
    ax, ay = rng.uniform(0.18, 0.82), rng.uniform(0.12, 0.48)
    dist = np.sqrt((xx - ax) ** 2 + ((yy - ay) * (H / W if W > H else 1.0)) ** 2)
    dist = dist / (dist.max() + 1e-9)
    wash = 0.42 + 0.58 * (1.0 - dist) ** 1.7          # never fully dark

    bg = hex_lin(bg_hex)
    ink = bg * 0.10 + np.float32(0.0035)               # deep, still tinted
    return ink[None, None, :] + wash[..., None] * bg[None, None, :]


def render(cat_id, label, pattern, bg_hex, tone, accent_hex, W, H, seed):
    rng = random.Random(seed)
    np.random.seed(seed & 0xFFFFFFFF)

    # 1. linework mask, supersampled
    mw, mh = W * SS, H * SS
    mask_img = Image.new("L", (mw, mh), 0)
    d = ImageDraw.Draw(mask_img)
    d._image = mask_img
    PAINTERS[pattern](d, mw, mh, rng)
    mask_img = mask_img.resize((W, H), Image.LANCZOS)

    # 2. additive bloom: sharp core + three decreasing halos
    m = np.asarray(mask_img, dtype=np.float32) / 255.0
    glow = m * 1.00
    glow += np.asarray(mask_img.filter(ImageFilter.GaussianBlur(max(2, W // 340))),
                       dtype=np.float32) / 255.0 * 0.50
    for div, radius, weight in ((4, max(3, W // 440), 0.30),
                                (8, max(4, W // 270), 0.20)):
        small = mask_img.resize((W // div, H // div), Image.BILINEAR)
        small = small.filter(ImageFilter.GaussianBlur(radius))
        big = small.resize((W, H), Image.BILINEAR)
        glow = glow + np.asarray(big, dtype=np.float32) / 255.0 * weight

    # 3. composite in linear light — additive glow over a dark tinted wash
    glow = glow / (1.0 + glow * 0.65)          # shoulder: keeps cores in range

    target_lin = 1.05 / TARGET_CONTRAST - 0.05

    def _lum(a):
        return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]

    # The colour field gets a guaranteed share of the luminance budget, so a card
    # is never dragged to black by a few bright glow cores.
    field = base_field(W, H, bg_hex, rng)
    field_peak = target_lin * FIELD_SHARE * tone   # tone is what separates the cards
    fmax = float(_lum(field).max())                # by lightness as well as hue
    if fmax > 1e-6:
        field *= field_peak / fmax

    line_rgb = hex_lin(accent_hex)
    line_rgb = line_rgb / max(float(line_rgb.max()), 1e-6)
    lit = glow[..., None] * line_rgb[None, None, :]
    lmax = float(_lum(lit).max())
    if lmax > 1e-6:
        lit *= (target_lin - field_peak) / lmax
    out = field + lit
    del field, lit, glow

    # 4. vignette — pulls the edges down so overlaid chrome always sits on ink
    xx, yy = _grid(W, H)
    vx = (xx - 0.5) * 2
    vy = (yy - 0.5) * 2
    vig = 1.0 - 0.26 * np.clip((vx ** 2 * 0.55 + vy ** 2), 0, 1) ** 1.3
    out *= vig[..., None]
    del vx, vy, vig

    # 5. normalise brightness so the card sits exactly at TARGET_CONTRAST vs white.
    #    Scaling both up and down means every category is as legible as the others
    #    and none is needlessly dim.
    lum = 0.2126 * out[..., 0] + 0.7152 * out[..., 1] + 0.0722 * out[..., 2]
    peak = float(lum.max())
    if peak > 1e-6:
        out *= target_lin / peak
    out = np.clip(out, 0.0, 1.0)
    del lum

    # 6. encode sRGB via a lookup table (np.power on 6M elements is the bottleneck)
    idx16 = (out * 4095.0 + 0.5).astype(np.uint16)
    srgb = _SRGB_LUT[idx16]
    del idx16

    # 7. fine dither to kill banding in the wash
    srgb += (np.random.random((H, W)).astype(np.float32) - 0.5)[..., None] * (1.7 / 255.0)
    np.clip(srgb, 0.0, 1.0, out=srgb)

    img = Image.fromarray((srgb * 255 + 0.5).astype(np.uint8), "RGB")
    del srgb

    # 8. verify against the encoded result, not the intermediate
    arr = np.asarray(img, dtype=np.float32) / 255.0
    lin = np.where(arr <= 0.04045, arr / 12.92, ((arr + 0.055) / 1.055) ** 2.4)
    lum2 = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    worst = float(lum2.max())
    contrast = 1.05 / (worst + 0.05)
    return img, contrast


def measure(path):
    a = np.asarray(Image.open(path).convert("RGB"), dtype=np.float32) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    L = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
    return 1.05 / (float(L.max()) + 0.05)


def save_verified(img, path):
    """Lossy encoding can brighten a few pixels past the ceiling. Save, measure the
    real file, and darken-and-resave until the guarantee actually holds on disk."""
    img.save(path, quality=92, method=4)
    for _ in range(4):
        c = measure(path)
        if c >= CONTRAST_FLOOR:
            return c
        a = np.asarray(img, dtype=np.float32) / 255.0
        lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
        lin *= (1.05 / CONTRAST_FLOOR - 0.05) / (1.05 / c - 0.05) * 0.985
        s = np.where(lin <= 0.0031308, lin * 12.92,
                     1.055 * np.power(np.maximum(lin, 1e-8), 1 / 2.4) - 0.055)
        img = Image.fromarray((np.clip(s, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB")
        img.save(path, quality=92, method=4)
    return measure(path)


def main():
    import sys
    lo = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    hi = int(sys.argv[2]) if len(sys.argv) > 2 else len(CATEGORIES)
    root = "/home/claude/trivia-artwork"
    os.makedirs(root, exist_ok=True)
    mpath = os.path.join(root, "categories.json")
    manifest = json.load(open(mpath))["categories"] if os.path.exists(mpath) else []
    for idx, (cid, label, pattern, bg_hex, tone) in list(enumerate(CATEGORIES))[lo:hi]:
        accent_hex = accent_from_bg(bg_hex)
        entry = {
            "id": cid, "label": label, "pattern": pattern,
            "background": bg_hex, "tone": tone,
            "accent": accent_hex, "files": {}, "minContrastVsWhite": 99.0,
        }
        for orient, (W, H) in (("portrait", (1080, 1920)), ("landscape", (1920, 1080))):
            seed = 7919 * (idx + 1) + (13 if orient == "portrait" else 29)
            img, contrast = render(cid, label, pattern, bg_hex, tone, accent_hex, W, H, seed)
            name = f"{cid}-{orient}.webp"
            contrast = save_verified(img, os.path.join(root, name))
            entry["files"][orient] = name
            entry["minContrastVsWhite"] = round(
                min(entry["minContrastVsWhite"], contrast), 2)
        manifest = [m for m in manifest if m["id"] != cid] + [entry]
        print(f"{idx+1:2d}/26 {cid:22s} bg {bg_hex}  accent {entry['accent']}  "
              f"contrast {entry['minContrastVsWhite']}:1")

    order = {c[0]: i for i, c in enumerate(CATEGORIES)}
    manifest.sort(key=lambda m: order[m["id"]])
    with open(mpath, "w") as f:
        json.dump({
            "generated": "procedural",
            "licence": "Generated for this project. No third-party rights.",
            "targetContrastVsWhite": TARGET_CONTRAST,
            "categories": manifest,
        }, f, indent=2)
    print(f"\n{len(manifest)} categories, {len(manifest) * 2} images")


if __name__ == "__main__":
    main()
