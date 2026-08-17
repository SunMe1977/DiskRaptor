//! Duplicate-file scanner commands. The heavy lifting (size-grouping â†’ head
//! hash â†’ full-hash verification) lives in `scanner::duplicates`; these commands
//! drive it with progress phases and cancellation.
use crate::{AppState, JsonResult};
use diskraptor_scanner::scanner;
use diskraptor_scanner::scanner::tree::format_size;
use rayon::prelude::*;
use std::sync::atomic::Ordering;
use tauri::{Manager, State};

#[tauri::command]
pub(crate) fn find_duplicates(path: String, app: tauri::AppHandle) -> JsonResult {
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

        // Phase 1: collect files grouped by size. jwalk parallelizes the
        // directory I/O underneath (walkdir was fully sequential).
        let mut by_size: std::collections::HashMap<u64, Vec<std::path::PathBuf>> =
            std::collections::HashMap::new();
        let mut scanned: u64 = 0;
        // Throttle the "currently examined file" progress string: a lock + String
        // allocation per file is pure overhead for a value the UI polls at ~1 Hz.
        let mut last_file_update = std::time::Instant::now();
        let mut last_file_at: u64 = 0;
        for entry in jwalk::WalkDir::new(&path).into_iter() {
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
            let meta = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            scanned += 1;
            st.dup.files_scanned.store(scanned, Ordering::Relaxed);
            if scanned - last_file_at >= 1000 || last_file_update.elapsed().as_millis() >= 100 {
                *st.dup.current_file.lock() = e.path().to_string_lossy().to_string();
                last_file_at = scanned;
                last_file_update = std::time::Instant::now();
            }
            by_size.entry(meta.len()).or_default().push(e.path().to_path_buf());
            if scanned >= FILE_CAP {
                break;
            }
        }

        // Phase 2: head-hash candidate groups (same size) in parallel. Hashing
        // is I/O-bound, so rayon workers saturate the disk better than one
        // thread; hash_file_head reuses a thread-local read buffer.
        st.dup.phase.store(2, Ordering::Relaxed);
        let cancelled = &st.dup.cancelled;
        let files_scanned = &st.dup.files_scanned;
        let current_file = &st.dup.current_file;
        let pairs: Vec<((u64, u64), std::path::PathBuf)> = by_size
            .into_values()
            .filter(|g| g.len() >= 2)
            .collect::<Vec<_>>()
            .into_par_iter()
            .flat_map_iter(|group| {
                let mut out = Vec::with_capacity(group.len());
                for p in group {
                    if cancelled.load(Ordering::Relaxed) {
                        break;
                    }
                    let n = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
                    if n.is_multiple_of(500) {
                        *current_file.lock() = p.to_string_lossy().to_string();
                    }
                    let h = scanner::duplicates::hash_file_head(&p, scanner::duplicates::HEAD_HASH_BYTES);
                    out.push((h, p));
                }
                out
            })
            .collect();
        let mut by_hash: std::collections::HashMap<(u64, u64), Vec<std::path::PathBuf>> =
            std::collections::HashMap::new();
        for (h, p) in pairs {
            by_hash.entry(h).or_default().push(p);
        }

        // Phase 3: full verification of head-hash groups (parallel per group),
        // then build the result groups.
        st.dup.phase.store(3, Ordering::Relaxed);
        let mut groups = Vec::new();
        let mut wasted: u64 = 0;
        for ((size, _), files) in by_hash {
            if files.len() < 2 {
                continue;
            }
            // Full stream-hash each candidate in parallel: only files with
            // identical full content are true duplicates. Files that changed
            // while scanning are excluded so we never suggest deleting them.
            let verified: Vec<(std::path::PathBuf, (u64, u64))> = files
                .par_iter()
                .filter_map(|p| {
                    if cancelled.load(Ordering::Relaxed) {
                        return None;
                    }
                    let (fsize, fhash, changed) = scanner::duplicates::hash_file_full(p);
                    if changed || fsize != size {
                        return None;
                    }
                    Some((p.clone(), (fsize, fhash)))
                })
                .collect();
            let mut by_full: std::collections::HashMap<(u64, u64), Vec<std::path::PathBuf>> =
                std::collections::HashMap::new();
            for (p, h) in verified {
                by_full.entry(h).or_default().push(p);
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
pub(crate) fn get_dup_stats(state: State<AppState>) -> JsonResult {
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
pub(crate) fn get_dup_result(state: State<AppState>) -> JsonResult {
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
pub(crate) fn cancel_dup_scan(state: State<AppState>) -> JsonResult {
    state.dup.cancelled.store(true, Ordering::Release);
    JsonResult::ok_empty()
}
