#!/bin/bash
# DiskRaptor Release Upload Script
set -euo pipefail

VERSION="0.0.2"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""

# ── Find gh CLI ──────────────────────────────
GH=""
for p in $(which gh 2>/dev/null || true) $(command -v gh 2>/dev/null || true) /usr/bin/gh /usr/local/bin/gh /snap/bin/gh /home/linuxbrew/.linuxbrew/bin/gh; do
  if [ -x "$p" ]; then GH="$p"; break; fi
done
if [ -z "$GH" ]; then
  echo "ERROR: GitHub CLI (gh) not found."
  echo "  Install: sudo apt install gh && gh auth login"
  echo "  Or: brew install gh && gh auth login"
  exit 1
fi
echo "  gh: $GH"

if ! "$GH" auth status 2>&1 | grep -qi "active account: true"; then
  echo "ERROR: Not authenticated. Run: gh auth login"
  exit 1
fi
echo "  ✓ gh CLI authenticated"

# ── Detect platform assets ────────────────────
PLATFORM="$(uname -s)"
case "$PLATFORM" in
  Darwin*)
    echo "  Platform: macOS"
    ASSETS="dist/DiskRaptor-$VERSION-macos.dmg dist/DiskRaptor-$VERSION-macos.zip"
    ;;
  Linux*)
    echo "  Platform: Linux"
    ASSETS="dist/DiskRaptor-$VERSION-amd64.deb dist/DiskRaptor-$VERSION-linux-x64.zip"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "  Platform: Windows"
    ASSETS="dist/DiskRaptor-$VERSION-win64.zip"
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
"$GH" release create "$TAG" --title "DiskRaptor v$VERSION" --notes "" 2>/dev/null || true

# ── Get upload URL and token ──────────────────
echo ""
echo "  Getting upload URL..."
UPLOAD_URL="$("$GH" release view "$TAG" --json "uploadUrl" --jq ".uploadUrl" 2>/dev/null | sed 's/{?name,label}//')"
if [ -z "$UPLOAD_URL" ]; then
  echo "  ERROR: Could not get upload URL for release $TAG"
  exit 1
fi
echo "  Upload URL: $UPLOAD_URL"

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  TOKEN=$("$GH" auth token 2>/dev/null || true)
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: No token found. Set GH_TOKEN or use gh auth login."
  exit 1
fi

# ── Delete stale assets ──────────────────────
echo ""
echo "  Cleaning stale assets..."
for FILE in $ASSETS; do
  NAME=$(basename "$FILE")
  ASSET_ID=$("$GH" release view "$TAG" --json assets --jq '.assets[] | select(.name == "'"$NAME"'") | .id' 2>/dev/null || true)
  if [ -n "$ASSET_ID" ]; then
    echo "    Removing stale: $NAME"
    "$GH" api -X DELETE "repos/$GH_REPO/releases/assets/$ASSET_ID" --silent 2>/dev/null || true
    sleep 2
  fi
done

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
  SIZE=$(stat -f%z "$FILE")
  EST_SEC=$(( SIZE / SPEED ))
  EST_MIN=$(( EST_SEC / 60 ))
  EST_REM=$(( EST_SEC % 60 ))
  echo "    Uploading: $NAME ($(du -h "$FILE" | cut -f1)) — est. ${EST_MIN}m${EST_REM}s at ${SPEED} B/s"

  LOG="$LOG_DIR/${NAME//\//_}"
  (
    curl -s -X POST "${UPLOAD_URL}?name=$NAME" \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$FILE" \
      --connect-timeout 30 --max-time 10800 > "${LOG}.result" 2>&1 || true

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
