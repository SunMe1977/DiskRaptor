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
check_version "qt-app/CMakeLists.txt"         "CMakeLists.txt (Qt)"  's/.*project(DiskRaptor VERSION \([0-9.]*\)[^0-9.].*/\1/p'
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
TAURI_TARGET=""
if [ "$PLATFORM" = "macos" ]; then
  # Check if we can build for arm64 (Apple Silicon)
  if rustc --print cfg --target aarch64-apple-darwin 2>/dev/null | grep -q "target_os"; then
    ARCHS="x86_64 arm64"
    TAURI_TARGET="--target universal-apple-darwin"
    echo "  Building universal binary (x86_64 + arm64)"
  fi
fi

echo "  Building Tauri app ($([ -n "$TAURI_TARGET" ] && echo 'universal' || echo 'native arch'))..."
# Remove stale bundles from previous manual `npx tauri build`/`cargo build` runs
# so a stale app can never be launched by mistake.
rm -rf src-tauri/target/release/bundle src-tauri/target/debug/bundle src-tauri/target/universal-apple-darwin/release/bundle 2>/dev/null || true
cd src-tauri
# `app` bundle only exists on macOS; on Linux we only need the raw binary.
TAURI_BUNDLES="app"
[ "$PLATFORM" = "linux" ] && TAURI_BUNDLES="--no-bundle"
npx tauri build --bundles "$TAURI_BUNDLES" --ci $TAURI_TARGET 2>&1 || true
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
    echo "  Using Tauri-generated app bundle..."
    TAURI_OUT="src-tauri/target/release"
    [ -n "$TAURI_TARGET" ] && TAURI_OUT="src-tauri/target/universal-apple-darwin/release"
    TAURI_APP="$TAURI_OUT/bundle/macos/DiskRaptor.app"
    if [ ! -d "$TAURI_APP" ]; then
      echo "  ERROR: Tauri bundle not found at $TAURI_APP"
      echo "  Tauri build may have failed. Check output above."
      exit 1
    fi

    APP="dist/DiskRaptor.app"
    cp -R "$TAURI_APP" "$APP"

    # Remove test-data helper binaries (not part of the shipped app)
    rm -f "$APP/Contents/MacOS/gen-testdata" "$APP/Contents/MacOS/clean-testdata"

    # Sanity-check the generated Info.plist (guards against ITMS-90049)
    BUNDLE_ID_PLIST="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null || true)"
    EXEC_PLIST="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist" 2>/dev/null || true)"
    echo "  Bundle ID:   ${BUNDLE_ID_PLIST:-<MISSING>}"
    echo "  Executable:  ${EXEC_PLIST:-<MISSING>}"
    if [ -z "$BUNDLE_ID_PLIST" ] || [ -z "$EXEC_PLIST" ]; then
      echo "  ERROR: Generated Info.plist is missing CFBundleIdentifier/CFBundleExecutable."
      exit 1
    fi
    if [ ! -f "$APP/Contents/MacOS/$EXEC_PLIST" ]; then
      echo "  ERROR: CFBundleExecutable ($EXEC_PLIST) does not match a file in Contents/MacOS/."
      echo "         This is what triggers ITMS-90049."
      exit 1
    fi

    # Verify the binary contains both architectures (App Store warning 91167)
    if command -v lipo &>/dev/null; then
      BIN_ARCHS="$(lipo -archs "$APP/Contents/MacOS/$EXEC_PLIST" 2>/dev/null || true)"
      echo "  Architectures: ${BIN_ARCHS:-<none>}"
      if [ -z "$BIN_ARCHS" ] || ! echo "$BIN_ARCHS" | grep -qi "arm64"; then
        echo "  WARNING: Binary is not universal (missing arm64)."
        echo "           The App Store will warn about this (code 91167)."
      fi
    fi

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

    # Binary: Tauri build is self-contained (Qt app removed)
    if [ ! -f src-tauri/target/release/diskraptor ]; then
      echo "  ERROR: Tauri binary not found at src-tauri/target/release/diskraptor"
      echo "  Tauri build may have failed. Check output above."
      exit 1
    fi
    cp src-tauri/target/release/diskraptor dist/DiskRaptor

    # Frontend + Images
    cp -r frontend dist/
    mkdir -p dist/images
    cp -r images/* dist/images/ 2>/dev/null || true

    # Rust scanner
    if [ -f src-tauri/target/release/libdiskraptor_scanner.so ]; then
      cp src-tauri/target/release/libdiskraptor_scanner.so dist/
    fi

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
Depends: libc6 (>= 2.31), libstdc++6 (>= 10), libgcc-s1 (>= 10), libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1, librsvg2-2, smartmontools
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

    # Bundle Qt libraries into DEB (skipped: Qt removed, Tauri is self-contained)
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
        fakeroot dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-${VERSION}-linux-amd64.deb"
      else
        dpkg-deb --build "$DEB_DIR" "dist/DiskRaptor-${VERSION}-linux-amd64.deb"
      fi
      echo "  DEB: dist/DiskRaptor-${VERSION}-linux-amd64.deb"
    else
      echo "  SKIP DEB: 'dpkg-deb' not installed"
    fi
    echo ""
    echo "  Run: LD_LIBRARY_PATH=dist/lib ./dist/DiskRaptor"
    echo "  Or install: sudo dpkg -i dist/DiskRaptor-${VERSION}-linux-amd64.deb"
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

