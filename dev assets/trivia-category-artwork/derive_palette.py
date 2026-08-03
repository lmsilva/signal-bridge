"""Derive the 26 background colours in CIELAB LCh so separation is measured, not guessed."""
import numpy as np

M = np.array([[.4124, .3576, .1805], [.2126, .7152, .0722], [.0193, .1192, .9505]])
WP = np.array([.95047, 1.0, 1.08883])


def lab2rgb(L, C, h):
    a, b = C * np.cos(np.radians(h)), C * np.sin(np.radians(h))
    fy = (L + 16) / 116
    f = np.array([fy + a / 500, fy, fy - b / 200])
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * WP
    lin = np.linalg.inv(M) @ xyz
    s = np.where(lin <= 0.0031308, lin * 12.92,
                 1.055 * np.maximum(lin, 0) ** (1 / 2.4) - 0.055)
    return s


def best(L, h, cmax=70):
    """Highest in-gamut chroma at this lightness and hue."""
    lo, hi = 0.0, cmax
    for _ in range(40):
        mid = (lo + hi) / 2
        s = lab2rgb(L, mid, h)
        if s.min() >= -0.002 and s.max() <= 1.002:
            lo = mid
        else:
            hi = mid
    s = np.clip(lab2rgb(L, lo, h), 0, 1)
    return "#%02X%02X%02X" % tuple(int(round(v * 255)) for v in s)


#  category                hue°   L*   (L* tiers alternate within each family)
SPEC = [
    ("general-knowledge",   275,  26),
    ("politics",            290,  18),
    ("mathematics",         300,  34),
    ("television",          307,  20),
    ("music",               320,  33),
    ("society-culture",     328,  20),
    ("anime-manga",         338,  32),
    ("musicals-theatre",    350,  24),
    ("film",                  4,  30),
    ("comics",               18,  20),
    ("art",                  32,  32),
    ("food-drink",           40,  22),
    ("board-games",          52,  34),
    ("books",                62,  26),
    ("history",              74,  18),
    ("mythology",            84,  32),
    ("celebrities",          96,  24),
    ("cartoons",            108,  34),
    ("sports",              124,  28),
    ("animals",             138,  20),
    ("science-nature",      150,  32),
    ("geography",           168,  20),
    ("video-games",         186,  35),
    ("gadgets",             204,  24),
    ("computers",           224,  32),
    ("vehicles",            246,  17),
]

out = {c: best(L, h) for c, h, L in SPEC}
for c, h, L in SPEC:
    print(f'    ("{c}", "{out[c]}", {round(max(0.55,min(1.0,(L+6)/40)),2)}),')

# verify separation
def lab(hexs):
    s = np.array([int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    lin = np.where(s <= .04045, s / 12.92, ((s + .055) / 1.055) ** 2.4)
    xyz = (M @ lin) / WP
    f = np.where(xyz > .008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.array([116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])])

ks = list(out)
d = sorted((np.linalg.norm(lab(out[a]) - lab(out[b])), a, b)
           for i, a in enumerate(ks) for b in ks[i + 1:])
print("\nclosest pairs:")
for v, a, b in d[:5]:
    print(f"  {v:5.1f}  {a} / {b}")
print(f"median {np.median([x[0] for x in d]):.1f}")
