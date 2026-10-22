//! Window management: bounds persistence, restore, setup.
use tauri::{AppHandle, Manager, Window};
use tracing::debug;

use crate::state::AppState;
#[cfg(target_os = "windows")]
use crate::menu;

const MIN_WINDOW_W: u32 = 900;
const MIN_WINDOW_H: u32 = 500;

/// Persist the window size/position into settings.json so the next launch
/// restores it. Best-effort; failures are ignored.
pub fn save_window_bounds(window: &Window) {
    let st = match window.app_handle().try_state::<AppState>() {
        Some(s) => s,
        None => return,
    };
    let Ok(size) = window.outer_size() else { return };
    let Ok(pos) = window.outer_position() else { return };
    let maximized = window.is_maximized().unwrap_or(false);
    let path = st.settings_path.lock().clone();
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = merged.as_object_mut() {
        obj.insert(
            "window_bounds".into(),
            serde_json::json!({
                "x": pos.x,
                "y": pos.y,
                "w": size.width,
                "h": size.height,
                "maximized": maximized,
            }),
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
    #[derive(Deserialize, Clone, Copy)]
    struct Bounds {
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        /// Missing in settings written by older versions. In that case a
        /// saved size that fills the whole work area means the window was
        /// maximized.
        #[serde(default)]
        maximized: Option<bool>,
    }

    let st = app.state::<AppState>();
    let path = st.settings_path.lock().clone();
    let b: Option<Bounds> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| v.get("window_bounds").cloned())
        .and_then(|v| serde_json::from_value(v).ok());
    let Some(b) = b else { return };
    if b.w < MIN_WINDOW_W || b.h < MIN_WINDOW_H {
        return;
    }
    let Some(win) = app.get_webview_window("main") else { return };

    // Pick the monitor that contained the saved window. This keeps a window
    // on a second monitor instead of always dragging it to the primary one.
    let saved_cx = b.x as i64 + b.w as i64 / 2;
    let saved_cy = b.y as i64 + b.h as i64 / 2;
    let monitor = win
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|m| {
                let p = m.position();
                let s = m.size();
                saved_cx >= p.x as i64
                    && saved_cx < p.x as i64 + s.width as i64
                    && saved_cy >= p.y as i64
                    && saved_cy < p.y as i64 + s.height as i64
            })
        })
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };

    // Work area is in physical pixels and already excludes the taskbar. Use
    // it instead of the full monitor so the bottom of the window can never
    // disappear behind the taskbar.
    let work = monitor.work_area();
    let was_maximized = b
        .maximized
        .unwrap_or(b.w >= work.size.width && b.h >= work.size.height);
    if was_maximized {
        if !win.is_maximized().unwrap_or(false) {
            let _ = win.maximize();
        }
        debug!("Window restored maximized");
        return;
    }

    // set_size() sets the client size, while the saved bounds are outer
    // sizes. Subtract the current frame so the restored outer window fits
    // inside the work area.
    let frame = match (win.outer_size(), win.inner_size()) {
        (Ok(outer), Ok(inner)) => (
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        _ => (0, 0),
    };
    let (x, y, w, h) = clamp_to_work_area(
        (b.x, b.y, b.w, b.h),
        work.position.x,
        work.position.y,
        work.size.width,
        work.size.height,
        frame.0,
        frame.1,
    );
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    debug!(
        "Window bounds restored: {}x{} at ({},{}), work area {}x{} at ({},{})",
        w,
        h,
        x,
        y,
        work.size.width,
        work.size.height,
        work.position.x,
        work.position.y
    );
}

/// Clamp saved outer bounds to the monitor's work area. Returns the outer
/// position and client size to pass to `set_position`/`set_size`.
fn clamp_to_work_area(
    saved: (i32, i32, u32, u32),
    work_x: i32,
    work_y: i32,
    work_w: u32,
    work_h: u32,
    frame_w: u32,
    frame_h: u32,
) -> (i32, i32, u32, u32) {
    let (saved_x, saved_y, saved_w, saved_h) = saved;

    // Always leave room for the minimum configured window size, even on a
    // very small or unusual monitor.
    let max_w = work_w.saturating_sub(frame_w).max(MIN_WINDOW_W);
    let max_h = work_h.saturating_sub(frame_h).max(MIN_WINDOW_H);
    let w = saved_w
        .saturating_sub(frame_w)
        .clamp(MIN_WINDOW_W, max_w);
    let h = saved_h
        .saturating_sub(frame_h)
        .clamp(MIN_WINDOW_H, max_h);

    let max_x = work_x + work_w.saturating_sub(w.saturating_add(frame_w)) as i32;
    let max_y = work_y + work_h.saturating_sub(h.saturating_add(frame_h)) as i32;
    let x = saved_x.clamp(work_x, max_x.max(work_x));
    let y = saved_y.clamp(work_y, max_y.max(work_y));
    (x, y, w, h)
}

pub fn setup_window(app: &AppHandle) {
    // Show the version in the window title (e.g. "DiskRaptor 1.0.27").
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_title(&format!("DiskRaptor {}", env!("CARGO_PKG_VERSION")));
        #[cfg(target_os = "linux")]
        let _ = win.with_webview(|webview| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(settings) = webview.inner().settings() {
                // Avoid delayed touchpad movement in the directory tree.
                settings.set_enable_smooth_scrolling(false);
            }
        });
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

/// Bring the main window back on screen (used by the Window menu, the
/// tray icon and the macOS Dock click). Required for Mac App Store
/// Guideline 4 (Design): closing the main window hides it, so there must
/// always be a discoverable way to reopen it.
pub fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_stale_large_bounds_to_work_area() {
        // e.g. settings saved on a larger monitor: 1938x1152 physical. The
        // current work area is 1920x1020 and the window frame is 16x40.
        assert_eq!(
            clamp_to_work_area((0, 0, 1938, 1152), 0, 0, 1920, 1020, 16, 40),
            (0, 0, 1904, 980)
        );
    }

    #[test]
    fn clamps_window_position_inside_work_area() {
        assert_eq!(
            clamp_to_work_area((5000, 5000, 1000, 700), 0, 0, 1920, 1020, 16, 40),
            (920, 320, 984, 660)
        );
    }

    #[test]
    fn respects_minimum_window_size() {
        assert_eq!(
            clamp_to_work_area((0, 0, 100, 100), 0, 0, 1920, 1020, 16, 40),
            (0, 0, MIN_WINDOW_W, MIN_WINDOW_H)
        );
    }

    #[test]
    fn clamps_to_offset_work_area() {
        // Secondary monitor to the right of the primary one.
        assert_eq!(
            clamp_to_work_area((0, -500, 1200, 800), 1920, 0, 1920, 1020, 16, 40),
            (1920, 0, 1184, 760)
        );
    }
}
