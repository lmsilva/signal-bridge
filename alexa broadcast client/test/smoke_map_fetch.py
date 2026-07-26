"""Manual smoke test: exercises the shared map-tile fetch/stitch helpers without Tk.

Usage: .venv\\Scripts\\python.exe test\\smoke_map_fetch.py [lat] [lon]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src import map_tiles


def main():
    lat = float(sys.argv[1]) if len(sys.argv) > 1 else 40.3327
    lon = float(sys.argv[2]) if len(sys.argv) > 2 else -111.9054
    image = map_tiles.fetch_map_tiles(lat, lon, 15, 512, 384)
    print(f"OK: stitched map {image.size[0]}x{image.size[1]} for {lat},{lon}")
    print(f"unverified-ssl fallback used: {map_tiles._unverified_ssl}")


if __name__ == "__main__":
    main()
