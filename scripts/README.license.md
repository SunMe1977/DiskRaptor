# diskraptor.private — Private repository for DiskRaptor licensing.

## Contents
- `keygen.sh` — Ed25519 license key generator (run without args to generate a keypair, then `./keygen.sh <email> <type> <days>` to issue a license).
- `public.key` — Ed25519 public key to embed in the app build.
- `private.key` — Ed25519 private key (kept secret, used only for signing). **NEVER commit this.**
- `LICENSE.key` — issued license payloads (public, per-user).

## Security notes
- The **private key** never ships in builds. The only thing embedded in the app binary is `public.key`.
- License keys are verified offline in the Rust code via Ed25519 (`src/license.rs`).
- This repo is **private** and should be access-controlled to the release engineer only.

## Usage
```bash
cd scripts
chmod +x keygen.sh
./keygen.sh                          # generate keypair
./keygen.sh user@example.com pro 365 # issue license
```