//! File operations + the native (unsafe) shell/icon interop they rely on.
//! Keeping every `unsafe` platform call and every path-validation rule in one
//! module makes this the single, reviewable security boundary of the app.
use crate::JsonResult;
#[cfg(target_os = "macos")]
use crate::in_mac_sandbox;

/// Windows `canonicalize` returns `\\?\C:\...` (or `\\?\UNC\server\share` for
/// UNC paths); strip that so path comparisons (home dir, roots) and the trash
/// crate see the conventional form.
#[cfg(target_os = "windows")]
fn strip_verbatim_prefix(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\UNC\").unwrap_or(&s);
    let s = s.strip_prefix(r"\\?\").unwrap_or(s);
    std::path::PathBuf::from(s)
}

/// Reject dangerous delete targets (filesystem roots, home dir, drive roots).
pub(crate) fn sanitize_delete_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = path.trim();
    if p.is_empty() {
        return Err("Empty path".into());
    }
    let path = std::path::Path::new(p);
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(target_os = "windows")]
    let canonical = strip_verbatim_prefix(&canonical);
    let home = dirs::home_dir().unwrap_or_default();
    if !home.as_os_str().is_empty() && canonical == home {
        return Err("Refusing to delete the home directory".into());
    }
    // A path with no parent is a filesystem root ("/", "C:\", "\\server\share").
    if canonical.parent().is_none() {
        return Err("Refusing to delete a filesystem root".into());
    }
    Ok(canonical)
}

/// Validate a user-supplied path before handing it to a shell/system command.
/// Guards against empty input, NUL/control-character injection and relative
/// paths (path traversal). Callers may additionally require the path to exist.
pub(crate) fn validate_system_path(path: &str) -> Result<std::path::PathBuf, String> {
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

/// Metadata snapshot taken right after path validation, used to close the
/// TOCTOU window: validation and deletion are two steps, and a swapped target
/// in between must not be deleted. Re-stat before acting and compare identity.
pub(crate) struct PathSnapshot {
    canonical: std::path::PathBuf,
    is_dir: bool,
    is_symlink: bool,
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl PathSnapshot {
    /// Canonicalize + snapshot. Refuses roots/home just like `sanitize_delete_path`.
    pub(crate) fn capture(path: &str) -> Result<Self, String> {
        let canonical = sanitize_delete_path(path)?;
        let meta = std::fs::symlink_metadata(&canonical)
            .map_err(|e| format!("Cannot inspect {}: {e}", canonical.display()))?;
        Ok(Self {
            is_dir: meta.is_dir(),
            is_symlink: meta.file_type().is_symlink(),
            len: meta.len(),
            modified: meta.modified().ok(),
            canonical,
        })
    }

    /// Re-canonicalize and re-stat the target immediately before an operation.
    /// Returns false when the path no longer resolves to the same file (deleted,
    /// replaced, or a symlink swapped in), so callers must abort.
    pub(crate) fn still_matches(&self) -> bool {
        let Ok(canonical_now) = std::fs::canonicalize(&self.canonical) else {
            return false;
        };
        #[cfg(target_os = "windows")]
        let canonical_now = strip_verbatim_prefix(&canonical_now);
        if canonical_now != self.canonical {
            return false;
        }
        let Ok(meta) = std::fs::symlink_metadata(&self.canonical) else {
            return false;
        };
        if meta.is_dir() != self.is_dir {
            return false;
        }
        if meta.file_type().is_symlink() != self.is_symlink {
            return false;
        }
        if meta.len() != self.len {
            return false;
        }
        meta.modified().ok() == self.modified
    }
}

#[tauri::command]
pub(crate) fn delete_path(path: String) -> JsonResult {
    let snap = match PathSnapshot::capture(&path) {
        Ok(s) => s,
        Err(e) => return JsonResult::err(e),
    };
    // Re-check identity right before acting: never trash a swapped target.
    if !snap.still_matches() {
        return JsonResult::err("Path changed while preparing deletion");
    }
    let path = snap.canonical.to_string_lossy().to_string();
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
pub(crate) async fn delete_permanent(path: String) -> JsonResult {
    let snap = match PathSnapshot::capture(&path) {
        Ok(s) => s,
        Err(e) => return JsonResult::err(e),
    };
    tauri::async_runtime::spawn_blocking(move || {
        if !snap.still_matches() {
            return JsonResult::err("Path changed while preparing deletion");
        }
        match delete_path_checked(&snap.canonical) {
            Ok(()) => JsonResult::ok_empty(),
            Err(msg) => JsonResult::err(msg),
        }
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Delete failed: {e}")))
}

/// Delete a validated path, never following symlinks for directory recursion
/// and reporting failures instead of silently swallowing them (the frontend
/// must not claim success when nothing was removed).
pub(crate) fn delete_path_checked(path: &std::path::Path) -> Result<(), String> {
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
pub(crate) fn open_explorer(path: String) -> JsonResult {
    let path = match validate_system_path(&path) {
        Ok(p) => p,
        Err(e) => return JsonResult::err(e),
    };
    // Operate on the canonical path so a symlink swap cannot redirect the
    // shell to a different location than the one the user saw.
    let path = std::fs::canonicalize(&path).unwrap_or(path);
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
pub(crate) fn open_terminal(path: String) -> JsonResult {
    let dir = match validate_system_path(&path) {
        Ok(p) if p.is_dir() => p,
        Ok(p) => p.parent().map(|x| x.to_path_buf()).unwrap_or(p),
        Err(e) => return JsonResult::err(e),
    };
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
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
pub(crate) fn open_properties(path: String) -> JsonResult {
    let path = match validate_system_path(&path) {
        Ok(p) => p,
        Err(e) => return JsonResult::err(e),
    };
    let path = std::fs::canonicalize(&path).unwrap_or(path);
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
pub(crate) fn get_icon(path: String, is_dir: bool) -> JsonResult {
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

/// Render a shell icon handle into 16Ã—16 RGBA bytes (top-down), as consumed by
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
            biHeight: -SIZE, // top-down rows â†’ straight RGBA order
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
pub(crate) fn windows_icon_bytes(probe: &str, attributes: u32) -> Option<Vec<u8>> {
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
pub(crate) fn base64_encode(data: &[u8]) -> String {
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
/// deflate blocks so no compression crate is needed â€” fine for 16Ã—16 icons.
#[cfg(target_os = "windows")]
pub(crate) fn png_encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
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
/// using the native shell API (SHGetFileInfoW) â€” no PowerShell.
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

#[tauri::command]
pub(crate) fn open_url(url: String) -> JsonResult {
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

#[tauri::command]
pub(crate) fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn sanitize_delete_path_rejects_roots_and_home() {
        assert!(sanitize_delete_path("").is_err());
        let home = dirs::home_dir().unwrap_or_default();
        if !home.as_os_str().is_empty() {
            assert!(sanitize_delete_path(&home.to_string_lossy()).is_err());
        }
        #[cfg(target_os = "windows")]
        {
            // Drive root: a single-component canonical path.
            assert!(sanitize_delete_path("C:\\").is_err());
        }
    }

    #[test]
    fn validate_system_path_rejects_traversal_and_injection() {
        assert!(validate_system_path("").is_err());
        assert!(validate_system_path("relative/path").is_err());
        assert!(validate_system_path("C:\\foo\0bar").is_err());
        let p = validate_system_path(&std::env::temp_dir().to_string_lossy())
            .expect("temp dir is absolute and exists");
        assert!(p.is_absolute());
    }

    #[test]
    fn path_snapshot_matches_unchanged_file_and_detects_swap() {
        let dir = std::env::temp_dir().join("diskraptor_toc_test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("target.txt");
        std::fs::write(&file, b"original").unwrap();

        let snap = PathSnapshot::capture(&file.to_string_lossy()).expect("capture ok");
        assert!(snap.still_matches(), "unchanged file must match");

        // Replace content â†’ identity changed â†’ guard must refuse.
        let mut f = std::fs::File::create(&file).unwrap();
        f.write_all(b"swapped").unwrap();
        assert!(!snap.still_matches(), "content change must be detected");

        // Delete â†’ guard must refuse.
        std::fs::remove_file(&file).unwrap();
        assert!(!snap.still_matches(), "deleted target must be detected");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_snapshot_rejects_directory_root() {
        #[cfg(target_os = "windows")]
        {
            assert!(PathSnapshot::capture("C:\\").is_err());
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(PathSnapshot::capture("/").is_err());
        }
    }
}
