//! System tray enable/disable commands.

use tauri::{AppHandle, Manager};

use crate::state::AppState;

#[tauri::command]
pub(crate) fn set_tray_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_visible(enabled).map_err(|e| e.to_string())
    } else {
        Err("System tray not initialized".to_string())
    }
}

#[tauri::command]
pub(crate) fn get_tray_enabled(app: AppHandle) -> bool {
    let st = app.state::<AppState>();
    let path = st.settings_path.lock().clone();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| v.get("disable_tray").and_then(|v| v.as_bool()))
        .map(|disable| !disable)
        .unwrap_or(true)
}