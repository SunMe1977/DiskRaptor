#!/bin/bash
# DiskRaptor Release Upload Script
# Creates/updates a GitHub release and uploads build artifacts.
# Uses gh CLI for auth (run 'gh auth login' once).
# Run AFTER build.sh completes successfully.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release v$VERSION"
echo "=========================================="
echo ""

# ── Check gh CLI ─────────────────────────────
if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI not found."
  echo "  Install:"
  echo "    macOS: brew install gh"
  echo "    Linux: sudo apt install gh  (or: sudo dnf install gh)"
  echo "    Windows: winget install GitHub.cli"
  echo ""
  echo "  Then authenticate: gh auth login"
  exit 1
fi

if ! gh auth status 2>&1 | grep -q "active"; then
  echo "ERROR: Not authenticated with GitHub."
  echo "  Run: gh auth login"
  echo "  Select: 'GitHub.com' → 'SSH' → 'Use your SSH key'"
  exit 1
fi
echo "  ✓ gh CLI authenticated"

# ── Detect platform assets ────────────────────
case "$(uname -s)" in
  Darwin*)
    ASSETS="dist/DiskRaptor-$VERSION-macos.dmg dist/DiskRaptor-$VERSION-macos.zip"
    ;;
  Linux*)
    ASSETS="dist/DiskRaptor-$VERSION-amd64.deb dist/DiskRaptor-$VERSION-linux-x64.zip"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    ASSETS="dist/DiskRaptor-$VERSION-win64.zip"
    for f in dist/DiskRaptor_*_Setup.exe; do [ -f "$f" ] && ASSETS="$ASSETS $f"; done
    ;;
  *)
    echo "Unknown OS: $(uname -s)"
    exit 1
    ;;
esac

# ── Delete old release + tag ──────────────────
echo ""
echo "  Cleaning up old release/tag..."
gh release delete "$TAG" --yes 2>/dev/null || true
git push origin --delete "$TAG" 2>/dev/null || true
git tag -f "$TAG" 2>/dev/null

# ── Create release ────────────────────────────
echo "  Creating release $TAG..."
if ! gh release create "$TAG" --title "DiskRaptor v$VERSION" --notes "Release v$VERSION" 2>&1; then
  echo "  ERROR: Could not create release"
  exit 1
fi
echo "  ✓ Release created"

# ── Upload assets ─────────────────────────────
echo ""
echo "  Uploading artifacts..."
for FILE in $ASSETS; do
  if [ ! -f "$FILE" ]; then
    echo "    SKIP (not found): $FILE"
    continue
  fi
  echo "    Uploading: $FILE ($(du -h "$FILE" | cut -f1))..."
  gh release upload "$TAG" "$FILE" --clobber
  echo "      Done"
done

echo ""
echo "=========================================="
echo "  RELEASE COMPLETE"
echo "=========================================="
echo ""
echo "  View: https://github.com/$GH_REPO/releases/tag/$TAG"
