//! Trash listing / empty / restore commands.

use crate::JsonResult;
#[cfg(target_os = "macos")]
use crate::in_mac_sandbox;

#[tauri::command]
pub fn empty_trash() -> JsonResult {
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
        // Native shell API — no `cmd` subprocess. Removes all of the user's
        // recycle bins (the flag combination suppresses confirm/progress/sound).
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{
            SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
        };
        let _ = unsafe {
            SHEmptyRecycleBinW(
                HWND::default(),
                PCWSTR::null(),
                SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
            )
        };
    }
    JsonResult::ok_empty()
}

#[tauri::command]
pub fn list_trash() -> JsonResult {
    let items = {
        #[cfg(target_os = "macos")] { list_trash_macos() }
        #[cfg(target_os = "linux")] { list_trash_linux() }
        #[cfg(target_os = "windows")] { list_trash_windows() }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))] { Vec::new() }
    };
    JsonResult::ok(serde_json::Value::Array(items))
}

#[cfg(target_os = "windows")]
fn list_trash_windows() -> Vec<serde_json::Value> {
    use std::collections::HashSet;

    // Only the CURRENT USER's recycle bin. `$Recycle.Bin` also holds the
    // SYSTEM account's bin (S-1-5-18) and 8.3 short-name aliases (S-1-5-~1) —
    // enumerating those surfaces access-denied errors for files the user can
    // never touch. SHGetKnownFolderPath returns exactly the user's own bin.
    let Some(bin) = current_user_recycle_bin() else {
        return Vec::new();
    };
    let mut items: Vec<serde_json::Value> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // Map "$I<name>" metadata files to their "$R<name>" payload.
    let mut i_entries: Vec<(std::path::PathBuf, IMetadata)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&bin) {
        for e in entries.flatten() {
            let p = e.path();
            let fname = e.file_name().to_string_lossy().to_string();
            if fname.starts_with("$I") {
                if let Some(meta) = parse_i_metadata(&p) {
                    i_entries.push((p, meta));
                }
            }
        }
    }
    for (i_path, meta) in i_entries {
        let i_name = i_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let suffix = &i_name[2..];
        let data = bin.join(format!("$R{}", suffix));
        let is_dir = data.is_dir();
        let size = std::fs::metadata(&data)
            .map(|m| if is_dir { 0 } else { m.len() })
            .unwrap_or(meta.original_size);
        let display_name = std::path::Path::new(&meta.original_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| i_name.clone());
        let path_str = data.to_string_lossy().to_string();
        if !seen.insert(path_str.clone()) {
            continue;
        }
        items.push(serde_json::json!({
            "name": display_name,
            "path": path_str,
            "size": size,
            "is_dir": is_dir,
            "deleted_at": meta.deleted_at,
            "original_path": meta.original_path,
        }));
    }
    // Orphaned data entries (no $I metadata) are invisible to the shell; still
    // list them so the user can reclaim the space.
    if let Ok(entries) = std::fs::read_dir(&bin) {
        for e in entries.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if !fname.starts_with("$R") {
                continue;
            }
            let path_str = e.path().to_string_lossy().to_string();
            if !seen.insert(path_str.clone()) {
                continue;
            }
            let is_dir = e.path().is_dir();
            let size = e.metadata().map(|m| if is_dir { 0 } else { m.len() }).unwrap_or(0);
            items.push(serde_json::json!({
                "name": fname,
                "path": path_str,
                "size": size,
                "is_dir": is_dir,
                "deleted_at": "",
                "original_path": "",
            }));
        }
    }
    items
}

/// The current user's recycle-bin directory (`C:\$Recycle.Bin\<sid>`) via the
/// native Known Folder API — no SID discovery or subprocess.
#[cfg(target_os = "windows")]
pub(crate) fn current_user_recycle_bin() -> Option<std::path::PathBuf> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{SHGetKnownFolderPath, FOLDERID_RecycleBinFolder};

    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_RecycleBinFolder, 0, HANDLE::default()) };
    let s = match path {
        Ok(p) => {
            let s = if p.is_null() { None } else { unsafe { p.to_string().ok() } };
            if !p.is_null() {
                unsafe {
                    CoTaskMemFree(p.0 as *const std::ffi::c_void);
                }
            }
            s
        }
        Err(_) => None,
    };
    s.map(std::path::PathBuf::from)
}

/// Decoded contents of a Windows `$I` recycle-bin metadata file.
#[cfg(target_os = "windows")]
struct IMetadata {
    original_size: u64,
    deleted_at: String,
    original_path: String,
}

/// Parse a `$I*` file: 8-byte header, 8-byte size, 8-byte FILETIME, then the
/// original path as UTF-16LE. Pure filesystem parsing — no PowerShell/COM.
#[cfg(target_os = "windows")]
fn parse_i_metadata(path: &std::path::Path) -> Option<IMetadata> {
    use std::io::Read;
    let mut data = Vec::new();
    std::fs::File::open(path).ok()?.read_to_end(&mut data).ok()?;
    if data.len() < 24 {
        return None;
    }
    let original_size = u64::from_le_bytes(data[8..16].try_into().ok()?);
    let filetime = u64::from_le_bytes(data[16..24].try_into().ok()?);
    // FILETIME: 100ns intervals since 1601-01-01 UTC.
    let unix_secs = filetime.saturating_sub(11_644_473_600_000_000_000) / 10_000_000;
    let mut wide = Vec::new();
    let mut i = 24;
    while i + 1 < data.len() {
        let code = u16::from_le_bytes([data[i], data[i + 1]]);
        if code == 0 {
            break;
        }
        wide.push(code);
        i += 2;
    }
    let original_path = String::from_utf16_lossy(&wide);
    Some(IMetadata {
        original_size,
        deleted_at: unix_secs_to_iso(unix_secs),
        original_path,
    })
}

/// Format a Unix timestamp as `YYYY-MM-DD HH:MM:SS` (UTC) using the
/// civil-from-days algorithm — no chrono dependency.
#[cfg(target_os = "windows")]
fn unix_secs_to_iso(unix_secs: u64) -> String {
    if unix_secs == 0 {
        return String::new();
    }
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let (h, m, s) = (secs_of_day / 3600, (secs_of_day % 3600) / 60, secs_of_day % 60);
    // Howard Hinnant's days_from_civil inverse.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mth <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mth, d, h, m, s)
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
pub fn restore_trash(trash_path: String) -> JsonResult {
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
