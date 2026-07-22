#!/bin/bash
# Fix Keychain ACL so codesign/productbuild don't prompt for password.
# Uses KEYCHAIN_PASSWORD from .env, or prompts interactively.

set -euo pipefail

KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

echo "=== DiskRaptor Keychain Fix ==="
echo ""

# Get password from env or prompt
if [ -n "${KEYCHAIN_PASSWORD:-}" ]; then
  echo "  Using KEYCHAIN_PASSWORD from environment"
else
  echo -n "Keychain password: "
  read -s KEYCHAIN_PASSWORD
  echo ""
fi

# Unlock
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

# Keep unlocked for 4 hours
security set-keychain-settings -t 14400 "$KEYCHAIN"

# Set partition list (allows codesign/productbuild without prompt)
echo "  Setting partition list..."
security set-key-partition-list \
  -S apple-tool:,apple:,codesign:,productbuild: \
  -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN"

# Update ACL on existing certificates to allow access without prompt
echo "  Updating certificate ACLs..."
CERT_HASHES=$(security find-identity -v -p codesigning 2>/dev/null | grep -E "^[[:space:]]*[0-9]" | sed 's/^[[:space:]]*[0-9]*) //' | awk '{print $1}')
for hash in $CERT_HASHES; do
  security import <(security find-certificate -p -Z "$KEYCHAIN" 2>/dev/null | grep -A1 "$hash" || true) \
    -k "$KEYCHAIN" -A -T /usr/bin/codesign -T /usr/bin/productbuild -T /usr/bin/security 2>/dev/null || true
done

echo ""
echo "=== Done! ==="
echo ""
security find-identity -v -p codesigning
