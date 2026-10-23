//! System-facing commands: drives, volumes, memory, app info, permissions,
//! update checks and disk enumeration. Also hosts the shared shell helpers
//! (`silent_command`, `run_output`, `win_powershell`, `in_mac_sandbox`) that
//! sibling modules (smart, trash) use.
use crate::cmds::path_ops::validate_system_path;
use crate::JsonResult;
#[cfg(target_os = "windows")]
use crate::trash;
use crate::scanner::tree::format_size;

/// Recursively calculate directory size.
pub(crate) fn dir_size(path: &std::path::Path) -> u64 {
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
pub(crate) fn win_powershell(script: &str) -> Option<String> {
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
pub(crate) async fn list_disks() -> JsonResult {
    // Probing \\.\PHYSICALDRIVE0..31, spawning smartctl/system_profiler or
    // invoking PowerShell takes seconds — never block the main thread.
    tauri::async_runtime::spawn_blocking(|| {
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
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Disk enumeration failed: {e}")))
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
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), false);
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

/// Enumerate installed applications with their icons and install sizes.
/// Cross-platform: Windows (registry), macOS (/Applications), Linux (.desktop files).
#[tauri::command]
pub(crate) async fn list_installed_apps() -> JsonResult {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            use std::collections::HashMap;
            use winreg::enums::*;
            use winreg::RegKey;

            let mut apps = Vec::new();
            let mut seen = HashMap::new();

            // Helper to process a registry key for uninstall entries
            let process_uninstall_key = |root: RegKey, hive: &str, path: &str, apps: &mut Vec<serde_json::Value>, seen: &mut HashMap<String, serde_json::Value>| {
                if let Ok(key) = root.open_subkey(path) {
                    for subkey_name in key.enum_keys().flatten() {
                        if let Ok(subkey) = key.open_subkey(&subkey_name) {
                            let name: String = subkey.get_value("DisplayName").unwrap_or_default();
                            if name.is_empty() { continue; }
                            let system_component: u32 = subkey.get_value("SystemComponent").unwrap_or(0);
                            if system_component == 1 { continue; } // Skip system components
                            let is_update: u32 = subkey.get_value("IsUpdate").unwrap_or(0);
                            if is_update == 1 { continue; }

                            let install_location: String = subkey.get_value("InstallLocation").unwrap_or_default();
                            let display_icon: String = subkey.get_value("DisplayIcon").unwrap_or_default();
                            let uninstall_string: String = subkey.get_value("UninstallString").unwrap_or_default();
                            let quiet_uninstall: String = subkey.get_value("QuietUninstallString").unwrap_or_default();
                            let version: String = subkey.get_value("DisplayVersion").unwrap_or_default();
                            let publisher: String = subkey.get_value("Publisher").unwrap_or_default();
                            let estimated_size: u32 = subkey.get_value("EstimatedSize").unwrap_or(0); // In KB
                            let install_date: String = subkey.get_value("InstallDate").unwrap_or_default();

                            // Calculate install size from InstallLocation if EstimatedSize not available
                            let mut install_size = (estimated_size as u64) * 1024;
                            if install_size == 0 && !install_location.is_empty() {
                                install_size = crate::cmds::system::dir_size(&std::path::PathBuf::from(&install_location));
                            }

                            // Try to get icon from DisplayIcon or exe in InstallLocation
                            let icon_path = if !display_icon.is_empty() {
                                display_icon
                            } else if !install_location.is_empty() {
                                // Find first .exe in install location
                                let mut found_exe = String::new();
                                if let Ok(rd) = std::fs::read_dir(&install_location) {
                                    for entry in rd.flatten() {
                                        let p = entry.path();
                                        if p.extension().and_then(|s| s.to_str()).unwrap_or("").eq_ignore_ascii_case("exe") {
                                            found_exe = p.to_string_lossy().to_string();
                                            break;
                                        }
                                    }
                                }
                                found_exe
                            } else {
                                String::new()
                            };

                            let key_name = name.to_lowercase();
                            if let Some(existing) = seen.get(&key_name) {
                                let existing_size =
                                    existing["install_size"].as_u64().unwrap_or(0);
                                if existing_size >= install_size {
                                    continue; // Keep the larger entry
                                }
                            }

                            let app_json = serde_json::json!({
                                "name": name,
                                "version": version,
                                "publisher": publisher,
                                "install_location": install_location,
                                "uninstall_string": uninstall_string,
                                "quiet_uninstall": quiet_uninstall,
                                "icon_path": icon_path,
                                "install_size": install_size,
                                "install_date": install_date,
                                "estimated_size_kb": estimated_size,
                                // Exact location lets the uninstaller verify that
                                // *this* entry is gone instead of matching names
                                // (two products can share a DisplayName).
                                "registry_key": format!("{hive}\\{path}\\{subkey_name}"),
                            });
                            apps.push(app_json.clone());
                            seen.insert(key_name, app_json);
                        }
                    }
                }
            };

            // 32-bit and 64-bit registry views
            let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
            process_uninstall_key(hklm, "HKLM", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", &mut apps, &mut seen);
            let hklm2 = RegKey::predef(HKEY_LOCAL_MACHINE);
            process_uninstall_key(hklm2, "HKLM", r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall", &mut apps, &mut seen);
            let hkcu = RegKey::predef(HKEY_CURRENT_USER);
            process_uninstall_key(hkcu, "HKCU", r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", &mut apps, &mut seen);

            // Also check Windows Store apps. The protocol registrations are a
            // convenient list, but stale keys survive an uninstall, so only keep
            // packages that still exist in the AppModel repository.
            let hkcu2 = RegKey::predef(HKEY_CURRENT_USER);
            let installed_store: Vec<String> = match hkcu2.open_subkey(
                r"SOFTWARE\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages",
            ) {
                Ok(key) => key.enum_keys().flatten().collect(),
                Err(_) => Vec::new(),
            };
            if let Ok(key) = hkcu2.open_subkey(r"SOFTWARE\Classes\Extensions\ContractId\Windows.Protocol\PackageId") {
                for pkg in key.enum_keys().flatten() {
                    let name = pkg.split('_').next().unwrap_or(&pkg).to_string();
                    let version = pkg.split('_').nth(1).unwrap_or("").to_string();
                    if !name.is_empty() && !seen.contains_key(&name.to_lowercase()) {
                        if !installed_store.is_empty() {
                            let prefix = format!("{name}_");
                            if !installed_store.iter().any(|p| p.starts_with(&prefix)) {
                                continue;
                            }
                        }
                        let app_json = serde_json::json!({
                            "name": name,
                            "version": version,
                            "publisher": "Microsoft Store",
                            "install_location": "",
                            "uninstall_string": "",
                            "quiet_uninstall": "",
                            "icon_path": "",
                            "install_size": 0,
                            "install_date": "",
                            "estimated_size_kb": 0,
                            "is_store_app": true,
                        });
                        apps.push(app_json.clone());
                        seen.insert(name.to_lowercase(), app_json);
                    }
                }
            }

            apps.sort_by(|a, b| {
                let an = a["name"].as_str().unwrap_or("");
                let bn = b["name"].as_str().unwrap_or("");
                an.to_lowercase().cmp(&bn.to_lowercase())
            });

            JsonResult::ok(serde_json::json!(apps))
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            match crate::cmds::apps::platform_list_apps() {
                Ok(apps) => JsonResult::ok(serde_json::json!(apps)),
                Err(error) => JsonResult::err(error),
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            JsonResult::err("Unsupported platform")
        }
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Failed to list apps: {e}")))
}

/// Check installed applications for available updates.
///
/// Windows: uses `winget list --upgrade-available` (the same package data the
/// OS uses). macOS: Homebrew plus `mas` when installed. Linux: the native
/// package manager (apt/dnf/zypper/pacman) plus flatpak and snap. Returns
/// `{ supported, updates: [{name, id, version, available, source}], error? }`.
#[tauri::command]
pub(crate) async fn check_app_updates() -> JsonResult {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let output = std::process::Command::new("winget")
                .args([
                    "list",
                    "--upgrade-available",
                    "--include-unknown",
                    "--accept-source-agreements",
                    "--disable-interactivity",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            match output {
                Ok(o) => {
                    let text = String::from_utf8_lossy(&o.stdout).to_string();
                    let updates = parse_winget_upgrades(&text);
                    // winget exits non-zero when it has nothing to report on
                    // older versions; treat a parseable table as success.
                    if !updates.is_empty() || text.contains("---") {
                        JsonResult::ok(serde_json::json!({
                            "supported": true,
                            "updates": updates,
                        }))
                    } else {
                        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        JsonResult::ok(serde_json::json!({
                            "supported": false,
                            "error": if err.is_empty() { "winget returned no data".to_string() } else { err },
                            "updates": [],
                        }))
                    }
                }
                Err(e) => JsonResult::ok(serde_json::json!({
                    "supported": false,
                    "error": format!("winget is not available: {e}"),
                    "updates": [],
                })),
            }
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            JsonResult::ok(crate::cmds::apps::platform_check_updates())
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            JsonResult::ok(serde_json::json!({
                "supported": false,
                "error": "Unsupported platform",
                "updates": [],
            }))
        }
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Update check failed: {e}")))
}

/// Parse the table printed by `winget list --upgrade-available`.
///
/// Columns are located from the header line (Name / Id / Version / Available /
/// Source); the dashed separator line below it is the anchor. Long names may
/// wrap onto a continuation line with an empty Id column, which is appended to
/// the previous entry.
#[cfg(target_os = "windows")]
fn parse_winget_upgrades(text: &str) -> Vec<serde_json::Value> {
    let lines: Vec<&str> = text.lines().collect();
    let sep = lines.iter().position(|line| {
        let t = line.trim();
        t.len() >= 20 && t.chars().all(|c| c == '-')
    });
    let Some(sep) = sep else { return Vec::new() };
    if sep == 0 {
        return Vec::new();
    }

    // Column start offsets: beginning of the line or after a run of 2+ spaces.
    let header: Vec<char> = lines[sep - 1].chars().collect();
    let mut starts: Vec<usize> = Vec::new();
    let mut in_word = false;
    let mut spaces = 0usize;
    for (idx, ch) in header.iter().enumerate() {
        if *ch == ' ' {
            spaces += 1;
            in_word = false;
        } else {
            if !in_word && (idx == 0 || spaces >= 2) {
                starts.push(idx);
            }
            in_word = true;
            spaces = 0;
        }
    }
    if starts.len() < 4 {
        return Vec::new();
    }

    let mut updates: Vec<serde_json::Value> = Vec::new();
    for line in lines.iter().skip(sep + 1) {
        if line.trim().is_empty() {
            continue;
        }
        let chars: Vec<char> = line.chars().collect();
        let field = |k: usize| -> String {
            let s = starts[k];
            let e = starts.get(k + 1).copied().unwrap_or(chars.len());
            if s >= chars.len() {
                return String::new();
            }
            chars[s..e.min(chars.len())]
                .iter()
                .collect::<String>()
                .trim()
                .to_string()
        };
        let name = field(0);
        let id = field(1);
        let version = field(2);
        let available = field(3);
        let source = field(4);

        if id.is_empty() {
            // Wrapped name: append to the previous entry.
            if !name.is_empty() {
                if let Some(last) = updates.last_mut() {
                    let old = last["name"].as_str().unwrap_or("").to_string();
                    last["name"] = serde_json::Value::String(format!("{old} {name}"));
                }
            }
            continue;
        }
        if name.is_empty() {
            continue;
        }
        updates.push(serde_json::json!({
            "name": name,
            "id": id,
            "version": version,
            "available": available,
            "source": source,
        }));
    }
    updates
}

/// Upgrade a single application via the platform package manager.
///
/// Windows: `winget upgrade --id <id> --exact --silent`. macOS/Linux: Homebrew,
/// mas, apt, dnf, zypper, pacman, flatpak or snap depending on the source.
/// Returns `{ success, output? }`; failures reject the IPC call so the UI can
/// report them.
#[tauri::command]
pub(crate) async fn run_app_update(id: String, source: String) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut cmd = std::process::Command::new("winget");
            cmd.args([
                "upgrade",
                "--id",
                &id,
                "--exact",
                "--silent",
                "--include-unknown",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--disable-interactivity",
            ]);
            let src = source.trim();
            if !src.is_empty() {
                cmd.args(["--source", src]);
            }
            cmd.creation_flags(CREATE_NO_WINDOW);
            match cmd.output() {
                Ok(o) => {
                    let stdout = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                    // winget reports "no applicable update" as a failure exit
                    // code; for our purposes the package is already current.
                    let no_update = stdout.to_lowercase().contains("no applicable update")
                        || stdout.to_lowercase().contains("no available upgrade")
                        || stdout.to_lowercase().contains("no newer package versions");
                    if o.status.success() || no_update {
                        JsonResult::ok(serde_json::json!({
                            "success": true,
                            "output": stdout,
                        }))
                    } else {
                        JsonResult::ok(serde_json::json!({
                            "success": false,
                            "code": o.status.code(),
                            "output": stdout,
                            "error": if stderr.is_empty() { stdout } else { stderr },
                        }))
                    }
                }
                Err(e) => JsonResult::ok(serde_json::json!({
                    "success": false,
                    "error": format!("winget is not available: {e}"),
                })),
            }
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            match crate::cmds::apps::platform_run_update(&id, &source) {
                Ok(data) => JsonResult::ok(data),
                Err(error) => JsonResult::err(error),
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = (id, source);
            JsonResult::ok(serde_json::json!({
                "success": false,
                "error": "Unsupported platform",
            }))
        }
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Update failed: {e}")))
}

#[cfg(target_os = "windows")]
fn win_hidden(cmd: &str, args: &[&str]) -> std::io::Result<std::process::ExitStatus> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(cmd)
        .creation_flags(CREATE_NO_WINDOW)
        .args(args)
        .status()
}

/// Run PowerShell hidden and capture stdout. Errors include stderr so the UI
/// can show why an uninstall was rejected instead of silently doing nothing.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .output()
        .map_err(|e| format!("PowerShell failed to start: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // PowerShell adds multi-line position/category noise; the first line
        // carries the actual reason and fits the status bar/toast.
        let first_line = stderr
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        Err(if first_line.is_empty() {
            format!("PowerShell exit code {:?}", out.status.code())
        } else {
            first_line
        })
    }
}

#[cfg(target_os = "windows")]
fn ps_single_quote(value: &str) -> String {
    value.replace('\'', "''")
}

/// Extract the `{GUID}` from an MsiExec UninstallString.
#[cfg(target_os = "windows")]
fn msiexec_guid(command: &str) -> Option<String> {
    let start = command.find('{')?;
    let rest = &command[start..];
    let end = rest.find('}')?;
    let candidate = &rest[..=end];
    if candidate.len() == 38 && candidate.chars().filter(|c| *c == '-').count() == 4 {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// True while the entry is still present. The exact registry key from the list
/// is preferred: two products can share a DisplayName, and matching by name
/// would then report a false failure after a successful uninstall.
#[cfg(target_os = "windows")]
fn uninstall_entry_exists(registry_key: Option<&str>, name: &str) -> bool {
    use winreg::enums::*;
    use winreg::RegKey;
    if let Some(key_path) = registry_key.filter(|key| !key.is_empty()) {
        if let Some((hive, path)) = key_path.split_once('\\') {
            let root = match hive {
                "HKLM" => RegKey::predef(HKEY_LOCAL_MACHINE),
                "HKCU" => RegKey::predef(HKEY_CURRENT_USER),
                _ => return uninstall_entry_exists(None, name),
            };
            return root.open_subkey(path).is_ok();
        }
    }
    let target = name.to_lowercase();
    let roots = [
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            RegKey::predef(HKEY_LOCAL_MACHINE),
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
        (
            RegKey::predef(HKEY_CURRENT_USER),
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        ),
    ];
    for (root, path) in roots {
        if let Ok(key) = root.open_subkey(path) {
            for subkey_name in key.enum_keys().flatten() {
                if let Ok(subkey) = key.open_subkey(&subkey_name) {
                    let display: String = subkey.get_value("DisplayName").unwrap_or_default();
                    if display.to_lowercase() == target {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Fast installed check via the per-user AppModel package repository. Falls
/// back to PowerShell when the repository key is unavailable.
#[cfg(target_os = "windows")]
fn store_package_in_repository(name: &str) -> Option<bool> {
    use winreg::enums::*;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(
            r"SOFTWARE\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages",
        )
        .ok()?;
    let prefix = format!("{name}_");
    Some(key.enum_keys().flatten().any(|pkg| pkg.starts_with(&prefix)))
}

#[cfg(target_os = "windows")]
fn store_app_installed(name: &str) -> bool {
    if let Some(installed) = store_package_in_repository(name) {
        return installed;
    }
    let script = format!(
        "if (Get-AppxPackage -Name '{}' -ErrorAction SilentlyContinue) {{ 'yes' }} else {{ 'no' }}",
        ps_single_quote(name)
    );
    matches!(run_powershell(&script), Ok(out) if out.eq_ignore_ascii_case("yes"))
}

/// Store apps are MSIX packages; Remove-AppxPackage removes them per user and
/// needs no elevation for normally installed Store apps.
#[cfg(target_os = "windows")]
fn uninstall_store_app(name: &str) -> Result<(), String> {
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $pkgs = Get-AppxPackage -Name '{}' -ErrorAction SilentlyContinue; \
         if (-not $pkgs) {{ throw 'Store app is not installed' }}; \
         $pkgs | ForEach-Object {{ Remove-AppxPackage -Package $_.PackageFullName }}",
        ps_single_quote(name)
    );
    run_powershell(&script).map(|_| ())
}

/// Windows Installer treats 3010/1641 as "removed successfully, reboot
/// pending". They must not be mistaken for failures.
#[cfg(target_os = "windows")]
fn msi_success(code: Option<i32>) -> bool {
    matches!(code, Some(0) | Some(3010) | Some(1641))
}

/// MSI: attempt a silent per-user removal first, then retry elevated for
/// per-machine packages. Without the retry every HKLM app would fail silently.
#[cfg(target_os = "windows")]
fn uninstall_msi(guid: &str) -> Result<(), String> {
    if let Ok(status) = win_hidden("msiexec.exe", &["/x", guid, "/qn", "/norestart"]) {
        if msi_success(status.code()) {
            return Ok(());
        }
    }
    let script = format!(
        "$p = Start-Process -FilePath 'msiexec.exe' \
         -ArgumentList '/x {} /qn /norestart' -Verb RunAs -Wait -PassThru; \
         if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010 -or $p.ExitCode -eq 1641) {{ exit 0 }}; \
         exit $p.ExitCode",
        guid
    );
    run_powershell(&script).map(|_| ())
}

/// Split `"C:\path\app.exe" /arg` into the executable and its arguments.
#[cfg(target_os = "windows")]
fn split_uninstall_command(command: &str) -> Option<(String, String)> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(stripped) = trimmed.strip_prefix('"') {
        let end = stripped.find('"')?;
        Some((
            stripped[..end].to_string(),
            stripped[end + 1..].trim().to_string(),
        ))
    } else {
        let end = trimmed
            .find(char::is_whitespace)
            .unwrap_or(trimmed.len());
        Some((trimmed[..end].to_string(), trimmed[end..].trim().to_string()))
    }
}

#[cfg(target_os = "windows")]
fn contains_ascii(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|part| part == needle)
}

#[cfg(target_os = "windows")]
fn contains_utf16(haystack: &[u8], needle: &str) -> bool {
    let encoded: Vec<u8> = needle
        .encode_utf16()
        .flat_map(|unit| unit.to_le_bytes())
        .collect();
    contains_ascii(haystack, &encoded)
}

#[cfg(target_os = "windows")]
fn read_file_prefix(path: &str, limit: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut data = Vec::new();
    file.take(limit).read_to_end(&mut data).ok()?;
    Some(data)
}

/// NsisMultiUser keeps the install directory in an unsuffixed key
/// (`...\Uninstall\App`) while the per-user uninstall entry lives under
/// `...\Uninstall\App (current user)`. Some installers fail to write the
/// base key; the uninstaller then reports "no installation" and exits 0
/// without removing anything. Repair that metadata before launching it.
#[cfg(target_os = "windows")]
fn repair_nsis_current_user_install_key(registry_key: &str, command: &str) {
    use winreg::enums::*;
    use winreg::RegKey;

    let Some((hive, path)) = registry_key.split_once('\\') else {
        return;
    };
    if !hive.eq_ignore_ascii_case("HKCU") {
        return;
    }
    let Some(base_path) = path.strip_suffix(" (current user)") else {
        return;
    };
    if base_path.is_empty() || !base_path.to_ascii_lowercase().contains("\\uninstall\\") {
        return;
    }
    let Some((exe, _)) = split_uninstall_command(command) else {
        return;
    };
    // The NSIS signature is in the PE manifest near the start. Avoid reading
    // large installers in full just to identify the framework.
    let Some(data) = read_file_prefix(&exe, 1024 * 1024) else {
        return;
    };
    if !contains_ascii(&data, b"Nullsoft Install System") && !contains_ascii(&data, b"NSIS") {
        return;
    }
    let Some(dir) = std::path::Path::new(&exe).parent() else {
        return;
    };
    let dir = dir.to_string_lossy().trim_end_matches('\\').to_string();
    if dir.is_empty() {
        return;
    }
    let root = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((key, _)) = root.create_subkey(base_path) else {
        return;
    };
    let existing: String = key.get_value("InstallLocation").unwrap_or_default();
    if existing.trim().is_empty() {
        let _ = key.set_value("InstallLocation", &dir);
    }
}

/// Many uninstallers only remove anything in their quiet mode. The registry
/// often has no QuietUninstallString (DBeaver is one example), so detect the
/// common installer frameworks from the uninstaller binary and add the flag.
#[cfg(target_os = "windows")]
fn add_silent_switch(command: &str) -> String {
    let lower = command.to_ascii_lowercase();
    let already_quiet = lower.split_whitespace().any(|arg| {
        matches!(
            arg,
            "/s" | "/silent" | "/verysilent" | "/quiet" | "-q" | "--silent"
        )
    });
    if already_quiet {
        return command.to_string();
    }
    let Some((exe, _args)) = split_uninstall_command(command) else {
        return command.to_string();
    };
    let Ok(data) = std::fs::read(&exe) else {
        return command.to_string();
    };
    if contains_ascii(&data, b"Nullsoft Install System") || contains_ascii(&data, b"NSIS") {
        return format!("{command} /S");
    }
    if contains_ascii(&data, b"Inno Setup") || contains_utf16(&data, "Inno Setup") {
        return format!("{command} /VERYSILENT /SUPPRESSMSGBOXES /NORESTART");
    }
    if contains_ascii(&data, b"install4j") || contains_utf16(&data, "install4j") {
        return format!("{command} -q");
    }
    command.to_string()
}

#[cfg(target_os = "windows")]
fn uninstall_command(command: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let command = add_silent_switch(command);
    // raw_arg is required here: std quoting would turn `"C:\...\app.exe" /S`
    // into a string cmd.exe cannot resolve.
    match std::process::Command::new("cmd.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .raw_arg(format!("/C {command}"))
        .status()
    {
        Ok(status) if status.success() || msi_success(status.code()) => Ok(()),
        Ok(status) => Err(format!("Uninstaller exited with code {:?}", status.code())),
        Err(e) => Err(format!("Failed to execute uninstaller: {e}")),
    }
}

/// Run only the uninstaller elevated, so the rest of DiskRaptor keeps its
/// state. Windows shows the normal UAC prompt.
#[cfg(target_os = "windows")]
fn uninstall_command_elevated(command: &str) -> Result<(), String> {
    let command = add_silent_switch(command);
    let Some((exe, args)) = split_uninstall_command(&command) else {
        return Err("Could not parse the uninstall command.".to_string());
    };
    if !std::path::Path::new(&exe).is_file() {
        return Err(format!("Uninstaller not found: {exe}"));
    }
    let arguments = if args.is_empty() {
        String::new()
    } else {
        format!(" -ArgumentList '{}'", ps_single_quote(&args))
    };
    let script = format!(
        "$p = Start-Process -FilePath '{}'{} -Verb RunAs -Wait -PassThru; \
         if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010 -or $p.ExitCode -eq 1641) {{ exit 0 }}; \
         exit $p.ExitCode",
        ps_single_quote(&exe),
        arguments
    );
    run_powershell(&script).map(|_| ())
}

/// Uninstall an app and verify that it actually disappeared. Store apps use
/// Remove-AppxPackage, MSI entries are run silently (elevated when required),
/// and everything else uses QuietUninstallString/UninstallString.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn uninstall_app(
    name: String,
    uninstall_string: String,
    quiet_uninstall: String,
    is_store_app: bool,
    registry_key: String,
    run_as_admin: bool,
    install_location: Option<String>,
    package_id: Option<String>,
    package_source: Option<String>,
) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let _ = (install_location, package_id, package_source);
            let command = if quiet_uninstall.trim().is_empty() {
                uninstall_string.trim().to_string()
            } else {
                quiet_uninstall.trim().to_string()
            };
            let command = add_silent_switch(&command);
            let store = is_store_app || (command.is_empty() && store_app_installed(&name));
            if !store && !command.is_empty() {
                repair_nsis_current_user_install_key(&registry_key, &command);
            }

            // Do not fail on a non-zero exit code up front: MSI and several
            // EXE uninstallers return non-zero (or 3010) after a successful
            // removal. The registry/package check below is the source of truth.
            let mut run_error: Option<String> = None;
            if store {
                if let Err(e) = uninstall_store_app(&name) {
                    run_error = Some(e);
                }
            } else if command.is_empty() {
                return JsonResult::err("No uninstall command is available for this app.");
            } else if command.to_lowercase().contains("msiexec") {
                match msiexec_guid(&command) {
                    Some(guid) => {
                        if let Err(e) = uninstall_msi(&guid) {
                            run_error = Some(e);
                        }
                    }
                    None => {
                        let result = if run_as_admin {
                            uninstall_command_elevated(&command)
                        } else {
                            uninstall_command(&command)
                        };
                        if let Err(e) = result {
                            run_error = Some(e);
                        }
                    }
                }
            } else {
                let result = if run_as_admin {
                    uninstall_command_elevated(&command)
                } else {
                    uninstall_command(&command)
                };
                if let Err(e) = result {
                    run_error = Some(e);
                }
            }

            // Exit code 0 is not proof: some uninstallers spawn a child and
            // return immediately. Wait until the exact entry/package is gone.
            let exact_key = if registry_key.is_empty() {
                None
            } else {
                Some(registry_key.as_str())
            };
            for attempt in 0..40 {
                if attempt > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
                let still_there = if store {
                    store_app_installed(&name)
                } else {
                    uninstall_entry_exists(exact_key, &name)
                };
                if !still_there {
                    return JsonResult::ok(serde_json::json!({ "success": true }));
                }
            }
            let detail = run_error
                .map(|error| format!(" ({error})"))
                .unwrap_or_default();
            JsonResult::err(format!(
                "Uninstaller finished, but the app is still installed{detail}. It may require administrator rights or user interaction."
            ))
        }
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let _ = (is_store_app, registry_key, run_as_admin);
            let location = install_location.unwrap_or_default();
            let package = package_id.unwrap_or_default();
            let source = package_source.unwrap_or_default();
            match crate::cmds::apps::platform_uninstall(
                &name,
                &location,
                &package,
                &source,
                &uninstall_string,
                &quiet_uninstall,
            ) {
                Ok(()) => JsonResult::ok(serde_json::json!({ "success": true })),
                Err(error) => JsonResult::err(error),
            }
        }

        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = (
                &name,
                &uninstall_string,
                &quiet_uninstall,
                is_store_app,
                &registry_key,
                run_as_admin,
            );
            JsonResult::err("Unsupported platform")
        }
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Uninstall failed: {e}")))
}

/// Download a Windows installer from our own GitHub release and launch it,
/// then exit so locked files can be replaced. Only our release URLs are
/// accepted. Other platforms report unsupported (frontend opens the URL).
#[tauri::command]
pub(crate) fn install_update(url: String, app: tauri::AppHandle) -> JsonResult {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (url, app);
        JsonResult::err("Automatic install is only supported on Windows")
    }
    #[cfg(target_os = "windows")]
    {
        let url = url.trim().to_string();
        let prefix = "https://github.com/SunMe1977/DiskRaptor/releases/download/";
        if !url.starts_with(prefix) || url.contains("..") || url.contains(' ') {
            return JsonResult::err("Refusing unknown update URL");
        }
        let file_name = url
            .rsplit('/')
            .next()
            .unwrap_or("DiskRaptor-setup.exe")
            .to_string();
        if !(file_name.ends_with(".exe") || file_name.ends_with(".msi")) {
            return JsonResult::err("Refusing non-installer update file");
        }
        std::thread::spawn(move || {
            // Download first (blocking, generous timeout for big installers).
            let config = ureq::Agent::config_builder()
                .timeout_global(Some(std::time::Duration::from_secs(300)))
                .build();
            let agent = ureq::Agent::new_with_config(config);
            let mut tmp = std::env::temp_dir();
            tmp.push(format!("diskraptor-update-{file_name}"));
            let download_ok = agent
                .get(&url)
                .header("User-Agent", "DiskRaptor")
                .call()
                .ok()
                .and_then(|mut r| r.body_mut().read_to_vec().ok())
                .and_then(|bytes| {
                    if bytes.is_empty() {
                        None
                    } else {
                        std::fs::write(&tmp, &bytes).ok()
                    }
                })
                .is_some();
            if !download_ok {
                return;
            }
            // Launch detached so it survives our exit, then quit to unlock files.
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x00000008;
            let _ = std::process::Command::new(&tmp)
                .creation_flags(DETACHED_PROCESS)
                .spawn();
            std::thread::sleep(std::time::Duration::from_millis(1500));
            app.exit(0);
        });
        JsonResult::ok(serde_json::json!({ "started": true }))
    }
}

#[tauri::command]
pub(crate) fn request_permissions(path: Option<String>) -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        // macOS asks once per protected folder (Desktop/Documents/Downloads).
        // Touching each folder now triggers any pending consent prompt up-front,
        // so the scan itself doesn't stall mid-way on a dialog while its worker
        // threads block. Only probe folders that actually lie under the scan
        // root to avoid prompting for folders the user never asked to scan.
        if let Some(root) = path {
            let root_path = std::path::PathBuf::from(root);
            let mut protected = Vec::new();
            if let Some(home) = dirs::home_dir() {
                for sub in ["Desktop", "Documents", "Downloads"] {
                    let p = home.join(sub);
                    if p.starts_with(&root_path) || root_path.starts_with(&p) {
                        protected.push(p);
                    }
                }
            }
            if !protected.is_empty() {
                // Spawn so the IPC call returns instantly; the prompts appear
                // as soon as the system processes the accesses.
                std::thread::spawn(move || {
                    for d in protected {
                        let _ = std::fs::read_dir(&d);
                    }
                });
                return JsonResult::ok(serde_json::json!({"permissions": "requested"}));
            }
        }
        JsonResult::ok(serde_json::json!({"permissions": "granted"}))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        JsonResult::ok(serde_json::json!({"permissions": "not_needed"}))
    }
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
pub(crate) fn restart_as_admin(_device_id: String) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        use windows::core::{PCWSTR, w};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        if let Ok(exe) = std::env::current_exe() {
            let exe_str = exe.to_string_lossy().to_string();
            let wide: Vec<u16> = exe_str.encode_utf16().chain(std::iter::once(0)).collect();
            // Pass the drive so the relaunched (elevated) instance re-opens the
            // S.M.A.R.T. tool and scans the same disk automatically.
            let params = format!("--smart-scan {}", _device_id.trim());
            let wide_params: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
            unsafe {
                ShellExecuteW(
                    None,
                    w!("runas"),
                    PCWSTR(wide.as_ptr()),
                    PCWSTR(wide_params.as_ptr()),
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
pub(crate) fn restart_as_admin(_device_id: String) -> JsonResult {
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
        // ureq 3.x API: Agent built from a Config (AgentBuilder was removed).
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(std::time::Duration::from_secs(5)))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        // One retry for transient network failures.
        for attempt in 0..2 {
            let resp = agent
                .get("https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest")
                .header("User-Agent", "DiskRaptor")
                .call();
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            let mut resp = match resp {
                Ok(r) => r,
                Err(_) if attempt == 0 => continue,
                Err(_) => return None,
            };
            let body = resp.body_mut().read_to_string().ok()?;
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use winreg::enums::*;
    use winreg::RegKey;

    #[test]
    fn repairs_missing_nsis_current_user_install_key() {
        // Any NSIS binary works for the framework check.
        let nsis = r"C:\Program Files (x86)\NSIS\Bin\makensis.exe";
        if !std::path::Path::new(nsis).is_file() {
            return;
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis();
        let suffix = format!("DiskRaptorTest-{}-{stamp}", std::process::id());
        let base_rel =
            format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{suffix}");
        let user_rel = format!("{base_rel} (current user)");

        let root = RegKey::predef(HKEY_CURRENT_USER);
        let _ = root.delete_subkey_all(&base_rel);
        let _ = root.delete_subkey_all(&user_rel);
        let (user_key, _) = root.create_subkey(&user_rel).expect("create test key");
        user_key
            .set_value("DisplayName", &suffix)
            .expect("display name");
        user_key
            .set_value("UninstallString", &format!("\"{nsis}\" /currentuser"))
            .expect("uninstall string");

        let registry_key = format!("HKCU\\{user_rel}");
        let command = format!("\"{nsis}\" /currentuser");
        repair_nsis_current_user_install_key(&registry_key, &command);

        let base_key = root.open_subkey(&base_rel).expect("repaired base key");
        let location: String = base_key.get_value("InstallLocation").expect("location");
        assert_eq!(location, r"C:\Program Files (x86)\NSIS\Bin");

        let _ = root.delete_subkey_all(&base_rel);
        let _ = root.delete_subkey_all(&user_rel);
    }
}
