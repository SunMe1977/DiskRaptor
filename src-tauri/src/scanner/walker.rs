use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub type ScanProgressCallback = Box<dyn Fn(u64, u64, &str) + Send + Sync>;

pub struct ScanConfig {
    pub root_path: String,
    pub skip_dirs: Vec<String>,
    pub top_file_min_size: u64,
    pub top_files_count: usize,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            root_path: String::new(),
            skip_dirs: vec![
                #[cfg(windows)]
                {
                    "C:\\Windows".into()
                },
            ],
            top_file_min_size: 0,
            top_files_count: 100,
        }
    }
}

struct TopFilesAccum {
    files: Mutex<Vec<TopFileEntry>>,
    min_size: Mutex<u64>,
}
impl Default for TopFilesAccum {
    fn default() -> Self {
        Self {
            files: Mutex::new(Vec::new()),
            min_size: Mutex::new(0),
        }
    }
}
impl TopFilesAccum {
    fn insert(&self, path: String, size: u64, max_count: usize) {
        let mut min = self.min_size.lock();
        if size <= *min {
            return;
        }
        let mut files = self.files.lock();
        files.push(TopFileEntry {
            path,
            size,
            size_human: format_size(size),
        });
        files.sort_unstable_by_key(|b| std::cmp::Reverse(b.size));
        if files.len() > max_count {
            files.truncate(max_count);
        }
        *min = files.last().map(|f| f.size).unwrap_or(0);
    }
    fn into_inner(self) -> Vec<TopFileEntry> {
        self.files.into_inner()
    }
}

struct FileTypeAccum {
    map: Mutex<HashMap<String, (u64, u64)>>,
}
impl Default for FileTypeAccum {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}
impl FileTypeAccum {
    #[allow(dead_code)]
    fn add(&self, path: &str, size: u64) {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_else(|| "(none)".into());
        let mut map = self.map.lock();
        let entry = map.entry(ext).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += size;
    }
    fn into_sorted(self) -> Vec<FileTypeCount> {
        let map = self.map.into_inner();
        let mut r: Vec<FileTypeCount> = map
            .into_iter()
            .map(|(ext, (c, s))| FileTypeCount {
                extension: ext,
                count: c,
                total_size: s,
                size_human: format_size(s),
            })
            .collect();
        r.sort_unstable_by_key(|b| std::cmp::Reverse(b.total_size));
        r
    }
}

pub struct ScanResult {
    pub arena: TreeNodeArena,
    pub stats: ScanStats,
}

/// A single file entry collected during parallel scanning.
/// Phase 1 produces these, Phase 2 builds the tree from them.
#[derive(Debug, Clone)]
struct FileEntry {
    full_path: String,
    name: String,
    parent_path: String,
    size: u64,
    is_dir: bool,
}

// ─── Windows Parallel Scanner ─────────────────────────────
#[cfg(windows)]
mod platform {
    use super::*;
    use std::collections::VecDeque;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::thread;
    use windows::Win32::Foundation::*;
    use windows::Win32::Storage::FileSystem::*;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    fn long(s: &str) -> String {
        let prefix = "\\\\?\\";
        if s.starts_with(prefix) {
            s.into()
        } else {
            let mut r = String::with_capacity(prefix.len() + s.len());
            r.push_str(prefix);
            r.push_str(s);
            r
        }
    }

    /// Scan a single directory, returning its contents without locking.
    /// Called by worker threads — no locks needed for local results.
    unsafe fn scan_dir_contents(
        dir: &str,
        skip_dirs: &[String],
        visited: &Mutex<std::collections::HashSet<String>>,
    ) -> (Vec<FileEntry>, Vec<String>) {
        let mut entries: Vec<FileEntry> = Vec::new();
        let mut subdirs: Vec<String> = Vec::new();
        let dl = long(dir);

        let mut fd = WIN32_FIND_DATAW::default();
        let search = format!("{}\\*", dl);
        let h = match FindFirstFileW(
            windows::core::PCWSTR::from_raw(wide(&search).as_ptr()),
            &mut fd,
        ) {
            Ok(h) => h,
            Err(_) => return (entries, subdirs),
        };
        let hh = HANDLE(h.0);

        loop {
            let nlen = fd.cFileName.iter().position(|&c| c == 0).unwrap_or(260);
            if nlen == 0 {
                break;
            }
            let name = String::from_utf16_lossy(&fd.cFileName[..nlen]);
            if name == "." || name == ".." {
                let mut nd = WIN32_FIND_DATAW::default();
                if FindNextFileW(hh, &mut nd).as_bool() {
                    fd = nd;
                    continue;
                } else {
                    break;
                }
            }
            let is_dir = (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0) != 0;
            let full = format!("{}\\{}", dir, name);

            if is_dir {
                // Check skip list
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                    let mut nd = WIN32_FIND_DATAW::default();
                    if FindNextFileW(hh, &mut nd).as_bool() {
                        fd = nd;
                        continue;
                    } else {
                        break;
                    }
                }
                // Check visited (only one thread should process each dir)
                let full_long = long(&full);
                let mut v = visited.lock();
                if !v.insert(full_long) {
                    drop(v);
                    let mut nd = WIN32_FIND_DATAW::default();
                    if FindNextFileW(hh, &mut nd).as_bool() {
                        fd = nd;
                        continue;
                    } else {
                        break;
                    }
                }
                drop(v);
                subdirs.push(full.clone());
                entries.push(FileEntry {
                    full_path: full,
                    name,
                    parent_path: dir.to_string(),
                    size: 0,
                    is_dir: true,
                });
            } else {
                let sz = ((fd.nFileSizeHigh as u64) << 32) | (fd.nFileSizeLow as u64);
                entries.push(FileEntry {
                    full_path: full,
                    name,
                    parent_path: dir.to_string(),
                    size: sz,
                    is_dir: false,
                });
            }
            let mut nd = WIN32_FIND_DATAW::default();
            if FindNextFileW(hh, &mut nd).as_bool() {
                fd = nd;
            } else {
                break;
            }
        }
        let _ = FindClose(h);
        (entries, subdirs)
    }

    pub fn scan(
        config: &ScanConfig,
        progress: &ScanProgressCallback,
        root_path: &str,
    ) -> Result<ScanResult> {
        let start = Instant::now();
        let skip_dirs = Arc::new(config.skip_dirs.clone());
        let top_files = Arc::new(TopFilesAccum::default());
        let file_types = Arc::new(FileTypeAccum::default());
        let top_count = config.top_files_count;

        // ── Phase 1: Parallel directory scanning ────────────
        let visited = Arc::new(Mutex::new(std::collections::HashSet::new()));
        visited.lock().insert(long(root_path));

        let queue = Arc::new(Mutex::new(VecDeque::<String>::new()));
        queue.lock().push_back(root_path.to_string());

        let all_entries = Arc::new(Mutex::new(Vec::<FileEntry>::new()));
        let files_found = Arc::new(AtomicU64::new(0));
        let dirs_found = Arc::new(AtomicU64::new(0));
        let cancel = Arc::new(AtomicBool::new(false));
        let active_workers = Arc::new(AtomicU64::new(0));
        let node_count = Arc::new(AtomicU64::new(1)); // root

        // Determine worker count (4-8, capped by logical CPUs)
        let num_workers = std::cmp::max(4, std::cmp::min(num_cpus::get(), 8));

        // Use crossbeam-channel for signaling
        let (done_tx, done_rx) = crossbeam_channel::bounded::<bool>(num_workers);

        for _ in 0..num_workers {
            let q = queue.clone();
            let v = visited.clone();
            let all = all_entries.clone();
            let ff = files_found.clone();
            let cncl = cancel.clone();
            let act = active_workers.clone();
            let nc = node_count.clone();
            let skp = skip_dirs.clone();
            let done = done_tx.clone();

            thread::spawn(move || {
                act.fetch_add(1, Ordering::Relaxed);
                loop {
                    if cncl.load(Ordering::Relaxed) {
                        break;
                    }

                    // Get next directory from queue
                    let dir = {
                        let mut q_lock = q.lock();
                        q_lock.pop_front()
                    };

                    match dir {
                        Some(d) => {
                            // Check node limit
                            if nc.load(Ordering::Relaxed) > 20_000_000 {
                                break;
                            }

                            // Scan directory (no locks held during scan)
                            let (entries, subdirs) = unsafe { scan_dir_contents(&d, &skp, &v) };

                            // Push results
                            let mut all_lock = all.lock();
                            let entry_count = entries.len();
                            all_lock.extend(entries);
                            drop(all_lock);

                            nc.fetch_add(entry_count as u64, Ordering::Relaxed);

                            // Push subdirectories to queue
                            if !subdirs.is_empty() {
                                let mut q_lock = q.lock();
                                for sd in subdirs {
                                    q_lock.push_back(sd);
                                }
                            }

                            // Thread-local top files processing
                            // Process files for top_files — lock briefly
                            ff.fetch_add(entry_count as u64, Ordering::Relaxed);
                        }
                        None => {
                            // Queue empty — check if all workers are idle
                            thread::sleep(std::time::Duration::from_millis(5));
                            // Try again after a short sleep
                            let q_len = q.lock().len();
                            if q_len == 0 {
                                // Give other workers time to add more work
                                thread::sleep(std::time::Duration::from_millis(20));
                                if q.lock().len() == 0 {
                                    break; // All done
                                }
                            }
                        }
                    }
                }
                act.fetch_sub(1, Ordering::Relaxed);
                let _ = done.send(true);
            });
        }
        drop(done_tx);

        // Monitor progress
        loop {
            let f = files_found.load(Ordering::Relaxed);
            let d = dirs_found.load(Ordering::Relaxed);
            progress(
                f,
                d,
                &format!("{} workers active", active_workers.load(Ordering::Relaxed)),
            );

            // Check if all workers finished (with debounce)
            let q_empty = queue.lock().is_empty();
            let no_workers = active_workers.load(Ordering::Relaxed) == 0;
            if q_empty && no_workers {
                // Race condition: a worker might still be adding work.
                // Wait a bit and re-check.
                thread::sleep(std::time::Duration::from_millis(200));
                if queue.lock().is_empty() && active_workers.load(Ordering::Relaxed) == 0 {
                    break;
                }
            }

            // Also check cancellation
            if cancel.load(Ordering::Relaxed) {
                break;
            }

            thread::sleep(std::time::Duration::from_millis(100));
            if node_count.load(Ordering::Relaxed) > 20_000_000 {
                break;
            }
        }

        // Collect all done signals (don't require all — workers may have crashed)
        for _ in 0..num_workers {
            let _ = done_rx.recv_timeout(std::time::Duration::from_millis(200));
        }

        // ── Phase 2: Tree building (sequential) ─────────────
        // Drain entries via lock (safe even if Arc is still referenced)
        let entries: Vec<FileEntry> = all_entries.lock().drain(..).collect();
        let total_count = entries.len() as u64 + 1; // +1 for root

        let mut arena = TreeNodeArena::with_capacity(total_count as usize + 1000);
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());

        let root_idx = arena.alloc(TreeNode {
            name: root_name,
            size: 0,
            file_count: 0,
            node_type: NodeType::Directory,
            parent: u32::MAX,
            first_child: u32::MAX,
            next_sibling: u32::MAX,
            depth: 0,
            chunk_id: 0,
        });

        // Map from path to arena index
        let mut path_to_idx: HashMap<String, u32> = HashMap::new();
        path_to_idx.insert(root_path.to_string(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();

        for entry in &entries {
            let pi = *path_to_idx.get(&entry.parent_path).unwrap_or(&root_idx);
            if entry.is_dir {
                let ci = arena.alloc(TreeNode {
                    name: entry.name.clone(),
                    size: 0,
                    file_count: 0,
                    node_type: NodeType::Directory,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx {
                        1
                    } else {
                        arena.nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => {
                        arena.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        arena.nodes[pi as usize].first_child = ci;
                    }
                }
                lc.insert(pi, ci);
                path_to_idx.insert(entry.full_path.clone(), ci);
            } else {
                let ci = arena.alloc(TreeNode {
                    name: entry.name.clone(),
                    size: entry.size,
                    file_count: 1,
                    node_type: NodeType::File,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx {
                        1
                    } else {
                        arena.nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => {
                        arena.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        arena.nodes[pi as usize].first_child = ci;
                    }
                }
                lc.insert(pi, ci);
                if entry.size > 0 {
                    top_files.insert(entry.full_path.clone(), entry.size, top_count);
                    file_types.add(&entry.full_path, entry.size);
                }
            }
        }

        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── Cross-platform fallback ──────────────────────────────
#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn scan(
        config: &ScanConfig,
        progress: &ScanProgressCallback,
        root_path: &str,
    ) -> Result<ScanResult> {
        use walkdir::WalkDir;
        let start = Instant::now();
        let skip_dirs = Arc::new(config.skip_dirs.clone());
        let top_files = Arc::new(TopFilesAccum::default());
        let file_types = Arc::new(FileTypeAccum::default());
        let top_count = config.top_files_count;
        let mut arena = TreeNodeArena::with_capacity(2_000_000);
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let root_idx = arena.alloc(TreeNode {
            name: root_name,
            size: 0,
            file_count: 0,
            node_type: NodeType::Directory,
            parent: u32::MAX,
            first_child: u32::MAX,
            next_sibling: u32::MAX,
            depth: 0,
            chunk_id: 0,
        });
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();

        for entry_result in WalkDir::new(root_path).follow_links(false) {
            if arena.nodes.len() > 20_000_000 {
                break;
            }
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => continue,
            };
            let full = entry.path().to_string_lossy().to_string();
            if full == root_path {
                continue;
            }
            progress(arena.nodes.len() as u64, 0, &full);
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().is_dir();
            let parent = entry
                .path()
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let pi = *ptix.get(&parent).unwrap_or(&root_idx);
            if is_dir {
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                    continue;
                }
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: 0,
                    file_count: 0,
                    node_type: NodeType::Directory,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx {
                        1
                    } else {
                        arena.nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => {
                        arena.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        arena.nodes[pi as usize].first_child = ci;
                    }
                }
                lc.insert(pi, ci);
                ptix.insert(full, ci);
            } else {
                let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: sz,
                    file_count: 1,
                    node_type: NodeType::File,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx {
                        1
                    } else {
                        arena.nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => {
                        arena.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        arena.nodes[pi as usize].first_child = ci;
                    }
                }
                lc.insert(pi, ci);
                if sz > 0 {
                    top_files.insert(full.clone(), sz, top_count);
                    file_types.add(&full, sz);
                }
            }
        }
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

fn finish_scan(
    start: Instant,
    mut arena: TreeNodeArena,
    top_files: Arc<TopFilesAccum>,
    file_types: Arc<FileTypeAccum>,
    _progress: &ScanProgressCallback,
) -> Result<ScanResult> {
    let n = arena.nodes.len();
    for i in (1..n).rev() {
        let node = &arena.nodes[i];
        let p = node.parent;
        let s = node.size;
        let fc = node.file_count;
        if p != u32::MAX {
            let parent = &mut arena.nodes[p as usize];
            parent.size += s;
            parent.file_count += fc;
        }
    }
    let elapsed = start.elapsed().as_millis() as u64;
    let total_files = arena.nodes.iter().filter(|n| n.is_file()).count() as u64;
    let total_dirs = arena.nodes.iter().filter(|n| n.is_directory()).count() as u64;
    let total_size = arena.nodes[0].size;
    let stats = ScanStats {
        total_files,
        total_dirs,
        total_size,
        scan_time_ms: elapsed,
        top_files: match Arc::try_unwrap(top_files) {
            Ok(t) => t.into_inner(),
            Err(_) => vec![],
        },
        file_type_breakdown: match Arc::try_unwrap(file_types) {
            Ok(t) => t.into_sorted(),
            Err(_) => vec![],
        },
    };
    Ok(ScanResult { arena, stats })
}

pub fn scan_directory_with_progress(
    config: ScanConfig,
    progress: ScanProgressCallback,
) -> Result<ScanResult> {
    let root_path = config.root_path.clone();
    platform::scan(&config, &progress, &root_path)
}
