//! License verification and activation for DiskRaptor Pro.
//!
//! Two key formats are accepted:
//! 1. Offline keys (`<payload-b64>.<signature-b64>`): Ed25519-signed by
//!    `scripts/keygen.sh`, verified locally with the embedded public key.
//! 2. Creem keys (`XXXX-XXXX-...`): issued by Creem's license addon and
//!    validated online via the Creem Licenses API
//!    (`POST /v1/licenses/{activate,validate,deactivate}`).
//!    The API key/product are embedded at compile time; the per-machine
//!    instance id is persisted in settings.json after activation.

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

// Creem online activation (compile-time config; see build.rs, which also
// picks these up from scripts/.env for local builds).
const CREEM_API_KEY: &str = match option_env!("DISKRAPTOR_CREEM_API_KEY") {
    Some(s) => s,
    None => "",
};
const CREEM_PRODUCT_ID: &str = match option_env!("DISKRAPTOR_CREEM_PRODUCT_ID") {
    Some(s) => s,
    None => "",
};
const CREEM_BASE_URL: &str = "https://api.creem.io";

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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LicenseKind {
    Offline,
    Creem,
}

#[derive(Clone)]
struct LicenseData {
    email: String,
    license_type: String,
    issued: String,
    expires: String,
    kind: LicenseKind,
    /// Creem credentials (only for `LicenseKind::Creem`).
    creem_key: String,
    creem_instance_id: String,
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
    /// Activate either key format. Returns the kind so callers persist the
    /// right representation (offline key vs. Creem key + instance id).
    /// `instance_name` labels this machine for Creem activations (ignored
    /// for offline keys).
    pub fn activate(&mut self, license_b64: &str, instance_name: &str) -> Result<LicenseKind, String> {
        // Sanitize here too so pasted keys with email word-wrap work even
        // when callers forget to clean the input first.
        let clean = sanitize_license_key(license_b64);
        if clean.is_empty() {
            return Err("Invalid license format".to_string());
        }
        if clean.contains('.') {
            self.activate_offline(&clean)?;
            return Ok(LicenseKind::Offline);
        }
        // No dot: must be a Creem short code (XXXX-XXXX-...).
        self.activate_creem(&clean, instance_name)?;
        Ok(LicenseKind::Creem)
    }

    /// Credentials needed to deactivate/validate a Creem license online.
    pub fn creem_credentials(&self) -> Option<(String, String)> {
        match &self.license {
            Some(d) if d.kind == LicenseKind::Creem => {
                Some((d.creem_key.clone(), d.creem_instance_id.clone()))
            }
            _ => None,
        }
    }

    /// Revalidate a restored Creem license against the API. Returns true if
    /// Pro stays active. Offline licenses need no check. A *network* failure
    /// keeps the cached state (grace for offline use); an explicit revoked /
    /// expired / unknown answer drops it.
    pub fn revalidate(&mut self) -> bool {
        let (key, instance) = match self.creem_credentials() {
            Some(c) => c,
            None => return self.license.is_some(),
        };
        match creem_validate(&key, &instance) {
            Ok(grant) => {
                if let Some(d) = self.license.as_mut() {
                    d.expires = grant.expires_at;
                }
                true
            }
            Err(CreemError::Network(_)) => true,
            Err(_) => {
                self.license = None;
                false
            }
        }
    }

    fn activate_offline(&mut self, clean: &str) -> Result<(), String> {
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
            kind: LicenseKind::Offline,
            creem_key: String::new(),
            creem_instance_id: String::new(),
        });
        Ok(())
    }

    /// Online activation of a Creem short code. Registers this machine as a
    /// license instance and stores the returned instance id for later
    /// validation/deactivation.
    fn activate_creem(&mut self, key: &str, instance_name: &str) -> Result<(), String> {
        let (api_key, product) = match creem_config() {
            Some(c) => c,
            None => return Err("Online activation not configured".to_string()),
        };
        let agent = creem_agent();
        let body = creem_post(
            &agent,
            "/v1/licenses/activate",
            &api_key,
            serde_json::json!({ "key": key, "instance_name": instance_name }),
        )
        .map_err(|e| match e {
            CreemError::Network(msg) => msg,
            CreemError::Rejected(msg) => msg,
        })?;
        let entity: serde_json::Value =
            serde_json::from_str(&body).map_err(|_| "License server error: bad response".to_string())?;
        let grant = parse_license_entity(&entity, &product)?;
        self.license = Some(LicenseData {
            email: String::new(),
            license_type: "pro".to_string(),
            issued: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            expires: grant.expires_at,
            kind: LicenseKind::Creem,
            creem_key: key.to_string(),
            creem_instance_id: grant.instance_id,
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
                    email: if d.email.is_empty() { None } else { Some(d.email.clone()) },
                    license_type: Some(d.license_type.clone()),
                    issued: if d.issued.is_empty() { None } else { Some(d.issued.clone()) },
                    expires: if d.expires.is_empty() { None } else { Some(d.expires.clone()) },
                }
            }
        }
    }
}

// ── Creem online licensing ──────────────────────────────────────

/// Compile-time Creem credentials (embedded via build-time env).
fn creem_config() -> Option<(String, String)> {
    if CREEM_API_KEY.is_empty() || CREEM_PRODUCT_ID.is_empty() {
        return None;
    }
    Some((CREEM_API_KEY.to_string(), CREEM_PRODUCT_ID.to_string()))
}

fn creem_agent() -> ureq::Agent {
    // ureq 3.x API: Agent built from a Config (AgentBuilder was removed).
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(15)))
        .build();
    ureq::Agent::new_with_config(config)
}

/// POST a JSON body to the Creem API (ureq 3.x has no send_json helper).
/// Returns the response body text; HTTP failures map to [`CreemError`].
fn creem_post(
    agent: &ureq::Agent,
    path: &str,
    api_key: &str,
    payload: serde_json::Value,
) -> Result<String, CreemError> {
    let body = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    let mut resp = agent
        .post(&format!("{CREEM_BASE_URL}{path}"))
        .header("x-api-key", api_key)
        .header("Content-Type", "application/json")
        .send(&body)
        .map_err(creem_error)?;
    resp.body_mut()
        .read_to_string()
        .map_err(|e| CreemError::Network(format!("No connection to license server ({e})")))
}

/// Error from a Creem API round-trip. Network failures are distinguished so
/// callers can grant offline grace instead of dropping Pro.
#[derive(Debug)]
enum CreemError {
    Network(String),
    Rejected(String),
}

fn creem_error(e: ureq::Error) -> CreemError {
    match e {
        ureq::Error::StatusCode(code) => CreemError::Rejected(match code {
            404 => "License key not found".to_string(),
            401 => "License server rejected the app key".to_string(),
            403 => "License activation limit reached".to_string(),
            409 => "License instance already deactivated".to_string(),
            410 => "License has been revoked or expired".to_string(),
            _ => format!("License server error (HTTP {code})"),
        }),
        other => CreemError::Network(format!("No connection to license server ({other})")),
    }
}

/// Parsed grant from a Creem LicenseEntity response.
#[derive(Debug)]
struct CreemGrant {
    instance_id: String,
    expires_at: String,
}

/// Validate a Creem LicenseEntity: must be active and belong to our product.
fn parse_license_entity(entity: &serde_json::Value, product: &str) -> Result<CreemGrant, String> {
    let status = entity.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "active" {
        return Err(format!("License is {status}"));
    }
    let entity_product = entity.get("product_id").and_then(|v| v.as_str()).unwrap_or("");
    if !product.is_empty() && entity_product != product {
        return Err("License is for a different product".to_string());
    }
    let instance_id = entity
        .get("instance")
        .and_then(|i| i.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if instance_id.is_empty() {
        return Err("License server error: no instance".to_string());
    }
    let expires_at = entity
        .get("expires_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(CreemGrant { instance_id, expires_at })
}

/// Online revalidation of a stored Creem key + instance id.
fn creem_validate(key: &str, instance_id: &str) -> Result<CreemGrant, CreemError> {
    let (api_key, product) = match creem_config() {
        Some(c) => c,
        None => return Err(CreemError::Rejected("Online activation not configured".to_string())),
    };
    let body = creem_post(
        &creem_agent(),
        "/v1/licenses/validate",
        &api_key,
        serde_json::json!({ "key": key, "instance_id": instance_id }),
    )?;
    let entity: serde_json::Value = serde_json::from_str(&body)
        .map_err(|_| CreemError::Rejected("License server error: bad response".to_string()))?;
    parse_license_entity(&entity, &product).map_err(CreemError::Rejected)
}

/// Best-effort online deactivation (frees the Creem instance slot).
fn creem_deactivate(key: &str, instance_id: &str) {
    let Some((api_key, _)) = creem_config() else {
        return;
    };
    // Drain the body so the connection is cleanly released; ignore outcome.
    let _ = creem_post(
        &creem_agent(),
        "/v1/licenses/deactivate",
        &api_key,
        serde_json::json!({ "key": key, "instance_id": instance_id }),
    );
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
    // Sanitize before verify AND persist: email word-wrap inserts newlines
    // that would otherwise fail verification (and re-break on restart).
    let clean = sanitize_license_key(&license_key);
    let instance_name = get_or_create_instance_name(&st);
    let mut mgr = st.license.lock();
    match mgr.activate(&clean, &instance_name) {
        Ok(kind) => {
            // Persist so Pro survives restarts; restored in `main()` at startup.
            match kind {
                LicenseKind::Offline => {
                    persist_license_setting(&st, Some(clean.trim()));
                    persist_creem_license(&st, None);
                }
                LicenseKind::Creem => {
                    persist_license_setting(&st, None);
                    let creds = mgr.creem_credentials().unwrap_or_default();
                    persist_creem_license(&st, Some((creds.0.as_str(), creds.1.as_str())));
                }
            }
            let info = mgr.status();
            JsonResult::ok(serde_json::to_value(&info).unwrap())
        }
        Err(e) => JsonResult::err(e),
    }
}

#[tauri::command]
pub(crate) fn license_deactivate(app: tauri::AppHandle) -> JsonResult {
    let st = app.state::<crate::AppState>();
    // Capture Creem credentials before clearing so the instance slot can be
    // freed online (best effort — local state clears regardless).
    let creds = st.license.lock().creem_credentials();
    st.license.lock().deactivate();
    if let Some((key, instance)) = creds {
        if !key.is_empty() && !instance.is_empty() {
            creem_deactivate(&key, &instance);
        }
    }
    persist_license_setting(&st, None);
    persist_creem_license(&st, None);
    JsonResult::ok(serde_json::json!({ "state": "inactive" }))
}

/// Restore persisted licenses at startup: offline key first, then Creem
/// (with online revalidation). Invalid/expired keys are ignored.
pub fn restore_persisted(state: &crate::AppState) {
    let (offline_key, creem) = read_persisted_licenses(state);
    if let Some(key) = offline_key {
        if !key.is_empty() {
            let instance = get_or_create_instance_name(state);
            let _ = state.license.lock().activate(&key, &instance);
            return;
        }
    }
    if let Some((key, instance)) = creem {
        if key.is_empty() {
            return;
        }
        // Seed the manager without network, then revalidate: offline grace
        // keeps Pro when the network is down; revoked keys are dropped.
        {
            let mut mgr = state.license.lock();
            mgr.license = Some(LicenseData {
                email: String::new(),
                license_type: "pro".to_string(),
                issued: String::new(),
                expires: String::new(),
                kind: LicenseKind::Creem,
                creem_key: key,
                creem_instance_id: instance,
            });
        }
        if !state.license.lock().revalidate() {
            persist_creem_license(state, None);
        }
    }
}

fn read_persisted_licenses(state: &crate::AppState) -> (Option<String>, Option<(String, String)>) {
    let path = state.settings_path.lock().clone();
    let json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    let offline = json
        .get("license_key")
        .and_then(|k| k.as_str())
        .map(sanitize_license_key);
    let creem = json.get("creem_license").and_then(|v| {
        let key = v.get("key").and_then(|k| k.as_str()).unwrap_or("").to_string();
        let instance = v.get("instance_id").and_then(|k| k.as_str()).unwrap_or("").to_string();
        if key.is_empty() {
            None
        } else {
            Some((key, instance))
        }
    });
    (offline, creem)
}

/// Stable per-machine label for Creem activations (readable in the Creem
/// dashboard). Generated once and persisted; no extra crates needed.
fn get_or_create_instance_name(state: &crate::AppState) -> String {
    let path = state.settings_path.lock().clone();
    let mut merged: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(existing) = merged.get("creem_instance_name").and_then(|v| v.as_str()) {
        if !existing.trim().is_empty() {
            return existing.to_string();
        }
    }
    // Hash of (nanos, pid) — unique enough for a dashboard label.
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let name = format!("diskraptor-{:016x}", h.finish());
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("creem_instance_name".to_string(), serde_json::Value::String(name.clone()));
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
    name
}

/// Persist (or clear) the Creem credentials in settings.json.
fn persist_creem_license(state: &crate::AppState, value: Option<(&str, &str)>) {
    let path = state.settings_path.lock().clone();
    let mut merged: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = merged.as_object_mut() {
        match value {
            Some((key, instance)) => {
                obj.insert(
                    "creem_license".to_string(),
                    serde_json::json!({ "key": key, "instance_id": instance }),
                );
            }
            None => {
                obj.remove("creem_license");
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
        mgr.activate(&key, "test-instance").expect("valid license must activate");
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
        assert!(mgr.activate(&tampered, "test-instance").is_err());
        assert_eq!(mgr.status().state, "inactive");
    }

    #[test]
    fn activate_rejects_wrong_key() {
        let (signing, _) = test_keypair();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let mut mgr = LicenseManager::with_verifying_key(Some(other.verifying_key()));
        let key = issue(&signing, "user@example.com", "pro", FUTURE);
        assert!(mgr.activate(&key, "test-instance").is_err());
    }

    #[test]
    fn activate_rejects_malformed_input() {
        let (_, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        assert!(mgr.activate("", "test-instance").is_err());
        // Dotless junk routes to the Creem path, which fails fast without
        // compiled-in credentials (no network in unit tests).
        assert!(mgr.activate("no-separator-here", "test-instance").is_err());
        assert!(mgr.activate("!!!.???", "test-instance").is_err());
        // Valid base64 but 3-byte signature instead of 64.
        let b64 = base64::engine::general_purpose::STANDARD;
        assert!(mgr.activate(&format!("{}.{}", b64.encode(b"{}"), b64.encode(b"abc")), "test-instance").is_err());
    }

    #[test]
    fn activate_rejects_expired_license() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let key = issue(&signing, "user@example.com", "pro", PAST);
        let err = mgr.activate(&key, "test-instance").unwrap_err();
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
        mgr.activate(&wrapped, "test-instance").expect("wrapped key must activate");
        assert_eq!(mgr.status().state, "pro");
    }

    fn creem_entity(status: &str, product: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "lk_test",
            "object": "license",
            "product_id": product,
            "status": status,
            "key": "N3BOP-JY4DX-WC6U4-CCZQB-6NG55",
            "activation": 1,
            "activation_limit": null,
            "expires_at": null,
            "created_at": "2026-10-02T16:47:45.375Z",
            "instance": {
                "object": "license-instance",
                "id": "lki_test",
                "name": "diskraptor-test",
                "status": "active",
                "created_at": "2026-10-02T16:51:44.846Z",
                "mode": "prod"
            },
            "mode": "prod"
        })
    }

    #[test]
    fn creem_grant_parses_active_entity() {
        let grant = parse_license_entity(&creem_entity("active", "prod_abc"), "prod_abc")
            .expect("active entity must parse");
        assert_eq!(grant.instance_id, "lki_test");
        assert!(grant.expires_at.is_empty());
    }

    #[test]
    fn creem_grant_rejects_wrong_product() {
        let err = parse_license_entity(&creem_entity("active", "prod_other"), "prod_abc").unwrap_err();
        assert!(err.contains("different product"), "unexpected error: {err}");
    }

    #[test]
    fn creem_grant_rejects_inactive_status() {
        for status in ["inactive", "expired", "disabled"] {
            let err = parse_license_entity(&creem_entity(status, "prod_abc"), "prod_abc").unwrap_err();
            assert!(err.contains(status), "unexpected error: {err}");
        }
    }

    #[test]
    fn creem_grant_rejects_missing_instance() {
        let mut entity = creem_entity("active", "prod_abc");
        entity.as_object_mut().unwrap().remove("instance");
        assert!(parse_license_entity(&entity, "prod_abc").is_err());
    }

    #[test]
    fn creem_dotless_input_routes_online() {
        // Dotless input takes the Creem online path: without compiled-in
        // credentials it fails fast (no network); with credentials a bogus
        // key is rejected by the API. Either way it must Err, never panic,
        // and never activate. (NOTE: never use a real customer key here —
        // a successful call would register a live instance.)
        let (_, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        let err = mgr.activate("UNIT-TEST-BOGUS-KEY-00000", "test-instance").unwrap_err();
        assert!(
            err.contains("not configured")
                || err.contains("not found")
                || err.contains("connection")
                || err.contains("different product")
                || err.contains("License is"),
            "unexpected error: {err}"
        );
        assert_eq!(mgr.status().state, "inactive");
    }

    #[test]
    fn deactivate_clears_pro_state() {
        let (signing, verifying) = test_keypair();
        let mut mgr = LicenseManager::with_verifying_key(Some(verifying));
        mgr.activate(&issue(&signing, "user@example.com", "pro", FUTURE), "test-instance")
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
