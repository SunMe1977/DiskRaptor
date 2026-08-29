#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_scanner::scanner;

mod apfs;
mod browser;
mod cmds;
mod menu;
mod menu_i18n;
mod smart;
#[cfg(feature = "test-server")]
mod test_server;
mod trash;

// Re-export the command domains so the crate-root API (integration tests,
// sibling modules smart/trash/browser) stays source compatible after splitting
// main.rs into cmds/. Several names are only referenced from #[cfg(test)] or
// platform-gated sibling modules, hence the allow.
#[allow(unused_imports)]
pub(crate) use cmds::{
    cancel_dup_scan, cancel_scan, check_admin_needed, check_for_updates, classify_download,
    delete_path, delete_permanent, exit_app, find_duplicates, get_app_data_dir, get_app_info,
    get_app_version, get_children, get_chunk, get_dir_stats, get_dup_result, get_dup_stats,
    get_home_dir, get_icon, get_memory_info, get_process_memory, get_scan_progress,
    get_scan_result, get_stats, get_trash_path, get_volume_stats, in_mac_sandbox, is_sandboxed,
    list_downloads_candidates, list_drives, list_volumes_via_sysinfo, load_settings, open_explorer,
    open_properties, open_terminal, open_url, parse_system_profiler_disks, pick_directory,
    release_scan, request_permissions, restart_as_admin, sanitize_delete_path, save_settings,
    start_scan, validate_system_path,
};
#[cfg(not(target_os = "windows"))]
pub(crate) use cmds::run_output;
#[cfg(target_os = "windows")]
pub(crate) use cmds::native_browser_icon;

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;
use tauri::Manager;
use tauri::Emitter;
use tauri::tray::TrayIconBuilder;
use tauri_plugin_autostart::MacosLauncher;
use serde::Serialize;

/// Keeps the system-tray icon alive for the app's lifetime.
struct Tray {
    _tray: tauri::tray::TrayIcon,
}

// -- Scanner state ----------------------------------------------------------

#[allow(dead_code)]
struct ScanState {
    result: Mutex<Option<ScanResultData>>,
    files_found: AtomicU64,
    dirs_found: AtomicU64,
    bytes_found: AtomicU64,
    current_dir: Mutex<String>,
    start_time: Mutex<Instant>,
    running: AtomicBool,
    cancelled: AtomicBool,
    cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
    errors: Mutex<Vec<String>>,
    /// The scan id currently active (or last started). Responses/events are
    /// only valid while they match this id.
    active_scan_id: AtomicU64,
    live_entries: Mutex<Option<LiveEntries>>,
    /// Serialized `get_scan_result` payload cached once per scan (keyed by scan
    /// id) so repeated IPC calls don't rebuild the whole JSON every time.
    cached_result: Mutex<Option<(u64, serde_json::Value)>>,
}

type LiveEntries = std::sync::Arc<parking_lot::Mutex<std::collections::VecDeque<String>>>;

#[allow(dead_code)]
struct ScanResultData {
    arena: scanner::tree::TreeNodeArena,
    stats: scanner::tree::ScanStats,
    scan_time_ms: u64,
    errors: Vec<String>,
    termination: scanner::walker::ScanTermination,
}

// -- Duplicate scanner state ------------------------------------------------

struct DupState {
    running: AtomicBool,
    cancelled: AtomicBool,
    phase: AtomicU64,
    files_scanned: AtomicU64,
    current_file: Mutex<String>,
    groups: Mutex<Vec<serde_json::Value>>,
    wasted_bytes: Mutex<u64>,
}

impl Default for DupState {
    fn default() -> Self {
        Self {
            running: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            phase: AtomicU64::new(0),
            files_scanned: AtomicU64::new(0),
            current_file: Mutex::new(String::new()),
            groups: Mutex::new(Vec::new()),
            wasted_bytes: Mutex::new(0),
        }
    }
}

// -- App managed state ------------------------------------------------------

pub(crate) struct AppState {
    scan: ScanState,
    dup: DupState,
    settings_path: Mutex<std::path::PathBuf>,
    /// Monotonic scan id counter so `start_scan` can hand back a real `scan_id`.
    scan_counter: AtomicU64,
    #[allow(dead_code)] // used on Linux for pkexec caching
    pub(crate) smart_cache: Mutex<std::collections::HashMap<String, (std::time::Instant, JsonResult)>>,
    /// Last scanned path (used by the tray "Open last scan" item).
    pub(crate) last_scan_path: Mutex<Option<String>>,
    /// Resolved UI locale code ("en", "de", â€¦) used to localize native menus.
    pub(crate) locale: Mutex<String>,
    /// Translated labels for native (tray / window) menus, sent from the webview.
    pub(crate) menu_strings: Mutex<std::collections::HashMap<String, String>>,
}

// -- Helper types -----------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[must_use]
pub(crate) struct JsonResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl JsonResult {
    fn ok(data: serde_json::Value) -> Self {
        Self { success: true, data: Some(data), error: None }
    }
    fn ok_empty() -> Self {
        Self { success: true, data: None, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
}

// -- Single instance ---------------------------------------------------------
// DiskRaptor is a tray app: only one instance should run. A second launch
// focuses the already-running window and exits.
//
// Bypassed in two deliberate cases:
//   * DISKraptor_CDP_PORT is set  -> the UI test harness runs several
//     instances in parallel (one per test) and each needs its own CDP port.
//   * --smart-scan is present     -> the elevated S.M.A.R.T. relaunch starts a
//     new process on purpose (restart_as_admin exits the current instance).
#[cfg(target_os = "windows")]
fn is_second_instance() -> bool {
    let testing = std::env::var("DISKraptor_CDP_PORT").is_ok();
    let elevated_relaunch = std::env::args().any(|a| a == "--smart-scan");
    if testing || elevated_relaunch {
        return false;
    }
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    unsafe {
        // bInitialOwner = true so a *new* mutex is owned by this process and
        // stays acquired until exit (we never release it). A second instance
        // finds ERROR_ALREADY_EXISTS and is the one that must quit.
        let handle = CreateMutexW(std::ptr::null(), true, w!("Local\\DiskRaptor-SingleInstance"));
        let already_running = GetLastError().0 == ERROR_ALREADY_EXISTS.0;
        // Keep the acquired handle for the process lifetime (never CloseHandle),
        // so the named mutex stays held until this instance exits.
        let _ = handle;
        already_running
    }
}

#[cfg(not(target_os = "windows"))]
fn is_second_instance() -> bool {
    false
}

#[cfg(target_os = "windows")]
fn focus_existing_and_exit() -> ! {
    // The window title includes the version ("DiskRaptor 1.0.x"), so enumerate
    // top-level windows and match the title prefix instead of an exact name.
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
                return BOOL(0); // stop enumerating
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
fn focus_existing_and_exit() -> ! {
    std::process::exit(0)
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

/// Persist the window size/position into settings.json so the next launch
/// restores it. Best-effort; failures are ignored.
fn save_window_bounds(window: &tauri::Window) {
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
fn restore_window_bounds(app: &tauri::App) {
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
            }
        }
    }
}

// -- Native menu localization ----------------------------------------------

/// Report the operating system's UI locale (e.g. "de-DE"). The frontend uses
/// this as the authoritative source for the "auto" language setting, since
/// WebView2's `navigator.language` does not always follow the OS language.
#[tauri::command]
fn get_system_locale() -> String {
    sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string())
}

/// Store the active UI locale + translated menu labels (pushed by the webview
/// once it resolves the language) and rebuild the native window + tray menus.
#[tauri::command]
fn set_locale(
    app: tauri::AppHandle,
    locale: String,
    strings: std::collections::HashMap<String, String>,
    raw: String,
) {
    // The webview's first resolution on "auto" is often English (WebView2's
    // navigator.language), before it syncs with the OS locale. Ignore that
    // auto-detected English push so it doesn't overwrite the correctly
    // localized native menu (which follows the OS locale). An explicit manual
    // English choice (raw == "en") is still respected.
    let os_base = sys_locale::get_locale()
        .map(|l| l.split('-').next().unwrap_or("en").to_lowercase())
        .unwrap_or_else(|| "en".to_string());
    let push_base = locale.split('-').next().unwrap_or("en").to_lowercase();
    if raw.trim().eq_ignore_ascii_case("auto") && push_base == "en" && os_base != "en" {
        return;
    }
    {
        let st = app.state::<AppState>();
        *st.locale.lock() = locale;
        *st.menu_strings.lock() = strings;
    }
    // Rebuild the native window menu (Windows menu bar / macOS app menu).
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(m) = menu::build_native_menu(&app) {
            let _ = win.set_menu(m);
        }
    }
    // Rebuild the system-tray context menu.
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(m) = menu::build_tray_menu(&app) {
            let _ = tray.set_menu(Some(m));
        }
    }
}

// -- Main -------------------------------------------------------------------

fn main() {
    if is_second_instance() {
        focus_existing_and_exit();
    }

    let settings_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor").join("settings.json");
    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .on_window_event(|window, event| {
            // Keep DiskRaptor in the system tray: closing the window hides it
            // instead of quitting (exit via tray/menu still terminates).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                save_window_bounds(window);
                let _ = window.hide();
            }
        })
        .manage(AppState {
            scan: ScanState {
                result: Mutex::new(None),
                files_found: AtomicU64::new(0),
                dirs_found: AtomicU64::new(0),
                bytes_found: AtomicU64::new(0),
                current_dir: Mutex::new(String::new()),
                start_time: Mutex::new(Instant::now()),
                running: AtomicBool::new(false),
                cancelled: AtomicBool::new(false),
                cancel_flag: Mutex::new(None),
                errors: Mutex::new(Vec::new()),
                live_entries: Mutex::new(None),
                cached_result: Mutex::new(None),
                active_scan_id: AtomicU64::new(0),
            },
            dup: DupState::default(),
            settings_path: Mutex::new(settings_path),
            scan_counter: AtomicU64::new(0),
            smart_cache: Mutex::new(std::collections::HashMap::new()),
            last_scan_path: Mutex::new(None),
            locale: Mutex::new("en".to_string()),
            menu_strings: Mutex::new(std::collections::HashMap::new()),
        })
        .setup(|app| {
            // -- System tray (Open / Exit) --------------------------
            {
                let menu = menu::build_tray_menu(app.handle())?;
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
            }

            // -- Autostart: enabled by default on the first run ------
            {
                use tauri_plugin_autostart::ManagerExt;
                let st = app.state::<AppState>();
                let path = st.settings_path.lock().clone();
                let already_set = std::fs::read_to_string(&path)
                    .ok()
                    .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
                    .map(|v| v.get("autostart").is_some())
                    .unwrap_or(false);
                if !already_set {
                    let _ = app.autolaunch().enable();
                    // Persist the default so a later manual disable sticks.
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
                }
            }

            #[cfg(feature = "test-server")]
            {
                let port: u16 = std::env::var("DISKraptor_CDP_PORT")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                if port > 0 {
                    // Inject test DOM structure into main window for tests.
                    // Only active when DISKraptor_CDP_PORT is explicitly set.
                    // DISKraptor_NO_INJECT keeps the real frontend (used by tests
                    // that exercise the actual UI, e.g. the S.M.A.R.T. tools).
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

                    let handle = app.handle().clone();
                    std::thread::spawn(move || {
                        let rt = tokio::runtime::Runtime::new().unwrap();
                        rt.block_on(test_server::cdp_server(port, handle));
                    });
                }
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = app.get_webview_window("main") {
                    if let Ok(menu) = menu::build_native_menu(app.handle()) {
                        let _ = win.set_menu(menu);
                    }
                }
            }

            // Restore the saved window size/position (best-effort).
            restore_window_bounds(app);

            // Show the version in the window title (e.g. "DiskRaptor 1.0.26").
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(&format!("DiskRaptor {}", env!("CARGO_PKG_VERSION")));
            }

            // Low-disk-space warning: check shortly after startup, then every
            // 30 minutes, and notify the UI when a drive is below 10% free.
            {
                let handle = app.handle().clone();
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
            }

            // -- Resume a S.M.A.R.T. scan after an admin restart -------------
            // The elevated relaunch passes `--smart-scan <device>`; once the
            // webview is up, tell the UI to re-open the S.M.A.R.T. tool and
            // auto-scan that drive.
            {
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
                }
                // CLI usage: `diskraptor.exe <path>` scans that path on startup.
                // Skips flags and the value of --smart-scan.
                else {
                    let iter = args.iter().skip(1).peekable();
                    let mut skip_next = false;
                    let path_arg: Option<String> = iter
                        .filter_map(|a| {                            if skip_next {
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
            Ok(())
        })
        .menu(menu::build_native_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            cmds::path_ops::delete_path, cmds::path_ops::delete_permanent,
            cmds::path_ops::open_explorer, cmds::path_ops::open_terminal, cmds::path_ops::open_properties, cmds::path_ops::get_icon,
            cmds::system::get_home_dir, cmds::system::pick_directory, cmds::system::get_trash_path, cmds::system::list_drives, cmds::system::get_volume_stats, cmds::system::get_dir_stats,
            cmds::system::list_downloads_candidates,
            cmds::system::get_memory_info, cmds::system::get_process_memory, cmds::system::get_app_version, cmds::system::get_app_data_dir, cmds::system::get_app_info,
            trash::empty_trash, trash::list_trash, trash::restore_trash,
            cmds::system::request_permissions, cmds::system::check_admin_needed, cmds::system::restart_as_admin, cmds::system::is_sandboxed,
            cmds::system::check_for_updates, cmds::path_ops::open_url,
            cmds::scan::start_scan, cmds::scan::get_scan_progress, cmds::scan::get_scan_result,
            cmds::scan::get_chunk, cmds::scan::get_children, cmds::scan::cancel_scan, cmds::scan::release_scan, cmds::scan::get_stats,
            cmds::dups::find_duplicates, cmds::dups::get_dup_stats, cmds::dups::get_dup_result, cmds::dups::cancel_dup_scan,
            cmds::settings::save_settings, cmds::settings::load_settings,
            cmds::system::list_disks, cmds::path_ops::exit_app,
            smart::get_smart_status,
            browser::list_browser_data, browser::clean_browser, browser::get_browser_icon,
            apfs::list_apfs_volumes, apfs::delete_local_snapshot,
            cmds::autostart::set_autostart, cmds::autostart::get_autostart,
            set_locale, get_system_locale,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[cfg(test)]
mod tests {
    use super::*;
    use diskraptor_scanner::scanner::tree::format_size;

    #[test]
    fn parse_system_profiler_handles_empty_input() {
        assert!(parse_system_profiler_disks("").is_empty());
        assert!(parse_system_profiler_disks("not json {").is_empty());
    }

    #[test]
    fn parse_system_profiler_detects_drives() {
        let s = r#"{
          "SPStorageDataType": [
            { "_name": "Apple",
              "bsd_name": "disk1",
              "size_in_bytes": 500277790720,
              "physical_drive": {
                "device_name": "APPLE SSD SM0512",
                "is_internal_disk": "yes",
                "medium_type": "ssd"
              } },
            { "_name": "Backup",
              "bsd_name": "disk2s1",
              "size_in_bytes": 999000000,
              "physical_drive": {
                "device_name": "WD Elements 4TB",
                "is_internal_disk": "no",
                "medium_type": "hdd"
              } },
            { "_name": "Cryptex",
              "bsd_name": "disk4s1",
              "size_in_bytes": 4194304,
              "physical_drive": {
                "device_name": "Disk Image",
                "is_internal_disk": "no",
                "medium_type": "ssd"
              } }
          ]
        }"#;
        let disks = parse_system_profiler_disks(s);
        assert_eq!(disks.len(), 3, "all three distinct physical drives listed");
        assert_eq!(disks[0]["name"], "APPLE SSD SM0512");
        assert_eq!(disks[0]["id"], "disk1");
        assert_eq!(disks[0]["media_type"], 4, "ssd -> media_type 4");
        assert_eq!(disks[0]["is_internal"], true);
        assert_eq!(disks[1]["name"], "WD Elements 4TB");
        assert_eq!(disks[1]["media_type"], 3, "hdd -> media_type 3");
        assert_eq!(disks[1]["is_internal"], false);
    }

    #[test]
    fn parse_system_profiler_dedupes_shared_physical_drive() {
        let s = r#"{
          "SPStorageDataType": [
            { "_name": "Untitled",
              "bsd_name": "disk1s1",
              "physical_drive": { "device_name": "VMware Virtual SATA Hard Drive", "medium_type": "ssd" } },
            { "_name": "Untitled - Data",
              "bsd_name": "disk1s2",
              "physical_drive": { "device_name": "VMware Virtual SATA Hard Drive", "medium_type": "ssd" } }
          ]
        }"#;
        let disks = parse_system_profiler_disks(s);
        assert_eq!(disks.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn browser_defs_include_safari() {
        assert!(browser_defs().iter().any(|d| d.name == "Safari"));
    }

    #[test]
    fn drive_fields_match_frontend_contract() {
        // The frontend (drives.js / welcome page) reads these exact keys.
        // Guard against silently breaking the drive selector UI.
        let result = list_drives();
        let ok = result.success;
        assert!(ok);
        if let Some(data) = result.data {
            let arr = data.as_array().cloned().unwrap_or_default();
            if !arr.is_empty() {
                let d = &arr[0];
                assert!(d.get("path").is_some(), "drive missing path");
                assert!(d.get("name").is_some(), "drive missing name");
                assert!(d.get("total_bytes").is_some(), "drive missing total_bytes");
                assert!(d.get("free_bytes").is_some(), "drive missing free_bytes");
                assert!(d.get("used_bytes").is_some(), "drive missing used_bytes");
                assert!(d.get("usage_pct").is_some(), "drive missing usage_pct");
                assert!(d.get("percentFull").is_some(), "drive missing percentFull");
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn safari_paths_fall_back_to_container() {
        for def in browser_defs() {
            if def.name != "Safari" { continue; }
            if let Some((_base, cookies, cache)) = browser_paths(&def) {
                assert!(cookies.len() >= 1);
                assert!(cache.len() >= 1);
                return;
            }
            panic!("browser_paths returned None for Safari");
        }
        panic!("Safari not in browser_defs");
    }

    #[test]
    fn format_size_known_values() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1048576), "1.00 MB");
        assert_eq!(format_size(1073741824), "1.00 GB");
    }

    #[test]
    fn classify_download_detects_temp_files() {
        assert_eq!(classify_download("file.part", 100, 1), (true, false, false));
        assert_eq!(classify_download("setup.crdownload", 100, 1), (true, false, false));
        assert_eq!(classify_download("data.tmp", 100, 1), (true, false, false));
        assert_eq!(classify_download("image.download", 100, 1), (true, false, false));
    }

    #[test]
    fn classify_download_detects_old_and_large() {
        assert_eq!(classify_download("archive.zip", 200 * 1024 * 1024, 1), (false, false, true));
        assert_eq!(classify_download("old_file.pdf", 1000, 120), (false, true, false));
        assert_eq!(classify_download("normal.txt", 5000, 5), (false, false, false));
    }

    #[test]
    fn classify_download_is_case_insensitive() {
        assert_eq!(classify_download("BIG.MOVIE.PART", 100, 1), (true, false, false));
    }

    #[test]
    fn get_app_info_returns_expected_fields() {
        let result = get_app_info();
        assert!(result.success);
        if let Some(data) = result.data {
            assert!(data.get("version").is_some());
            assert!(data.get("os").is_some());
            assert!(data.get("arch").is_some());
            assert!(data.get("data_dir").is_some());
            assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
        }
    }

    #[test]
    fn open_url_rejects_dangerous_schemes() {
        assert!(open_url("file:///etc/passwd".to_string()).error.is_some());
        assert!(open_url("javascript:alert(1)".to_string()).error.is_some());
        assert!(open_url("data:text/html,x".to_string()).error.is_some());
        assert!(open_url("https://example.com".to_string()).success);
        assert!(open_url("mailto:test@example.com".to_string()).success);
    }

    #[test]
    fn chunk_start_index_matches_arena_offset() {
        // chunk_tree assigns start_index = chunk_id * CHUNK_SIZE; the UI uses
        // this to place nodes instead of assuming a fixed chunk size.
        use diskraptor_scanner::scanner::tree::{NodeType, TreeNode, TreeNodeArena};
        use diskraptor_scanner::streaming::chunker::chunk_tree;
        let mut arena = TreeNodeArena::with_capacity(25_000);
        for i in 0..25_000u32 {
            let mut n = TreeNode {
                name: format!("n{i}"),
                size: i as u64,
                file_count: 1,
                dir_count: 0,
                node_type: NodeType::File,
                parent: 0,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth: 1,
                chunk_id: 0,
                mtime: 0,
            };
            if i == 0 {
                n.parent = u32::MAX;
                n.node_type = NodeType::Directory;
                n.dir_count = 1;
                n.file_count = 0;
            }
            arena.nodes.push(n);
        }
        let chunks = chunk_tree(&arena).unwrap();
        assert_eq!(chunks.len(), 3, "25000 nodes -> 3 chunks of 10000");
        assert_eq!(chunks[0].start_index, 0);
        assert_eq!(chunks[1].start_index, 10_000);
        assert_eq!(chunks[2].start_index, 20_000);
        assert_eq!(chunks[0].nodes.len(), 10_000);
        assert_eq!(chunks[2].nodes.len(), 5_000);
    }

    #[test]
    fn borrowed_chunk_json_matches_tree_chunk() {
        // The clone-free BorrowedChunk must serialize byte-identically to the
        // owned TreeChunk (including the per-node chunk_id patch), so the UI
        // contract never changes.
        use diskraptor_scanner::scanner::tree::{
            BorrowedChunk, NodeType, TreeNode, TreeNodeArena, TreeChunk,
        };
        let mut arena = TreeNodeArena::with_capacity(8);
        let root = arena.alloc(TreeNode {
            name: "root".into(), size: 3, file_count: 2, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0,
            chunk_id: 0, mtime: 0,
        });
        for (i, (n, s, mt)) in [("a.txt", 1u64, 11u64), ("b.bin", 2, 22)].iter().enumerate() {
            arena.alloc(TreeNode {
                name: n.to_string(), size: *s, file_count: 1, dir_count: 0,
                node_type: NodeType::File, parent: root,
                first_child: u32::MAX, next_sibling: u32::MAX, depth: 1,
                chunk_id: 0, mtime: *mt,
            });
            let _ = i;
        }
        let borrowed = BorrowedChunk::new(7, 1, 3, 0, &arena.nodes);
        let mut owned_nodes = arena.nodes.clone();
        for n in owned_nodes.iter_mut() {
            n.chunk_id = 7;
        }
        let owned = TreeChunk {
            chunk_id: 7, total_chunks: 1, total_nodes: 3, start_index: 0,
            nodes: owned_nodes,
        };
        let a = serde_json::to_value(&borrowed).unwrap();
        let b = serde_json::to_value(&owned).unwrap();
        assert_eq!(a, b, "BorrowedChunk serialization diverged from TreeChunk");
        let ca = serde_json::to_string(&borrowed).unwrap();
        let cb = serde_json::to_string(&owned).unwrap();
        assert_eq!(ca, cb);
    }
}
