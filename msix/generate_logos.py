#!/usr/bin/env python3
"""Generate the MSIX logo assets from the app's master icon.

Usage: python generate_logos.py <source_icon.png> <output_dir>
"""
import os
import sys
from PIL import Image

LOGO_SIZES = {
    "Square44x44Logo.png": (44, 44),
    "Square71x71Logo.png": (71, 71),
    "Square150x150Logo.png": (150, 150),
    "Square310x310Logo.png": (310, 310),
    "Wide310x150Logo.png": (310, 150),
    "Logo.png": (150, 150),
}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src = sys.argv[1]
    out_dir = sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)

    img = Image.open(src).convert("RGBA")

    # Pad square artwork so wide/tall targets keep the artwork centered on a
    # transparent background (matches how Windows renders packaged logos).
    for name, (w, h) in LOGO_SIZES.items():
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        side = min(w, h)
        art = img.resize((side, side), Image.LANCZOS)
        canvas.paste(art, ((w - side) // 2, (h - side) // 2), art)
        canvas.save(os.path.join(out_dir, name))
        print(f"  wrote {name} ({w}x{h})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
