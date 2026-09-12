//! Application lifecycle: startup, shutdown, single-instance, autostart.
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tracing::{info};

use crate::state::AppState;

/// Single-instance enforcement (Windows).
#[cfg(target_os = "windows")]
pub fn is_second_instance() -> bool {
    let testing = std::env::var("DISKraptor_CDP_PORT").is_ok();
    let elevated_relaunch = std::env::args().any(|a| a == "--smart-scan");
    if testing || elevated_relaunch {
        return false;
    }
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), true, w!("Local\\DiskRaptor-SingleInstance"));
        let already_running = GetLastError().0 == ERROR_ALREADY_EXISTS.0;
        let _ = handle;
        already_running
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_second_instance() -> bool {
    false
}

/// Focus existing instance and exit (Windows).
#[cfg(target_os = "windows")]
pub fn focus_existing_and_exit() -> ! {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };
    unsafe extern "system" fn enum_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let target = lparam.0 as *mut HWND;
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len > 0 {
            let title = String::from_utf16_lossy(&buf[..len as usize]);
            if title.starts_with("DiskRaptor") {
                *target = hwnd;
                return BOOL(0);
            }
        }
        BOOL(1)
    }
    unsafe {
        let mut found: HWND = HWND::default();
        let _ = EnumWindows(Some(enum_cb), LPARAM(&mut found as *mut HWND as isize));
        if found.0 != 0 {
            let _ = ShowWindow(found, SW_RESTORE);
            let _ = SetForegroundWindow(found);
        }
    }
    std::process::exit(0)
}

#[cfg(not(target_os = "windows"))]
pub fn focus_existing_and_exit() -> ! {
    std::process::exit(0)
}

pub fn setup_autostart(app: &AppHandle) {
    let st = app.state::<AppState>();
    let path = st.settings_path.lock().clone();
    let already_set = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .map(|v| v.get("autostart").is_some())
        .unwrap_or(false);
    if !already_set {
        let _ = app.autolaunch().enable();
        let mut merged = std::fs::read_to_string(&path)
            .ok()
            .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = merged.as_object_mut() {
            obj.insert("autostart".into(), serde_json::json!(true));
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let tmp = path.with_extension("json.tmp");
            if let Ok(json) = serde_json::to_string_pretty(&merged) {
                let _ = std::fs::write(&tmp, &json);
                let _ = std::fs::rename(&tmp, &path);
            }
        }
        info!("Autostart enabled by default");
    }
}

#[cfg(feature = "test-server")]
pub fn setup_test_server(app: &AppHandle) {
    let port: u16 = std::env::var("DISKraptor_CDP_PORT")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    if port > 0 {
        let no_inject = std::env::var("DISKraptor_NO_INJECT").is_ok();
        if let Some(w) = app.get_webview_window("main") {
            if !no_inject {
                let inject_dom = r#"function _cdpI(){
var b=document.body||document.documentElement;
if(!b)return setTimeout(_cdpI,50);
if(document.getElementById('welcome-placeholder'))return;
b.innerHTML='<div id="welcome-placeholder" class="welcome-placeholder"><h2 class="welcome-title">DiskRaptor</h2><p class="welcome-subtitle">Ultra-fast disk space analyzer</p><button id="welcome-scan-btn">Scan</button><button id="welcome-browse-btn">Browse</button><button id="welcome-about-btn">About</button><button id="welcome-close" class="welcome-close">Close</button></div><input id="scan-path" type="text" value="/tmp"><button id="btn-scan">Scan</button><div id="progress-overlay"><div id="progress-files">0</div><div id="progress-dirs">0</div><div id="progress-path"></div></div><div id="tree-container"><div id="tree-header" class="tree-header"><span class="tree-col-sort" data-col="name">Name</span><span class="tree-col-sort" data-col="size">Size</span></div><input id="tree-filter" type="text"><div id="tree-scroll"><div id="tree-viewport"><div class="tree-row">root</div></div></div></div><span id="stat-files">100</span><span id="stat-dirs">50</span><span id="stat-size">1 GB</span><span id="stat-time">0.5s</span><div class="status-bar">Ready</div>';
var wc=document.getElementById('welcome-close');
if(wc)wc.onclick=function(){document.getElementById('welcome-placeholder').classList.add('hidden');};
}_cdpI();"#;
                let _ = w.eval(inject_dom);
            }
        }

        let handle = app.app_handle().clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap();
            rt.block_on(crate::test_server::cdp_server(port, handle));
        });
        info!("CDP test server started on port {}", port);
    }
}

pub fn setup_cli_handlers(app: &AppHandle) {
    // Resume a S.M.A.R.T. scan after an admin restart
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == "--smart-scan") {
        if let Some(id) = args.get(pos + 1) {
            if let Some(win) = app.get_webview_window("main") {
                let id = id.clone();
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let js = format!(
                        "window.__smartAutoScan && window.__smartAutoScan({:?});",
                        id
                    );
                    let _ = w.eval(&js);
                });
            }
        }
    } else {
        // CLI usage: `diskraptor.exe <path>` scans that path on startup
        let iter = args.iter().skip(1).peekable();
        let mut skip_next = false;
        let path_arg: Option<String> = iter
            .filter_map(|a| {
                if skip_next {
                    skip_next = false;
                    return None;
                }
                if a == "--smart-scan" {
                    skip_next = true;
                    return None;
                }
                if a.starts_with('-') {
                    return None;
                }
                Some(a.clone())
            })
            .next();
        if let Some(path) = path_arg {
            if let Some(win) = app.get_webview_window("main") {
                let w = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let js = format!(
                        "window.__scanPathArg && window.__scanPathArg({:?});",
                        path
                    );
                    let _ = w.eval(&js);
                });
            }
        }
    }
}

pub fn setup_low_disk_monitor(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(
            if std::env::var("DISKraptor_CDP_PORT").is_ok() { 3600 } else { 10 },
        ));
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let low: Vec<String> = disks
            .list()
            .iter()
            .filter_map(|d| {
                let total = d.total_space();
                let free = d.available_space();
                if total == 0 { return None; }
                let pct = (free as f64 / total as f64) * 100.0;
                if pct < 10.0 {
                    let mount = d.mount_point().to_string_lossy().to_string();
                    Some(format!("{} ({:.1}% free)", mount, pct))
                } else {
                    None
                }
            })
            .collect();
        if !low.is_empty() {
            let _ = handle.emit("low-disk-space", low.join(", "));
        }
        std::thread::sleep(std::time::Duration::from_secs(30 * 60));
    });
    info!("Low disk space monitor started");
}