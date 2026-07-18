#!/bin/bash
# DiskRaptor Build Script — auto-detects platform
set -euo pipefail

# ── Detect OS ────────────────────────────────
OS="$(uname -s)"
case "$OS" in
  Darwin*)  PLATFORM="macos" ;;
  Linux*)   PLATFORM="linux" ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
  *)        echo "Unknown OS: $OS"; exit 1 ;;
esac
echo "=========================================="
echo "  DiskRaptor - $PLATFORM Build"
echo "=========================================="
echo ""

# Source cargo env
# Source cargo env so rustc/cargo are on PATH
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
elif [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# Also check for cargo in default rustup location
if ! command -v cargo &>/dev/null && [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# ── Install missing tools ─────────────────────
echo "[1] Checking tools..."
NEEDS=""
command -v cmake  &>/dev/null || NEEDS="$NEEDS cmake"
command -v ninja  &>/dev/null || NEEDS="$NEEDS ninja"
command -v node   &>/dev/null || NEEDS="$NEEDS node"
command -v rustc  &>/dev/null || NEEDS="$NEEDS rust"
command -v cargo  &>/dev/null || NEEDS="$NEEDS cargo"
command -v git    &>/dev/null || NEEDS="$NEEDS git"

if [ -n "$NEEDS" ]; then
  echo "  Installing:$NEEDS"
  case "$NEEDS" in *rust*|*cargo*)
    echo "  Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    if [ -f "$HOME/.cargo/env" ]; then
      . "$HOME/.cargo/env"
    fi
    # Ensure cargo is in PATH for this session
    if [ -d "$HOME/.cargo/bin" ]; then
      export PATH="$HOME/.cargo/bin:$PATH"
    fi
    ;; esac
fi

# ── Platform-specific dependencies ────────────
case "$PLATFORM" in
  macos)
    echo "  macOS: checking Homebrew + Qt..."
    if ! command -v brew &>/dev/null; then
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    PKGS=""
    command -v cmake &>/dev/null || PKGS="$PKGS cmake"
    command -v ninja &>/dev/null || PKGS="$PKGS ninja"
    command -v node  &>/dev/null || PKGS="$PKGS node"
    if [ ! -d "/usr/local/opt/qt@6" ] && [ ! -d "/opt/homebrew/opt/qt@6" ]; then
      PKGS="$PKGS qt@6"
    fi
    [ -n "$PKGS" ] && brew install $PKGS

    if [ -d "/usr/local/opt/qt@6" ]; then
      QT_PREFIX="/usr/local/opt/qt@6"
    elif [ -d "/opt/homebrew/opt/qt@6" ]; then
      QT_PREFIX="/opt/homebrew/opt/qt@6"
    else
      QT_PREFIX="$(brew --prefix qt@6 2>/dev/null || echo '/usr/local/opt/qt@6')"
    fi
    ;;

  linux)
    echo "  Linux: checking system packages..."
    if command -v apt-get &>/dev/null; then
      APT_PKGS=""
      dpkg -l libqt6webenginewidgets6 2>/dev/null | grep -q '^ii' || APT_PKGS="$APT_PKGS qt6-webengine-dev"
      dpkg -l libqt6widgets6 2>/dev/null | grep -q '^ii' || APT_PKGS="$APT_PKGS qt6-base-dev"
      dpkg -l cmake 2>/dev/null | grep -q '^ii' || APT_PKGS="$APT_PKGS cmake"
      dpkg -l ninja-build 2>/dev/null | grep -q '^ii' || APT_PKGS="$APT_PKGS ninja-build"
      dpkg -l nodejs 2>/dev/null | grep -q '^ii' || APT_PKGS="$APT_PKGS nodejs"
      [ -n "$APT_PKGS" ] && sudo apt-get install -y $APT_PKGS
      # Qt6 cmake path on Debian/Ubuntu
      QT_PREFIX="/usr/lib/x86_64-linux-gnu/cmake/Qt6"
      # Also try finding it
      for p in /usr/lib/x86_64-linux-gnu/cmake/Qt6 /usr/lib/cmake/Qt6; do
        [ -d "$p" ] && QT_PREFIX="$p" && break
      done
    elif command -v dnf &>/dev/null; then
      rpm -q qt6-qtwebengine-devel 2>/dev/null || sudo dnf install -y qt6-qtwebengine-devel qt6-qtbase-devel cmake ninja-build nodejs
      QT_PREFIX="/usr/lib64/cmake/Qt6"
    fi
    ;;

  windows)
    echo "  Windows: using build.cmd instead"
    echo "  Run build.cmd from cmd.exe, not bash"
    exit 0
    ;;
esac

# ── Build ─────────────────────────────────────
echo ""
echo "[2] Building..."

if [ -f package.json ] && [ ! -d node_modules ] && command -v npm &>/dev/null; then
  npm install --ignore-scripts 2>/dev/null || true
fi

# Rust scanner — find cargo in all possible locations
CARGO_BIN=""
for dir in "$HOME/.cargo/bin" \
           "$HOME/.rustup/toolchains/stable-*/bin" \
           "/usr/local/cargo/bin" \
           "/usr/lib/cargo/bin" \
           "$CARGO_HOME/bin"; do
  # Expand glob
  for f in $dir; do
    if [ -x "$f/cargo" ] || [ -x "$f/cargo.exe" ]; then
      CARGO_BIN="$f"
      break 2
    fi
  done
done

if [ -n "$CARGO_BIN" ]; then
  export PATH="$CARGO_BIN:$PATH"
  echo "  cargo: $CARGO_BIN/cargo"
elif command -v cargo &>/dev/null; then
  echo "  cargo: $(command -v cargo)"
else
  echo "  ERROR: cargo not found!"
  echo "  Install Rust manually: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "  Then run: source \"\$HOME/.cargo/env\""
  exit 1
fi

echo "  Rust scanner..."
cd src-tauri
cargo build --release
cd ..

# Qt app
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
    -DQt6_DIR="$QT_PREFIX" \
    -DCMAKE_PREFIX_PATH="$QT_PREFIX"
  cmake --build . --config Release
  cd ..
fi
cd ..

# ── Bundle ────────────────────────────────────
echo ""
echo "[3] Packaging..."
mkdir -p dist

case "$PLATFORM" in
  macos)
    echo "  Creating DiskRaptor.app bundle..."
    mkdir -p dist/DiskRaptor.app/Contents/MacOS
    mkdir -p dist/DiskRaptor.app/Contents/Resources

    if [ -f "images/icon.icns" ]; then
      cp images/icon.icns dist/DiskRaptor.app/Contents/Resources/
    fi
    if [ -f qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor ]; then
      cp qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
    elif [ -f qt-app/build/DiskRaptor ]; then
      cp qt-app/build/DiskRaptor dist/DiskRaptor.app/Contents/MacOS/
    fi
    cp -r frontend dist/DiskRaptor.app/Contents/Resources/
    cp -r images dist/DiskRaptor.app/Contents/Resources/ 2>/dev/null || true
    if [ -f src-tauri/target/release/libdiskraptor_scanner.dylib ]; then
      cp src-tauri/target/release/libdiskraptor_scanner.dylib dist/DiskRaptor.app/Contents/MacOS/
    fi
    qt_path="$QT_PREFIX"
    for lib in Qt6Core Qt6Gui Qt6Widgets Qt6WebEngine Qt6WebChannel Qt6Network; do
      for f in $qt_path/../lib/${lib}*.dylib; do
        [ -f "$f" ] && cp -n "$f" dist/DiskRaptor.app/Contents/MacOS/ 2>/dev/null || true
      done
    done

    cat > dist/DiskRaptor.app/Contents/Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DiskRaptor</string>
    <key>CFBundleIdentifier</key><string>com.diskraptor.app</string>
    <key>CFBundleName</key><string>DiskRaptor</string>
    <key>CFBundleVersion</key><string>0.0.7</string>
    <key>CFBundleShortVersionString</key><string>0.0.7</string>
    <key>CFBundleIconFile</key><string>icon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSDesktopFolderUsageDescription</key><string>DiskRaptor needs access to your Desktop to scan files.</string>
    <key>NSDocumentsFolderUsageDescription</key><string>DiskRaptor needs access to your Documents to scan files.</string>
    <key>NSDownloadsFolderUsageDescription</key><string>DiskRaptor needs access to your Downloads to scan files.</string>
    <key>NSNetworkVolumesUsageDescription</key><string>DiskRaptor can scan network volumes.</string>
    <key>NSRemovableVolumesUsageDescription</key><string>DiskRaptor can scan removable volumes.</string>
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>
</dict>
</plist>
EOF
    echo "  App: dist/DiskRaptor.app"
    echo "  Run: open dist/DiskRaptor.app"
    ;;

  linux)
    echo "  Creating dist directory..."
    cp qt-app/build/DiskRaptor dist/
    cp frontend dist/frontend -r
    cp images dist/images -r 2>/dev/null || true
    if [ -f src-tauri/target/release/libdiskraptor_scanner.so ]; then
      cp src-tauri/target/release/libdiskraptor_scanner.so dist/
    fi
    echo "  App: dist/DiskRaptor"
    echo "  Run: ./dist/DiskRaptor"
    ;;

  windows)
    echo "  Run build.cmd from cmd.exe for Windows builds"
    ;;
esac

echo ""
echo "=========================================="
echo "  BUILD COMPLETE"
echo "=========================================="
echo ""
