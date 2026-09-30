#!/usr/bin/env bash
set -euo pipefail

# keygen.sh — DiskRaptor Pro license key generator.
# Run once to generate a keypair, then sign license payloads.
# Requires OpenSSL 1.1.1+ (already ships with Windows 10+/macOS/Linux).
#
# Usage:
#   ./keygen.sh                           # generate new keypair
#   ./keygen.sh "user@example.com" "pro"  # issue a license
#
# Outputs:
#   public.key        — embed this in the app (or pass to diskraptor build)
#   private.key       — KEEP SECRET; used only to sign licenses
#   LICENSE.key       — signed license payload for the given email

DIR="$(cd "$(dirname "$0")" && pwd)"
PUB="$DIR/public.key"
PRIV="$DIR/private.key"
OUT_LICENSE="$DIR/LICENSE.key"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <email> <type> [days]"
  echo "  email  — customer email"
  echo "  type   — pro | single | trial"
  echo "  days   — validity in days from now (default: 365)"
  echo ""
  echo "Generating new Ed25519 keypair..."
  openssl genpkey -algorithm ed25519 -out "$PRIV" 2>/dev/null || {
    echo "ERROR: OpenSSL not found or too old. Install OpenSSL 1.1.1+."
    exit 1
  }
  openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
  echo "Done. Public key → $PUB"
  echo "     Private key → $PRIV (KEEP SECRET)"
  echo ""
  echo "To issue a license:"
  echo "  $0 user@example.com pro 365"
  exit 0
fi

EMAIL="$1"
TYPE="${2:-pro}"
DAYS="${3:-365}"

if [ ! -f "$PRIV" ]; then
  echo "No private key found. Run without arguments first to generate one."
  exit 1
fi

ISSUED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EXPIRES=$(date -u -d "+${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
          || date -u -v +"${DAYS}"z +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
          || python3 -c "import datetime; print((datetime.datetime.utcnow()+datetime.timedelta(days=$DAYS)).strftime('%Y-%m-%dT%H:%M:%SZ'))")

PAYLOAD=$(printf '{"email":"%s","type":"%s","issued":"%s","expires":"%s"}' "$EMAIL" "$TYPE" "$ISSUED" "$EXPIRES")
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | base64 -w0)

SIG=$(printf '%s' "$PAYLOAD_B64" | openssl pkeyutl -sign -inkey "$PRIV" -pkeyopt digest:null 2>/dev/null | base64 -w0)

LICENSE="${PAYLOAD_B64}.${SIG}"
printf '%s' "$LICENSE" > "$OUT_LICENSE"

PUB_HEX=$(openssl pkey -in "$PRIV" -pubout -outform DER 2>/dev/null | base64 -w0)

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  License issued"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Email:      $EMAIL"
echo "  Type:       $TYPE"
echo "  Expires:    $EXPIRES"
echo "  License:    $LICENSE"
echo ""
echo "  Public key (embed in app):"
echo "    $PUB_HEX"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"