#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================"
echo " DiskRaptor -- Cross-Platform Test Suite"
echo "========================================"
echo ""

BINARY="dist/DiskRaptor"
FRONTEND="dist/frontend"

if [ ! -f "$BINARY" ] && [ ! -f "dist/DiskRaptor.app/Contents/MacOS/DiskRaptor" ] && [ ! -f "src-tauri/target/release/diskraptor" ] && [ ! -f "src-tauri/target/debug/diskraptor" ]; then
  echo "ERROR: Binary not found in dist/ or src-tauri/target/{release,debug}/"
  echo "Run 'bash build.sh' or 'cargo build --release' first"
  exit 1
fi

case "${1:-}" in
  --quick)
    # Smoke tests run concurrently (3 workers, isolated app instances on
    # distinct CDP ports) — roughly 3x faster than sequential.
    shift
    node tests/run_tests.mjs --quick --parallel 3 "$@"
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
