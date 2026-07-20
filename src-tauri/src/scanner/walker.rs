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
// ─── Windows Win32 Scanner (FindFirstFile/FindNextFile) ─────
// Uses direct Win32 API for maximum speed. One syscall per entry
// returns file type AND size simultaneously - vs walkdir which does two.
#[cfg(windows)]
mod platform {
    use super::*;
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::path::PathBuf;
    #[repr(C)]
    struct WIN32_FIND_DATAW {
        dwFileAttributes: u32,
        ftCreationTime: [u32; 2],
        ftLastAccessTime: [u32; 2],
        ftLastWriteTime: [u32; 2],
        nFileSizeHigh: u32,
        nFileSizeLow: u32,
        dwReserved0: u32,
        dwReserved1: u32,
        cFileName: [u16; 260],
        cAlternateFileName: [u16; 14],
    }

    #[repr(C)]
    #[derive(PartialEq, Copy, Clone)]
    struct HANDLE(isize);
    const INVALID_HANDLE_VALUE: HANDLE = HANDLE(-1);
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

    extern "system" {
        fn FindFirstFileW(lpFileName: *const u16, lpFindFileData: *mut WIN32_FIND_DATAW) -> HANDLE;
        fn FindNextFileW(hFindFile: HANDLE, lpFindFileData: *mut WIN32_FIND_DATAW) -> i32;
        fn FindClose(hFindFile: HANDLE) -> i32;
    }

    // ── Path helpers ──────────────────────────────────────
    fn to_wide(s: &str) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[inline]
    fn cfilename_to_string(w: &[u16; 260]) -> String {
        // Find null terminator - most filenames are short, so linear scan is cheap
        let len = w.iter().position(|&c| c == 0).unwrap_or(260);
        if len == 0 {
            return String::new();
        }
        OsString::from_wide(&w[..len])
            .to_string_lossy()
            .into_owned()
    }

    /// Build search pattern: path\* (normalizes / to \)
    fn search_pattern(path: &str) -> Vec<u16> {
        let mut p = String::with_capacity(path.len() + 4);
        for ch in path.chars() {
            if ch == '/' {
                p.push('\\');
            } else {
                p.push(ch);
            }
        }
        if !p.ends_with('\\') {
            p.push('\\');
        }
        p.push('*');
        to_wide(&p)
    }

    #[inline]
    fn get_file_size(data: &WIN32_FIND_DATAW) -> u64 {
        (data.nFileSizeHigh as u64) << 32 | data.nFileSizeLow as u64
    }

    #[inline]
    fn is_directory(data: &WIN32_FIND_DATAW) -> bool {
        (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
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
        let mut last_progress = Instant::now();
        let errors = config.errors.clone();
        let timeout = config.scan_timeout_secs;
        let mut iter_count = 0u64;
        let cancel = config.cancelled.clone();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;

        // Use a stack of (path_string, parent_index) for directory traversal
        struct DirEntry {
            path: String,
            parent: u32,
        }
        let mut stack: Vec<DirEntry> = Vec::with_capacity(1024);
        stack.push(DirEntry {
            path: root_path.to_owned(),
            parent: root_idx,
        });

        while let Some(current) = stack.pop() {
            if arena.nodes.len() > 50_000_000 {
                break;
            }
            let pattern = search_pattern(&current.path);
            let mut find_data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };

            let find_handle = unsafe { FindFirstFileW(pattern.as_ptr(), &mut find_data) };
            if find_handle == INVALID_HANDLE_VALUE {
                continue; // Can't open directory, skip
            }

            loop {
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
                    let mut errs = errors.lock().unwrap();
                    if errs.len() < 100 {
                        errs.push(format!("TIMEOUT: No progress for {}s", timeout));
                    }
                    break;
                }

                let name = unsafe { cfilename_to_string(&find_data.cFileName) };

                // Skip . and ..
                if name == "." || name == ".." {
                    // Get next file
                    if unsafe { FindNextFileW(find_handle, &mut find_data) } == 0 {
                        break;
                    }
                    continue;
                }

                let is_dir = is_directory(&find_data);
                let sz = if is_dir { 0 } else { get_file_size(&find_data) };

                // Build full path: pushd \ + name
                let mut full = String::with_capacity(current.path.len() + 1 + name.len());
                full.push_str(&current.path);
                if !full.ends_with('\\') {
                    full.push('\\');
                }
                full.push_str(&name);

                if is_dir {
                    dirs_found += 1;
                    if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                        // Get next
                        if unsafe { FindNextFileW(find_handle, &mut find_data) } == 0 {
                            break;
                        }
                        continue;
                    }
                    let depth = if current.parent == root_idx {
                        1
                    } else {
                        arena.nodes[current.parent as usize].depth + 1
                    };
                    let ci = arena.alloc(TreeNode {
                        name: name.clone(),
                        size: 0,
                        file_count: 0,
                        dir_count: 1,
                        node_type: NodeType::Directory,
                        parent: current.parent,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.parent) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.parent as usize].first_child = ci,
                    }
                    lc.insert(current.parent, ci);
                    ptix.insert(full.clone(), ci);
                    // Push onto stack for later traversal
                    stack.push(DirEntry {
                        path: full.clone(),
                        parent: ci,
                    });
                } else {
                    files_found += 1;
                    bytes_found += sz;
                    let depth = if current.parent == root_idx {
                        1
                    } else {
                        arena.nodes[current.parent as usize].depth + 1
                    };
                    let ci = arena.alloc(TreeNode {
                        name: name.clone(),
                        size: sz,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: current.parent,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.parent) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.parent as usize].first_child = ci,
                    }
                    lc.insert(current.parent, ci);
                    if sz > 0 {
                        top_files.insert(full.clone(), sz, top_count);
                        file_types.add(&name, sz);
                    }
                }

                if last_progress.elapsed().as_millis() >= 100 {
                    progress(files_found, dirs_found, bytes_found, &full);
                    last_progress = Instant::now();
                }

                // Get next file in this directory
                if unsafe { FindNextFileW(find_handle, &mut find_data) } == 0 {
                    break;
                }
            }

            unsafe {
                FindClose(find_handle);
            }

            // Check cancel after closing handle
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
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
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

        while let Some(current) = stack.pop() {
            if arena.nodes.len() > 20_000_000 {
                break;
            }

            let dir = match fs::read_dir(&current.path) {
                Ok(d) => d,
                Err(_) => continue,
            };

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

                // Build full path
                let mut full = String::with_capacity(current.path.len() + 1 + name.len());
                full.push_str(&current.path);
                if !full.ends_with('/') {
                    full.push('/');
                }
                full.push_str(&name);

                if is_dir {
                    dirs_found += 1;
                    let depth = arena.nodes[current.node_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: 0,
                        file_count: 0,
                        dir_count: 1,
                        node_type: NodeType::Directory,
                        parent: current.node_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.node_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.node_idx as usize].first_child = ci,
                    }
                    lc.insert(current.node_idx, ci);
                    ptix.insert(full.clone(), ci);
                    stack.push(DirCtx {
                        path: full,
                        node_idx: ci,
                    });
                } else {
                    files_found += 1;
                    // Only stat() for file size - macOS read_dir might not have d_type
                    let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes_found += sz;
                    let depth = arena.nodes[current.node_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: sz,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: current.node_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.node_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.node_idx as usize].first_child = ci,
                    }
                    lc.insert(current.node_idx, ci);
                    if sz > 0 {
                        top_files.insert(full, sz, top_count);
                        file_types.add(&name, sz);
                    }
                }

                if last_progress.elapsed().as_millis() >= 100 {
                    progress(files_found, dirs_found, bytes_found, &full);
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
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
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

        while let Some(current) = stack.pop() {
            if arena.nodes.len() > 20_000_000 {
                break;
            }

            let dir = match fs::read_dir(&current.path) {
                Ok(d) => d,
                Err(_) => continue,
            };

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

                // Linux read_dir gives d_type via file_type() without extra stat
                let ft = entry
                    .file_type()
                    .unwrap_or_else(|_| std::fs::FileType::new(false, false));
                let is_dir = ft.is_dir();

                // Build full path
                let mut full = String::with_capacity(current.path.len() + 1 + name.len());
                full.push_str(&current.path);
                if !full.ends_with('/') {
                    full.push('/');
                }
                full.push_str(&name);

                if is_dir {
                    dirs_found += 1;
                    let depth = arena.nodes[current.node_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: 0,
                        file_count: 0,
                        dir_count: 1,
                        node_type: NodeType::Directory,
                        parent: current.node_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.node_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.node_idx as usize].first_child = ci,
                    }
                    lc.insert(current.node_idx, ci);
                    ptix.insert(full.clone(), ci);
                    stack.push(DirCtx {
                        path: full,
                        node_idx: ci,
                    });
                } else {
                    files_found += 1;
                    // stat() for file size - necessary on all platforms
                    let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    bytes_found += sz;
                    let depth = arena.nodes[current.node_idx as usize].depth + 1;
                    let ci = arena.alloc(TreeNode {
                        name,
                        size: sz,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: current.node_idx,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match lc.get(&current.node_idx) {
                        Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                        None => arena.nodes[current.node_idx as usize].first_child = ci,
                    }
                    lc.insert(current.node_idx, ci);
                    if sz > 0 {
                        top_files.insert(full, sz, top_count);
                        file_types.add(&name, sz);
                    }
                }

                if last_progress.elapsed().as_millis() >= 100 {
                    progress(files_found, dirs_found, bytes_found, &full);
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
