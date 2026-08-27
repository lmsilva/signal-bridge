"""Shared OpenStreetMap tile fetch/stitch/pixel-math helpers.

Originally private to `TeslaDashboardPanel` (single-point map centered on the
vehicle); extracted so `RoutePlannerPanel` can reuse the same fetch/cache/
SSL-fallback plumbing for a two-point "zoom to fit both places" map, plus
project a route line onto the stitched tile image.
"""
import io
import math
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

try:
    from PIL import Image, ImageEnhance
except ImportError:  # Pillow ships with the client, but degrade gracefully.
    Image = None
    ImageEnhance = None

TILE_SIZE = 256
USER_AGENT = "alexa-broadcast-client/1.0 (personal home display)"

# Frozen builds without a bundled CA store fail the default SSL context; once
# that happens for any tile fetch we remember it and skip straight to the
# unverified context for the rest of the process (module-level, shared by
# every caller — mirrors the previous per-class flag).
_unverified_ssl = False


def latlon_to_global_px(lat: float, lon: float, zoom: int):
    scale = TILE_SIZE * (1 << zoom)
    x = (lon + 180.0) / 360.0 * scale
    lat = max(-85.05112878, min(85.05112878, float(lat)))
    siny = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + siny) / (1 - siny)) / (4 * math.pi)) * scale
    return x, y


def global_px_to_latlon(x: float, y: float, zoom: int):
    """Inverse of `latlon_to_global_px` (standard slippy-map tile math)."""
    scale = TILE_SIZE * (1 << zoom)
    lon = x / scale * 360.0 - 180.0
    n = math.pi - 2 * math.pi * y / scale
    lat = math.degrees(math.atan(math.sinh(n)))
    return lat, lon


def zoom_to_fit(
    lat1: float, lon1: float, lat2: float, lon2: float,
    box_w: int, box_h: int,
    *, max_zoom: int = 15, min_zoom: int = 2, padding_frac: float = 0.15,
):
    """Largest zoom level (most zoomed-in) where both points still fit inside
    a `box_w` x `box_h` pixel box (with `padding_frac` breathing room), plus
    the pixel-accurate center point to fetch/crop the map around. Falls back
    to `min_zoom` for very long routes (e.g. cross-continental) rather than
    failing outright.
    """
    usable_w = max(1.0, box_w * (1 - padding_frac))
    usable_h = max(1.0, box_h * (1 - padding_frac))
    zoom = min_zoom
    for candidate in range(max_zoom, min_zoom - 1, -1):
        x1, y1 = latlon_to_global_px(lat1, lon1, candidate)
        x2, y2 = latlon_to_global_px(lat2, lon2, candidate)
        if abs(x2 - x1) <= usable_w and abs(y2 - y1) <= usable_h:
            zoom = candidate
            break

    x1, y1 = latlon_to_global_px(lat1, lon1, zoom)
    x2, y2 = latlon_to_global_px(lat2, lon2, zoom)
    center_lat, center_lon = global_px_to_latlon((x1 + x2) / 2, (y1 + y2) / 2, zoom)
    return zoom, center_lat, center_lon


def project_to_pixels(lat: float, lon: float, center_lat: float, center_lon: float, zoom: int, box_w: int, box_h: int):
    """Pixel position (relative to a `box_w` x `box_h` box's top-left corner)
    of `(lat, lon)` on a map fetched via `fetch_map_tiles(center_lat, center_lon, zoom, box_w, box_h)`.
    """
    center_x, center_y = latlon_to_global_px(center_lat, center_lon, zoom)
    left = center_x - box_w / 2
    top = center_y - box_h / 2
    x, y = latlon_to_global_px(lat, lon, zoom)
    return x - left, y - top


def project_points_to_pixels(points, center_lat: float, center_lon: float, zoom: int, box_w: int, box_h: int):
    return [project_to_pixels(lat, lon, center_lat, center_lon, zoom, box_w, box_h) for lat, lon in points]


def is_ssl_failure(error) -> bool:
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, ssl.SSLError):
            return True
        current = getattr(current, "reason", None) or getattr(current, "__cause__", None)
    return "CERTIFICATE_VERIFY_FAILED" in str(error) or "SSL" in str(error)


def map_tile_cache_dir():
    from src.paths import app_root

    return app_root() / "map-tiles"


def log_map_error(message: str):
    from src.paths import app_root

    line = f"{datetime.now().isoformat(timespec='seconds')} {message}"
    print(line, file=sys.stderr)
    try:
        log_path = app_root() / "map-errors.log"
        if log_path.exists() and log_path.stat().st_size > 200_000:
            log_path.unlink()
        with open(log_path, "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        pass


def fetch_map_tile(zoom: int, tx: int, ty: int):
    global _unverified_ssl

    cache_dir = map_tile_cache_dir()
    cache_file = cache_dir / f"{zoom}_{tx}_{ty}.png"
    if cache_file.exists():
        try:
            return Image.open(cache_file).convert("RGB")
        except OSError:
            pass

    url = f"https://tile.openstreetmap.org/{zoom}/{tx}/{ty}.png"
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})

    def download(context):
        with urllib.request.urlopen(request, timeout=8, context=context) as response:
            return response.read()

    last_error = None
    for _attempt in range(2):
        context = ssl._create_unverified_context() if _unverified_ssl else ssl.create_default_context()
        try:
            data = download(context)
        except Exception as error:
            # urllib wraps cert failures in URLError; unwrap before deciding.
            if not _unverified_ssl and is_ssl_failure(error):
                try:
                    data = download(ssl._create_unverified_context())
                    # Frozen builds without a CA bundle: remember the fallback.
                    _unverified_ssl = True
                except Exception as fallback_error:
                    last_error = fallback_error
                    time.sleep(0.4)
                    continue
            else:
                last_error = error
                time.sleep(0.4)
                continue
        try:
            cache_dir.mkdir(parents=True, exist_ok=True)
            cache_file.write_bytes(data)
        except OSError:
            pass
        return Image.open(io.BytesIO(data)).convert("RGB")
    raise last_error if last_error else RuntimeError("tile fetch failed")


def fetch_map_tiles(lat: float, lon: float, zoom: int, w: int, h: int):
    """Stitches, crops (to `w` x `h` centered on `lat`/`lon`) and dark-tones a
    map image from cached/downloaded OSM tiles.
    """
    center_x, center_y = latlon_to_global_px(lat, lon, zoom)
    left = int(center_x - w / 2)
    top = int(center_y - h / 2)
    tile_x0, tile_y0 = left // TILE_SIZE, top // TILE_SIZE
    tile_x1, tile_y1 = (left + w) // TILE_SIZE, (top + h) // TILE_SIZE
    stitched = Image.new(
        "RGB",
        ((tile_x1 - tile_x0 + 1) * TILE_SIZE, (tile_y1 - tile_y0 + 1) * TILE_SIZE),
        (10, 17, 30),
    )
    max_tile = (1 << zoom) - 1
    span = max_tile + 1
    # Longitude wraps: a trans-Pacific great circle runs past ±180, and clamping
    # those columns away left half the map as empty navy. Y never wraps.
    coords = [
        (tx, ty)
        for tx in range(tile_x0, tile_x1 + 1)
        for ty in range(tile_y0, tile_y1 + 1)
        if 0 <= ty <= max_tile
    ]
    fetched = 0
    last_error = None
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(fetch_map_tile, zoom, tx % span, ty): (tx, ty) for tx, ty in coords}
        for future, (tx, ty) in futures.items():
            try:
                tile = future.result()
            except Exception as error:
                last_error = error
                log_map_error(f"map tile {zoom}/{tx % span}/{ty} failed: {error!r}")
                continue
            stitched.paste(tile, ((tx - tile_x0) * TILE_SIZE, (ty - tile_y0) * TILE_SIZE))
            fetched += 1
    if not fetched:
        raise RuntimeError(f"no map tiles could be downloaded ({last_error!r})")
    crop_left = left - tile_x0 * TILE_SIZE
    crop_top = top - tile_y0 * TILE_SIZE
    image = stitched.crop((crop_left, crop_top, crop_left + w, crop_top + h))
    # Tone the map toward the dark theme while keeping streets clearly readable.
    image = ImageEnhance.Color(image).enhance(0.75)
    image = ImageEnhance.Contrast(image).enhance(1.12)
    image = ImageEnhance.Brightness(image).enhance(0.88)
    navy = Image.new("RGB", image.size, (16, 27, 48))
    return Image.blend(image, navy, 0.12)
