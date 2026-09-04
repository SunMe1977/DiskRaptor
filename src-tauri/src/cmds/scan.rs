//! Scan commands: start/cancel a scan, stream progress and chunks, and read
//! per-chunk children. State lives in `AppState` (declared in main.rs); these
//! commands are kept separate so the concurrency-heavy walker glue is isolated
//! from the rest of the command surface.
use crate::{AppState, JsonResult, LiveEntries, ScanResultData};
use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::format_size;
use diskraptor_scanner::scanner::tree::{NodeType, TreeNodeArena};
use diskraptor_scanner::streaming::chunker::CHUNK_SIZE;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

/// Build a scan config whose walker-error list the caller can read after the
/// walk finishes (the walkers push "Access denied" / timeout entries into it).
/// Returns the config plus a handle on the same shared list.
pub(crate) fn scan_config(
    path: &str,
    follow_symlinks: bool,
    timeout_secs: u64,
    live: LiveEntries,
) -> (scanner::walker::ScanConfig, Arc<Mutex<Vec<String>>>) {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let cfg = scanner::walker::ScanConfig {
        root_path: path.into(),
        follow_symlinks,
        scan_timeout_secs: timeout_secs,
        errors: errors.clone(),
        cancelled: Some(Arc::new(AtomicBool::new(false))),
        live_entries: live,
        ..scanner::walker::ScanConfig::default()
    };
    (cfg, errors)
}

/// Clears `scan.running` when the scan thread exits — including when it panics
/// or is cancelled early — so a wedged flag can never block future scans.
struct ResetScanRunning {
    app: tauri::AppHandle,
}
impl Drop for ResetScanRunning {
    fn drop(&mut self) {
        let s = self.app.state::<AppState>();
        s.scan.running.store(false, Ordering::Release);
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
    let spawned = std::thread::Builder::new().name("scan".into()).spawn(move || {
        // Drop guard resets `running` even if this thread panics or returns
        // early; a permanently-true flag would otherwise reject every later
        // scan until the app is restarted.
        let _reset = ResetScanRunning { app: result_handle.clone() };
        let (config, scan_errors) = scan_config(&p, fs, ts, live);
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
                // Surface the walkers' per-entry failures (access denied, stuck
                // junctions, ...) that used to be silently dropped on success.
                let walk_errors = scan_errors.lock().clone();
                s.scan.errors.lock().extend(walk_errors.clone());
                let insights = compute_scan_insights(&sr.arena, &p);
                let data = ScanResultData {
                    arena: sr.arena, stats: sr.stats, scan_time_ms: elapsed,
                    errors: walk_errors, termination,
                    root_path: p.clone(),
                    insights,
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
        // `running` is cleared by the ResetScanRunning drop guard when this
        // thread exits (normal return, early return or panic).
    });
    if spawned.is_err() {
        // The thread could not be started; undo the running flag we set above.
        scan.scan.running.store(false, Ordering::Release);
        return JsonResult::err("Failed to start scan thread");
    }

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
        "insights": d.insights,
    });
    let total_chunks = (d.arena.len() as u32).div_ceil(CHUNK_SIZE);
    let ri = serde_json::json!({"root_index": 0, "total_nodes": d.arena.len(), "total_chunks": total_chunks});
    serde_json::json!({"stats": sj, "root_info": ri, "scan_id": active_id, "errors": d.errors})
}

// ── Plain-language scan insights (#4) ──────────────────────────────────────
//
// Computed once when a scan finishes and embedded in the cached result so the
// frontend never pays the arena pass again. Answers the two questions a scan
// result should answer without reading a diagram: "which folders dominate?"
// and "how much of this is old / never touched?".

/// Current time as Unix seconds (used by the age aggregation).
fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Rebuild the absolute path of an arena node by walking parent pointers to the
/// root (index 0) and joining the root path with the relative segment names.
fn arena_node_path(arena: &TreeNodeArena, root_path: &str, mut idx: usize) -> String {
    let mut segs: Vec<&str> = Vec::new();
    let mut guard = 0usize;
    while idx != 0 && idx < arena.nodes.len() && guard < 4096 {
        let n = &arena.nodes[idx];
        segs.push(&n.name);
        idx = n.parent as usize;
        guard += 1;
    }
    if segs.is_empty() {
        return root_path.to_string();
    }
    segs.reverse();
    let sep = if cfg!(target_os = "windows") { "\\" } else { "/" };
    let mut out = root_path.trim_end_matches(['/', '\\']).to_string();
    for s in segs {
        out.push_str(sep);
        out.push_str(s);
    }
    out
}

/// Compute the scan-insights payload for a finished arena.
pub(crate) fn compute_scan_insights(arena: &TreeNodeArena, root_path: &str) -> serde_json::Value {
    let total = arena.nodes.first().map(|n| n.size).unwrap_or(0);
    let now = now_unix_secs();

    // 1) Largest directories, skipping any folder nested under one already
    //    listed (so the list shows distinct space hogs, not a family tree).
    let mut candidates: Vec<(usize, u64)> = arena
        .nodes
        .iter()
        .enumerate()
        .skip(1)
        .filter(|(_, n)| n.node_type == NodeType::Directory && n.size > 0)
        .map(|(i, n)| (i, n.size))
        .collect();
    candidates.sort_unstable_by_key(|x| std::cmp::Reverse(x.1));
    let mut chosen: Vec<usize> = Vec::new();
    let mut chosen_set = std::collections::HashSet::new();
    for (i, _size) in candidates {
        if chosen.len() >= 8 {
            break;
        }
        // Reject if any ancestor (up to root) is already a chosen hog.
        let mut a = arena.nodes[i].parent as usize;
        let mut blocked = false;
        let mut g = 0usize;
        while a != 0 && a < arena.nodes.len() && g < 4096 {
            if chosen_set.contains(&a) {
                blocked = true;
                break;
            }
            a = arena.nodes[a].parent as usize;
            g += 1;
        }
        if blocked {
            continue;
        }
        chosen.push(i);
        chosen_set.insert(i);
    }
    let pct_of = |s: u64| -> f64 {
        if total == 0 {
            0.0
        } else {
            (s as f64 / total as f64 * 1000.0).round() / 10.0
        }
    };
    let top_dirs: Vec<serde_json::Value> = chosen
        .into_iter()
        .map(|i| {
            let n = &arena.nodes[i];
            serde_json::json!({
                "idx": i,
                "name": n.name,
                "path": arena_node_path(arena, root_path, i),
                "size": n.size,
                "size_human": format_size(n.size),
                "pct": pct_of(n.size),
                "files": n.file_count,
                "dirs": n.dir_count,
            })
        })
        .collect();

    // 2) File age distribution.
    const DAY: u64 = 86400;
    let mut counts: std::collections::BTreeMap<&'static str, (u64, u64)> = [
        ("lt_1m", (0, 0)),
        ("1m_6m", (0, 0)),
        ("6m_12m", (0, 0)),
        ("gt_1y", (0, 0)),
        ("unknown", (0, 0)),
    ]
    .into_iter()
    .collect();
    for n in arena.nodes.iter().skip(1) {
        if n.node_type != NodeType::File {
            continue;
        }
        let key = if n.mtime == 0 {
            "unknown"
        } else {
            let age = now.saturating_sub(n.mtime);
            if age < 30 * DAY {
                "lt_1m"
            } else if age < 180 * DAY {
                "1m_6m"
            } else if age < 365 * DAY {
                "6m_12m"
            } else {
                "gt_1y"
            }
        };
        let e = counts.entry(key).or_insert((0, 0));
        e.0 += 1;
        e.1 += n.size;
    }
    let mut ages: Vec<serde_json::Value> = Vec::new();
    for key in ["lt_1m", "1m_6m", "6m_12m", "gt_1y", "unknown"] {
        let (count, size) = counts[key];
        if count > 0 || size > 0 {
            ages.push(serde_json::json!({ "key": key, "count": count, "size": size, "pct": pct_of(size) }));
        }
    }
    let (old_count, old_size) = counts["gt_1y"];

    serde_json::json!({
        "total_size": total,
        "top_dirs": top_dirs,
        "ages": ages,
        "old_files": { "count": old_count, "size": old_size, "pct": pct_of(old_size) },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use diskraptor_scanner::scanner::tree::TreeNode;

    fn mk_node(
        name: &str,
        size: u64,
        parent: u32,
        depth: u16,
        mtime: u64,
        node_type: NodeType,
    ) -> TreeNode {
        TreeNode {
            name: name.to_string(),
            size,
            file_count: if node_type == NodeType::File { 1 } else { 0 },
            dir_count: if node_type == NodeType::Directory { 1 } else { 0 },
            node_type,
            parent,
            first_child: u32::MAX,
            next_sibling: u32::MAX,
            depth,
            chunk_id: 0,
            mtime,
        }
    }

    fn arena_for_tests() -> TreeNodeArena {
        let mut arena = TreeNodeArena::with_capacity(16);
        // Root size = aggregated total of everything below (as the walker
        // would leave it after finish_scan).
        let root = arena.alloc(mk_node("data", 1_000_000_000, u32::MAX, 0, 0, NodeType::Directory));
        let now = now_unix_secs();
        let big = arena.alloc(mk_node("Movies", 800_000_000, root, 1, now, NodeType::Directory));
        arena.alloc(mk_node("old.bin", 300_000_000, big, 2, now - 500 * 86400, NodeType::File));
        arena.alloc(mk_node("new.mp4", 500_000_000, big, 2, now - 5 * 86400, NodeType::File));
        let docs = arena.alloc(mk_node("Documents", 200_000_000, root, 1, now, NodeType::Directory));
        arena.alloc(mk_node("a.txt", 50_000_000, docs, 2, now - 100 * 86400, NodeType::File));
        arena.alloc(mk_node("b.txt", 150_000_000, docs, 2, now - 400 * 86400, NodeType::File));
        // Deeply nested hog must be skipped because Movies is already listed.
        arena.alloc(mk_node("archive", 700_000_000, big, 3, now, NodeType::Directory));
        arena
    }

    #[test]
    fn arena_path_reconstruction() {
        let arena = arena_for_tests();
        let idx = arena.nodes.len() - 1; // .../data/Movies/archive
        let p = arena_node_path(&arena, "C:\\data", idx);
        assert!(p.ends_with("archive") && p.contains("Movies"), "got {p}");
        let p2 = arena_node_path(&arena, "C:\\data", 1);
        assert!(p2.contains("Movies") && p2.ends_with("Movies"), "got {p2}");
    }

    #[test]
    fn insights_find_top_dirs_and_skip_nested() {
        let arena = arena_for_tests();
        let ins = compute_scan_insights(&arena, "C:\\data");
        let dirs = ins["top_dirs"].as_array().unwrap();
        // Movies (800 MB) listed, its nested archive (700 MB) skipped.
        let names: Vec<&str> = dirs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["Movies", "Documents"]);
        assert_eq!(dirs[0]["pct"].as_f64().unwrap(), 80.0); // 800/1000
        let path0 = dirs[0]["path"].as_str().unwrap();
        assert!(path0.contains("Movies") && path0.ends_with("Movies"), "got {path0}");
    }

    #[test]
    fn insights_age_buckets_old_files() {
        let arena = arena_for_tests();
        let now = now_unix_secs();
        let ins = compute_scan_insights(&arena, "C:\\data");
        let ages = ins["ages"].as_array().unwrap();
        // old.bin + b.txt are > 1y -> 450 MB old
        assert_eq!(ins["old_files"]["count"].as_u64().unwrap(), 2);
        assert_eq!(ins["old_files"]["size"].as_u64().unwrap(), 450_000_000);
        // new.mp4 (< 1 month) lands in the first bucket
        let lt_1m = ages.iter().find(|a| a["key"] == "lt_1m").unwrap();
        assert_eq!(lt_1m["count"].as_u64().unwrap(), 1);
        assert_eq!(lt_1m["size"].as_u64().unwrap(), 500_000_000);
        let _ = now;
    }
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

/// Substring search across every scanned node (directories + files). Used by
/// the Ctrl+J quick-jump. Returns `limit` matches with real absolute paths and
/// the arena index so the frontend can jump straight to them.
#[tauri::command]
pub(crate) fn search_tree(
    state: State<AppState>,
    query: String,
    limit: Option<usize>,
    scan_id: Option<u64>,
) -> JsonResult {
    if !scan_id_matches(&state, scan_id) {
        return JsonResult::err("Scan id is stale");
    }
    let q = query.trim().to_lowercase();
    if q.is_empty() || q.chars().count() < 1 {
        return JsonResult::ok(serde_json::json!([]));
    }
    let limit = limit.unwrap_or(50).min(300);
    let g = state.scan.result.lock();
    if let Some(ref d) = *g {
        let arena = &d.arena;
        let mut out: Vec<serde_json::Value> = Vec::new();
        // Rank prefix matches above substring matches.
        for pass in 0..2 {
            if out.len() >= limit {
                break;
            }
            for (i, n) in arena.nodes.iter().enumerate().skip(1) {
                if out.len() >= limit {
                    break;
                }
                let lower = n.name.to_lowercase();
                let hit = if pass == 0 {
                    lower.starts_with(&q)
                } else {
                    lower.contains(&q)
                };
                if !hit {
                    continue;
                }
                out.push(serde_json::json!({
                    "idx": i,
                    "name": n.name,
                    "path": arena_node_path(arena, &d.root_path, i),
                    "size": n.size,
                    "size_human": format_size(n.size),
                    "is_dir": n.node_type == NodeType::Directory,
                    "files": n.file_count,
                    "dirs": n.dir_count,
                }));
            }
        }
        JsonResult::ok(serde_json::json!(out))
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
            "insights": d.insights,
        });
        drop(g);
        JsonResult::ok(sj)
    } else {
        drop(g);
        JsonResult::err("No scan data")
    }
}
