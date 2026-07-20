// DiskRaptor Rust Scanner - C FFI for Qt integration
use crate::scanner::tree::{ScanStats, TreeChunk, TreeNodeArena};
use crate::scanner::walker;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
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
pub extern "C" fn dr_start_scan(json_config: *const c_char) -> *mut c_char {
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
    *state.current_dir.lock().unwrap() = path_str.clone();
    *state.start_time.lock().unwrap() = Instant::now();
    *state.result.lock().unwrap() = None;
    let path_clone = path_str.clone();

    std::thread::Builder::new()
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
            let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let cancel_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            *state.cancel_flag.lock().unwrap() = Some(cancel_flag.clone());
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
                    *state.current_dir.lock().unwrap() = msg.to_owned();
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
                    let errs = errors.lock().unwrap().clone();
                    *state.errors.lock().unwrap() = errs.clone();
                    *state.result.lock().unwrap() = Some(ScanResultData {
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
        .ok();

    CString::new(serde_json::json!({"success":true,"scan_id":scan_id}).to_string())
        .unwrap()
        .into_raw()
}

#[no_mangle]
pub extern "C" fn dr_get_progress() -> *mut c_char {
    let state = &*STATE;
    let is_running = state.running.load(Ordering::Acquire);
    let rg = state.result.lock().unwrap();
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
    let elapsed = state.start_time.lock().unwrap().elapsed().as_secs();
    let cd = state.current_dir.lock().unwrap().clone();
    let errs: Vec<String> = state.errors.lock().unwrap().clone();
    let err_count = errs.len();
    let last_err = errs.last().cloned().unwrap_or_default();
    CString::new(
        serde_json::json!({
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
    .unwrap()
    .into_raw()
}

#[no_mangle]
pub extern "C" fn dr_get_result() -> *mut c_char {
    let g = STATE.result.lock().unwrap();
    if let Some(ref d) = *g {
        let sid = d.scan_id;
        let sj = serde_json::json!({"total_files":d.stats.total_files,"total_dirs":d.stats.total_dirs,"total_size":d.stats.total_size,"scan_time_ms":d.scan_time_ms,"top_files":d.stats.top_files,"file_type_breakdown":d.stats.file_type_breakdown,"size_human":format_size(d.stats.total_size),"time_human":format!("{:.2}s",d.scan_time_ms as f64/1000.0)});
        let tn = d.arena.len() as u32;
        let tc = d.chunks.len() as u32;
        let ri = serde_json::json!({"root_index":0,"total_nodes":tn,"total_chunks":tc});
        let errs: Vec<String> = d.errors.clone();
        drop(g);
        CString::new(
            serde_json::json!({"stats":sj,"root_info":ri,"scan_id":sid,"errors":errs}).to_string(),
        )
        .unwrap()
        .into_raw()
    } else {
        drop(g);
        CString::new("{}").unwrap().into_raw()
    }
}

#[no_mangle]
pub extern "C" fn dr_cancel_scan() -> bool {
    let s = &*STATE;
    if !s.running.load(Ordering::Acquire) {
        return false;
    }
    s.cancelled.store(true, Ordering::Release);
    // Also set the shared cancel flag that the walker checks
    if let Some(ref cf) = *s.cancel_flag.lock().unwrap() {
        cf.store(true, Ordering::Release);
    }
    true
}
#[no_mangle]
pub extern "C" fn dr_is_running() -> bool {
    STATE.running.load(Ordering::Acquire)
}
#[no_mangle]
pub extern "C" fn dr_get_chunk(c: u32) -> *mut c_char {
    let s = &*STATE;
    let g = s.result.lock().unwrap();
    if let Some(ref d) = *g {
        if (c as usize) < d.chunks.len() {
            if let Ok(json) = serde_json::to_string(&d.chunks[c as usize]) {
                drop(g);
                return CString::new(json).unwrap().into_raw();
            }
        }
    }
    drop(g);
    CString::new("{}").unwrap().into_raw()
}
#[no_mangle]
pub extern "C" fn dr_free_string(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(s);
    }
}

fn make_json_error(msg: &str) -> *mut c_char {
    STATE.running.store(false, Ordering::Release);
    CString::new(format!("{{\"success\":false,\"error\":\"{}\"}}", msg))
        .unwrap()
        .into_raw()
}
fn format_size(b: u64) -> String {
    const U: &[&str] = &["B", "KB", "MB", "GB", "TB", "PB"];
    if b == 0 {
        return "0 B".into();
    }
    let bf = b as f64;
    let i = (bf.log10() / 3.0) as usize;
    let i = i.min(U.len() - 1);
    let v = bf / (1024u64.pow(i as u32) as f64);
    if i == 0 {
        format!("{} {}", b, U[i])
    } else {
        format!("{:.2} {}", v, U[i])
    }
}
