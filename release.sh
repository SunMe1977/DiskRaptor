#!/bin/bash
# DiskRaptor Release Upload Script
# Uses curl + GitHub API directly (no gh CLI needed).
# Run AFTER build.sh completes successfully.
set -euo pipefail

VERSION="0.0.1"
TAG="v$VERSION"
OS="$(uname -s)"
GH_REPO="SunMe1977/DiskRaptor"

echo "=========================================="
echo "  DiskRaptor Release Upload v$VERSION"
echo "=========================================="
echo ""

# Check curl
if ! command -v curl &>/dev/null; then
  echo "ERROR: curl not found. Install with: sudo apt install curl"
  exit 1
fi

# Get GitHub token
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
if [ -z "$GITHUB_TOKEN" ]; then
  echo "ERROR: GITHUB_TOKEN not set."
  echo "  Set it with: export GITHUB_TOKEN=ghp_xxx"
  echo "  Create a token at: https://github.com/settings/tokens"
  exit 1
fi

GH_API="https://api.github.com/repos/$GH_REPO"
GH_UPLOAD="https://uploads.github.com/repos/$GH_REPO"

echo "  Repository: $GH_REPO"
echo "  Tag: $TAG"
echo ""

# Check if release exists, create if not
RELEASE_ID=$(curl -s -H "Authorization: token $GITHUB_TOKEN" "$GH_API/releases/tags/$TAG" | grep -o '"id": [0-9]*' | head -1 | cut -d' ' -f2)

if [ -z "$RELEASE_ID" ]; then
  echo "  Creating release $TAG..."
  RESP=$(curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"tag_name\":\"$TAG\",\"name\":\"DiskRaptor v$VERSION\",\"body\":\"DiskRaptor v$VERSION\"}" \
    "$GH_API/releases")
  RELEASE_ID=$(echo "$RESP" | grep -o '"id": [0-9]*' | head -1 | cut -d' ' -f2)
  echo "  Release ID: $RELEASE_ID"
else
  echo "  Release exists (ID: $RELEASE_ID)"
fi

# Detect files to upload
FILES=""
case "$OS" in
  Darwin*)
    echo "  Platform: macOS"
    FILES="dist/DiskRaptor-$VERSION-macos.dmg dist/DiskRaptor-$VERSION-macos.zip"
    ;;
  Linux*)
    echo "  Platform: Linux"
    FILES="dist/DiskRaptor-$VERSION-linux-x64.zip dist/DiskRaptor-$VERSION-amd64.deb"
    ;;
  CYGWIN*|MINGW*|MSYS*)
    echo "  Platform: Windows"
    FILES="dist/DiskRaptor-$VERSION-win64.zip"
    for f in dist/DiskRaptor_*_Setup.exe; do
      [ -f "$f" ] && FILES="$FILES $f"
    done
    ;;
  *)
    echo "Unknown OS: $OS"
    exit 1
    ;;
esac

# Upload each file
echo ""
echo "  Uploading artifacts..."
for FILE in $FILES; do
  if [ ! -f "$FILE" ]; then
    echo "    SKIP (not found): $FILE"
    continue
  fi

  FILENAME=$(basename "$FILE")
  FILESIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE" 2>/dev/null || echo "0")

  echo "    Uploading: $FILENAME ($(du -h "$FILE" | cut -f1))"

  # Check if asset already exists
  EXISTING_ID=$(curl -s -H "Authorization: token $GITHUB_TOKEN" \
    "$GH_API/releases/$RELEASE_ID/assets" | \
    grep -o "\"name\":\"$FILENAME\",\"id\":[0-9]*" | \
    grep -o '"id":[0-9]*' | cut -d: -f2 | head -1)

  # Delete existing asset if present
  if [ -n "$EXISTING_ID" ]; then
    echo "      Removing existing asset..."
    curl -s -X DELETE -H "Authorization: token $GITHUB_TOKEN" \
      "$GH_API/releases/assets/$EXISTING_ID" > /dev/null
  fi

  # Upload
  curl -s -X POST -H "Authorization: token $GITHUB_TOKEN" \
    -H "Content-Type: application/octet-stream" \
    "$GH_UPLOAD/releases/$RELEASE_ID/assets?name=$FILENAME" \
    --data-binary @"$FILE" > /dev/null

  echo "      Done"
done

echo ""
echo "=========================================="
echo "  UPLOAD COMPLETE"
echo "=========================================="
echo ""
echo "  View: https://github.com/$GH_REPO/releases/tag/$TAG"
