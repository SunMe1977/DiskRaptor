#!/bin/bash
# bump-version.sh — bump DiskRaptor version across all 8 files.
#
# Usage: ./bump-version.sh 1.0.8
set -eu

NEW="${1:-}"
if [ -z "$NEW" ]; then
  echo "Usage: $0 <new-version>   e.g. $0 1.0.8"
  exit 1
fi
if ! echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: version must be X.Y.Z (got '$NEW')"
  exit 1
fi

OLD="$(node -p "require('$(dirname "$0")/package.json').version" 2>/dev/null)"
[ -z "$OLD" ] && OLD="$(grep -o '"version": "[^"]*"' "$(dirname "$0")/package.json" | head -1 | cut -d'"' -f4)"
if [ -z "$OLD" ]; then
  echo "ERROR: could not read current version from package.json"
  exit 1
fi
echo "Bumping $OLD -> $NEW"

# Replace the literal version token with the new one, keeping all surrounding
# syntax untouched. Each file below contains the version exactly once.
rep() {
  local file="$1"
  if grep -Fq "$OLD" "$file"; then
    perl -0pi -e "s/\Q$OLD\E/$NEW/g" "$file"
    echo "  ok   $file"
  else
    echo "  SKIP $file (version '$OLD' not found)"
  fi
}

rep "package.json"
rep "src-tauri/Cargo.toml"
rep "src-tauri/tauri.conf.json"
rep "installer/nsis/DiskRaptor.nsi"

# Cargo.lock: only the diskraptor crate entry should change (other crates share
# version numbers, so do a targeted replacement on that block).
LOCK="$(dirname "$0")/src-tauri/Cargo.lock"
if grep -A1 -F 'name = "diskraptor"' "$LOCK" | grep -Fq 'version = "'"$OLD"'"'; then
  perl -0pi -e 's/(name = "diskraptor"\nversion = ")'"$OLD"'(")/${1}'"$NEW"'${2}/' "$LOCK"
  echo "  ok   src-tauri/Cargo.lock"
else
  echo "  SKIP src-tauri/Cargo.lock"
fi

echo ""
echo "Done."
