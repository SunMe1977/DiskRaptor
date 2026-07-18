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

# ── Install missing tools ─────────────────────
echo ""
echo "[2] Checking tools..."
NEEDS=""
brew ls --formula qt@6       &>/dev/null || NEEDS="$NEEDS qt@6"
brew ls --formula cmake      &>/dev/null || NEEDS="$NEEDS cmake"
brew ls --formula ninja      &>/dev/null || NEEDS="$NEEDS ninja"
if [ -n "$NEEDS" ]; then
  echo "  Installing:$NEEDS"
  brew install $NEEDS
else
  echo "  All tools present"
fi

# ── Rust ──────────────────────────────────────
echo ""
echo "[3] Rust: $(rustc --version 2>/dev/null || echo 'not found')"
if ! command -v rustc &>/dev/null; then
  echo "  Installing Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  source "$HOME/.cargo/env"
fi

# ── Node deps ─────────────────────────────────
echo ""
echo "[4] Node: $(node --version 2>/dev/null || echo 'not found')"
if ! command -v node &>/dev/null; then
  echo "  Installing Node..."
  brew install node
fi
if [ ! -d node_modules ]; then
  npm install --ignore-scripts 2>/dev/null || true
fi

# ── Build ─────────────────────────────────────
echo ""
echo "[5] Building..."

export Qt6_DIR="$(brew --prefix qt@6)/lib/cmake/Qt6"
export CMAKE_PREFIX_PATH="$(brew --prefix qt@6)"
export PATH="$(brew --prefix qt@6)/bin:$PATH"
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

cp qt-app/build/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
cp -r frontend dist/DiskRaptor.app/Contents/Resources/
cp -r images dist/DiskRaptor.app/Contents/Resources/ 2>/dev/null || true

# Copy Qt runtime libs (skip if unchanged — use rsync-style check)
qt_path="$(brew --prefix qt@6)"
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
