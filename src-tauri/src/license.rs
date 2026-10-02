//! License verification and activation for DiskRaptor Pro.
//!
//! Uses Ed25519 offline verification: the app embeds the public key;
//! the private key stays in `diskraptor.private` and is used by the
//! keygen script to issue signed license payloads.

use crate::JsonResult;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use tauri::Manager;

// Raw 32-byte Ed25519 public key (base64), injected at compile time via the
// DISKRAPTOR_LICENSE_PUBLIC_KEY env var. Copy the "Public key (embed in app)"
// line printed by scripts/keygen.sh into your build environment:
//   DISKRAPTOR_LICENSE_PUBLIC_KEY=<base64> cargo build --release
// If unset, license activation is disabled ("No public key configured").
// NOTE: `match` instead of `.unwrap_or("")` — `Option::unwrap_or` is not
// usable in `const` context on stable Rust (E0658).
const PUBLIC_KEY_B64: &str = match option_env!("DISKRAPTOR_LICENSE_PUBLIC_KEY") {
    Some(s) => s,
    None => "",
};

#[derive(Clone, Debug, Serialize)]
pub struct LicenseInfo {
    pub state: String,
    pub email: Option<String>,
    pub license_type: Option<String>,
    pub issued: Option<String>,
    pub expires: Option<String>,
}

pub struct LicenseManager {
    verifying_key: Option<VerifyingKey>,
    license: Option<LicenseData>,
}

#[derive(Clone)]
struct LicenseData {
    email: String,
    license_type: String,
    issued: String,
    expires: String,
}

impl LicenseManager {
    /// Build a manager around an explicit verifying key. Production uses
    /// `default()` (compile-time embedded key); tests inject throwaway keys
    /// so no real private key is ever needed to exercise verification.
    pub fn with_verifying_key(verifying_key: Option<VerifyingKey>) -> Self {
        Self {
            verifying_key,
            license: None,
        }
    }

    /// Clear the active license (deactivate). The caller is responsible for
    /// dropping the persisted key from settings as well.
    pub fn deactivate(&mut self) {
        self.license = None;
    }
}

impl Default for LicenseManager {
    fn default() -> Self {
        Self::with_verifying_key(load_verifying_key(PUBLIC_KEY_B64))
    }
}

fn load_verifying_key(b64: &str) -> Option<VerifyingKey> {
    if b64.is_empty() {
        return None;
    }
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    VerifyingKey::from_bytes(&arr).ok()
}

/// Strip all whitespace (spaces, newlines, tabs) from a pasted license key.
/// Email clients word-wrap long lines, so a key copied from the fulfillment
/// mail often contains embedded `\n` — standard base64 rejects those and
/// activation would fail with a decode error even though the key is valid.
pub fn sanitize_license_key(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_whitespace()).collect()
}

impl LicenseManager {
    pub fn activate(&mut self, license_b64: &str) -> Result<(), String> {
        // Sanitize here too so pasted keys with email word-wrap work even
        // when callers forget to clean the input first.
        let clean = sanitize_license_key(license_b64);
        let vk = self
            .verifying_key
            .as_ref()
            .ok_or("No public key configured")?;
        let parts: Vec<&str> = clean.splitn(2, '.').collect();
        if parts.len() != 2 {
            return Err("Invalid license format".to_string());
        }
        let payload_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, parts[0])
                .map_err(|e| format!("Payload decode error: {e}"))?;
        let sig_bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, parts[1])
                .map_err(|e| format!("Signature decode error: {e}"))?;
        if sig_bytes.len() != 64 {
            return Err("Invalid signature length".to_string());
        }
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(&sig_bytes);
        let signature = Signature::from_bytes(&sig_arr);
        vk.verify(&payload_bytes, &signature)
            .map_err(|e| format!("Signature verification failed: {e}"))?;
        let payload: serde_json::Value = serde_json::from_slice(&payload_bytes)
            .map_err(|e| format!("Payload parse error: {e}"))?;
        let email = payload
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let license_type = payload
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let issued = payload
            .get("issued")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let expires = payload
            .get("expires")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let now = chrono::Utc::now();
        let expires_dt = chrono::DateTime::parse_from_rfc3339(&expires)
            .map_err(|e| format!("Bad expires date: {e}"))?;
        if now > expires_dt.with_timezone(&chrono::Utc) {
            return Err("License expired".to_string());
        }
        self.license = Some(LicenseData {
            email,
            license_type,
            issued,
            expires,
        });
        Ok(())
    }

    pub fn status(&self) -> LicenseInfo {
        match &self.license {
            None => LicenseInfo {
                state: "inactive".to_string(),
                email: None,
                license_type: None,
                issued: None,
                expires: None,
            },
            Some(d) => {
                let expires_dt = chrono::DateTime::parse_from_rfc3339(&d.expires).ok();
                let state = match expires_dt {
                    Some(dt) if chrono::Utc::now() > dt.with_timezone(&chrono::Utc) => "expired",
                    _ => &d.license_type,
                };
                LicenseInfo {
                    state: state.to_string(),
                    email: Some(d.email.clone()),
                    license_type: Some(d.license_type.clone()),
                    issued: Some(d.issued.clone()),
                    expires: Some(d.expires.clone()),
                }
            }
        }
    }
}

/// Merge one key into settings.json (atomic write via temp file + rename),
/// mirroring `cmds::settings::save_settings`. `value = None` removes the key.
fn persist_license_setting(state: &crate::AppState, value: Option<&str>) {
    let path = state.settings_path.lock().clone();
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = merged.as_object_mut() {
        match value {
            Some(v) => {
                obj.insert("license_key".to_string(), serde_json::Value::String(v.to_string()));
            }
            None => {
                obj.remove("license_key");
            }
        }
        if let Ok(json) = serde_json::to_string_pretty(&merged) {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, &json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

#[tauri::command]
pub(crate) fn license_activate(app: tauri::AppHandle, license_key: String) -> JsonResult {
    let st = app.state::<crate::AppState>();
    let mut mgr = st.license.lock();
    // Sanitize before verify AND persist: email word-wrap inserts newlines
    // that would otherwise fail verification (and re-break on restart).
    let clean = sanitize_license_key(&license_key);
    match mgr.activate(&clean) {
        Ok(()) => {
            // Persist so Pro survives restarts; restored in `main()` at startup.
            persist_license_setting(&st, Some(clean.trim()));
            let info = mgr.status();
            JsonResult::ok(serde_json::to_value(&info).unwrap())
        }
        Err(e) => JsonResult::err(e),
    }
}

#[tauri::command]
pub(crate) fn license_deactivate(app: tauri::AppHandle) -> JsonResult {
    let st = app.state::<crate::AppState>();
    st.license.lock().deactivate();
    persist_license_setting(&st, None);
    JsonResult::ok(serde_json::json!({ "state": "inactive" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use ed25519_dalek::{Signer, SigningKey};

    /// Deterministic throwaway keypair — no RNG, no real private key.
    /// The payload/signature layout mirrors `scripts/keygen.sh` exactly
    /// (raw JSON bytes, standard base64, `<payload>.<signature>`).
    fn test_keypair() -> (SigningKey, VerifyingKey) {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let verifying = signing.verifying_key();
        (signing, verifying)
    }

    fn issue(signing: &SigningKey, email: &str, license_type: &str, expires: &str) -> String {
        let payload = serde_json::json!({
            "email": email,
            "type": license_type,
            "issued": "2026-01-01T00:00:00Z",
            "expires": expires,
        });
        let raw = serde_json::to_vec(&payload).unwrap();
        let sig = signing.sign(&raw);
        let b64 = base64::engine::general_purpose::STANDARD;
        format!("{}.{}", b64.encode(&raw), b64.encode(sig.to_bytes()))
    }

    const FUTURE: &str = "2999-01-01T00:00:00Z";
    const PAST: &str = "2000-01-01T00:00:00Z";

    #[test]
    fn default_status_is_inactive() {
        let mgr = LicenseManager::with_verifying_key(None);
        assert_eq!(mgr.status().state, "inactive");
    }

    #[test]
    fn activate_valid_key_reports_pro() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let key = issue(&signing, "user@example.com", "pro", FUTURE);
        mgr.activate(&key).expect("valid license must activate");
        let info = mgr.status();
        assert_eq!(info.state, "pro");
        assert_eq!(info.email.as_deref(), Some("user@example.com"));
        assert_eq!(info.license_type.as_deref(), Some("pro"));
    }

    #[test]
    fn activate_rejects_tampered_payload() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let key = issue(&signing, "user@example.com", "pro", FUTURE);
        // Flip one payload byte after signing: signature must no longer verify.
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut raw = b64.decode(key.split('.').next().unwrap()).unwrap();
        raw[10] ^= 0x01;
        let tampered = format!(
            "{}.{}",
            b64.encode(&raw),
            key.split('.').nth(1).unwrap()
        );
        assert!(mgr.activate(&tampered).is_err());
        assert_eq!(mgr.status().state, "inactive");
    }

    #[test]
    fn activate_rejects_wrong_key() {
        let (signing, _) = test_keypair();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let mut mgr = LicenseManager::with_verifying_key(Some(other.verifying_key()));
        let key = issue(&signing, "user@example.com", "pro", FUTURE);
        assert!(mgr.activate(&key).is_err());
    }

    #[test]
    fn activate_rejects_malformed_input() {
        let (_, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        assert!(mgr.activate("").is_err());
        assert!(mgr.activate("no-separator-here").is_err());
        assert!(mgr.activate("!!!.???").is_err());
        // Valid base64 but 3-byte signature instead of 64.
        let b64 = base64::engine::general_purpose::STANDARD;
        assert!(mgr.activate(&format!("{}.{}", b64.encode(b"{}"), b64.encode(b"abc"))).is_err());
    }

    #[test]
    fn activate_rejects_expired_license() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let key = issue(&signing, "user@example.com", "pro", PAST);
        let err = mgr.activate(&key).unwrap_err();
        assert!(err.contains("expired"), "unexpected error: {err}");
        assert_eq!(mgr.status().state, "inactive");
    }

    #[test]
    fn activate_accepts_email_word_wrapped_key() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let key = issue(&signing, "user@example.com", "pro", FUTURE);
        // Simulate email word-wrap: newlines/spaces every 64 chars + edges.
        let mut wrapped = String::from("  \n");
        for (i, c) in key.chars().enumerate() {
            wrapped.push(c);
            if (i + 1) % 64 == 0 {
                wrapped.push_str("\r\n ");
            }
        }
        wrapped.push('\n');
        mgr.activate(&wrapped).expect("wrapped key must activate");
        assert_eq!(mgr.status().state, "pro");
    }

    #[test]
    fn deactivate_clears_pro_state() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        mgr.activate(&issue(&signing, "user@example.com", "pro", FUTURE))
            .unwrap();
        assert_eq!(mgr.status().state, "pro");
        mgr.deactivate();
        let info = mgr.status();
        assert_eq!(info.state, "inactive");
        assert!(info.email.is_none());
    }
}

#[tauri::command]
pub(crate) fn license_status(app: tauri::AppHandle) -> JsonResult {
    let st = app.state::<crate::AppState>();
    let mgr = st.license.lock();
    let info = mgr.status();
    JsonResult::ok(serde_json::to_value(&info).unwrap())
}
