//! System tray management.
use tauri::{Manager, AppHandle};
use tauri::tray::TrayIconBuilder;
use tracing::info;

use crate::{state::AppState, menu};

pub struct Tray {
    _tray: tauri::tray::TrayIcon,
}

pub fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // Load settings to check if tray should be disabled
    let st = app.state::<AppState>();
    let path = st.settings_path.lock().clone();
    let disable_tray = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .and_then(|v| v.get("disable_tray").and_then(|v| v.as_bool()))
        .unwrap_or(false);

    let menu = menu::build_tray_menu(app)?;
    let mut tray_builder = TrayIconBuilder::with_id("main");
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
                crate::window::show_main_window(app);
            }
            "tray_lastscan" => {
                let st = app.state::<AppState>();
                let path = st.last_scan_path.lock().clone();
                if let Some(p) = path {
                    open_in_explorer(&p);
                } else {
                    crate::window::show_main_window(app);
                }
            }
            "tray_exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    if disable_tray {
        let _ = tray.set_visible(false);
    }
    app.manage(Tray { _tray: tray });
    info!("System tray initialized (visible: {})", !disable_tray);
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