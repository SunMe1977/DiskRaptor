#!/bin/bash
# DiskRaptor Release Upload Script
# Uploads current platform's build artifacts to the GitHub release.
# Does NOT delete existing assets — run on each platform to accumulate files.
# Uses gh CLI (authenticate once with: gh auth login).
# Run AFTER build.sh completes successfully.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""

# ── Check gh CLI ─────────────────────────────
if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI not found."
  echo "  Install: brew install gh  |  sudo apt install gh  |  winget install GitHub.cli"
  echo "  Then authenticate: gh auth login"
  exit 1
fi

if ! gh auth status 2>&1 | grep -q "active"; then
  echo "ERROR: Not authenticated. Run: gh auth login"
  exit 1
fi
echo "  ✓ gh CLI authenticated"

# ── Detect platform assets ────────────────────
case "$(uname -s)" in
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
    echo "Unknown OS: $(uname -s)"
    exit 1
    ;;
esac

# ── Ensure release exists ─────────────────────
echo ""
echo "  Checking release $TAG..."
if gh release view "$TAG" &>/dev/null; then
  echo "  Release exists, will add assets"
else
  echo "  Creating release..."
  gh release create "$TAG" --title "DiskRaptor v$VERSION" --notes "Release v$VERSION"
fi

# ── Upload assets ─────────────────────────────
echo ""
echo "  Uploading artifacts..."
for FILE in $ASSETS; do
  if [ ! -f "$FILE" ]; then
    echo "    SKIP (file not found): $FILE"
    continue
  fi
  NAME=$(basename "$FILE")
  # Skip if already uploaded (gh will error, we catch it)
  echo "    Uploading: $NAME ($(du -h "$FILE" | cut -f1))..."
  if gh release upload "$TAG" "$FILE" --clobber 2>&1; then
    echo "      ✓ Done"
  else
    echo "      ⚠ Upload failed (may already exist)"
  fi
done

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE"
echo "=========================================="
echo ""
echo "  View: https://github.com/$GH_REPO/releases/tag/$TAG"
echo "  Run on each platform (macOS, Linux, Windows) to add all assets."
