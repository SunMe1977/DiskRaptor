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
        let mut files = self.files.lock();
        // Quick check: if smaller than current minimum, skip (files lock held, no TOCTOU race)
        if size <= *self.min_size.lock() && files.len() >= max_count {
            return;
        }
        // Binary-search insertion point (list kept sorted descending by size) - O(log n).
        let idx = files
            .binary_search_by(|f| f.size.cmp(&size).reverse())
            .unwrap_or_else(|e| e);
        files.insert(idx, TopFileEntry {
            path,
            size,
            size_human: format_size(size),
        });
        if files.len() > max_count {
            files.truncate(max_count);
        }
        *self.min_size.lock() = files.last().map(|f| f.size).unwrap_or(0);
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


// ─── macOS scanner (jwalk parallel traversal) ────────────
// Uses jwalk for parallel directory walking, significantly faster
// than the single-threaded read_dir approach on multi-core systems.
mod platform {
    use super::*;
    use jwalk::WalkDir;

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
        let mut arena = TreeNodeArena::with_estimated_capacity(root_path);
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
        mtime: 0,
        });
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut last_progress = Instant::now();
        let cancel = config.cancelled.clone();
        let errors = config.errors.clone();
        let timeout = config.scan_timeout_secs;
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut iter_count = 0u64;
        let mut path_buf = String::with_capacity(4096);

        for entry_result in WalkDir::new(root_path).follow_links(config.follow_symlinks).sort(false).parallelism(jwalk::Parallelism::RayonNewPool(4)) {
            if arena.nodes.len() > 20_000_000 {
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

            // Reconstruct full path from jwalk entry
            let os_path = entry.path();
            path_buf.clear();
            path_buf.push_str(&os_path.to_string_lossy());
            if path_buf == root_path {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy();

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
                name: file_name.into_owned(),
                size: 0,
                file_count: 0,
                dir_count: 1,
                node_type: NodeType::Directory,
                parent: pi,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth,
                chunk_id: 0,
                mtime: 0,
            });
                match lc.get(&pi) {
                    Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                    None => arena.nodes[pi as usize].first_child = ci,
                }
                lc.insert(pi, ci);
                ptix.insert(path_buf.clone(), ci);
            } else {
                files_found += 1;
                let meta = entry.metadata();
                let sz = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                bytes_found += sz;
                let depth = if pi == root_idx {
                    1
                } else {
                    arena.nodes[pi as usize].depth + 1
                };
                let mtime = meta.as_ref()
                    .map(|m| m.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0))
                    .unwrap_or(0);
                let fname = file_name.into_owned();
                let ci = arena.alloc(TreeNode {
                    name: fname.clone(),
                    size: sz,
                    file_count: 1,
                    dir_count: 0,
                    node_type: NodeType::File,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth,
                    chunk_id: 0,
                    mtime,
                });
                match lc.get(&pi) {
                    Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                    None => arena.nodes[pi as usize].first_child = ci,
                }
                lc.insert(pi, ci);
                if sz > 0 {
                    top_files.insert(path_buf.clone(), sz, top_count);
                    file_types.add(&fname, sz);
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
    let mut arena = TreeNodeArena::with_estimated_capacity(root_path);
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
        mtime: 0,
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
        mtime: 0,
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
            let fname = file_name.clone();
            let ci = arena.alloc(TreeNode {
            name: fname,
                    size: sz,
                file_count: 1,
                dir_count: 0,
                node_type: NodeType::File,
                parent: pi,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth,
                chunk_id: 0,
        mtime: 0,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_top_files_empty() {
        let accum = TopFilesAccum::default();
        let result = accum.into_inner();
        assert!(result.is_empty());
    }

    #[test]
    fn test_top_files_below_max() {
        let accum = TopFilesAccum::default();
        accum.insert("a".into(), 100, 5);
        accum.insert("b".into(), 200, 5);
        let result = accum.into_inner();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].size, 200);
    }

    #[test]
    fn test_top_files_truncates() {
        let accum = TopFilesAccum::default();
        accum.insert("a".into(), 100, 3);
        accum.insert("b".into(), 200, 3);
        accum.insert("c".into(), 50, 3);
        accum.insert("d".into(), 150, 3);
        let result = accum.into_inner();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].size, 200);
        assert_eq!(result[1].size, 150);
        assert_eq!(result[2].size, 100);
    }

    #[test]
    fn test_top_files_skips_small() {
        let accum = TopFilesAccum::default();
        accum.insert("a".into(), 200, 2);
        accum.insert("b".into(), 100, 2);
        accum.insert("c".into(), 50, 2);
        let result = accum.into_inner();
        assert_eq!(result.len(), 2);
        assert_eq!(result[1].size, 100);
    }

    #[test]
    fn test_file_type_accum_empty() {
        let accum = FileTypeAccum::default();
        let result = accum.into_sorted();
        assert!(result.is_empty());
    }

    #[test]
    fn test_file_type_accum_single() {
        let accum = FileTypeAccum::default();
        accum.add("file.txt", 100);
        let result = accum.into_sorted();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].extension, "txt");
        assert_eq!(result[0].count, 1);
        assert_eq!(result[0].total_size, 100);
    }

    #[test]
    fn test_file_type_accum_multi() {
        let accum = FileTypeAccum::default();
        accum.add("a.txt", 100);
        accum.add("b.jpg", 200);
        accum.add("c.txt", 50);
        let result = accum.into_sorted();
        assert_eq!(result.len(), 2);
        let txt = result.iter().find(|f| f.extension == "txt").unwrap();
        assert_eq!(txt.count, 2);
        assert_eq!(txt.total_size, 150);
    }

    #[test]
    fn test_file_type_accum_no_ext() {
        let accum = FileTypeAccum::default();
        accum.add("Makefile", 100);
        let result = accum.into_sorted();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].extension, "(none)");
    }
}
