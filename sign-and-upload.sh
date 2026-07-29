#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
[ -f ".env" ] && { set -a; . ./.env; set +a; }

VERSION="${VERSION:-$(node -p "require('./package.json').version" 2>/dev/null || echo "1.0.2")}"
APP="dist/DiskRaptor.app"
APP_DST="dist-mas/DiskRaptor.app"
PKG="dist-mas/DiskRaptor-$VERSION-mas.pkg"
ENT="installer/DiskRaptor-MAS.entitlements"

# ── Ensure login keychain is accessible ──
if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
fi

# ── Detect signing identities from login keychain ──
detect_identity() {
  local pattern="$1" purpose="$2"
  security find-identity -v -p "$purpose" 2>/dev/null | grep -i "$pattern" | head -1 | sed 's/.*"\([^"]*\)".*/\1/' || true
}

CERT="${SIGNING_IDENTITY:-$(detect_identity '3rd Party Mac Developer Application' codesigning)}"
INSTALLER_CERT="${INSTALLER_IDENTITY:-$(detect_identity '3rd Party Mac Developer Installer' basic)}"

if [ -z "$CERT" ]; then
  echo "ERROR: No '3rd Party Mac Developer Application' certificate found."
  echo "       Install from: https://developer.apple.com/account/resources/certificates"
  echo "       Or set SIGNING_IDENTITY in .env"
  exit 1
fi
if [ -z "$INSTALLER_CERT" ]; then
  echo "ERROR: No '3rd Party Mac Developer Installer' certificate found."
  echo "       Install from: https://developer.apple.com/account/resources/certificates"
  echo "       Or set INSTALLER_IDENTITY in .env"
  exit 1
fi

echo "  App cert:       $CERT"
echo "  Installer cert: $INSTALLER_CERT"

# ── Set up signing keychain ──
KC="${KEYCHAIN_PATH:-/tmp/diskraptor-signing-$$.keychain}"
if [[ "$KC" == /tmp/* ]] && [ -f "$KC" ]; then
  echo "  Removing stale temp keychain..."
  security delete-keychain "$KC" 2>/dev/null || true
  rm -f "$KC"
fi
if [ ! -f "$KC" ]; then
  if [ -z "${KEYCHAIN_PASSWORD:-}" ]; then
    echo "ERROR: KEYCHAIN_PASSWORD not set — needed to create signing keychain"
    echo "       Set it in .env or run ./fix-keychain.sh first"
    exit 1
  fi
  echo "  Creating signing keychain..."
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KC" 2>/dev/null || true
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC" 2>/dev/null || true
  security set-keychain-settings -t 86400 "$KC" 2>/dev/null || true
  # set-key-partition-list fails on empty keychain — safe to ignore
  security set-key-partition-list -S apple-tool:,apple:,codesign:,productbuild: -s -k "$KEYCHAIN_PASSWORD" "$KC" 2>/dev/null || true

  echo "  Unlocking login keychain..."
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" ~/Library/Keychains/login.keychain-db 2>/dev/null || true
  IMPORTED=0
  # Try importing .p12 files from Downloads first
  for p12 in ~/Downloads/*.p12; do
    [ -f "$p12" ] || continue
    echo "  Importing: $(basename "$p12")"
    security import "$p12" -k "$KC" -P "$KEYCHAIN_PASSWORD" -A -T /usr/bin/codesign -T /usr/bin/productbuild 2>/dev/null && IMPORTED=1 || true
  done
  # Fallback: export from login keychain
  if [ "$IMPORTED" = "0" ]; then
    echo "  Exporting certs from login keychain..."
    security export -k ~/Library/Keychains/login.keychain-db -t identities -f pkcs12 -P "$KEYCHAIN_PASSWORD" -o /tmp/cert_export.p12 2>/dev/null || true
    if [ -f /tmp/cert_export.p12 ] && [ -s /tmp/cert_export.p12 ]; then
      security import /tmp/cert_export.p12 -k "$KC" -P "$KEYCHAIN_PASSWORD" -A -T /usr/bin/codesign -T /usr/bin/productbuild 2>/dev/null || true
      rm -f /tmp/cert_export.p12
      IMPORTED=1
    fi
  fi
  if [ "$IMPORTED" = "1" ]; then
    echo "  Certs imported to signing keychain"
  else
    echo "  WARNING: Could not import certs — trying with existing keychain"
  fi
fi

security list-keychains -s "$KC" ~/Library/Keychains/login.keychain-db /Library/Keychains/System.keychain 2>/dev/null || true
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC" 2>/dev/null || true

echo "[1] Prepare .app..."
rm -rf "dist-mas" 2>/dev/null; mkdir -p "dist-mas"
cp -R "$APP" "$APP_DST"
plutil -replace CFBundleVersion -string "$VERSION" "$APP_DST/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APP_DST/Contents/Info.plist"

SIGN_FP=$(security find-certificate -c "3rd Party Mac Developer Application" -p 2>/dev/null | openssl x509 -inform pem -sha1 -fingerprint -noout 2>/dev/null)
find_profile() {
  for dir in "$@"; do
    for f in "$dir"/*.provisionprofile; do
      [ -f "$f" ] || continue
      security cms -D -i "$f" 2>/dev/null > /tmp/_pp.plist
      FP=$(/usr/libexec/PlistBuddy -c "Print :DeveloperCertificates:0" /tmp/_pp.plist 2>/dev/null | openssl x509 -inform der -sha1 -fingerprint -noout 2>/dev/null)
      if [ "$FP" = "$SIGN_FP" ]; then
        cp "$f" "$APP_DST/Contents/embedded.provisionprofile"
        echo "  Profile: $(basename "$f")"
        return 0
      fi
    done
  done
  return 1
}
find_profile ~/Library/MobileDevice/Provisioning\ Profiles ~/Downloads || true

echo "[2] Strip quarantine attributes..."
xattr -cr "$APP_DST"

echo "[2b] Remove QtWebEngineCore + unused frameworks (MAS rejection: private APIs)..."
rm -rf "$APP_DST/Contents/Frameworks/QtWebEngineCore.framework"
rm -rf "$APP_DST/Contents/Frameworks/QtPdf.framework" "$APP_DST/Contents/Frameworks/QtPdfQuick.framework"
rm -rf "$APP_DST/Contents/Frameworks/QtSql.framework"
rm -rf "$APP_DST/Contents/Resources/qml/QtWebEngine" "$APP_DST/Contents/Resources/qml/QtWebChannel"
rm -rf "$APP_DST/Contents/Resources/qml/QtPdf"
rm -rf "$APP_DST/Contents/PlugIns/webengine" "$APP_DST/Contents/PlugIns/sqldrivers"
rm -f "$APP_DST"/Contents/Resources/qtwebengine_*
rm -f "$APP_DST"/Contents/Frameworks/QtWebEngineCore*
find "$APP_DST/Contents" -type d -empty -delete 2>/dev/null || true

echo "[3] Sign inner dylibs..."
find "$APP_DST/Contents" -type f -name "*.dylib" -print0 | xargs -0 -P4 -I{} codesign --force --options=runtime --sign "$CERT" --keychain "$KC" "{}" || true

echo "[4] QtWebEngineProcess already removed (WKWebView — no private APIs)"

echo "[5] Sign all frameworks..."
find "$APP_DST/Contents" -type d -name "*.framework" -print0 | xargs -0 -P4 -I{} codesign --force --options=runtime --sign "$CERT" --keychain "$KC" "{}" || true

echo "[6] Sign main app..."
codesign --force --options=runtime --entitlements "$ENT" --sign "$CERT" --keychain "$KC" "$APP_DST"

echo "[7] Create signed PKG..."
productbuild --component "$APP_DST" /Applications --sign "$INSTALLER_CERT" --keychain "$KC" --identifier "diskraptor" --version "$VERSION" "$PKG"

echo "[8] Upload..."
API_KEY="${APPLE_API_KEY:-${APPLE_API_KEY_ID:-PAWX8HDNG4}}"
API_ISSUER="${APPLE_API_ISSUER:-1782f6bd-09a4-4e82-84b5-9adbb9e1003b}"
if [ -z "$API_KEY" ] || [ -z "$API_ISSUER" ]; then
  echo "  SKIP upload: APPLE_API_KEY and APPLE_API_ISSUER not set in .env"
else
  xcrun altool --upload-app --file "$PKG" --apiKey "$API_KEY" --apiIssuer "$API_ISSUER" --output-format json 2>&1 || echo "  Upload failed (exit code $?)"
fi

echo "=== Done ==="
echo "  PKG: $PKG"
echo "  Upload to App Store Connect at: https://appstoreconnect.apple.com"
