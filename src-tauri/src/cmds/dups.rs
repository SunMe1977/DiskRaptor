//! Duplicate-file scanner commands. The heavy lifting (size-grouping â†’ head
//! hash â†’ full-hash verification) lives in `scanner::duplicates`; these commands
//! drive it with progress phases and cancellation.
use crate::{AppState, JsonResult, scanner};
use crate::scanner::tree::format_size;
use rayon::prelude::*;
use std::sync::atomic::Ordering;
use tauri::{Manager, State};

/// Keep duplicate hashing responsive on rotational and external drives.  The
/// global Rayon pool may use every logical CPU, which turns random reads into
/// seek contention and can starve the UI/scanner.  Four workers is enough to
/// saturate typical storage while leaving capacity for the app.
///
/// Pool construction validates the config up front; a failure returns an
/// error instead of panicking the duplicate-scan thread.
fn duplicate_hash_pool() -> Result<rayon::ThreadPool, String> {
    let workers = std::thread::available_parallelism()
        .map(|n| n.get().saturating_sub(1).clamp(1, 4))
        .unwrap_or(2);
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .thread_name(|i| format!("dup-hash-{i}"))
        .build()
        .map_err(|e| format!("duplicate hash pool: {e}"))
}

/// Run `op` on the dedicated pool, falling back to the global Rayon pool when
/// the dedicated pool could not be built. The fallback still hashes in
/// parallel (via the global pool) instead of panicking the scan thread.
fn install_on<T, F>(pool: Option<&rayon::ThreadPool>, op: F) -> T
where
    T: Send,
    F: FnOnce() -> T + Send,
{
    match pool {
        Some(p) => p.install(op),
        None => op(),
    }
}

/// A same-size candidate awaiting hashing: `(path, length, mtime)`. The length
/// and mtime snapshot is used in phase 3 to detect a concurrent change via a
/// cheap re-stat instead of re-reading files whose head hash covered the whole
/// file.
type Candidate = (std::path::PathBuf, u64, Option<std::time::SystemTime>);

/// A hashed candidate: `((bytes_read, hash), path, length, mtime)`.
type HashedCandidate = ((u64, u64), std::path::PathBuf, u64, Option<std::time::SystemTime>);

/// Verify one head-hash candidate against its full content.
/// Returns the full-hash grouping key `(file_size, full_hash)`, or `None` when
/// the file changed mid-scan or can no longer be read, so we never suggest
/// deleting a file whose content we did not fully verify.
///
/// `len0` is the length recorded for this path in phase 1 (size grouping).
/// It — not the head-hash byte count — is the reference the full re-read must
/// agree with; otherwise files larger than `HEAD_HASH_BYTES` could never be
/// confirmed as duplicates.
fn verify_candidate(
    bytes_read: u64,
    head_hash: u64,
    path: &std::path::Path,
    len0: u64,
    mtime0: Option<std::time::SystemTime>,
) -> Option<(u64, u64)> {
    if bytes_read == len0 {
        // The head read covered the entire file, so its digest
        // *is* the full hash. Re-stat instead of re-reading the
        // bytes to confirm the file did not change meanwhile.
        let m = std::fs::metadata(path).ok()?;
        if m.len() != len0 || m.modified().ok() != mtime0 {
            return None;
        }
        Some((bytes_read, head_hash))
    } else {
        let (fsize, fhash, changed) = scanner::duplicates::hash_file_full(path);
        if changed || fsize != len0 {
            return None;
        }
        Some((fsize, fhash))
    }
}

/// Clears `dup.running` when the duplicate-scan thread exits — including on a
/// panic or an early return — so a wedged flag can't block future scans.
struct ResetDupRunning {
    app: tauri::AppHandle,
}
impl Drop for ResetDupRunning {
    fn drop(&mut self) {
        let s = self.app.state::<AppState>();
        s.dup.running.store(false, Ordering::Release);
    }
}

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
    let spawned = std::thread::Builder::new().name("dup-scan".into()).spawn(move || {
        // Drop guard resets `running` even if this thread panics or exits early.
        let _reset = ResetDupRunning { app: handle.clone() };
        let st = handle.state::<AppState>();
        const FILE_CAP: u64 = 200_000;

        // Phase 1: collect files grouped by size. Each entry also keeps the
        // metadata snapshot (length + mtime) used in phase 3 to detect a
        // concurrent change *without* re-reading files whose head hash already
        // covered the whole file. jwalk parallelizes the directory I/O.
        let mut by_size: std::collections::HashMap<u64, Vec<Candidate>> =
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
            by_size
                .entry(meta.len())
                .or_default()
                .push((e.path().to_path_buf(), meta.len(), meta.modified().ok()));
            if scanned >= FILE_CAP {
                break;
            }
        }

        // Phase 2: head-hash every candidate file in parallel. Candidates are
        // flattened out of the same-size groups first so a single dominant
        // group (e.g. thousands of identically-sized logs) cannot starve the
        // rayon pool by occupying one whole task.
        st.dup.phase.store(2, Ordering::Relaxed);
        let cancelled = &st.dup.cancelled;
        let files_scanned = &st.dup.files_scanned;
        let current_file = &st.dup.current_file;
        let candidates: Vec<Candidate> = by_size
            .into_values()
            .filter(|g| g.len() >= 2)
            .flatten()
            .collect();
        let hash_pool = duplicate_hash_pool().ok();
        let hashed: Vec<HashedCandidate> = install_on(hash_pool.as_ref(), || candidates
                .into_par_iter()
                .filter_map(|(p, len0, mtime0)| {
                    if cancelled.load(Ordering::Relaxed) {
                        return None;
                    }
                    let n = files_scanned.fetch_add(1, Ordering::Relaxed) + 1;
                    if n.is_multiple_of(500) {
                        *current_file.lock() = p.to_string_lossy().to_string();
                    }
                    let (bytes, hash) =
                        scanner::duplicates::hash_file_head(&p, scanner::duplicates::HEAD_HASH_BYTES);
                    Some(((bytes, hash), p, len0, mtime0))
                })
                .collect());
        let mut by_hash: std::collections::HashMap<(u64, u64), Vec<Candidate>> =
            std::collections::HashMap::new();
        for ((bytes_read, hash), p, len0, mtime0) in hashed {
            by_hash.entry((bytes_read, hash)).or_default().push((p, len0, mtime0));
        }

        // Phase 3: full verification of head-hash groups (parallel per group),
        // then build the result groups.
        st.dup.phase.store(3, Ordering::Relaxed);
        let mut groups = Vec::new();
        let mut wasted: u64 = 0;
        for ((bytes_read, head_hash), files) in by_hash {
            if files.len() < 2 {
                continue;
            }
            // Full stream-hash each candidate in parallel: only files with
            // identical full content are true duplicates. Files that changed
            // while scanning are excluded so we never suggest deleting them.
            let verified: Vec<(std::path::PathBuf, (u64, u64))> = install_on(hash_pool.as_ref(), || files
                .into_par_iter()
                .filter_map(|(p, len0, mtime0)| {
                    if cancelled.load(Ordering::Relaxed) {
                        return None;
                    }
                    let key = verify_candidate(bytes_read, head_hash, &p, len0, mtime0)?;
                    Some((p, key))
                })
                .collect());
            let mut by_full: std::collections::HashMap<(u64, u64), Vec<std::path::PathBuf>> =
                std::collections::HashMap::new();
            for (p, h) in verified {
                by_full.entry(h).or_default().push(p);
            }
            for ((file_size, _fh), dup_files) in by_full {
                if dup_files.len() < 2 {
                    continue;
                }
                // `bytes_read` is only the head-hash length for large files.
                // The verified full-hash key carries the real file size.
                let wasted_g = file_size * (dup_files.len() as u64 - 1);
                wasted += wasted_g;
                let paths: Vec<String> = dup_files
                    .iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                groups.push(serde_json::json!({
                    "count": dup_files.len(),
                    "size": file_size,
                    "sizeHuman": format_size(file_size),
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
        // Phase 3 is full-hash verification; only signal completion after the
        // result vector has been stored, otherwise the UI can fetch an empty
        // result while a large final group is still being processed.
        st.dup.phase.store(4, Ordering::Release);
        // `running` is cleared by the ResetDupRunning drop guard on exit.
    });
    if spawned.is_err() {
        // Thread could not be started; undo the running flag we set above.
        st.dup.running.store(false, Ordering::Release);
        return JsonResult::err("Failed to start duplicate scan thread");
    }

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
pub(crate) fn get_dup_result(
    state: State<AppState>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> JsonResult {
    let groups = state.dup.groups.lock();
    let wasted = *state.dup.wasted_bytes.lock();
    let total_groups = groups.len();
    let start = offset.unwrap_or(0).min(total_groups);
    // A bounded response prevents a single IPC message and DOM update from
    // freezing the WebView on directories with many duplicate groups.
    let end = start.saturating_add(limit.unwrap_or(100).clamp(1, 500)).min(total_groups);
    JsonResult::ok(serde_json::json!({
        "groups": &groups[start..end],
        "offset": start,
        "totalGroups": total_groups,
        "hasMore": end < total_groups,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join("diskraptor_dup_cmd_test")
            .join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture_file(dir: &std::path::Path, name: &str, content: &[u8]) -> std::path::PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        f.sync_all().ok();
        p
    }

    fn head_of(p: &std::path::Path) -> (u64, u64) {
        scanner::duplicates::hash_file_head(p, scanner::duplicates::HEAD_HASH_BYTES)
    }

    #[test]
    fn large_duplicates_verify_with_full_size() {
        // Regression test: files larger than HEAD_HASH_BYTES must still verify,
        // and the grouping key must carry the real file size (not the head
        // byte count). Previously `fsize != bytes_read` rejected every large
        // file, so no large duplicates were ever reported.
        let dir = fixture_dir("large");
        let size = scanner::duplicates::HEAD_HASH_BYTES as u64 + 1024;
        let content: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let a = fixture_file(&dir, "a.bin", &content);
        let b = fixture_file(&dir, "b.bin", &content);
        for p in [&a, &b] {
            let meta = std::fs::metadata(p).unwrap();
            let (bytes_read, head_hash) = head_of(p);
            assert!(bytes_read < meta.len());
            let key = verify_candidate(
                bytes_read,
                head_hash,
                p,
                meta.len(),
                meta.modified().ok(),
            );
            assert_eq!(key, {
                let (fsize, fhash, changed) = scanner::duplicates::hash_file_full(p);
                assert!(!changed);
                assert_eq!(fsize, size);
                Some((fsize, fhash))
            });
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn small_files_take_stat_fast_path() {
        let dir = fixture_dir("small");
        let p = fixture_file(&dir, "s.txt", b"tiny and identical");
        let meta = std::fs::metadata(&p).unwrap();
        let (bytes_read, head_hash) = head_of(&p);
        assert_eq!(bytes_read, meta.len());
        let key = verify_candidate(bytes_read, head_hash, &p, meta.len(), meta.modified().ok());
        assert_eq!(key, Some((meta.len(), head_hash)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn changed_or_missing_files_do_not_verify() {
        let dir = fixture_dir("changed");
        let p = fixture_file(&dir, "c.bin", &vec![7u8; 2048]);
        let (bytes_read, head_hash) = head_of(&p);
        // Stale length snapshot (file grew after phase 1): must be rejected.
        assert!(verify_candidate(bytes_read, head_hash, &p, 1, None).is_none());
        // Unreadable path: must be rejected, never suggested for delete.
        let missing = dir.join("gone.bin");
        assert!(verify_candidate(0, 0, &missing, 100, None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
