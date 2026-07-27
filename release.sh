#!/bin/bash
# DiskRaptor Release Upload Script — pure curl, no gh CLI
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(node -p "require('${SCRIPT_DIR}/package.json').version" 2>/dev/null)"
[ -z "$VERSION" ] && VERSION="$(grep -o '"version": "[^"]*"' "${SCRIPT_DIR}/package.json" | cut -d'"' -f4)"
[ -z "$VERSION" ] && VERSION="0.0.2"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"
API="https://api.github.com"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""

# ── Token (gh keyring > env var) ──────────────
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(gh auth token 2>/dev/null || true)
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: No token found. Run: gh auth login  or  set GH_TOKEN"
  exit 1
fi
echo "  Token: OK (${#TOKEN} chars)"

CURL() {
  curl -sS -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" "$@"
}

# ── Detect platform assets ────────────────────
PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Darwin*)
    echo "  Platform: macOS"
    ASSETS="dist/DiskRaptor-$VERSION-macos.dmg"
    for f in dist/DiskRaptor-$VERSION-macos.pkg; do [ -f "$f" ] && ASSETS="$ASSETS $f"; done
    ;;
  Linux*)
    echo "  Platform: Linux"
    ASSETS="dist/DiskRaptor-$VERSION-amd64.deb"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "  Platform: Windows"
    ASSETS=""
    for f in dist/DiskRaptor_*_Setup.exe; do [ -f "$f" ] && ASSETS="$ASSETS $f"; done
    ;;
  *)
    echo "Unknown OS: $PLATFORM"
    exit 1
    ;;
esac

# ── Ensure release exists ────────────────────
echo ""
echo "  Ensuring release $TAG exists..."

RELEASE_JSON=$(CURL "$API/repos/$GH_REPO/releases/tags/$TAG" 2>/dev/null || true)
RELEASE_ID=$(echo "$RELEASE_JSON" | grep -o '"id": [0-9]*' | head -1 | awk '{print $2}' || true)

if [ -z "$RELEASE_ID" ]; then
  echo "    Creating release $TAG..."
  RELEASE_JSON=$(CURL -X POST "$API/repos/$GH_REPO/releases" \
    -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"DiskRaptor v$VERSION\",\"body\":\"\"}" 2>/dev/null)
  RELEASE_ID=$(echo "$RELEASE_JSON" | grep -o '"id": [0-9]*' | head -1 | awk '{print $2}' || true)
  if [ -z "$RELEASE_ID" ]; then
    echo "    ERROR: Failed to create release. Response:"
    echo "$RELEASE_JSON" | head -5
    exit 1
  fi
  echo "    Created release ID: $RELEASE_ID"
else
  echo "    Release exists (ID: $RELEASE_ID)"
fi

UPLOAD_URL=$(echo "$RELEASE_JSON" | grep -o '"upload_url": "[^"]*"' | head -1 | sed 's/"upload_url": "//;s/"//;s/{?name,label}//')
echo "    Upload URL: $UPLOAD_URL"

# ── Delete stale assets ──────────────────────
echo ""
echo "  Cleaning stale assets..."
# Collect asset IDs for all names we intend to upload (including .speedtest)
STALE_NAMES=""
for FILE in $ASSETS; do
  STALE_NAMES="$STALE_NAMES $(basename "$FILE")"
done
STALE_NAMES="$STALE_NAMES .speedtest"
if command -v python3 &>/dev/null; then
  ASSETS_JSON=$(CURL "$API/repos/$GH_REPO/releases/$RELEASE_ID/assets" 2>/dev/null || echo "[]")
  for NAME in $STALE_NAMES; do
    ASSET_ID=$(echo "$ASSETS_JSON" | python3 -c "
import json,sys
assets=json.load(sys.stdin)
for a in assets:
    if a.get('name') == '$NAME':
        print(a['id'])
" 2>/dev/null)
    if [ -n "$ASSET_ID" ]; then
      echo "    Removing stale: $NAME (ID: $ASSET_ID)"
      CURL -X DELETE "$API/repos/$GH_REPO/releases/assets/$ASSET_ID" >/dev/null 2>&1 || true
      sleep 2
    fi
  done
else
  # Fallback grep-based parsing (less reliable with minified JSON)
  ASSETS_JSON=$(CURL "$API/repos/$GH_REPO/releases/$RELEASE_ID/assets" 2>/dev/null || echo "[]")
  for NAME in $STALE_NAMES; do
    ASSET_ID=$(echo "$ASSETS_JSON" | tr ',' '\n' | grep -B1 '"name": "'"$NAME"'"' | grep -o '"id": [0-9]*' | head -1 | grep -o '[0-9]*' || true)
    if [ -n "$ASSET_ID" ]; then
      echo "    Removing stale: $NAME (ID: $ASSET_ID)"
      CURL -X DELETE "$API/repos/$GH_REPO/releases/assets/$ASSET_ID" >/dev/null 2>&1 || true
      sleep 2
    fi
  done
fi

# ── Measure upload speed ─────────────────────
echo ""
echo "  Measuring upload speed..."
SPEED=$(dd if=/dev/zero bs=1M count=5 2>/dev/null | curl -s -o /dev/null -w "%{speed_upload}" \
  -X POST "${UPLOAD_URL}?name=.speedtest" \
  -H "Authorization: token $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @- \
  --connect-timeout 10 --max-time 60 2>/dev/null || echo "50000")
SPEED=${SPEED%.*}
[ "$SPEED" -lt 1 ] && SPEED=50000
echo "  Upload speed: $(echo "scale=1; $SPEED/1024" | bc) KB/s"

# ── Upload assets in parallel ────────────────
echo ""
echo "  Uploading artifacts..."
COUNT=0
PID_LIST=""
LOG_DIR=$(mktemp -d)
trap "rm -rf '$LOG_DIR'" EXIT

for FILE in $ASSETS; do
  if [ ! -f "$FILE" ]; then
    echo "    SKIP (not found): $FILE"
    continue
  fi
  COUNT=$((COUNT+1))
  NAME=$(basename "$FILE")
  SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null)
  EST_SEC=$(( SIZE / SPEED ))
  EST_MIN=$(( EST_SEC / 60 ))
  EST_REM=$(( EST_SEC % 60 ))
  echo "    Uploading: $NAME ($(du -h "$FILE" | cut -f1)) — est. ${EST_MIN}m${EST_REM}s at ${SPEED} B/s"

  LOG="$LOG_DIR/${NAME//\//_}"
  (
      MIME="application/octet-stream"
      case "$NAME" in
        *.deb) MIME="application/vnd.debian.binary-package" ;;
        *.dmg) MIME="application/x-apple-diskimage" ;;
        *.pkg) MIME="application/x-newton-compatible-pkg" ;;
        *.zip) MIME="application/zip" ;;
        *.AppImage) MIME="application/vnd.appimage" ;;
      esac
      curl -s -X POST "${UPLOAD_URL}?name=$NAME" \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: $MIME" \
      --data-binary "@$FILE" \
      --connect-timeout 30 \
      --max-time 10800 \
      --retry 5 \
      --retry-delay 30 \
      --retry-max-time 7200 \
      --speed-limit 100 \
      --speed-time 60 > "${LOG}.result" 2>&1 || true

    if grep -q '"message"' "${LOG}.result" 2>/dev/null; then
      echo "      ✗ Failed: $NAME — $(grep -o '"message":"[^"]*"' "${LOG}.result" | head -1)" > "${LOG}.status"
    else
      echo "      ✓ Done: $NAME" > "${LOG}.status"
    fi
  ) &
  PID_LIST="$PID_LIST $!"
done

# ── Wait for all uploads ─────────────────────
if [ "$COUNT" -gt 0 ]; then
  echo ""
  echo "  Waiting for uploads to complete..."
  TICK=0
  RUNNING="$COUNT"
  while [ "$RUNNING" -gt 0 ]; do
    RUNNING=0
    for PID in $PID_LIST; do
      kill -0 "$PID" 2>/dev/null && RUNNING=$((RUNNING+1))
    done
    for f in "$LOG_DIR"/*.status; do
      [ -f "$f" ] && cat "$f" && rm -f "$f"
    done
    TICK=$((TICK+1))
    if [ "$RUNNING" -gt 0 ] && [ $((TICK % 12)) -eq 0 ]; then
      echo "    → $RUNNING file(s) still uploading ($((TICK*5))s elapsed)..."
    fi
    sleep 5
  done
  wait || true
fi

# ── Summary ──────────────────────────────────
if [ "$COUNT" -eq 0 ]; then
  echo "  No files found in dist/ for platform '$PLATFORM'."
  echo "  Make sure you ran: ./build.sh"
  for FILE in $ASSETS; do
    echo "    - $FILE"
  done
fi

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE"
echo "=========================================="
echo ""
echo "  View: https://github.com/$GH_REPO/releases/tag/$TAG"
echo "  Run on each platform to accumulate all assets."
