#!/bin/bash
# Generate application icons from a source PNG (1024x1024 recommended).
# Requires: imagemagick, iconutil (macOS), imagemagick (Windows .ico)
# Usage: bash make-icons.sh source.png

SRC="${1:-logo6_transparent.webp}"
OUT="../images"

if [ ! -f "$SRC" ]; then
  echo "Source not found: $SRC"
  echo "Usage: bash make-icons.sh <source-png>"
  exit 1
fi

echo "Generating icons from: $SRC"

# macOS .icns
if command -v iconutil &>/dev/null; then
  TMPDIR=$(mktemp -d)
  mkdir -p "$TMPDIR/icon.iconset"
  for s in 16 32 64 128 256 512 1024; do
    magick "$SRC" -resize "${s}x${s}" "$TMPDIR/icon.iconset/icon_${s}x${s}.png" 2>/dev/null
    if [ "$s" -le 512 ]; then
      s2=$((s*2))
      magick "$SRC" -resize "${s2}x${s2}" "$TMPDIR/icon.iconset/icon_${s}x${s}@2x.png" 2>/dev/null
    fi
  done
  iconutil -c icns "$TMPDIR/icon.iconset" -o "$OUT/icon.icns"
  rm -rf "$TMPDIR"
  echo "  ✓ icon.icns"
fi

# Windows .ico
if command -v magick &>/dev/null; then
  magick "$SRC" -resize 256x256 "$OUT/icon.ico"
  echo "  ✓ icon.ico"
fi

echo "Done."
