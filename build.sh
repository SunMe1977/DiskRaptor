#!/bin/bash
# DiskRaptor Build Script ??? auto-detects platform
set -eu
if [ -n "${BASH_VERSION:-}" ]; then
  set -o pipefail
fi

# Load environment variables from .env file (secrets for signing/notarization)
if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

# ── Argument parsing ──────────────────────────────────────────────
UPLOAD_MAS=false
NO_MAS=false
for arg in "$@"; do
  case "$arg" in
    --no-mas) NO_MAS=true ;;
    --upload) UPLOAD_MAS=true ;;
    --help|-h)
      echo "Usage: $0 [--no-mas] [--upload]"
      echo "  --no-mas   Skip Mac App Store .pkg build"
      echo "  --upload   Upload the MAS .pkg via Transporter"
      exit 0 ;;
  esac
done

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

# ── MAS (Mac App Store) build function ────────────────────────────
build_mas_pkg() {
  local APP_SRC="dist/DiskRaptor.app"
  local MAS_DIR="dist-mas"
  local APP_DST="$MAS_DIR/DiskRaptor.app"
  local IDENTIFIER="diskraptor"
  local DIST_CERT="${APPLE_DIST_CERT:-Apple Distribution: Hansjoerg Hofer (7TK444BCPC)}"
  local ENTITLEMENTS="installer/DiskRaptor-MAS.entitlements"

  echo ""
  echo "--- MAS Build ---"
  echo "[MAS] Preparing .app bundle..."
  rm -rf "$MAS_DIR"
  mkdir -p "$MAS_DIR"

  if [ ! -d "$APP_SRC" ]; then
    echo "  ERROR: $APP_SRC not found. Main build must succeed first."
    return 1
  fi

  cp -R "$APP_SRC" "$APP_DST"
  plutil -replace CFBundleIdentifier -string "$IDENTIFIER" "$APP_DST/Contents/Info.plist" 2>/dev/null || true
  plutil -replace DiskRaptorDisableUpdates -bool YES "$APP_DST/Contents/Info.plist" 2>/dev/null || true

  # Embed provisioning profile (required for TestFlight & App Store)
  local PROFILE_SRC=""
  for f in ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
    [ -f "$f" ] || continue
    if security cms -D -i "$f" 2>/dev/null | grep -q "MAC_APP_STORE"; then
      PROFILE_SRC="$f"
      break
    fi
  done
  if [ -z "$PROFILE_SRC" ]; then
    # Fallback: try the first Mac provisioning profile
    for f in ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision; do
      [ -f "$f" ] || continue
      if security cms -D -i "$f" 2>/dev/null | grep -q "Mac App Store\|MacAppStore\|macappstore"; then
        PROFILE_SRC="$f"
        break
      fi
    done
  fi
  if [ -n "$PROFILE_SRC" ]; then
    cp "$PROFILE_SRC" "$APP_DST/Contents/embedded.provisionprofile"
    echo "  Provisioning profile embedded: $(basename "$PROFILE_SRC")"
  else
    echo "  WARNING: No Mac App Store provisioning profile found."
    echo "           TestFlight will reject this build."
    echo "           Create one at: https://developer.apple.com/account/resources/profiles"
  fi
  plutil -replace CFBundleVersion -string "$VERSION" "$APP_DST/Contents/Info.plist" 2>/dev/null || true
  plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DST/Contents/Info.plist" 2>/dev/null || true
  echo "  Bundle ID: $IDENTIFIER"

  # Temp keychain for signing
  # Unlock keychain if password is set (suppresses GUI prompts)
  if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  fi

  # Sign the .app with Apple Distribution cert
  echo "[MAS] Signing .app with Apple Distribution..."
  local DIST_ACCESSIBLE=true
  security find-identity -v -p codesigning 2>/dev/null | grep -F -q "$DIST_CERT" || DIST_ACCESSIBLE=false

  # Detect installer signing identity (separate from app signing)
  local INSTALLER_CERT=""
  INSTALLER_CERT="$(security find-identity -v -p basic 2>/dev/null | grep -i "Installer.*$TEAM_ID" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
  if [ -z "$INSTALLER_CERT" ]; then
    INSTALLER_CERT="$(security find-identity -v -p basic 2>/dev/null | grep -i "Mac Developer Installer\|Developer ID Installer\|3rd Party Mac" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
  fi

  if [ "$DIST_ACCESSIBLE" = true ]; then
    echo "  Signing with: $DIST_CERT"
    codesign --deep --force --options=runtime \
      --entitlements "$ENTITLEMENTS" \
      --sign "$DIST_CERT" \
      "$APP_DST" 2>&1 || true
    codesign -dvvv "$APP_DST" 2>&1 | head -5 || true
  else
    echo "  WARNING: Distribution cert not accessible ($DIST_CERT)"
    echo "  Falling back to ad-hoc signing (invalid for MAS)."
    codesign --deep --force --options=runtime \
      --entitlements "$ENTITLEMENTS" \
      --sign - \
      "$APP_DST" 2>/dev/null || true
  fi

  # Create .pkg
  echo "[MAS] Creating .pkg..."
  local PKG_PATH="$MAS_DIR/DiskRaptor-$VERSION-mas.pkg"
  if [ -n "$INSTALLER_CERT" ]; then
    echo "  Signing PKG with: $INSTALLER_CERT"
    productbuild \
      --component "$APP_DST" /Applications \
      --sign "$INSTALLER_CERT" \
      --identifier "$IDENTIFIER" \
      --version "$VERSION" \
      "$PKG_PATH" 2>&1 || true
  else
    echo "  WARNING: No '3rd Party Mac Developer Installer' certificate found."
    echo "           The PKG must be signed for App Store submission."
    echo "           Get the cert at: https://developer.apple.com/account/resources/certificates"
    productbuild \
      --component "$APP_DST" /Applications \
      --identifier "$IDENTIFIER" \
      --version "$VERSION" \
      "$PKG_PATH" 2>&1 || true
  fi

  if [ -f "$PKG_PATH" ]; then
    echo "  PKG: $PKG_PATH"
    ls -lh "$PKG_PATH"
  else
    echo "  ERROR: PKG was not created at $PKG_PATH"
  fi

  # Upload via Transporter
  if [ "$UPLOAD_MAS" = true ] && [ "$DIST_ACCESSIBLE" = true ]; then
    echo "[MAS] Uploading to App Store Connect..."
    if command -v iTMSTransporter &>/dev/null; then
      iTMSTransporter -m upload -f "$PKG_PATH" \
        -u "${APPLE_ID:?APPLE_ID not set}" \
        -vp "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD not set}"
    else
      xcrun transporter \
        --source "$PKG_PATH" \
        --type package \
        --apple-id "${APPLE_ID:-}" \
        --team-id "${APPLE_TEAM_ID:-7TK444BCPC}" \
        --password "${APPLE_APP_PASSWORD:-}" \
        --verbose 2>&1
    fi
    echo "  Upload complete."
  elif [ "$UPLOAD_MAS" = true ]; then
    echo "  SKIP upload: Distribution cert not accessible."
  fi

  echo "--- MAS Build Complete ---"
  echo "  .app: $APP_DST"
  echo "  .pkg: $PKG_PATH"
}

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
    # Optionally auto-install Qt and modules when QT not found
    if [ ! -d "$QT_PREFIX/lib/cmake/Qt6" ] && [ "${AUTO_INSTALL_QT:-0}" = "1" ]; then
      echo "  QT not found — AUTO_INSTALL_QT=1 set. Installing Qt and common modules via Homebrew..."
      if ! command -v brew &>/dev/null; then
        echo "  ERROR: Homebrew not found. Install Homebrew or unset AUTO_INSTALL_QT.";
        exit 1
      fi
      brew update || true
      brew install qt@6 qtsvg qtvirtualkeyboard qtwebengine qtwebchannel qtpositioning || true
      QT_PREFIX="$(brew --prefix qt@6 2>/dev/null || true)"
    fi
    # Allow overriding QT_PREFIX from the environment if Homebrew prefix differs
    if [ -n "${QT_PREFIX_OVERRIDE:-}" ]; then
      QT_PREFIX="$QT_PREFIX_OVERRIDE"
    fi
    if [ ! -d "$QT_PREFIX/lib/cmake/Qt6" ]; then
      echo "  Qt6 not found at $QT_PREFIX. Install with: brew install qt@6"
      exit 1
    fi
    QT_CMAKE_DIR="$QT_PREFIX/lib/cmake/Qt6"
    echo "  Qt6_DIR: $QT_CMAKE_DIR"
    # Respect explicit override for QML dir
    QML_DIR="${QT_QML_DIR:-}"
    # Try to detect QML directory (qmake is the next reliable source)
    if [ -z "$QML_DIR" ] && command -v qmake &>/dev/null; then
      QML_DIR=$(qmake -query QT_INSTALL_QML 2>/dev/null || true)
    fi
    # Fallback common locations
    for d in "$QT_PREFIX/qml" "$QT_PREFIX/lib/qml" "$QT_PREFIX/Resources/qml" "/usr/local/opt/qt@6/qml" "/opt/homebrew/opt/qt@6/qml"; do
      [ -d "$d" ] && QML_DIR="$d" && break
    done
    echo "  QML_DIR: ${QML_DIR:-<not found>}"
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

# Detect architectures for universal binary
ARCHS="x86_64"
if [ "$PLATFORM" = "macos" ]; then
  # Check if Qt supports arm64 (universal Qt from qt.io)
  QT_ARCHS=$(lipo -info "$QT_PREFIX/lib/QtCore.framework/Versions/A/QtCore" 2>/dev/null | grep "Architectures" | sed 's/.*are: //')
  if echo "$QT_ARCHS" | grep -q "arm64"; then
    ARCHS="x86_64 arm64"
    echo "  Detected universal Qt ($QT_ARCHS) — building universal binary"
  else
    echo "  Warning: Qt is x86_64 only. For arm64 support, install universal Qt from qt.io"
  fi
fi

echo "  Rust scanner..."
cd src-tauri
if echo "$ARCHS" | grep -q "arm64"; then
  rustup target add aarch64-apple-darwin 2>/dev/null || true
  cargo build --release --target x86_64-apple-darwin
  cargo build --release --target aarch64-apple-darwin
  mkdir -p target/universal
  lipo -create -output target/universal/libdiskraptor_scanner.dylib \
    target/x86_64-apple-darwin/release/libdiskraptor_scanner.dylib \
    target/aarch64-apple-darwin/release/libdiskraptor_scanner.dylib
  cp target/universal/libdiskraptor_scanner.dylib target/release/
else
  cargo build --release
fi
cd ..

echo "  Qt app..."
cd qt-app
rm -rf build
mkdir build
cd build
ARCH_FLAGS=""
if echo "$ARCHS" | grep -q "arm64"; then
  ARCH_FLAGS="-DCMAKE_OSX_ARCHITECTURES=x86_64;arm64"
fi
cmake .. -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DQt6_DIR="$QT_CMAKE_DIR" \
  -DCMAKE_PREFIX_PATH="$QT_PREFIX" \
  -DCMAKE_INSTALL_RPATH="\$ORIGIN" \
  $ARCH_FLAGS
cmake --build . --config Release
cd ../..

# ?????? Package ????????????????????????????????????????????????????????????????????????????????????????????????????????????
echo ""
echo "[3] Packaging..."
rm -rf dist 2>/dev/null || true
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
    <key>CFBundleIdentifier</key><string>diskraptor</string>
    <key>CFBundleName</key><string>DiskRaptor</string>
    <key>CFBundleVersion</key><string>0.0.2</string>
    <key>CFBundleShortVersionString</key><string>0.0.2</string>
    <key>CFBundleIconFile</key><string>icon.icns</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
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
      # Try Developer ID or Apple Distribution first (for distribution)
      CODESIGN_IDENTITY="$(security find-identity -p basic 2>/dev/null | grep -iE "Developer ID|Apple Distribution" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
      if [ -z "$CODESIGN_IDENTITY" ]; then
        # Fall back to Apple Development
        CODESIGN_IDENTITY="$(security find-identity -p basic 2>/dev/null | grep -i "Apple Development" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
      fi
      if [ -z "$CODESIGN_IDENTITY" ]; then
        # Fall back to any identity (last resort)
        CODESIGN_IDENTITY="$(security find-identity -p basic 2>/dev/null | grep "^1)" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
      fi
    fi
    if [ -n "$CODESIGN_IDENTITY" ]; then
      echo "  Codesign identity: $CODESIGN_IDENTITY"
    else
      echo "  No codesign certificate found — will use ad-hoc signing"
      CODESIGN_IDENTITY="-"
    fi

    # Deploy Qt frameworks using macdeployqt (handles rpath, plugins, WebEngine)
    MACDEPLOYQT=""
    for p in "$QT_PREFIX/bin/macdeployqt" "/usr/local/opt/qt@6/bin/macdeployqt" "/opt/homebrew/opt/qt@6/bin/macdeployqt" "$(which macdeployqt 2>/dev/null || true)"; do
      [ -x "$p" ] && MACDEPLOYQT="$p" && break
    done
    if [ -n "$MACDEPLOYQT" ]; then
      echo "  Deploying Qt frameworks with macdeployqt..."
      if [ -n "${QML_DIR:-}" ] && [ -d "$QML_DIR" ]; then
        "$MACDEPLOYQT" "$APP" -verbose=1 -qmldir="$QML_DIR" -no-strip -no-codesign 2>&1 || true
      else
        "$MACDEPLOYQT" "$APP" -verbose=1 -no-strip -no-codesign 2>&1 || true
      fi
      echo "  macdeployqt done"

      # ── Bundle QtSvg (needed by imageformat/iconengine plugins, not auto-deployed by macdeployqt) ──
      for fw in QtSvg QtSvgWidgets; do
        SRC_FW=""
        for p in /usr/local/opt/qtsvg/lib/${fw}.framework /opt/homebrew/opt/qtsvg/lib/${fw}.framework /usr/local/Cellar/qtsvg/*/lib/${fw}.framework /opt/homebrew/Cellar/qtsvg/*/lib/${fw}.framework; do
          [ -d "$p" ] && SRC_FW="$p" && break
        done
        if [ -d "$SRC_FW" ] && [ ! -d "$APP/Contents/Frameworks/${fw}.framework" ]; then
          echo "  Copying ${fw}.framework..."
          ditto "$SRC_FW" "$APP/Contents/Frameworks/${fw}.framework"
        fi
      done

      # ── Bundle missing Qt frameworks not deployed by macdeployqt ──
      QT_BASE_LIB="${QT_PREFIX}/lib"
      for fw in QtDBus QtQmlMeta QtQmlModels QtQmlWorkerScript QtQuickWidgets; do
        SRC_FW="$QT_BASE_LIB/${fw}.framework"
        if [ -d "$SRC_FW" ] && [ ! -d "$APP/Contents/Frameworks/${fw}.framework" ]; then
          echo "  Copying ${fw}.framework..."
          ditto "$SRC_FW" "$APP/Contents/Frameworks/${fw}.framework"
        fi
      done

      # ── Fix shorthand framework references ──
      # QtWebEngineCore and some other frameworks reference other Qt frameworks
      # as "@executable_path/../Frameworks/Name" without ".framework/Versions/A/Name".
      # macOS dyld should expand this automatically, but in practice it doesn't
      # always work. Fix by expanding to full framework paths.
      fix_shorthand_refs() {
        local fw_dir="$APP/Contents/Frameworks"
        find "$fw_dir" \( -name "*.dylib" -o -name "Qt*" -path "*/Versions/A/*" \) -type f 2>/dev/null | while IFS= read -r dylib; do
          file "$dylib" 2>/dev/null | grep -q "Mach-O" || continue
          otool -L "$dylib" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
            dep=$(echo "$line" | awk '{print $1}')
            case "$dep" in
              @executable_path/../Frameworks/*)
                if ! echo "$dep" | grep -q "\.framework"; then
                  dep_name=$(basename "$dep")
                  if [ -d "$fw_dir/${dep_name}.framework" ]; then
                    install_name_tool -change "$dep" \
                      "@executable_path/../Frameworks/${dep_name}.framework/Versions/A/${dep_name}" \
                      "$dylib" 2>/dev/null || true
                  fi
                fi
                ;;
            esac
          done
        done
      }
      fix_shorthand_refs

      # ── Fix QtWebEngineProcess.app: symlink frameworks/dylibs into its Frameworks dir ──
      # QtWebEngineProcess is a helper app inside QtWebEngineCore.framework. When it
      # loads Qt frameworks, @executable_path resolves to the helper app's own MacOS/
      # directory, not the main app's. We need to symlink all needed files into the
      # helper app's Frameworks directory.
      fix_webengine_process() {
        local WEP_DIR="$APP/Contents/Frameworks/QtWebEngineCore.framework/Versions/A/Helpers/QtWebEngineProcess.app"
        local WEP_FW="$WEP_DIR/Contents/Frameworks"
        local WEP_EXEC="$WEP_DIR/Contents/MacOS/QtWebEngineProcess"
        if [ ! -d "$WEP_DIR" ]; then return; fi
        mkdir -p "$WEP_FW"
        # Symlink dylibs from main app Frameworks (excluding QtWebEngineCore to avoid recursion)
        for dylib in "$APP/Contents/Frameworks/"*.dylib; do
          name=$(basename "$dylib")
          [ ! -e "$WEP_FW/$name" ] && ln -sf "../../../../../../../$name" "$WEP_FW/$name" 2>/dev/null || true
        done
        # Symlink Qt frameworks (excluding QtWebEngineCore to avoid infinite recursion)
        for fw_dir in "$APP/Contents/Frameworks/"Qt*.framework; do
          [ -d "$fw_dir" ] || continue
          name=$(basename "$fw_dir")
          [ "$name" = "QtWebEngineCore.framework" ] && continue
          [ ! -e "$WEP_FW/$name" ] && ln -sf "../../../../../../../$name" "$WEP_FW/$name" 2>/dev/null || true
        done
        # Change WEP references from @executable_path/../Frameworks/ to @rpath/
        # with the rpath pointing to main app's Frameworks via @loader_path
        if [ -f "$WEP_EXEC" ]; then
          otool -L "$WEP_EXEC" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
            dep=$(echo "$line" | awk '{print $1}')
            case "$dep" in
              @executable_path/../Frameworks/*.framework/*)
                new_dep="@rpath/$(basename "$dep").framework/Versions/A/$(basename "$dep")"
                install_name_tool -change "$dep" "$new_dep" "$WEP_EXEC" 2>/dev/null || true
                ;;
              @executable_path/../Frameworks/*)
                dep_name=$(basename "$dep")
                if [ -d "$APP/Contents/Frameworks/${dep_name}.framework" ]; then
                  new_dep="@rpath/${dep_name}.framework/Versions/A/${dep_name}"
                  install_name_tool -change "$dep" "$new_dep" "$WEP_EXEC" 2>/dev/null || true
                fi
                ;;
              /usr/local/opt/*/lib/*.framework/Versions/A/*)
                # macdeployqt sets absolute Homebrew paths in WEP; fix to @rpath
                fw_name=$(echo "$dep" | sed 's|.*/\(Qt[^/]*\)\.framework/.*|\1|')
                new_dep="@rpath/${fw_name}.framework/Versions/A/${fw_name}"
                install_name_tool -change "$dep" "$new_dep" "$WEP_EXEC" 2>/dev/null || true
                ;;
            esac
          done
        fi
      }
      fix_webengine_process

      # ── Remove Homebrew @rpath from main binary ──
      # Prevents duplicate class loading from both bundled and system Qt
      MAIN_BIN="$APP/Contents/MacOS/DiskRaptor"
      if [ -f "$MAIN_BIN" ]; then
        otool -l "$MAIN_BIN" 2>/dev/null | grep -A2 "LC_RPATH" | grep "path" | while IFS= read -r line; do
          rpath=$(echo "$line" | sed -n 's/.*path //p')
          if echo "$rpath" | grep -qE "/usr/local/opt/qt|/opt/homebrew/opt/qt"; then
            install_name_tool -delete_rpath "$rpath" "$MAIN_BIN" 2>/dev/null || true
            echo "  Removed Homebrew rpath: $rpath"
          fi
        done
      fi

      # ── Fix all absolute Homebrew references to use bundled paths ──
      # macdeployqt and the copied frameworks may still reference Homebrew
      # absolute paths. Fix them all to use @executable_path/../Frameworks/.
      fix_absolute_refs() {
        local fw_dir="$APP/Contents/Frameworks"
        # Fix dylib files
        find "$fw_dir" -name "*.dylib" -type f | while IFS= read -r dylib; do
          file "$dylib" 2>/dev/null | grep -q "Mach-O" || continue
          otool -L "$dylib" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
            dep=$(echo "$line" | awk '{print $1}')
            dep_name=$(basename "$dep")
            case "$dep" in
              @loader_path/../lib*)
                [ -f "$fw_dir/$dep_name" ] && install_name_tool -change "$dep" "@executable_path/../Frameworks/$dep_name" "$dylib" 2>/dev/null || true
                ;;
              /usr/local/opt/*/lib/*.framework/Versions/A/*)
                fw=$(echo "$dep_name" | sed 's/\.framework.*//')
                [ -d "$fw_dir/${fw}.framework" ] && install_name_tool -change "$dep" "@executable_path/../Frameworks/${fw}.framework/Versions/A/${fw}" "$dylib" 2>/dev/null || true
                ;;
              /usr/local/opt/*)
                if [ -f "$fw_dir/$dep_name" ]; then
                  install_name_tool -change "$dep" "@executable_path/../Frameworks/$dep_name" "$dylib" 2>/dev/null || true
                elif [ -d "$fw_dir/${dep_name%.dylib}.framework" ]; then
                  fw="${dep_name%.dylib}"
                  install_name_tool -change "$dep" "@executable_path/../Frameworks/${fw}.framework/Versions/A/${fw}" "$dylib" 2>/dev/null || true
                fi
                ;;
            esac
          done
        done
        # Fix Qt framework binaries too
        find "$fw_dir" -name "Qt*" -path "*/Versions/A/*" -type f 2>/dev/null | while IFS= read -r dylib; do
          file "$dylib" 2>/dev/null | grep -q "Mach-O" || continue
          otool -L "$dylib" 2>/dev/null | tail -n +2 | while IFS= read -r line; do
            dep=$(echo "$line" | awk '{print $1}')
            case "$dep" in
              /usr/local/opt/*/lib/*.framework/Versions/A/*)
                fw_name=$(echo "$dep" | sed 's|.*/\(Qt[^/]*\)\.framework/.*|\1|')
                new_ref="@executable_path/../Frameworks/${fw_name}.framework/Versions/A/${fw_name}"
                install_name_tool -change "$dep" "$new_ref" "$dylib" 2>/dev/null || true
                ;;
            esac
          done
        done
      }
      fix_absolute_refs

      # ── Remove unused plugin dirs that pull in missing frameworks ──
      for dir in platforminputcontexts; do
        if [ -d "$APP/Contents/PlugIns/$dir" ]; then
          echo "  Removing unused plugins: $dir"
          rm -rf "$APP/Contents/PlugIns/$dir"
        fi
      done

      # ── Remove unnecessary QML modules that cause missing-framework errors ──
      QML_DEPLOY_DIR="$APP/Contents/Resources/qml"
      if [ -d "$QML_DEPLOY_DIR" ]; then
        for mod in QtLocation QtMultimedia QtStateMachine Qt3D QtQuick3D QtQuickTimeline QtVirtualKeyboard QtSpatialAudio; do
          mod_path="$QML_DEPLOY_DIR/$mod"
          if [ -d "$mod_path" ]; then
            echo "  Removing unused QML module: $mod"
            rm -rf "$mod_path"
          fi
        done
      fi
    else
      echo "  WARNING: macdeployqt not found ??? Qt frameworks may be missing"
    fi

    # ── Sign with developer certificate, fall back to ad-hoc ──
    # Create temp signing keychain to avoid GUI password prompts
    if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
      security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
    fi
    SIGN_KEYCHAIN="/tmp/diskraptor-build-$$.keychain"
    SIGN_KEYCHAIN_PASS="diskraptor"
    trap 'rm -f "$SIGN_KEYCHAIN" 2>/dev/null; security list-keychains -s ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain 2>/dev/null' EXIT
    security create-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true
    security unlock-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true
    security set-keychain-settings -t 86400 "$SIGN_KEYCHAIN" 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true
    security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -P "" -o /tmp/cert_export.p12 2>/dev/null || true
    security import /tmp/cert_export.p12 -k "$SIGN_KEYCHAIN" -P "" -A -T /usr/bin/codesign -T /usr/bin/productbuild 2>/dev/null || true
    rm -f /tmp/cert_export.p12 2>/dev/null || true
    security list-keychains -s "$SIGN_KEYCHAIN" ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain 2>/dev/null || true

    # Sign with developer certificate if available, fall back to ad-hoc
    if [ -n "$CODESIGN_IDENTITY" ] && [ "$CODESIGN_IDENTITY" != "-" ]; then
      ID_ACCESSIBLE=true
      security find-identity -v -p codesigning 2>/dev/null | grep -F -q "$CODESIGN_IDENTITY" || ID_ACCESSIBLE=false
      if [ "$ID_ACCESSIBLE" = true ]; then
        echo "  Signing with: $CODESIGN_IDENTITY"
        codesign --deep --force --options=runtime \
          --entitlements "$ENTITLEMENTS" \
          --sign "$CODESIGN_IDENTITY" \
          --keychain "$SIGN_KEYCHAIN" \
          "$APP" 2>&1 || true
      else
        echo "  Signing cert not accessible — ad-hoc signing"
      fi
    else
      echo "  No developer cert found — ad-hoc signing"
    fi
    # Always ensure the app is at least ad-hoc signed
    codesign --deep --force --options=runtime \
      --entitlements "$ENTITLEMENTS" \
      --sign - \
      "$APP" 2>/dev/null || true

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
    # Also create a signed PKG for distribution (not MAS). Look for Installer signing identity.
    INSTALLER_CERT=""
    INSTALLER_CERT="$(security find-identity -v -p basic 2>/dev/null | grep -i "Installer\|Developer ID Installer\|Mac Developer Installer" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
    PKG_OUT="dist/DiskRaptor-$VERSION-macos.pkg"
    if [ -n "$INSTALLER_CERT" ]; then
      echo "  Creating signed PKG: $PKG_OUT (signed with $INSTALLER_CERT)"
      productbuild --component "$APP" /Applications --sign "$INSTALLER_CERT" --identifier "diskraptor" --version "$VERSION" "$PKG_OUT" 2>&1 || true
    else
      echo "  Creating unsigned PKG: $PKG_OUT (no installer cert found)"
      productbuild --component "$APP" /Applications --identifier "diskraptor" --version "$VERSION" "$PKG_OUT" 2>&1 || true
    fi
    echo "  PKG: $PKG_OUT"
    echo ""
    echo "  Run: open dist/DiskRaptor.app"

    # ── MAS (Mac App Store) PKG build (default, skip with --no-mas) ──
    if [ "$NO_MAS" = false ]; then
      build_mas_pkg
    fi
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
    # Create a .deb package if dpkg-deb is available
    if command -v dpkg-deb &>/dev/null; then
      echo "  Creating .deb package..."
      PKGDIR="dist/deb"
      mkdir -p "$PKGDIR/DEBIAN"
      mkdir -p "$PKGDIR/usr/bin"
      # Minimal control file
      cat > "$PKGDIR/DEBIAN/control" <<EOF
Package: diskraptor
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: DiskRaptor <noreply@example.com>
Description: DiskRaptor - disk space analyzer
EOF
      # Install binary
      cp dist/DiskRaptor "$PKGDIR/usr/bin/DiskRaptor" 2>/dev/null || true
      chmod 0755 "$PKGDIR/usr/bin/DiskRaptor" 2>/dev/null || true
      dpkg-deb --build "$PKGDIR" "dist/DiskRaptor-$VERSION-linux-amd64.deb" 2>/dev/null || true
      echo "  DEB: dist/DiskRaptor-$VERSION-linux-amd64.deb"
      rm -rf "$PKGDIR"
    else
      echo "  SKIP DEB: 'dpkg-deb' not found"
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
      if command -v fakeroot &>/dev/null; then
        fakeroot dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-$VERSION-amd64.deb"
      else
        dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-$VERSION-amd64.deb"
      fi
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
if [ "$NO_MAS" = false ] && [ "$PLATFORM" = "macos" ]; then
  echo "  MAS PKG: dist-mas/DiskRaptor-$VERSION-mas.pkg"
fi
echo ""

