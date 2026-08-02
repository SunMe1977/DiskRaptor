#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::TreeChunk;
use diskraptor_scanner::streaming::chunker::CHUNK_SIZE;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Emitter, Manager, State};
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
    live_entries: Mutex<Option<std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>>>,
}

#[allow(dead_code)]
struct ScanResultData {
    arena: scanner::tree::TreeNodeArena,
    stats: scanner::tree::ScanStats,
    scan_time_ms: u64,
    errors: Vec<String>,
}

// ── App managed state ──

struct AppState {
    scan: ScanState,
    settings_path: Mutex<std::path::PathBuf>,
    #[allow(dead_code)] // used on Linux for pkexec caching
    smart_cache: Mutex<std::collections::HashMap<String, (std::time::Instant, JsonResult)>>,
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
    #[allow(dead_code)] // used on Linux for smartctl cache
    fn clone(&self) -> Self {
        Self { success: self.success, data: self.data.clone(), error: self.error.clone() }
    }
}

// ── File Operations ──

/// Reject dangerous delete targets (filesystem roots, home dir, drive roots).
fn sanitize_delete_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    let path = std::path::Path::new(p);
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let home = dirs::home_dir().unwrap_or_default();
    if !home.as_os_str().is_empty() && canonical == home {
        return Err("Refusing to delete the home directory".into());
    }
    if canonical.parent().map(|x| x == canonical).unwrap_or(false) {
        return Err("Refusing to delete a filesystem root".into());
    }
    #[cfg(target_os = "windows")]
    {
        if canonical.components().count() == 1 {
            return Err("Refusing to delete a drive root".into());
        }
    }
    Ok(canonical)
}

#[tauri::command]
fn delete_path(path: String) -> JsonResult {
    let path = match sanitize_delete_path(&path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return JsonResult::err(e),
    };
    if trash::delete(&path).is_ok() {
        return JsonResult::ok_empty();
    }
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            // Sandboxed build: the `trash` crate uses NSFileManager which works
            // for user-selected files; the osascript/Finder path is not allowed.
            return JsonResult::err("Could not move to trash in sandbox");
        }
        let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
        if let Ok(s) = std::process::Command::new("osascript")
            .args(["-e", &format!("tell app \"Finder\" to delete POSIX file \"{}\"", escaped)])
            .status()
        {
            if s.success() { return JsonResult::ok_empty(); }
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
async fn delete_permanent(path: String) -> JsonResult {
    let path = match sanitize_delete_path(&path) {
        Ok(p) => p,
        Err(e) => return JsonResult::err(e),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let p = &path;
        if p.is_dir() { std::fs::remove_dir_all(p).ok(); }
        else { std::fs::remove_file(p).ok(); }
        JsonResult::ok_empty()
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Delete failed: {e}")))
}

#[tauri::command]
fn open_explorer(path: String) -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            return JsonResult::err("Opening in Finder is not available in the sandboxed build.");
        }
        let _ = std::process::Command::new("open").args(["-R", &path]).status();
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
        if in_mac_sandbox() {
            return JsonResult::err("Opening Terminal is not available in the sandboxed build.");
        }
        let _ = std::process::Command::new("open").args(["-a", "Terminal", dir_str]).status();
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
fn pick_directory(app: tauri::AppHandle) -> JsonResult {
    use tauri_plugin_dialog::DialogExt;
    match app.dialog().file().blocking_pick_folder() {
        Some(fp) => match fp.into_path() {
            Ok(p) => JsonResult::ok(serde_json::Value::String(p.to_string_lossy().to_string())),
            Err(_) => JsonResult::err("Invalid selection"),
        },
        None => JsonResult::err("No folder selected"),
    }
}

#[tauri::command]
fn get_trash_path() -> JsonResult {
    let path = {
        #[cfg(target_os = "macos")]
        { dirs::home_dir().map(|h| h.join(".Trash")) }
        #[cfg(target_os = "linux")]
        { dirs::home_dir().map(|h| h.join(".local/share/Trash/files")) }
        #[cfg(target_os = "windows")]
        {
            let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
            Some(std::path::PathBuf::from(format!("{}\\$Recycle.Bin", system_drive)))
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        { dirs::home_dir().map(|h| h.join(".Trash")) }
    };
    match path {
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
        let label = d.name().to_string_lossy().to_string();
        serde_json::json!({
            "path": mount, "name": if label.is_empty() { mount.clone() } else { label },
            "total_bytes": total, "free_bytes": free, "used_bytes": used,
            "percentFull": pct, "usage_pct": pct, "type": "local",
            // legacy aliases used by some callers
            "total": total, "free": free, "used": used,
        })
    }).collect();
    JsonResult::ok(serde_json::json!(disks))
}

fn classify_download(name: &str, size: u64, age_days: u64) -> (bool, bool, bool) {
    let lower = name.to_lowercase();
    let is_temp = lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower.ends_with(".download")
        || lower.ends_with(".tmp");
    let is_old = age_days >= 90;
    let is_large = size >= 100 * 1024 * 1024;
    (is_temp, is_old, is_large)
}

#[tauri::command]
async fn list_downloads_candidates() -> JsonResult {
    tauri::async_runtime::spawn_blocking(|| {
        let home = dirs::home_dir().unwrap_or_default();
        let dl = home.join("Downloads");
        if !dl.is_dir() {
            return JsonResult::err("Downloads folder not found");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut files = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&dl) {
            for entry in rd.flatten() {
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if !meta.is_file() { continue; }
                let size = meta.len();
                let modified = meta.modified().ok()
                    .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(now);
                let age_days = (now.saturating_sub(modified)) / 86400;
                let name = entry.file_name().to_string_lossy().to_string();
                let (is_temp, is_old, is_large) = classify_download(&name, size, age_days);
                if !is_temp && !is_old && !is_large { continue; }
                files.push(serde_json::json!({
                    "name": name,
                    "path": path.to_string_lossy(),
                    "size": size,
                    "age_days": age_days,
                    "is_temp": is_temp,
                    "is_old": is_old,
                    "is_large": is_large,
                    "size_human": format_size(size),
                }));
            }
        }
        files.sort_by(|a, b| {
            b["size"].as_u64().unwrap_or(0).cmp(&a["size"].as_u64().unwrap_or(0))
        });
        JsonResult::ok(serde_json::json!({
            "path": dl.to_string_lossy(),
            "files": files,
        }))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Cleanup scan failed: {e}")))
}

#[tauri::command]
fn get_volume_stats() -> JsonResult {
    list_drives()
}

/// Enumerate mounted volumes via sysinfo — works without spawning any external
/// helper, so it survives the macOS App Sandbox (unlike smartctl/system_profiler).
#[allow(dead_code)]
fn list_volumes_via_sysinfo() -> Vec<serde_json::Value> {
    let disks_list = sysinfo::Disks::new_with_refreshed_list();
    let mut out = Vec::new();
    for d in disks_list.list() {
        let mount = d.mount_point().to_string_lossy().to_string();
        if mount.is_empty() { continue; }
        let total = d.total_space();
        let free = d.available_space();
        let used = total.saturating_sub(free);
        let pct = if total > 0 { (used as f64 / total as f64 * 100.0).round() as u64 } else { 0 };
        let label = d.name().to_string_lossy().to_string();
        out.push(serde_json::json!({
            "id": mount.clone(),
            "name": if label.is_empty() { mount.clone() } else { label },
            "size": total,
            "total_bytes": total, "free_bytes": free, "used_bytes": used,
            "usage_pct": pct, "percentFull": pct,
            "is_mac_device": true, "is_internal": false,
        }));
    }
    out
}

/// Quick top-level stats for a directory: total size, file count, dir count.
/// Uses a capped walk so it stays fast for the tool previews.
#[tauri::command]
async fn get_dir_stats(path: String) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::PathBuf::from(&path);
        if !p.is_dir() {
            return JsonResult::err("Not a directory");
        }
        let mut total_bytes = 0u64;
        let mut files = 0u64;
        let mut dirs = 0u64;
        let mut errors = 0u64;
        let mut walked = 0u64;
        const MAX_WALK: u64 = 500_000;
        let mut stack: Vec<std::path::PathBuf> = vec![p];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                errors += 1;
                continue;
            };
            for entry in rd.flatten() {
                walked += 1;
                if walked > MAX_WALK {
                    break;
                }
                let path = entry.path();
                let Ok(meta) = entry.metadata() else { continue };
                if meta.is_dir() {
                    dirs += 1;
                    stack.push(path);
                } else if meta.is_file() {
                    files += 1;
                    total_bytes += meta.len();
                }
            }
            if walked > MAX_WALK {
                break;
            }
        }
        JsonResult::ok(serde_json::json!({
            "path": path,
            "total_bytes": total_bytes,
            "files": files,
            "dirs": dirs,
            "errors": errors,
            "truncated": walked > MAX_WALK,
        }))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Stats failed: {e}")))
}

// ── S.M.A.R.T. Tools ────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn win_powershell(script: &str) -> Option<String> {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn win_powershell_file(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(path)
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

fn run_output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

/// Returns true when running inside the macOS App Sandbox, where spawning
/// external helpers (smartctl, system_profiler, osascript) is not permitted.
#[cfg(target_os = "macos")]
fn in_mac_sandbox() -> bool {
    std::env::var("APP_SANDBOX_CONTAINER_ID").is_ok()
}

#[cfg(not(target_os = "macos"))]
fn in_mac_sandbox() -> bool {
    false
}

#[cfg(target_os = "linux")]
fn run_smartctl_linux(device_id: &str) -> Option<String> {
    // Direct call first (works when user has disk access / is root).
    if let Some(s) = run_output("smartctl", &["-j", "-a", &format!("/dev/{}", device_id)]) {
        return Some(s);
    }
    // Fall back to pkexec so the polkit dialog elevates smartctl once.
    run_output("pkexec", &["smartctl", "-j", "-a", &format!("/dev/{}", device_id)])
}

/// Normalize smartmontools JSON (`smartctl -j -a`) into a common report shape.
fn smart_from_smartctl(v: &serde_json::Value, device_id: &str) -> Option<serde_json::Value> {
    let model = v.pointer("/model_name").and_then(|x| x.as_str()).unwrap_or(device_id).to_string();
    let serial = v.pointer("/serial_number").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let firmware = v.pointer("/firmware_version").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let dev_type = v.pointer("/device/type").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let passed = v.pointer("/smart_status/passed").and_then(|x| x.as_bool()).unwrap_or(false);
    let temp = v.pointer("/temperature/current").and_then(|x| x.as_u64()).map(|x| x as f64);
    let powh = v.pointer("/power_on_time/hours").and_then(|x| x.as_u64()).unwrap_or(0);
    let capacity = v.pointer("/user_capacity/bytes").and_then(|x| x.as_u64()).unwrap_or(0);

    let mut attributes: Vec<serde_json::Value> = Vec::new();

    // Devices that report no SMART support (e.g. virtualized SCSI disks)
    // still expose model/capacity/interface — return a report that says
    // "not supported" instead of fabricating a health score.
    let support_available = v.pointer("/smart_support/available").and_then(|x| x.as_bool());
    let unsupported = support_available == Some(false) && !dev_type.contains("nvme");

    if dev_type.contains("nvme") {
        let nvme_fields: &[(&str, &str)] = &[
            ("02", "Temperature"), ("03", "Available Spare"), ("04", "Available Spare Threshold"),
            ("05", "Percentage Used"), ("06", "Data Units Read"), ("07", "Data Units Written"),
            ("08", "Host Read Commands"), ("09", "Host Write Commands"), ("0a", "Controller Busy Time"),
            ("0b", "Power Cycles"), ("0c", "Power On Hours"), ("0d", "Unsafe Shutdowns"),
            ("0e", "Media Errors"), ("0f", "Num Err Log Entries"), ("10", "Warning Temp Time"),
            ("11", "Critical Comp Temp Time"), ("12", "Thermal Sensor 1"), ("13", "Thermal Sensor 2"),
        ];
        if let Some(log) = v.pointer("/nvme_smart_health_information_log") {
            let critical = log.get("critical_warning").and_then(|x| x.as_u64()).unwrap_or(0);
            for (id, name) in nvme_fields {
                let key = name.split_whitespace().collect::<Vec<_>>().join("_");
                let val = log.get(&key).and_then(|x| x.as_u64());
                attributes.push(serde_json::json!({
                    "id": id, "name": name,
                    "current": val, "worst": null, "threshold": null,
                    "raw": val.map(|x| x.to_string()).unwrap_or_default(),
                    "status": "OK",
                }));
            }
            attributes.insert(0, serde_json::json!({
                "id": "01", "name": "Critical Warning",
                "current": critical, "worst": null, "threshold": null,
                "raw": critical.to_string(),
                "status": if critical > 0 { "FAIL" } else { "OK" },
            }));
        }
    } else if let Some(table) = v.pointer("/ata_smart_attributes/table") {
        if let Some(arr) = table.as_array() {
            for a in arr {
                let id = a.get("id").and_then(|x| x.as_u64()).unwrap_or(0);
                let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
                let val = a.get("value").and_then(|x| x.as_u64());
                let worst = a.get("worst").and_then(|x| x.as_u64());
                let thresh = a.get("thresh").and_then(|x| x.as_u64());
                let raw = a.pointer("/raw/string").and_then(|x| x.as_str()).unwrap_or("");
                let failed = a.pointer("/flags/failure").and_then(|x| x.as_bool()).unwrap_or(false);
                attributes.push(serde_json::json!({
                    "id": format!("{:02X}", id), "name": name,
                    "current": val, "worst": worst, "threshold": thresh,
                    "raw": raw, "status": if failed { "FAIL" } else { "OK" },
                }));
            }
        }
    }

    let (score, status) = if unsupported {
        (0u64, "Not Supported")
    } else if passed {
        (100u64, "Healthy")
    } else {
        (30u64, "Critical")
    };
    Some(serde_json::json!({
        "device_id": device_id,
        "model": model, "serial": serial, "firmware": firmware,
        "interface": dev_type.to_uppercase(),
        "capacity": capacity,
        "score": score, "status": status,
        "smart_supported": !unsupported,
        "temperature_c": temp,
        "power_on_hours": powh,
        "attributes": attributes,
        "source": "smartctl",
    }))
}

/// Combine OS health status + SMART attributes into a 0-100 score.
#[cfg(target_os = "windows")]
fn smart_health_from_attrs(health: i64, wear: Option<f64>, temp: Option<f64>, read_unc: u64, write_unc: u64) -> (u64, &'static str) {
    let mut score: f64 = 100.0;
    match health {
        1 => score -= 20.0,
        2 => score -= 60.0,
        _ => {}
    }
    if let Some(w) = wear {
        if w > 90.0 { score -= 40.0; }
        else if w > 75.0 { score -= 20.0; }
        else if w > 50.0 { score -= 8.0; }
    }
    if let Some(t) = temp {
        if t >= 60.0 { score -= 30.0; }
        else if t >= 50.0 { score -= 10.0; }
        else if t >= 45.0 { score -= 4.0; }
    }
    if read_unc + write_unc > 0 { score -= 15.0; }
    let score = score.clamp(0.0, 100.0).round() as u64;
    let status = if score >= 85 { "Healthy" } else if score >= 55 { "Warning" } else { "Critical" };
    (score, status)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn list_disks() -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        let script = "try { $d = Get-CimInstance -ClassName MSFT_PhysicalDisk -Namespace 'root\\Microsoft\\Windows\\Storage' | Select-Object DeviceId, FriendlyName, MediaType, HealthStatus, OperationalStatus, Size, Model, SerialNumber, BusType, SpindleSpeed, FirmwareVersion; if (-not $d) { '[]'; exit 0 }; @($d) | ConvertTo-Json -Compress } catch { exit 1 }";
        if let Some(s) = win_powershell(script) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                let arr = if v.is_array() { v } else { serde_json::json!([v]) };
                let norm: Vec<serde_json::Value> = arr.as_array().map(|a| a.iter().map(|d| {
                    let id = d["DeviceId"].as_str().unwrap_or("0");
                    serde_json::json!({
                        "id": id, "name": d["FriendlyName"],
                        "media_type": d["MediaType"], "health": d["HealthStatus"],
                        "size": d["Size"], "model": d["Model"],
                        "serial": d["SerialNumber"], "bus": d["BusType"],
                        "firmware": d["FirmwareVersion"],
                        "status": d["OperationalStatus"],
                        "device": format!("\\\\.\\PHYSICALDRIVE{}", id),
                    })
                }).collect()).unwrap_or_default();
                return JsonResult::ok(serde_json::json!(norm));
            }
        }
        JsonResult::err("Could not enumerate physical disks")
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(s) = run_output("lsblk", &["-J", "-b", "-d", "-o", "NAME,MODEL,SIZE,TRAN,SERIAL,TYPE"]) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(devs) = v.pointer("/blockdevices") {
                    let arr: Vec<serde_json::Value> = devs.as_array().map(|a| a.iter().filter_map(|d| {
                        let dev_type = d["type"].as_str().unwrap_or("");
                        let name = d["name"].as_str().unwrap_or("");
                        if dev_type != "disk" || name.starts_with("fd") { return None; }
                        let trans = d["tran"].as_str().unwrap_or("").to_lowercase();
                        Some(serde_json::json!({
                            "id": d["name"].as_str().unwrap_or(""),
                            "name": d["model"].as_str().unwrap_or(""),
                            "media_type": if trans.contains("nvme") || trans.contains("ssd") { 4 } else { 3 },
                            "size": d["size"].as_u64().unwrap_or(0),
                            "serial": d["serial"].as_str().unwrap_or(""),
                            "is_linux_device": true,
                        }))
                    }).collect()).unwrap_or_default();
                    return JsonResult::ok(serde_json::json!(arr));
                }
            }
        }
        JsonResult::err("Could not enumerate block devices")
    }
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            // Sandboxed MAS builds cannot spawn smartctl/system_profiler.
            // Fall back to the app's own mounted-volume enumeration so the
            // SSD/S.M.A.R.T. tool still shows something.
            let disks = list_volumes_via_sysinfo();
            if !disks.is_empty() {
                return JsonResult::ok(serde_json::json!(disks));
            }
            return JsonResult::err(
                "S.M.A.R.T. is unavailable in the sandboxed App Store build.",
            );
        }
        if run_output("smartctl", &["--version"]).is_some() {
            let mut disks = Vec::new();
            for i in 0..8 {
                if let Some(s) = run_output("smartctl", &["-j", "-i", &format!("disk{}", i)]) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                        if v.pointer("/model_name").and_then(|m| m.as_str()).is_some() {
                            let rot = v.pointer("/rotation_rate").and_then(|r| r.as_u64()).unwrap_or(0);
                            disks.push(serde_json::json!({
                                "id": format!("disk{}", i),
                                "name": v.pointer("/model_name").and_then(|m| m.as_str()).unwrap_or(""),
                                "media_type": if rot == 0 { 4 } else { 3 },
                                "serial": v.pointer("/serial_number").and_then(|m| m.as_str()).unwrap_or(""),
                                "is_mac_device": true,
                            }));
                        }
                    }
                }
            }
            if !disks.is_empty() { return JsonResult::ok(serde_json::json!(disks)); }
        }
        // Fall back to `system_profiler` so the SSD/S.M.A.R.T. tool still lists
        // drives even when smartmontools is not installed.
        if let Some(s) = run_output("system_profiler", &["SPStorageDataType", "-json"]) {
            let disks = parse_system_profiler_disks(&s);
            if !disks.is_empty() {
                return JsonResult::ok(serde_json::json!(disks));
            }
        }
        // Last resort: mounted volumes from sysinfo (works everywhere, incl. sandbox).
        let disks = list_volumes_via_sysinfo();
        if !disks.is_empty() {
            return JsonResult::ok(serde_json::json!(disks));
        }
        JsonResult::err("S.M.A.R.T. requires smartmontools (smartctl) on macOS")
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        JsonResult::err("Unsupported platform")
    }
}

#[allow(dead_code)]
fn parse_system_profiler_disks(s: &str) -> Vec<serde_json::Value> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(s) else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    v.get("SPStorageDataType")
        .and_then(|a| a.as_array())
        .map(|items| {
            items.iter().filter_map(|it| {
                let pd = it.get("physical_drive")?;
                let dev = pd.get("device_name").and_then(|d| d.as_str()).unwrap_or("");
                if dev.is_empty() { return None; }
                if !seen.insert(dev.to_string()) { return None; }
                let medium = pd.get("medium_type").and_then(|m| m.as_str()).unwrap_or("");
                let bsd = it.get("bsd_name").and_then(|b| b.as_str()).unwrap_or("");
                let disk_num: String = bsd
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                let is_internal = pd.get("is_internal_disk").and_then(|x| x.as_str()).unwrap_or("") == "yes";
                Some(serde_json::json!({
                    "id": if disk_num.is_empty() { bsd.to_string() } else { format!("disk{disk_num}") },
                    "name": dev,
                    "media_type": if medium == "ssd" { 4 } else { 3 },
                    "size": it.get("size_in_bytes").and_then(|s| s.as_u64()).unwrap_or(0),
                    "is_mac_device": true,
                    "is_internal": is_internal,
                }))
            }).collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn get_smart_status(state: State<AppState>, device_id: String) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        let _ = &state;
        // 1) Prefer smartmontools for a full CrystalDiskInfo-style report.
        if let Some(s) = run_output("smartctl", &["-j", "-a", &format!("\\\\.\\PHYSICALDRIVE{}", device_id)]) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(r) = smart_from_smartctl(&v, &device_id) {
                    return JsonResult::ok(r);
                }
            }
        }
        // 2) WMI fallback + NVMe SMART passthrough (fills firmware/interface/capacity/temperature).
        let ps = r#"param()
$id = "__ID__"
try {
  $d = Get-CimInstance -Namespace 'root\Microsoft\Windows\Storage' -ClassName MSFT_PhysicalDisk -Filter "DeviceId = $id"
  if (-not $d) { Write-Output '{}'; exit 0 }

  $result = [ordered]@{
    device_id = $d.DeviceId
    friendly_name = $d.FriendlyName
    model = $d.Model
    serial = $d.SerialNumber
    media_type = $d.MediaType
    health = [int]($d.HealthStatus)
    size = $d.Size
    firmware = $d.FirmwareVersion
    bus = $d.BusType
  }

  # NVMe SMART health log via storage protocol passthrough
  $nvme = $null
  try {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NvmeSmart {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr CreateFile(string f, uint a, uint s, IntPtr sa, uint cd, uint fa, IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool DeviceIoControl(IntPtr h, uint c, IntPtr i, uint isz, IntPtr o, uint osz, out uint r, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, FS_READ = 1, FS_WRITE = 2, OPEN = 3, NORMAL = 0x80;
  static uint CTL(uint dev, uint fn, uint m, uint a) { return (dev << 16) | (a << 14) | (fn << 2) | m; }
  static uint IOCTL_STORAGE_QUERY_PROPERTY = CTL(0x2D, 0x0500, 0, 0);
  const uint StorageDeviceProtocolSpecificProperty = 50;
  const uint ProtocolTypeNvme = 3;
  const uint NVMeDataTypeLogPage = 2;
  const uint LOG_PAGE_SMART = 0x02;
  [StructLayout(LayoutKind.Sequential)] struct PROP_QUERY { public uint id; public uint type; public byte extra; }
  [StructLayout(LayoutKind.Sequential)] struct PROTO { public uint t; public uint dt; public uint rv; public uint rsv; public uint off; public uint len; public uint fix; public uint rsv2; }
  static ulong U64(byte[] d, int o) { return (ulong)d[o] | ((ulong)d[o + 1] << 8) | ((ulong)d[o + 2] << 16) | ((ulong)d[o + 3] << 24) | ((ulong)d[o + 4] << 32) | ((ulong)d[o + 5] << 40) | ((ulong)d[o + 6] << 48) | ((ulong)d[o + 7] << 56); }
  public static object GetSmart(string dev) {
    IntPtr h = CreateFile(dev, GENERIC_READ | GENERIC_WRITE, FS_READ | FS_WRITE, IntPtr.Zero, OPEN, NORMAL, IntPtr.Zero);
    if (h == (IntPtr)(-1)) return null;
    try {
      int qs = Marshal.SizeOf(typeof(PROP_QUERY)) + Marshal.SizeOf(typeof(PROTO));
      int total = qs + 512;
      IntPtr buf = Marshal.AllocHGlobal(total);
      try {
        Marshal.WriteInt32(buf, 0, (int)StorageDeviceProtocolSpecificProperty);
        Marshal.WriteInt32(buf, 4, 0);
        Marshal.WriteInt32(buf, 8, (int)ProtocolTypeNvme);
        Marshal.WriteInt32(buf, 12, (int)NVMeDataTypeLogPage);
        Marshal.WriteInt32(buf, 16, (int)LOG_PAGE_SMART);
        Marshal.WriteInt32(buf, 20, 0);
        Marshal.WriteInt32(buf, 24, qs);
        Marshal.WriteInt32(buf, 28, 512);
        Marshal.WriteInt32(buf, 32, 0);
        Marshal.WriteInt32(buf, 36, 0);
        uint ret = 0;
        if (!DeviceIoControl(h, IOCTL_STORAGE_QUERY_PROPERTY, buf, (uint)total, buf, (uint)total, out ret, IntPtr.Zero)) return null;
        byte[] d = new byte[512];
        Marshal.Copy(IntPtr.Add(buf, qs), d, 0, 512);
        int kelvin = d[1] | (d[2] << 8);
        return new {
          temperature_c = kelvin > 0 ? kelvin - 273 : 0,
          critical_warning = d[0],
          available_spare = d[3],
          available_spare_threshold = d[4],
          percentage_used = d[5],
          data_units_read = U64(d, 15),
          data_units_written = U64(d, 23),
          host_read_commands = U64(d, 31),
          host_write_commands = U64(d, 39),
          power_cycles = U64(d, 47),
          power_on_hours = U64(d, 55),
          unsafe_shutdowns = U64(d, 63),
          media_errors = U64(d, 71),
          num_err_log_entries = U64(d, 79)
        };
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(h); }
  }
}
"@
    $nvme = [NvmeSmart]::GetSmart('\\.\PHYSICALDRIVE' + $id)
  } catch { $nvme = $null }

  # Reliability counters (needs admin) - best effort
  $rel = @()
  try {
    $rel = @($d | Get-CimAssociatedInstance -ResultClassName MSFT_StorageReliabilityCounter | Select-Object Temperature, Wear, PowerOnHours, ReadErrorsTotal, WriteErrorsTotal, ReadErrorsUncorrected, WriteErrorsUncorrected, StartStopCycleCount, LoadUnloadCycleCount)
  } catch { $rel = @() }

  if ($nvme) {
    $result.temperature_c = $nvme.temperature_c
    $result.power_on_hours = $nvme.power_on_hours
    $result.power_cycles = $nvme.power_cycles
    $result.percentage_used = $nvme.percentage_used
    $result.available_spare = $nvme.available_spare
    $result.available_spare_threshold = $nvme.available_spare_threshold
    $result.data_units_read = $nvme.data_units_read
    $result.data_units_written = $nvme.data_units_written
    $result.host_read_commands = $nvme.host_read_commands
    $result.host_write_commands = $nvme.host_write_commands
    $result.unsafe_shutdowns = $nvme.unsafe_shutdowns
    $result.media_errors = $nvme.media_errors
    $result.num_err_log_entries = $nvme.num_err_log_entries
    $result.critical_warning = $nvme.critical_warning
    $result.nvme = $true
  } else {
    $t = @($rel | Measure-Object -Property Temperature -Maximum)
    $result.temperature_c = if ($t.Count -gt 0 -and $t.Maximum) { [math]::Round($t.Maximum) } else { $null }
    $w = @($rel | Measure-Object -Property Wear -Maximum)
    $result.wear = if ($w.Count -gt 0 -and $w.Maximum) { [math]::Round($w.Maximum, 1) } else { $null }
    $ph = @($rel | Measure-Object -Property PowerOnHours -Sum)
    $result.power_on_hours = if ($ph.Count -gt 0 -and $ph.Sum) { $ph.Sum } else { 0 }
    $ru = @($rel | Measure-Object -Property ReadErrorsUncorrected -Sum)
    $result.read_errors_uncorrected = if ($ru.Count -gt 0 -and $ru.Sum) { $ru.Sum } else { 0 }
    $wu = @($rel | Measure-Object -Property WriteErrorsUncorrected -Sum)
    $result.write_errors_uncorrected = if ($wu.Count -gt 0 -and $wu.Sum) { $wu.Sum } else { 0 }
    $result.nvme = $false
  }

  $result | ConvertTo-Json -Compress
  exit 0
} catch {
  Write-Output '{}'
  exit 1
}
"#;
        let ps_path = std::env::temp_dir().join("diskraptor_smart.ps1");
        let _ = std::fs::write(&ps_path, ps.replace("__ID__", &device_id));
        let out = win_powershell_file(&ps_path);
        let _ = std::fs::remove_file(&ps_path);
        if let Some(s) = out {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if v.get("device_id").is_some() {
                    let health = v.get("health").and_then(|x| x.as_i64()).unwrap_or(-1);
                    let bus = v.get("bus").and_then(|x| x.as_i64()).unwrap_or(0);
                    let interface = match bus {
                        17 => "NVMe", 11 => "SATA", 10 => "SAS", 7 => "USB", 3 => "ATA",
                        8 => "RAID", 9 => "iSCSI", 12 => "SD", 13 => "MMC", 18 => "SCM",
                        _ => "Unknown",
                    };
                    let temp = v.get("temperature_c").and_then(|x| x.as_f64());
                    let wear = v.get("wear").and_then(|x| x.as_f64());
                    let powh = v.get("power_on_hours").and_then(|x| x.as_u64()).unwrap_or(0);
                    let cycles = v.get("power_cycles").and_then(|x| x.as_u64());
                    let pct_used = v.get("percentage_used").and_then(|x| x.as_u64());
                    let avail_spare = v.get("available_spare").and_then(|x| x.as_u64());
                    let du_read = v.get("data_units_read").and_then(|x| x.as_u64());
                    let du_written = v.get("data_units_written").and_then(|x| x.as_u64());
                    let unsafe_shutdowns = v.get("unsafe_shutdowns").and_then(|x| x.as_u64());
                    let media_errors = v.get("media_errors").and_then(|x| x.as_u64());
                    let num_err = v.get("num_err_log_entries").and_then(|x| x.as_u64());
                    let critical_warning = v.get("critical_warning").and_then(|x| x.as_u64()).unwrap_or(0);
                    let is_nvme = v.get("nvme").and_then(|x| x.as_bool()).unwrap_or(false);
                    let read_u = v.get("read_errors_uncorrected").and_then(|x| x.as_u64()).unwrap_or(0);
                    let write_u = v.get("write_errors_uncorrected").and_then(|x| x.as_u64()).unwrap_or(0);

                    let (score, status) = smart_health_from_attrs(health, wear, temp, read_u, write_u);

                    let attributes: Vec<serde_json::Value> = if is_nvme {
                        vec![
                            serde_json::json!({"id":"01","name":"Critical Warning","current":critical_warning,"worst":null,"threshold":null,"raw":critical_warning.to_string(),"status":if critical_warning > 0 {"FAIL"} else {"OK"}}),
                            serde_json::json!({"id":"02","name":"Temperature","current":temp.map(|t| t.round() as u64),"worst":null,"threshold":null,"raw":temp.map(|t| format!("{} C", t.round())).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"03","name":"Available Spare","current":avail_spare,"worst":null,"threshold":null,"raw":avail_spare.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"05","name":"Percentage Used","current":pct_used,"worst":null,"threshold":null,"raw":pct_used.map(|x| format!("{}%", x)).unwrap_or_else(|| "n/a".into()),"status":if pct_used.unwrap_or(0) >= 90 {"WARN"} else {"OK"}}),
                            serde_json::json!({"id":"06","name":"Data Units Read","current":du_read,"worst":null,"threshold":null,"raw":du_read.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"07","name":"Data Units Written","current":du_written,"worst":null,"threshold":null,"raw":du_written.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"0b","name":"Power Cycles","current":cycles,"worst":null,"threshold":null,"raw":cycles.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"0c","name":"Power On Hours","current":Some(powh),"worst":null,"threshold":null,"raw":powh.to_string(),"status":"OK"}),
                            serde_json::json!({"id":"0d","name":"Unsafe Shutdowns","current":unsafe_shutdowns,"worst":null,"threshold":null,"raw":unsafe_shutdowns.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"0e","name":"Media Errors","current":media_errors,"worst":null,"threshold":null,"raw":media_errors.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":if media_errors.unwrap_or(0) > 0 {"WARN"} else {"OK"}}),
                            serde_json::json!({"id":"0f","name":"Num Err Log Entries","current":num_err,"worst":null,"threshold":null,"raw":num_err.map(|x| x.to_string()).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                        ]
                    } else {
                        vec![
                            serde_json::json!({"id":"01","name":"Health Status","current":health,"worst":null,"threshold":null,"raw":health.to_string(),"status":if health == 0 {"OK"} else {"WARN"}}),
                            serde_json::json!({"id":"02","name":"Temperature","current":temp.map(|t| t.round() as u64),"worst":null,"threshold":null,"raw":temp.map(|t| format!("{} C", t.round())).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"03","name":"Wear Level","current":wear.map(|w| w.round() as u64),"worst":null,"threshold":null,"raw":wear.map(|w| format!("{}%", w.round())).unwrap_or_else(|| "n/a".into()),"status":"OK"}),
                            serde_json::json!({"id":"04","name":"Power On Hours","current":Some(powh),"worst":null,"threshold":null,"raw":powh.to_string(),"status":"OK"}),
                            serde_json::json!({"id":"05","name":"Read Errors Uncorrected","current":Some(read_u),"worst":null,"threshold":null,"raw":read_u.to_string(),"status":if read_u > 0 {"WARN"} else {"OK"}}),
                            serde_json::json!({"id":"06","name":"Write Errors Uncorrected","current":Some(write_u),"worst":null,"threshold":null,"raw":write_u.to_string(),"status":if write_u > 0 {"WARN"} else {"OK"}}),
                        ]
                    };

                    return JsonResult::ok(serde_json::json!({
                        "device_id": v["device_id"].as_str().unwrap_or(&device_id),
                        "friendly_name": v["friendly_name"].as_str().unwrap_or(""),
                        "model": v["model"].as_str().unwrap_or(""),
                        "serial": v["serial"].as_str().unwrap_or(""),
                        "firmware": v["firmware"].as_str().unwrap_or(""),
                        "interface": interface,
                        "media_type": v["media_type"].as_i64().unwrap_or(-1),
                        "capacity": v["size"].as_u64().unwrap_or(0),
                        "health": health,
                        "score": score,
                        "status": status,
                        "temperature_c": temp,
                        "wear": wear,
                        "power_on_hours": powh,
                        "power_cycles": cycles,
                        "percentage_used": pct_used,
                        "available_spare": avail_spare,
                        "media_errors": media_errors,
                        "read_errors_uncorrected": read_u,
                        "write_errors_uncorrected": write_u,
                        "attributes": attributes,
                        "source": if is_nvme { "nvme" } else { "wmi" },
                    }));
                }
            }
        }
        JsonResult::err("S.M.A.R.T. data not available for this disk")
    }
    #[cfg(target_os = "linux")]
    {
        // Cache pkexec results (success AND failure) for 5 minutes so we
        // don't prompt for the admin password on every scan.
        const CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);
        {
            let cache = state.smart_cache.lock().unwrap();
            if let Some((when, cached)) = cache.get(&device_id) {
                if when.elapsed() < CACHE_TTL {
                    return cached.clone();
                }
            }
        }
        let result = if let Some(s) = run_smartctl_linux(&device_id) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                smart_from_smartctl(&v, &device_id)
            } else {
                None
            }
        } else {
            None
        };
        let out = match result {
            Some(r) => JsonResult::ok(r),
            None => JsonResult::err(
                "S.M.A.R.T. data not available (is smartmontools installed, and does this disk support SMART?)",
            ),
        };
        state
            .smart_cache
            .lock()
            .unwrap()
            .insert(device_id.clone(), (std::time::Instant::now(), out.clone()));
        out
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &state;
        if in_mac_sandbox() {
            return JsonResult::err(
                "S.M.A.R.T. is unavailable in the sandboxed App Store build.",
            );
        }
        if let Some(s) = run_output("smartctl", &["-j", "-a", &device_id]) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                if let Some(r) = smart_from_smartctl(&v, &device_id) {
                    return JsonResult::ok(r);
                }
            }
        }
        JsonResult::err("S.M.A.R.T. data not available (is smartmontools installed?)")
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        JsonResult::err("Unsupported platform")
    }
}

// ── Browser Cleanup Tools ─────────────────────────────────────────

#[derive(Clone)]
struct BrowserDef {
    name: &'static str,
    #[allow(dead_code)] // used by browser_paths_windows
    sub: &'static str,
    kind: &'static str,
    #[allow(dead_code)] // used by browser_paths_windows
    base: &'static str, // "local" | "appdata"
}

fn dir_size(path: &std::path::Path) -> u64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for entry in rd.flatten() {
            total += dir_size(&entry.path());
        }
    }
    total
}

fn sum_sizes(paths: &[std::path::PathBuf]) -> u64 {
    paths.iter().map(|p| dir_size(p)).sum()
}

fn delete_path_recursive(path: &std::path::Path) -> u64 {
    let size = dir_size(path);
    if size > 0 {
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
    }
    size
}

fn browser_defs() -> Vec<BrowserDef> {
    vec![
        BrowserDef { name: "Google Chrome", sub: r"Google\Chrome\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Microsoft Edge", sub: r"Microsoft\Edge\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Safari", sub: r"com.apple.Safari", kind: "safari", base: "local" },
        BrowserDef { name: "Chromium", sub: r"Chromium\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Brave", sub: r"BraveSoftware\Brave-Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Vivaldi", sub: r"Vivaldi\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Yandex Browser", sub: r"Yandex\YandexBrowser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Avast Secure Browser", sub: r"AVAST Software\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "AVG Secure Browser", sub: r"AVG\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "CocCoc", sub: r"CocCoc\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Maxthon", sub: r"Maxthon5\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Arc", sub: r"Arc\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Epic Privacy Browser", sub: r"Epic Privacy Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Slimjet", sub: r"Slimjet\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Opera", sub: r"Opera Software\Opera Stable", kind: "opera", base: "appdata" },
        BrowserDef { name: "Opera GX", sub: r"Opera Software\Opera GX Stable", kind: "opera", base: "appdata" },
        BrowserDef { name: "Firefox", sub: r"Mozilla\Firefox\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Waterfox", sub: r"Waterfox\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Pale Moon", sub: r"Moonchild Productions\Pale Moon\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Tor Browser", sub: r"Tor Browser\Browser\TorBrowser\Data\Browser", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Internet Explorer", sub: r"Microsoft\Windows\Cookies", kind: "ie", base: "appdata" },
    ]
}

#[cfg(target_os = "windows")]
fn browser_paths_windows(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let appdata = std::env::var("APPDATA").ok()?;
    let base_dir = if def.base == "local" { &local } else { &appdata };
    let base = std::path::PathBuf::from(base_dir).join(def.sub);
    let (cookies, cache) = match def.kind {
        "chrome" | "opera" => (
            vec![
                base.join("Default").join("Network").join("Cookies"),
                base.join("Default").join("Cookies"),
            ],
            vec![
                base.join("Default").join("Cache"),
                base.join("Default").join("Code Cache"),
                base.join("Default").join("GPUCache"),
                base.join("Default").join("Service Worker").join("CacheStorage"),
            ],
        ),
        "firefox" => {
            let mut cookies = Vec::new();
            let mut cache = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    let ck = p.join("cookies.sqlite");
                    if ck.exists() { cookies.push(ck); }
                    cache.push(p.join("cache2"));
                    cache.push(p.join("startupCache"));
                }
            }
            (cookies, cache)
        }
        "ie" => (
            vec![base.join("Cookies")],
            vec![std::path::PathBuf::from(&local).join(r"Microsoft\Windows\INetCache")],
        ),
        _ => (Vec::new(), Vec::new()),
    };
    Some((base, cookies, cache))
}

#[cfg(target_os = "linux")]
fn browser_paths_linux(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let home = std::env::var("HOME").ok()?;
    let cfg = |p: &str| std::path::PathBuf::from(&home).join(".config").join(p);
    let cache = |p: &str| std::path::PathBuf::from(&home).join(".cache").join(p);
    let (base, cookies, cache_paths): (std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) = match def.name {
        "Google Chrome" => (cfg("google-chrome"), vec![cfg("google-chrome/Default/Network/Cookies")], vec![cache("google-chrome/Default/Cache")]),
        "Chromium" => (cfg("chromium"), vec![cfg("chromium/Default/Network/Cookies")], vec![cache("chromium/Default/Cache")]),
        "Microsoft Edge" => (cfg("microsoft-edge"), vec![cfg("microsoft-edge/Default/Network/Cookies")], vec![cache("microsoft-edge/Default/Cache")]),
        "Brave" => (cfg("BraveSoftware/Brave-Browser"), vec![cfg("BraveSoftware/Brave-Browser/Default/Network/Cookies")], vec![cache("BraveSoftware/Brave-Browser/Default/Cache")]),
        "Opera" => (cfg("opera"), vec![cfg("opera/Default/Network/Cookies")], vec![cache("opera/Default/Cache")]),
        "Firefox" => {
            let base = std::path::PathBuf::from(&home).join(".mozilla").join("firefox");
            let mut cookies = Vec::new();
            let mut caches = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    if p.join("cookies.sqlite").exists() { cookies.push(p.join("cookies.sqlite")); }
                    caches.push(p.join("cache2"));
                }
            }
            (base, cookies, caches)
        }
        _ => return None,
    };
    Some((base, cookies, cache_paths))
}

#[cfg(target_os = "macos")]
fn browser_paths_macos(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let home = std::env::var("HOME").ok()?;
    let support = |p: &str| std::path::PathBuf::from(&home).join("Library/Application Support").join(p);
    let caches = |p: &str| std::path::PathBuf::from(&home).join("Library/Caches").join(p);
    let (base, cookies, cache_paths) = match def.name {
        "Google Chrome" => (support("Google/Chrome"), vec![support("Google/Chrome/Default/Network/Cookies")], vec![caches("Google/Chrome/Default/Cache")]),
        "Microsoft Edge" => (support("Microsoft Edge"), vec![support("Microsoft Edge/Default/Network/Cookies")], vec![caches("Microsoft Edge/Default/Cache")]),
        "Safari" => {
            let base = support("com.apple.Safari");
            let container = std::path::PathBuf::from(&home).join("Library/Containers/com.apple.Safari/Data/Library");
            let cookies = if container.join("Cookies/Cookies.binarycookies").exists() {
                vec![container.join("Cookies/Cookies.binarycookies")]
            } else {
                vec![base.join("Cookies.binarycookies")]
            };
            let mut cache = Vec::new();
            for p in [
                container.join("Caches/com.apple.Safari"),
                container.join("WebKit/com.apple.WebKit"),
                container.join("WebKit/com.apple.Safari"),
                caches("com.apple.Safari"),
            ] {
                if p.exists() { cache.push(p); }
            }
            if cache.is_empty() { cache.push(base.join("Cache")); }
            (base, cookies, cache)
        }
        "Firefox" => {
            let base = support("Firefox/Profiles");
            let mut cookies = Vec::new();
            let mut caches = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    if p.join("cookies.sqlite").exists() { cookies.push(p.join("cookies.sqlite")); }
                    caches.push(p.join("cache2"));
                }
            }
            (base, cookies, caches)
        }
        _ => return None,
    };
    Some((base, cookies, cache_paths))
}

#[allow(clippy::needless_return)] // cfg-gated returns keep each platform arm type-consistent
fn browser_paths(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    #[cfg(target_os = "windows")]
    { return browser_paths_windows(def); }
    #[cfg(target_os = "linux")]
    { return browser_paths_linux(def); }
    #[cfg(target_os = "macos")]
    { return browser_paths_macos(def); }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    { None }
}

#[cfg(target_os = "windows")]
fn browser_exe_path(name: &str) -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    match name {
        "Google Chrome" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Google\Chrome\Application\chrome.exe"));
        }
        "Microsoft Edge" => {
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Microsoft\Edge\Application\msedge.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
        "Firefox" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Mozilla Firefox\firefox.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Mozilla Firefox\firefox.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Mozilla Firefox\firefox.exe"));
        }
        "Opera" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera\opera.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera\launcher.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Opera\launcher.exe"));
        }
        "Opera GX" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera GX\opera.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera GX\launcher.exe"));
        }
        "Brave" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
        }
        "Chromium" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Chromium\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Chromium\Application\chrome.exe"));
        }
        "Vivaldi" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Vivaldi\Application\vivaldi.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Vivaldi\Application\vivaldi.exe"));
        }
        "Yandex Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Yandex\YandexBrowser\Application\browser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Yandex\YandexBrowser\Application\browser.exe"));
        }
        "Avast Secure Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"AVAST Software\Browser\Application\AvastBrowser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"AVAST Software\Browser\Application\AvastBrowser.exe"));
        }
        "AVG Secure Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"AVG\Browser\Application\AVGBrowser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"AVG\Browser\Application\AVGBrowser.exe"));
        }
        "Tor Browser" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Tor Browser\Browser\firefox.exe"));
        }
        "Internet Explorer" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Internet Explorer\iexplore.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Internet Explorer\iexplore.exe"));
        }
        _ => {}
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn simple_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{:016x}", h)
}

#[tauri::command]
fn get_browser_icon(exe: String) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        let cache_dir = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("diskraptor").join("browser-icons");
        let cache_file = cache_dir.join(format!("{}.txt", simple_hash(&exe)));
        // Fast path: read previously extracted icon from disk cache.
        if let Ok(s) = std::fs::read_to_string(&cache_file) {
            if s.starts_with("data:image") {
                return JsonResult::ok(serde_json::Value::String(s.trim().to_string()));
            }
        }
        let script = r#"Add-Type -AssemblyName System.Drawing; try { $i = [System.Drawing.Icon]::ExtractAssociatedIcon('__EXE__'); if ($i) { $b = $i.ToBitmap(); $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bytes = $ms.ToArray(); Write-Output ('data:image/png;base64,' + [Convert]::ToBase64String($bytes)) } else { exit 1 } } catch { exit 1 }"#;
        let script = script.replace("__EXE__", &exe.replace('\'', "''"));
        if let Some(s) = win_powershell(&script) {
            let s = s.trim();
            if s.starts_with("data:image") {
                let _ = std::fs::create_dir_all(&cache_dir);
                let _ = std::fs::write(&cache_file, s);
                return JsonResult::ok(serde_json::Value::String(s.to_string()));
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = &exe; }
    JsonResult::err("Could not extract browser icon")
}

#[tauri::command]
async fn list_browser_data() -> JsonResult {
    // Summing cache sizes walks large directory trees, so run it off the
    // main/UI thread to avoid freezing the window.
    tauri::async_runtime::spawn_blocking(|| {
        let mut list: Vec<serde_json::Value> = Vec::new();
        for def in browser_defs() {
            if let Some((_base, cookies, cache)) = browser_paths(&def) {
                let cookie_size = sum_sizes(&cookies);
                let cache_size = sum_sizes(&cache);
                if cookie_size == 0 && cache_size == 0 { continue; }
                let exe: Option<String> = {
                    #[cfg(target_os = "windows")]
                    {
                        browser_exe_path(def.name).map(|p| p.to_string_lossy().to_string())
                    }
                    #[cfg(not(target_os = "windows"))]
                    { None }
                };
                let cookie_paths: Vec<String> = cookies.iter()
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                let cache_paths: Vec<String> = cache.iter()
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                list.push(serde_json::json!({
                    "name": def.name,
                    "cookie_size": cookie_size,
                    "cache_size": cache_size,
                    "total_size": cookie_size + cache_size,
                    "kind": def.kind,
                    "exe": exe,
                    "cookie_paths": cookie_paths,
                    "cache_paths": cache_paths,
                }));
            }
        }
        list.sort_by(|a, b| b["total_size"].as_u64().unwrap_or(0).cmp(&a["total_size"].as_u64().unwrap_or(0)));
        JsonResult::ok(serde_json::json!(list))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Browser scan failed: {e}")))
}

#[tauri::command]
async fn clean_browser(name: String, cookies: bool, cache: bool) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        for def in browser_defs() {
            if def.name != name { continue; }
            if let Some((_base, cookie_paths, cache_paths)) = browser_paths(&def) {
                let mut freed = 0u64;
                if cookies {
                    for p in &cookie_paths {
                        if p.exists() { freed += delete_path_recursive(p); }
                    }
                }
                if cache {
                    for p in &cache_paths {
                        if p.exists() { freed += delete_path_recursive(p); }
                    }
                }
                return JsonResult::ok(serde_json::json!({
                    "name": name, "freed": freed,
                }));
            }
        }
        JsonResult::err(format!("Browser not found: {}", name))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Clean failed: {e}")))
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
fn get_app_version() -> JsonResult {
    JsonResult::ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": "DiskRaptor",
    }))
}

#[tauri::command]
fn get_app_data_dir() -> JsonResult {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor");
    JsonResult::ok(serde_json::json!({
        "path": dir.to_string_lossy(),
    }))
}

#[tauri::command]
fn get_app_info() -> JsonResult {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let data_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor");
    JsonResult::ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": "DiskRaptor",
        "os": os,
        "arch": arch,
        "data_dir": data_dir.to_string_lossy(),
    }))
}

#[tauri::command]
fn empty_trash() -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            // In the sandbox we cannot drive Finder. Empty the user's own
            // trash container if we can read it; otherwise report clearly.
            if let Some(home) = dirs::home_dir() {
                let trash = home.join(".Trash");
                if let Ok(entries) = std::fs::read_dir(&trash) {
                    let mut ok = false;
                    for entry in entries.flatten() {
                        let p = entry.path();
                        let name = entry.file_name();
                        if name.to_string_lossy().starts_with('.') { continue; }
                        let r = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                        if r.is_ok() { ok = true; }
                    }
                    if ok || !trash.exists() {
                        return JsonResult::ok_empty();
                    }
                }
            }
            return JsonResult::err("Empty Trash is unavailable in the sandboxed build.");
        }
        let _ = std::process::Command::new("osascript").args(["-e", "tell app \"Finder\" to empty trash"]).status();
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
    {
        // The real recycle bin lives at {SystemDrive}\$Recycle.Bin — NOT in the
        // user profile. The old temp-dir derivation targeted the wrong folder
        // and silently never emptied anything.
        let system_drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let bin = format!("{}\\$Recycle.Bin", system_drive);
        let _ = std::process::Command::new("cmd").args(["/c", "rd", "/s", "/q", &bin]).status();
    }
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
            let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
            let size = if is_dir {
                dir_size(&entry.path())
            } else {
                meta.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            items.push(serde_json::json!({
                "name": name,
                "path": entry.path().to_string_lossy(),
                "size": size,
                "is_dir": is_dir,
                "deleted_at": "",
            }));
        }
    }
    items
}

#[cfg(target_os = "macos")]
fn list_trash_macos() -> Vec<serde_json::Value> {
    let script = r#"import os,json
t=os.path.expanduser('~/.Trash')
out=[]
for f in os.listdir(t):
    if f.startswith('.'): continue
    p=os.path.join(t,f)
    try:
        st=os.lstat(p)
        isdir=os.path.isdir(p)
        size=0
        if isdir:
            for root,dirs,files in os.walk(p):
                for n in files:
                    try: size+=os.lstat(os.path.join(root,n)).st_size
                    except: pass
        else:
            size=st.st_size
        out.append({'name':f,'path':p,'size':size,'is_dir':isdir,'deleted_at':''})
    except: pass
print(json.dumps(out))"#;
    let output = std::process::Command::new("python3")
        .args(["-c", script])
        .output();
    if let Ok(out) = output {
        if let Ok(s) = String::from_utf8(out.stdout) {
            let trimmed = s.trim();
            if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
                return items;
            }
        }
    }
    Vec::new()
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
fn is_sandboxed() -> JsonResult {
    JsonResult::ok(serde_json::json!({ "sandboxed": in_mac_sandbox() }))
}

#[tauri::command]
#[cfg(not(feature = "store"))]
fn check_admin_needed(_path: String) -> JsonResult {
    JsonResult::ok(serde_json::json!(false))
}

#[tauri::command]
#[cfg(not(feature = "store"))]
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
#[cfg(feature = "store")]
fn check_admin_needed(_path: String) -> JsonResult {
    JsonResult::ok(serde_json::json!(false))
}

#[tauri::command]
#[cfg(feature = "store")]
fn restart_as_admin() -> JsonResult {
    JsonResult::err("Admin elevation is not available in the Store build")
}

#[tauri::command]
async fn check_for_updates() -> JsonResult {
    // Query the GitHub releases API for the latest tag and compare with the
    // installed version. Async so a slow network call never blocks the UI.
    let installed = env!("CARGO_PKG_VERSION");
    // Sandboxed Store builds cannot run the curl subprocess; report no update
    // available (updates are distributed via the store itself).
    if cfg!(target_os = "macos") && in_mac_sandbox() {
        return JsonResult::ok(serde_json::json!({
            "version": installed,
            "latest": null,
            "update_available": false,
        }));
    }
    let result = tauri::async_runtime::spawn_blocking(|| {
        let out = std::process::Command::new("curl")
            .args([
                "-s",
                "-m",
                "8",
                "https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest",
            ])
            .output()
            .ok()?;
        if !out.status.success() { return None; }
        let s = String::from_utf8_lossy(&out.stdout);
        let v: serde_json::Value = serde_json::from_str(&s).ok()?;
        let tag = v.get("tag_name").and_then(|t| t.as_str())?;
        let latest = tag.trim_start_matches('v').to_string();
        Some(latest)
    })
    .await;
    match result {
        Ok(Some(latest)) => {
            let update_available = latest != installed;
            JsonResult::ok(serde_json::json!({
                "version": installed,
                "latest": latest,
                "update_available": update_available,
            }))
        }
        _ => JsonResult::ok(serde_json::json!({
            "version": installed,
            "latest": null,
            "update_available": false,
        })),
    }
}

#[tauri::command]
fn open_url(url: String) -> JsonResult {
    // Restrict to safe schemes so a compromised frontend can't use this to
    // launch arbitrary programs (e.g. file:///path/to/script).
    let lower = url.trim().to_ascii_lowercase();
    if !(lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
    {
        return JsonResult::err("Blocked URL scheme");
    }
    let _ = open::that(&url);
    JsonResult::ok_empty()
}

// ── Scanner Commands ──

fn scan_config(
    path: &str,
    follow_symlinks: bool,
    timeout_secs: u64,
    live: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<String>>>,
) -> scanner::walker::ScanConfig {
    scanner::walker::ScanConfig {
        root_path: path.into(),
        follow_symlinks,
        scan_timeout_secs: timeout_secs,
        errors: Arc::new(Mutex::new(Vec::new())),
        cancelled: Some(Arc::new(AtomicBool::new(false))),
        live_entries: live,
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
    *scan.scan.errors.lock().unwrap() = Vec::new();

    let p = path.clone();
    let fs = follow_symlinks.unwrap_or(false);
    let ts = timeout_secs.unwrap_or(30);
    let handle = app.clone();

    let live = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
    *scan.scan.live_entries.lock().unwrap() = Some(live.clone());

    let result_handle = handle.clone();
    std::thread::Builder::new().name("scan".into()).spawn(move || {
        let config = scan_config(&p, fs, ts, live);
        let cancel_flag = config.cancelled.clone().unwrap();
        {
            let s = result_handle.state::<AppState>();
            *s.scan.cancel_flag.lock().unwrap() = Some(cancel_flag.clone());
            if s.scan.cancelled.load(Ordering::Acquire) { return; }
        }

        let progress_handle = result_handle.clone();
        let emit_handle = handle.clone();
        let progress = Box::new(move |files: u64, dirs: u64, bytes: u64, msg: &str| {
            let s = progress_handle.state::<AppState>();
            s.scan.files_found.store(files, Ordering::Relaxed);
            s.scan.dirs_found.store(dirs, Ordering::Relaxed);
            s.scan.bytes_found.store(bytes, Ordering::Relaxed);
            if !msg.is_empty() {
                *s.scan.current_dir.lock().unwrap() = msg.to_owned();
            }
            let _ = emit_handle.emit(
                "scan:progress",
                serde_json::json!({
                    "files": files, "dirs": dirs, "bytes": bytes, "path": msg,
                }),
            );
        });

        let result = {
            // Run the walker on a dedicated worker so a hung walker (e.g. a
            // Windows junction loop in $Recycle.Bin) can be cut off after a
            // no-progress timeout. Without this, a stuck scan never sets
            // running=false and the UI hangs forever waiting for it.
            let (tx, rx) = std::sync::mpsc::channel();
            let worker = std::thread::Builder::new().name("scan-worker".into()).spawn(move || {
                let _ = tx.send(scanner::walker::scan_directory_with_progress(config, progress));
            });

            let poll = std::time::Duration::from_millis(250);
            let mut last_progress = Instant::now();
            let mut last_count = (0u64, 0u64);
            let watchdog_result = loop {
                match rx.recv_timeout(poll) {
                    Ok(res) => break Some(res),
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break None,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        let s = result_handle.state::<AppState>();
                        let f = s.scan.files_found.load(Ordering::Relaxed);
                        let d = s.scan.dirs_found.load(Ordering::Relaxed);
                        if (f, d) != last_count {
                            last_count = (f, d);
                            last_progress = Instant::now();
                        }
                        if last_progress.elapsed().as_secs() > ts {
                            cancel_flag.store(true, Ordering::Release);
                            s.scan.cancelled.store(true, Ordering::Release);
                            s.scan.errors.lock().unwrap().push(format!(
                                "TIMEOUT: scan made no progress for {}s and was stopped",
                                ts
                            ));
                            eprintln!("[scan] no progress for {}s, stopped walker", ts);
                            break None;
                        }
                    }
                }
            };
            if let Ok(w) = worker {
                // Keep the worker handle alive while we finish up; dropping it
                // merely detaches the thread.
                drop(w);
            }
            watchdog_result
        };
        let s = result_handle.state::<AppState>();
        match result {
            Some(Ok(sr)) => {
                let elapsed = sr.stats.scan_time_ms;
                // NOTE: chunks are built on demand in get_chunk (avoids cloning the
                // whole arena and doubling peak memory for huge scans).
                *s.scan.result.lock().unwrap() = Some(ScanResultData {
                    arena: sr.arena, stats: sr.stats, scan_time_ms: elapsed,
                    errors: Vec::new(),
                });
            }
            Some(Err(e)) => {
                eprintln!("[scan] error: {}", e);
                // Surface the error to the UI so the user sees why the tree is empty.
                s.scan.errors.lock().unwrap().push(e.to_string());
                let _ = result_handle.emit("scan:error", serde_json::json!({ "error": e.to_string() }));
            }
            None => {
                // Timed out: errors were already pushed by the watchdog.
            }
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
    let errors: Vec<String> = state.scan.errors.lock().unwrap().clone();
    drop(rg);
    let phase: u64 = if !is_running && has_result { 3 } else if is_running { 0 } else { 3 };
    let elapsed = state.scan.start_time.lock().unwrap().elapsed().as_secs();
    let cd = state.scan.current_dir.lock().unwrap().clone();
    let live: Vec<String> = state
        .scan
        .live_entries
        .lock()
        .unwrap()
        .as_ref()
        .map(|q| q.lock().unwrap().iter().cloned().collect())
        .unwrap_or_default();
    serde_json::json!({
        "files_found": files, "dirs_found": dirs, "bytes_found": bytes,
        "is_running": is_running, "current_dir": cd,
        "elapsed_secs": elapsed, "phase": phase,
        "errors": errors, "live_entries": live,
    })
}

#[tauri::command]
fn get_scan_progress(state: State<AppState>) -> JsonResult {
    JsonResult::ok(scan_progress_data(&state))
}

/// Build a single chunk from the arena on demand (clones only that chunk's nodes).
fn build_chunk(arena: &scanner::tree::TreeNodeArena, chunk_id: u32) -> Option<TreeChunk> {
    let total = arena.nodes.len() as u32;
    let total_chunks = total.div_ceil(CHUNK_SIZE);
    if chunk_id >= total_chunks {
        return None;
    }
    let start: usize = (chunk_id as u64 * CHUNK_SIZE as u64) as usize;
    let end: usize = (((chunk_id as u64 + 1) * CHUNK_SIZE as u64).min(total as u64)) as usize;
    let mut nodes = Vec::with_capacity(end - start);
    for idx in start..end {
        let mut node = arena.nodes[idx].clone();
        node.chunk_id = chunk_id;
        nodes.push(node);
    }
    Some(TreeChunk {
        chunk_id,
        total_chunks,
        total_nodes: total,
        start_index: start as u32,
        nodes,
    })
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
        let total_chunks = (d.arena.len() as u32).div_ceil(CHUNK_SIZE);
        let ri = serde_json::json!({"root_index": 0, "total_nodes": d.arena.len(), "total_chunks": total_chunks});
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
        if let Some(chunk) = build_chunk(&d.arena, chunk_index) {
            if let Ok(json) = serde_json::to_value(&chunk) {
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

#[cfg(feature = "test-server")]
use std::collections::HashMap;
#[cfg(feature = "test-server")]
use std::sync::Mutex as StdMutex;

#[cfg(feature = "test-server")]
static CDP_RESULTS: std::sync::LazyLock<StdMutex<HashMap<String, String>>> =
    std::sync::LazyLock::new(|| StdMutex::new(HashMap::new()));

#[cfg(feature = "test-server")]
#[tauri::command]
fn __cdp_result(key: String, value: String) -> JsonResult {
    CDP_RESULTS.lock().unwrap().insert(key, value);
    JsonResult::ok_empty()
}

#[cfg(feature = "test-server")]
fn get_cdp_result(key: &str) -> Option<String> {
    CDP_RESULTS.lock().unwrap().remove(key)
}

#[cfg(feature = "test-server")]
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
    // Accept both `invoke("save_settings", { settings: {...} })` and a raw payload.
    let settings = match settings.get("settings") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => settings,
    };
    let path = state.settings_path.lock().unwrap().clone();
    let mut merged = std::fs::read_to_string(&path)
        .ok()
        .and_then(|j| serde_json::from_str::<serde_json::Value>(&j).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if let (Some(obj), Some(updates)) = (merged.as_object_mut(), settings.as_object()) {
        for (k, v) in updates {
            obj.insert(k.clone(), v.clone());
        }
        if let Ok(json) = serde_json::to_string_pretty(&merged) {
            if std::fs::write(&path, &json).is_ok() {
                return JsonResult::ok_empty();
            }
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

// ── Native menu ────────────────────────────────────────────
const MENU_LANGUAGES: &[(&str, &str)] = &[
    ("lang_en", "English"),
    ("lang_de", "Deutsch"),
    ("lang_fr", "Français"),
    ("lang_es", "Español"),
    ("lang_it", "Italiano"),
    ("lang_pt", "Português"),
    ("lang_nl", "Nederlands"),
    ("lang_pl", "Polski"),
    ("lang_sv", "Svenska"),
    ("lang_da", "Dansk"),
    ("lang_nb", "Norsk"),
    ("lang_fi", "Suomi"),
    ("lang_cs", "Čeština"),
    ("lang_ro", "Română"),
    ("lang_tr", "Türkçe"),
    ("lang_id", "Bahasa Indonesia"),
    ("lang_vi", "Tiếng Việt"),
    ("lang_ru", "Русский"),
    ("lang_uk", "Українська"),
    ("lang_ar", "العربية"),
    ("lang_zh", "简体中文"),
    ("lang_zh-tw", "繁體中文"),
    ("lang_ja", "日本語"),
    ("lang_ko", "한국어"),
    ("lang_hi", "हिन्दी"),
];

#[cfg(desktop)]
fn build_native_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let about = MenuItem::with_id(app, "about", "About DiskRaptor", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let app_submenu = Submenu::with_items(
        app,
        "DiskRaptor",
        true,
        &[
            &about as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let view_pie = MenuItem::with_id(app, "view_pie", "Pie Chart", true, Some("CmdOrCtrl+1"))?;
    let view_galaxy = MenuItem::with_id(app, "view_galaxy", "Galaxy", true, Some("CmdOrCtrl+3"))?;
    let view_treemap = MenuItem::with_id(app, "view_treemap", "Treemap", true, Some("CmdOrCtrl+4"))?;

    let lang_auto = MenuItem::with_id(app, "lang_auto", "Auto (System)", true, None::<&str>)?;
    let lang_sep = PredefinedMenuItem::separator(app)?;
    let mut lang_items_owned: Vec<tauri::menu::MenuItem<R>> =
        Vec::with_capacity(MENU_LANGUAGES.len());
    for (id, label) in MENU_LANGUAGES {
        lang_items_owned.push(MenuItem::with_id(app, *id, *label, true, None::<&str>)?);
    }
    let mut lang_items: Vec<&dyn IsMenuItem<R>> = vec![&lang_auto, &lang_sep];
    for item in &lang_items_owned {
        lang_items.push(item);
    }
    let lang_submenu = Submenu::with_items(app, "Language", true, &lang_items)?;

    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &view_pie as &dyn IsMenuItem<R>,
            &view_galaxy,
            &view_treemap,
            &PredefinedMenuItem::separator(app)?,
            &lang_submenu,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let scan_dl =
        MenuItem::with_id(app, "scan_downloads", "Scan Downloads", true, None::<&str>)?;
    let scan_trash = MenuItem::with_id(app, "scan_trash", "Scan Trash", true, None::<&str>)?;
    let trash_recovery =
        MenuItem::with_id(app, "trash_recovery", "Trash Recovery…", true, None::<&str>)?;
    let find_files = MenuItem::with_id(app, "find_files", "Find Files…", true, None::<&str>)?;
    let empty_folders =
        MenuItem::with_id(app, "empty_folders", "Empty Folders…", true, None::<&str>)?;
    let cleanup_dl =
        MenuItem::with_id(app, "cleanup_downloads", "Downloads Cleanup", true, None::<&str>)?;
    let smart_tools =
        MenuItem::with_id(app, "smart_tools", "S.M.A.R.T. Tools…", true, None::<&str>)?;
    let browser_tools =
        MenuItem::with_id(app, "browser_tools", "Clean Browser Tools…", true, None::<&str>)?;
    let find_dupes =
        MenuItem::with_id(app, "find_duplicates", "Find Duplicate Files…", true, Some("CmdOrCtrl+D"))?;
    let export_html =
        MenuItem::with_id(app, "export_html", "Export HTML Report…", true, None::<&str>)?;
    let preferences =
        MenuItem::with_id(app, "preferences", "Preferences…", true, None::<&str>)?;
    let clear_scan = MenuItem::with_id(app, "clear_scan", "Clear Scan", true, None::<&str>)?;
    let empty_trash = MenuItem::with_id(app, "empty_trash", "Empty Trash…", true, None::<&str>)?;
    let exit_app_item = MenuItem::with_id(app, "menu_exit", "Exit", true, Some("CmdOrCtrl+Q"))?;
    let tools_submenu = Submenu::with_items(
        app,
        "Tools",
        true,
        &[
            &scan_dl as &dyn IsMenuItem<R>,
            &scan_trash,
            &trash_recovery,
            &find_files,
            &empty_folders,
            &cleanup_dl,
            &smart_tools,
            &browser_tools,
            &find_dupes,
            &PredefinedMenuItem::separator(app)?,
            &export_html,
            &preferences,
            &clear_scan,
            &PredefinedMenuItem::separator(app)?,
            &empty_trash,
            &PredefinedMenuItem::separator(app)?,
            &exit_app_item,
        ],
    )?;

    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)? as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let check_updates =
        MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
    let help_about = MenuItem::with_id(app, "about_help", "About DiskRaptor", true, Some("CmdOrCtrl+I"))?;
    let help_submenu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &check_updates as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::separator(app)?,
            &help_about,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_submenu as &dyn IsMenuItem<R>,
            &view_submenu,
            &tools_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

#[cfg(desktop)]
fn handle_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let run = |js: &str| {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(js);
        }
    };
    let click = |sel: &str| run(&format!("var e=document.querySelector(\"{sel}\");if(e)e.click();"));
    match id {
        "view_pie" => click(".diagram-mode[data-mode='pie']"),
        "view_galaxy" => click(".diagram-mode[data-mode='galaxy']"),
        "view_treemap" => click(".diagram-mode[data-mode='treemap']"),
        "scan_downloads" => click(".tools-item[data-action='scan-downloads']"),
        "scan_trash" => click(".tools-item[data-action='scan-trash']"),
        "trash_recovery" => click(".tools-item[data-action='trash-recovery']"),
        "find_files" => click(".tools-item[data-action='find-files']"),
        "empty_folders" => click(".tools-item[data-action='empty-folders']"),
        "cleanup_downloads" => click(".tools-item[data-action='cleanup-downloads']"),
        "smart_tools" => click(".tools-item[data-action='smart-tools']"),
        "browser_tools" => click(".tools-item[data-action='browser-tools']"),
        "find_duplicates" => click("#btn-duplicates"),
        "export_html" => click(".tools-item[data-action='export-html']"),
        "preferences" => click(".tools-item[data-action='settings']"),
        "clear_scan" => click(".tools-item[data-action='clear-scan']"),
        "empty_trash" => click(".tools-item[data-action='trash']"),
        "menu_exit" => {
            app.exit(0);
        }
        "check_updates" => run("if(window.__checkUpdate)window.__checkUpdate();"),
        "settings" => run("var s=document.getElementById('settings-overlay');if(s)s.style.display='flex';"),
        "about" | "about_help" => run("var o=document.getElementById('about-overlay');if(o)o.classList.add('active');"),
        "lang_auto" => run("if(window.I18N)window.I18N.setLocale('auto');"),
        _ => {
            if let Some(code) = id.strip_prefix("lang_") {
                run(&format!("if(window.I18N)window.I18N.setLocale('{code}');"));
            }
        }
    }
}

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
                live_entries: Mutex::new(None),
            },
            settings_path: Mutex::new(settings_path),
            smart_cache: Mutex::new(std::collections::HashMap::new()),
        })
        .setup(|_app| {
            #[cfg(feature = "test-server")]
            {
                let port: u16 = std::env::var("DISKraptor_CDP_PORT")
                    .ok().and_then(|s| s.parse().ok()).unwrap_or(0);
                if port > 0 {
                    // Inject test DOM structure into main window for tests.
                    // Only active when DISKraptor_CDP_PORT is explicitly set.
                    if let Some(w) = _app.get_webview_window("main") {
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

                    let handle = _app.handle().clone();
                    std::thread::spawn(move || {
                        let rt = tokio::runtime::Runtime::new().unwrap();
                        rt.block_on(cdp_server(port, handle));
                    });
                }
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = _app.get_webview_window("main") {
                    if let Ok(menu) = build_native_menu(_app.handle()) {
                        let _ = win.set_menu(menu);
                    }
                }
            }
            Ok(())
        })
        .menu(build_native_menu)
        .on_menu_event(|app, event| handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            delete_path, delete_permanent,
            open_explorer, open_terminal, get_icon,
            get_home_dir, pick_directory, get_trash_path, list_drives, get_volume_stats, get_dir_stats,
            list_downloads_candidates,
            get_memory_info, get_process_memory, get_app_version, get_app_data_dir, get_app_info,
            empty_trash, list_trash, restore_trash,
            request_permissions, check_admin_needed, restart_as_admin, is_sandboxed,
            check_for_updates, open_url,
            start_scan, get_scan_progress, get_scan_result,
            get_chunk, cancel_scan, release_scan, get_stats,
            save_settings, load_settings,
            list_disks, get_smart_status, exit_app,
            list_browser_data, clean_browser, get_browser_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── CDP Server ──

#[cfg(feature = "test-server")]
use tokio_tungstenite::accept_async;
#[cfg(feature = "test-server")]
use futures_util::{StreamExt, SinkExt};
#[cfg(feature = "test-server")]
use tokio::sync::Mutex as AsyncMutex;
#[cfg(feature = "test-server")]
use tokio::io::AsyncReadExt;

#[cfg(feature = "test-server")]
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

#[cfg(feature = "test-server")]
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
                                    "try{{var r=eval({});var s=JSON.stringify(r);var x=new XMLHttpRequest();x.open('POST','http://127.0.0.1:{}/cdp_result',true);x.setRequestHeader('Content-Type','text/plain');x.send(JSON.stringify({{id:'{}',value:s}}));}}catch(e){{}}",
                                    serde_json::Value::String(expr.to_string()), _cdp_port, cdp_id
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

#[cfg(feature = "test-server")]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_profiler_handles_empty_input() {
        assert!(parse_system_profiler_disks("").is_empty());
        assert!(parse_system_profiler_disks("not json {").is_empty());
    }

    #[test]
    fn parse_system_profiler_detects_drives() {
        let s = r#"{
          "SPStorageDataType": [
            { "_name": "Data",
              "bsd_name": "disk1s1",
              "size_in_bytes": 429286973440,
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
    }    #[cfg(target_os = "macos")]
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
                name: format!("n{i}").into(),
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
}
