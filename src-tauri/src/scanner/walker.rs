use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::Path;
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

// ── Platform modules ─────────────────────────────────────

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::atomic::{AtomicU64, Ordering};
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

    /// Scan a single directory (non-recursive), returning its files and subdirs.
    /// This is the inner function called by parallel workers.
    unsafe fn scan_single_dir(
        dir: &str,
        pi: u32,
        d: u16,
        arena: &Mutex<TreeNodeArena>,
        lc: &Mutex<HashMap<u32, u32>>,
        visited: &Mutex<std::collections::HashSet<String>>,
        skip_dirs: &[String],
        top_files: &TopFilesAccum,
        file_types: &FileTypeAccum,
        top_count: usize,
        files_count: &AtomicU64,
    ) -> Vec<(String, u32, u16)> {
        let mut subdirs: Vec<(String, u32, u16)> = Vec::new();
        let dl = long(dir);
        let mut fd = WIN32_FIND_DATAW::default();
        let search = format!("{}\\*", dl);
        let h = match FindFirstFileW(
            windows::core::PCWSTR::from_raw(wide(&search).as_ptr()),
            &mut fd,
        ) {
            Ok(h) => h,
            Err(_) => return subdirs,
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
                // Check visited
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

                // Allocate node for this directory
                let ci = {
                    let mut a = arena.lock();
                    let ci = a.alloc(TreeNode {
                        name,
                        size: 0,
                        file_count: 0,
                        node_type: NodeType::Directory,
                        parent: pi,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth: d + 1,
                        chunk_id: 0,
                    });
                    // Link as last child of parent
                    let mut l = lc.lock();
                    match l.get(&pi) {
                        Some(&last) => {
                            a.nodes[last as usize].next_sibling = ci;
                        }
                        None => {
                            a.nodes[pi as usize].first_child = ci;
                        }
                    }
                    l.insert(pi, ci);
                    ci
                };
                subdirs.push((full, ci, d + 1));
            } else {
                files_count.fetch_add(1, Ordering::Relaxed);
                let sz = ((fd.nFileSizeHigh as u64) << 32) | (fd.nFileSizeLow as u64);
                let ci = {
                    let mut a = arena.lock();
                    let ci = a.alloc(TreeNode {
                        name,
                        size: sz,
                        file_count: 1,
                        node_type: NodeType::File,
                        parent: pi,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth: d + 1,
                        chunk_id: 0,
                    });
                    let mut l = lc.lock();
                    match l.get(&pi) {
                        Some(&last) => {
                            a.nodes[last as usize].next_sibling = ci;
                        }
                        None => {
                            a.nodes[pi as usize].first_child = ci;
                        }
                    }
                    l.insert(pi, ci);
                    ci
                };
                if sz > 0 {
                    top_files.insert(full.clone(), sz, top_count);
                    file_types.add(&full, sz);
                }
            }
            let mut nd = WIN32_FIND_DATAW::default();
            if FindNextFileW(hh, &mut nd).as_bool() {
                fd = nd;
            } else {
                break;
            }
        }
        let _ = FindClose(h);
        subdirs
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
        let files_count = Arc::new(AtomicU64::new(0));

        let arena = Arc::new(Mutex::new(TreeNodeArena::with_capacity(2_000_000)));
        let lc = Arc::new(Mutex::new(HashMap::new()));
        let visited = Arc::new(Mutex::new(std::collections::HashSet::new()));

        // Allocate root node
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let root_idx = arena.lock().alloc(TreeNode {
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
        visited.lock().insert(long(root_path));

        // Work stack: directories to process
        let stack = Arc::new(Mutex::new(Vec::<(String, u32, u16)>::new()));
        stack.lock().push((root_path.into(), root_idx, 0));

        // Process stack in parallel batches
        loop {
            // Take a batch from the stack (up to 64 dirs at a time)
            let batch: Vec<(String, u32, u16)> = {
                let mut s = stack.lock();
                let count = std::cmp::min(s.len(), 64);
                if count == 0 {
                    break;
                }
                s.drain(s.len() - count..).collect()
            };

            // Check node limit
            if arena.lock().len() > 20_000_000 {
                break;
            }

            // Progress
            progress(
                files_count.load(Ordering::Relaxed),
                0,
                &batch.last().map(|b| b.0.clone()).unwrap_or_default(),
            );

            // Process each directory in parallel
            let results: Vec<Vec<(String, u32, u16)>> = batch
                .par_iter()
                .map(|(dir, pi, d)| unsafe {
                    scan_single_dir(
                        dir,
                        *pi,
                        *d,
                        &arena,
                        &lc,
                        &visited,
                        &skip_dirs,
                        &top_files,
                        &file_types,
                        top_count,
                        &files_count,
                    )
                })
                .collect();

            // Collect results back into the stack
            let mut s = stack.lock();
            for subdirs in results {
                if arena.lock().len() > 20_000_000 {
                    break;
                }
                for sd in subdirs {
                    s.push(sd);
                }
            }
        }

        // Extract arena and finish
        let arena = Arc::try_unwrap(arena).unwrap().into_inner();
        finish_scan(
            start,
            arena,
            top_files,
            file_types,
            progress,
            files_count.load(Ordering::Relaxed),
        )
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicU64, Ordering};

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
        let files_count = Arc::new(AtomicU64::new(0));

        let arena = Arc::new(Mutex::new(TreeNodeArena::with_capacity(2_000_000)));
        let lc = Arc::new(Mutex::new(HashMap::new()));
        let ptix = Arc::new(Mutex::new(HashMap::new()));

        let root_idx = {
            let mut a = arena.lock();
            let root_name = Path::new(root_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let idx = a.alloc(TreeNode {
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
            ptix.lock().insert(root_path.to_string(), idx);
            idx
        };

        let root_path_arc = Arc::new(root_path.to_string());
        let entries: Vec<_> = WalkDir::new(&*root_path_arc)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .collect();

        // Process entries in parallel
        let processed: Vec<_> = entries
            .par_iter()
            .filter_map(|entry| {
                let full = entry.path().to_string_lossy().to_string();
                if full == *root_path_arc {
                    return None;
                }

                files_count.fetch_add(1, Ordering::Relaxed);
                let file_name = entry.file_name().to_string_lossy().to_string();
                let is_dir = entry.file_type().is_dir();
                let parent = entry
                    .path()
                    .parent()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| root_path_arc.to_string());

                Some((
                    full,
                    parent,
                    file_name,
                    is_dir,
                    entry.metadata().map(|m| m.len()).unwrap_or(0),
                ))
            })
            .collect();

        // Build tree from processed entries
        for (full, parent, file_name, is_dir, sz) in processed {
            if arena.lock().len() > 20_000_000 {
                break;
            }
            progress(files_count.load(Ordering::Relaxed), 0, &full);

            let pi = *ptix.lock().get(&parent).unwrap_or(&root_idx);
            if is_dir {
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                    continue;
                }
                let ci = arena.lock().alloc(TreeNode {
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
                        arena.lock().nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                let mut a = arena.lock();
                let mut l = lc.lock();
                match l.get(&pi) {
                    Some(&last) => {
                        a.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        a.nodes[pi as usize].first_child = ci;
                    }
                }
                l.insert(pi, ci);
                ptix.lock().insert(full, ci);
            } else {
                let ci = arena.lock().alloc(TreeNode {
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
                        arena.lock().nodes[pi as usize].depth + 1
                    },
                    chunk_id: 0,
                });
                let mut a = arena.lock();
                let mut l = lc.lock();
                match l.get(&pi) {
                    Some(&last) => {
                        a.nodes[last as usize].next_sibling = ci;
                    }
                    None => {
                        a.nodes[pi as usize].first_child = ci;
                    }
                }
                l.insert(pi, ci);
                if sz > 0 {
                    top_files.insert(full.clone(), sz, top_count);
                    file_types.add(&full, sz);
                }
            }
        }

        let arena = Arc::try_unwrap(arena).unwrap().into_inner();
        finish_scan(
            start,
            arena,
            top_files,
            file_types,
            progress,
            files_count.load(Ordering::Relaxed),
        )
    }
}

fn finish_scan(
    start: Instant,
    mut arena: TreeNodeArena,
    top_files: Arc<TopFilesAccum>,
    file_types: Arc<FileTypeAccum>,
    _progress: &ScanProgressCallback,
    _total_files_scanned: u64,
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
