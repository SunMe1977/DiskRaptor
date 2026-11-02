//! Autostart (launch at login) on Windows / macOS / Linux.
//! Off by default: the user enables it in Preferences, which calls
//! `set_autostart`. The app never registers itself at login on first run.

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
