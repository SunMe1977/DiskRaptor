use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
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

// ─── Windows Parallel Scanner ─────────────────────────────
#[cfg(windows)]
mod platform {
    use super::*;

    // Windows Unicode helper
    fn wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn long(path: &str) -> Vec<u16> {
        if path.starts_with("\\\\?\\") {
            wide(path)
        } else {
            let mut p = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
            // Replace '/' with '\' for NT path
            let normalized = path.replace('/', "\\");
            p.extend(wide(&normalized));
            p
        }
    }

    const FILE_LIST_DIRECTORY: u32 = 0x0001;
    const FILE_READ_EA: u32 = 0x0008;
    const SYNCHRONIZE: u32 = 0x00100000;
    const FILE_SHARE_READ: u32 = 0x00000001;
    const FILE_SHARE_WRITE: u32 = 0x00000002;
    const FILE_SHARE_DELETE: u32 = 0x00000004;
    const OPEN_EXISTING: u32 = 3;
    const FILE_DIRECTORY_FILE: u32 = 0x00000001;
    const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x00000020;

    const FILE_DIRECTORY_INFORMATION: u32 = 1;
    const FILE_NAMES_INFORMATION: u32 = 12;
    const STATUS_SUCCESS: i32 = 0;
    const STATUS_NO_MORE_FILES: i32 = -2147483642i32;
    const STATUS_BUFFER_OVERFLOW: i32 = -2147483643i32;

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
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut last_progress = Instant::now();
        let mut last_entry_time = Instant::now();
        let follow = config.follow_symlinks;
        let errors = config.errors.clone();
        let timeout = config.scan_timeout_secs;
        let mut walker = WalkDir::new(root_path).follow_links(follow).into_iter();
        loop {
            if arena.nodes.len() > 50_000_000 {
                eprintln!("[walker] Node limit reached (50M), stopping scan");
                break;
            }
            // Check for timeout (NAS dead share detection)
            if timeout > 0 && last_entry_time.elapsed().as_secs() > timeout {
                errors.lock().unwrap().push(format!(
                    "TIMEOUT: No progress for {}s at {}",
                    timeout, root_path
                ));
                eprintln!("[walker] Timeout after {}s, stopping scan", timeout);
                break;
            }
            let entry_result = match walker.next() {
                Some(r) => r,
                None => break,
            };
            let entry = match entry_result {
                Ok(e) => {
                    last_entry_time = Instant::now();
                    e
                }
                Err(e) => {
                    // Report permission errors
                    if let Some(path) = e.path() {
                        let err_path = path.to_string_lossy().to_string();
                        errors
                            .lock()
                            .unwrap()
                            .push(format!("Access denied: {}", err_path));
                    }
                    continue;
                }
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
                bytes_found += sz;
            }
            if last_progress.elapsed().as_millis() >= 100 {
                progress(files_found, dirs_found, bytes_found, &full);
                last_progress = Instant::now();
            }
        }
        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── macOS walkdir scanner ────────────────────────
#[cfg(target_os = "macos")]
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
                bytes_found += sz;
            }
            if last_progress.elapsed().as_millis() >= 100 {
                progress(files_found, dirs_found, bytes_found, &full);
                last_progress = Instant::now();
            }
        }
        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── Linux scanner (delegates to scan_simple) ──
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    pub fn scan(
        config: &ScanConfig,
        progress: &ScanProgressCallback,
        root_path: &str,
    ) -> Result<ScanResult> {
        scan_simple(config, progress, root_path)
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
