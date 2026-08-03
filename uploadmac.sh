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
# App Store Connect API key credentials — MUST come from the environment
# (secrets), never hardcoded.
API_KEY="${APPLE_API_KEY:-}"
API_ISSUER="${APPLE_API_ISSUER:-}"
PKG_PATH="dist-mas/DiskRaptor-$VERSION-mas.pkg"

if [ ! -f "$PKG_PATH" ]; then
  echo "ERROR: $PKG_PATH not found."
  echo "Run ./mas-build.sh first to create the signed MAS package."
  exit 1
fi
if [ -z "$API_KEY" ] || [ -z "$API_ISSUER" ]; then
  echo "ERROR: APPLE_API_KEY / APPLE_API_ISSUER not set in environment."
  echo "       Set them in .env or as GitHub secrets."
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
