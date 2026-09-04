//! Trash listing / empty / restore commands.

use crate::JsonResult;
#[cfg(target_os = "macos")]
use crate::in_mac_sandbox;

#[tauri::command]
pub async fn empty_trash() -> JsonResult {
    // Shell/`gio`/`osascript` calls can block; run off the main thread.
    tauri::async_runtime::spawn_blocking(empty_trash_inner)
        .await
        .unwrap_or_else(|e| JsonResult::err(format!("Empty Trash failed: {e}")))
}

fn empty_trash_inner() -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            // In the sandbox we cannot drive Finder. Empty the user's own
            // trash container if we can read it; otherwise report clearly.
            if let Some(home) = dirs::home_dir() {
                let trash = home.join(".Trash");
                if let Ok(entries) = std::fs::read_dir(&trash) {
                    let mut removed_any = false;
                    let mut had_visible = false;
                    for entry in entries.flatten() {
                        let p = entry.path();
                        let name = entry.file_name();
                        if name.to_string_lossy().starts_with('.') { continue; }
                        had_visible = true;
                        let r = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
                        if r.is_ok() { removed_any = true; }
                    }
                    if had_visible && !removed_any {
                        return JsonResult::err("Failed to empty the Trash (items may be in use or locked).");
                    }
                    return JsonResult::ok_empty();
                }
            }
            return JsonResult::err("Empty Trash is unavailable in the sandboxed build.");
        }
        // Report Finder's actual result instead of claiming success blindly.
        match std::process::Command::new("osascript")
            .args(["-e", "tell app \"Finder\" to empty trash"])
            .status()
        {
            Ok(s) if s.success() => JsonResult::ok_empty(),
            Ok(_) => JsonResult::err("Finder could not empty the Trash."),
            Err(e) => JsonResult::err(format!("Could not ask Finder to empty the Trash: {e}")),
        }
    }
    #[cfg(target_os = "linux")]
    {
        let gio_ok = match std::process::Command::new("gio").args(["trash", "--empty"]).status() {
            Ok(s) => s.success(),
            Err(_) => false,
        };
        let mut failures: Vec<String> = Vec::new();
        if let Some(home) = dirs::home_dir() {
            for sub in [".local/share/Trash/files", ".local/share/Trash/info"] {
                let p = home.join(sub);
                if p.exists() {
                    if let Err(e) = std::fs::remove_dir_all(&p) {
                        failures.push(format!("{}: {e}", p.display()));
                    }
                }
            }
        }
        if gio_ok && failures.is_empty() {
            JsonResult::ok_empty()
        } else if !failures.is_empty() {
            JsonResult::err(format!("Trash could not be fully emptied: {}", failures.join("; ")))
        } else {
            // `gio` missing/failed but there was nothing left to remove.
            JsonResult::ok_empty()
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
        // SHEmptyRecycleBinW returns S_OK on success, S_FALSE when the bin was
        // already empty. Report a real failure (e.g. ERROR_ACCESS_DENIED) rather
        // than always telling the UI the bin was emptied.
        match unsafe {
            SHEmptyRecycleBinW(
                HWND::default(),
                PCWSTR::null(),
                SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND,
            )
        } {
            Ok(()) => JsonResult::ok_empty(),
            Err(e) => JsonResult::err(format!("Failed to empty the Recycle Bin (0x{:08X}).", e.code().0)),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        JsonResult::ok_empty()
    }
}

#[tauri::command]
pub async fn list_trash() -> JsonResult {
    // Directory walks / a Python subprocess (macOS) can block; run off-thread.
    tauri::async_runtime::spawn_blocking(list_trash_inner)
        .await
        .unwrap_or_else(|e| JsonResult::err(format!("List Trash failed: {e}")))
}

fn list_trash_inner() -> JsonResult {
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
                crate::browser::dir_size(&entry.path())
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
pub async fn restore_trash(trash_path: String, original_path: Option<String>) -> JsonResult {
    // Moving / copy+removing a large tree can block for seconds; run off the
    // main thread so the UI stays responsive.
    tauri::async_runtime::spawn_blocking(move || restore_trash_inner(trash_path, original_path))
        .await
        .unwrap_or_else(|e| JsonResult::err(format!("Restore failed: {e}")))
}

fn restore_trash_inner(trash_path: String, original_path: Option<String>) -> JsonResult {
    use std::path::PathBuf;

    let src = std::path::Path::new(&trash_path);
    if !src.exists() {
        return JsonResult::err("File not found");
    }
    let meta = match std::fs::symlink_metadata(src) {
        Ok(m) => m,
        Err(e) => return JsonResult::err(format!("Cannot inspect {}: {e}", src.display())),
    };
    let is_dir = meta.is_dir();

    // Prefer the original location (parsed from trash metadata on Windows).
    let mut dest: Option<PathBuf> = original_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| is_safe_restore_target(p));
    if dest.is_none() {
        // Fallback: home directory, named after the trashed file.
        let home = dirs::home_dir().unwrap_or_default();
        let fname = src.file_name().and_then(|n| n.to_str()).unwrap_or("restored");
        dest = Some(home.join(fname));
    }
    let mut dest = dest.unwrap();

    if dest.exists() {
        // Conflict strategy: rename with a timestamp suffix.
        let base = dest
            .file_stem()
            .and_then(|n| n.to_str())
            .map(String::from)
            .unwrap_or_else(|| "file".into());
        let ext = dest
            .extension()
            .and_then(|n| n.to_str())
            .map(String::from)
            .unwrap_or_default();
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let mut new_name = format!("{}_{}", base, ts);
        if !ext.is_empty() {
            new_name = format!("{}.{}", new_name, ext);
        }
        dest = dest.with_file_name(new_name);
    }

    // Re-validate the final target: a malicious trash entry must never be able
    // to place files inside an OS-critical directory (C:\Windows, /etc, ...).
    if !is_safe_restore_target(&dest) {
        return JsonResult::err(format!(
            "Restore location is not allowed: {}",
            dest.display()
        ));
    }

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return JsonResult::err(format!("Cannot create {}: {e}", parent.display()));
            }
        }
    }

    // Atomic move where possible; fall back to copy + remove across devices.
    // Never copy over an existing destination: the conflict branch above picked
    // a unique name, so a destination that reappears here is a race we must not
    // overwrite silently.
    let moved = if is_dir {
        if dest.exists() {
            return JsonResult::err(format!(
                "Destination unexpectedly exists: {}",
                dest.display()
            ));
        }
        std::fs::rename(src, &dest)
            .or_else(|_| copy_dir_all(src, &dest).and_then(|_| std::fs::remove_dir_all(src)))
    } else {
        if dest.exists() {
            return JsonResult::err(format!(
                "Destination unexpectedly exists: {}",
                dest.display()
            ));
        }
        match std::fs::rename(src, &dest) {
            Ok(()) => Ok(()),
            Err(e) => {
                if dest.exists() {
                    return JsonResult::err(format!(
                        "Destination appeared before restore: {}",
                        dest.display()
                    ));
                }
                std::fs::copy(src, &dest)
                    .and_then(|_| std::fs::remove_file(src))
                    .map_err(|ce| {
                        std::io::Error::new(
                            e.kind(),
                            format!("rename ({e}) and copy ({ce}) both failed"),
                        )
                    })
            }
        }
    };
    match moved {
        Ok(()) => JsonResult::ok(serde_json::json!({
            "restored_to": dest.to_string_lossy().to_string(),
        })),
        Err(e) => JsonResult::err(format!("Failed to restore: {e}")),
    }
}

/// A restore target must never be a filesystem root, the home directory, an
/// OS-critical system directory or contain NUL bytes. The original path comes
/// from the user-writable `$I` metadata, so a crafted trash entry could
/// otherwise be used to write files anywhere on disk.
fn is_safe_restore_target(path: &std::path::Path) -> bool {
    if path.as_os_str().to_string_lossy().as_bytes().contains(&0) {
        return false;
    }
    if path.parent().map(|x| x == path).unwrap_or(false) {
        return false; // filesystem root ("/")
    }
    if path.file_name().is_none() {
        return false; // volume / drive root ("C:\", "/")
    }
    let home = dirs::home_dir().unwrap_or_default();
    if !home.as_os_str().is_empty() && path == home {
        return false;
    }
    for base in system_critical_dirs() {
        if path_is_within_or_equal(&base, path) {
            return false;
        }
    }
    true
}

/// Directories no restore may write into, resolved from environment variables
/// (Windows) or fixed OS locations (macOS/Linux).
fn system_critical_dirs() -> Vec<String> {
    let mut deny: Vec<String> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        // Windows keeps case-insensitive paths; compare lowercased below.
        for var in [
            "SystemRoot",
            "WINDIR",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
        ] {
            if let Ok(v) = std::env::var(var) {
                if !v.trim().is_empty() {
                    deny.push(v);
                }
            }
        }
        // Never restore into the recycle bin itself (a recursive source).
        if let Some(bin) = current_user_recycle_bin() {
            deny.push(bin.to_string_lossy().into_owned());
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        deny.extend(
            [
                "/System",
                "/Library",
                "/etc",
                "/usr",
                "/var",
                "/private",
                "/bin",
                "/sbin",
                "/cores",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    }
    deny
}

/// Case-insensitive on Windows, exact elsewhere: is `path` equal to `base` or
/// located anywhere beneath it?
fn path_is_within_or_equal(base: &str, path: &std::path::Path) -> bool {
    let base = base.trim().trim_end_matches(['/', '\\']);
    if base.is_empty() {
        return false;
    }
    let p = path.to_string_lossy();
    #[cfg(target_os = "windows")]
    {
        let b = base.to_lowercase();
        let q = p.to_lowercase();
        q == b || q.starts_with(&format!("{}\\", b))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let b = base.to_string();
        q == b || q.starts_with(&format!("{}/", b))
    }
}

/// Recursive directory copy (used when `rename` crosses filesystem boundaries).
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_target_rejects_nul_bytes() {
        let p = std::path::PathBuf::from("C:\\evil\0name");
        assert!(!is_safe_restore_target(&p));
    }

    #[test]
    fn restore_target_rejects_filesystem_and_drive_roots() {
        // Root of the current volume (path whose parent == itself).
        let root = std::env::current_dir()
            .map(|c| c.ancestors().last().unwrap().to_path_buf())
            .unwrap();
        assert!(!is_safe_restore_target(&root));
        #[cfg(target_os = "windows")]
        assert!(!is_safe_restore_target(&std::path::PathBuf::from("C:\\")));
    }

    #[test]
    fn restore_target_rejects_home_root() {
        if let Some(home) = dirs::home_dir() {
            assert!(!is_safe_restore_target(&home));
        }
    }

    #[test]
    fn restore_target_rejects_system_dirs() {
        #[cfg(target_os = "windows")]
        if let Ok(sys) = std::env::var("SystemRoot") {
            let root = std::path::PathBuf::from(&sys);
            // Deny files directly inside the system dir and nested below it.
            assert!(!is_safe_restore_target(&root.join("evil.dll")));
            assert!(!is_safe_restore_target(&root.join("System32\\evil.dll")));
        }
        #[cfg(not(target_os = "windows"))]
        for deny in ["/etc", "/usr", "/System", "/Library", "/var"] {
            let p = std::path::PathBuf::from(deny).join("evil");
            assert!(!is_safe_restore_target(&p), "{deny} must be denied");
        }
    }

    #[test]
    fn restore_target_allows_home_subdirs() {
        if let Some(home) = dirs::home_dir() {
            let ok = home.join("Documents\\restored.txt");
            // If the OS deny list ever grows a home subdir (rare), the assert
            // would fail loudly here; currently home subdirs are fine.
            assert!(is_safe_restore_target(&ok));
        }
    }

    #[test]
    fn path_within_or_equal_matches_prefix() {
        #[cfg(target_os = "windows")]
        {
            assert!(path_is_within_or_equal("C:\\Windows", &std::path::PathBuf::from("c:\\WINDOWS\\System32")));
            assert!(path_is_within_or_equal("C:\\Windows", &std::path::PathBuf::from("C:\\Windows")));
            assert!(!path_is_within_or_equal("C:\\Windows", &std::path::PathBuf::from("C:\\WindowsStuff")));
            assert!(!path_is_within_or_equal("C:\\Windows", &std::path::PathBuf::from("D:\\Windows\\System32")));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(path_is_within_or_equal("/etc", &std::path::PathBuf::from("/etc/shadow")));
            assert!(path_is_within_or_equal("/etc", &std::path::PathBuf::from("/etc")));
            assert!(!path_is_within_or_equal("/etc", &std::path::PathBuf::from("/etcetera")));
        }
    }
}
