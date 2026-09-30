#!/usr/bin/env bash
set -euo pipefail

# keygen.sh — DiskRaptor Pro license key generator.
# Run once to generate a keypair, then sign license payloads.
# Requires OpenSSL 3.0+ (ships with Windows 10+/macOS/Linux).
#
# Usage:
#   ./keygen.sh                           # generate new keypair
#   ./keygen.sh "user@example.com" "pro"  # issue a license
#
# Outputs:
#   public.key        — Ed25519 public key (SPKI PEM, for reference/verify)
#   public.b64        — RAW 32-byte public key (base64) that build.rs embeds in the app
#   private.key       — KEEP SECRET; used only to sign licenses
#   LICENSE.key       — signed license payload for the given email

DIR="$(cd "$(dirname "$0")" && pwd)"
PUB="$DIR/public.key"
PUB_RAW="$DIR/public.b64"
PRIV="$DIR/private.key"
OUT_LICENSE="$DIR/LICENSE.key"

# Portable base64 encode (single line, no wrap) for GNU + BSD/macOS.
b64() {
  base64 | tr -d '\n'
}

# Portable "date in N days" (Linux GNU date vs macOS BSD date).
date_add_days() {
  local days="$1"
  if date -u -d "+${days} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then
    return 0
  fi
  if date -u -v "+${days}d" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null; then
    return 0
  fi
  python3 -c "import datetime; print((datetime.datetime.utcnow()+datetime.timedelta(days=${days})).strftime('%Y-%m-%dT%H:%M:%SZ'))" 2>/dev/null
}

# Extract the RAW 32-byte Ed25519 public key from an OpenSSL private key.
# The DER SubjectPublicKeyInfo encoding ends with the 32 raw key bytes,
# which is exactly what the app embeds (and what ed25519_dalek verifies with).
extract_raw_pubkey() {
  openssl pkey -in "$PRIV" -pubout -outform DER 2>/dev/null | tail -c 32 | b64
}

if [ $# -lt 2 ]; then
  echo "Usage: $0 <email> <type> [days]"
  echo "  email  — customer email"
  echo "  type   — pro | single | trial"
  echo "  days   — validity in days from now (default: 365)"
  echo ""
  echo "Generating new Ed25519 keypair..."
  openssl genpkey -algorithm ed25519 -out "$PRIV" 2>/dev/null || {
    echo "ERROR: OpenSSL not found or too old. Install OpenSSL 3.0+."
    exit 1
  }
  openssl pkey -in "$PRIV" -pubout -out "$PUB" 2>/dev/null
  extract_raw_pubkey > "$PUB_RAW"
  echo "Done. Public key (SPKI) → $PUB"
  echo "     Public key (raw, for build) → $PUB_RAW"
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
EXPIRES=$(date_add_days "$DAYS")

PAYLOAD=$(printf '{"email":"%s","type":"%s","issued":"%s","expires":"%s"}' "$EMAIL" "$TYPE" "$ISSUED" "$EXPIRES")

# Sign the RAW JSON payload (not its base64). The Rust app decodes the
# payload and verifies the signature over those exact bytes, so the signed
# message must be the raw JSON.
TMP_PAYLOAD="$(mktemp)"
TMP_SIG="$(mktemp)"
trap 'rm -f "$TMP_PAYLOAD" "$TMP_SIG"' EXIT
printf '%s' "$PAYLOAD" > "$TMP_PAYLOAD"

# OpenSSL 3.x: use -rawin so Ed25519 signs the message directly (RFC 8032).
# -rawin requires a seekable file, so we pass -in rather than stdin.
openssl pkeyutl -sign -inkey "$PRIV" -rawin -in "$TMP_PAYLOAD" -out "$TMP_SIG" 2>/dev/null

PAYLOAD_B64=$(b64 < "$TMP_PAYLOAD")
SIG_B64=$(b64 < "$TMP_SIG")

LICENSE="${PAYLOAD_B64}.${SIG_B64}"
printf '%s' "$LICENSE" > "$OUT_LICENSE"

PUB_B64=$(extract_raw_pubkey)
printf '%s' "$PUB_B64" > "$PUB_RAW"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  License issued"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Email:      $EMAIL"
echo "  Type:       $TYPE"
echo "  Expires:    $EXPIRES"
echo "  License:    $LICENSE"
echo ""
echo "  Public key (embed in app, RAW 32-byte base64):"
echo "    $PUB_B64"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
