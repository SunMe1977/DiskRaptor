#!/bin/bash
# DiskRaptor Release Upload Script
# Uses SSH + git push for tags (no tokens, no gh CLI).
# Run AFTER build.sh completes successfully.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release v$VERSION"
echo "=========================================="
echo ""

# ── Switch remote to SSH ────────────────────
REMOTE=$(git remote get-url origin 2>/dev/null || echo "")
if echo "$REMOTE" | grep -q "^https://github.com/"; then
  SSH_URL="git@github.com:$(echo "$REMOTE" | sed 's|https://github.com/||')"
  echo "  Switching remote from HTTPS to SSH..."
  git remote set-url origin "$SSH_URL"
  echo "  New remote: $SSH_URL"
elif echo "$REMOTE" | grep -q "^git@github.com:"; then
  echo "  Remote already uses SSH: $REMOTE"
else
  echo "  WARNING: Unknown remote URL: $REMOTE"
fi

# ── Tag and push ─────────────────────────────
echo ""
echo "  Tag: $TAG"
git tag -f "$TAG" 2>/dev/null

echo "  Pushing tag via SSH..."
if git push origin "$TAG" 2>&1; then
  echo "  ✓ Tag pushed: https://github.com/$GH_REPO/releases/tag/$TAG"
else
  echo "  ✗ Tag push failed. Test SSH connection:"
  echo "    ssh -T git@github.com"
  echo ""
  echo "  If your SSH key is not set up:"
  echo "    1. Generate key: ssh-keygen -t ed25519 -C \"your@email.com\""
  echo "    2. Add to agent: eval \"\$(ssh-agent -s)\" && ssh-add ~/.ssh/id_ed25519"
  echo "    3. Add to GitHub: https://github.com/settings/ssh/new"
  exit 1
fi

echo ""
echo "=========================================="
echo "  RELEASE TAG PUSHED"
echo "=========================================="
echo ""
echo "  View: https://github.com/$GH_REPO/releases/tag/$TAG"
echo ""
echo "  Artifacts to upload (optional, via web UI):"

case "$(uname -s)" in
  Darwin*)
    echo "    - dist/DiskRaptor-$VERSION-macos.dmg"
    echo "    - dist/DiskRaptor-$VERSION-macos.zip"
    ;;
  Linux*)
    echo "    - dist/DiskRaptor-$VERSION-amd64.deb"
    echo "    - dist/DiskRaptor-$VERSION-linux-x64.zip"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "    - dist/DiskRaptor-$VERSION-win64.zip"
    echo "    - dist/DiskRaptor_*_Setup.exe"
    ;;
esac
