use std::path::Path;

fn main() {
    // Inject the Ed25519 license public key (raw 32-byte base64) at compile
    // time if a key file exists, so license activation works without any manual
    // env-var setup. `scripts/keygen.sh` writes the raw key to
    // `scripts/public.b64` ("Public key (embed in app)").
    //
    // If the file is absent, activation is disabled (the app reports
    // "No public key configured" instead of crashing).
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    // An explicitly-set env var takes precedence over the generated file.
    let already_set = std::env::var("DISKRAPTOR_LICENSE_PUBLIC_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !already_set {
        for relative in ["public.b64", "scripts/public.b64", "../scripts/public.b64"] {
            let candidate = Path::new(&manifest_dir).join(relative);
            if let Ok(key) = std::fs::read_to_string(&candidate) {
                let key = key.trim();
                if !key.is_empty() {
                    println!("cargo:rustc-env=DISKRAPTOR_LICENSE_PUBLIC_KEY={key}");
                    println!("cargo:rerun-if-changed={}", candidate.display());
                    break;
                }
            }
        }
    }

    tauri_build::build()
}
