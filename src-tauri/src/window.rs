//! Window management: bounds persistence, restore, setup.
use tauri::{AppHandle, Manager, Window};
use tracing::debug;

use crate::{state::AppState, menu};

/// Persist the window size/position into settings.json so the next launch
/// restores it. Best-effort; failures are ignored.
pub fn save_window_bounds(window: &Window) {
    let st = match window.app_handle().try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    let Ok(size) = window.outer_size() else { return };
    let Ok(pos) = window.outer_position() else { return };
    let path = st.settings_path.lock().clone();
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = merged.as_object_mut() {
        obj.insert(
            "window_bounds".into(),
            serde_json::json!({ "x": pos.x, "y": pos.y, "w": size.width, "h": size.height }),
        );
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&merged).unwrap_or_default());
}

/// Restore a saved window size/position at startup (best-effort).
pub fn restore_window_bounds(app: &AppHandle) {
    use serde::Deserialize;
    #[derive(Deserialize)]
    struct Bounds { x: i32, y: i32, w: u32, h: u32 }
    let st = app.state::<AppState>();
    let path = st.settings_path.lock().clone();
    let b: Option<Bounds> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| v.get("window_bounds").cloned())
        .and_then(|v| serde_json::from_value(v).ok());
    if let Some(b) = b {
        if b.w >= 800 && b.h >= 500 {
            if let Some(win) = app.get_webview_window("main") {
                // Clamp the restored size/position to the primary monitor so a
                // stale or off-screen saved state can never exceed the screen.
                let (sw, sh, sf) = win
                    .primary_monitor()
                    .ok()
                    .flatten()
                    .map(|m| {
                        let s = m.size();
                        (s.width as f64, s.height as f64, m.scale_factor())
                    })
                    .unwrap_or((1920.0, 1080.0, 1.0));
                let lw = (sw / sf) as i32;
                let lh = (sh / sf) as i32;
                let w = (b.w as i32).clamp(800, lw);
                let h = (b.h as i32).clamp(500, lh);
                let x = b.x.clamp(0, (lw - w).max(0));
                let y = b.y.clamp(0, (lh - h).max(0));
                let _ = win.set_position(tauri::LogicalPosition::new(x, y));
                let _ = win.set_size(tauri::LogicalSize::new(w as u32, h as u32));
                debug!("Window bounds restored: {}x{} at ({},{})", w, h, x, y);
            }
        }
    }
}

pub fn setup_window(app: &AppHandle) {
    // Show the version in the window title (e.g. "DiskRaptor 1.0.27").
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&format!("DiskRaptor {}", env!("CARGO_PKG_VERSION")));
    }

    // Restore saved window bounds
    restore_window_bounds(app);

    // Native menu on Windows
    #[cfg(target_os = "windows")]
    {
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(menu) = menu::build_native_menu(app) {
                let _ = win.set_menu(menu);
            }
        }
    }
}