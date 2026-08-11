//! macOS-native fast scanner using getattrlistbulk.
//!
//! Why this is faster than jwalk on macOS:
//! - `getattrlistbulk` returns name, object type, logical size and mtime for a
//!   whole batch of directory entries in a single syscall — no separate
//!   `metadata()`/`stat()` per entry (jwalk issues an extra stat per file).
//! - Iterative traversal with an explicit directory stack, so deep trees can't
//!   overflow the call stack.
//! - The kernel caps the return buffer at `ATTR_MAX_BUFFER` (8192) bytes, so
//!   that is the largest useful batch per call.
//!
//! The tree is built with the same arena helpers as the cross-platform walkers,
//! so results are byte-identical in structure (same node layout, same stats).
//! Only macOS uses this; other platforms keep jwalk.

#![cfg(target_os = "macos")]

use crate::scanner::tree::*;
use crate::scanner::walker::{
    FileTypeAccum, ScanConfig, ScanProgressCallback, ScanResult, ScanTermination, TopFilesAccum,
    finish_scan,
};
use anyhow::Result;
use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::c_int;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// getattrlistbulk object types (`vtype` enum from <sys/vnode.h>).
const VDIR: u32 = 2;
const VLNK: u32 = 5;

/// ATTR_CMN_ERROR is not exported by libc.
const ATTR_CMN_ERROR: u32 = 0x20000000;

/// Attributes requested for every directory entry.
const REQ_COMMON: u32 = libc::ATTR_CMN_RETURNED_ATTRS
    | ATTR_CMN_ERROR
    | libc::ATTR_CMN_NAME
    | libc::ATTR_CMN_OBJTYPE
    | libc::ATTR_CMN_MODTIME;
const REQ_FILE: u32 = libc::ATTR_FILE_TOTALSIZE;

/// The kernel silently caps the buffer at ATTR_MAX_BUFFER (8192) bytes, so
/// larger buffers buy nothing.
const ATTR_BUF_SIZE: usize = 8192;

/// A directory entry as returned by getattrlistbulk, with the name decoded.
#[derive(Debug)]
struct MacEntry {
    name: String,
    objtype: u32,
    size: u64,
    mtime: u64,
}

/// Read a u32 at an arbitrary (possibly 4-aligned) offset without triggering
/// unaligned-access UB (8-byte values like off_t can sit at mod 8 == 4).
#[inline]
fn rd_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

#[inline]
fn rd_i64(buf: &[u8], off: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&buf[off..off + 8]);
    i64::from_ne_bytes(b)
}

/// Parse `count` entries from one getattrlistbulk batch.
///
/// Each group starts with a 4-byte total length followed by an
/// `attribute_set_t` (RETURNED_ATTRS). Remaining attributes are packed in the
/// order documented by getattrlistbulk(2): ERROR, NAME, OBJTYPE, MODTIME, then
/// the file-group attrs (TOTALSIZE). All values are 4-byte aligned, so the
/// parser just walks forward with no padding.
fn parse_entries(buf: &[u8], count: i32, out: &mut Vec<MacEntry>) {
    let mut off = 0usize;
    for _ in 0..count {
        if off + 4 > buf.len() {
            break;
        }
        let group_len = rd_u32(buf, off) as usize;
        if group_len < 24 || off + group_len > buf.len() {
            break;
        }
        let group_end = off + group_len;
        let mut cur = off + 4;

        // attribute_set_t: five u32 bitmaps.
        let common_ret = rd_u32(buf, cur);
        let file_ret = rd_u32(buf, cur + 12);
        cur += 20;

        if common_ret & ATTR_CMN_ERROR != 0 {
            let err = rd_u32(buf, cur);
            cur += 4;
            if err != 0 {
                // Entry-specific error (e.g. I/O); skip the rest of the group.
                off = group_end;
                continue;
            }
        }

        let mut name: Option<String> = None;
        let mut objtype: u32 = 0;
        let mut mtime: i64 = 0;
        let mut size: i64 = 0;

        if common_ret & libc::ATTR_CMN_NAME != 0 {
            let dataoffset = rd_u32(buf, cur) as i32;
            let namelen = rd_u32(buf, cur + 4) as usize;
            let name_pos = (cur as i64) + (dataoffset as i64);
            if name_pos >= 0 {
                let p = name_pos as usize;
                let len = namelen.min(group_end.saturating_sub(p));
                let bytes = &buf[p..p + len];
                name = Some(String::from_utf8_lossy(bytes).trim_end_matches('\0').to_string());
            }
            cur += 8;
        }
        if common_ret & libc::ATTR_CMN_OBJTYPE != 0 {
            objtype = rd_u32(buf, cur);
            cur += 4;
        }
        if common_ret & libc::ATTR_CMN_MODTIME != 0 {
            mtime = rd_i64(buf, cur);
            cur += 16; // struct timespec { tv_sec, tv_nsec }
        }
        if file_ret & libc::ATTR_FILE_TOTALSIZE != 0 {
            size = rd_i64(buf, cur);
        }

        if let Some(name) = name {
            out.push(MacEntry {
                name,
                objtype,
                size: size.max(0) as u64,
                mtime: if mtime > 0 { mtime as u64 } else { 0 },
            });
        }
        off = group_end;
    }
}

struct FdGuard(c_int);
impl Drop for FdGuard {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.0);
        }
    }
}

/// Enumerate `dir`, calling `f` for every entry (getattrlistbulk never returns
/// "." or "..").
/// Returns Err only for hard failures (open/read denied on the dir itself).
fn read_dir<F: FnMut(MacEntry)>(dir: &str, mut f: F) -> std::io::Result<()> {
    let c_path = match CString::new(Path::new(dir).as_os_str().as_bytes()) {
        Ok(c) => c,
        Err(_) => return Ok(()), // interior NUL cannot exist in real paths
    };
    let dirfd = unsafe {
        libc::open(
            c_path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if dirfd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let _guard = FdGuard(dirfd);

    let mut attr_list = libc::attrlist {
        bitmapcount: libc::ATTR_BIT_MAP_COUNT,
        reserved: 0,
        commonattr: REQ_COMMON,
        volattr: 0,
        dirattr: 0,
        fileattr: REQ_FILE,
        forkattr: 0,
    };

    let mut buf = [0u8; ATTR_BUF_SIZE];
    let mut entries: Vec<MacEntry> = Vec::with_capacity(256);
    loop {
        entries.clear();
        let n = unsafe {
            libc::getattrlistbulk(
                dirfd,
                &mut attr_list as *mut libc::attrlist as *mut std::ffi::c_void,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                buf.len(),
                0,
            )
        };
        if n < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if n == 0 {
            break; // no more entries
        }
        parse_entries(&buf, n, &mut entries);
        for e in entries.drain(..) {
            f(e);
        }
    }
    Ok(())
}

/// macOS-native scan. The arena/statistics logic mirrors the jwalk walker so
/// the resulting tree and stats are identical; only the directory enumeration
/// differs (getattrlistbulk instead of read_dir+metadata). Uses N worker
/// threads that pull directories off a shared queue, so several directories
/// are enumerated in parallel — this is where the speed vs. single-threaded
/// walks comes from.
pub fn scan(
    config: &ScanConfig,
    progress: Arc<ScanProgressCallback>,
    root_path: &str,
) -> Result<ScanResult> {
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;

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

    let progress_arc = progress.clone();

    let arena = Arc::new(StdMutex::new(TreeNodeArena::with_estimated_capacity(root_path)));
    let root_idx = alloc_root(&mut arena.lock().unwrap(), root_path);
    let ptix: Arc<StdMutex<HashMap<String, u32>>> = Arc::new(StdMutex::new(HashMap::new()));
    ptix.lock().unwrap().insert(root_path.to_string(), root_idx);
    let lc: Arc<StdMutex<HashMap<u32, u32>>> = Arc::new(StdMutex::new(HashMap::new()));

    let node_cap = {
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let avail = sys.available_memory().max(256 * 1024 * 1024);
        (avail / 128).clamp(500_000, 20_000_000) as usize
    };

    let files_found = Arc::new(StdMutex::new(0u64));
    let dirs_found = Arc::new(StdMutex::new(0u64));
    let bytes_found = Arc::new(StdMutex::new(0u64));
    let termination: Arc<StdMutex<ScanTermination>> =
        Arc::new(StdMutex::new(ScanTermination::Completed));
    let stop_flag = Arc::new(AtomicBool::new(false));

    // Shared work queue. Initially the root directory.
    let queue: Arc<StdMutex<VecDeque<(String, u32)>>> = Arc::new(StdMutex::new(VecDeque::new()));
    queue.lock().unwrap().push_back((root_path.to_string(), root_idx));

    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8);
    let progress_start = Instant::now();
    let mut handles = Vec::new();
    for _ in 0..workers {
        let queue = queue.clone();
        let arena = arena.clone();
        let ptix = ptix.clone();
        let lc = lc.clone();
        let top_files = top_files.clone();
        let file_types = file_types.clone();
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
            // the timeout is a *no-progress* watchdog, not a wall-clock limit,
            // so a slow-but-moving scan (e.g. a 1M-file home folder) never gets
            // cut off at `timeout` seconds.
            let mut last_progress = progress_start;
            loop {
                // Take a directory from the queue.
                let (dir_path, parent_idx) = {
                    let mut q = queue.lock().unwrap();
                    match q.pop_front() {
                        Some(item) => item,
                        None => return, // no more work
                    }
                };

                if stop_flag.load(Ordering::Relaxed) {
                    return;
                }

                let node_count = arena.lock().unwrap().nodes.len();
                if node_count > node_cap {
                    *termination.lock().unwrap() = ScanTermination::LimitReached;
                    stop_flag.store(true, Ordering::Relaxed);
                    return;
                }

                if dir_path != root_path
                    && skip_dirs.iter().any(|sd| path_has_component(&dir_path, sd.as_str()))
                {
                    continue;
                }

                let mut new_dirs: Vec<(String, u32)> = Vec::new();
                let mut local_files = 0u64;
                let mut local_bytes = 0u64;
                let mut local_entries: Vec<(String, bool, u64, u64)> =
                    Vec::new(); // name, is_dir, size, mtime

                let read_res = read_dir(&dir_path, |e| {
                    push_live(&live_entries, &e.name);
                    match e.objtype {
                        VDIR => {
                            local_entries.push((e.name.clone(), true, 0, e.mtime));
                        }
                        VLNK => {
                            // getattrlistbulk reports the link itself, not the
                            // target. jwalk reports the link's own size/mtime
                            // (lstat semantics), and only resolves the target
                            // to decide whether to descend when following
                            // symlinked directories is enabled.
                            let full = format!("{}/{}", dir_path, e.name);
                            match std::fs::symlink_metadata(&full) {
                                Ok(meta) => {
                                    let mut is_dir = false;
                                    if follow_symlinks {
                                        is_dir = std::fs::metadata(&full)
                                            .map(|m| m.is_dir())
                                            .unwrap_or(false);
                                    }
                                    if is_dir {
                                        local_entries.push((e.name.clone(), true, 0, e.mtime));
                                    } else {
                                        let sz = meta.len();
                                        let mt = meta
                                            .modified()
                                            .ok()
                                            .and_then(|t| {
                                                t.duration_since(std::time::UNIX_EPOCH).ok()
                                            })
                                            .map(|d| d.as_secs())
                                            .unwrap_or(e.mtime);
                                        local_bytes += sz;
                                        local_files += 1;
                                        local_entries.push((e.name.clone(), false, sz, mt));
                                    }
                                }
                                Err(_) => {
                                    // Dangling link: counted as an empty file.
                                    local_entries.push((e.name.clone(), false, 0, e.mtime));
                                }
                            }
                        }
                        _ => {
                            // VREG (regular files) plus devices, sockets,
                            // fifos and unknown types: count as files with
                            // their reported size.
                            local_bytes += e.size;
                            local_files += 1;
                            local_entries.push((e.name.clone(), false, e.size, e.mtime));
                        }
                    }
                });

                if let Err(err) = read_res {
                    let mut errs = errors.lock();
                    if errs.len() < 100 {
                        let kind = err.kind();
                        errs.push(match kind {
                            std::io::ErrorKind::NotFound => {
                                format!("Not found: {}", dir_path)
                            }
                            std::io::ErrorKind::PermissionDenied => {
                                format!("Access denied: {}", dir_path)
                            }
                            _ => format!("Cannot read {}: {}", dir_path, err),
                        });
                    }
                }

                // Insert all entries of this directory with a single arena lock.
                {
                    let mut ar = arena.lock().unwrap();
                    let mut ptx = ptix.lock().unwrap();
                    let mut lc2 = lc.lock().unwrap();
                    let depth = child_depth(&ar, parent_idx, root_idx);
                    for (name, is_dir, size, mtime) in local_entries {
                        if is_dir {
                            let ci = alloc_directory(&mut ar, name.clone(), parent_idx, depth);
                            link_child(&mut ar, &mut lc2, parent_idx, ci);
                            let child_path = format!("{}/{}", dir_path, name);
                            ptx.insert(child_path.clone(), ci);
                            new_dirs.push((child_path, ci));
                        } else {
                            let ci = alloc_file(&mut ar, name.clone(), size, parent_idx, depth, mtime);
                            link_child(&mut ar, &mut lc2, parent_idx, ci);
                            if size > 0 {
                                let full = format!("{}/{}", dir_path, name);
                                top_files.insert(full, size, top_count);
                                file_types.add(&name, size);
                            }
                        }
                    }
                }

                {
                    let mut ff = files_found.lock().unwrap();
                    *ff += local_files;
                }
                {
                    let mut bb = bytes_found.lock().unwrap();
                    *bb += local_bytes;
                }
                {
                    let mut df = dirs_found.lock().unwrap();
                    *df += new_dirs.len() as u64;
                }

                // Enqueue newly discovered subdirectories.
                {
                    let mut q = queue.lock().unwrap();
                    for d in new_dirs {
                        q.push_back(d);
                    }
                }

                // Cancellation / timeout checks.
                if let Some(ref cf) = cancel {
                    if cf.load(Ordering::Relaxed) {
                        *termination.lock().unwrap() = ScanTermination::Cancelled;
                        stop_flag.store(true, Ordering::Relaxed);
                        return;
                    }
                }
                if timeout > 0 && last_progress.elapsed().as_secs() > timeout {
                    let mut errs = errors.lock();
                    if errs.len() < 100 {
                        errs.push(format!("TIMEOUT: No progress for {}s at {}", timeout, root_path));
                    }
                    *termination.lock().unwrap() = ScanTermination::TimedOut;
                    stop_flag.store(true, Ordering::Relaxed);
                    return;
                }

                if progress_start.elapsed().as_millis() >= 100 {
                    let f = *files_found.lock().unwrap();
                    let d = *dirs_found.lock().unwrap();
                    let b = *bytes_found.lock().unwrap();
                    progress(f, d, b, &dir_path);
                    last_progress = Instant::now();
                }
            }
        }));
    }
    for h in handles {
        let _ = h.join();
    }

    let f = *files_found.lock().unwrap();
    let d = *dirs_found.lock().unwrap();
    let b = *bytes_found.lock().unwrap();
    progress_arc(f, d, b, "Finalizing tree...");

    let arena = Arc::try_unwrap(arena)
        .map_err(|_| anyhow::anyhow!("arena Arc leaked"))?
        .into_inner()
        .map_err(|e| anyhow::anyhow!("arena mutex poisoned: {e}"))?;
    let term = *termination.lock().unwrap();
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
    let root_name = Path::new(root_path)
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
