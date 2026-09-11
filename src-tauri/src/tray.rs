//! System tray management.
use tauri::{Manager, AppHandle};
use tauri::tray::TrayIconBuilder;
use tracing::info;

use crate::{state::AppState, menu};

pub struct Tray {
    _tray: tauri::tray::TrayIcon,
}

pub fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let menu = menu::build_tray_menu(app)?;
    let mut tray_builder = TrayIconBuilder::new();
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    }
    tray_builder = tray_builder.tooltip(format!(
        "DiskRaptor {}",
        env!("CARGO_PKG_VERSION")
    ));
    let tray = tray_builder
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
            "tray_lastscan" => {
                let st = app.state::<AppState>();
                let path = st.last_scan_path.lock().clone();
                if let Some(p) = path {
                    open_in_explorer(&p);
                } else if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "tray_exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    app.manage(Tray { _tray: tray });
    info!("System tray initialized");
    Ok(())
}

/// Open a path in the platform file manager/Explorer (best-effort).
fn open_in_explorer(path: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .args(["/select,", path])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").args(["-R", path]).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
}