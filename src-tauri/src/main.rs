#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::{format_size, TreeChunk};
use diskraptor_scanner::streaming::chunker::CHUNK_SIZE;

mod browser;
mod menu;
mod smart;
#[cfg(feature = "test-server")]
mod test_server;
mod trash;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};
use serde::Serialize;

// â”€â”€ Scanner state â”€â”€

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

// â”€â”€ Duplicate scanner state â”€â”€

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

// â”€â”€ App managed state â”€â”€

pub(crate) struct AppState {
    scan: ScanState,
    dup: DupState,
    settings_path: Mutex<std::path::PathBuf>,
    /// Monotonic scan id counter so `start_scan` can hand back a real `scan_id`.
    scan_counter: AtomicU64,
    #[allow(dead_code)] // used on Linux for pkexec caching
    pub(crate) smart_cache: Mutex<std::collections::HashMap<String, (std::time::Instant, JsonResult)>>,
}

// â”€â”€ Helper types â”€â”€

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

// â”€â”€ File Operations â”€â”€

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
    if canonical.parent().map(|p| p.as_os_str() == std::ffi::OsStr::new("")).unwrap_or(false)
        || canonical.parent().map(|p| p == std::path::Path::new("/")).unwrap_or(false)
    {
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

/// Validate a user-supplied path before handing it to a shell/system command.
/// Guards against empty input, NUL/control-character injection and relative
/// paths (path traversal). Callers may additionally require the path to exist.
fn validate_system_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    if p.as_bytes().contains(&0) {
        return Err("Path contains NUL byte".into());
    }
    for b in p.bytes() {
        if b < 0x20 && b != b'\t' && b != b'\n' && b != b'\r' {
            return Err("Path contains control characters".into());
        }
    }
    let pb = std::path::PathBuf::from(p);
    if !pb.is_absolute() {
        return Err("Only absolute paths are allowed".into());
    }
    if !pb.exists() {
        return Err("Path does not exist".into());
    }
    Ok(pb)
}

#[tauri::command]
fn delete_path(path: String) -> JsonResult {
    let path = match sanitize_delete_path(&path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(e) => return JsonResult::err(e),
    };
    if ::trash::delete(&path).is_ok() {
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
    tauri::async_runtime::spawn_blocking(move || match delete_path_checked(&path) {
        Ok(()) => JsonResult::ok_empty(),
        Err(msg) => JsonResult::err(msg),
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Delete failed: {e}")))
}

/// Delete a validated path, never following symlinks for directory recursion
/// and reporting failures instead of silently swallowing them (the frontend
/// must not claim success when nothing was removed).
fn delete_path_checked(path: &std::path::Path) -> Result<(), String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("Not found: {}", path.display())
        } else {
            format!("Cannot inspect {}: {e}", path.display())
        }
    })?;
    if meta.is_symlink() {
        // Remove the link itself, never the target it points to.
        std::fs::remove_file(path)
            .map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
    } else if meta.is_dir() {
        // remove_dir_all does not follow symlinks; junctions/links are removed
        // as links. This prevents recursive deletion through a swapped target.
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
    } else {
        std::fs::remove_file(path)
            .map_err(|e| format!("Cannot remove {}: {e}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
fn open_explorer(path: String) -> JsonResult {
    let path = match validate_system_path(&path) {
        Ok(p) => p,
        Err(e) => return JsonResult::err(e),
    };
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            return JsonResult::err("Opening in Finder is not available in the sandboxed build.");
        }
        let _ = std::process::Command::new("open").args(["-R", &path_str]).status();
    }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("explorer").args(["/select,", &path_str]).status(); }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path_str).parent().and_then(|p| p.to_str()).unwrap_or(&path_str);
        let _ = std::process::Command::new("xdg-open").args([parent]).status();
    }
    JsonResult::ok_empty()
}

#[tauri::command]
fn open_terminal(path: String) -> JsonResult {
    let dir = match validate_system_path(&path) {
        Ok(p) if p.is_dir() => p,
        Ok(p) => p.parent().map(|x| x.to_path_buf()).unwrap_or(p),
        Err(e) => return JsonResult::err(e),
    };
    let dir_str = dir.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        // cmd.exe interprets the whole command line, so reject paths carrying
        // cmd metacharacters that could break out of the `cd` argument.
        if dir_str.chars().any(|c| "&|<>^%".contains(c)) {
            return JsonResult::err("Path contains characters unsafe for cmd.exe");
        }
    }
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            return JsonResult::err("Opening Terminal is not available in the sandboxed build.");
        }
        let _ = std::process::Command::new("open").args(["-a", "Terminal", &dir_str]).status();
    }
    #[cfg(target_os = "windows")]
    { let _ = std::process::Command::new("cmd").args(["/k", "cd", "/d", &dir_str]).status(); }
    #[cfg(target_os = "linux")]
    {
        for term in &["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "mate-terminal", "alacritty", "kitty"] {
            if let Ok(s) = std::process::Command::new(term).arg("--working-directory").arg(&dir_str).status() {
                if s.success() { break; }
            }
        }
    }
    JsonResult::ok_empty()
}

#[tauri::command]
fn open_properties(path: String) -> JsonResult {
    let path = match validate_system_path(&path) {
        Ok(p) => p,
        Err(e) => return JsonResult::err(e),
    };
    let path_str = path.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    {
        use windows::core::{PCWSTR, w};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = path_str.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("properties"),
                PCWSTR(wide.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL.0 as i32,
            )
        };
        // ShellExecute returns a value > 32 on success.
        if result.0 as usize <= 32 {
            // Fall back to revealing the item in Explorer.
            let _ = std::process::Command::new("explorer").args(["/select,", &path_str]).status();
        }
    }
    #[cfg(target_os = "macos")]
    {
        if in_mac_sandbox() {
            return JsonResult::err("Show Info is not available in the sandboxed build.");
        }
        let _ = std::process::Command::new("open").args(["-R", &path_str]).status();
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(&path_str).parent().and_then(|p| p.to_str()).unwrap_or(&path_str);
        let _ = std::process::Command::new("xdg-open").args([parent]).status();
    }
    JsonResult::ok_empty()
}

#[tauri::command]
fn get_icon(path: String, is_dir: bool) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        // The frontend sends an extension key (e.g. "exe", "pdf", "__folder__"),
        // so probe the shell icon for that file type. Empty string â†’ frontend
        // falls back to its emoji icons.
        let key = path.trim();
        let (probe, attrs) = if is_dir {
            ("folder".to_string(), 0x10) // FILE_ATTRIBUTE_DIRECTORY
        } else if key.is_empty() {
            ("file.unk".to_string(), 0x80) // FILE_ATTRIBUTE_NORMAL
        } else {
            // Use the key as extension (frontend already strips the dot).
            (format!("probe.{}", key), 0x80)
        };
        match windows_icon_bytes(&probe, attrs) {
            Some(rgba) => JsonResult::ok(serde_json::json!(base64_encode(&rgba))),
            None => JsonResult::ok(serde_json::json!("")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (path, is_dir);
        JsonResult::ok(serde_json::json!(""))
    }
}

/// Render a shell icon handle into 16×16 RGBA bytes (top-down), as consumed by
/// the frontend IconCache canvas.
#[cfg(target_os = "windows")]
pub(crate) fn hicon_to_rgba(hicon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Gdi::{
        BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DeleteObject,
        DIB_RGB_COLORS, HBRUSH, HGDIOBJ, SelectObject,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DI_NORMAL, DestroyIcon, DrawIconEx};

    const SIZE: i32 = 16;
    if hicon.0 == 0 {
        return None;
    }
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: SIZE,
            biHeight: -SIZE, // top-down rows → straight RGBA order
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        },
        bmiColors: [Default::default()],
    };

    let dc = unsafe { CreateCompatibleDC(None) };
    let hbitmap = unsafe { CreateDIBSection(dc, &bmi, DIB_RGB_COLORS, &mut bits, HANDLE::default(), 0) };
    if hbitmap.is_err() || bits.is_null() {
        return None;
    }
    let hbitmap = hbitmap.unwrap();
    let _old = unsafe { SelectObject(dc, hbitmap) };
    unsafe {
        DrawIconEx(
            dc,
            0,
            0,
            hicon,
            SIZE,
            SIZE,
            0,
            HBRUSH::default(),
            DI_NORMAL,
        )
    };
    let mut bytes: Vec<u8> = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let src = bits as *const u8;
    unsafe {
        // 32bpp DIBs store pixels as BGRA; the frontend canvas expects RGBA.
        for px in 0..(SIZE * SIZE) as usize {
            let off = px * 4;
            let (b, r) = (*src.add(off), *src.add(off + 2));
            bytes.push(r);
            bytes.push(*src.add(off + 1));
            bytes.push(b);
            bytes.push(*src.add(off + 3));
        }
    }
    unsafe {
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    }
    unsafe {
        let _ = DestroyIcon(hicon);
    }
    Some(bytes)
}

/// Get the shell icon handle for a file type (or a real path) as RGBA bytes.
#[cfg(target_os = "windows")]
fn windows_icon_bytes(probe: &str, attributes: u32) -> Option<Vec<u8>> {
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES};

    let mut shfi = SHFILEINFOW::default();
    let wide: Vec<u16> = probe.encode_utf16().chain(std::iter::once(0)).collect();
    let flags = SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES;
    let ret = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(attributes),
            &mut shfi,
            size_of::<SHFILEINFOW>() as u32,
            flags,
        )
    };
    if ret == 0 || shfi.hIcon.0 == 0 {
        return None;
    }
    hicon_to_rgba(shfi.hIcon)
}

#[cfg(target_os = "windows")]
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { ALPHABET[((n >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[(n & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/// Minimal PNG encoder (RGBA, 8-bit, no interlace). Uses stored (uncompressed)
/// deflate blocks so no compression crate is needed — fine for 16×16 icons.
#[cfg(target_os = "windows")]
fn png_encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    fn crc32(data: &[u8]) -> u32 {
        let mut crc: u32 = 0xFFFF_FFFF;
        for &b in data {
            crc ^= b as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(data);
        let mut crc_input = Vec::with_capacity(4 + data.len());
        crc_input.extend_from_slice(kind);
        crc_input.extend_from_slice(data);
        out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
    }

    let row_bytes = width as usize * 4 + 1; // +1 filter byte per row
    let mut raw = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        raw.push(0); // filter: None
        raw.extend_from_slice(&rgba[y * (width as usize * 4)..(y + 1) * (width as usize * 4)]);
    }

    // zlib: header (0x78 0x01) + one stored deflate block + adler32.
    let mut zlib = vec![0x78, 0x01];
    let len = raw.len();
    debug_assert!(len <= 65535, "icon too large for single stored block");
    zlib.push(0x01); // BFINAL=1, BTYPE=00 (stored)
    zlib.extend_from_slice(&(len as u16).to_le_bytes());
    zlib.extend_from_slice(&(!(len as u16)).to_le_bytes());
    zlib.extend_from_slice(&raw);
    let adler = {
        let mut a: u32 = 1;
        let mut b: u32 = 0;
        for &byte in &raw {
            a = (a + byte as u32) % 65521;
            b = (b + a) % 65521;
        }
        (b << 16) | a
    };
    zlib.extend_from_slice(&adler.to_be_bytes());

    let mut out = Vec::new();
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.push(8); // bit depth
    ihdr.push(6); // color type: RGBA
    ihdr.push(0); // compression
    ihdr.push(0); // filter
    ihdr.push(0); // interlace
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Extract a browser's executable icon as a `data:image/png;base64,...` URL
/// using the native shell API (SHGetFileInfoW) — no PowerShell.
#[cfg(target_os = "windows")]
pub(crate) fn native_browser_icon(exe_path: &str) -> Option<String> {
    use std::mem::size_of;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};

    let mut shfi = SHFILEINFOW::default();
    let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
    // Probe the real executable so its embedded icon is used; USEFILEATTRIBUTES
    // is omitted so the actual file's icon (not the type icon) is returned.
    let ret = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0x80), // FILE_ATTRIBUTE_NORMAL
            &mut shfi,
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ret == 0 || shfi.hIcon.0 == 0 {
        return None;
    }
    let rgba = hicon_to_rgba(shfi.hIcon)?;
    let png = png_encode_rgba(16, 16, &rgba);
    Some(format!("data:image/png;base64,{}", base64_encode(&png)))
}

// â”€â”€ System Operations â”€â”€

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
            // Only the current user's recycle bin — scanning the $Recycle.Bin
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

/// Enumerate mounted volumes via sysinfo â€” works without spawning any external
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

// â”€â”€ S.M.A.R.T. Tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Build a `Command` without flashing a console window. Windows GUI apps show
/// a brief DOS box whenever powershell/cmd/curl/smartctl are launched from
/// them; `CREATE_NO_WINDOW` suppresses that. Only needed on macOS/Linux now —
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
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn list_disks() -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        // 100% native: probe \\.\PHYSICALDRIVE0..31 via DeviceIoControl.
        // Opening a physical drive needs admin rights; without them the list is
        // empty (S.M.A.R.T. reads need admin anyway).
        JsonResult::ok(serde_json::json!(smart::native_list_disks()))
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
    // installed version. Pure Rust (ureq) — no curl subprocess. Async so a slow
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
            .timeout(std::time::Duration::from_secs(8))
            .build();
        let resp = agent
            .get("https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest")
            .set("User-Agent", "DiskRaptor")
            .call()
            .ok()?;
        let body = resp.into_string().ok()?;
        let v: serde_json::Value = serde_json::from_str(&body).ok()?;
        let tag = v.get("tag_name").and_then(|t| t.as_str())?;
        Some(tag.trim_start_matches('v').to_string())
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

// â”€â”€ Scanner Commands â”€â”€

fn scan_config(
    path: &str,
    follow_symlinks: bool,
    timeout_secs: u64,
    live: LiveEntries,
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
    let scan_id = scan.scan_counter.fetch_add(1, Ordering::Relaxed) + 1;
    scan.scan.active_scan_id.store(scan_id, Ordering::Release);
    scan.scan.cancelled.store(false, Ordering::Release);
    scan.scan.files_found.store(0, Ordering::Relaxed);
    scan.scan.dirs_found.store(0, Ordering::Relaxed);
    scan.scan.bytes_found.store(0, Ordering::Relaxed);
    *scan.scan.current_dir.lock() = path.clone();
    *scan.scan.start_time.lock() = Instant::now();
    *scan.scan.result.lock() = None;
    *scan.scan.errors.lock() = Vec::new();

    let p = path.clone();
    let fs = follow_symlinks.unwrap_or(false);
    let ts = timeout_secs.unwrap_or(30);
    let handle = app.clone();

    let live = std::sync::Arc::new(parking_lot::Mutex::new(std::collections::VecDeque::new()));
    *scan.scan.live_entries.lock() = Some(live.clone());

    let result_handle = handle.clone();
    std::thread::Builder::new().name("scan".into()).spawn(move || {
        let config = scan_config(&p, fs, ts, live);
        let cancel_flag = config.cancelled.clone().unwrap();
        {
            let s = result_handle.state::<AppState>();
            *s.scan.cancel_flag.lock() = Some(cancel_flag.clone());
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
                *s.scan.current_dir.lock() = msg.to_owned();
            }
            let _ = emit_handle.emit(
                "scan:progress",
                serde_json::json!({
                    "scan_id": s.scan.active_scan_id.load(Ordering::Acquire),
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
                            s.scan.errors.lock().push(format!(
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
                let termination = sr.termination;
                *s.scan.result.lock() = Some(ScanResultData {
                    arena: sr.arena, stats: sr.stats, scan_time_ms: elapsed,
                    errors: Vec::new(), termination,
                });
            }
            Some(Err(e)) => {
                eprintln!("[scan] error: {}", e);
                // Surface the error to the UI so the user sees why the tree is empty.
                s.scan.errors.lock().push(e.to_string());
                let _ = result_handle.emit("scan:error", serde_json::json!({ "error": e.to_string() }));
            }
            None => {
                // Timed out: errors were already pushed by the watchdog.
            }
        }
        s.scan.running.store(false, Ordering::Release);
    }).ok();

    JsonResult::ok(serde_json::json!({"status": "started", "scan_id": scan_id}))
}

/// True when the caller's `scan_id` matches the currently active scan (or the
/// caller did not pass an id). Guards against late IPC responses from a stale
/// scan being applied to a newer one.
fn scan_id_matches(state: &AppState, scan_id: Option<u64>) -> bool {
    match scan_id {
        Some(id) => id == state.scan.active_scan_id.load(Ordering::Acquire),
        None => true,
    }
}

fn scan_progress_data(state: &AppState) -> serde_json::Value {
    let is_running = state.scan.running.load(Ordering::Acquire);
    let rg = state.scan.result.lock();
    let has_result = rg.is_some();
    let (files, dirs, bytes) = if has_result {
        let r = rg.as_ref().unwrap();
        (r.stats.total_files, r.stats.total_dirs, r.stats.total_size)
    } else {
        (state.scan.files_found.load(Ordering::Relaxed), state.scan.dirs_found.load(Ordering::Relaxed), state.scan.bytes_found.load(Ordering::Relaxed))
    };
    let errors: Vec<String> = state.scan.errors.lock().clone();
    drop(rg);
    let phase: u64 = if !is_running && has_result { 3 } else if is_running { 0 } else { 3 };
    let elapsed = state.scan.start_time.lock().elapsed().as_secs();
    let cd = state.scan.current_dir.lock().clone();
    let live: Vec<String> = state
        .scan
        .live_entries
        .lock()
        .as_ref()
        .map(|q| q.lock().iter().cloned().collect())
        .unwrap_or_default();
    serde_json::json!({
        "files_found": files, "dirs_found": dirs, "bytes_found": bytes,
        "is_running": is_running, "current_dir": cd,
        "elapsed_secs": elapsed, "phase": phase,
        "errors": errors, "live_entries": live,
    })
}

#[tauri::command]
fn get_scan_progress(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
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
fn get_scan_result(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let sj = serde_json::json!({
            "total_files": d.stats.total_files, "total_dirs": d.stats.total_dirs,
            "total_size": d.stats.total_size, "scan_time_ms": d.scan_time_ms,
            "top_files": d.stats.top_files, "file_type_breakdown": d.stats.file_type_breakdown,
            "size_human": format_size(d.stats.total_size),
            "time_human": format!("{:.2}s", d.scan_time_ms as f64 / 1000.0),
            "termination": d.termination,
        });
        let total_chunks = (d.arena.len() as u32).div_ceil(CHUNK_SIZE);
        let active_id = state.scan.active_scan_id.load(Ordering::Acquire);
        let ri = serde_json::json!({"root_index": 0, "total_nodes": d.arena.len(), "total_chunks": total_chunks});
        drop(g);
        JsonResult::ok(serde_json::json!({"stats": sj, "root_info": ri, "scan_id": active_id, "errors": []}))
    } else {
        drop(g);
        JsonResult::err("No scan result")
    }
}

#[tauri::command]
fn get_chunk(state: State<AppState>, chunk_index: u32, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let g = state.scan.result.lock();
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

/// Return the direct children of a node as full node objects, mirroring what
/// `loadChunk` hands the UI. Used by the frontend when a node's children have
/// not been received in any loaded chunk yet.
#[tauri::command]
fn get_children(state: State<AppState>, node_index: u32, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let arena = &d.arena;
        if (node_index as usize) >= arena.nodes.len() {
            return JsonResult::ok(serde_json::json!([]));
        }
        let mut children: Vec<scanner::tree::TreeNode> = Vec::new();
        let mut cur = arena.nodes[node_index as usize].first_child;
        while cur != u32::MAX {
            match arena.nodes.get(cur as usize) {
                Some(n) => {
                    let next = n.next_sibling;
                    let mut node = n.clone();
                    node.chunk_id = cur / CHUNK_SIZE;
                    children.push(node);
                    cur = next;
                }
                None => break,
            }
        }
        drop(g);
        match serde_json::to_value(&children) {
            Ok(v) => JsonResult::ok(v),
            Err(_) => JsonResult::err("Failed to serialize children"),
        }
    } else {
        drop(g);
        JsonResult::ok(serde_json::json!([]))
    }
}

#[tauri::command]
fn cancel_scan(state: State<AppState>) -> JsonResult {
    if !state.scan.running.load(Ordering::Acquire) {
        return JsonResult::ok(serde_json::json!(false));
    }
    state.scan.cancelled.store(true, Ordering::Release);
    if let Some(ref cf) = *state.scan.cancel_flag.lock() {
        cf.store(true, Ordering::Release);
    }
    JsonResult::ok(serde_json::json!(true))
}

#[tauri::command]
fn release_scan(state: State<AppState>) -> JsonResult {
    *state.scan.result.lock() = None;
    JsonResult::ok_empty()
}

// â”€â”€ Duplicate file scanner â”€â”€

#[tauri::command]
fn find_duplicates(path: String, app: tauri::AppHandle) -> JsonResult {
    let st = app.state::<AppState>();
    if st.dup.running.swap(true, Ordering::Acquire) {
        return JsonResult::err("Duplicate scan already running");
    }
    st.dup.cancelled.store(false, Ordering::Release);
    st.dup.phase.store(1, Ordering::Relaxed);
    st.dup.files_scanned.store(0, Ordering::Relaxed);
    *st.dup.current_file.lock() = String::new();
    *st.dup.groups.lock() = Vec::new();
    *st.dup.wasted_bytes.lock() = 0;

    let handle = app.clone();
    std::thread::Builder::new().name("dup-scan".into()).spawn(move || {
        let st = handle.state::<AppState>();
        const FILE_CAP: u64 = 200_000;

        // Phase 1: collect files grouped by size.
        let mut by_size: std::collections::HashMap<u64, Vec<std::path::PathBuf>> =
            std::collections::HashMap::new();
        let mut scanned: u64 = 0;
        for entry in walkdir::WalkDir::new(&path).follow_links(false) {
            let e = match entry {
                Ok(e) => e,
                Err(_) => continue,
            };
            if st.dup.cancelled.load(Ordering::Relaxed) {
                break;
            }
            if !e.file_type().is_file() {
                continue;
            }
            let meta = match std::fs::metadata(e.path()) {
                Ok(m) => m,
                Err(_) => continue,
            };
            scanned += 1;
            st.dup.files_scanned.store(scanned, Ordering::Relaxed);
            *st.dup.current_file.lock() = e.path().to_string_lossy().to_string();
            by_size.entry(meta.len()).or_default().push(e.path().to_path_buf());
            if scanned >= FILE_CAP {
                break;
            }
        }

        // Phase 2: hash candidate groups (same size).
        st.dup.phase.store(2, Ordering::Relaxed);
        let mut by_hash: std::collections::HashMap<(u64, u64), Vec<std::path::PathBuf>> =
            std::collections::HashMap::new();
        for group in by_size.into_values() {
            if group.len() < 2 {
                continue;
            }
            for p in group {
                if st.dup.cancelled.load(Ordering::Relaxed) {
                    break;
                }
                scanned += 1;
                st.dup.files_scanned.store(scanned, Ordering::Relaxed);
                *st.dup.current_file.lock() = p.to_string_lossy().to_string();
                let h = scanner::duplicates::hash_file_head(&p, scanner::duplicates::HEAD_HASH_BYTES);
                by_hash.entry(h).or_default().push(p);
            }
        }

        // Phase 3: full verification of head-hash groups, then build result groups.
        st.dup.phase.store(3, Ordering::Relaxed);
        let mut groups = Vec::new();
        let mut wasted: u64 = 0;
        for ((size, _), files) in by_hash {
            if files.len() < 2 {
                continue;
            }
            // Full stream-hash each candidate: only files with identical full
            // content are true duplicates. Files that changed while scanning
            // are excluded so we never suggest deleting them.
            let mut by_full: std::collections::HashMap<(u64, u64), Vec<std::path::PathBuf>> =
                std::collections::HashMap::new();
            for p in &files {
                if st.dup.cancelled.load(Ordering::Relaxed) {
                    break;
                }
                let (fsize, fhash, changed) = scanner::duplicates::hash_file_full(p);
                if changed || fsize != size {
                    continue;
                }
                by_full.entry((fsize, fhash)).or_default().push(p.clone());
            }
            for ((_s, _fh), dup_files) in by_full {
                if dup_files.len() < 2 {
                    continue;
                }
                let wasted_g = size * (dup_files.len() as u64 - 1);
                wasted += wasted_g;
                let paths: Vec<String> = dup_files
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                groups.push(serde_json::json!({
                    "count": dup_files.len(),
                    "size": size,
                    "sizeHuman": format_size(size),
                    "wasted": wasted_g,
                    "wastedHuman": format_size(wasted_g),
                    "files": paths,
                }));
            }
        }
        groups.sort_by(|a, b| {
            b["wasted"].as_u64().unwrap_or(0).cmp(&a["wasted"].as_u64().unwrap_or(0))
        });
        *st.dup.groups.lock() = groups;
        *st.dup.wasted_bytes.lock() = wasted;
        st.dup.running.store(false, Ordering::Release);
    }).ok();

    JsonResult::ok_empty()
}

#[tauri::command]
fn get_dup_stats(state: State<AppState>) -> JsonResult {
    let groups = state.dup.groups.lock();
    let wasted = *state.dup.wasted_bytes.lock();
    JsonResult::ok(serde_json::json!({
        "phase": state.dup.phase.load(Ordering::Relaxed),
        "filesScanned": state.dup.files_scanned.load(Ordering::Relaxed),
        "groups": groups.len(),
        "wastedBytes": wasted,
        "currentFile": state.dup.current_file.lock().clone(),
    }))
}

#[tauri::command]
fn get_dup_result(state: State<AppState>) -> JsonResult {
    let groups = state.dup.groups.lock().clone();
    let wasted = *state.dup.wasted_bytes.lock();
    JsonResult::ok(serde_json::json!({
        "groups": groups,
        "wastedBytes": wasted,
        "filesScanned": state.dup.files_scanned.load(Ordering::Relaxed),
        "cancelled": state.dup.cancelled.load(Ordering::Relaxed),
    }))
}

#[tauri::command]
fn cancel_dup_scan(state: State<AppState>) -> JsonResult {
    state.dup.cancelled.store(true, Ordering::Release);
    JsonResult::ok_empty()
}

#[tauri::command]
fn get_stats(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let sj = serde_json::json!({
            "total_files": d.stats.total_files, "total_dirs": d.stats.total_dirs,
            "total_size": d.stats.total_size, "scan_time_ms": d.scan_time_ms,
            "top_files": d.stats.top_files, "file_type_breakdown": d.stats.file_type_breakdown,
            "size_human": format_size(d.stats.total_size),
            "time_human": format!("{:.2}s", d.scan_time_ms as f64 / 1000.0),
            "termination": d.termination,
        });
        drop(g);
        JsonResult::ok(sj)
    } else {
        drop(g);
        JsonResult::err("No scan data")
    }
}

// â”€â”€ Test/Diagnostic Commands â”€â”€

// â”€â”€ Settings â”€â”€

#[tauri::command]
fn save_settings(state: State<AppState>, settings: serde_json::Value) -> JsonResult {
    // Accept both `invoke("save_settings", { settings: {...} })` and a raw payload.
    let settings = match settings.get("settings") {
        Some(inner) if inner.is_object() => inner.clone(),
        _ => settings,
    };
    let path = state.settings_path.lock().clone();
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
    let path = state.settings_path.lock().clone();
    if let Ok(json) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) {
            return JsonResult::ok(v);
        }
    }
    JsonResult::ok(serde_json::json!({}))
}

// â”€â”€ Helpers â”€â”€

// â”€â”€ Main â”€â”€

fn main() {
    let settings_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor").join("settings.json");
    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
                active_scan_id: AtomicU64::new(0),
            },
            dup: DupState::default(),
            settings_path: Mutex::new(settings_path),
            scan_counter: AtomicU64::new(0),
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
                        rt.block_on(test_server::cdp_server(port, handle));
                    });
                }
            }
            #[cfg(target_os = "windows")]
            {
                if let Some(win) = _app.get_webview_window("main") {
                    if let Ok(menu) = menu::build_native_menu(_app.handle()) {
                        let _ = win.set_menu(menu);
                    }
                }
            }
            Ok(())
        })
        .menu(menu::build_native_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            delete_path, delete_permanent,
            open_explorer, open_terminal, open_properties, get_icon,
            get_home_dir, pick_directory, get_trash_path, list_drives, get_volume_stats, get_dir_stats,
            list_downloads_candidates,
            get_memory_info, get_process_memory, get_app_version, get_app_data_dir, get_app_info,
            trash::empty_trash, trash::list_trash, trash::restore_trash,
            request_permissions, check_admin_needed, restart_as_admin, is_sandboxed,
            check_for_updates, open_url,
            start_scan, get_scan_progress, get_scan_result,
            get_chunk, get_children, cancel_scan, release_scan, get_stats,
            find_duplicates, get_dup_stats, get_dup_result, cancel_dup_scan,
            save_settings, load_settings,
            list_disks, exit_app,
            smart::get_smart_status,
            browser::list_browser_data, browser::clean_browser, browser::get_browser_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
}
