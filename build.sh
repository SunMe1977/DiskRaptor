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
VERSION="$(node -p "require('$(dirname "$0")/package.json').version" 2>/dev/null)"
[ -z "$VERSION" ] && VERSION="$(grep -o '"version": "[^"]*"' "$(dirname "$0")/package.json" | cut -d'"' -f4)"
[ -z "$VERSION" ] && VERSION="0.0.2"

# ── Version consistency check ──────────────────────────────────
ROOT="$(dirname "$0")"
MISMATCH=0
check_version() {
  local file="$1" label="$2" val
  val="$(sed -n "$3" "$ROOT/$file" 2>/dev/null | head -1)"
  if [ -n "$val" ] && [ "$val" != "$VERSION" ]; then
    echo "  ⚠ $label: expected $VERSION, got $val ($file)"
    MISMATCH=$((MISMATCH + 1))
  fi
}
check_version "src-tauri/Cargo.toml"         "Cargo.toml"           's/.*version = "\([^"]*\)".*/\1/p'
check_version "qt-app/CMakeLists.txt"         "CMakeLists.txt (Qt)"  's/.*project(DiskRaptor VERSION \([0-9.]*\)).*/\1/p'
check_version "qt-app/src/main.cpp"           "main.cpp"             's/.*setApplicationVersion("\([^"]*\)").*/\1/p'
check_version "vcpkg.json"                    "vcpkg.json"           's/.*"version": "\([^"]*\)".*/\1/p'
check_version "installer/nsis/DiskRaptor.nsi" "DiskRaptor.nsi"       's/.*PRODUCT_VERSION "\([^"]*\)".*/\1/p'
check_version "modulesPro/duplicateScan/duplicate_scan.cpp" "duplicate_scan.cpp" 's/.*g_moduleVersion = "\([^"]*\)".*/\1/p'
if [ "$MISMATCH" -gt 0 ]; then
  echo "  Update these files to match package.json version $VERSION"
fi
echo ""

# ── Tool paths (override via env vars) ──────────────────────────
: "${QT_DIR:=/usr/local/opt/qt}"                  # macOS Homebrew default
: "${QT_VERSION:=6}"                               # Qt major version
: "${RUST_TARGET:=release}"                        # release or debug
: "${SIGNING_IDENTITY:=}"                          # macOS codesign identity
: "${APPLE_ID:=}"                                  # Apple ID for notarization
: "${APPLE_TEAM_ID:=}"                             # Apple Team ID
: "${BUNDLE_ID:=diskraptor}"                      # Bundle identifier

echo "=========================================="
echo "  DiskRaptor $VERSION - $PLATFORM Build"
echo "=========================================="
echo ""

# ── MAS (Mac App Store) build function ────────────────────────────
build_mas_pkg() {
  local APP_SRC="dist/DiskRaptor.app"
  local MAS_DIR="dist-mas"
  local APP_DST="$MAS_DIR/DiskRaptor.app"
  local IDENTIFIER="${BUNDLE_ID}"
  local DIST_CERT="${APPLE_DIST_CERT:-${SIGNING_IDENTITY:-}}"
  local ENTITLEMENTS="installer/DiskRaptor-MAS.entitlements"

  # Ensure Tauri app is built
  if [ ! -d "$APP_SRC" ]; then
    echo "  ERROR: $APP_SRC not found. Run main build first."
    return 1
  fi

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
  local TEAM_ID="${APPLE_TEAM_ID:-}"
  local SIGN_FP=$(security find-certificate -c "3rd Party Mac Developer Application" -p 2>/dev/null | openssl x509 -inform pem -sha1 -fingerprint -noout 2>/dev/null)
  for ext in mobileprovision provisionprofile; do
    for f in ~/Library/MobileDevice/Provisioning\ Profiles/*."$ext"; do
      [ -f "$f" ] || continue
      security cms -D -i "$f" 2>/dev/null > /tmp/_pp_match.plist
      local FP=$(/usr/libexec/PlistBuddy -c "Print :DeveloperCertificates:0" /tmp/_pp_match.plist 2>/dev/null | openssl x509 -inform der -sha1 -fingerprint -noout 2>/dev/null)
      if [ "$FP" = "$SIGN_FP" ]; then
        PROFILE_SRC="$f"
        break 2
      fi
    done
  done
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

  # Unlock keychain to avoid GUI password prompts
  if [ -z "${KEYCHAIN_PASSWORD:-}" ]; then
    echo "  WARNING: KEYCHAIN_PASSWORD not set - codesign may prompt for password"
  else
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
    security set-keychain-settings -t 14400 ~/Library/Keychains/login.keychain-db 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
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
      --keychain ~/Library/Keychains/login.keychain-db \
      "$APP_DST" 2>&1 || true
    # Re-sign QtWebEngineProcess after --deep (--deep re-signs nested .apps but can strip entitlements)
    local WEP="$APP_DST/Contents/Frameworks/QtWebEngineCore.framework/Versions/A/Helpers/QtWebEngineProcess.app"
    if [ -d "$WEP" ]; then
      echo "  Re-signing QtWebEngineProcess.app (ensuring sandbox entitlement)..."
      codesign --force --options=runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$DIST_CERT" \
        --keychain ~/Library/Keychains/login.keychain-db \
        "$WEP" 2>&1 || true
    fi
    codesign -dvvv "$APP_DST" 2>&1 | head -5 || true
  else
    echo "  WARNING: Distribution cert not accessible ($DIST_CERT)"
    echo "  Falling back to ad-hoc signing (invalid for MAS)."
    codesign --deep --force --options=runtime \
      --entitlements "$ENTITLEMENTS" \
      --sign - \
      --keychain ~/Library/Keychains/login.keychain-db \
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
        --team-id "${APPLE_TEAM_ID:-}" \
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
for cmd in node rustc cargo git; do
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

# Tauri build dependencies check
case "$PLATFORM" in
  macos)
    echo "  Platform: macOS"
    ;;
  linux)
    echo "  Platform: Linux — ensure webkit2gtk is installed: sudo apt-get install libwebkit2gtk-4.1-dev"
    ;;
  windows)
    echo "  Platform: Windows — ensure WebView2 runtime is available (built into Win 10+)"
    ;;
esac

# ?????? Build ???????????????????????????????????????????????????????????????????????????????????????????????????????????????
echo ""
echo "[2] Building..."

# Detect architectures for universal binary
ARCHS="x86_64"
if [ "$PLATFORM" = "macos" ]; then
  # Check if we can build for arm64 (Apple Silicon)
  if rustc --print cfg --target aarch64-apple-darwin 2>/dev/null | grep -q "target_os"; then
    ARCHS="x86_64 arm64"
    echo "  Building universal binary (x86_64 + arm64)"
  fi
fi

echo "  Copying assets to frontend/..."
cp -r images frontend/ 2>/dev/null || true
cp -r src-tauri/icons frontend/ 2>/dev/null || true
cp -r modulesPro frontend/ 2>/dev/null || true
echo "  OK"

echo "  Building Tauri app (native arch)..."
cd src-tauri
case "$PLATFORM" in
  macos)   BUNDLES="app,dmg" ;;
  linux)   BUNDLES="deb,appimage" ;;
  windows) BUNDLES="nsis" ;;
  *)       echo "Unknown platform '$PLATFORM', defaulting to native bundle"; BUNDLES="" ;;
esac
BUNDLE_ARGS=""
[ -n "$BUNDLES" ] && BUNDLE_ARGS="--bundles $BUNDLES"
npx tauri build $BUNDLE_ARGS --ci 2>&1
cd ..

# Also build scanner library for backward compat
echo "  Building scanner library..."
cd src-tauri
cargo build --release -p diskraptor_scanner 2>/dev/null || true
cd ..

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

    # Binary (Tauri)
    TAURI_BIN="src-tauri/target/release/diskraptor"
    if [ ! -f "$TAURI_BIN" ]; then
      echo "  ERROR: Tauri binary not found at $TAURI_BIN"
      echo "  Tauri build may have failed. Check output above."
      exit 1
    fi
    cp "$TAURI_BIN" "$APP/Contents/MacOS/"

    # Resources (frontend)
    cp -r frontend "$APP/Contents/Resources/"

    # Rust scanner dylib (kept for backward compat, now bundled inside Tauri binary)
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
    <key>CFBundleVersion</key><string>0.0.8</string>
    <key>CFBundleShortVersionString</key><string>0.0.8</string>
    <key>ITSAppUsesNonExemptEncryption</key><false/>
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

    # No Qt deployment needed — Tauri app is self-contained

    # ── Create temporary signing keychain to avoid GUI password prompts ──
    SIGN_KEYCHAIN="/tmp/diskraptor-build-$$.keychain"
    if [ -z "${KEYCHAIN_PASSWORD:-}" ]; then
      echo "  ERROR: KEYCHAIN_PASSWORD not set - cannot sign"
      exit 1
    fi
    SIGN_KEYCHAIN_PASS="$KEYCHAIN_PASSWORD"
    trap 'rm -f "$SIGN_KEYCHAIN" 2>/dev/null; security list-keychains -s ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain 2>/dev/null' EXIT

    # Unlock login keychain first so export works
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true

    security create-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true
    security unlock-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true
    security set-keychain-settings -t 86400 "$SIGN_KEYCHAIN" 2>/dev/null || true
    security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN" 2>/dev/null || true

    # Export certs from login keychain and import to temp keychain
    echo "  Exporting signing certs to temp keychain..."
    security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -P "$KEYCHAIN_PASSWORD" -o /tmp/cert_export.p12 2>/dev/null || true
    if [ -f /tmp/cert_export.p12 ] && [ -s /tmp/cert_export.p12 ]; then
      security import /tmp/cert_export.p12 -k "$SIGN_KEYCHAIN" -P "$KEYCHAIN_PASSWORD" -A -T /usr/bin/codesign -T /usr/bin/productbuild 2>/dev/null || true
      echo "  Certs imported to temp keychain"
    else
      echo "  WARNING: Cert export failed - falling back to login keychain"
      SIGN_KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
    fi
    rm -f /tmp/cert_export.p12 2>/dev/null || true
    security list-keychains -s "$SIGN_KEYCHAIN" ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain 2>/dev/null || true

    # ── Sign with developer certificate, fall back to ad-hoc ──

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
        codesign --deep --force --options=runtime \
          --entitlements "$ENTITLEMENTS" \
          --sign - \
          --keychain "$SIGN_KEYCHAIN" \
          "$APP" 2>/dev/null || true
      fi
    else
      echo "  No developer cert found — ad-hoc signing"
      codesign --deep --force --options=runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign - \
        --keychain "$SIGN_KEYCHAIN" \
        "$APP" 2>/dev/null || true
    fi

    echo ""
    echo "  Creating DMG..."
    if [ ! -d "$APP" ]; then
      echo "  ERROR: .app bundle not found at $APP"
      exit 1
    fi
    if ! hdiutil create -volname "DiskRaptor" -srcfolder "$APP" -ov -format UDZO "dist/DiskRaptor-$VERSION-macos.dmg" 2>&1; then
      echo "  ERROR: hdiutil failed (exit code $?)"
      ls -la dist/
      exit 1
    fi


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
      productbuild --component "$APP" /Applications --sign "$INSTALLER_CERT" --identifier "$BUNDLE_ID" --version "$VERSION" "$PKG_OUT" 2>&1 || true
    else
      echo "  Creating unsigned PKG: $PKG_OUT (no installer cert found)"
      productbuild --component "$APP" /Applications --identifier "$BUNDLE_ID" --version "$VERSION" "$PKG_OUT" 2>&1 || true
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

    echo "  Creating .deb package..."
    DEB_DIR="deb"
    rm -rf "$DEB_DIR"
    mkdir -p "$DEB_DIR/DEBIAN"
    mkdir -p "$DEB_DIR/usr/bin"
    mkdir -p "$DEB_DIR/usr/lib/diskraptor"
    mkdir -p "$DEB_DIR/usr/share/applications"
    mkdir -p "$DEB_DIR/usr/share/icons/hicolor/128x128/apps"
    mkdir -p "$DEB_DIR/usr/share/icons/hicolor/256x256/apps"

    # Control file
    cat > "$DEB_DIR/DEBIAN/control" <<EOF
Package: diskraptor
Version: $VERSION
Section: utils
Priority: optional
Architecture: amd64
Depends: libc6 (>= 2.31), libstdc++6 (>= 10), libgcc-s1 (>= 10)
Maintainer: DiskRaptor Team
Description: Ultra-fast disk space analyzer with virtual tree view, pie chart, and live progress.
 Scans millions of files using a parallel Rust engine.
EOF

    # Post-install: register desktop database and icon cache
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

    # Launcher script (at /usr/bin/diskraptor, lower-case, for the .desktop file)
    cat > "$DEB_DIR/usr/bin/diskraptor" << 'LAUNCHER'
#!/bin/bash
export LD_LIBRARY_PATH="/usr/lib/diskraptor:$LD_LIBRARY_PATH"
exec /usr/bin/DiskRaptor "$@"
LAUNCHER
    chmod 755 "$DEB_DIR/usr/bin/diskraptor"

    # Binary
    cp dist/DiskRaptor "$DEB_DIR/usr/bin/"
    chmod 755 "$DEB_DIR/usr/bin/DiskRaptor"

    # Desktop entry
    cat > "$DEB_DIR/usr/share/applications/diskraptor.desktop" << 'DESKTOP'
[Desktop Entry]
Name=DiskRaptor
Comment=Ultra-fast disk space analyzer
Exec=diskraptor
Icon=diskraptor
Terminal=false
Type=Application
Categories=Utility;System;FileTools;
StartupNotify=true
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
      ffmpeg -y -i images/logo6_original.png -vf "scale=128:128" "$DEB_DIR/usr/share/icons/hicolor/128x128/apps/diskraptor.png" 2>/dev/null || true
    fi

    # Bundle Qt libraries into DEB
    cp -r dist/lib/*.so* "$DEB_DIR/usr/lib/diskraptor/" 2>/dev/null || true

    # Rust scanner library
    if [ -f dist/libdiskraptor_scanner.so ]; then
      cp dist/libdiskraptor_scanner.so "$DEB_DIR/usr/lib/diskraptor/"
    fi

    # Frontend + images (matches search paths in main.cpp)
    mkdir -p "$DEB_DIR/usr/share/diskraptor"
    cp -r dist/frontend "$DEB_DIR/usr/share/diskraptor/"
    cp -r dist/images "$DEB_DIR/usr/share/diskraptor/" 2>/dev/null || true

    if command -v dpkg-deb &>/dev/null; then
      if command -v fakeroot &>/dev/null; then
        fakeroot dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-${VERSION}-amd64.deb"
      else
        dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-${VERSION}-amd64.deb"
      fi
      echo "  DEB: dist/DiskRaptor-${VERSION}-amd64.deb"
    else
      echo "  SKIP DEB: 'dpkg-deb' not installed"
    fi
    echo ""
    echo "  Run: LD_LIBRARY_PATH=dist/lib ./dist/DiskRaptor"
    echo "  Or install: sudo dpkg -i dist/DiskRaptor-${VERSION}-amd64.deb"
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

