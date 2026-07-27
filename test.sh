#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

BINARY="dist/DiskRaptor"
FRONTEND="dist/frontend"
LIB="dist/lib/libdiskraptor_scanner.so"

echo "========================================"
echo " DiskRaptor — Run All Linux UI Tests"
echo "========================================"
echo ""

if [ ! -f "$BINARY" ]; then
  echo "ERROR: Binary not found: $BINARY"
  echo "Run 'bash build.sh' first"
  exit 1
fi

echo "✓ Binary: $BINARY"
echo "✓ Frontend: $FRONTEND"
echo ""

TESTS=(
  "test_scan_linux.mjs"
  "test_rescan_linux.mjs"
  "test_welcome_linux.mjs"
  "test_settings_linux.mjs"
  "test_tree_linux.mjs"
  "test_topfiles_linux.mjs"
  "test_theme_linux.mjs"
  "test_export_linux.mjs"
  "test_favorites_linux.mjs"
  "test_filters_linux.mjs"
  "test_trash_linux.mjs"
  "test_ui_all_linux.mjs"
  "test_find_linux.mjs"
  "test_duplicates_linux.mjs"
  "test_trash_recovery_linux.mjs"
  "test_i18n_linux.mjs"
  "test_tauri_linux.mjs"
  "test_fileops_linux.mjs"
  "test_galaxy_linux.mjs"
  "test_progress_linux.mjs"
  "test_context_menu_linux.mjs"
  "tests/downloads-cleanup.spec.mjs"
)

PASSED=0
FAILED=0
SKIPPED=0
RESULTS=""

for test in "${TESTS[@]}"; do
  echo "----------------------------------------"
  echo "▶ Running: $test"
  echo "----------------------------------------"
  if [ -f "$test" ]; then
    if timeout 120 node "$test" 2>&1; then
      echo "  ✓ PASSED: $test"
      PASSED=$((PASSED + 1))
    else
      echo "  ✗ FAILED: $test (exit code: $?)"
      FAILED=$((FAILED + 1))
      RESULTS="${RESULTS}FAIL: $test\n"
    fi
  else
    echo "  ⊘ SKIPPED: $test (not found)"
    SKIPPED=$((SKIPPED + 1))
  fi
  echo ""
  sleep 2
done

echo "========================================"
echo " RESULTS"
echo "========================================"
echo "  Passed: $PASSED"
echo "  Failed: $FAILED"
echo "  Skipped: $SKIPPED"
echo "  Total:  ${#TESTS[@]}"
echo ""
if [ -n "$RESULTS" ]; then
  echo "--- Failed Tests ---"
  echo -e "$RESULTS"
fi

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi
echo "✓ All tests passed!"