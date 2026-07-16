// DiskRaptor Rust Scanner — C FFI for Qt integration
//
// Exposes a pure Rust scanner (multi-threaded, Win32 NtQueryDirectoryFile)
// as a CDYLIB that the Qt C++ app loads via LoadLibrary / GetProcAddress.
//
// All functions take/return C strings (JSON). Caller must free returned
// strings with dr_free_string().

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use crate::scanner::tree::{ScanStats, TreeNodeArena};
use crate::scanner::walker::{self, ScanConfig};
use crate::streaming::chunker;

// ── Global scan state ─────────────────────────────────────────────
// Only one scan can run at a time (matching the Qt single-scanner model).

struct ScanState {
    /// The arena tree result (set when scan finishes).
    result: Mutex<Option<ScanResultData>>,
    /// Progress counters, updated from the scanner thread.
    pub files_found: AtomicU64,
    pub dirs_found: AtomicU64,
    pub current_dir: Mutex<String>,
    pub start_time: Mutex<Instant>,
    /// Whether a scan is currently in flight.
    running: AtomicBool,
    /// Cancellation flag checked by worker threads.
    cancelled: AtomicBool,
    /// Scan ID incremented on each start.
    scan_id: AtomicU64,
}

struct ScanResultData {
    scan_id: u64,
    arena: TreeNodeArena,
    stats: ScanStats,
    scan_time_ms: u64,
    chunks_json: String,
}

use std::sync::LazyLock;

static STATE: LazyLock<ScanState> = LazyLock::new(|| ScanState {
    result: Mutex::new(None),
    files_found: AtomicU64::new(0),
    dirs_found: AtomicU64::new(0),
    current_dir: Mutex::new(String::new()),
    start_time: Mutex::new(Instant::now()),
    running: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    scan_id: AtomicU64::new(0),
});

// ── FFI exports ──────────────────────────────────────────────────

/// Start a scan of the given path.
///
/// `path` — UTF-8 C string, the root directory to scan.
///
/// Returns a C string (JSON) with keys:
///   { "success": bool, "scan_id": u64, "error": "..." }
///
/// Caller must free the returned string with dr_free_string().
#[no_mangle]
pub extern "C" fn dr_start_scan(path: *const c_char) -> *mut c_char {
    let path_str = match unsafe { CStr::from_ptr(path) }.to_str() {
        Ok(s) => s.to_owned(),
        Err(e) => {
            return make_json_error(&format!("invalid path UTF-8: {}", e));
        }
    };

    // Prevent concurrent scans
    let state = &*STATE;
    if state.running.swap(true, Ordering::Acquire) {
        return make_json_error("scan already running");
    }

    // Reset state
    state.cancelled.store(false, Ordering::Release);
    let scan_id = state.scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.files_found.store(0, Ordering::Relaxed);
    state.dirs_found.store(0, Ordering::Relaxed);
    *state.current_dir.lock().unwrap() = path_str.clone();
    *state.start_time.lock().unwrap() = Instant::now();
    *state.result.lock().unwrap() = None;

    let path_clone = path_str.clone();

    // Spawn scan in a background thread.
    // The thread owns the scan lifecycle and writes results into STATE.
    std::thread::Builder::new()
        .name("diskraptor-scan".into())
        .spawn(move || {
            let state = &*STATE;
            let config = ScanConfig {
                root_path: path_clone.clone(),
                ..ScanConfig::default()
            };

            let progress = Box::new(move |files: u64, dirs: u64, msg: &str| {
                state.files_found.store(files, Ordering::Relaxed);
                state.dirs_found.store(dirs, Ordering::Relaxed);
                if !msg.is_empty() {
                    *state.current_dir.lock().unwrap() = msg.to_owned();
                }
            });

            // Only run scan if not cancelled
            if state.cancelled.load(Ordering::Acquire) {
                state.running.store(false, Ordering::Release);
                return;
            }

            let scan_start = Instant::now();
            match walker::scan_directory_with_progress(config, progress) {
                Ok(scan_result) => {
                    let elapsed = scan_start.elapsed().as_millis() as u64;

                    // Chunk the tree for streaming
                    let _root_info = chunker::get_root_info(&scan_result.arena);
                    let chunks = match chunker::chunk_tree(&scan_result.arena) {
                        Ok(c) => c,
                        Err(_) => vec![],
                    };

                    let chunks_json = serde_json::to_string(&chunks).unwrap_or_else(|_| "[]".into());

                    let data = ScanResultData {
                        scan_id,
                        arena: scan_result.arena,
                        stats: scan_result.stats,
                        scan_time_ms: elapsed,
                        chunks_json,
                    };

                    *state.result.lock().unwrap() = Some(data);
                    state.running.store(false, Ordering::Release);
                }
                Err(e) => {
                    eprintln!("[diskraptor_scanner] scan error: {}", e);
                    state.running.store(false, Ordering::Release);
                }
            }
        })
        .expect("failed to spawn scanner thread");

    let json = serde_json::json!({
        "success": true,
        "scan_id": scan_id,
    });
    CString::new(json.to_string()).unwrap().into_raw()
}

/// Get current scan progress as a JSON C string.
///
/// Returns: { "files_found": u64, "dirs_found": u64,
///            "is_running": bool, "current_dir": "...",
///            "elapsed_secs": u64, "phase": u64 }
///
/// Phase: 0=scanning, 1=building, 2=chunking, 3=done
#[no_mangle]
pub extern "C" fn dr_get_progress() -> *mut c_char {
    let state = &*STATE;
    let is_running = state.running.load(Ordering::Acquire);
    let has_result = state.result.lock().unwrap().is_some();
    let phase: u64 = if !is_running && has_result {
        3
    } else if is_running {
        0
    } else {
        3
    };

    let elapsed = state.start_time.lock().unwrap().elapsed().as_secs();
    let current_dir = state.current_dir.lock().unwrap().clone();

    let json = serde_json::json!({
        "files_found": state.files_found.load(Ordering::Relaxed),
        "dirs_found": state.dirs_found.load(Ordering::Relaxed),
        "is_running": is_running,
        "current_dir": current_dir,
        "elapsed_secs": elapsed,
        "phase": phase,
    });

    CString::new(json.to_string()).unwrap().into_raw()
}

/// Get the final scan result as a JSON C string.
///
/// Must be called only after progress shows phase=3.
/// Returns: { "stats": {...}, "root_info": {...}, "scan_id": u64 }
#[no_mangle]
pub extern "C" fn dr_get_result() -> *mut c_char {
    let state = &*STATE;
    let guard = state.result.lock().unwrap();

    if let Some(ref data) = *guard {
        let stats_json = serde_json::json!({
            "total_files": data.stats.total_files,
            "total_dirs": data.stats.total_dirs,
            "total_size": data.stats.total_size,
            "scan_time_ms": data.scan_time_ms,
            "top_files": data.stats.top_files,
            "file_type_breakdown": data.stats.file_type_breakdown,
            "size_human": format_size(data.stats.total_size),
            "time_human": format!("{:.2}s", data.scan_time_ms as f64 / 1000.0),
        });

        let total_nodes = data.arena.len() as u32;
        let total_chunks = if total_nodes > 0 {
            total_nodes.div_ceil(chunker::CHUNK_SIZE)
        } else {
            0
        };

        let root_info = serde_json::json!({
            "root_index": 0,
            "total_nodes": total_nodes,
            "total_chunks": total_chunks,
        });

        let json = serde_json::json!({
            "stats": stats_json,
            "root_info": root_info,
            "scan_id": data.scan_id,
            "chunks": data.chunks_json,
        });

        drop(guard);
        CString::new(json.to_string()).unwrap().into_raw()
    } else {
        drop(guard);
        CString::new("{}").unwrap().into_raw()
    }
}

/// Cancel the currently running scan. Returns true if a scan was cancelled.
#[no_mangle]
pub extern "C" fn dr_cancel_scan() -> bool {
    let state = &*STATE;
    if !state.running.load(Ordering::Acquire) {
        return false;
    }
    state.cancelled.store(true, Ordering::Release);
    true
}

/// Check if a scan is currently running.
#[no_mangle]
pub extern "C" fn dr_is_running() -> bool {
    STATE.running.load(Ordering::Acquire)
}

/// Free a C string returned by any dr_* function.
#[no_mangle]
pub extern "C" fn dr_free_string(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(s);
    }
}

// ── Helpers ──────────────────────────────────────────────────────

fn make_json_error(msg: &str) -> *mut c_char {
    // Don't leave stale running flag
    STATE.running.store(false, Ordering::Release);
    let json = serde_json::json!({
        "success": false,
        "error": msg,
    });
    CString::new(json.to_string()).unwrap().into_raw()
}

fn format_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes == 0 {
        return "0 B".into();
    }
    let bytes_f = bytes as f64;
    let unit_idx = (bytes_f.log10() / 3.0) as usize;
    let unit_idx = unit_idx.min(UNITS.len() - 1);
    let value = bytes_f / (1024u64.pow(unit_idx as u32) as f64);
    if unit_idx == 0 {
        format!("{} {}", bytes, UNITS[unit_idx])
    } else {
        format!("{:.2} {}", value, UNITS[unit_idx])
    }
}
