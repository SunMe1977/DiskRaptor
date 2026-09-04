//! Windows-native fast scanner using FindFirstFileW / FindNextFileW.
//!
//! Why this is faster than walkdir/jwalk on Windows:
//! - `FindFirstFileW` returns name, attributes, size and last-write time in a
//!   single kernel call — no separate `metadata()`/`stat()` per entry (jwalk
//!   issues an extra open+query per file).
//! - Iterative traversal with an explicit directory stack, so deep trees can't
//!   overflow the call stack.
//! - Batched per-directory reads reuse one handle per directory.
//!
//! The tree is built with the same arena helpers as the cross-platform walkers,
//! so results are byte-identical in structure (same node layout, same stats).
//! Only Windows uses this; other platforms keep jwalk.

#![cfg(target_os = "windows")]

use crate::scanner::tree::*;
use crate::scanner::walker::{
    FileTypeAccum, ScanConfig, ScanProgressCallback, ScanResult, ScanTermination, TopFilesAccum,
    file_ext_lower, finish_scan,
};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Storage::FileSystem::{
    FindClose, FindFirstFileW, FindNextFileW, FindFileHandle, WIN32_FIND_DATAW,
};

/// Attribute bits (numeric, matching FILE_FLAGS_AND_ATTRIBUTES.0).
const ATTR_DIRECTORY: u32 = 0x10;
const ATTR_REPARSE_POINT: u32 = 0x0400;

/// Convert a Windows FILETIME (100ns since 1601-01-01) to Unix seconds.
fn filetime_to_unix_secs(ft: &windows::Win32::Foundation::FILETIME) -> u64 {
    let t = ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
    // FILETIME epoch is 1601-01-01; Unix epoch 1970-01-01. Difference in 100ns.
    const EPOCH_DIFF: u64 = 116_444_736_000_000_000;
    if t >= EPOCH_DIFF {
        (t - EPOCH_DIFF) / 10_000_000
    } else {
        0
    }
}

/// A directory entry as returned by FindFirstFileW, with the name decoded.
#[derive(Debug)]
struct WinEntry {
    name: String,
    is_dir: bool,
    is_reparse: bool,
    size: u64,
    mtime: u64,
}

fn entry_from_data(d: &WIN32_FIND_DATAW) -> WinEntry {
    let attrs = d.dwFileAttributes;
    let is_dir = attrs & ATTR_DIRECTORY != 0;
    let is_reparse = attrs & ATTR_REPARSE_POINT != 0;
    let name = decode_name(&d.cFileName);
    let size = ((d.nFileSizeHigh as u64) << 32) | d.nFileSizeLow as u64;
    let mtime = filetime_to_unix_secs(&d.ftLastWriteTime);
    WinEntry { name, is_dir, is_reparse, size, mtime }
}

fn decode_name(raw: &[u16; 260]) -> String {
    let len = raw.iter().position(|&c| c == 0).unwrap_or(raw.len());
    String::from_utf16_lossy(&raw[..len])
}

/// Scan a directory, calling `f` for every entry (skip . and ..).
/// Returns Err only for hard failures (access denied on the dir itself).
fn read_dir<F: FnMut(WinEntry)>(dir: &str, mut f: F) -> windows::core::Result<()> {
    let wide: Vec<u16> = format!("{}\\*", dir).encode_utf16().chain(std::iter::once(0)).collect();
    let mut find_data = WIN32_FIND_DATAW::default();
    let handle: FindFileHandle = unsafe { FindFirstFileW(PCWSTR(wide.as_ptr()), &mut find_data)? };
    if handle.is_invalid() {
        return Ok(());
    }
    let _guard = FindHandleGuard(handle);
    let h: windows::Win32::Foundation::HANDLE = HANDLE(handle.0);
    loop {
        let e = entry_from_data(&find_data);
        if e.name != "." && e.name != ".." {
            f(e);
        }
        let ok = unsafe { FindNextFileW(h, &mut find_data) };
        if !ok.as_bool() {
            break;
        }
    }
    Ok(())
}

struct FindHandleGuard(FindFileHandle);
impl Drop for FindHandleGuard {
    fn drop(&mut self) {
        // FindClose takes Into<FindFileHandle>; pass the handle itself.
        unsafe { FindClose(self.0) };
    }
}

/// Windows-native scan. The arena/statistics logic mirrors the jwalk walker so
/// the resulting tree and stats are identical; only the directory enumeration
/// differs (FindFirstFileW instead of read_dir+metadata). Uses N worker
/// threads that pull directories off a shared queue, so several directories
/// are enumerated in parallel — this is where the speed vs. single-threaded
/// walks comes from.
pub fn scan(
    config: &ScanConfig,
    progress: Arc<ScanProgressCallback>,
    root_path: &str,
) -> Result<ScanResult> {
    use std::collections::VecDeque;
    use parking_lot::Mutex;

    let start = Instant::now();
    let skip_dirs = Arc::new(config.skip_dirs.clone());
    let top_files = Arc::new(TopFilesAccum::default());
    let file_types = Arc::new(FileTypeAccum::default());
    let live_entries = config.live_entries.clone();
    let top_count = config.top_files_count;
    let cancel = config.cancelled.clone();
    let errors = config.errors.clone();
    let timeout = config.scan_timeout_secs;
    let follow_symlinks = config.follow_symlinks;

    // ScanProgressCallback is Box<dyn Fn + Send + Sync>; shared via Arc.
    let progress_arc = progress.clone();

    let arena = Arc::new(Mutex::new(TreeNodeArena::with_estimated_capacity(root_path)));
    let root_idx = alloc_root(&mut arena.lock(), root_path);
    let ptix: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
    ptix.lock().insert(root_path.to_string(), root_idx);
    let lc: Arc<Mutex<HashMap<u32, u32>>> = Arc::new(Mutex::new(HashMap::new()));

    let node_cap = {
        let avail = crate::scanner::tree::available_memory_bytes();
        (avail / 128).clamp(500_000, 20_000_000) as usize
    };

    let files_found = Arc::new(AtomicU64::new(0));
    let dirs_found = Arc::new(AtomicU64::new(0));
    let bytes_found = Arc::new(AtomicU64::new(0));
    let termination: Arc<Mutex<ScanTermination>> = Arc::new(Mutex::new(ScanTermination::Completed));
    let stop_flag = Arc::new(AtomicBool::new(false));

    // Shared work queue. Initially the root directory.
    let queue: Arc<Mutex<VecDeque<(String, u32)>>> = Arc::new(Mutex::new(VecDeque::new()));
    queue.lock().push_back((root_path.to_string(), root_idx));

    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let progress_start = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = queue.clone();
        let arena = arena.clone();
        let ptix = ptix.clone();
        let lc = lc.clone();
        let top_files = top_files.clone();
        let live_entries = live_entries.clone();
        let skip_dirs = skip_dirs.clone();
        let cancel = cancel.clone();
        let errors = errors.clone();
        let files_found = files_found.clone();
        let dirs_found = dirs_found.clone();
        let bytes_found = bytes_found.clone();
        let termination = termination.clone();
        let stop_flag = stop_flag.clone();
        let progress = progress_arc.clone();
        let root_path = root_path.to_string();

        handles.push(std::thread::spawn(move || {
            // `last_progress` tracks when this worker last reported progress;
            // the timeout is a *no-progress* watchdog, not a wall-clock limit.
            let mut last_progress = progress_start;
            // Worker-local file-type map: avoids taking the global map lock once
            // per file. Merged into the shared accumulator after join.
            let mut local_types: HashMap<String, (u64, u64)> = HashMap::new();
            let mut live_count: u64 = 0;
            loop {
                // Take a directory from the queue.
                let (dir_path, parent_idx) = {
                    let mut q = queue.lock();
                    match q.pop_front() {
                        Some(item) => item,
                        None => return local_types, // no more work
                    }
                };

                if stop_flag.load(Ordering::Relaxed) {
                    return local_types;
                }

                let node_count = arena.lock().nodes.len();
                if node_count > node_cap {
                    *termination.lock() = ScanTermination::LimitReached;
                    stop_flag.store(true, Ordering::Relaxed);
                    return local_types;
                }

                if dir_path != root_path
                    && skip_dirs.iter().any(|sd| path_has_component(&dir_path, sd.as_str()))
                {
                    continue;
                }

                let mut new_dirs: Vec<(String, u32)> = Vec::new();
                let mut local_files = 0u64;
                let mut local_bytes = 0u64;
                let mut local_entries: Vec<(String, bool, u64, u64)> = Vec::new(); // name, is_dir, size, mtime

                let read_res = read_dir(&dir_path, |e| {
                    live_count += 1;
                    if live_count.is_multiple_of(100) {
                        push_live(&live_entries, &e.name);
                    }
                    let treat_as_dir = e.is_dir && (!e.is_reparse || follow_symlinks);
                    if treat_as_dir {
                        local_entries.push((e.name.clone(), true, 0, e.mtime));
                    } else {
                        local_bytes += e.size;
                        local_files += 1;
                        local_entries.push((e.name.clone(), false, e.size, e.mtime));
                    }
                });

                if read_res.is_err() {
                    let mut errs = errors.lock();
                    if errs.len() < 100 {
                        errs.push(format!("Access denied: {}", dir_path));
                    }
                }

                // Insert all entries of this directory with a single arena lock.
                {
                    let mut ar = arena.lock();
                    let mut ptx = ptix.lock();
                    let mut lc2 = lc.lock();
                    let depth = child_depth(&ar, parent_idx, root_idx);
                    for (name, is_dir, size, mtime) in local_entries {
                        if is_dir {
                            let ci = alloc_directory(&mut ar, name.clone(), parent_idx, depth);
                            link_child(&mut ar, &mut lc2, parent_idx, ci);
                            let child_path = format!("{}\\{}", dir_path, name);
                            ptx.insert(child_path.clone(), ci);
                            new_dirs.push((child_path, ci));
                        } else {
                            let ci = alloc_file(&mut ar, name.clone(), size, parent_idx, depth, mtime);
                            link_child(&mut ar, &mut lc2, parent_idx, ci);
                            if size > 0 {
                                let full = format!("{}\\{}", dir_path, name);
                                top_files.insert(full, size, top_count);
                                let ext = file_ext_lower(&name);
                                let entry = local_types.entry(ext).or_insert((0, 0));
                                entry.0 += 1;
                                entry.1 += size;
                            }
                        }
                    }
                }

                files_found.fetch_add(local_files, Ordering::Relaxed);
                bytes_found.fetch_add(local_bytes, Ordering::Relaxed);
                // `dirs_found` was declared but never incremented, so live scan
                // progress on Windows always reported 0 directories while the
                // jwalk/macOS paths counted them. Count the subdirectories this
                // worker discovered and hand the queue to the sibling workers.
                dirs_found.fetch_add(new_dirs.len() as u64, Ordering::Relaxed);

                // Enqueue newly discovered subdirectories.
                {
                    let mut q = queue.lock();
                    for d in new_dirs {
                        q.push_back(d);
                    }
                }

                // Cancellation / timeout checks.
                if let Some(ref cf) = cancel {
                    if cf.load(Ordering::Relaxed) {
                        *termination.lock() = ScanTermination::Cancelled;
                        stop_flag.store(true, Ordering::Relaxed);
                        return local_types;
                    }
                }
                if timeout > 0 && last_progress.elapsed().as_secs() > timeout {
                    let mut errs = errors.lock();
                    if errs.len() < 100 {
                        errs.push(format!("TIMEOUT: No progress for {}s at {}", timeout, root_path));
                    }
                    *termination.lock() = ScanTermination::TimedOut;
                    stop_flag.store(true, Ordering::Relaxed);
                    return local_types;
                }

                if progress_start.elapsed().as_millis() >= 100 {
                    let f = files_found.load(Ordering::Relaxed);
                    let d = dirs_found.load(Ordering::Relaxed);
                    let b = bytes_found.load(Ordering::Relaxed);
                    progress(f, d, b, &dir_path);
                    last_progress = Instant::now();
                }
            }
        }));
    }
    for h in handles {
        if let Ok(m) = h.join() {
            file_types.merge(m);
        }
    }

    let f = files_found.load(Ordering::Relaxed);
    let d = dirs_found.load(Ordering::Relaxed);
    let b = bytes_found.load(Ordering::Relaxed);
    progress_arc(f, d, b, "Finalizing tree...");

    let arena = Arc::try_unwrap(arena)
        .map_err(|_| anyhow::anyhow!("arena Arc leaked"))?
        .into_inner();
    let term = *termination.lock();
    // finish_scan takes &ScanProgressCallback; wrap the Arc closure.
    let finish_progress: ScanProgressCallback = Box::new(move |f, d, b, p| progress_arc(f, d, b, p));
    finish_scan(start, arena, top_files, file_types, &finish_progress, term)
}

fn path_has_component(path: &str, target: &str) -> bool {
    path.split(['/', '\\']).any(|c| c == target)
}

const LIVE_CAP: usize = 1000;
fn push_live(live: &Arc<parking_lot::Mutex<std::collections::VecDeque<String>>>, name: &str) {
    let mut q = live.lock();
    if q.len() >= LIVE_CAP {
        q.pop_front();
    }
    q.push_back(name.to_string());
}

fn child_depth(arena: &TreeNodeArena, parent: u32, root_idx: u32) -> u16 {
    if parent == root_idx {
        1
    } else {
        arena.nodes[parent as usize].depth + 1
    }
}

fn alloc_root(arena: &mut TreeNodeArena, root_path: &str) -> u32 {
    let root_name = std::path::Path::new(root_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.into());
    arena.alloc(TreeNode {
        name: root_name,
        size: 0,
        file_count: 0,
        dir_count: 1,
        node_type: NodeType::Directory,
        parent: u32::MAX,
        first_child: u32::MAX,
        next_sibling: u32::MAX,
        depth: 0,
        chunk_id: 0,
        mtime: 0,
    })
}

fn alloc_directory(arena: &mut TreeNodeArena, name: String, parent: u32, depth: u16) -> u32 {
    arena.alloc(TreeNode {
        name,
        size: 0,
        file_count: 0,
        dir_count: 1,
        node_type: NodeType::Directory,
        parent,
        first_child: u32::MAX,
        next_sibling: u32::MAX,
        depth,
        chunk_id: 0,
        mtime: 0,
    })
}

fn alloc_file(
    arena: &mut TreeNodeArena,
    name: String,
    size: u64,
    parent: u32,
    depth: u16,
    mtime: u64,
) -> u32 {
    arena.alloc(TreeNode {
        name,
        size,
        file_count: 1,
        dir_count: 0,
        node_type: NodeType::File,
        parent,
        first_child: u32::MAX,
        next_sibling: u32::MAX,
        depth,
        chunk_id: 0,
        mtime,
    })
}

fn link_child(arena: &mut TreeNodeArena, lc: &mut HashMap<u32, u32>, parent: u32, child: u32) {
    match lc.get(&parent) {
        Some(&last) => arena.nodes[last as usize].next_sibling = child,
        None => arena.nodes[parent as usize].first_child = child,
    }
    lc.insert(parent, child);
}
