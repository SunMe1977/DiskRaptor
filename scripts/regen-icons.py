#!/usr/bin/env python3
"""Regenerate the Tauri PNG icon set from a square master image.

The committed 32x32/128x128/128x128@2x/512 PNGs had fully transparent pixels
(only `icon.ico`/`icon.icns` carried the artwork), which made every MSIX logo
asset generated from `icon.png` blank - Microsoft Store package validation
rejects blank image assets.

Usage:
    python scripts/regen-icons.py [master.png]

Defaults to `frontend/images/logo6_original.png` (1024x1024). Writes into
`src-tauri/icons/`; `icon.ico`/`icon.icns` are generated separately by
`npx tauri icon` and are not touched here.
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "src-tauri", "icons")

TARGETS = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
}


def fail(msg: str) -> "None":
    print(f"[regen-icons] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> int:
    master = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        ROOT, "frontend", "images", "logo6_original.png"
    )
    if not os.path.isfile(master):
        fail(f"master image not found: {master}")

    img = Image.open(master).convert("RGBA")
    if img.width != img.height:
        fail(f"master image must be square, got {img.width}x{img.height}")
    if img.getchannel("A").getbbox() is None:
        fail("master image is fully transparent")

    for name, size in TARGETS.items():
        out = img.resize((size, size), Image.LANCZOS)
        path = os.path.join(ICONS, name)
        out.save(path, "PNG", optimize=True)
        print(f"[regen-icons] wrote {name} ({size}x{size}, {os.path.getsize(path)} bytes)")

    print(f"[regen-icons] done from {os.path.relpath(master, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
