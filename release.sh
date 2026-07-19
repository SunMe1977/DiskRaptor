#!/bin/bash
# DiskRaptor Release Upload Script
# Uses SSH + git push for tags (no tokens, no gh CLI).
# Run AFTER build.sh completes successfully.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"

echo "=========================================="
echo "  DiskRaptor Release v$VERSION"
echo "=========================================="
echo ""

# ── Check git remote ─────────────────────────
REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if echo "$REMOTE" | grep -q "^https://"; then
  echo "  Remote uses HTTPS. Switch to SSH for token-free push:"
  echo "    git remote set-url origin git@github.com:$(echo "$REMOTE" | sed 's|https://github.com/||')"
  echo ""
  echo "  Or set GITHUB_TOKEN for API uploads."
  echo "  Continuing with tag push only..."
fi

# ── Tag and push ─────────────────────────────
echo "  Tag: $TAG"
echo "  Creating tag..."
git tag -f "$TAG" 2>/dev/null

echo "  Pushing tag via SSH..."
if git push origin "$TAG" 2>&1; then
  echo "  ✓ Tag pushed: https://github.com/SunMe1977/DiskRaptor/releases/tag/$TAG"
  echo ""
  echo "  Release created from tag. Add assets manually at:"
  echo "    https://github.com/SunMe1977/DiskRaptor/releases/new"
else
  echo "  ✗ Tag push failed. Make sure SSH key is set up:"
  echo "    ssh -T git@github.com"
  exit 1
fi

echo ""
echo "=========================================="
echo "  RELEASE TAG PUSHED"
echo "=========================================="
echo ""
echo "  Next steps:"
echo "  1. Go to: https://github.com/SunMe1977/DiskRaptor/releases/new"
echo "  2. Select tag: $TAG"
echo "  3. Upload these artifacts:"
echo ""

case "$(uname -s)" in
  Darwin*)
    echo "     - dist/DiskRaptor-$VERSION-macos.dmg"
    echo "     - dist/DiskRaptor-$VERSION-macos.zip"
    ;;
  Linux*)
    echo "     - dist/DiskRaptor-$VERSION-amd64.deb"
    echo "     - dist/DiskRaptor-$VERSION-linux-x64.zip"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "     - dist/DiskRaptor-$VERSION-win64.zip"
    echo "     - dist/DiskRaptor_*_Setup.exe"
    ;;
esac
echo ""
echo "  4. Publish release"
