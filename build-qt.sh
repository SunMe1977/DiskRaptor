#!/bin/bash
# DiskRaptor Qt 6 Build Script
# Usage: bash build-qt.sh [debug|release]

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_TYPE="${1:-release}"
BUILD_DIR="$SCRIPT_DIR/qt-app/build"

echo "=== DiskRaptor Qt 6 Build ==="
echo "  Type:    $BUILD_TYPE"
echo "  System:  $(uname -s)"
echo ""

# Clean and create build directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with CMake
echo "[1/3] Configuring..."
cmake "$SCRIPT_DIR/qt-app" \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE^}" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/install" \
  -DBUILD_SHARED_LIBS=OFF \
  -GNinja 2>&1 || cmake "$SCRIPT_DIR/qt-app" \
  -DCMAKE_BUILD_TYPE="${BUILD_TYPE^}" \
  -DCMAKE_INSTALL_PREFIX="$BUILD_DIR/install" \
  -DBUILD_SHARED_LIBS=OFF

echo "[2/3] Building..."
cmake --build . --config "${BUILD_TYPE^}" -j$(nproc 2>/dev/null || echo 4) 2>&1

echo "[3/3] Installing..."
cmake --install . --config "${BUILD_TYPE^}" 2>&1 || true

echo ""
echo "=== Build Complete ==="
echo "  Binary: $BUILD_DIR/install/bin/DiskRaptor"
echo "  Size:   $(du -h "$BUILD_DIR/install/bin/DiskRaptor" 2>/dev/null | cut -f1 || echo 'N/A')"
echo ""
echo "Run with:"
echo "  $BUILD_DIR/install/bin/DiskRaptor"
echo ""
echo "Or from build directory:"
echo "  $BUILD_DIR/DiskRaptor"
