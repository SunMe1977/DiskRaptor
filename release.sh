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

# Delete old GitHub release if possible (needs gh CLI or token)
if command -v gh &>/dev/null; then
  echo "  Deleting old GitHub release (if exists)..."
  gh release delete "$TAG" --yes 2>/dev/null || true
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "  Deleting old GitHub release via API..."
  RELEASE_ID=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$GH_REPO/releases/tags/$TAG" | grep -o '"id": [0-9]*' | head -1 | cut -d' ' -f2 2>/dev/null || true)
  [ -n "$RELEASE_ID" ] && curl -s -X DELETE -H "Authorization: token $GITHUB_TOKEN" "https://api.github.com/repos/$GH_REPO/releases/$RELEASE_ID" > /dev/null 2>&1 || true
fi

echo "  Deleting old remote tag (if exists)..."
git push origin --delete "$TAG" 2>/dev/null || true
git tag -f "$TAG" 2>/dev/null

echo "  Pushing tag via SSH..."
if git push origin "$TAG" 2>&1; then
  echo "  ✓ Tag pushed: https://github.com/$GH_REPO/releases/tag/$TAG"
else
  echo "  ✗ Push failed. Retrying with force delete..."
  git push origin --delete "$TAG" 2>/dev/null || true
  sleep 1
  if git push origin "$TAG" 2>&1; then
    echo "  ✓ Tag pushed after force delete"
  else
    echo "  ✗ Still failing. Check SSH access:"
    echo "    ssh -T git@github.com"
    exit 1
  fi
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
