#!/bin/bash
# Local macOS "Release" CI: builds the universal .app, signs it with a
# Developer ID Application certificate (from env vars, never a GUI prompt),
# creates a DMG + PKG and notarizes/staple both. Mirrors the
# macos-universal job of .github/workflows/release.yml for local runs.
set -euo pipefail
cd "$(dirname "$0")"

# ── Options ────────────────────────────────────────────────────────
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --help|-h)
      echo "Usage: $0 [--no-build]"
      echo "  --no-build  Reuse the existing universal app (skip 'npx tauri build')."
      echo ""
      echo "Required env vars (set them in .env or export them):"
      echo "  Cert import (one of):"
      echo "    DEVELOPER_ID_CERT_P12=<base64>       Developer ID cert bundle (.p12, base64)"
      echo "    DEVELOPER_ID_CERT_PASSWORD=<pass>    .p12 export password"
      echo "    -- or fallback to login keychain: --"
      echo "    KEYCHAIN_PASSWORD=<pass>             login keychain password (no GUI prompt)"
      echo "  Notarization:"
      echo "    APPLE_API_KEY / APPLE_API_ISSUER     App Store Connect API key ID/issuer"
      echo "    APPLE_API_KEY_PATH                   path to AuthKey_<id>.p8 (default \$HOME/private_keys)"
      echo "  Optional:"
      echo "    BUNDLE_ID=<id>                       default: diskraptor"
      exit 0 ;;
  esac
done

# ── Load .env ──────────────────────────────────────────────────────
if [ -f ".env" ]; then
  set -a; . ./.env; set +a
fi

VERSION="$(node -p "require('./package.json').version" 2>/dev/null)"
BUNDLE_ID="${BUNDLE_ID:-diskraptor}"
APP_SRC="src-tauri/target/universal-apple-darwin/release/bundle/macos/DiskRaptor.app"

echo "=========================================="
echo "  DiskRaptor $VERSION - macOS PKG CI"
echo "=========================================="

# ── 1. Build unsigned universal app ───────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  echo "[1] Building universal app (unsigned)..."
  npx tauri build --bundles app --ci --target universal-apple-darwin
else
  echo "[1] Skipping build (--no-build)"
fi
[ -d "$APP_SRC" ] || { echo "ERROR: app bundle not found at $APP_SRC" >&2; exit 1; }

# ── 2. Set up signing keychain (never prompts) ────────────────────
ORIG_KEYCHAINS="$(security list-keychains -d user 2>/dev/null)"
ORIG_DEFAULT="$(security default-keychain 2>/dev/null | tr -d '"')"
SIGN_KEYCHAIN="/tmp/diskraptor-ci-$$.keychain"
SIGN_KEYCHAIN_PASS="${KEYCHAIN_PASSWORD:-ci}"
CERT_P12="/tmp/diskraptor-ci-$$.p12"

cleanup() {
  security delete-keychain "$SIGN_KEYCHAIN" 2>/dev/null || true
  rm -f "$CERT_P12"
  if [ -n "$ORIG_KEYCHAINS" ]; then
    # shellcheck disable=SC2086
    security list-keychains -d user -s $ORIG_KEYCHAINS 2>/dev/null || true
  fi
  if [ -n "$ORIG_DEFAULT" ]; then
    security default-keychain -s "$ORIG_DEFAULT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "[2] Setting up signing keychain..."
security create-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN"
security unlock-keychain -p "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN"
security set-keychain-settings -t 3600 "$SIGN_KEYCHAIN"
security default-keychain -s "$SIGN_KEYCHAIN"

if [ -n "${DEVELOPER_ID_CERT_P12:-}" ]; then
  echo "  Importing Developer ID cert from DEVELOPER_ID_CERT_P12 (base64)..."
  [ -n "${DEVELOPER_ID_CERT_PASSWORD:-}" ] || { echo "ERROR: DEVELOPER_ID_CERT_PASSWORD not set" >&2; exit 1; }
  echo "$DEVELOPER_ID_CERT_P12" | base64 --decode > "$CERT_P12"
  security import "$CERT_P12" -P "$DEVELOPER_ID_CERT_PASSWORD" -A \
    -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security
elif [ -n "${DEVELOPER_ID_CERT_P12_PATH:-}" ] && [ -f "$DEVELOPER_ID_CERT_P12_PATH" ]; then
  echo "  Importing Developer ID cert from $DEVELOPER_ID_CERT_P12_PATH..."
  [ -n "${DEVELOPER_ID_CERT_PASSWORD:-}" ] || { echo "ERROR: DEVELOPER_ID_CERT_PASSWORD not set" >&2; exit 1; }
  cp "$DEVELOPER_ID_CERT_P12_PATH" "$CERT_P12"
  security import "$CERT_P12" -P "$DEVELOPER_ID_CERT_PASSWORD" -A \
    -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security
else
  if [ -z "${KEYCHAIN_PASSWORD:-}" ]; then
    echo "ERROR: no cert source configured." >&2
    echo "  Set DEVELOPER_ID_CERT_P12 + DEVELOPER_ID_CERT_PASSWORD (base64 p12)," >&2
    echo "  DEVELOPER_ID_CERT_P12_PATH + DEVELOPER_ID_CERT_PASSWORD, or" >&2
    echo "  KEYCHAIN_PASSWORD (exports identities from the login keychain)." >&2
    exit 1
  fi
  echo "  Exporting Developer ID identities from login keychain (no GUI prompt)..."
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  security export -k ~/Library/Keychains/login.keychain-db -t identities \
    -f pkcs12 -P "$SIGN_KEYCHAIN_PASS" -o "$CERT_P12" 2>/dev/null || true
  if [ ! -s "$CERT_P12" ]; then
    echo "ERROR: no signable identities in the login keychain." >&2
    exit 1
  fi
  security import "$CERT_P12" -P "$SIGN_KEYCHAIN_PASS" -A \
    -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security
fi

security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: \
  -s -k "$SIGN_KEYCHAIN_PASS" "$SIGN_KEYCHAIN"
security list-keychains -d user -s "$SIGN_KEYCHAIN"

IDENTITY="$(security find-identity -v -p codesigning "$SIGN_KEYCHAIN" 2>/dev/null \
  | grep -i 'Developer ID Application' | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
if [ -z "$IDENTITY" ]; then
  echo "ERROR: no 'Developer ID Application' identity found in the signing keychain." >&2
  exit 1
fi
echo "  Signing identity: $IDENTITY"

# ── 3. Codesign app (Developer ID + hardened runtime + timestamp) ──
echo "[3] Codesigning app..."
STAGE="dist-ci"
rm -rf "$STAGE"
mkdir -p "$STAGE"
APP="$STAGE/DiskRaptor.app"
cp -R "$APP_SRC" "$APP"
rm -f "$APP/Contents/MacOS/gen-testdata" "$APP/Contents/MacOS/clean-testdata"

xattr -cr "$APP" || true
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$APP/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"

find "$APP/Contents" -type f -name "*.dylib" -print0 | \
  xargs -0 -P4 -I{} codesign --force --options=runtime --timestamp --sign "$IDENTITY" --keychain "$SIGN_KEYCHAIN" "{}"
find "$APP/Contents" -type d -name "*.framework" -print0 | \
  xargs -0 -P4 -I{} codesign --force --options=runtime --timestamp --sign "$IDENTITY" --keychain "$SIGN_KEYCHAIN" "{}"
codesign --force --options=runtime --timestamp --entitlements installer/DiskRaptor.entitlements \
  --sign "$IDENTITY" --keychain "$SIGN_KEYCHAIN" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ── 4. Create DMG + PKG ────────────────────────────────────────────
echo "[4] Creating DMG + PKG..."
DMG="$STAGE/DiskRaptor-$VERSION-macos-universal.dmg"
DMG_STAGING="/tmp/diskraptor-ci-dmg-$$"
rm -rf "$DMG_STAGING"
mkdir -p "$DMG_STAGING"
cp -R "$APP" "$DMG_STAGING/DiskRaptor.app"
ln -s /Applications "$DMG_STAGING/Applications"
for i in $(seq 1 5); do
  hdiutil create -volname "DiskRaptor" -srcfolder "$DMG_STAGING" -ov -format UDZO "$DMG" && break
  echo "hdiutil create failed (attempt $i) - retrying..." >&2
  sleep 10
done
rm -rf "$DMG_STAGING"
[ -f "$DMG" ] || { echo "ERROR: DMG creation failed" >&2; exit 1; }

PKG="$STAGE/DiskRaptor-$VERSION-macos-universal.pkg"
INSTALLER_CERT="$(security find-identity -v -p basic "$SIGN_KEYCHAIN" 2>/dev/null | grep -i 'Developer ID Installer' | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true)"
if [ -n "$INSTALLER_CERT" ]; then
  echo "  Signing PKG with: $INSTALLER_CERT"
  productbuild --component "$APP" /Applications \
    --sign "$INSTALLER_CERT" --keychain "$SIGN_KEYCHAIN" \
    --identifier "$BUNDLE_ID" --version "$VERSION" "$PKG"
else
  echo "ERROR: no 'Developer ID Installer' cert found - cannot build a notarizable PKG." >&2
  exit 1
fi

# ── 5. Notarize (hard-fail unless Apple reports "Accepted") ───────
echo "[5] Notarizing DMG + PKG..."
if [ -z "${APPLE_API_KEY:-}" ] || [ -z "${APPLE_API_ISSUER:-}" ]; then
  echo "ERROR: APPLE_API_KEY / APPLE_API_ISSUER not set - cannot notarize." >&2
  exit 1
fi
KEY="${APPLE_API_KEY_PATH:-$HOME/private_keys/AuthKey_$APPLE_API_KEY.p8}"
if [ ! -f "$KEY" ]; then
  echo "ERROR: API key file not found at $KEY (set APPLE_API_KEY_PATH)" >&2
  exit 1
fi

notarize() {
  local file="$1" label="$2"
  echo "=== Notarizing $label: $(basename "$file") ==="
  set +e
  xcrun notarytool submit "$file" \
    --key "$KEY" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" \
    --wait --output-format json > "/tmp/notary-$label.json" 2> "/tmp/notary-$label.err"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "ERROR: notarytool submit for $label failed (exit $rc):" >&2
    cat "/tmp/notary-$label.err" >&2 || true
    return 1
  fi
  local status
  status="$(tr -d '\n' < "/tmp/notary-$label.json" | python3 -c 'import sys,re; s=sys.stdin.read(); m=list(re.finditer(r"\"status\"\s*:\s*\"([A-Za-z]+)\"", s)); print(m[-1].group(1) if m else "unknown")' 2>/dev/null || echo unknown)"
  echo "Apple status for $label: $status"
  if [ "$status" != "Accepted" ]; then
    echo "ERROR: Apple notarization for $label reported status '$status' (expected Accepted)." >&2
    cat "/tmp/notary-$label.err" >&2 || true
    return 1
  fi
  return 0
}

notarize "$DMG" dmg
xcrun stapler staple "$DMG" && xcrun stapler validate "$DMG"
notarize "$PKG" pkg
xcrun stapler staple "$PKG" && xcrun stapler validate "$PKG"

echo ""
echo "=========================================="
echo "  PKG CI COMPLETE"
echo "=========================================="
ls -lh "$DMG" "$PKG"
echo ""
echo "  DMG: $DMG"
echo "  PKG: $PKG"
