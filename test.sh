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

if [ ! -f "$BINARY" ] && [ ! -f "dist/DiskRaptor.app/Contents/MacOS/DiskRaptor" ]; then
  echo "ERROR: Binary not found in dist/"
  echo "Run 'bash build.sh' first"
  exit 1
fi

case "${1:-}" in
  --quick)
    node run_tests.mjs --quick
    exit $?
    ;;
  --list)
    node run_tests.mjs --list
    exit $?
    ;;
  --help|-h)
    node run_tests.mjs --help
    exit 0
    ;;
esac

echo "Using unified runner: run_tests.mjs"
echo ""
node run_tests.mjs "$@"
