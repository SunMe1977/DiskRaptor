//! Scan commands: start/cancel a scan, stream progress and chunks, and read
//! per-chunk children. State lives in `AppState` (declared in main.rs); these
//! commands are kept separate so the concurrency-heavy walker glue is isolated
//! from the rest of the command surface.
use crate::{AppState, JsonResult, LiveEntries, ScanResultData};
use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::format_size;
use diskraptor_scanner::streaming::chunker::CHUNK_SIZE;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

pub(crate) fn scan_config(
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
pub(crate) fn start_scan(path: String, follow_symlinks: Option<bool>, timeout_secs: Option<u64>, app: tauri::AppHandle) -> JsonResult {
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
    *scan.last_scan_path.lock() = Some(path.clone());
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
                let active_id = s.scan.active_scan_id.load(Ordering::Acquire);
                let data = ScanResultData {
                    arena: sr.arena, stats: sr.stats, scan_time_ms: elapsed,
                    errors: Vec::new(), termination,
                };
                // Cache the serialized result once per scan (see get_scan_result).
                let json = build_result_json(&data, active_id);
                *s.scan.result.lock() = Some(data);
                *s.scan.cached_result.lock() = Some((active_id, json));
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
pub(crate) fn scan_id_matches(state: &AppState, scan_id: Option<u64>) -> bool {
    match scan_id {
        Some(id) => id == state.scan.active_scan_id.load(Ordering::Acquire),
        None => true,
    }
}

pub(crate) fn scan_progress_data(state: &AppState) -> serde_json::Value {
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
        .map(|q| {
            // Only the most recent entries are shown in the live view; cap the
            // per-poll clone so a 1 Hz poll doesn't copy the whole ring buffer.
            let q = q.lock();
            let skip = q.len().saturating_sub(50);
            q.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default();
    serde_json::json!({
        "files_found": files, "dirs_found": dirs, "bytes_found": bytes,
        "is_running": is_running, "current_dir": cd,
        "elapsed_secs": elapsed, "phase": phase,
        "errors": errors, "live_entries": live,
    })
}

#[tauri::command]
pub(crate) fn get_scan_progress(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    JsonResult::ok(scan_progress_data(&state))
}

/// Build a single chunk from the arena on demand. Returns a clone-free borrow
/// of the arena slice so a 10k-node chunk is never copied on the hot path.
pub(crate) fn build_chunk(
    arena: &scanner::tree::TreeNodeArena,
    chunk_id: u32,
) -> Option<scanner::tree::BorrowedChunk<'_>> {
    let total = arena.nodes.len() as u32;
    let total_chunks = total.div_ceil(CHUNK_SIZE);
    if chunk_id >= total_chunks {
        return None;
    }
    let start: usize = (chunk_id as u64 * CHUNK_SIZE as u64) as usize;
    let end: usize = (((chunk_id as u64 + 1) * CHUNK_SIZE as u64).min(total as u64)) as usize;
    Some(scanner::tree::BorrowedChunk::new(
        chunk_id,
        total_chunks,
        total,
        start as u32,
        &arena.nodes[start..end],
    ))
}

/// Build the serialized `get_scan_result` payload from a finished scan.
fn build_result_json(d: &ScanResultData, active_id: u64) -> serde_json::Value {
    let sj = serde_json::json!({
        "total_files": d.stats.total_files, "total_dirs": d.stats.total_dirs,
        "total_size": d.stats.total_size, "scan_time_ms": d.scan_time_ms,
        "top_files": d.stats.top_files, "file_type_breakdown": d.stats.file_type_breakdown,
        "size_human": format_size(d.stats.total_size),
        "time_human": format!("{:.2}s", d.scan_time_ms as f64 / 1000.0),
        "termination": d.termination,
    });
    let total_chunks = (d.arena.len() as u32).div_ceil(CHUNK_SIZE);
    let ri = serde_json::json!({"root_index": 0, "total_nodes": d.arena.len(), "total_chunks": total_chunks});
    serde_json::json!({"stats": sj, "root_info": ri, "scan_id": active_id, "errors": []})
}

#[tauri::command]
pub(crate) fn get_scan_result(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let active_id = state.scan.active_scan_id.load(Ordering::Acquire);
    // Fast path: the scan thread already serialized the result once per scan.
    let cached = state.scan.cached_result.lock();
    if let Some((id, json)) = cached.as_ref() {
        if *id == active_id {
            return JsonResult::ok(json.clone());
        }
    }
    drop(cached);
    // Fallback: build on demand (e.g. cache not yet filled for this scan id).
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let json = build_result_json(d, active_id);
        drop(g);
        JsonResult::ok(json)
    } else {
        drop(g);
        JsonResult::err("No scan result")
    }
}

#[tauri::command]
pub(crate) fn get_chunk(state: State<AppState>, chunk_index: u32, scan_id: Option<u64>) -> JsonResult {
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
pub(crate) fn get_children(state: State<AppState>, node_index: u32, scan_id: Option<u64>) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let arena = &d.arena;
        if (node_index as usize) >= arena.nodes.len() {
            return JsonResult::ok(serde_json::json!([]));
        }
        // Borrow the children instead of cloning every node (serialized via
        // BorrowedNode, which also patches chunk_id like loadChunk expects).
        let mut children: Vec<scanner::tree::BorrowedNode> = Vec::new();
        let mut cur = arena.nodes[node_index as usize].first_child;
        while cur != u32::MAX {
            match arena.nodes.get(cur as usize) {
                Some(n) => {
                    let next = n.next_sibling;
                    children.push(scanner::tree::BorrowedNode::new(cur / CHUNK_SIZE, n));
                    cur = next;
                }
                None => break,
            }
        }
        // `children` borrows the arena, so `g` must stay alive through the
        // serialization (the lock is released when the function returns).
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
pub(crate) fn cancel_scan(state: State<AppState>) -> JsonResult {
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
pub(crate) fn release_scan(state: State<AppState>) -> JsonResult {
    *state.scan.result.lock() = None;
    JsonResult::ok_empty()
}

#[tauri::command]
pub(crate) fn get_stats(state: State<AppState>, scan_id: Option<u64>) -> JsonResult {
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
