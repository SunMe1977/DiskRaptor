//! Autostart (launch at login) on Windows / macOS / Linux.
//! The frontend toggles this from Preferences; it defaults to enabled on the
//! first run (see main.rs setup).

use tauri_plugin_autostart::ManagerExt;

#[tauri::command]
pub(crate) fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let auto = app.autolaunch();
    if enabled {
        auto.enable().map_err(|e| e.to_string())
    } else {
        auto.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub(crate) fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}
