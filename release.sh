#!/bin/bash
# DiskRaptor Release Upload Script
# Deletes old release, recreates it, and uploads only this platform's build.
# Run AFTER build.sh completes successfully on each OS.
set -euo pipefail

VERSION="0.0.2"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""
echo "  Note: Large files (DMG, ZIP, DEB) may take several minutes to upload."
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

# ── Ensure release exists (create if missing) ──
echo ""
echo "  Ensuring release $TAG exists..."
"$GH" release create "$TAG" --title "DiskRaptor v$VERSION" --notes "" 2>/dev/null || true

# ── Get upload URL from gh ────────────────────
echo ""
echo "  Getting upload URL..."
UPLOAD_URL="$("$GH" release view "$TAG" --json "uploadUrl" --jq ".uploadUrl" 2>/dev/null | sed 's/{?name,label}//')"
if [ -z "$UPLOAD_URL" ]; then
  echo "  ERROR: Could not get upload URL for release $TAG"
  exit 1
fi
echo "  Upload URL: $UPLOAD_URL"

# ── Detect timeout command ────────────────────
TIMEOUT_CMD=""
for cmd in timeout gtimeout; do
  if command -v "$cmd" &>/dev/null; then
    TIMEOUT_CMD="$cmd"
    break
  fi
done

# ── Upload assets via gh --clobber ────────────
echo ""
echo "  Uploading artifacts..."
echo "  Note: Large files may take several minutes."
COUNT=0
for FILE in $ASSETS; do
  if [ ! -f "$FILE" ]; then
    echo "    SKIP (not found): $FILE"
    continue
  fi
  COUNT=$((COUNT+1))
  NAME=$(basename "$FILE")
  SIZE=$(du -h "$FILE" | cut -f1)
  echo "    Uploading: $NAME ($SIZE)..."
  set +e
  if [ -n "$TIMEOUT_CMD" ]; then
    $TIMEOUT_CMD 600 "$GH" release upload "$TAG" "$FILE" --clobber 2>&1
    RC=$?
  else
    "$GH" release upload "$TAG" "$FILE" --clobber 2>&1
    RC=$?
  fi
  set -e
  if [ "$RC" -eq 0 ]; then
    echo "      ✓ Done"
  elif [ "$RC" -eq 124 ]; then
    echo "      ⚠ timed out after 10 minutes"
  else
    echo "      ⚠ upload failed (exit $RC)"
  fi
done

if [ "$COUNT" -eq 0 ]; then
  echo "  No files found in dist/ for platform '$PLATFORM'."
  echo "  Make sure you ran: ./build.sh"
  echo "  Expected files:"
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
