#!/bin/bash
# DiskRaptor Mac App Store Build Script
# Usage: ./mas-build.sh [upload]
#   upload  - auch zu Transporter hochladen
set -euo pipefail

# Load environment variables from .env file (secrets for signing/notarization)
if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

VERSION="0.0.5"
IDENTIFIER="diskraptor"
APP_NAME="DiskRaptor"
TEAM_ID="7TK444BCPC"
DIST_CERT="Apple Distribution: Hansjoerg Hofer (${TEAM_ID})"
OUTPUT_DIR="$(pwd)/dist-mas"

echo "=========================================="
echo "  DiskRaptor MAS Build v$VERSION"
echo "=========================================="
echo ""

# ── 1. Build ──────────────────────────────────
echo "[1] Building app..."
bash build.sh
echo ""

# ── 2. Prepare .app Bundle ────────────────────
echo "[2] Preparing MAS .app bundle..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
APP_SRC="$(pwd)/dist/DiskRaptor.app"
APP_DST="$OUTPUT_DIR/DiskRaptor.app"

if [ ! -d "$APP_SRC" ]; then
  echo "ERROR: $APP_SRC not found. build.sh must succeed first."
  exit 1
fi

cp -R "$APP_SRC" "$APP_DST"

# Info.plist an MAS anpassen
plutil -replace CFBundleIdentifier -string "$IDENTIFIER" "$APP_DST/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DST/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DST/Contents/Info.plist"

echo "  Bundle ID: $IDENTIFIER"
echo ""

# ── 3. Sign with Apple Distribution ───────────
echo "[3] Signing with Apple Distribution..."
ENTITLEMENTS="$(pwd)/installer/DiskRaptor-MAS.entitlements"

# Unlock keychain to avoid GUI password prompts
if [ -z "${KEYCHAIN_PASSWORD:-}" ]; then
  echo "  WARNING: KEYCHAIN_PASSWORD not set - codesign may prompt for password"
else
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  security set-keychain-settings -t 14400 ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
fi

# Check if Distribution cert is accessible
DIST_ACCESSIBLE=true
security find-identity -v -p codesigning 2>/dev/null | grep -F -q "$DIST_CERT" || DIST_ACCESSIBLE=false

if [ "$DIST_ACCESSIBLE" = true ]; then
  echo "  Signing with: $DIST_CERT"
  codesign --deep --force --options=runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$DIST_CERT" \
    "$APP_DST" 2>&1
  echo "  Verification:"
  codesign -dvvv "$APP_DST" 2>&1 | head -5
else
  echo "  WARNING: Distribution cert not accessible."
  echo "  The .app will be ad-hoc signed (not valid for MAS)."
  codesign --deep --force --options=runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign - \
    "$APP_DST" 2>/dev/null || true
fi
echo ""

# ── 4. Create .pkg ────────────────────────────
echo "[4] Creating signed .pkg..."
PKG_PATH="$OUTPUT_DIR/DiskRaptor-$VERSION-mas.pkg"

if [ "$DIST_ACCESSIBLE" = true ]; then
  productbuild \
    --component "$APP_DST" /Applications \
    --sign "$DIST_CERT" \
    --identifier "$IDENTIFIER" \
    --version "$VERSION" \
    "$PKG_PATH" 2>&1
else
  productbuild \
    --component "$APP_DST" /Applications \
    --identifier "$IDENTIFIER" \
    --version "$VERSION" \
    "$PKG_PATH" 2>&1
fi

echo "  PKG: $PKG_PATH"
ls -lh "$PKG_PATH"
echo ""

# ── 5. Upload via Transporter ────────────────
if [ "${1:-}" = "upload" ]; then
  echo "[5] Uploading to App Store Connect via Transporter..."

  # Prüfe ob Transporter (Xcode) installiert ist
  if ! xcrun --show-sdk-path &>/dev/null 2>&1; then
    echo "  ERROR: Xcode command line tools nicht gefunden."
    echo "  Installiere Xcode und führe aus: sudo xcode-select -s /Applications/Xcode.app"
    exit 1
  fi

  # Alternative 1: iTMSTransporter (älter)
  if command -v iTMSTransporter &>/dev/null; then
    echo "  Using iTMSTransporter..."
    iTMSTransporter -m upload -f "$PKG_PATH" -u "${APPLE_ID:?APPLE_ID not set}" -vp "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD not set}"
  else
    echo "  Using xcrun transporter (Xcode 14+)..."
    xcrun transporter \
      --source "$PKG_PATH" \
      --type package \
      --apple-id "${APPLE_ID:-}" \
      --team-id "$TEAM_ID" \
      --password "${APPLE_APP_PASSWORD:-}" \
      --verbose 2>&1
  fi

  echo ""
  echo "  Upload complete. Check status in App Store Connect."
else
  echo "[5] Skipping upload (add 'upload' argument to upload)"
  echo "  Usage: ./mas-build.sh upload"
fi

echo ""
echo "=========================================="
echo "  MAS BUILD COMPLETE"
echo "=========================================="
echo ""
echo "  .app:  $APP_DST"
echo "  .pkg:  $PKG_PATH"
echo ""
echo "  Upload manually:"
echo "    xcrun transporter --source \"$PKG_PATH\" --type package --apple-id \"you@apple.com\" --team-id \"$TEAM_ID\""
