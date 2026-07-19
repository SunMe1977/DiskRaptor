#!/bin/bash
# DiskRaptor Release Upload Script
# Run AFTER build.sh completes successfully.
# Uploads platform artifacts to the GitHub release.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"
OS="$(uname -s)"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""

# Check gh CLI
if ! command -v gh &>/dev/null; then
  echo "ERROR: GitHub CLI (gh) not found. Install with: brew install gh (macOS) or sudo apt install gh (Linux)"
  exit 1
fi

# Check auth
if ! gh auth status 2>&1 | grep -q "active"; then
  echo "ERROR: Not logged into GitHub CLI. Run: gh auth login"
  exit 1
fi

# Check if release exists, create if not
if ! gh release view "$TAG" &>/dev/null; then
  echo "  Creating release $TAG..."
  gh release create "$TAG" --title "DiskRaptor v$VERSION" --notes "Release v$VERSION"
fi

echo "  Release: $TAG"
echo ""

# Upload based on platform
case "$OS" in
  Darwin*)
    echo "  Uploading macOS artifacts..."
    for f in dist/DiskRaptor-$VERSION-macos.dmg dist/DiskRaptor-$VERSION-macos.zip; do
      if [ -f "$f" ]; then
        echo "    Uploading: $f ($(du -h "$f" | cut -f1))"
        gh release upload "$TAG" "$f" --clobber
      fi
    done
    ;;

  Linux*)
    echo "  Uploading Linux artifacts..."
    for f in dist/DiskRaptor-$VERSION-linux-x64.zip dist/DiskRaptor-$VERSION-amd64.deb; do
      if [ -f "$f" ]; then
        echo "    Uploading: $f ($(du -h "$f" | cut -f1))"
        gh release upload "$TAG" "$f" --clobber
      fi
    done
    ;;

  CYGWIN*|MINGW*|MSYS*)
    echo "  Uploading Windows artifacts..."
    for f in dist/DiskRaptor-$VERSION-win64.zip dist/DiskRaptor_*_Setup.exe; do
      if [ -f "$f" ]; then
        echo "    Uploading: $f ($(du -h "$f" | cut -f1))"
        gh release upload "$TAG" "$f" --clobber
      fi
    done
    ;;

  *)
    echo "Unknown OS: $OS"
    exit 1
    ;;
esac

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE"
echo "=========================================="
echo ""
echo "  View: https://github.com/SunMe1977/DiskRaptor/releases/tag/$TAG"
