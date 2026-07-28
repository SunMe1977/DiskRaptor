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

: "${VERSION:=$(node -p "require('./package.json').version" 2>/dev/null || grep -o '"version": "[^"]*"' package.json | cut -d'"' -f4 || echo "0.0.2")}"
API_KEY="PAWX8HDNG4"
API_ISSUER="1782f6bd-09a4-4e82-84b5-9adbb9e1003b"
PKG_PATH="dist-mas/DiskRaptor-$VERSION-mas.pkg"

if [ ! -f "$PKG_PATH" ]; then
  echo "ERROR: $PKG_PATH not found."
  echo "Run ./mas-build.sh first to create the signed MAS package."
  exit 1
fi

echo "Uploading $PKG_PATH ($(ls -lh "$PKG_PATH" | awk '{print $5}'))..."
xcrun altool --upload-app \
  --file "$PKG_PATH" \
  --apiKey "$API_KEY" \
  --apiIssuer "$API_ISSUER" \
  --output-format json 2>&1

echo ""
echo "Check status in App Store Connect."
