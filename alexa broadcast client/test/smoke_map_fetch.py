"""Manual smoke test: exercises TeslaDashboardPanel map-tile fetching without Tk.

Usage: .venv\\Scripts\\python.exe test\\smoke_map_fetch.py [lat] [lon]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.display_panels import TeslaDashboardPanel


class _Harness(TeslaDashboardPanel):
    def __init__(self):
        # Skip BasePanel/Tk setup entirely; only the fetch helpers are exercised.
        pass


def main():
    lat = float(sys.argv[1]) if len(sys.argv) > 1 else 40.3327
    lon = float(sys.argv[2]) if len(sys.argv) > 2 else -111.9054
    harness = _Harness()
    image = harness._fetch_map_tiles(lat, lon, TeslaDashboardPanel.MAP_ZOOM, 512, 384)
    print(f"OK: stitched map {image.size[0]}x{image.size[1]} for {lat},{lon}")
    print(f"unverified-ssl fallback used: {TeslaDashboardPanel._MAP_UNVERIFIED_SSL}")


if __name__ == "__main__":
    main()
