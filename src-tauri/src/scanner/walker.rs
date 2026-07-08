// Platform-independent directory scanner.
// Windows: Win32 FindFirstFileW + \\?\ for long paths.
// macOS/Linux: walkdir crate (no 260-char limit issues).

use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
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

// ------------------------------------------------------------
// Platform-specific scanners
// ------------------------------------------------------------

#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::*;
    use windows::Win32::Storage::FileSystem::*;

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }
    fn long(s: &str) -> String {
        if s.starts_with("\\\\?\\") {
            s.into()
        } else {
            format!("\\\\?\\{}", s)
        }
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
        let mut stack: Vec<(String, u32, u16)> = Vec::new();
        stack.push((root_path.into(), root_idx, 0));

        while let Some((dir, pi, d)) = stack.pop() {
            if arena.nodes.len() > 5_000_000 {
                break;
            }
            progress(arena.nodes.len() as u64, 0, &dir);
            let dl = long(&dir);
            unsafe {
                let mut fd = WIN32_FIND_DATAW::default();
                let search = format!("{}\\*", dl);
                let h = match FindFirstFileW(
                    ::windows::core::PCWSTR::from_raw(wide(&search).as_ptr()),
                    &mut fd,
                ) {
                    Ok(h) => h,
                    Err(_) => continue,
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
                    let is_reparse = (fd.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0) != 0;
                    let full = format!("{}\\{}", dir, name);
                    // Skip reparse points to avoid infinite loops
                    if is_dir && is_reparse {
                        let mut nd = WIN32_FIND_DATAW::default();
                        if FindNextFileW(hh, &mut nd).as_bool() {
                            fd = nd;
                            continue;
                        } else {
                            break;
                        }
                    }
                    if is_dir {
                        if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                            let mut nd = WIN32_FIND_DATAW::default();
                            if FindNextFileW(hh, &mut nd).as_bool() {
                                fd = nd;
                                continue;
                            } else {
                                break;
                            }
                        }
                        let ci = arena.alloc(TreeNode {
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
                        match lc.get(&pi) {
                            Some(&last) => {
                                arena.nodes[last as usize].next_sibling = ci;
                            }
                            None => {
                                arena.nodes[pi as usize].first_child = ci;
                            }
                        }
                        lc.insert(pi, ci);
                        ptix.insert(full.clone(), ci);
                        stack.push((full, ci, d + 1));
                    } else {
                        let sz = ((fd.nFileSizeHigh as u64) << 32) | (fd.nFileSizeLow as u64);
                        let ci = arena.alloc(TreeNode {
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
                            top_files.insert(full, sz, top_count);
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
            }
        }
        finish_scan(start, arena, top_files, file_types, progress)
    }
}

#[cfg(not(windows))]
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

        let walkdir_iter = walkdir::WalkDir::new(root_path)
            .follow_links(false)
            .into_iter();
        for entry_result in walkdir_iter {
            if arena.nodes.len() > 5_000_000 {
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

// ------------------------------------------------------------
// Shared finalisation
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// Public entry point
// ------------------------------------------------------------

pub fn scan_directory_with_progress(
    config: ScanConfig,
    progress: ScanProgressCallback,
) -> Result<ScanResult> {
    let root_path = config.root_path.clone();
    platform::scan(&config, &progress, &root_path)
}
