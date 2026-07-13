#!/bin/bash
# DiskRaptor macOS Build Script — fast, only installs missing tools
set -euo pipefail

echo "=========================================="
echo "  DiskRaptor - macOS Build"
echo "=========================================="
echo ""

# ── Check Homebrew ────────────────────────────
if ! command -v brew &>/dev/null; then
  echo "[1] Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "[1] Homebrew: $(brew --version 2>/dev/null | head -1)"
fi

# Source cargo env so rustc/cargo are on PATH
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
fi

# ── Install missing tools ─────────────────────
echo ""
echo "[2] Checking tools..."
NEEDS=""
# Use command -v (shell builtin, instant) instead of brew ls
command -v cmake  &>/dev/null || NEEDS="$NEEDS cmake"
command -v ninja  &>/dev/null || NEEDS="$NEEDS ninja"
command -v node   &>/dev/null || NEEDS="$NEEDS node"
command -v rustc  &>/dev/null || NEEDS="$NEEDS rust"
# For Qt, just check if the prefix directory exists (no brew invocation)
if [ -d "/usr/local/opt/qt@6" ] || [ -d "/opt/homebrew/opt/qt@6" ]; then
  : # qt@6 found
else
  NEEDS="$NEEDS qt@6"
fi

if [ -n "$NEEDS" ]; then
  echo "  Installing:$NEEDS"
  case "$NEEDS" in
    *rust*) curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y ;;
  esac
  # Remove rust from NEEDS before passing to brew
  BREW_NEEDS=$(echo "$NEEDS" | sed 's/ rust//g; s/^ *//')
  if [ -n "$BREW_NEEDS" ]; then
    brew install $BREW_NEEDS
  fi
else
  echo "  All tools present"
fi

# Cache Qt prefix path (avoids multiple slow brew --prefix calls)
if [ -d "/usr/local/opt/qt@6" ]; then
  QT_PREFIX="/usr/local/opt/qt@6"
elif [ -d "/opt/homebrew/opt/qt@6" ]; then
  QT_PREFIX="/opt/homebrew/opt/qt@6"
else
  QT_PREFIX="$(brew --prefix qt@6 2>/dev/null || echo '/usr/local/opt/qt@6')"
fi

# ── Build ─────────────────────────────────────
echo ""
echo "[3] Building..."

# Install Node deps if needed
if [ -f package.json ] && [ ! -d node_modules ] && command -v npm &>/dev/null; then
  npm install --ignore-scripts 2>/dev/null || true
fi

export Qt6_DIR="$QT_PREFIX/lib/cmake/Qt6"
export CMAKE_PREFIX_PATH="$QT_PREFIX"
export PATH="$QT_PREFIX/bin:$PATH"
echo "  Qt6_DIR: $Qt6_DIR"

# Rust scanner (Cargo handles incremental builds automatically)
echo "  Rust scanner..."
cd src-tauri
cargo build --release
cd ..

# Qt app (incremental when build dir exists with CMakeCache.txt)
echo "  Qt app..."
cd qt-app
if [ -f build/CMakeCache.txt ]; then
  cd build
  cmake --build . --config Release
  cd ..
else
  rm -rf build
  mkdir build
  cd build
  cmake .. -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DQt6_DIR="$Qt6_DIR" \
    -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH"
  cmake --build . --config Release
  cd ..
fi
cd ..

# ── Bundle ────────────────────────────────────
echo ""
echo "  Creating DiskRaptor.app bundle..."
mkdir -p dist/DiskRaptor.app/Contents/MacOS
mkdir -p dist/DiskRaptor.app/Contents/Resources

# Generate .icns icon from source PNG (macOS only, uses built-in sips + iconutil)
ICON_SRC="images/logo6_original.png"
ICONSET="dist/DiskRaptor.app/Contents/Resources/DiskRaptor.iconset"
ICON_DEST="dist/DiskRaptor.app/Contents/Resources/icon.icns"
if [ -f "$ICON_SRC" ] && command -v iconutil &>/dev/null; then
  echo "  Generating icon.icns..."
  mkdir -p "$ICONSET"
  for size in 16 32 64 128 256 512 1024; do
    sips -z $size $size "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" &>/dev/null
    if [ $size -le 512 ]; then
      sips -z $((size*2)) $((size*2)) "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" &>/dev/null
    fi
  done
  iconutil -c icns "$ICONSET" -o "$ICON_DEST" 2>/dev/null && rm -rf "$ICONSET"
  echo "  icon.icns created"
elif [ -f "images/icon.ico" ] && command -v iconutil &>/dev/null; then
  echo "  (PNG source not found, skipping icns generation)"
fi

# cmake with MACOSX_BUNDLE TRUE outputs inside .app bundle
if [ -f qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor ]; then
  cp qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
elif [ -f qt-app/build/DiskRaptor ]; then
  cp qt-app/build/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
else
  echo "  ERROR: DiskRaptor binary not found!"
  ls qt-app/build/ 2>/dev/null
  exit 1
fi
cp -r frontend dist/DiskRaptor.app/Contents/Resources/
cp -r images dist/DiskRaptor.app/Contents/Resources/ 2>/dev/null || true

# Copy Qt runtime libs (skip if unchanged)
qt_path="$QT_PREFIX"
for lib in Qt6Core Qt6Gui Qt6Widgets Qt6WebEngine Qt6WebChannel Qt6Network \
           Qt6OpenGL Qt6Positioning Qt6PrintSupport Qt6Qml Qt6Quick \
           Qt6SerialPort Qt6Svg; do
  src_lib="$qt_path/lib/${lib}*.dylib"
  dest_dir="dist/DiskRaptor.app/Contents/MacOS/"
  # Only copy if source is newer than destination
  for f in $src_lib; do
    if [ -f "$f" ]; then
      base="$(basename "$f")"
      if [ ! -f "$dest_dir/$base" ] || [ "$f" -nt "$dest_dir/$base" ]; then
        cp -n "$f" "$dest_dir" 2>/dev/null || true
      fi
    fi
  done
done

# Info.plist
cat > dist/DiskRaptor.app/Contents/Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>DiskRaptor</string>
    <key>CFBundleIdentifier</key>
    <string>com.diskraptor.app</string>
    <key>CFBundleName</key>
    <string>DiskRaptor</string>
    <key>CFBundleVersion</key>
    <string>0.0.7</string>
    <key>CFBundleShortVersionString</key>
    <string>0.0.7</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

echo ""
echo "=========================================="
echo "  BUILD COMPLETE"
echo "=========================================="
echo ""
echo "  App: dist/DiskRaptor.app"
echo ""
echo "  Run with: open dist/DiskRaptor.app"
echo "  Or: dist/DiskRaptor.app/Contents/MacOS/DiskRaptor"
echo ""
