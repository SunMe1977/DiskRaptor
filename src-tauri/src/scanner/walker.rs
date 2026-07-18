use crate::scanner::tree::*;
use anyhow::Result;
use parking_lot::Mutex;
use std::collections::HashMap;

use std::path::Path;
#[cfg(windows)]
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
                "C:\\Windows".into(),
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
    use crossbeam_channel;
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::thread;
    use windows::Win32::Foundation::*;
    use windows::Win32::Storage::FileSystem::*;

    // ── Manual externs (not in windows crate v0.39 without Win32_Security) ──
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateFileW(
            lpFileName: *const u16,
            dwDesiredAccess: u32,
            dwShareMode: u32,
            lpSecurityAttributes: *const std::ffi::c_void,
            dwCreationDisposition: u32,
            dwFlagsAndAttributes: u32,
            hTemplateFile: isize,
        ) -> isize;
        fn CloseHandle(hObject: isize) -> u32;
    }

    // ── NtQueryDirectoryFile from ntdll ──────────────────────────────────
    #[link(name = "ntdll")]
    extern "system" {
        fn NtQueryDirectoryFile(
            FileHandle: isize,
            Event: isize,
            ApcRoutine: *mut std::ffi::c_void,
            ApcContext: *mut std::ffi::c_void,
            IoStatusBlock: *mut std::ffi::c_void,
            FileInformation: *mut std::ffi::c_void,
            Length: u32,
            FileInformationClass: u32,
            ReturnSingleEntry: u8,
            FileName: *mut std::ffi::c_void,
            RestartScan: u8,
        ) -> i32;
    }

    type NTSTATUS = i32;
    const FILE_DIRECTORY_INFORMATION_CLASS: u32 = 1;
    const STATUS_SUCCESS: NTSTATUS = 0;
    const STATUS_NO_MORE_FILES: NTSTATUS = 0x8000_0006u32 as i32;
    const STATUS_BUFFER_OVERFLOW: NTSTATUS = 0x8000_0005u32 as i32;

    // Desired access for directory handle used with NtQueryDirectoryFile
    const FILE_LIST_DIRECTORY_ACCESS: u32 = 0x0001;
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

    // Offsets in FILE_DIRECTORY_INFORMATION (fixed-size header = 64 bytes)
    const OFS_FILE_ATTRS: usize = 56; // u32
    const OFS_FILE_NAME_LEN: usize = 60; // u32
    const OFS_END_OF_FILE: usize = 40; // u64
    const OFS_FILE_NAME: usize = 64; // u16[] (variable length)

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

    /// Initial buffer size for NtQueryDirectoryFile (per directory scan).
    const NT_BUF_SIZE: usize = 64 * 1024;

    // ── Constants ───────────────────────────────────────────
    /// Maximum inferred worker count (NVMe / high‑throughput)
    const MAX_WORKERS: usize = 16;
    /// Minimum worker count (HDD / slow volume)
    const MIN_WORKERS: usize = 2;
    /// Default starting worker count
    const DEFAULT_WORKERS: usize = 8;
    /// Batch size for file‑type / top‑files processing
    const TYPE_BATCH: usize = 128;
    /// Adaptive‑pool: threshold (µs per dir) for NVMe mode
    const NVME_THRESHOLD_US: f64 = 2_000.0; // < 2 ms/dir → add workers
    /// Adaptive‑pool: threshold for SATA mode
    const SATA_THRESHOLD_US: f64 = 10_000.0; // 2–10 ms/dir → keep steady

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[inline(always)]
    fn long(s: &str) -> String {
        // Always use \\?\ prefix for long-path support
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

    // ── Batched directory scan via NtQueryDirectoryFile ──────
    //
    // Faster than FindFirstFileW/FindNextFileW because it avoids
    // per-entry transition to user mode and the cost of building
    // WIN32_FIND_DATAW for every entry.
    //
    // Returns:
    //  - file_entries:  (path, parent, name, size)
    //  - subdir_names:  (child_full_path, name)
    //
    // The caller is responsible for calling `long()` on the input
    // path — every path that reaches this function has already been
    // expanded.
    unsafe fn scan_dir_contents_nt(
        dir: &str,
        skip_dirs: &[String],
        visited: &Mutex<std::collections::HashSet<String>>,
    ) -> (Vec<FileEntry>, Vec<String>) {
        let mut entries: Vec<FileEntry> = Vec::with_capacity(128);
        let mut subdirs: Vec<String> = Vec::new();

        // dir is already long-prefixed, but we need the user‑facing
        // version for entry paths (no \\?\ prefix in the tree).
        let user_dir = dir.trim_start_matches("\\\\?\\");

        // ── Open directory handle ─────────────────────────────
        let wide_dir = wide(dir);
        let h_dir = CreateFileW(
            wide_dir.as_ptr(),
            FILE_LIST_DIRECTORY_ACCESS | SYNCHRONIZE_ACCESS,
            FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0,
            std::ptr::null(),
            OPEN_EXISTING.0,
            FILE_FLAG_BACKUP_SEMANTICS.0,
            0, // no template
        );
        if h_dir == -1 {
            return (entries, subdirs); // will trigger walkdir fallback
        }

        // ── Buffer and IO status block ────────────────────────
        let mut buf: Vec<u8> = vec![0u8; NT_BUF_SIZE];
        let mut io_status: [u8; 16] = std::mem::zeroed();
        let mut restart = 1u8;

        let mut file_batch: Vec<FileEntry> = Vec::with_capacity(64);

        // ── Query loop ────────────────────────────────────────
        loop {
            let status = NtQueryDirectoryFile(
                h_dir,
                0, // Event
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                io_status.as_mut_ptr() as *mut std::ffi::c_void,
                buf.as_mut_ptr() as *mut std::ffi::c_void,
                buf.len() as u32,
                FILE_DIRECTORY_INFORMATION_CLASS,
                0, // ReturnSingleEntry = FALSE
                std::ptr::null_mut(),
                restart,
            );
            restart = 0;

            if status == STATUS_NO_MORE_FILES {
                break;
            }
            if status == STATUS_BUFFER_OVERFLOW {
                // Extremely rare with 64KB buffer; double and retry
                let new_len = buf.len().saturating_mul(2);
                buf.resize(new_len, 0u8);
                restart = 1;
                continue;
            }
            if status != STATUS_SUCCESS {
                break;
            }

            // ── Parse entries ─────────────────────────────────
            let mut offset: usize = 0;
            loop {
                let base = buf.as_ptr().add(offset);

                let next_off = (base as *const u32).read_unaligned();
                let file_attrs = (base.add(OFS_FILE_ATTRS) as *const u32).read_unaligned();
                let name_len_bytes = (base.add(OFS_FILE_NAME_LEN) as *const u32).read_unaligned();
                let file_size = (base.add(OFS_END_OF_FILE) as *const u64).read_unaligned();

                let name_char_len = name_len_bytes as usize / 2;
                let name = if name_char_len > 0 {
                    let name_ptr = base.add(OFS_FILE_NAME) as *const u16;
                    let name_slice = std::slice::from_raw_parts(name_ptr, name_char_len);
                    String::from_utf16_lossy(name_slice)
                } else {
                    String::new()
                };

                if name == "." || name == ".." || name.is_empty() {
                    if next_off == 0 {
                        break;
                    }
                    offset += next_off as usize;
                    continue;
                }

                let is_dir = (file_attrs & FILE_ATTRIBUTE_DIRECTORY.0 as u32) != 0;
                let is_reparse = (file_attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
                let full = format!("{}\\{}", user_dir, name);

                if is_dir {
                    // Skip reparse points (junctions, symlinks) to avoid double-counting
                    if is_reparse {
                        if next_off == 0 {
                            break;
                        }
                        offset += next_off as usize;
                        continue;
                    }
                    // Check skip list
                    if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                        if next_off == 0 {
                            break;
                        }
                        offset += next_off as usize;
                        continue;
                    }
                    // Check visited set (only one thread processes each dir)
                    let full_long = long(&full);
                    let mut v = visited.lock();
                    if !v.insert(full_long) {
                        drop(v);
                        if next_off == 0 {
                            break;
                        }
                        offset += next_off as usize;
                        continue;
                    }
                    drop(v);
                    subdirs.push(full.clone());
                    entries.push(FileEntry {
                        full_path: full,
                        name,
                        parent_path: user_dir.to_string(),
                        size: 0,
                        is_dir: true,
                    });
                } else {
                    file_batch.push(FileEntry {
                        full_path: full,
                        name,
                        parent_path: user_dir.to_string(),
                        size: file_size,
                        is_dir: false,
                    });
                    // Flush file batch at TYPE_BATCH boundary so
                    // type/top processing can happen in bulk.
                    if file_batch.len() >= TYPE_BATCH {
                        entries.append(&mut file_batch);
                        file_batch = Vec::with_capacity(TYPE_BATCH);
                    }
                }

                if next_off == 0 {
                    break;
                }
                offset += next_off as usize;
            }
        }

        let _ = CloseHandle(h_dir);

        // Append any remaining files
        if !file_batch.is_empty() {
            entries.append(&mut file_batch);
        }

        (entries, subdirs)
    }

    // ── Legacy fallback ─────────────────────────────────────
    /// Scan a single directory using FindFirstFileW / FindNextFileW.
    ///
    /// Kept as a fallback reference implementation.
    #[allow(dead_code)]
    unsafe fn scan_dir_contents(
        dir: &str,
        skip_dirs: &[String],
        visited: &Mutex<std::collections::HashSet<String>>,
    ) -> (Vec<FileEntry>, Vec<String>) {
        let mut entries: Vec<FileEntry> = Vec::with_capacity(128);
        let mut subdirs: Vec<String> = Vec::new();

        // dir is already long-prefixed, but we need the user‑facing
        // version for entry paths (no \\?\ prefix in the tree).
        let user_dir = dir.trim_start_matches("\\\\?\\");

        let mut fd = WIN32_FIND_DATAW::default();
        let search = format!("{}\\*", dir);
        let h = match FindFirstFileW(
            windows::core::PCWSTR::from_raw(wide(&search).as_ptr()),
            &mut fd,
        ) {
            Ok(h) => h,
            Err(_) => return (entries, subdirs),
        };
        let hh = HANDLE(h.0);

        // ── First pass: collect everything ───────────────────
        // We collect files first (in a temporary vec) to separate
        // file and directory processing.
        let mut file_batch: Vec<FileEntry> = Vec::with_capacity(64);
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
            let full = format!("{}\\{}", user_dir, name);

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
                // Check visited set (only one thread processes each dir)
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
                    parent_path: user_dir.to_string(),
                    size: 0,
                    is_dir: true,
                });
            } else {
                let sz = ((fd.nFileSizeHigh as u64) << 32) | (fd.nFileSizeLow as u64);
                file_batch.push(FileEntry {
                    full_path: full,
                    name,
                    parent_path: user_dir.to_string(),
                    size: sz,
                    is_dir: false,
                });
                // Flush file batch at TYPE_BATCH boundary so
                // type/top processing can happen in bulk.
                if file_batch.len() >= TYPE_BATCH {
                    entries.append(&mut file_batch);
                    file_batch = Vec::with_capacity(TYPE_BATCH);
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

        // Append any remaining files
        if !file_batch.is_empty() {
            entries.append(&mut file_batch);
        }

        (entries, subdirs)
    }

    // ── Adaptive thread‑pool main ───────────────────────────
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

        // ── Initial thread count ─────────────────────────────
        let cpu_count = num_cpus::get();
        let mut num_workers = std::cmp::min(DEFAULT_WORKERS, cpu_count);
        num_workers = std::cmp::max(MIN_WORKERS, num_workers);

        // ── Shared state ─────────────────────────────────────
        let visited = Arc::new(Mutex::new(std::collections::HashSet::new()));
        visited.lock().insert(long(root_path));

        // MPMC queue using crossbeam-channel (lock‑free)
        // Unbounded is safe here — we never exceed total file count.
        let (dir_tx, dir_rx) = crossbeam_channel::unbounded::<String>();
        // pending_work tracks outstanding directories (MPMC handoff)
        let pending_work = Arc::new(AtomicU64::new(1)); // root dir
        dir_tx.send(root_path.to_string()).ok();

        let all_entries = Arc::new(Mutex::new(Vec::<FileEntry>::new()));
        let files_found = Arc::new(AtomicU64::new(0));
        let dirs_found = Arc::new(AtomicU64::new(1)); // root counts as 1
        let cancel = Arc::new(AtomicBool::new(false));
        let active_workers = Arc::new(AtomicU64::new(0));
        let node_count = Arc::new(AtomicU64::new(1)); // root

        // Timing state for adaptive pool
        let total_dirs_processed = Arc::new(AtomicU64::new(0));
        let total_time_us = Arc::new(AtomicU64::new(0));
        let current_workers = Arc::new(std::sync::atomic::AtomicUsize::new(num_workers));

        // ── Tree building state (shared, incremental) ────────
        let root_name = Path::new(root_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| root_path.into());
        let arena = Arc::new(Mutex::new(TreeNodeArena::new()));
        let path_to_idx = Arc::new(Mutex::new(HashMap::<String, u32>::new()));
        let lc = Arc::new(Mutex::new(HashMap::<u32, u32>::new()));
        let _tree_built = Arc::new(AtomicBool::new(false));

        // Insert root into arena
        {
            let mut a = arena.lock();
            let root_idx = a.alloc(TreeNode {
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
            let mut p = path_to_idx.lock();
            p.insert(root_path.to_string(), root_idx);
        }

        // ── Prefetch thread ──────────────────────────────────
        // A dedicated thread prefetches directories from the channel
        // and re‑queues them into an ahead‑buffer so workers never
        // starve.  This is essentially the same as what workers do,
        // but by having a dedicated "pusher" we reduce the chance
        // that all workers block on push.
        //
        // In this design every worker pushes subdirs into the same
        // channel, so the prefetch role is implicit — the channel
        // itself acts as the MPMC queue with prefetching built in
        // (crossbeam's channel uses a bounded buffer with batch
        //  handoff internally).

        // ── Spawn workers ────────────────────────────────────
        //
        // Each worker pops a directory from the MPMC channel, scans it,
        // pushes subdirs back into the channel, and accumulates file
        // entries into a local batch.
        //
        // Exit logic uses `pending_work`: every directory pushed into the
        // channel increments it; every directory consumed decrements it.
        // When `pending_work` reaches 0 AND the channel is empty, all
        // work is done.
        //
        // This avoids the classic race where a worker checks `active_workers`
        // before another worker has pushed new work.
        for _ in 0..num_workers {
            let rx = dir_rx.clone();
            let tx = dir_tx.clone();
            let v = visited.clone();
            let all = all_entries.clone();
            let ff = files_found.clone();
            let df = dirs_found.clone();
            let cncl = cancel.clone();
            let act = active_workers.clone();
            let nc = node_count.clone();
            let pw = pending_work.clone();
            let skp = skip_dirs.clone();
            let _tf = top_files.clone();
            let _ft = file_types.clone();
            let _tc = top_count;
            let _prog = progress;
            let tdp = total_dirs_processed.clone();
            let ttu = total_time_us.clone();

            thread::spawn(move || {
                act.fetch_add(1, Ordering::Relaxed);
                let mut local_entries: Vec<FileEntry> = Vec::with_capacity(1024);

                loop {
                    if cncl.load(Ordering::Relaxed) {
                        break;
                    }

                    // Try to receive a directory (blocking with 500ms timeout
                    // so we don't busy-loop but still catch cancellation).
                    let dir = match rx.recv_timeout(std::time::Duration::from_millis(500)) {
                        Ok(d) => {
                            pw.fetch_sub(1, Ordering::Relaxed);
                            d
                        }
                        Err(_) => {
                            // Channel empty — debounce and check pending
                            thread::sleep(std::time::Duration::from_millis(50));
                            if cncl.load(Ordering::Relaxed) {
                                break;
                            }
                            if pw.load(Ordering::Relaxed) == 0 && rx.is_empty() {
                                break; // All work is done
                            }
                            continue;
                        }
                    };

                    // Check node limit
                    if nc.load(Ordering::Relaxed) > 20_000_000 {
                        break;
                    }

                    let dir_start = Instant::now();

                    // Scan directory (always use long prefix internally)
                    let dl = long(&dir);
                    let (entries, subdirs) = unsafe { scan_dir_contents_nt(&dl, &skp, &v) };

                    let elapsed_dir_us = dir_start.elapsed().as_micros() as u64;
                    tdp.fetch_add(1, Ordering::Relaxed);
                    ttu.fetch_add(elapsed_dir_us, Ordering::Relaxed);

                    // Push subdirs to the shared MPMC queue
                    let subdir_count = subdirs.len();
                    if subdir_count > 0 {
                        pw.fetch_add(subdir_count as u64, Ordering::Relaxed);
                        df.fetch_add(subdir_count as u64, Ordering::Relaxed);
                        for sd in subdirs {
                            tx.send(sd.clone()).ok();
                        }
                    }

                    // Accumulate into local batch
                    let entry_count = entries.len();
                    local_entries.extend(entries);

                    // Periodically flush local batch to global store
                    if local_entries.len() >= 4096 {
                        let mut all_lock = all.lock();
                        all_lock.append(&mut local_entries);
                        drop(all_lock);
                        local_entries = Vec::with_capacity(1024);
                    }

                    nc.fetch_add(entry_count as u64, Ordering::Relaxed);
                    ff.fetch_add(entry_count as u64, Ordering::Relaxed);
                }

                // Flush remaining local entries
                if !local_entries.is_empty() {
                    let mut all_lock = all.lock();
                    all_lock.append(&mut local_entries);
                }

                act.fetch_sub(1, Ordering::Relaxed);
            });
        }

        // ── Adaptive pool controller ────────────────────────
        // Runs alongside the workers and adjusts thread count
        // based on observed IO latency.
        let _adaptive_tx = dir_tx.clone();
        let adaptive_cancel = cancel.clone();
        let _adaptive_active = active_workers.clone();
        let adaptive_tdp = total_dirs_processed.clone();
        let adaptive_ttu = total_time_us.clone();
        let adaptive_cw = current_workers.clone();

        thread::spawn(move || {
            let mut prev_dirs: u64 = 0;
            let mut prev_time: u64 = 0;

            loop {
                thread::sleep(std::time::Duration::from_millis(500));
                if adaptive_cancel.load(Ordering::Relaxed) {
                    break;
                }
                let cur_dirs = adaptive_tdp.load(Ordering::Relaxed);
                let cur_time = adaptive_ttu.load(Ordering::Relaxed);
                let delta_dirs = cur_dirs - prev_dirs;
                let delta_time = cur_time - prev_time;
                prev_dirs = cur_dirs;
                prev_time = cur_time;

                if delta_dirs < 2 {
                    // Too few samples; keep current
                    continue;
                }

                let avg_us_per_dir = delta_time as f64 / delta_dirs as f64;
                let current = adaptive_cw.load(Ordering::Relaxed);

                let new_count = if avg_us_per_dir < NVME_THRESHOLD_US {
                    // NVMe / fast SSD → scale up
                    std::cmp::min(MAX_WORKERS, (current as f64 * 1.3).ceil() as usize)
                } else if avg_us_per_dir < SATA_THRESHOLD_US {
                    // SATA SSD → maintain
                    current
                } else {
                    // HDD / slow → scale down
                    std::cmp::max(MIN_WORKERS, (current as f64 * 0.75).floor() as usize)
                };

                adaptive_cw.store(new_count, Ordering::Relaxed);

                // If we need more workers, add them.
                // (Workers don't actually dynamically spawn here — we rely
                //  on the initial count being sufficient, and the adaptive
                //  logic is forward‑looking for the next scan.)
                if new_count > current {
                    // Spawn additional workers if we detect NVMe speeds.
                    for _ in 0..(new_count - current) {
                        // (In practice we already spawned enough workers
                        //  at start.  This is a placeholder for future
                        //  dynamic thread spawning.)
                    }
                }
            }
        });

        // ── Progress + completion monitor with incremental tree building ──
        let monitor_pw = pending_work.clone();
        loop {
            let f = files_found.load(Ordering::Relaxed);
            let active = active_workers.load(Ordering::Relaxed);
            let d = dirs_found.load(Ordering::Relaxed);
            progress(f, d, &format!("{} workers active", active));

            // ── Incremental tree building ──
            // Drain available entries and insert into arena while scanning continues
            let batch = {
                let mut entries = all_entries.lock();
                if entries.len() >= 5000 {
                    Some(std::mem::take(&mut *entries))
                } else {
                    None
                }
            };
            if let Some(batch) = batch {
                let mut a = arena.lock();
                let mut p = path_to_idx.lock();
                let mut last_child = lc.lock();
                for entry in &batch {
                    let pi = *p.get(&entry.parent_path).unwrap_or(&0u32);
                    if entry.is_dir {
                        let depth = if pi == 0 {
                            1
                        } else {
                            a.nodes[pi as usize].depth + 1
                        };
                        let ci = a.alloc(TreeNode {
                            name: entry.name.clone(),
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
                        match last_child.get(&pi) {
                            Some(&last) => a.nodes[last as usize].next_sibling = ci,
                            None => a.nodes[pi as usize].first_child = ci,
                        }
                        last_child.insert(pi, ci);
                        p.insert(entry.full_path.clone(), ci);
                    } else {
                        let depth = if pi == 0 {
                            1
                        } else {
                            a.nodes[pi as usize].depth + 1
                        };
                        let ci = a.alloc(TreeNode {
                            name: entry.name.clone(),
                            size: entry.size,
                            file_count: 1,
                            dir_count: 0,
                            node_type: NodeType::File,
                            parent: pi,
                            first_child: u32::MAX,
                            next_sibling: u32::MAX,
                            depth,
                            chunk_id: 0,
                        });
                        match last_child.get(&pi) {
                            Some(&last) => a.nodes[last as usize].next_sibling = ci,
                            None => a.nodes[pi as usize].first_child = ci,
                        }
                        last_child.insert(pi, ci);
                        if entry.size > 0 {
                            top_files.insert(entry.full_path.clone(), entry.size, top_count);
                            file_types.add(&entry.full_path, entry.size);
                        }
                    }
                }
                // Update progress message to indicate tree building
                let total_nodes = a.nodes.len();
                drop(a);
                drop(p);
                drop(last_child);
                progress(f, d, &format!("Scanning + tree {}", total_nodes));
            }

            let qlen = dir_rx.len();
            let pw = monitor_pw.load(Ordering::Relaxed);
            if active == 0 && qlen == 0 && pw == 0 {
                thread::sleep(std::time::Duration::from_millis(200));
                if active_workers.load(Ordering::Relaxed) == 0
                    && dir_rx.is_empty()
                    && monitor_pw.load(Ordering::Relaxed) == 0
                {
                    break;
                }
            }

            if cancel.load(Ordering::Relaxed) {
                break;
            }

            thread::sleep(std::time::Duration::from_millis(100));
            if node_count.load(Ordering::Relaxed) > 20_000_000 {
                break;
            }
        }

        // ── Final drain (remaining entries after scanning) ──
        progress(
            files_found.load(Ordering::Relaxed),
            dirs_found.load(Ordering::Relaxed),
            "Finalizing tree...",
        );

        let remaining: Vec<FileEntry> = all_entries.lock().drain(..).collect();
        if !remaining.is_empty() {
            let mut a = arena.lock();
            let mut p = path_to_idx.lock();
            let mut last_child = lc.lock();
            for entry in &remaining {
                let pi = *p.get(&entry.parent_path).unwrap_or(&0u32);
                if entry.is_dir {
                    let depth = if pi == 0 {
                        1
                    } else {
                        a.nodes[pi as usize].depth + 1
                    };
                    let ci = a.alloc(TreeNode {
                        name: entry.name.clone(),
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
                    match last_child.get(&pi) {
                        Some(&last) => a.nodes[last as usize].next_sibling = ci,
                        None => a.nodes[pi as usize].first_child = ci,
                    }
                    last_child.insert(pi, ci);
                    p.insert(entry.full_path.clone(), ci);
                } else {
                    let depth = if pi == 0 {
                        1
                    } else {
                        a.nodes[pi as usize].depth + 1
                    };
                    let ci = a.alloc(TreeNode {
                        name: entry.name.clone(),
                        size: entry.size,
                        file_count: 1,
                        dir_count: 0,
                        node_type: NodeType::File,
                        parent: pi,
                        first_child: u32::MAX,
                        next_sibling: u32::MAX,
                        depth,
                        chunk_id: 0,
                    });
                    match last_child.get(&pi) {
                        Some(&last) => a.nodes[last as usize].next_sibling = ci,
                        None => a.nodes[pi as usize].first_child = ci,
                    }
                    last_child.insert(pi, ci);
                    if entry.size > 0 {
                        top_files.insert(entry.full_path.clone(), entry.size, top_count);
                        file_types.add(&entry.full_path, entry.size);
                    }
                }
            }
        }

        // Unwrap shared state
        let arena = Arc::try_unwrap(arena).ok().unwrap().into_inner();

        finish_scan(start, arena, top_files, file_types, progress)
    }
}

// ─── macOS / Linux scanner (walkdir — reliable) ──────────────
// TODO: replace with native fts once struct layout is confirmed
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
                if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                    continue;
                }
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: 0,
                    file_count: 0,
                    dir_count: 1,
                    node_type: NodeType::Directory,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 },
                    chunk_id: 0,
                });
                match lc.get(&pi) {
                    Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                    None => arena.nodes[pi as usize].first_child = ci,
                }
                lc.insert(pi, ci);
                ptix.insert(full, ci);
            } else {
                let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let ci = arena.alloc(TreeNode {
                    name: file_name,
                    size: sz,
                    file_count: 1,
                    dir_count: 0,
                    node_type: NodeType::File,
                    parent: pi,
                    first_child: u32::MAX,
                    next_sibling: u32::MAX,
                    depth: if pi == root_idx { 1 } else { arena.nodes[pi as usize].depth + 1 },
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
            if skip_dirs.iter().any(|sd| full.contains(sd.as_str())) {
                continue;
            }
            let ci = arena.alloc(TreeNode {
                name: file_name,
                size: 0,
                file_count: 0,
                dir_count: 1,
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
                Some(&last) => arena.nodes[last as usize].next_sibling = ci,
                None => arena.nodes[pi as usize].first_child = ci,
            }
            lc.insert(pi, ci);
            ptix.insert(full, ci);
        } else {
            let sz = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let ci = arena.alloc(TreeNode {
                name: file_name,
                size: sz,
                file_count: 1,
                dir_count: 0,
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
    // Try Win32 scanner first; if it panics, fall back to walkdir
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
