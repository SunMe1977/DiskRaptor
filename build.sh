#!/bin/bash
# DiskRaptor macOS Build Script
# Installs all required tools and builds the application

set -euo pipefail

echo "=========================================="
echo "  DiskRaptor - macOS Build"
echo "=========================================="
echo ""

# ── Check for Homebrew ──────────────────────────
if ! command -v brew &>/dev/null; then
    echo "[1/5] Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "[1/5] Homebrew found: $(brew --version | head -1)"
fi

# ── Install Qt 6 ─────────────────────────────────
echo ""
echo "[2/5] Installing Qt 6 + dependencies..."
brew list qt@6 2>/dev/null || brew install qt@6
brew list cmake 2>/dev/null || brew install cmake
brew list ninja 2>/dev/null || brew install ninja

# ── Install Rust ─────────────────────────────────
echo ""
echo "[3/5] Installing Rust..."
if ! command -v rustc &>/dev/null; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source "$HOME/.cargo/env"
fi
echo "  rustc: $(rustc --version)"
echo "  cargo: $(cargo --version)"

# ── Install Node.js for tests ────────────────────
echo ""
echo "[4/5] Installing Node.js + dependencies..."
brew list node 2>/dev/null || brew install node
npm install --ignore-scripts 2>/dev/null || true

# ── Build ────────────────────────────────────────
echo ""
echo "[5/5] Building..."

# Export Qt paths
export Qt6_DIR="$(brew --prefix qt@6)/lib/cmake/Qt6"
export CMAKE_PREFIX_PATH="$(brew --prefix qt@6)"
export PATH="$(brew --prefix qt@6)/bin:$PATH"

echo "  Qt6_DIR: $Qt6_DIR"

# Build Rust scanner DLL
echo "  Building Rust scanner..."
cd src-tauri
cargo build --release
cd ..

# Build Qt app
echo "  Building Qt app..."
cd qt-app
rm -rf build
mkdir build
cd build
cmake .. -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DQt6_DIR="$Qt6_DIR" \
    -DCMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH"
cmake --build . --config Release
cd ../..

# Create bundle
echo ""
echo "  Creating DiskRaptor.app bundle..."
mkdir -p dist/DiskRaptor.app/Contents/MacOS
mkdir -p dist/DiskRaptor.app/Contents/Resources

cp qt-app/build/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
cp -r frontend dist/DiskRaptor.app/Contents/Resources/
cp -r images dist/DiskRaptor.app/Contents/Resources/ 2>/dev/null || true

# Copy Qt runtime libs
qt_path="$(brew --prefix qt@6)"
cp "$qt_path/lib"/Qt6Core*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Gui*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Widgets*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6WebEngine*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6WebChannel*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Network*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6OpenGL*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Positioning*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6PrintSupport*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Qml*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Quick*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6SerialPort*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
cp "$qt_path/lib"/Qt6Svg*.dylib dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true

# Create Info.plist
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
    <string>0.0.1</string>
    <key>CFBundleShortVersionString</key>
    <string>0.0.1</string>
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
