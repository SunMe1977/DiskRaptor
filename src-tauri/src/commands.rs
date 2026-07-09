use crate::scanner::tree::*;
use crate::scanner::walker::{self, ScanConfig, ScanProgressCallback};
use crate::streaming::chunker::{self, ScanRootInfo};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

/// Holds state for an active scan.
pub struct ScanState {
    pub arena: TreeNodeArena,
    pub stats: ScanStats,
    pub chunks: Vec<TreeChunk>,
}

/// Live progress of a running scan.
pub struct ScanProgress {
    pub files_found: AtomicU64,
    pub dirs_found: AtomicU64,
    pub is_running: AtomicU64,
    pub phase: AtomicU64,
    pub current_dir: Mutex<String>,
    pub start_time: AtomicU64, // unix millis
    pub error: Mutex<Option<String>>,
}

impl ScanProgress {
    pub fn new() -> Arc<Self> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Arc::new(Self {
            files_found: AtomicU64::new(0),
            dirs_found: AtomicU64::new(0),
            is_running: AtomicU64::new(1),
            phase: AtomicU64::new(0),
            current_dir: Mutex::new(String::new()),
            start_time: AtomicU64::new(now),
            error: Mutex::new(None),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub scan_id: String,
    pub files_found: u64,
    pub dirs_found: u64,
    pub is_running: bool,
    pub phase: u64,
    pub current_dir: String,
    pub elapsed_secs: u64,
    pub error: Option<String>,
}

// Global state
static SCANS: OnceLock<Mutex<HashMap<String, Arc<ScanState>>>> = OnceLock::new();
static SCAN_PROGRESS: OnceLock<Mutex<HashMap<String, Arc<ScanProgress>>>> = OnceLock::new();

fn scans() -> &'static Mutex<HashMap<String, Arc<ScanState>>> {
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn scan_progress() -> &'static Mutex<HashMap<String, Arc<ScanProgress>>> {
    SCAN_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── Commands ─────────────────────────────────────────────────────────────

/// Start a scan in the background. Returns immediately with a scan ID.
/// Poll `get_scan_progress` and `get_scan_result` to track completion.
#[tauri::command]
pub fn start_scan(path: String) -> Result<ScanResponse, String> {
    let progress = ScanProgress::new();
    let scan_id = format!("scan_{}", chrono_id());
    scan_progress()
        .lock()
        .insert(scan_id.clone(), progress.clone());

    let path_c = path.clone();
    let scan_id_c = scan_id.clone();
    let prog = progress.clone();

    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let config = ScanConfig {
            root_path: path_c.clone(),
            ..Default::default()
        };
        let prog_cb = prog.clone();
        let progress_cb: ScanProgressCallback = Box::new(move |files, dirs, current_dir| {
            prog_cb.files_found.store(files, Ordering::Relaxed);
            prog_cb.dirs_found.store(dirs, Ordering::Relaxed);
            if !current_dir.is_empty() {
                *prog_cb.current_dir.lock() = current_dir.to_string();
            }
        });

        // Phase 1: Scanning
        let scan_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            walker::scan_directory_with_progress(config, progress_cb)
        }))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Scan panicked")));
        match scan_result {
            Ok(result) => {
                // Phase 2: Building tree
                prog.phase.store(1, Ordering::Relaxed);

                match chunker::chunk_tree(&result.arena) {
                    Ok(chunks) => {
                        // Phase 3: Chunking done, storing result
                        prog.phase.store(2, Ordering::Relaxed);
                        let scan_state = Arc::new(ScanState {
                            arena: result.arena,
                            stats: result.stats,
                            chunks,
                        });
                        scans().lock().insert(scan_id_c.clone(), scan_state);
                        prog.is_running.store(0, Ordering::Relaxed);
                        prog.phase.store(3, Ordering::Relaxed);
                        log::info!("Scan {} completed in {:?}", scan_id_c, start.elapsed());
                    }
                    Err(e) => {
                        prog.is_running.store(0, Ordering::Relaxed);
                        *prog.error.lock() = Some(format!("Chunking failed: {}", e));
                        log::error!("Chunking failed for {}: {}", scan_id_c, e);
                    }
                }
            }
            Err(e) => {
                prog.is_running.store(0, Ordering::Relaxed);
                *prog.error.lock() = Some(format!("Scan failed: {}", e));
                log::error!("Scan {} failed: {}", scan_id_c, e);
            }
        }
    });

    // Return immediately with scan ID and no stats yet
    Ok(ScanResponse {
        scan_id,
        root_info: chunker::ScanRootInfo {
            root_index: 0,
            total_nodes: 0,
            total_chunks: 0,
        },
        stats: ScanStats {
            total_files: 0,
            total_dirs: 0,
            total_size: 0,
            scan_time_ms: 0,
            top_files: vec![],
            file_type_breakdown: vec![],
        },
    })
}

/// Check if a scan has finished and return its result.
#[tauri::command]
pub fn get_scan_result(scan_id: String) -> Result<Option<ScanResponse>, String> {
    let scans_lock = scans().lock();
    if let Some(state) = scans_lock.get(&scan_id) {
        let root_info = chunker::get_root_info(&state.arena);
        let stats = state.stats.clone();
        Ok(Some(ScanResponse {
            scan_id,
            root_info,
            stats,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_scan_progress(scan_id: String) -> Result<ProgressPayload, String> {
    let p = scan_progress().lock();
    let prog = p.get(&scan_id).ok_or_else(|| "No such scan".to_string())?;
    let error = prog.error.lock().clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let elapsed = (now - prog.start_time.load(Ordering::Relaxed)) / 1000;
    let dir = prog.current_dir.lock().clone();
    Ok(ProgressPayload {
        scan_id: scan_id.clone(),
        files_found: prog.files_found.load(Ordering::Relaxed),
        dirs_found: prog.dirs_found.load(Ordering::Relaxed),
        is_running: prog.is_running.load(Ordering::Relaxed) == 1,
        phase: prog.phase.load(Ordering::Relaxed),
        current_dir: dir,
        elapsed_secs: elapsed,
        error,
    })
}

#[tauri::command]
pub fn get_chunk(scan_id: String, chunk_index: u32) -> Result<TreeChunk, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    let chunk = state
        .chunks
        .get(chunk_index as usize)
        .ok_or_else(|| {
            format!(
                "Chunk {} out of range (total: {})",
                chunk_index,
                state.chunks.len()
            )
        })?
        .clone();
    Ok(chunk)
}

#[tauri::command]
pub fn get_stats(scan_id: String) -> Result<ScanStats, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    Ok(state.stats.clone())
}

#[tauri::command]
pub fn get_children(scan_id: String, node_index: u32) -> Result<Vec<TreeNode>, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    let node = state
        .arena
        .nodes
        .get(node_index as usize)
        .ok_or_else(|| format!("Node {} not found", node_index))?;

    let mut children = Vec::new();
    let mut child = node.first_child;
    while child != u32::MAX {
        children.push(state.arena.nodes[child as usize].clone());
        child = state.arena.nodes[child as usize].next_sibling;
    }
    children.sort_unstable_by_key(|b| std::cmp::Reverse(b.size));
    Ok(children)
}

#[tauri::command]
pub fn release_scan(scan_id: String) -> Result<(), String> {
    scans().lock().remove(&scan_id);
    scan_progress().lock().remove(&scan_id);
    Ok(())
}

/// Open file explorer at the given path.
/// For files: opens parent directory and selects the file.
/// For directories: opens the directory directly.
#[tauri::command]
pub fn open_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::path::Path;
        use std::process::Command;
        let p = Path::new(&path);
        if p.is_dir() {
            // Open directory directly
            let status = Command::new("explorer").arg(&path).spawn();
            match status {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to open explorer: {}", e)),
            }
        } else {
            // Open parent directory and select the file
            let status = Command::new("explorer").args(["/select,", &path]).spawn();
            match status {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to open explorer: {}", e)),
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::path::Path;
        use std::process::Command;
        let p = Path::new(&path);
        if p.is_dir() {
            let status = Command::new("open").arg(&path).spawn();
            match status {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to open: {}", e)),
            }
        } else {
            // Reveal in Finder
            let status = Command::new("open").args(["-R", &path]).spawn();
            match status {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to reveal: {}", e)),
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::path::Path;
        use std::process::Command;
        let p = Path::new(&path);
        if p.is_dir() {
            let status = Command::new("xdg-open").arg(&path).spawn();
            match status {
                Ok(_) => Ok(()),
                Err(e) => Err(format!("Failed to open: {}", e)),
            }
        } else {
            // Open parent folder
            if let Some(parent) = p.parent() {
                let status = Command::new("xdg-open").arg(parent).spawn();
                match status {
                    Ok(_) => Ok(()),
                    Err(e) => Err(format!("Failed to open: {}", e)),
                }
            } else {
                Err("Cannot determine parent directory".into())
            }
        }
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err(String::from("unsupported platform"))
}

/// Open file/folder properties dialog.
/// On Windows: uses ShellExecuteExW with "properties" verb (native dialog).
/// On macOS: reveals in Finder. On Linux: opens in file manager.
#[tauri::command]
pub fn open_properties(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::{
            ShellExecuteExW, SEE_MASK_INVOKEIDLIST, SHELLEXECUTEINFOW,
        };

        let wide_path: Vec<u16> = OsStr::new(&path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let verb: Vec<u16> = OsStr::new("properties")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mut sei = SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_INVOKEIDLIST,
            hwnd: HWND::default(),
            lpVerb: windows::core::PCWSTR::from_raw(verb.as_ptr()),
            lpFile: windows::core::PCWSTR::from_raw(wide_path.as_ptr()),
            lpParameters: windows::core::PCWSTR::null(),
            lpDirectory: windows::core::PCWSTR::null(),
            nShow: 5,
            ..Default::default()
        };

        let result = unsafe { ShellExecuteExW(&mut sei as *mut SHELLEXECUTEINFOW) };
        if result.as_bool() {
            Ok(())
        } else {
            Err("Failed to open properties".to_string())
        }
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        match Command::new("open").args(["-R", &path]).spawn() {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open properties: {}", e)),
        }
    }
    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let result = Command::new("nautilus")
            .arg(&path)
            .spawn()
            .or_else(|_| Command::new("dolphin").arg(&path).spawn());
        match result {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("Failed to open properties: {}", e)),
        }
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    Err(String::from("unsupported platform"))
}

/// Open a terminal at the given directory path (cross-platform).
#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    use std::process::Command;
    #[cfg(windows)]
    let status = Command::new("cmd")
        .args(["/c", "start", "cmd", "/k", "cd", "/d", &path])
        .spawn();
    #[cfg(target_os = "macos")]
    let status = Command::new("open").args(["-a", "Terminal", &path]).spawn();
    #[cfg(target_os = "linux")]
    let status = Command::new("x-terminal-emulator")
        .arg(&path)
        .spawn()
        .or_else(|_| Command::new("gnome-terminal").arg(&path).spawn())
        .or_else(|_| Command::new("konsole").arg("--workdir").arg(&path).spawn());
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    let status = Err(std::io::Error::new(
        std::io::ErrorKind::Other,
        "unsupported platform",
    ));
    match status {
        Ok(_) => Ok(()),
        Err(e) => Err(format!("Failed to open terminal: {}", e)),
    }
}

/// Delete a file or directory at the given path.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        std::fs::remove_file(p).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

/// Check if a directory requires admin rights to scan fully.
/// Tries to access a known protected system folder.
#[cfg(not(windows))]
#[tauri::command]
pub fn check_admin_needed(_path: String) -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
#[tauri::command]
pub fn check_admin_needed(path: String) -> Result<bool, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{FindFirstFileW, WIN32_FIND_DATAW};

    let test_paths = vec![
        format!(
            "{}\\System Volume Information\\*",
            path.trim_end_matches('\\')
        ),
        format!("{}\\$RECYCLE.BIN\\*", path.trim_end_matches('\\')),
    ];
    for test in &test_paths {
        let w: Vec<u16> = OsStr::new(test)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let mut fd = WIN32_FIND_DATAW::default();
            let h = FindFirstFileW(windows::core::PCWSTR::from_raw(w.as_ptr()), &mut fd);
            if let Err(e) = h {
                let code = e.code().0;
                // ERROR_ACCESS_DENIED = 5
                if code == 5 {
                    return Ok(true);
                }
            } else {
                let _ = windows::Win32::Storage::FileSystem::FindClose(h.unwrap());
            }
        }
    }
    Ok(false)
}

/// Restart the application as Administrator (UAC prompt).
#[cfg(not(windows))]
#[tauri::command]
pub fn restart_as_admin() -> Result<(), String> {
    Err("Admin restart is only available on Windows".into())
}

#[cfg(windows)]
#[tauri::command]
pub fn restart_as_admin() -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let exe = std::env::current_exe().map_err(|e| format!("Cannot get exe path: {}", e))?;
    let exe_str = exe.to_string_lossy().to_string();

    let w_path: Vec<u16> = OsStr::new(&exe_str)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let verb: Vec<u16> = OsStr::new("runas")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: isize,
            lpOperation: *const u16,
            lpFile: *const u16,
            lpParameters: *const u16,
            lpDirectory: *const u16,
            nShowCmd: i32,
        ) -> isize;
    }

    unsafe {
        let ret = ShellExecuteW(
            0,
            verb.as_ptr(),
            w_path.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            5, // SW_SHOW
        );
        // ShellExecute returns > 32 on success
        if ret as usize <= 32 {
            return Err(format!("ShellExecuteW failed: ret={}", ret));
        }
    }

    // Exit the current (non-elevated) instance
    std::process::exit(0);
}

/// Get a 16x16 Windows shell icon as base64 RGBA data.
#[cfg(windows)]
#[tauri::command]
pub fn get_icon(path: String, is_dir: bool) -> Result<String, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
    };

    // Raw Win32 API declarations not in windows crate v0.39
    #[link(name = "user32")]
    extern "system" {
        fn DrawIconEx(
            hdc: isize,
            x: i32,
            y: i32,
            hicon: isize,
            cx: i32,
            cy: i32,
            istepifani: u32,
            hbrflickerfreedraw: isize,
            diflags: u32,
        ) -> i32;
        fn DestroyIcon(hicon: isize) -> i32;
    }
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateCompatibleDC(hdc: isize) -> isize;
        fn CreateDIBSection(
            hdc: isize,
            pbmi: *const std::ffi::c_void,
            usage: u32,
            ppvbits: *mut *mut std::ffi::c_void,
            hsection: isize,
            offset: u32,
        ) -> isize;
        fn SelectObject(hdc: isize, hgdiobj: isize) -> isize;
        fn DeleteDC(hdc: isize) -> i32;
        fn DeleteObject(ho: isize) -> i32;
        fn GetDC(hwnd: isize) -> isize;
        fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
    }

    let w: Vec<u16> = OsStr::new(&path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        let mut sfi: SHFILEINFOW = std::mem::zeroed();
        let attr = if is_dir {
            FILE_FLAGS_AND_ATTRIBUTES(0x10u32) // FILE_ATTRIBUTE_DIRECTORY
        } else {
            FILE_FLAGS_AND_ATTRIBUTES(0x80u32) // FILE_ATTRIBUTE_NORMAL
        };
        let ret = SHGetFileInfoW(
            windows::core::PCWSTR::from_raw(w.as_ptr()),
            attr,
            &mut sfi,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
        );
        if ret == 0 {
            return Err("SHGetFileInfoW failed".into());
        }

        let hicon = sfi.hIcon.0 as isize;
        if hicon == 0 {
            return Err("No icon".into());
        }

        let hdc_screen = GetDC(0);
        let hdc = CreateCompatibleDC(hdc_screen);
        if hdc == 0 {
            let _ = ReleaseDC(0, hdc_screen);
            DestroyIcon(hicon);
            return Err("CreateCompatibleDC failed".into());
        }

        // BITMAPINFOHEADER for 16x16 32-bit top-down DIB
        let mut bi_header: [u32; 11] = [
            40, // biSize
            16, // biWidth
            16, // biHeight (positive = bottom-up, but we handle it)
            1,  // biPlanes
            32, // biBitCount
            0,  // biCompression (BI_RGB)
            0,  // biSizeImage
            0, 0, 0, 0, // biClrUsed, biClrImportant
        ];
        // Set biHeight negative for top-down
        bi_header[2] = 0xFFFFFFF0u32; // -16 in unsigned u32 (two's complement)

        let mut pixel_ptr: *mut std::ffi::c_void = ptr::null_mut();
        let hbmp = CreateDIBSection(
            hdc,
            &bi_header as *const u32 as *const std::ffi::c_void,
            0, // DIB_RGB_COLORS
            &mut pixel_ptr,
            0,
            0,
        );
        if hbmp == 0 {
            let _ = ReleaseDC(0, hdc_screen);
            let _ = DeleteDC(hdc);
            DestroyIcon(hicon);
            return Err("CreateDIBSection failed".into());
        }

        SelectObject(hdc, hbmp);

        // Draw the icon at 16x16
        DrawIconEx(hdc, 0, 0, hicon, 16, 16, 0, 0, 3);

        // Copy pixels and swap BGR to RGB, also handle top-down vs bottom-up
        let src = pixel_ptr as *const u8;
        let mut pixels = vec![0u8; 16 * 16 * 4];
        // The DIB might be bottom-up (if height > 0), so flip rows
        // Since we set height = -16 (in two's complement as 0xFFFFFFF0),
        // but that might not work. Let's use height = 16 (bottom-up) and flip.
        // Actually let's just use height=16 and flip rows
        for y in 0..16 {
            let src_row = src.wrapping_add((15 - y) * 64);
            let dst_start = y * 64;
            for x in 0..16 {
                let si = x * 4;
                let di = dst_start + x * 4;
                pixels[di] = *src_row.add(si + 2).wrapping_add(0); // R
                pixels[di + 1] = *src_row.add(si + 1);
                pixels[di + 2] = *src_row.add(si);
                pixels[di + 3] = *src_row.add(si + 3);
            }
        }

        // Cleanup
        DestroyIcon(hicon);
        let _ = ReleaseDC(0, hdc_screen);
        let _ = DeleteDC(hdc);
        let _ = DeleteObject(hbmp);

        Ok(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &pixels,
        ))
    }
}

/// Icons are currently only implemented on Windows.
#[cfg(not(windows))]
#[tauri::command]
pub fn get_icon(_path: String, _is_dir: bool) -> Result<String, String> {
    Err("Icons only available on Windows".into())
}

// ── Response types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ScanResponse {
    pub scan_id: String,
    pub root_info: ScanRootInfo,
    pub stats: ScanStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickDirectoryResponse {
    pub path: Option<String>,
}

/// Open a native directory picker dialog using the OS file dialog.
#[tauri::command]
pub fn pick_directory() -> Result<String, String> {
    // Use `rfd` for native file dialog
    rfd::FileDialog::new()
        .set_title("Select directory to scan")
        .pick_folder()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .ok_or_else(|| "No directory selected".into())
}

fn chrono_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}
