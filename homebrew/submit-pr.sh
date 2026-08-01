#!/bin/bash
# Submit DiskRaptor cask to Homebrew/homebrew-cask.
# Prereq: upload the macOS .dmg for the current version to the GitHub release first.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(node -p "require('${SCRIPT_DIR}/../package.json').version")"
CASK_DIR="${HOMEBREW_CASK_DIR:-$HOME/Documents/GitHub/homebrew-cask}"
CASK="$CASK_DIR/Casks/d/diskraptor.rb"
BRANCH="add-diskraptor"
DMG_URL="https://github.com/SunMe1977/DiskRaptor/releases/download/v$VERSION/DiskRaptor-$VERSION-macos.dmg"

echo "==> Version: $VERSION"
echo "==> Cask repo: $CASK_DIR"

if [ ! -f "$CASK" ]; then
  echo "ERROR: $CASK not found. Clone/place the fork of homebrew/homebrew-cask there."
  exit 1
fi

echo "==> Checking $DMG_URL"
HTTP=$(curl -sIL -o /dev/null -w "%{http_code}" "$DMG_URL")
if [ "$HTTP" != "200" ]; then
  echo "ERROR: .dmg not uploaded yet (HTTP $HTTP). Upload it first (./sign-and-upload.sh / release.sh on macOS)."
  exit 1
fi

echo "==> Computing sha256 (downloads the .dmg, may take a while)..."
SHA=$(curl -sL "$DMG_URL" | shasum -a 256 | awk '{print $1}')
echo "    sha256: $SHA"

echo "==> Updating $CASK"
perl -0pi -e "s/REPLACE_WITH_REAL_SHA256/$SHA/" "$CASK"

echo "==> Validating (brew style + audit)"
brew style "$CASK"
brew audit --cask --new "$CASK"

cd "$CASK_DIR"
git checkout -B "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
git add Casks/d/diskraptor.rb
git commit -m "Add diskraptor" || true

echo "==> Pushing to fork (SunMe1977/homebrew-cask)"
git push -u origin "$BRANCH" --force

echo "==> Opening PR against Homebrew/homebrew-cask"
gh pr create --repo Homebrew/homebrew-cask \
  --base master \
  --head "SunMe1977:$BRANCH" \
  --title "Add diskraptor" \
  --body "Adds DiskRaptor v$VERSION (ultra-fast disk space analyzer).

- [x] The cask passes \`brew audit --cask --new diskraptor\`
- [x] The cask passes \`brew style\`
- [x] The download URL is reachable and the sha256 is correct"

echo "=== Done. PR created for DiskRaptor v$VERSION ==="
