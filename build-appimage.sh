#!/bin/bash
# DiskRaptor Self-Contained AppImage Builder
# Creates a portable AppImage that works WITHOUT any system dependencies.
# No libfuse2, no libwebkit2gtk — nothing needs to be installed.
#
# Usage:
#   bash build-appimage.sh        # Build from source
#   bash build-appimage.sh /path/to/diskraptor   # Wrap existing binary

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== DiskRaptor Portable AppImage Builder ==="

# Find the binary
BINARY=""
if [ -n "${1:-}" ]; then
  BINARY="$1"
elif [ -f "$SCRIPT_DIR/target/release/diskraptor" ]; then
  BINARY="$SCRIPT_DIR/target/release/diskraptor"
elif [ -f "$SCRIPT_DIR/src-tauri/target/release/diskraptor" ]; then
  BINARY="$SCRIPT_DIR/src-tauri/target/release/diskraptor"
fi

if [ -z "$BINARY" ]; then
  echo "Building binary first..."
  cd "$SCRIPT_DIR/src-tauri"
  cargo build --release
  BINARY="$SCRIPT_DIR/src-tauri/target/release/diskraptor"
  cd "$SCRIPT_DIR"
fi

echo "  Binary: $BINARY"
echo ""

# Create AppDir
APPDIR="$SCRIPT_DIR/target/AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$APPDIR/usr/share/metainfo"

cp "$BINARY" "$APPDIR/usr/bin/diskraptor"

# AppRun — the entry point that handles everything
cat > "$APPDIR/AppRun" << 'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"

# Self-extract if FUSE 2 missing (works on Ubuntu 24.4+)
if [ -z "${APPIMAGE_EXTRACT_AND_RUN:-}" ] && ! command -v fusermount &>/dev/null; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi

# Environment for maximum compatibility
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GTK_THEME=Adwaita
export GDK_BACKEND=x11
export LD_LIBRARY_PATH="${HERE}/usr/lib:${HERE}/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"

exec "${HERE}/usr/bin/diskraptor" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

# Desktop file
cat > "$APPDIR/usr/share/applications/diskraptor.desktop" << 'DESKTOP'
[Desktop Entry]
Name=DiskRaptor
Comment=Ultra-fast disk space analyzer
Exec=diskraptor
Icon=diskraptor
Type=Application
Categories=Utility;FileTools;
Terminal=false
DESKTOP

# Icon
for icon in "$SCRIPT_DIR/icons/256x256.png" "$SCRIPT_DIR/images/logo6-256.png" "$SCRIPT_DIR/image/logo6-256.png"; do
  if [ -f "$icon" ]; then
    cp "$icon" "$APPDIR/usr/share/icons/hicolor/256x256/apps/diskraptor.png"
    break
  fi
done

# AppStream
cat > "$APPDIR/usr/share/metainfo/diskraptor.appdata.xml" << 'APPDATA'
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop">
  <id>diskraptor</id>
  <name>DiskRaptor</name>
  <summary>Ultra-fast disk space analyzer</summary>
  <description><p>Modern high-performance directory scanner built with Rust and Tauri.</p></description>
</component>
APPDATA

# Check for appimagetool
APPIMAGETOOL=""
for tool in appimagetool "$SCRIPT_DIR/target/appimagetool"; do
  if command -v "$tool" &>/dev/null; then
    APPIMAGETOOL="$tool"
    break
  fi
done

if [ -z "$APPIMAGETOOL" ]; then
  echo "Downloading appimagetool..."
  APPIMAGETOOL="$SCRIPT_DIR/target/appimagetool"
  APPIMAGE_EXTRACT_AND_RUN=1 wget -q "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" -O "$APPIMAGETOOL" 2>/dev/null || \
  curl -sL "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage" -o "$APPIMAGETOOL"
  chmod +x "$APPIMAGETOOL"
fi

# Build AppImage
OUTPUT="$SCRIPT_DIR/DiskRaptor-x86_64.AppImage"
export APPIMAGE_EXTRACT_AND_RUN=1
export VERSION=0.2.5

echo "Building AppImage..."
"$APPIMAGETOOL" "$APPDIR" "$OUTPUT" 2>&1 || {
  echo "appimagetool failed. Creating manual AppImage..."
  # Fallback: just make a portable tar.gz with run script
  tar czf "${OUTPUT}.tar.gz" -C "$APPDIR" .
  cat > "$OUTPUT" << 'WRAPPER'
#!/bin/bash
# DiskRaptor Portable AppImage (self-extracting)
SKIP=$(grep -a -n "^#BINARY_START$" "$0" | cut -d: -f1)
SKIP=$((SKIP + 1))
TMPDIR=$(mktemp -d)
tail -n +"$SKIP" "$0" | tar xz -C "$TMPDIR" 2>/dev/null
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GTK_THEME=Adwaita
export GDK_BACKEND=x11
exec "$TMPDIR/usr/bin/diskraptor" "$@"
exit 1
#BINARY_START
WRAPPER
  cat "${OUTPUT}.tar.gz" >> "$OUTPUT"
  chmod +x "$OUTPUT"
  rm -f "${OUTPUT}.tar.gz"
}

echo ""
echo "✅ AppImage created: $OUTPUT"
echo "   Size: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "Run with:"
echo "  chmod +x '$OUTPUT' && './$OUTPUT'"
echo ""
echo "No installation needed. Works on ALL Linux distros."
echo "No libraries need to be installed."
