// DiskRaptor Rust Scanner - C FFI for Qt integration
#![allow(clippy::missing_safety_doc)]
use crate::scanner::tree::{format_size, ScanStats, TreeChunk, TreeNodeArena};
use crate::scanner::walker;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use parking_lot::Mutex;
use std::time::Instant;

struct ScanState {
    result: Mutex<Option<ScanResultData>>,
    pub files_found: AtomicU64,
    pub dirs_found: AtomicU64,
    pub bytes_found: AtomicU64,
    pub current_dir: Mutex<String>,
    pub start_time: Mutex<Instant>,
    running: AtomicBool,
    cancelled: AtomicBool,
    cancel_flag: Mutex<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>>,
    scan_id: AtomicU64,
    pub errors: Mutex<Vec<String>>,
}
struct ScanResultData {
    scan_id: u64,
    arena: TreeNodeArena,
    stats: ScanStats,
    scan_time_ms: u64,
    chunks: Vec<TreeChunk>,
    errors: Vec<String>,
}

use std::sync::LazyLock;
static STATE: LazyLock<ScanState> = LazyLock::new(|| ScanState {
    result: Mutex::new(None),
    files_found: AtomicU64::new(0),
    dirs_found: AtomicU64::new(0),
    bytes_found: AtomicU64::new(0),
    current_dir: Mutex::new(String::new()),
    start_time: Mutex::new(Instant::now()),
    running: AtomicBool::new(false),
    cancelled: AtomicBool::new(false),
    cancel_flag: Mutex::new(None),
    scan_id: AtomicU64::new(0),
    errors: Mutex::new(Vec::new()),
});

#[no_mangle]
pub unsafe extern "C" fn dr_start_scan(json_config: *const c_char) -> *mut c_char {
    // SAFETY: `json_config` must be a valid, NUL-terminated UTF-8 C string
    // that remains valid for the duration of this call. The pointer is only
    // read here and never retained.
    if json_config.is_null() {
        return make_json_error("json_config is null");
    }
    let config_str = match unsafe { CStr::from_ptr(json_config) }.to_str() {
        Ok(s) => s.to_string(),
        Err(e) => return make_json_error(&format!("invalid config UTF-8: {}", e)),
    };
    // Parse JSON config
    let (path_str, follow_symlinks, timeout_secs) =
        match serde_json::from_str::<serde_json::Value>(&config_str) {
            Ok(v) => {
                let p = v.get("path").and_then(|s| s.as_str()).unwrap_or("");
                let fs = v
                    .get("follow_symlinks")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false);
                let ts = v.get("timeout_secs").and_then(|n| n.as_u64()).unwrap_or(0);
                #[cfg(windows)]
                {
                    (p.replace('/', "\\"), fs, ts)
                }
                #[cfg(not(windows))]
                {
                    (p.to_string(), fs, ts)
                }
            }
            Err(_) => {
                // Fallback: treat entire string as path
                let p = config_str.clone();
                #[cfg(windows)]
                {
                    (p.replace('/', "\\"), false, 0u64)
                }
                #[cfg(not(windows))]
                {
                    (p.to_string(), false, 0u64)
                }
            }
        };
    if path_str.is_empty() {
        return make_json_error("no path provided");
    }
    let state = &*STATE;
    if state.running.swap(true, Ordering::Acquire) {
        return make_json_error("scan already running");
    }
    state.cancelled.store(false, Ordering::Release);
    let scan_id = state.scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.files_found.store(0, Ordering::Relaxed);
    state.dirs_found.store(0, Ordering::Relaxed);
    state.bytes_found.store(0, Ordering::Relaxed);
    *state.current_dir.lock() = path_str.clone();
    *state.start_time.lock() = Instant::now();
    *state.result.lock() = None;
    state.errors.lock().clear();
    let path_clone = path_str.clone();

    let spawn_result = std::thread::Builder::new()
        .name("scan".into())
        .spawn(move || {
            eprintln!("[scan] starting scan of: {}", path_clone);
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    STATE.running.store(false, Ordering::Release);
                }
            }
            let _g = Guard;

            let state = &*STATE;
            let errors = std::sync::Arc::new(parking_lot::Mutex::new(Vec::new()));
            let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            *state.cancel_flag.lock() = Some(cancel_flag.clone());
            let config = walker::ScanConfig {
                root_path: path_clone.clone(),
                follow_symlinks,
                scan_timeout_secs: timeout_secs,
                errors: errors.clone(),
                cancelled: Some(cancel_flag),
                ..walker::ScanConfig::default()
            };
            let progress = Box::new(move |files: u64, dirs: u64, bytes: u64, msg: &str| {
                state.files_found.store(files, Ordering::Relaxed);
                state.dirs_found.store(dirs, Ordering::Relaxed);
                state.bytes_found.store(bytes, Ordering::Relaxed);
                if !msg.is_empty() {
                    *state.current_dir.lock() = msg.to_owned();
                }
            });

            if state.cancelled.load(Ordering::Acquire) {
                return;
            }

            match walker::scan_directory_with_progress(config, progress) {
                Ok(sr) => {
                    eprintln!(
                        "[scan] completed: {} files, {} dirs",
                        sr.stats.total_files, sr.stats.total_dirs
                    );
                    let elapsed = sr.stats.scan_time_ms;
                    let chunks = crate::streaming::chunker::chunk_tree(&sr.arena)
                        .unwrap_or_else(|_| crate::streaming::chunker::make_root_chunk(&sr.arena));
                    let errs = errors.lock().clone();
                    *state.errors.lock() = errs.clone();
                    *state.result.lock() = Some(ScanResultData {
                        scan_id,
                        arena: sr.arena,
                        stats: sr.stats,
                        scan_time_ms: elapsed,
                        chunks,
                        errors: errs,
                    });
                }
                Err(e) => {
                    let err_msg = format!("[scan] error: {}", e);
                    eprintln!("{}", err_msg);
                    let _ = std::fs::write(
                        std::env::temp_dir().join("diskraptor_scan_error.txt"),
                        &err_msg,
                    );
                }
            }
        })
        .map_err(|e| e.to_string())
        .map(std::mem::drop);

    if let Err(e) = spawn_result {
        // Thread creation failed (OS limit / OOM): reset the running flag so
        // future scans aren't blocked forever.
        state.running.store(false, Ordering::Release);
        return make_json_error(&format!("failed to spawn scan thread: {}", e));
    }

    to_c_string(&serde_json::json!({"success":true,"scan_id":scan_id}).to_string())
}

#[no_mangle]
pub unsafe extern "C" fn dr_get_progress() -> *mut c_char {
    let state = &*STATE;
    let is_running = state.running.load(Ordering::Acquire);
    let rg = state.result.lock();
    let has_result = rg.is_some();
    let (files, dirs, bytes) = if has_result {
        let r = rg.as_ref().unwrap();
        (r.stats.total_files, r.stats.total_dirs, r.stats.total_size)
    } else {
        (
            state.files_found.load(Ordering::Relaxed),
            state.dirs_found.load(Ordering::Relaxed),
            state.bytes_found.load(Ordering::Relaxed),
        )
    };
    drop(rg);
    let phase: u64 = if !is_running && has_result {
        3
    } else if is_running {
        0
    } else {
        3
    };
    let elapsed = state.start_time.lock().elapsed().as_secs();
    let cd = state.current_dir.lock().clone();
    let errs: Vec<String> = state.errors.lock().clone();
    let err_count = errs.len();
    let last_err = errs.last().cloned().unwrap_or_default();
    to_c_string(
        &serde_json::json!({
            "files_found": files, "dirs_found": dirs,
            "bytes_found": bytes,
            "is_running": is_running, "current_dir": cd,
            "elapsed_secs": elapsed, "phase": phase,
            "errors": errs,
            "error_count": err_count,
            "last_error": last_err,
        })
        .to_string(),
    )
}

#[no_mangle]
pub unsafe extern "C" fn dr_get_result() -> *mut c_char {
    let g = STATE.result.lock();
    if let Some(ref d) = *g {
        let sid = d.scan_id;
        let sj = serde_json::json!({"total_files":d.stats.total_files,"total_dirs":d.stats.total_dirs,"total_size":d.stats.total_size,"scan_time_ms":d.scan_time_ms,"top_files":d.stats.top_files,"file_type_breakdown":d.stats.file_type_breakdown,"size_human":format_size(d.stats.total_size),"time_human":format!("{:.2}s",d.scan_time_ms as f64/1000.0)});
        let tn = d.arena.len() as u32;
        let tc = d.chunks.len() as u32;
        let ri = serde_json::json!({"root_index":0,"total_nodes":tn,"total_chunks":tc});
        let errs: Vec<String> = d.errors.clone();
        drop(g);
        to_c_string(
            &serde_json::json!({"stats":sj,"root_info":ri,"scan_id":sid,"errors":errs}).to_string(),
        )
    } else {
        drop(g);
        to_c_string("{}")
    }
}

#[no_mangle]
pub unsafe extern "C" fn dr_cancel_scan() -> bool {
    let s = &*STATE;
    if !s.running.load(Ordering::Acquire) {
        return false;
    }
    s.cancelled.store(true, Ordering::Release);
    // Also set the shared cancel flag that the walker checks
    if let Some(ref cf) = *s.cancel_flag.lock() {
        cf.store(true, Ordering::Release);
    }
    true
}
#[no_mangle]
pub unsafe extern "C" fn dr_is_running() -> bool {
    STATE.running.load(Ordering::Acquire)
}
#[no_mangle]
pub unsafe extern "C" fn dr_get_chunk(c: u32) -> *mut c_char {
    let s = &*STATE;
    let g = s.result.lock();
    if let Some(ref d) = *g {
        if (c as usize) < d.chunks.len() {
            if let Ok(json) = serde_json::to_string(&d.chunks[c as usize]) {
                drop(g);
                return to_c_string(&json);
            }
        }
    }
    drop(g);
    to_c_string("{}")
}
#[no_mangle]
pub unsafe extern "C" fn dr_free_string(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    // SAFETY: `s` must be a pointer previously returned by this module via
    // `CString::into_raw` (e.g. from dr_start_scan / dr_get_result). Calling
    // from_raw with any other pointer is UB; the null check above covers the
    // sentinel case only.
    unsafe {
        let _ = CString::from_raw(s);
    }
}

fn make_json_error(msg: &str) -> *mut c_char {
    // NOTE: must NOT touch STATE.running here — it may be called while a scan
    // is still running (e.g. re-entry "scan already running"); resetting the
    // flag would corrupt dr_is_running() state.
    to_c_string(&format!("{{\"success\":false,\"error\":\"{}\"}}", msg))
}

/// Build a NUL-terminated C string from a Rust string. JSON payloads can
/// contain filenames that carry NUL bytes (legal on Linux), which would make
/// `CString::new` panic — so strip them and never panic across the FFI boundary.
fn to_c_string(s: &str) -> *mut c_char {
    match CString::new(s.replace('\0', "")) {
        Ok(c) => c.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}
#[no_mangle]
pub unsafe extern "C" fn dr_find_duplicates(path: *const c_char) -> *mut c_char {
    if path.is_null() {
        return make_json_error("path is null");
    }
    // SAFETY: `path` must be a valid, NUL-terminated C string that remains
    // valid for the duration of this call; it is only read, never retained.
    let path_str = unsafe { CStr::from_ptr(path) }.to_string_lossy().into_owned();

    let (dup_groups, total_files, wasted) = crate::scanner::duplicates::find_duplicate_groups(&path_str);
    let result = serde_json::json!({
        "groups": dup_groups,
        "totalFilesScanned": total_files,
        "totalGroups": dup_groups.len(),
        "totalDuplicates": dup_groups.iter().map(|g| g["count"].as_u64().unwrap_or(0) - 1).sum::<u64>(),
        "wastedBytes": wasted,
        "wastedHuman": format_size(wasted),
    });

    to_c_string(&result.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_size_zero() {
        assert_eq!(format_size(0), "0 B");
    }

    #[test]
    fn test_format_size_bytes() {
        assert_eq!(format_size(1), "1 B");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1023), "1023 B");
    }

    #[test]
    fn test_format_size_kb() {
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1536), "1.50 KB");
    }

    #[test]
    fn test_format_size_mb() {
        assert_eq!(format_size(1024 * 1024), "1.00 MB");
        assert_eq!(format_size(5 * 1024 * 1024), "5.00 MB");
    }

    #[test]
    fn test_format_size_gb() {
        assert_eq!(format_size(1024 * 1024 * 1024), "1.00 GB");
        assert_eq!(format_size(2 * 1024 * 1024 * 1024), "2.00 GB");
    }

    #[test]
    fn test_format_size_tb() {
        assert_eq!(format_size(1024u64.pow(4)), "1.00 TB");
    }

    #[test]
    fn test_format_size_large() {
        assert_eq!(format_size(3 * 1024u64.pow(4)), "3.00 TB");
    }
}
