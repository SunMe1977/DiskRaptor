# diskraptor.private — Private repository for DiskRaptor licensing.

## Contents
- `keygen.sh` — Ed25519 license key generator (run without args to generate a keypair, then `./keygen.sh <email> <type> <days>` to issue a license).
- `public.key` — Ed25519 public key (SPKI PEM, for reference/verify). **Committed**
  (public by design — every binary embeds it; CI/release builds need it).
- `public.b64` — RAW 32-byte public key (base64). `src-tauri/build.rs` reads this and embeds it automatically. **Committed.**
- `private.key` — Ed25519 private key (kept secret, used only for signing). **NEVER commit this.**
  The license server MUST hold this exact key — a server with its own
  keypair issues licenses no app build will accept. Deploy it out-of-band
  (SSH/`scp`), then verify on the server:
  `openssl pkey -in scripts/private.key -pubout -outform DER | tail -c 32 | base64`
  must print the same string as `scripts/public.b64`.
- `LICENSE.key` — issued license payload (public, per-user).

## Security notes
- The **private key** never ships in builds.
- The app embeds the **raw 32-byte** Ed25519 public key (base64) from `public.b64`.
- License keys are verified offline in the Rust code via Ed25519 (`src/license.rs`).
- This repo is **private** and should be access-controlled to the release engineer only.

## Embedding the public key at build time
`keygen.sh` writes the raw 32-byte public key to `public.b64`. `src-tauri/build.rs`
auto-detects that file and injects it via the `DISKRAPTOR_LICENSE_PUBLIC_KEY`
compile-time env var, so a normal `cargo build --release` picks it up with no
manual steps. You can also set the env var directly (it takes precedence):

```bash
export DISKRAPTOR_LICENSE_PUBLIC_KEY="<raw-32-byte-base64>"
cargo build --release
```

If no key is available, activation reports "No public key configured".

## Usage
```bash
cd scripts
chmod +x keygen.sh
./keygen.sh                          # generate keypair
./keygen.sh user@example.com pro 365 # issue license
```

## License format
`<payload-base64>.<signature-base64>` — the payload is the raw JSON
`{"email","type","issued","expires"}` (not base64 of it), signed with Ed25519
(OpenSSL `pkeyutl -sign -rawin`). The app decodes the payload and verifies the
signature over those exact raw bytes.

## Creem short codes (online activation)
Keys like `XXXX-XXXX-...` issued by Creem's license addon are validated
online (`POST /v1/licenses/{activate,validate,deactivate}`) instead of
offline. The app embeds `DISKRAPTOR_CREEM_API_KEY` + `DISKRAPTOR_CREEM_PRODUCT_ID`
at compile time (`src-tauri/build.rs` also reads them as `CREEM_API_KEY` /
`CREEM_PRODUCT_ID` from `scripts/.env` for local builds); without them only
offline keys work. GitHub releases need the same values as Actions secrets.