//! Settings persistence (atomic write via temp file + rename).
use crate::{AppState, JsonResult};
use tauri::State;

#[tauri::command]
pub(crate) fn save_settings(state: State<AppState>, settings: serde_json::Value) -> JsonResult {
    // Accept both `invoke("save_settings", { settings: {...} })` and a raw payload.
    let settings = match settings.get("settings") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => settings,
    };
    let path = state.settings_path.lock().clone();
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let (Some(obj), Some(updates)) = (merged.as_object_mut(), settings.as_object()) {
        for (k, v) in updates {
            obj.insert(k.clone(), v.clone());
        }
        if let Ok(json) = serde_json::to_string_pretty(&merged) {
            // Atomic write: write to a temp file then rename, so a crash in the
            // middle never leaves a truncated/corrupt settings.json behind.
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, &json).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
                return JsonResult::ok_empty();
            }
        }
    }
    JsonResult::err("Failed to save settings")
}

#[tauri::command]
pub(crate) fn load_settings(state: State<AppState>) -> JsonResult {
    let path = state.settings_path.lock().clone();
    if let Ok(json) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            return JsonResult::ok(v);
        }
    }
    JsonResult::ok(serde_json::json!({}))
}
