#!/bin/bash
# DiskRaptor Build Script ??? auto-detects platform
set -eu
if [ -n "$BASH_VERSION" ]; then
  set -o pipefail
fi

# ?????? Detect OS ????????????????????????????????????????????????????????????????????????????????????????????????
OS="$(uname -s)"
case "$OS" in
  Darwin*)  PLATFORM="macos" ;;
  Linux*)   PLATFORM="linux" ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
  *)        echo "Unknown OS: $OS"; exit 1 ;;
esac
VERSION="0.0.2"
echo "=========================================="
echo "  DiskRaptor $VERSION - $PLATFORM Build"
echo "=========================================="
echo ""

# Source cargo env
if [ -f "$HOME/.cargo/env" ]; then
  . "$HOME/.cargo/env"
elif [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
if ! command -v cargo &>/dev/null && [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

# ?????? Quick tool checks (fast, no brew) ???????????????????????????
echo "[1] Checking tools..."
for cmd in cmake ninja node rustc cargo git; do
  LOC=""
  LOC="$(which $cmd 2>/dev/null || true)"
  if [ -z "$LOC" ]; then
    LOC="$(command -v $cmd 2>/dev/null || true)"
  fi
  if [ -z "$LOC" ]; then
    for p in /usr/bin/$cmd /usr/local/bin/$cmd /snap/bin/$cmd; do
      if [ -x "$p" ]; then LOC="$p"; break; fi
    done
  fi
  if [ -z "$LOC" ]; then
    echo "  Missing: $cmd"
    exit 1
  fi
done
echo "  All tools present"

# ?????? Platform-specific deps ????????????????????????????????????????????????????????????
case "$PLATFORM" in
  macos)
    QT_PREFIX=""
    for d in /usr/local/opt/qt@6 /opt/homebrew/opt/qt@6; do
      [ -d "$d" ] && QT_PREFIX="$d" && break
    done
    if [ -z "$QT_PREFIX" ]; then
      QT_PREFIX="$(brew --prefix qt@6 2>/dev/null || true)"
    fi
    if [ ! -d "$QT_PREFIX/lib/cmake/Qt6" ]; then
      echo "  Qt6 not found at $QT_PREFIX. Install with: brew install qt@6"
      exit 1
    fi
    QT_CMAKE_DIR="$QT_PREFIX/lib/cmake/Qt6"
    echo "  Qt6_DIR: $QT_CMAKE_DIR"
    ;;
  linux)
    QT_CMAKE_DIR=""
    for p in /usr/lib/x86_64-linux-gnu/cmake/Qt6 /usr/lib/cmake/Qt6 /usr/lib/aarch64-linux-gnu/cmake/Qt6; do
      [ -d "$p" ] && QT_CMAKE_DIR="$p" && break
    done
    if [ -z "$QT_CMAKE_DIR" ]; then
      echo "  Qt6 cmake not found. Install: sudo apt install qt6-base-dev qt6-webengine-dev"
      exit 1
    fi
    QT_PREFIX="$(dirname "$(dirname "$QT_CMAKE_DIR")")"
    echo "  Qt6_DIR: $QT_CMAKE_DIR"
    ;;
  windows)
    echo "  Run build.cmd from cmd.exe for Windows builds"
    exit 0
    ;;
esac

# ?????? Build ???????????????????????????????????????????????????????????????????????????????????????????????????????????????
echo ""
echo "[2] Building..."
echo "  Rust scanner..."
cd src-tauri
cargo build --release
cd ..

echo "  Qt app..."
cd qt-app
rm -rf build
mkdir build
cd build
cmake .. -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DQt6_DIR="$QT_CMAKE_DIR" \
  -DCMAKE_PREFIX_PATH="$QT_PREFIX" \
  -DCMAKE_INSTALL_RPATH="\$ORIGIN"
cmake --build . --config Release
cd ../..

# ?????? Package ????????????????????????????????????????????????????????????????????????????????????????????????????????????
echo ""
echo "[3] Packaging..."
rm -rf dist
mkdir -p dist

case "$PLATFORM" in
  macos)
    echo "  Creating DiskRaptor.app bundle..."
    APP="dist/DiskRaptor.app"
    mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

    # Binary
    if [ -f "qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor" ]; then
      cp "qt-app/build/DiskRaptor.app/Contents/MacOS/DiskRaptor" "$APP/Contents/MacOS/"
    elif [ -f "qt-app/build/DiskRaptor" ]; then
      cp "qt-app/build/DiskRaptor" "$APP/Contents/MacOS/"
    else
      echo "  ERROR: DiskRaptor binary not found in qt-app/build/"
      echo "  Qt build may have failed. Check output above."
      exit 1
    fi

    # Resources
    cp -r frontend "$APP/Contents/Resources/"
    cp -r images "$APP/Contents/Resources/" 2>/dev/null || true

    # Rust scanner
    if [ -f "src-tauri/target/release/libdiskraptor_scanner.dylib" ]; then
      cp "src-tauri/target/release/libdiskraptor_scanner.dylib" "$APP/Contents/MacOS/"
    fi

    # Icon ??? generate .icns from PNG if missing
    if [ ! -f "images/icon.icns" ] && [ -f "images/logo6_original.png" ]; then
      echo "  Generating icon.icns from logo6_original.png..."
      mkdir -p icon_tmp/diskraptor.iconset
      SRC="images/logo6_original.png"
      # Generate all required sizes for a complete iconset
      # macOS requires: 16, 32, 128, 256, 512 + @2x variants (32, 64, 256, 512, 1024)
      for s in 16 32 128 256 512 1024; do
        if command -v convert &>/dev/null; then
          convert "$SRC" -resize ${s}x${s} "icon_tmp/diskraptor.iconset/icon_${s}x${s}.png" 2>/dev/null || true
        elif command -v ffmpeg &>/dev/null; then
          ffmpeg -y -i "$SRC" -vf "scale=${s}:${s}" "icon_tmp/diskraptor.iconset/icon_${s}x${s}.png" 2>/dev/null || true
        elif command -v sips &>/dev/null; then
          sips -z $s $s "$SRC" --out "icon_tmp/diskraptor.iconset/icon_${s}x${s}.png" 2>/dev/null || true
        fi
      done
      # Create @2x variants (retina) from the larger sizes
      # 16x16@2x = 32, 32x32@2x = 64, 128x128@2x = 256, 256x256@2x = 512, 512x512@2x = 1024
      for pair in "16 32" "32 64" "128 256" "256 512" "512 1024"; do
        base="${pair% *}"
        retina="${pair#* }"
        src="icon_tmp/diskraptor.iconset/icon_${retina}x${retina}.png"
        dst="icon_tmp/diskraptor.iconset/icon_${base}x${base}@2x.png"
        [ -f "$src" ] && cp "$src" "$dst" 2>/dev/null || true
      done
      # Fallback: create missing @2x from base size
      for base in 16 32 128 256 512; do
        dst="icon_tmp/diskraptor.iconset/icon_${base}x${base}@2x.png"
        if [ ! -f "$dst" ]; then
          src="icon_tmp/diskraptor.iconset/icon_${base}x${base}.png"
          [ -f "$src" ] && cp "$src" "$dst" 2>/dev/null || true
        fi
      done
      # Build .icns
      if command -v iconutil &>/dev/null; then
        iconutil -c icns icon_tmp/diskraptor.iconset -o images/icon.icns 2>/dev/null || true
        if [ -f "images/icon.icns" ]; then
          echo "  icon.icns created ($(du -h images/icon.icns | cut -f1))"
        fi
      fi
      rm -rf icon_tmp
    fi

    if [ -f "images/icon.icns" ]; then
      cp "images/icon.icns" "$APP/Contents/Resources/"
      echo "  icon.icns copied"
    else
      echo "  WARNING: icon.icns not found ??? app icon will be missing"
    fi

    # Info.plist
    cat > "$APP/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>DiskRaptor</string>
    <key>CFBundleIdentifier</key><string>com.diskraptor.app</string>
    <key>CFBundleName</key><string>DiskRaptor</string>
    <key>CFBundleVersion</key><string>0.0.2</string>
    <key>CFBundleShortVersionString</key><string>0.0.2</string>
    <key>CFBundleIconFile</key><string>icon.icns</string>
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

    # Entitlements (used for hardened runtime)
    ENTITLEMENTS="installer/DiskRaptor.entitlements"

    # Codesign — detect Developer ID certificate
    CODESIGN_IDENTITY="${APPLE_DEVELOPER_ID:-}"
    if [ -z "$CODESIGN_IDENTITY" ]; then
      echo "  Looking for Developer ID certificate in keychain..."
      security find-identity -v -p basic 2>&1 | grep -i "developer" || true
      CODESIGN_IDENTITY="$(security find-identity -v -p basic 2>/dev/null | grep -i "Developer ID" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)"
      if [ -z "$CODESIGN_IDENTITY" ]; then
        CODESIGN_IDENTITY="$(security find-identity -v 2>/dev/null | grep -i "Developer ID" | head -1 | sed 's/.*"\(.*\)"/\1/' || true)"
      fi
    fi
    if [ -n "$CODESIGN_IDENTITY" ]; then
      echo "  Developer ID: $CODESIGN_IDENTITY"
    else
      echo "  No Developer ID certificate found — will not codesign"
    fi

    # Deploy Qt frameworks using macdeployqt (handles rpath, plugins, WebEngine)
    MACDEPLOYQT=""
    for p in "$QT_PREFIX/bin/macdeployqt" "/usr/local/opt/qt@6/bin/macdeployqt" "/opt/homebrew/opt/qt@6/bin/macdeployqt" "$(which macdeployqt 2>/dev/null || true)"; do
      [ -x "$p" ] && MACDEPLOYQT="$p" && break
    done
    if [ -n "$MACDEPLOYQT" ]; then
      echo "  Deploying Qt frameworks with macdeployqt..."
      "$MACDEPLOYQT" "$APP" -verbose=1 -no-strip 2>&1 || true
      echo "  macdeployqt done"
    else
      echo "  WARNING: macdeployqt not found ??? Qt frameworks may be missing"
    fi

    if [ -n "$CODESIGN_IDENTITY" ]; then
      echo "  Codesigning with hardened runtime..."
      codesign --deep --force --options=runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$CODESIGN_IDENTITY" "$APP" 2>&1 || true
    fi

    echo "  DEBUG: Creating DMG step..."
    echo ""
    echo "  Creating DMG..."
    if [ ! -d "$APP" ]; then
      echo "  ERROR: .app bundle not found at $APP"
      ls -la dist/
      exit 1
    fi
    echo "  DEBUG: Running hdiutil..."
    if ! hdiutil create -volname "DiskRaptor" -srcfolder "$APP" -ov -format UDZO "dist/DiskRaptor-$VERSION-macos.dmg" -verbose 2>&1; then
      echo "  ERROR: hdiutil failed"
      echo "  DEBUG: dist/ contents:" && ls -la dist/
      exit 1
    fi
    echo "  DMG: dist/DiskRaptor-$VERSION-macos.dmg"
    echo "  DEBUG: DMG created, continuing..."

    echo "  DEBUG: Creating ZIP step..."
    echo "  DEBUG: Running zip from $(pwd)..."
    ls -la dist/DiskRaptor.app || true
    if ! zip -r "dist/DiskRaptor-$VERSION-macos.zip" "dist/DiskRaptor.app" 2>&1; then
      echo "  ERROR: zip creation failed (exit code $?)"
      echo "  DEBUG: dist/ contents:" && ls -la dist/
      exit 1
    fi
    echo "  ZIP: dist/DiskRaptor-$VERSION-macos.zip"

    # Notarization (requires Apple ID email, team ID, and app-specific password)
    if [ -n "$CODESIGN_IDENTITY" ] && [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
        echo "  Notarizing DMG..."
        # Submit for notarization
        xcrun notarytool submit "dist/DiskRaptor-$VERSION-macos.dmg" \
          --apple-id "$APPLE_ID" \
          --team-id "$APPLE_TEAM_ID" \
          --password "$APPLE_APP_PASSWORD" \
          --wait 2>&1 || true
        # Staple the ticket
        xcrun stapler staple "dist/DiskRaptor-$VERSION-macos.dmg" 2>&1 || true
        xcrun stapler staple "$APP" 2>&1 || true
    elif [ -n "$CODESIGN_IDENTITY" ] && [ -n "${APPLE_NOTARIZE:-}" ]; then
        echo "  Notarization requested but APPLE_ID, APPLE_TEAM_ID, or APPLE_APP_PASSWORD not set — skipping"
    fi

    if [ -z "$CODESIGN_IDENTITY" ]; then
      echo ""
      echo "  ??? To remove macOS gatekeeper warnings on this build:"
      echo "    xattr -rd com.apple.quarantine dist/DiskRaptor.app"
      echo "    xattr -rd com.apple.quarantine dist/DiskRaptor-$VERSION-macos.dmg"
    fi
    echo ""
    echo "  Run: open dist/DiskRaptor.app"
    ;;

  linux)
    echo "  Bundling..."
    mkdir -p dist/lib

    # Binary (check it exists)
    if [ ! -f qt-app/build/DiskRaptor ]; then
      echo "  ERROR: Binary not found at qt-app/build/DiskRaptor"
      echo "  Qt build may have failed. Check output above."
      exit 1
    fi
    cp qt-app/build/DiskRaptor dist/

    # Frontend + Images
    cp -r frontend dist/
    mkdir -p dist/images
    cp -r images/* dist/images/ 2>/dev/null || true

    # Rust scanner
    if [ -f src-tauri/target/release/libdiskraptor_scanner.so ]; then
      cp src-tauri/target/release/libdiskraptor_scanner.so dist/
    fi

    # Bundle Qt libraries
    echo "  Bundling Qt libraries..."
    for lib in Core Gui Widgets Network OpenGL Positioning PrintSupport Qml Quick Svg WebChannel WebEngineCore WebEngineWidgets; do
      for f in $QT_PREFIX/libQt6${lib}.so*; do
        [ -f "$f" ] && cp -n "$f" dist/lib/ 2>/dev/null || true
      done
    done

    # Bundle additional required libs
    for lib in libicudata.so.* libicui18n.so.* libicuuc.so.* libpcre2-16.so.* libdouble-conversion.so.* libzstd.so.* libmd4c.so.* libfreetype.so.* libharfbuzz.so.* libpng16.so.* libjpeg.so.* libglib-2.0.so.* libgio-2.0.so.* libgobject-2.0.so.* libdrm.so.* libxkbcommon.so.* libxcb.so.* libxcb-xkb.so.* libxcb-image.so.* libxcb-render.so.* libxcb-shm.so.* libxcb-keysyms.so.* libxcb-xfixes.so.* libxcb-xinput.so.* libxcb-randr.so.* libxcb-shape.so.* libxcb-sync.so.* libxcb-xinerama.so.* libxcb-present.so.* libxcb-dri3.so.* libxshmfence.so.* libX11.so.* libX11-xcb.so.* libXi.so.* libXrandr.so.* libXrender.so.* libXext.so.* libXfixes.so.* libXcursor.so.* libXdamage.so.* libXcomposite.so.* libXinerama.so.* libXtst.so.* libfontconfig.so.* libEGL.so.* libGL.so.* libgbm.so.* libwayland-client.so.* libwayland-server.so.* libwayland-egl.so.*; do
      for f in /usr/lib/x86_64-linux-gnu/$lib /usr/lib/$lib; do
        [ -f "$f" ] && cp -n "$f" dist/lib/ 2>/dev/null || true
      done
    done

    # Launcher script
    cat > dist/DiskRaptor.sh << 'SCRIPT'
#!/bin/bash
cd "$(dirname "$0")"
export LD_LIBRARY_PATH="$PWD/lib:$LD_LIBRARY_PATH"
exec ./DiskRaptor "$@"
SCRIPT
    chmod +x dist/DiskRaptor.sh

    # Create ZIP
    if command -v zip &>/dev/null; then
      ROOT="$(pwd)"
      cd "$ROOT"
      zip -r "dist/DiskRaptor-$VERSION-linux-x64.zip" "dist/" -x "dist/DiskRaptor-*.zip" "dist/DiskRaptor-*.deb" 2>/dev/null || true
      echo "  ZIP: dist/DiskRaptor-$VERSION-linux-x64.zip"
    else
      echo "  SKIP ZIP: 'zip' not installed (sudo apt install zip)"
    fi

    # Create DEB package
    echo "  Creating DEB package..."
    DEB_DIR="deb"
    rm -rf "$DEB_DIR"
    mkdir -p "$DEB_DIR/DEBIAN"
    mkdir -p "$DEB_DIR/usr/bin"
    mkdir -p "$DEB_DIR/usr/lib/diskraptor"
    mkdir -p "$DEB_DIR/usr/share/applications"
    mkdir -p "$DEB_DIR/usr/share/icons/hicolor/128x128/apps"
    mkdir -p "$DEB_DIR/usr/share/icons/hicolor/256x256/apps"

    # Control file
    cat > "$DEB_DIR/DEBIAN/control" << 'CONTROL'
Package: diskraptor
Version: 0.0.2
Section: utils
Priority: optional
Architecture: amd64
Maintainer: DiskRaptor Team
Description: Ultra-fast disk space analyzer with virtual tree view, pie chart, and live progress.
 Scans millions of files using a parallel Rust engine.
CONTROL

    # Post-install: register icon cache
    cat > "$DEB_DIR/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
set -e
if command -v update-desktop-database &>/dev/null; then
    update-desktop-database 2>/dev/null || true
fi
if command -v gtk-update-icon-cache &>/dev/null; then
    gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi
POSTINST
    chmod 755 "$DEB_DIR/DEBIAN/postinst"

    # Binary + launcher
    cp dist/DiskRaptor "$DEB_DIR/usr/bin/"
    cp dist/DiskRaptor.sh "$DEB_DIR/usr/bin/"

    # Desktop entry
    cat > "$DEB_DIR/usr/share/applications/diskraptor.desktop" << 'DESKTOP'
[Desktop Entry]
Name=DiskRaptor
Comment=Ultra-fast disk space analyzer
Exec=/usr/bin/DiskRaptor.sh
Icon=diskraptor
Terminal=false
Type=Application
Categories=Utility;FileTools;
DESKTOP

    # Icons
    if [ -f images/256x256@2x.png ]; then
      cp images/256x256@2x.png "$DEB_DIR/usr/share/icons/hicolor/256x256/apps/diskraptor.png"
    fi
    if [ -f images/128x128@2x.png ]; then
      cp images/128x128@2x.png "$DEB_DIR/usr/share/icons/hicolor/128x128/apps/diskraptor.png"
    fi
    if [ -f images/logo6_original.png ]; then
      cp images/logo6_original.png "$DEB_DIR/usr/share/icons/hicolor/256x256/apps/diskraptor.png"
      # Generate 128 from 256
      ffmpeg -y -i images/logo6_original.png -vf "scale=128:128" "$DEB_DIR/usr/share/icons/hicolor/128x128/apps/diskraptor.png" 2>/dev/null || true
    fi

    # Bundle Qt libraries into DEB
    cp -r dist/lib/*.so* "$DEB_DIR/usr/lib/diskraptor/" 2>/dev/null || true
    cp -r dist/frontend "$DEB_DIR/usr/share/diskraptor/" 2>/dev/null || true
    cp -r dist/images "$DEB_DIR/usr/share/diskraptor/" 2>/dev/null || true

    # Update launcher to find bundled libs
    cat > "$DEB_DIR/usr/bin/diskraptor" << 'LAUNCHER'
#!/bin/bash
export LD_LIBRARY_PATH="/usr/lib/diskraptor:$LD_LIBRARY_PATH"
exec /usr/bin/DiskRaptor "$@"
LAUNCHER
    chmod 755 "$DEB_DIR/usr/bin/diskraptor"
    chmod 755 "$DEB_DIR/usr/bin/DiskRaptor.sh"

    if command -v dpkg-deb &>/dev/null; then
      dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-$VERSION-amd64.deb"
      echo "  DEB: dist/DiskRaptor-$VERSION-amd64.deb"
    else
      echo "  SKIP DEB: 'dpkg-deb' not installed"
    fi
    echo "  ZIP: dist/DiskRaptor-$VERSION-linux-x64.zip"
    echo ""
    echo "  Run: LD_LIBRARY_PATH=dist/lib ./dist/DiskRaptor"
    echo "  Or install: sudo dpkg -i dist/DiskRaptor-$VERSION-amd64.deb"
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

