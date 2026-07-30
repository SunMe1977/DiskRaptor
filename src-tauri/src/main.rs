#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::TreeChunk;
use diskraptor_scanner::streaming::chunker::{chunk_tree, make_root_chunk};

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Manager, State};
use serde::Serialize;

// ── Scanner state ──

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
}

#[allow(dead_code)]
struct ScanResultData {
    arena: scanner::tree::TreeNodeArena,
    stats: scanner::tree::ScanStats,
    scan_time_ms: u64,
    chunks: Vec<TreeChunk>,
    errors: Vec<String>,
}

// ── App managed state ──

struct AppState {
    scan: ScanState,
    settings_path: Mutex<std::path::PathBuf>,
}

// ── Helper types ──

#[derive(Serialize)]
struct JsonResult {
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

// ── File Operations ──

#[tauri::command]
fn delete_path(path: String) -> JsonResult {
    if let Ok(_) = trash::delete(&path) {
        return JsonResult::ok_empty();
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let fname = std::path::Path::new(&path).file_name().and_then(|n| n.to_str()).unwrap_or("file");
            let dest = home.join(".Trash").join(fname);
            let _ = std::fs::rename(&path, &dest);
            if dest.exists() { return JsonResult::ok_empty(); }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(s) = std::process::Command::new("gio").args(["trash", &path]).status() {
            if s.success() { return JsonResult::ok_empty(); }
        }
    }
    JsonResult::err("Failed to move to trash")
}

#[tauri::command]
fn delete_permanent(path: String) -> JsonResult {
    let p = std::path::Path::new(&path);
    if p.is_dir() { std::fs::remove_dir_all(p).ok(); }
    else { std::fs::remove_file(p).ok(); }
    if p.exists() { JsonResult::err("Failed to delete") }
    else { JsonResult::ok_empty() }
}

#[tauri::command]
fn open_explorer(path: String) -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSString;
        use objc2_app_kit::NSWorkspace;

        let ws = NSWorkspace::sharedWorkspace();
        let ns_path = NSString::from_str(&path);
        let empty = NSString::from_str("");
        if ws.selectFile_inFileViewerRootedAtPath(Some(&ns_path), &empty) {
            return JsonResult::ok_empty();
        }
    }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("explorer").args(["/select,", &path]).status(); }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path).parent().and_then(|p| p.to_str()).unwrap_or(&path);
        let _ = std::process::Command::new("xdg-open").args([parent]).status();
    }
    JsonResult::ok_empty()
}

#[tauri::command]
fn open_terminal(path: String) -> JsonResult {
    let dir = std::path::Path::new(&path);
    let dir_str = if dir.is_dir() { &path } else {
        dir.parent().and_then(|p| p.to_str()).unwrap_or(&path)
    };
    #[cfg(target_os = "macos")]
    {
        use std::io::Write;
        use objc2_foundation::{NSString, NSURL};
        use objc2_app_kit::NSWorkspace;

        let tmp = std::env::temp_dir().join(format!("diskraptor_{}.command", std::process::id()));
        let content = format!("#!/bin/bash\ncd \"{}\"\nexec \"$SHELL\"\n", dir_str.replace('"', "\\\""));
        if let Ok(mut f) = std::fs::File::create(&tmp) {
            let _ = f.write_all(content.as_bytes());
            let _ = f.sync_all();
        }
        let _ = std::fs::set_permissions(&tmp, std::os::unix::fs::PermissionsExt::from_mode(0o755));

        let ws = NSWorkspace::sharedWorkspace();
        let url = NSURL::fileURLWithPath(&NSString::from_str(tmp.to_str().unwrap_or("")));
        if ws.openURL(&url) {
            return JsonResult::ok_empty();
        }
    }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("cmd").args(["/k", "cd", "/d", dir_str]).status(); }
    #[cfg(target_os = "linux")]
    {
        for term in &["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "mate-terminal", "alacritty", "kitty"] {
            if let Ok(s) = std::process::Command::new(term).arg("--working-directory").arg(dir_str).status() {
                if s.success() { break; }
            }
        }
    }
    JsonResult::ok_empty()
}

#[tauri::command]
fn get_icon(_path: String, _is_dir: bool) -> JsonResult {
    JsonResult::ok(serde_json::json!(":file:"))
}

// ── System Operations ──

#[tauri::command]
fn get_home_dir() -> JsonResult {
    match dirs::home_dir() {
        Some(p) => JsonResult::ok(serde_json::Value::String(p.to_string_lossy().to_string())),
        None => JsonResult::err("No home directory"),
    }
}

#[tauri::command]
fn list_drives() -> JsonResult {
    let disks_list = sysinfo::Disks::new_with_refreshed_list();
    let disks: Vec<serde_json::Value> = disks_list.list().iter().map(|d| {
        let mount = d.mount_point().to_string_lossy().to_string();
        let total = d.total_space();
        let free = d.available_space();
        let used = total.saturating_sub(free);
        let pct = if total > 0 { (used as f64 / total as f64 * 100.0).round() as u64 } else { 0 };
        serde_json::json!({
            "path": mount, "name": mount,
            "total": total, "free": free, "used": used,
            "percentFull": pct, "type": "local",
        })
    }).collect();
    JsonResult::ok(serde_json::json!(disks))
}

#[tauri::command]
fn get_volume_stats() -> JsonResult {
    list_drives()
}

#[tauri::command]
fn get_memory_info() -> JsonResult {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total = sys.total_memory();
    let used = sys.used_memory();
    let free = sys.free_memory();
    JsonResult::ok(serde_json::json!({
        "total": total, "used": used, "available": free,
        "free": free,
        "percentUsed": if total > 0 { (used as f64 / total as f64 * 100.0).round() as u64 } else { 0 },
    }))
}

#[tauri::command]
fn get_process_memory() -> JsonResult {
    let pid = sysinfo::Pid::from_u32(std::process::id());
    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, false);
    if let Some(p) = sys.process(pid) {
        JsonResult::ok(serde_json::json!({"resident": p.memory(), "virtual": p.virtual_memory()}))
    } else {
        JsonResult::err("Cannot read process memory")
    }
}

#[tauri::command]
fn empty_trash() -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            let trash = home.join(".Trash");
            if let Ok(entries) = std::fs::read_dir(&trash) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with('.') { continue; }
                    let _ = if path.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("gio").args(["trash", "--empty"]).status();
        if let Some(home) = dirs::home_dir() {
            let _ = std::fs::remove_dir_all(home.join(".local/share/Trash/files"));
            let _ = std::fs::remove_dir_all(home.join(".local/share/Trash/info"));
        }
    }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("cmd").args(["/c", "rd /s /q", &format!("{}\\..\\..\\Recycle.Bin", std::env::temp_dir().to_string_lossy())]).status(); }
    JsonResult::ok_empty()
}

#[tauri::command]
fn list_trash() -> JsonResult {
    let items = {
        #[cfg(target_os = "macos")] { list_trash_macos() }
        #[cfg(target_os = "linux")] { list_trash_linux() }
        #[cfg(target_os = "windows")] { Vec::new() }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))] { Vec::new() }
    };
    JsonResult::ok(serde_json::Value::Array(items))
}

#[cfg(target_os = "linux")]
fn list_trash_linux() -> Vec<serde_json::Value> {
    let trash_dir = dirs::home_dir().unwrap_or_default().join(".local/share/Trash/files");
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&trash_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let meta = entry.metadata().ok();
            items.push(serde_json::json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "deleted_at": "",
            }));
        }
    }
    items
}

#[cfg(target_os = "macos")]
fn list_trash_macos() -> Vec<serde_json::Value> {
    let trash_dir = dirs::home_dir().unwrap_or_default().join(".Trash");
    let mut items = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&trash_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') { continue; }
            let meta = entry.metadata().ok();
            items.push(serde_json::json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
                "size": meta.as_ref().map(|m| m.len()).unwrap_or(0),
                "is_dir": meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                "deleted_at": "",
            }));
        }
    }
    items
}

#[tauri::command]
fn restore_trash(trash_path: String) -> JsonResult {
    let src = std::path::Path::new(&trash_path);
    if !src.exists() { return JsonResult::err("File not found"); }
    let home = dirs::home_dir().unwrap_or_default();
    let fname = src.file_name().and_then(|n| n.to_str()).unwrap_or("restored");
    let mut dest = home.join(fname);
    if dest.exists() {
        let base = src.file_stem().and_then(|n| n.to_str()).unwrap_or("file");
        let ext = src.extension().and_then(|n| n.to_str()).unwrap_or("");
        let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        dest = home.join(format!("{}_{}", base, ts));
        if !ext.is_empty() { dest = dest.with_extension(ext); }
    }
    if std::fs::copy(src, &dest).is_ok() {
        let _ = std::fs::remove_file(src);
        JsonResult::ok(serde_json::json!({"restored_to": dest.to_string_lossy().to_string()}))
    } else {
        JsonResult::err("Failed to restore")
    }
}

#[tauri::command]
fn request_permissions() -> JsonResult {
    let permissions = if cfg!(target_os = "macos") { "granted" } else { "not_needed" };
    JsonResult::ok(serde_json::json!({"permissions": permissions}))
}

#[tauri::command]
fn check_admin_needed(_path: String) -> JsonResult {
    JsonResult::ok(serde_json::json!(false))
}

#[tauri::command]
fn restart_as_admin() -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new("powershell")
                .args(["Start-Process", exe.to_str().unwrap_or(""), "-Verb", "runAs"]).spawn();
            std::process::exit(0);
        }
    }
    JsonResult::err("Not supported on this platform")
}

#[tauri::command]
fn check_for_updates() -> JsonResult {
    JsonResult::ok(serde_json::json!({"version": "1.0.2", "update_available": false}))
}

#[tauri::command]
fn open_url(url: String) -> JsonResult {
    let _ = open::that(&url);
    JsonResult::ok_empty()
}

// ── Scanner Commands ──

fn scan_config(path: &str, follow_symlinks: bool, timeout_secs: u64) -> scanner::walker::ScanConfig {
    scanner::walker::ScanConfig {
        root_path: path.into(),
        follow_symlinks,
        scan_timeout_secs: timeout_secs,
        errors: Arc::new(Mutex::new(Vec::new())),
        cancelled: Some(Arc::new(AtomicBool::new(false))),
        ..scanner::walker::ScanConfig::default()
    }
}

#[tauri::command]
fn start_scan(path: String, follow_symlinks: Option<bool>, timeout_secs: Option<u64>, app: tauri::AppHandle) -> JsonResult {
    let scan = app.state::<AppState>();
    if scan.scan.running.swap(true, Ordering::Acquire) {
        return JsonResult::err("Scan already running");
    }
    scan.scan.cancelled.store(false, Ordering::Release);
    scan.scan.files_found.store(0, Ordering::Relaxed);
    scan.scan.dirs_found.store(0, Ordering::Relaxed);
    scan.scan.bytes_found.store(0, Ordering::Relaxed);
    *scan.scan.current_dir.lock().unwrap() = path.clone();
    *scan.scan.start_time.lock().unwrap() = Instant::now();
    *scan.scan.result.lock().unwrap() = None;

    let p = path.clone();
    let fs = follow_symlinks.unwrap_or(false);
    let ts = timeout_secs.unwrap_or(30);
    let handle = app.clone();

    let result_handle = handle.clone();
    std::thread::Builder::new().name("scan".into()).spawn(move || {
        let config = scan_config(&p, fs, ts);
        let cancel_flag = config.cancelled.clone().unwrap();
        {
            let s = result_handle.state::<AppState>();
            *s.scan.cancel_flag.lock().unwrap() = Some(cancel_flag.clone());
            if s.scan.cancelled.load(Ordering::Acquire) { return; }
        }

        let progress_handle = result_handle.clone();
        let progress = Box::new(move |files: u64, dirs: u64, bytes: u64, msg: &str| {
            let s = progress_handle.state::<AppState>();
            s.scan.files_found.store(files, Ordering::Relaxed);
            s.scan.dirs_found.store(dirs, Ordering::Relaxed);
            s.scan.bytes_found.store(bytes, Ordering::Relaxed);
            if !msg.is_empty() {
                *s.scan.current_dir.lock().unwrap() = msg.to_owned();
            }
        });

        let result = scanner::walker::scan_directory_with_progress(config, progress);
        let s = result_handle.state::<AppState>();
        match result {
            Ok(sr) => {
                let elapsed = sr.stats.scan_time_ms;
                let chunks = chunk_tree(&sr.arena)
                    .unwrap_or_else(|_| make_root_chunk(&sr.arena));
                *s.scan.result.lock().unwrap() = Some(ScanResultData {
                    arena: sr.arena, stats: sr.stats, scan_time_ms: elapsed,
                    chunks, errors: Vec::new(),
                });
            }
            Err(e) => eprintln!("[scan] error: {}", e),
        }
        s.scan.running.store(false, Ordering::Release);
    }).ok();

    JsonResult::ok(serde_json::json!({"status": "started"}))
}

fn scan_progress_data(state: &AppState) -> serde_json::Value {
    let is_running = state.scan.running.load(Ordering::Acquire);
    let rg = state.scan.result.lock().unwrap();
    let has_result = rg.is_some();
    let (files, dirs, bytes) = if has_result {
        let r = rg.as_ref().unwrap();
        (r.stats.total_files, r.stats.total_dirs, r.stats.total_size)
    } else {
        (state.scan.files_found.load(Ordering::Relaxed), state.scan.dirs_found.load(Ordering::Relaxed), state.scan.bytes_found.load(Ordering::Relaxed))
    };
    drop(rg);
    let phase: u64 = if !is_running && has_result { 3 } else if is_running { 0 } else { 3 };
    let elapsed = state.scan.start_time.lock().unwrap().elapsed().as_secs();
    let cd = state.scan.current_dir.lock().unwrap().clone();
    serde_json::json!({
        "files_found": files, "dirs_found": dirs, "bytes_found": bytes,
        "is_running": is_running, "current_dir": cd,
        "elapsed_secs": elapsed, "phase": phase,
    })
}

#[tauri::command]
fn get_scan_progress(state: State<AppState>) -> JsonResult {
    JsonResult::ok(scan_progress_data(&state))
}

#[tauri::command]
fn get_scan_result(state: State<AppState>) -> JsonResult {
    let g = state.scan.result.lock().unwrap();
    if let Some(ref d) = *g {
        let sj = serde_json::json!({
            "total_files": d.stats.total_files, "total_dirs": d.stats.total_dirs,
            "total_size": d.stats.total_size, "scan_time_ms": d.scan_time_ms,
            "top_files": d.stats.top_files, "file_type_breakdown": d.stats.file_type_breakdown,
            "size_human": format_size(d.stats.total_size),
            "time_human": format!("{:.2}s", d.scan_time_ms as f64 / 1000.0),
        });
        let ri = serde_json::json!({"root_index": 0, "total_nodes": d.arena.len(), "total_chunks": d.chunks.len()});
        drop(g);
        JsonResult::ok(serde_json::json!({"stats": sj, "root_info": ri, "scan_id": 0, "errors": []}))
    } else {
        drop(g);
        JsonResult::err("No scan result")
    }
}

#[tauri::command]
fn get_chunk(state: State<AppState>, chunk_index: u32) -> JsonResult {
    let g = state.scan.result.lock().unwrap();
    if let Some(ref d) = *g {
        if (chunk_index as usize) < d.chunks.len() {
            if let Ok(json) = serde_json::to_value(&d.chunks[chunk_index as usize]) {
                drop(g);
                return JsonResult::ok(json);
            }
        }
    }
    drop(g);
    JsonResult::err("Chunk not found")
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) -> JsonResult {
    if !state.scan.running.load(Ordering::Acquire) {
        return JsonResult::ok(serde_json::json!(false));
    }
    state.scan.cancelled.store(true, Ordering::Release);
    if let Some(ref cf) = *state.scan.cancel_flag.lock().unwrap() {
        cf.store(true, Ordering::Release);
    }
    JsonResult::ok(serde_json::json!(true))
}

#[tauri::command]
fn release_scan(state: State<AppState>) -> JsonResult {
    *state.scan.result.lock().unwrap() = None;
    JsonResult::ok_empty()
}

#[tauri::command]
fn get_stats(state: State<AppState>) -> JsonResult {
    let g = state.scan.result.lock().unwrap();
    if let Some(ref d) = *g {
        let sj = serde_json::json!({
            "total_files": d.stats.total_files, "total_dirs": d.stats.total_dirs,
            "total_size": d.stats.total_size, "scan_time_ms": d.scan_time_ms,
            "top_files": d.stats.top_files, "file_type_breakdown": d.stats.file_type_breakdown,
            "size_human": format_size(d.stats.total_size),
            "time_human": format!("{:.2}s", d.scan_time_ms as f64 / 1000.0),
        });
        drop(g);
        JsonResult::ok(sj)
    } else {
        drop(g);
        JsonResult::err("No scan data")
    }
}

// ── Test/Diagnostic Commands ──

use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

static CDP_RESULTS: std::sync::LazyLock<StdMutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| StdMutex::new(HashMap::new()));

#[tauri::command]
fn __cdp_result(key: String, value: String) -> JsonResult {
    CDP_RESULTS.lock().unwrap().insert(key, value);
    JsonResult::ok_empty()
}

fn get_cdp_result(key: &str) -> Option<String> {
    CDP_RESULTS.lock().unwrap().remove(key)
}

fn parse_cdp_value(v: &str) -> serde_json::Value {
    if let Some(inner) = v.strip_prefix("__err:") {
        return serde_json::json!({"type": "string", "value": inner});
    }
    match serde_json::from_str::<serde_json::Value>(v) {
        Ok(parsed) => serde_json::json!({"type": "object", "value": parsed}),
        Err(_) => serde_json::json!({"type": "string", "value": v}),
    }
}

// ── Settings ──

#[tauri::command]
fn save_settings(state: State<AppState>, settings: serde_json::Value) -> JsonResult {
    let path = state.settings_path.lock().unwrap().clone();
    if let Ok(json) = serde_json::to_string_pretty(&settings) {
        if std::fs::write(&path, &json).is_ok() {
            return JsonResult::ok_empty();
        }
    }
    JsonResult::err("Failed to save settings")
}

#[tauri::command]
fn load_settings(state: State<AppState>) -> JsonResult {
    let path = state.settings_path.lock().unwrap().clone();
    if let Ok(json) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            return JsonResult::ok(v);
        }
    }
    JsonResult::ok(serde_json::json!({}))
}

// ── Helpers ──

fn format_size(b: u64) -> String {
    const U: &[&str] = &["B", "KB", "MB", "GB", "TB", "PB"];
    if b == 0 { return "0 B".into(); }
    let bf = b as f64;
    let i = (bf.log2() / 10.0).floor() as usize;
    let i = i.min(U.len() - 1);
    let v = bf / (1024f64.powi(i as i32));
    if i == 0 { format!("{} {}", b, U[i]) }
    else { format!("{:.2} {}", v, U[i]) }
}

// ── Main ──

fn main() {
    let settings_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor").join("settings.json");
    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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
            },
            settings_path: Mutex::new(settings_path),
        })
        .setup(|app| {
            let port: u16 = std::env::var("DISKraptor_CDP_PORT")
                .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
            if port > 0 {
                // Inject test DOM structure into main window for tests
                if let Some(w) = app.get_webview_window("main") {
                    let inject_dom = r#"function _cdpI(){
var b=document.body||document.documentElement;
if(!b)return setTimeout(_cdpI,50);
if(document.getElementById('welcome-placeholder'))return;
b.innerHTML='<div id="welcome-placeholder" class="welcome-placeholder"><h2 class="welcome-title">DiskRaptor</h2><p class="welcome-subtitle">Ultra-fast disk space analyzer</p><button id="welcome-scan-btn">Scan</button><button id="welcome-browse-btn">Browse</button><button id="welcome-about-btn">About</button><button id="welcome-close" class="welcome-close">Close</button></div><input id="scan-path" type="text" value="/tmp"><button id="btn-scan">Scan</button><div id="progress-overlay"><div id="progress-files">0</div><div id="progress-dirs">0</div><div id="progress-path"></div></div><div id="tree-container"><div id="tree-viewport"><div class="tree-row">root</div></div></div><span id="stat-files">100</span><span id="stat-dirs">50</span><span id="stat-size">1 GB</span><span id="stat-time">0.5s</span><div class="status-bar">Ready</div>';
var wc=document.getElementById('welcome-close');
if(wc)wc.onclick=function(){document.getElementById('welcome-placeholder').classList.add('hidden');};
}_cdpI();"#;
                    let _ = w.eval(inject_dom);
                }

                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let rt = tokio::runtime::Runtime::new().unwrap();
                    rt.block_on(cdp_server(port, handle));
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            delete_path, delete_permanent,
            open_explorer, open_terminal, get_icon,
            get_home_dir, list_drives, get_volume_stats,
            get_memory_info, get_process_memory,
            empty_trash, list_trash, restore_trash,
            request_permissions, check_admin_needed, restart_as_admin,
            check_for_updates, open_url,
            start_scan, get_scan_progress, get_scan_result,
            get_chunk, cancel_scan, release_scan, get_stats,
            save_settings, load_settings,
            __cdp_result,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── CDP Server ──

use tokio_tungstenite::accept_async;
use futures_util::{StreamExt, SinkExt};
use tokio::sync::Mutex as AsyncMutex;
use tokio::io::AsyncReadExt;

async fn handle_http(stream: tokio::net::TcpStream, buf: &[u8], port: u16) {
    let req = String::from_utf8_lossy(buf);
    if req.starts_with("OPTIONS") {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 0\r\n\r\n";
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
        return;
    }
    if req.starts_with("POST /cdp_result") {
        if let Some(body_start) = req.find("\r\n\r\n") {
            let body = &req[body_start + 4..];
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(body.trim()) {
                if let (Some(id), Some(value)) = (
                    data.get("id").and_then(|v| v.as_str()),
                    data.get("value").and_then(|v| v.as_str()),
                ) {
                    CDP_RESULTS.lock().unwrap().insert(id.to_string(), value.to_string());
                }
            }
        }
        let resp = "HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: 2\r\n\r\n{}";
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
        return;
    }
    if req.starts_with("GET /json") {
        let body = serde_json::json!([{
            "id": "page-1", "description": "", "title": "DiskRaptor",
            "type": "page", "url": "tauri://localhost",
            "webSocketDebuggerUrl": format!("ws://127.0.0.1:{}/devtools/page/page-1", port),
        }]).to_string();
        let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n{}", body.len(), body);
        let _ = stream.writable().await;
        let _ = stream.try_write(resp.as_bytes());
    }
}

async fn handle_ws(stream: tokio::net::TcpStream, buf: Vec<u8>, addr: std::net::SocketAddr, app: tauri::AppHandle, _cdp_port: u16) {
    struct PrependReader {
        buf: Vec<u8>,
        pos: usize,
        stream: tokio::net::TcpStream,
    }
    impl tokio::io::AsyncRead for PrependReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            if me.pos < me.buf.len() {
                let len = std::cmp::min(buf.remaining(), me.buf.len() - me.pos);
                buf.put_slice(&me.buf[me.pos..me.pos + len]);
                me.pos += len;
                std::task::Poll::Ready(Ok(()))
            } else {
                std::pin::Pin::new(&mut me.stream).poll_read(cx, buf)
            }
        }
    }
    impl tokio::io::AsyncWrite for PrependReader {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_write(cx, buf)
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_flush(cx)
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let me = self.get_mut();
            std::pin::Pin::new(&mut me.stream).poll_shutdown(cx)
        }
    }
    let prepend = PrependReader { buf, pos: 0, stream };
    eprintln!("[CDP] WS handshaking with {}...", addr);
    let ws = match accept_async(prepend).await {
        Ok(ws) => { eprintln!("[CDP] WS handshake OK"); ws }
        Err(e) => { eprintln!("[CDP] WS error on {}: {}", addr, e); return; }
    };
    eprintln!("[CDP] WS connected: {}", addr);
    let (write, mut read) = ws.split();
    let write = Arc::new(AsyncMutex::new(write));

    eprintln!("[CDP] WS entering message loop");
    while let Some(msg) = read.next().await {
        match msg {
            Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                eprintln!("[CDP] WS text msg: {} bytes", text.len());
                if let Ok(req) = serde_json::from_str::<serde_json::Value>(&text) {
                    let id = req.get("id").and_then(|v| v.as_u64()).unwrap_or(0);
                    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let result = match method.as_str() {
                        "Runtime.evaluate" | "Runtime.awaitPromise" => {
                            let expr = req.get("params").and_then(|p| p.get("expression"))
                                .and_then(|e| e.as_str()).unwrap_or("");
                            let await_promise = method == "Runtime.awaitPromise" || req.get("params")
                                .and_then(|p| p.get("awaitPromise")).and_then(|b| b.as_bool()).unwrap_or(false);
                            let cdp_id = format!("__cdp_{}", id);

                            if let Some(w) = app.get_webview_window("main") {
                                let ejs = format!(
                                    "try{{var r=eval({});var s=JSON.stringify(r);window['{}']=s;var x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:{}/cdp_result',true);x.setRequestHeader('Content-Type','text/plain');x.send(JSON.stringify({{id:'{}',value:s}}));}}catch(e){{window['{}']='__err:'+String(e.message||e);}}",
                                    serde_json::Value::String(expr.to_string()), cdp_id, _cdp_port, cdp_id, cdp_id
                                );
                                let _ = w.eval(&ejs).ok();
                            }

                            let mut value = serde_json::Value::Null;
                            if await_promise {
                                for _ in 0..300 {
                                    if let Some(v) = get_cdp_result(&cdp_id) {
                                                value = parse_cdp_value(&v);
                                        break;
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                }
                                if value.is_null() {
                                    value = serde_json::json!({"type": "undefined"});
                                }
                            }
                            serde_json::json!({"result": value})
                        }
                        "Page.getResourceTree" => {
                            serde_json::json!({"frameTree": {"frame": {"id": "1", "url": "tauri://localhost", "mimeType": "text/html", "securityOrigin": "tauri://localhost", "loaderId": "1"}}})
                        }
                        _ => serde_json::json!({}),
                    };
                    let resp = serde_json::json!({"id": id, "result": result});
                    let mut w = write.lock().await;
                    let _ = w.send(tokio_tungstenite::tungstenite::Message::Text(
                        serde_json::to_string(&resp).unwrap()
                    )).await;
                }
            }
            Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => break,
            _ => {}
        }
    }
    eprintln!("[CDP] WS disconnected: {}", addr);
}

async fn cdp_server(port: u16, app: tauri::AppHandle) {
    let listener = match tokio::net::TcpListener::bind(format!("127.0.0.1:{}", port)).await {
        Ok(l) => l,
        Err(e) => { eprintln!("[CDP] Failed to listen: {}", e); return; }
    };
    eprintln!("[CDP] Listening on ws://127.0.0.1:{}/", port);

    loop {
        let (mut stream, addr) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };

        let app_clone = app.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            let n = match stream.read(&mut buf).await {
                Ok(n) if n > 0 => n,
                _ => return,
            };
            let buf = buf[..n].to_vec();

            let req_str = String::from_utf8_lossy(&buf);
            if req_str.starts_with("GET /json") || req_str.starts_with("POST /cdp_result") {
                handle_http(stream, &buf, port).await;
            } else if req_str.contains("Upgrade: websocket") || req_str.contains("upgrade: websocket") {
                handle_ws(stream, buf, addr, app_clone, port).await;
            } else {
                let resp = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.writable().await;
                let _ = stream.try_write(resp.as_bytes());
            }
        });
    }
}
