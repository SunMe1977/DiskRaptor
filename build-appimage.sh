#!/bin/bash
# DiskRaptor Portable AppImage Builder
# Usage: bash build-appimage.sh [/path/to/diskraptor-binary]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "=== DiskRaptor Portable AppImage Builder ==="

# ── Helper: self-extracting AppImage fallback ─────────────────
create_self_extracting() {
  local appdir="$1" out="$2"
  tar czf "${out}.tar.gz" -C "$appdir" .
  cat > "$out" << 'WRAPPER'
#!/bin/bash
# DiskRaptor Portable (self-extracting)
SKIP=$(grep -a -n "^#BINARY_START$" "$0" | cut -d: -f1)
SKIP=$((SKIP + 1))
TMPDIR=$(mktemp -d)
tail -n +"$SKIP" "$0" | tar xz -C "$TMPDIR" 2>/dev/null
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GTK_THEME=Adwaita
export GDK_BACKEND=x11
"$TMPDIR/usr/bin/diskraptor" "$@"
RC=$?
rm -rf "$TMPDIR"
exit $RC
#BINARY_START
WRAPPER
  cat "${out}.tar.gz" >> "$out"
  chmod +x "$out"
  rm -f "${out}.tar.gz"
}

# ── Find the binary ───────────────────────────────────────────
BINARY=""
if [ -n "${1:-}" ]; then
  BINARY="$1"
else
  for loc in \
    "$SCRIPT_DIR/target/release/diskraptor" \
    "$SCRIPT_DIR/src-tauri/target/release/diskraptor" \
    "$SCRIPT_DIR/src-tauri/target/release/diskraptor_lib"
  do
    if [ -f "$loc" ] && [ -x "$loc" ]; then
      BINARY="$loc"
      break
    fi
  done
fi

# Search if still not found
if [ -z "$BINARY" ]; then
  BINARY=$(find "$SCRIPT_DIR" -name "diskraptor" -type f -executable 2>/dev/null | head -1)
fi

# Build if still not found
if [ -z "$BINARY" ] || [ ! -f "$BINARY" ]; then
  echo "Building binary..."
  cargo build --release --bin diskraptor --manifest-path "$SCRIPT_DIR/src-tauri/Cargo.toml" 2>&1
  BINARY=$(find "$SCRIPT_DIR/target" -name "diskraptor" -type f -executable 2>/dev/null | head -1)
  if [ -z "$BINARY" ]; then
    echo "❌ Binary not found after build"
    find "$SCRIPT_DIR/target" -name "diskraptor*" -type f 2>/dev/null | head -5
    exit 1
  fi
fi

echo "  Binary: $BINARY"
echo "  Size: $(du -h "$BINARY" | cut -f1)"
echo ""

# ── Create AppDir ─────────────────────────────────────────────
APPDIR="$SCRIPT_DIR/target/AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$APPDIR/usr/share/metainfo"

cp "$BINARY" "$APPDIR/usr/bin/diskraptor"

# AppRun — handles FUSE, GTK, WebKit automatically
cat > "$APPDIR/AppRun" << 'APPRUN'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
# Auto-detect: use extraction if FUSE 2 missing
if [ -z "${APPIMAGE_EXTRACT_AND_RUN:-}" ] && ! command -v fusermount &>/dev/null; then
  export APPIMAGE_EXTRACT_AND_RUN=1
fi
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

# AppStream metadata
cat > "$APPDIR/usr/share/metainfo/diskraptor.appdata.xml" << 'APPDATA'
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop">
  <id>diskraptor</id>
  <name>DiskRaptor</name>
  <summary>Ultra-fast disk space analyzer</summary>
  <description><p>Modern high-performance directory scanner built with Rust and Tauri.</p></description>
</component>
APPDATA

# ── Build AppImage ────────────────────────────────────────────
OUTPUT="$SCRIPT_DIR/DiskRaptor-x86_64.AppImage"

# Find or download appimagetool
APPIMAGETOOL=""
for tool in appimagetool "$SCRIPT_DIR/target/appimagetool"; do
  if command -v "$tool" &>/dev/null; then
    APPIMAGETOOL=$(command -v "$tool")
    break
  fi
done

if [ -z "$APPIMAGETOOL" ]; then
  echo "Downloading appimagetool..."
  APPIMAGETOOL="$SCRIPT_DIR/target/appimagetool"
  URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  if command -v wget &>/dev/null; then
    APPIMAGE_EXTRACT_AND_RUN=1 wget -q "$URL" -O "$APPIMAGETOOL" 2>/dev/null || \
    curl -sL "$URL" -o "$APPIMAGETOOL"
  else
    curl -sL "$URL" -o "$APPIMAGETOOL"
  fi
  chmod +x "$APPIMAGETOOL" || true
fi

echo "Building AppImage..."
export APPIMAGE_EXTRACT_AND_RUN=1
export VERSION=0.2.5

if [ -x "$APPIMAGETOOL" ]; then
  "$APPIMAGETOOL" "$APPDIR" "$OUTPUT" 2>&1 || {
    echo "appimagetool failed. Creating self-extracting archive..."
    create_self_extracting "$APPDIR" "$OUTPUT"
  }
else
  echo "appimagetool not available. Creating self-extracting archive..."
  create_self_extracting "$APPDIR" "$OUTPUT"
fi

echo ""
echo "✅ AppImage: $OUTPUT"
echo "   Size: $(du -h "$OUTPUT" | cut -f1)"
echo ""
echo "Run: chmod +x '$OUTPUT' && './$OUTPUT'"
echo ""

# ── Helper: self-extracting AppImage fallback ─────────────────
create_self_extracting() {
  local appdir="$1" out="$2"
  tar czf "${out}.tar.gz" -C "$appdir" .
  cat > "$out" << 'WRAPPER'
#!/bin/bash
# DiskRaptor Portable (self-extracting)
SKIP=$(grep -a -n "^#BINARY_START$" "$0" | cut -d: -f1)
SKIP=$((SKIP + 1))
TMPDIR=$(mktemp -d)
tail -n +"$SKIP" "$0" | tar xz -C "$TMPDIR" 2>/dev/null
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export GTK_THEME=Adwaita
export GDK_BACKEND=x11
"$TMPDIR/usr/bin/diskraptor" "$@"
RC=$?
rm -rf "$TMPDIR"
exit $RC
#BINARY_START
WRAPPER
  cat "${out}.tar.gz" >> "$out"
  chmod +x "$out"
  rm -f "${out}.tar.gz"
}
