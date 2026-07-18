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
        // Use crossbeam-channel for parallel processing
        // ...
        use walkdir::WalkDir;
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut last_progress = Instant::now();
        for entry_result in WalkDir::new(root_path).follow_links(false) {
            if arena.nodes.len() > 20_000_000 { break; }
            let entry = match entry_result { Ok(e) => e, Err(_) => continue };
            let full = entry.path().to_string_lossy().to_string();
            if full == root_path { continue; }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().is_dir();
            let parent = entry.path().parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let pi = *ptix.get(&parent).unwrap_or(&root_idx);
            if is_dir {
                dirs_found += 1;
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) { continue; }
                let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
                let ci = arena.alloc(TreeNode {
                    name: file_name, size: 0, file_count: 0, dir_count: 1,
                    node_type: NodeType::Directory, parent: pi,
                    first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
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
                let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
                let ci = arena.alloc(TreeNode {
                    name: file_name, size: sz, file_count: 1, dir_count: 0,
                    node_type: NodeType::File, parent: pi,
                    first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
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
            name: root_name, size: 0, file_count: 0, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0,
        });
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut last_progress = Instant::now();

        for entry_result in WalkDir::new(root_path).follow_links(false) {
            if arena.nodes.len() > 20_000_000 { break; }
            let entry = match entry_result { Ok(e) => e, Err(_) => continue };
            let full = entry.path().to_string_lossy().to_string();
            if full == root_path { continue; }
            let file_name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().is_dir();
            let parent = entry.path().parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let pi = *ptix.get(&parent).unwrap_or(&root_idx);
            if is_dir {
                dirs_found += 1;
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) { continue; }
                let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
                let ci = arena.alloc(TreeNode {
                    name: file_name, size: 0, file_count: 0, dir_count: 1,
                    node_type: NodeType::Directory, parent: pi,
                    first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
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
                let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
                let ci = arena.alloc(TreeNode {
                    name: file_name, size: sz, file_count: 1, dir_count: 0,
                    node_type: NodeType::File, parent: pi,
                    first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
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

// ─── Linux native scanner (getdents64 + openat + fstatat) ──
// Uses raw Linux syscalls for maximum traversal speed.
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::ffi::{CStr, CString, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::RawFd;

    const DT_DIR: u8 = 4;
    const DT_REG: u8 = 8;
    const DT_LNK: u8 = 10;
    const DT_UNKNOWN: u8 = 0;

    const O_RDONLY: i32 = 0;
    const O_DIRECTORY: i32 = 0o100000; // 00200000 on most arches
    const O_CLOEXEC: i32 = 0o2000000;
    const AT_FDCWD: i32 = -100;
    const AT_SYMLINK_NOFOLLOW: i32 = 0x100;

    const BUF_SIZE: usize = 32768;

    extern "C" {
        fn open(pathname: *const i8, flags: i32, mode: u32) -> RawFd;
        fn openat(dirfd: RawFd, pathname: *const i8, flags: i32, mode: u32) -> RawFd;
        fn close(fd: RawFd) -> i32;
        fn fstatat(dirfd: RawFd, pathname: *const i8, buf: *mut libc::stat, flags: i32) -> i32;
    }

    #[repr(C, packed)]
    struct dirent64 {
        d_ino: u64,
        d_off: i64,
        d_reclen: u16,
        d_type: u8,
        d_name: [u8; 256],
    }

    unsafe fn getdents64(fd: RawFd, buf: *mut u8, count: usize) -> i64 {
        let result: i64;
        core::arch::asm!(
            "syscall",
            in("rax") 217i64,  // SYS_getdents64
            in("rdi") fd as i64,
            in("rsi") buf,
            in("rdx") count,
            lateout("rax") result,
            out("rcx") _, out("r11") _,
            options(nostack, preserves_flags),
        );
        result
    }

    /// Get file size via fstatat (only when needed, e.g. d_type == DT_UNKNOWN)
    unsafe fn get_size(dirfd: RawFd, name: &[u8]) -> u64 {
        let mut st: libc::stat = std::mem::zeroed();
        let cname = CString::new(name).unwrap_or_default();
        if fstatat(dirfd, cname.as_ptr(), &mut st, AT_SYMLINK_NOFOLLOW) == 0 {
            st.st_size as u64
        } else {
            0
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
        let mut arena = TreeNodeArena::with_capacity(8_000_000);

        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());

        let root_idx = arena.alloc(TreeNode {
            name: root_name, size: 0, file_count: 0, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0,
        });

        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.to_owned(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();

        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut last_progress = Instant::now();

        // Dir queue: (fd, parent_arena_idx, depth, path_string)
        let croot = CString::new(root_path.as_bytes()).unwrap_or_default();
        let root_fd = unsafe { open(croot.as_ptr(), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0) };
        if root_fd < 0 {
            return Err(anyhow::anyhow!("Cannot open root: {}", root_path));
        }

        let mut queue: Vec<(RawFd, u32, u16, String)> = Vec::new();
        queue.push((root_fd, root_idx, 0, root_path.to_owned()));

        let mut buf: Vec<u8> = vec![0u8; BUF_SIZE];

        while let Some((dir_fd, parent_idx, depth, parent_path)) = queue.pop() {
            if arena.nodes.len() > 20_000_000 { break; }

            unsafe {
                loop {
                    let nread = getdents64(dir_fd, buf.as_mut_ptr(), BUF_SIZE);
                    if nread <= 0 { break; }

                    let mut pos = 0usize;
                    while pos < nread as usize {
                        let ent = &*buf.as_ptr().add(pos).cast::<dirent64>();
                        let d_type = ent.d_type;
                        let d_reclen = ent.d_reclen as usize;
                        if d_reclen == 0 { break; }

                        // Get name as bytes up to first nul
                        let name_bytes = &ent.d_name[..ent.d_name.iter().position(|&b| b == 0).unwrap_or(0)];
                        pos += d_reclen;

                        // Skip . and ..
                        if name_bytes.len() <= 2
                            && (name_bytes == b"." || name_bytes == b"..")
                        {
                            continue;
                        }

                        let name = String::from_utf8_lossy(name_bytes).to_string();

                        // Build full path for parent resolution
                        let full = if parent_path.ends_with('/') {
                            format!("{}{}", parent_path, name)
                        } else {
                            format!("{}/{}", parent_path, name)
                        };

                        let entry_type = match d_type {
                            DT_DIR => {
                                // Check skip dirs before opening
                                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                                    continue;
                                }
                                Some(0u8) // directory
                            }
                            DT_REG | DT_LNK => Some(1u8), // file or symlink
                            DT_UNKNOWN => {
                                // Fallback: try fstatat to determine type
                                let cname = CString::new(name_bytes).unwrap_or_default();
                                let mut st: libc::stat = std::mem::zeroed();
                                if fstatat(dir_fd, cname.as_ptr(), &mut st, AT_SYMLINK_NOFOLLOW) == 0 {
                                    if st.st_mode & libc::S_IFMT == libc::S_IFDIR {
                                        Some(0u8)
                                    } else {
                                        Some(1u8)
                                    }
                                } else {
                                    None
                                }
                            }
                            _ => None, // skip other types
                        };

                        let Some(is_dir_val) = entry_type else { continue };
                        let is_dir = is_dir_val == 0u8;

                        if is_dir { dirs_found += 1; } else { files_found += 1; }
                        let depth_u16 = depth + 1;

                        let ci = if is_dir {
                            // Open subdirectory for later traversal
                            let cname = CString::new(name_bytes).unwrap_or_default();
                            let sub_fd = openat(dir_fd, cname.as_ptr(), O_RDONLY | O_DIRECTORY | O_CLOEXEC, 0);
                            if sub_fd >= 0 {
                                queue.push((sub_fd, 0, depth_u16, full.clone()));
                            }
                            // Alloc node (will fix parent after queue push)
                            let idx = arena.alloc(TreeNode {
                                name: name.clone(), size: 0, file_count: 0, dir_count: 1,
                                node_type: NodeType::Directory, parent: parent_idx,
                                first_child: u32::MAX, next_sibling: u32::MAX, depth: depth_u16, chunk_id: 0,
                            });
                            // Update parent link
                            match lc.get(&parent_idx) {
                                Some(&last) => arena.nodes[last as usize].next_sibling = idx,
                                None => arena.nodes[parent_idx as usize].first_child = idx,
                            }
                            lc.insert(parent_idx, idx);
                            ptix.insert(full.clone(), idx);
                            idx
                        } else {
                            // File — get size via fstatat
                            let sz = if d_type == DT_UNKNOWN || d_type == DT_LNK {
                                unsafe { get_size(dir_fd, name_bytes) }
                            } else {
                                // For DT_REG, we still need size — use fstatat
                                unsafe { get_size(dir_fd, name_bytes) }
                            };

                            let idx = arena.alloc(TreeNode {
                                name: name.clone(), size: sz, file_count: 1, dir_count: 0,
                                node_type: NodeType::File, parent: parent_idx,
                                first_child: u32::MAX, next_sibling: u32::MAX, depth: depth_u16, chunk_id: 0,
                            });
                            match lc.get(&parent_idx) {
                                Some(&last) => arena.nodes[last as usize].next_sibling = idx,
                                None => arena.nodes[parent_idx as usize].first_child = idx,
                            }
                            lc.insert(parent_idx, idx);
                            if sz > 0 {
                                top_files.insert(full.clone(), sz, top_count);
                                file_types.add(&full, sz);
                            }
                            bytes_found += sz;
                            idx
                        };

                        // Fix directory queue entry parent index
                        if is_dir {
                            if let Some(last) = queue.last_mut() {
                                if last.2 == depth_u16 && last.3 == full {
                                    last.1 = ci;
                                }
                            }
                        }

                        let now = Instant::now();
                        if now.duration_since(last_progress).as_millis() >= 100 {
                            progress(files_found, dirs_found, bytes_found, &full);
                            last_progress = now;
                        }
                    }
                }
            }

            unsafe { close(dir_fd); }
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
    let mut arena = TreeNodeArena::with_capacity(2_000_000);
    let root_name = Path::new(root_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root_path.into());
    let root_idx = arena.alloc(TreeNode {
        name: root_name, size: 0, file_count: 0, dir_count: 1,
        node_type: NodeType::Directory, parent: u32::MAX,
        first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0,
    });
    let mut ptix: HashMap<String, u32> = HashMap::new();
    ptix.insert(root_path.into(), root_idx);
    let mut lc: HashMap<u32, u32> = HashMap::new();

    for entry_result in WalkDir::new(root_path).follow_links(false) {
        if arena.nodes.len() > 20_000_000 { break; }
        let entry = match entry_result { Ok(e) => e, Err(_) => continue };
        let full = entry.path().to_string_lossy().to_string();
        if full == root_path { continue; }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_dir();
        let parent = entry.path().parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let pi = *ptix.get(&parent).unwrap_or(&root_idx);
        if is_dir {
            if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) { continue; }
            let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
            let ci = arena.alloc(TreeNode {
                name: file_name, size: 0, file_count: 0, dir_count: 1,
                node_type: NodeType::Directory, parent: pi,
                first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
            });
            match lc.get(&pi) {
                Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                None => arena.nodes[pi as usize].first_child = ci,
            }
            lc.insert(pi, ci);
            ptix.insert(full, ci);
        } else {
            let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let depth = if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 };
            let ci = arena.alloc(TreeNode {
                name: file_name, size: sz, file_count: 1, dir_count: 0,
                node_type: NodeType::File, parent: pi,
                first_child: u32::MAX, next_sibling: u32::MAX, depth, chunk_id: 0,
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
    }
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
