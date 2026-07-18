// DiskRaptor Rust Scanner - C FFI for Qt integration
use crate::scanner::tree::{ScanStats, TreeNodeArena};
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
    pub current_dir: Mutex<String>,
    pub start_time: Mutex<Instant>,
    running: AtomicBool,
    cancelled: AtomicBool,
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

#[no_mangle]
pub extern "C" fn dr_start_scan(path: *const c_char) -> *mut c_char {
    let path_str = match unsafe { CStr::from_ptr(path) }.to_str() {
        Ok(s) => {
            #[cfg(windows)]
            { s.replace('/', "\\") }
            #[cfg(not(windows))]
            { s.to_string() }
        },
        Err(e) => return make_json_error(&format!("invalid path UTF-8: {}", e)),
    };
    let state = &*STATE;
    if state.running.swap(true, Ordering::Acquire) {
        return make_json_error("scan already running");
    }
    state.cancelled.store(false, Ordering::Release);
    let scan_id = state.scan_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.files_found.store(0, Ordering::Relaxed);
    state.dirs_found.store(0, Ordering::Relaxed);
    *state.current_dir.lock().unwrap() = path_str.clone();
    *state.start_time.lock().unwrap() = Instant::now();
    *state.result.lock().unwrap() = None;
    let path_clone = path_str.clone();

    std::thread::Builder::new()
        .name("scan".into())
        .spawn(move || {
            struct Guard;
            impl Drop for Guard {
                fn drop(&mut self) {
                    STATE.running.store(false, Ordering::Release);
                }
            }
            let _g = Guard;

            let state = &*STATE;
            let config = walker::ScanConfig {
                root_path: path_clone.clone(),
                ..walker::ScanConfig::default()
            };
            let progress = Box::new(move |files: u64, dirs: u64, msg: &str| {
                state.files_found.store(files, Ordering::Relaxed);
                state.dirs_found.store(dirs, Ordering::Relaxed);
                if !msg.is_empty() {
                    *state.current_dir.lock().unwrap() = msg.to_owned();
                }
            });

            if state.cancelled.load(Ordering::Acquire) {
                return;
            }

            match walker::scan_directory_with_progress(config, progress) {
                Ok(sr) => {
                    let elapsed = sr.stats.scan_time_ms;
                    // Generate root-only chunk (safe for any tree size)
                    let root_chunk = crate::streaming::chunker::make_root_chunk(&sr.arena);
                    let chunks_json = serde_json::to_string(&root_chunk).unwrap_or_default();
                    *state.result.lock().unwrap() = Some(ScanResultData {
                        scan_id,
                        arena: sr.arena,
                        stats: sr.stats,
                        scan_time_ms: elapsed,
                        chunks_json,
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
    let (files, dirs) = if has_result {
        let r = rg.as_ref().unwrap();
        (r.stats.total_files, r.stats.total_dirs)
    } else {
        (
            state.files_found.load(Ordering::Relaxed),
            state.dirs_found.load(Ordering::Relaxed),
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
    CString::new(
        serde_json::json!({
            "files_found": files, "dirs_found": dirs,
            "is_running": is_running, "current_dir": cd,
            "elapsed_secs": elapsed, "phase": phase,
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
        let cj = d.chunks_json.clone();
        let sj = serde_json::json!({"total_files":d.stats.total_files,"total_dirs":d.stats.total_dirs,"total_size":d.stats.total_size,"scan_time_ms":d.scan_time_ms,"top_files":d.stats.top_files,"file_type_breakdown":d.stats.file_type_breakdown,"size_human":format_size(d.stats.total_size),"time_human":format!("{:.2}s",d.scan_time_ms as f64/1000.0)});
        let tn = d.arena.len() as u32;
        let tc = if !d.chunks_json.is_empty() {
            if let Ok(chunks) = serde_json::from_str::<Vec<serde_json::Value>>(&d.chunks_json) {
                chunks.len() as u32
            } else {
                1
            }
        } else {
            0
        };
        let ri = serde_json::json!({"root_index":0,"total_nodes":tn,"total_chunks":tc});
        drop(g);
        CString::new(
            serde_json::json!({"stats":sj,"root_info":ri,"scan_id":sid,"chunks":cj}).to_string(),
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
        if let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(&d.chunks_json) {
            if (c as usize) < v.len() {
                return CString::new(v[c as usize].to_string()).unwrap().into_raw();
            }
        }
    }
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
