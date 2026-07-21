use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub type ScanProgressCallback = Box<dyn Fn(u64, u64, u64, &str) + Send + Sync>;

pub struct ScanConfig {
    pub root_path: String,
    pub skip_dirs: Vec<String>,
    pub top_file_min_size: u64,
    pub top_files_count: usize,
    pub follow_symlinks: bool,
    pub scan_timeout_secs: u64,
    /// Shared error list — scanner pushes inaccessible paths here
    pub errors: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    /// When set to true, scanner should stop as soon as possible
    pub cancelled: Option<std::sync::Arc<AtomicBool>>,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            root_path: String::new(),
            skip_dirs: vec![
                #[cfg(windows)]
                "C:\\Windows".into(),
                #[cfg(target_os = "macos")]
                "/System".into(),
                #[cfg(target_os = "macos")]
                "/Library".into(),
                "target".into(),
                ".git".into(),
            ],
            top_file_min_size: 0,
            top_files_count: 100,
            follow_symlinks: false,
            scan_timeout_secs: 0,
            errors: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            cancelled: None,
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
#[cfg(windows)]
#[derive(Debug, Clone)]
struct FileEntry {
    full_path: String,
    name: String,
    parent_path: String,
    size: u64,
    is_dir: bool,
}

// ─── Windows Scanner (walkdir - single-threaded, fastest on NTFS) ──
// ─── Windows Scanner (walkdir + reusable path buffer) ──
// walkdir on Windows internally uses FindFirstFileW, but handles
// the UTF-16→String conversion more efficiently than raw FFI.
// Combined with our reusable path buffer (String::truncate)
// this gives the best speed on NTFS.
#[cfg(windows)]
mod platform {
    use super::*;

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
        let mut arena = TreeNodeArena::with_capacity(16_000_000);
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let root_idx = arena.alloc(TreeNode {
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
        });
        use walkdir::WalkDir;
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut last_progress = Instant::now();
        let follow = config.follow_symlinks;
        let errors = config.errors.clone();
        let timeout = config.scan_timeout_secs;
        let mut iter_count = 0u64;
        let cancel = config.cancelled.clone();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        // Reusable path buffer — truncated between entries, no new allocs
        let mut path_buf = String::with_capacity(4096);

        for entry_result in WalkDir::new(root_path).follow_links(follow) {
            if arena.nodes.len() > 50_000_000 {
                break;
            }
            iter_count += 1;
            if (iter_count & 0x3FF) == 0 {
                if let Some(ref cf) = cancel {
                    if cf.load(Ordering::Relaxed) {
                        break;
                    }
                }
            }
            if timeout > 0
                && (iter_count & 0x1FFF) == 0
                && last_progress.elapsed().as_secs() > timeout
            {
                errors.lock().unwrap().push(format!(
                    "TIMEOUT: No progress for {}s at {}",
                    timeout, root_path
                ));
                break;
            }
            let entry = match entry_result {
                Ok(e) => e,
                Err(e) => {
                    if let Some(path) = e.path() {
                        let err_path = path.to_string_lossy().to_string();
                        let mut errs = errors.lock().unwrap();
                        if errs.len() < 100 {
                            errs.push(format!("Access denied: {}", err_path));
                        }
                    }
                    continue;
                }
            };

            // Use reusable path buffer
            let os_path = entry.path();
            path_buf.clear();
            path_buf.push_str(&os_path.to_string_lossy());
            if path_buf == root_path {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().is_dir();
            let parent = os_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let pi = *ptix.get(&parent).unwrap_or(&root_idx);

            if is_dir {
                dirs_found += 1;
                if skip_dirs.iter().any(|sd| path_buf.contains(sd.as_str())) {
                    continue;
                }
                let depth = if pi == root_idx {
                    1
                } else {
                    arena.nodes[pi as usize].depth + 1
                };
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: 0,
                    file_count: 0,
                    dir_count: 1,
                    node_type: NodeType::Directory,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth,
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                    None => arena.nodes[pi as usize].first_child = ci,
                }
                lc.insert(pi, ci);
                ptix.insert(path_buf.clone(), ci);
            } else {
                files_found += 1;
                let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                bytes_found += sz;
                let depth = if pi == root_idx {
                    1
                } else {
                    arena.nodes[pi as usize].depth + 1
                };
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: sz,
                    file_count: 1,
                    dir_count: 0,
                    node_type: NodeType::File,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth,
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                    None => arena.nodes[pi as usize].first_child = ci,
                }
                lc.insert(pi, ci);
                if sz > 0 {
                    top_files.insert(path_buf.clone(), sz, top_count);
                    file_types.add(&path_buf, sz);
                }
            }
            if last_progress.elapsed().as_millis() >= 100 {
                progress(files_found, dirs_found, bytes_found, &path_buf);
                last_progress = Instant::now();
            }
        }
        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── macOS scanner (read_dir with manual stack) ──────────
// Uses std::fs::read_dir directly instead of walkdir.
// read_dir calls getdirentries under the hood, and file_type()
// uses d_type when available (APFS), avoiding extra stat() calls.
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::fs;

    struct DirCtx {
        path: String,
        node_idx: u32,
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
        let mut arena = TreeNodeArena::with_capacity(4_000_000);
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let root_idx = arena.alloc(TreeNode {
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
        });
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut stack: Vec<DirCtx> = vec![DirCtx {
            path: root_path.into(),
            node_idx: root_idx,
        }];
        let mut last_progress = Instant::now();
        let cancel = config.cancelled.clone();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut iter_count = 0u64;
        // Reusable path buffer
        let mut path_buf = String::with_capacity(4096);

        while let Some(current) = stack.pop() {
            if arena.nodes.len() > 20_000_000 {
                break;
            }

            let dir = match fs::read_dir(&current.path) {
                Ok(d) => d,
                Err(_) => continue,
            };

            // Set up reusable path_buf with current directory
            path_buf.clear();
            path_buf.push_str(&current.path);
            if !path_buf.ends_with('/') {
                path_buf.push('/');
            }
            let dir_path_len = path_buf.len();
            let parent_idx = current.node_idx;

            for entry_res in dir {
                let entry = match entry_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                iter_count += 1;
                if (iter_count & 0xFFF) == 0 {
                    if let Some(ref cf) = cancel {
                        if cf.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                }

                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }

                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

                // Append filename to reusable path buffer
                path_buf.truncate(dir_path_len);
                path_buf.push_str(&name);

                if is_dir {
                    dirs_found += 1;
                    if skip_dirs.iter().any(|sd| path_buf.contains(sd.as_str())) {
                        continue;
                    }
                    let depth = arena.nodes[parent_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: 0,
                        file_count: 0,
                        dir_count: 1,
                        node_type: NodeType::Directory,
                        parent: parent_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&parent_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[parent_idx as usize].first_child = ci,
                    }
                    lc.insert(parent_idx, ci);
                    stack.push(DirCtx {
                        path: path_buf.clone(),
                        node_idx: ci,
                    });
                } else {
                    files_found += 1;
                    let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes_found += sz;
                    let depth = arena.nodes[parent_idx as usize].depth + 1;
                    // Use name before it's moved into TreeNode
                    if sz > 0 {
                        top_files.insert(path_buf.clone(), sz, top_count);
                        file_types.add(&name, sz);
                    }
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: sz,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: parent_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&parent_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[parent_idx as usize].first_child = ci,
                    }
                    lc.insert(parent_idx, ci);
                }

                if last_progress.elapsed().as_millis() >= 100 {
                    progress(files_found, dirs_found, bytes_found, &path_buf);
                    last_progress = Instant::now();
                }
            }

            if let Some(ref cf) = cancel {
                if cf.load(Ordering::Relaxed) {
                    break;
                }
            }
        }

        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── Linux scanner (read_dir with manual stack) ──────────
// Uses std::fs::read_dir which calls getdents64 internally.
// Entry::file_type() uses d_type from the kernel, avoiding stat()
// for type detection. Only calls stat() for file size.
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::fs;

    struct DirCtx {
        path: String,
        node_idx: u32,
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
        let mut arena = TreeNodeArena::with_capacity(4_000_000);
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let root_idx = arena.alloc(TreeNode {
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
        });
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut stack: Vec<DirCtx> = vec![DirCtx {
            path: root_path.into(),
            node_idx: root_idx,
        }];
        let mut last_progress = Instant::now();
        let cancel = config.cancelled.clone();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut iter_count = 0u64;
        let mut path_buf = String::with_capacity(4096);

        while let Some(current) = stack.pop() {
            if arena.nodes.len() > 20_000_000 {
                break;
            }

            let dir = match fs::read_dir(&current.path) {
                Ok(d) => d,
                Err(_) => continue,
            };

            path_buf.clear();
            path_buf.push_str(&current.path);
            if !path_buf.ends_with('/') {
                path_buf.push('/');
            }
            let dir_path_len = path_buf.len();
            let parent_idx = current.node_idx;

            for entry_res in dir {
                let entry = match entry_res {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                iter_count += 1;
                if (iter_count & 0xFFF) == 0 {
                    if let Some(ref cf) = cancel {
                        if cf.load(Ordering::Relaxed) {
                            break;
                        }
                    }
                }

                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }

                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);

                path_buf.truncate(dir_path_len);
                path_buf.push_str(&name);

                if is_dir {
                    dirs_found += 1;
                    if skip_dirs.iter().any(|sd| path_buf.contains(sd.as_str())) {
                        continue;
                    }
                    let depth = arena.nodes[parent_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: 0,
                        file_count: 0,
                        dir_count: 1,
                        node_type: NodeType::Directory,
                        parent: parent_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&parent_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[parent_idx as usize].first_child = ci,
                    }
                    lc.insert(parent_idx, ci);
                    stack.push(DirCtx {
                        path: path_buf.clone(),
                        node_idx: ci,
                    });
                } else {
                    files_found += 1;
                    let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes_found += sz;
                    if sz > 0 {
                        top_files.insert(path_buf.clone(), sz, top_count);
                        file_types.add(&name, sz);
                    }
                    let depth = arena.nodes[parent_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: sz,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: parent_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&parent_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[parent_idx as usize].first_child = ci,
                    }
                    lc.insert(parent_idx, ci);
                }

                if last_progress.elapsed().as_millis() >= 100 {
                    progress(files_found, dirs_found, bytes_found, &path_buf);
                    last_progress = Instant::now();
                }
            }

            if let Some(ref cf) = cancel {
                if cf.load(Ordering::Relaxed) {
                    break;
                }
            }
        }

        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
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
        let dc = node.dir_count;
        if p != u32::MAX {
            let parent = &mut arena.nodes[p as usize];
            parent.size += s;
            parent.file_count += fc;
            parent.dir_count += dc;
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

/// Simple walkdir-based scanner (fallback for when Win32 scanner panics)
pub fn scan_simple(
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
    let mut arena = TreeNodeArena::with_capacity(16_000_000);
    let root_name = Path::new(root_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.into());
    let root_idx = arena.alloc(TreeNode {
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
    });
    let mut ptix: HashMap<String, u32> = HashMap::new();
    ptix.insert(root_path.into(), root_idx);
    let mut lc: HashMap<u32, u32> = HashMap::new();
    let mut files_found: u64 = 0;
    let mut dirs_found: u64 = 0;
    let mut bytes_found: u64 = 0;
    let mut last_progress = Instant::now();

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
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_dir();
        let parent = entry
            .path()
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let pi = *ptix.get(&parent).unwrap_or(&root_idx);
        if is_dir {
            dirs_found += 1;
            if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                continue;
            }
            let depth = if pi == root_idx {
                1
            } else {
                arena.nodes[pi as usize].depth + 1
            };
            let ci = arena.alloc(TreeNode {
                name: file_name,
                size: 0,
                file_count: 0,
                dir_count: 1,
                node_type: NodeType::Directory,
                parent: pi,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth,
                chunk_id: 0,
            });
            match lc.get(&pi) {
                Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                None => arena.nodes[pi as usize].first_child = ci,
            }
            lc.insert(pi, ci);
            ptix.insert(full.clone(), ci);
        } else {
            files_found += 1;
            let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
            bytes_found += sz;
            let depth = if pi == root_idx {
                1
            } else {
                arena.nodes[pi as usize].depth + 1
            };
            let ci = arena.alloc(TreeNode {
                name: file_name,
                size: sz,
                file_count: 1,
                dir_count: 0,
                node_type: NodeType::File,
                parent: pi,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth,
                chunk_id: 0,
            });
            match lc.get(&pi) {
                Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                None => arena.nodes[pi as usize].first_child = ci,
            }
            lc.insert(pi, ci);
            if sz > 0 {
                top_files.insert(full.clone(), sz, top_count);
                file_types.add(&full, sz);
            }
        }
        if last_progress.elapsed().as_millis() >= 100 {
            progress(files_found, dirs_found, bytes_found, &full);
            last_progress = Instant::now();
        }
    }
    progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
    finish_scan(start, arena, top_files, file_types, progress)
}

pub fn scan_directory_with_progress(
    config: ScanConfig,
    progress: ScanProgressCallback,
) -> Result<ScanResult> {
    let root_path = config.root_path.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        platform::scan(&config, &progress, &root_path)
    }));
    match result {
        Ok(Ok(scan_result)) => Ok(scan_result),
        Ok(Err(e)) => {
            eprintln!("[walker] Win32 scan error: {}, falling back to walkdir", e);
            scan_simple(&config, &progress, &root_path)
        }
        Err(panic) => {
            let msg = if let Some(s) = panic.downcast_ref::<&str>() {
                s.to_string()
            } else if let Some(s) = panic.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown".to_string()
            };
            eprintln!(
                "[walker] Win32 scanner panicked: {}, falling back to walkdir",
                msg
            );
            scan_simple(&config, &progress, &root_path)
        }
    }
}
