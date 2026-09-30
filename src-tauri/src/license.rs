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
const PUBLIC_KEY_B64: &str = option_env!("DISKRAPTOR_LICENSE_PUBLIC_KEY").unwrap_or("");

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

impl Default for LicenseManager {
    fn default() -> Self {
        let vk = load_verifying_key(PUBLIC_KEY_B64);
        Self {
            verifying_key: vk,
            license: None,
        }
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

impl LicenseManager {
    pub fn activate(&mut self, license_b64: &str) -> Result<(), String> {
        let vk = self
            .verifying_key
            .as_ref()
            .ok_or("No public key configured")?;
        let parts: Vec<&str> = license_b64.splitn(2, '.').collect();
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

#[tauri::command]
pub(crate) fn license_activate(app: tauri::AppHandle, license_key: String) -> JsonResult {
    let st = app.state::<crate::AppState>();
    let mut mgr = st.license.lock();
    match mgr.activate(&license_key) {
        Ok(()) => {
            let info = mgr.status();
            JsonResult::ok(serde_json::to_value(&info).unwrap())
        }
        Err(e) => JsonResult::err(e),
    }
}

#[tauri::command]
pub(crate) fn license_status(app: tauri::AppHandle) -> JsonResult {
    let st = app.state::<crate::AppState>();
    let mgr = st.license.lock();
    let info = mgr.status();
    JsonResult::ok(serde_json::to_value(&info).unwrap())
}
