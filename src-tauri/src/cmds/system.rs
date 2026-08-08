//! System-facing commands: drives, volumes, memory, app info, permissions,
//! update checks and disk enumeration. Also hosts the shared shell helpers
//! (`silent_command`, `run_output`, `win_powershell`, `in_mac_sandbox`) that
//! sibling modules (smart, trash) use.
use crate::cmds::path_ops::validate_system_path;
use crate::JsonResult;
#[cfg(target_os = "windows")]
use crate::trash;
use diskraptor_scanner::scanner::tree::format_size;

/// Build a `Command` without flashing a console window. Windows GUI apps show
/// a brief DOS box whenever powershell/cmd/curl/smartctl are launched from
/// them; `CREATE_NO_WINDOW` suppresses that. Only needed on macOS/Linux now â€”
/// every Windows code path uses native APIs.
#[cfg(not(target_os = "windows"))]
pub(crate) fn silent_command(cmd: &str) -> std::process::Command {
    std::process::Command::new(cmd)
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn run_output(cmd: &str, args: &[&str]) -> Option<String> {
    let out = silent_command(cmd).args(args).output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

/// Run a PowerShell command hidden (CREATE_NO_WINDOW) â€” used only as a no-admin
/// fallback for disk enumeration. Never shows a console/DOS window.
#[cfg(target_os = "windows")]
fn win_powershell(script: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .output()
        .ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        None
    }
}

/// Returns true when running inside the macOS App Sandbox, where spawning
/// external helpers (smartctl, system_profiler, osascript) is not permitted.
#[cfg(target_os = "macos")]
pub(crate) fn in_mac_sandbox() -> bool {
    std::env::var("APP_SANDBOX_CONTAINER_ID").is_ok()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn in_mac_sandbox() -> bool {
    false
}

#[tauri::command]
pub(crate) fn get_home_dir() -> JsonResult {
    match dirs::home_dir() {
        Some(p) => JsonResult::ok(serde_json::Value::String(p.to_string_lossy().to_string())),
        None => JsonResult::err("No home directory"),
    }
}

#[tauri::command]
pub(crate) fn pick_directory(app: tauri::AppHandle) -> JsonResult {
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
pub(crate) fn get_trash_path() -> JsonResult {
    let path = {
        #[cfg(target_os = "macos")]
        { dirs::home_dir().map(|h| h.join(".Trash")) }
        #[cfg(target_os = "linux")]
        { dirs::home_dir().map(|h| h.join(".local/share/Trash/files")) }
        #[cfg(target_os = "windows")]
        {
            // Only the current user's recycle bin â€” scanning the $Recycle.Bin
            // root hits SYSTEM-owned folders (S-1-5-18) and 8.3 aliases, which
            // produce access-denied errors.
            trash::current_user_recycle_bin()
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
pub(crate) fn list_drives() -> JsonResult {
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

pub(crate) fn classify_download(name: &str, size: u64, age_days: u64) -> (bool, bool, bool) {
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
pub(crate) async fn list_downloads_candidates() -> JsonResult {
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
pub(crate) fn get_volume_stats() -> JsonResult {
    list_drives()
}

/// Enumerate mounted volumes via sysinfo â€” works without spawning any external
/// helper, so it survives the macOS App Sandbox (unlike smartctl/system_profiler).
#[allow(dead_code)]
pub(crate) fn list_volumes_via_sysinfo() -> Vec<serde_json::Value> {
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
pub(crate) async fn get_dir_stats(path: String) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        let p = match validate_system_path(&path) {
            Ok(p) => p,
            Err(e) => return JsonResult::err(e),
        };
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

// â”€â”€ S.M.A.R.T. Tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[tauri::command]
pub(crate) fn list_disks() -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        // Native probe of \\.\PHYSICALDRIVE0..31 via DeviceIoControl â€” needs
        // admin rights to open a physical drive. Without admin the probe comes
        // back empty, so fall back to a silent WMI query (no console window)
        // that can enumerate physical disks as a normal user.
        let native = crate::smart::native_list_disks();
        if !native.is_empty() {
            return JsonResult::ok(serde_json::json!(native));
        }
        if let Some(s) = win_powershell(
            "try { $d = Get-CimInstance -ClassName MSFT_PhysicalDisk -Namespace 'root\\Microsoft\\Windows\\Storage' | Select-Object DeviceId, FriendlyName, MediaType, HealthStatus, OperationalStatus, Size, Model, SerialNumber, BusType, SpindleSpeed, FirmwareVersion; if (-not $d) { '[]'; exit 0 }; @($d) | ConvertTo-Json -Compress } catch { '[]' }",
        ) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                let arr = if v.is_array() { v } else { serde_json::json!([v]) };
                let norm: Vec<serde_json::Value> = arr
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|d| {
                                let id = d["DeviceId"]
                                    .as_str()
                                    .map(|s| s.to_string())
                                    .or_else(|| d["DeviceId"].as_i64().map(|n| n.to_string()))
                                    .unwrap_or_else(|| "0".to_string());
                                serde_json::json!({
                                    "id": id,
                                    "name": d["FriendlyName"],
                                    "media_type": d["MediaType"],
                                    "health": d["HealthStatus"],
                                    "size": d["Size"],
                                    "model": d["Model"],
                                    "serial": d["SerialNumber"],
                                    "bus": d["BusType"],
                                    "firmware": d["FirmwareVersion"],
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                return JsonResult::ok(serde_json::json!(norm));
            }
        }
        JsonResult::ok(serde_json::json!([]))
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
pub(crate) fn parse_system_profiler_disks(s: &str) -> Vec<serde_json::Value> {
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
pub(crate) fn get_memory_info() -> JsonResult {
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
pub(crate) fn get_process_memory() -> JsonResult {
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
pub(crate) fn get_app_version() -> JsonResult {
    JsonResult::ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "name": "DiskRaptor",
    }))
}

#[tauri::command]
pub(crate) fn get_app_data_dir() -> JsonResult {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor");
    JsonResult::ok(serde_json::json!({
        "path": dir.to_string_lossy(),
    }))
}

#[tauri::command]
pub(crate) fn get_app_info() -> JsonResult {
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
pub(crate) fn request_permissions() -> JsonResult {
    let permissions = if cfg!(target_os = "macos") { "granted" } else { "not_needed" };
    JsonResult::ok(serde_json::json!({"permissions": permissions}))
}

#[tauri::command]
pub(crate) fn is_sandboxed() -> JsonResult {
    JsonResult::ok(serde_json::json!({ "sandboxed": in_mac_sandbox() }))
}

#[tauri::command]
#[cfg(not(feature = "store"))]
pub(crate) fn check_admin_needed(_path: String) -> JsonResult {
    JsonResult::ok(serde_json::json!(false))
}

#[tauri::command]
#[cfg(not(feature = "store"))]
pub(crate) fn restart_as_admin() -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        use windows::core::{PCWSTR, w};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        if let Ok(exe) = std::env::current_exe() {
            let exe_str = exe.to_string_lossy().to_string();
            let wide: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                ShellExecuteW(
                    None,
                    w!("runas"),
                    PCWSTR(wide.as_ptr()),
                    None,
                    None,
                    SW_SHOWNORMAL.0 as i32,
                );
            }
            std::process::exit(0);
        }
    }
    JsonResult::err("Not supported on this platform")
}

#[tauri::command]
#[cfg(feature = "store")]
pub(crate) fn check_admin_needed(_path: String) -> JsonResult {
    JsonResult::ok(serde_json::json!(false))
}

#[tauri::command]
#[cfg(feature = "store")]
pub(crate) fn restart_as_admin() -> JsonResult {
    JsonResult::err("Admin elevation is not available in the Store build")
}

#[tauri::command]
pub(crate) async fn check_for_updates() -> JsonResult {
    // Query the GitHub releases API for the latest tag and compare with the
    // installed version. Pure Rust (ureq) â€” no curl subprocess. Async so a slow
    // network call never blocks the UI.
    let installed = env!("CARGO_PKG_VERSION");
    // Sandboxed Store builds cannot do the network call; report no update
    // available (updates are distributed via the store itself).
    if cfg!(target_os = "macos") && in_mac_sandbox() {
        return JsonResult::ok(serde_json::json!({
            "version": installed,
            "latest": null,
            "update_available": false,
        }));
    }
    let result = tauri::async_runtime::spawn_blocking(|| {
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(5))
            .build();
        // One retry for transient network failures.
        for attempt in 0..2 {
            let resp = agent
                .get("https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest")
                .set("User-Agent", "DiskRaptor")
                .call();
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            let resp = match resp {
                Ok(r) => r,
                Err(_) if attempt == 0 => continue,
                Err(_) => return None,
            };
            let body = resp.into_string().ok()?;
            let v: serde_json::Value = serde_json::from_str(&body).ok()?;
            let tag = v.get("tag_name").and_then(|t| t.as_str())?;
            return Some(tag.trim_start_matches('v').to_string());
        }
        None
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
