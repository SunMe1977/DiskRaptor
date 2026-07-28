#!/bin/bash
# DiskRaptor Mac App Store Upload Script
# Usage: ./uploadmac.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f ".env" ]; then
  set -a
  . ./.env
  set +a
fi

: "${BUNDLE_ID:=diskraptor}"
: "${VERSION:=$(node -p "require('./package.json').version" 2>/dev/null || grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4 || echo "0.0.2")}"
API_KEY="PAWX8HDNG4"
API_ISSUER="1782f6bd-09a4-4e82-84b5-9adbb9e1003b"

APP_SRC="dist/DiskRaptor.app"
MAS_DIR="dist-mas"
APP_DST="$MAS_DIR/DiskRaptor.app"
PKG_PATH="$MAS_DIR/DiskRaptor-$VERSION-mas.pkg"

if [ ! -d "$APP_SRC" ]; then
  echo "ERROR: $APP_SRC not found. Run build.sh first."
  exit 1
fi

echo "[1] Copying .app..."
rm -rf "$MAS_DIR"
mkdir -p "$MAS_DIR"
cp -R "$APP_SRC" "$APP_DST"

plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$APP_DST/Contents/Info.plist" 2>/dev/null || true
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DST/Contents/Info.plist" 2>/dev/null || true
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DST/Contents/Info.plist" 2>/dev/null || true

echo "[2] Creating PKG..."
productbuild \
  --component "$APP_DST" /Applications \
  --identifier "$BUNDLE_ID" \
  --version "$VERSION" \
  "$PKG_PATH" 2>&1

echo "  PKG: $(ls -lh "$PKG_PATH" | awk '{print $5}')"

echo "[3] Uploading to App Store Connect..."
xcrun altool --upload-app \
  --file "$PKG_PATH" \
  --apiKey "$API_KEY" \
  --apiIssuer "$API_ISSUER" \
  --output-format json 2>&1

echo ""
echo "=== UPLOAD COMPLETE ==="
echo "Check status in App Store Connect."
