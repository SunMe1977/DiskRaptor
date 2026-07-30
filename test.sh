#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " DiskRaptor -- Cross-Platform Test Suite"
echo "========================================"
echo ""

# Check for binary in various locations
BINARY="src-tauri/target/release/diskraptor"
MAC_BUNDLE="src-tauri/target/release/bundle/macos/DiskRaptor.app/Contents/MacOS/DiskRaptor"

if [ ! -f "$BINARY" ] && [ ! -f "$MAC_BUNDLE" ]; then
  echo "ERROR: Binary not found"
  echo "Run 'bash build.sh' first (or 'cd src-tauri && npx tauri build --bundles app')"
  exit 1
fi

case "${1:-}" in
  --quick)
    node tests/run_tests.mjs --quick
    exit $?
    ;;
  --list)
    node tests/run_tests.mjs --list
    exit $?
    ;;
  --help|-h)
    node tests/run_tests.mjs --help
    exit 0
    ;;
esac

echo "Using unified runner: tests/run_tests.mjs"
echo ""
node tests/run_tests.mjs "$@"
