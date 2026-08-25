"""Crop a region out of a preview render so details can be inspected 1:1."""

import argparse
from pathlib import Path

from PIL import Image

parser = argparse.ArgumentParser()
parser.add_argument("image")
parser.add_argument("--box", required=True, help="x0,y0,x1,y1 in source pixels")
parser.add_argument("--out", default=None)
parser.add_argument("--zoom", type=float, default=1.0)
args = parser.parse_args()

source = Path(args.image)
box = tuple(int(value) for value in args.box.split(","))
image = Image.open(source).crop(box)
if args.zoom != 1.0:
    image = image.resize(
        (int(image.width * args.zoom), int(image.height * args.zoom)), Image.LANCZOS,
    )
out = Path(args.out) if args.out else source.with_name(f"{source.stem}-crop.png")
image.save(out)
print(f"wrote {out} ({image.width}x{image.height})")
