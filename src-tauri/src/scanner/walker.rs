use crate::scanner::tree::*;
use crate::scanner::activity::{record_error, ScanActivity};
use anyhow::Result;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tracing::{warn, error};

pub type ScanProgressCallback = Box<dyn Fn(u64, u64, u64, &str) + Send + Sync>;

pub struct ScanConfig {
    pub activity: Arc<super::activity::ScanActivity>,
    pub root_path: String,
    pub skip_dirs: Vec<String>,
    pub top_file_min_size: u64,
    pub top_files_count: usize,
    pub follow_symlinks: bool,
    /// No-progress limit; zero disables it. The app's outer watchdog can also
    /// detach a blocked worker, whereas cooperative checks cannot interrupt I/O.
    pub scan_timeout_secs: u64,
    /// Shared error list â€” scanner pushes inaccessible paths here
    pub errors: std::sync::Arc<parking_lot::Mutex<Vec<String>>>,
    /// When set to true, scanner should stop as soon as possible
    pub cancelled: Option<std::sync::Arc<AtomicBool>>,
    /// Ring buffer of recently discovered entries, for live scanning views.
    pub live_entries: std::sync::Arc<parking_lot::Mutex<std::collections::VecDeque<String>>>,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            root_path: String::new(),
            // Matched as bare path components so a whole-drive scan of `C:\`
            // actually skips `C:\Windows` (previously the full-path entries
            // could never match a single segment). Entries containing a path
            // separator are instead matched as a path prefix.
            skip_dirs: vec![
                #[cfg(windows)]
                "Windows".into(),
                #[cfg(target_os = "macos")]
                "System".into(),
                #[cfg(target_os = "macos")]
                "Library".into(),
                "target".into(),
                ".git".into(),
            ],
            top_file_min_size: 0,
            top_files_count: 100,
            follow_symlinks: false,
            scan_timeout_secs: super::activity::DEFAULT_TIMEOUT_SECS,
            activity: Arc::new(super::activity::ScanActivity::default()),
            errors: std::sync::Arc::new(parking_lot::Mutex::new(Vec::new())),
            cancelled: None,
            live_entries: std::sync::Arc::new(parking_lot::Mutex::new(std::collections::VecDeque::new())),
        }
    }
}

/// True if `path` should be pruned from a scan. A skip entry is either:
/// - a bare component name (`"Windows"`, `"target"`) matched against any path
///   segment (avoids partial matches like `"bin"` matching `"binary_folder"`),
/// - or a path that contains a separator (`"C:\\Games\\Old"`), matched as a
///   prefix of the walked path with a component boundary.
pub(crate) fn path_is_skipped(path: &str, skip_dirs: &[String]) -> bool {
    skip_dirs.iter().any(|sd| {
        if sd.is_empty() {
            return false;
        }
        if sd.contains('/') || sd.contains('\\') {
            if let Some(rest) = path.strip_prefix(sd.as_str()) {
                return rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\');
            }
            false
        } else {
            path.split(['/', '\\']).any(|c| c == sd.as_str())
        }
    })
}

const LIVE_CAP: usize = 1000;

/// Record a discovered entry into the live ring buffer (capped). Callers
/// throttle to every Nth entry so huge scans don't allocate one String per
/// file just for the live preview.
fn push_live(live: &std::sync::Arc<parking_lot::Mutex<std::collections::VecDeque<String>>>, name: &str) {
    let mut q = live.lock();
    if q.len() >= LIVE_CAP {
        q.pop_front();
    }
    q.push_back(name.to_string());
}

/// Lowercase extension key for the file-type breakdown, avoiding the Unicode
/// `to_lowercase` path when the extension is already lowercase ASCII (the
/// overwhelmingly common case).
pub(crate) fn file_ext_lower(path: &str) -> String {
    let p = Path::new(path);
    let mut parts = Vec::new();
    let ext = match p.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_string(),
        None => return "(none)".into(),
    };
    parts.push(ext);
    // Walk up through multi-part extensions (e.g. "tar.gz").
    let mut stem = p.file_stem();
    while let Some(s) = stem {
        if let Some(next_ext) = Path::new(s).extension().and_then(|e| e.to_str()) {
            parts.push(next_ext.to_string());
            stem = Path::new(s).file_stem();
        } else {
            break;
        }
    }
    parts.reverse();
    let joined = parts.join(".");
    if joined.bytes().any(|b| b.is_ascii_uppercase()) {
        joined.to_lowercase()
    } else {
        joined
    }
}

pub(crate) struct TopFilesAccum {
    files: Mutex<Vec<TopFileEntry>>,
    min_size: AtomicU64,
}
impl Default for TopFilesAccum {
    fn default() -> Self {
        Self {
            files: Mutex::new(Vec::new()),
            min_size: AtomicU64::new(0),
        }
    }
}
impl TopFilesAccum {
    pub(crate) fn insert(&self, path: &str, size: u64, max_count: usize) {
        // Fast reject without taking the files lock: once the list is full,
        // anything at or below the current minimum can never enter.
        if size <= self.min_size.load(Ordering::Relaxed) {
            let files = self.files.lock();
            if files.len() >= max_count {
                return;
            }
        }
        let mut files = self.files.lock();
        let min_size = self.min_size.load(Ordering::Relaxed);
        if size <= min_size && files.len() >= max_count {
            return;
        }
        let idx = files
            .binary_search_by(|f| f.size.cmp(&size).reverse())
            .unwrap_or_else(|e| e);
        files.insert(idx, TopFileEntry {
            // Only materialize the owned path string once the entry is actually
            // kept — callers pass a borrowed path to avoid allocating a String
            // for every scanned file that never makes the top-N.
            path: path.to_string(),
            size,
            size_human: format_size(size),
        });
        if files.len() > max_count {
            files.truncate(max_count);
        }
        self.min_size.store(files.last().map(|f| f.size).unwrap_or(0), Ordering::Relaxed);
    }
    fn into_inner(self) -> Vec<TopFileEntry> {
        self.files.into_inner()
    }
}

pub(crate) struct FileTypeAccum {
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
    pub(crate) fn add(&self, path: &str, size: u64) {
        let ext = file_ext_lower(path);
        let mut map = self.map.lock();
        let entry = map.entry(ext).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += size;
    }
    /// Merge a worker-local map into this accumulator (parallel walkers avoid
    /// taking the global lock once per file; they merge once per worker).
    /// Only the platform-specific fast walkers use this, so it is gated to
    /// those targets to avoid dead-code errors on other platforms.
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    pub(crate) fn merge(&self, other: HashMap<String, (u64, u64)>) {
        if other.is_empty() {
            return;
        }
        let mut map = self.map.lock();
        for (ext, (c, s)) in other {
            let e = map.entry(ext).or_insert((0, 0));
            e.0 += c;
            e.1 += s;
        }
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
    fn sorted_clone(&self) -> Vec<FileTypeCount> {
        let map = self.map.lock().clone();
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

/// Why a scan run ended. The UI must not treat partial results as complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanTermination {
    Completed,
    Cancelled,
    TimedOut,
    LimitReached,
}

#[must_use]
pub struct ScanResult {
    pub arena: TreeNodeArena,
    pub stats: ScanStats,
    pub termination: ScanTermination,
}

// â”€â”€ Shared tree-building helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Both the parallel (jwalk) and fallback (walkdir) walkers build the arena
// with identical logic; these helpers keep the two loops from drifting apart.

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

fn child_depth(arena: &TreeNodeArena, parent: u32, root_idx: u32) -> u16 {
    if parent == root_idx {
        1
    } else {
        arena.nodes[parent as usize].depth + 1
    }
}

fn alloc_directory(
    arena: &mut TreeNodeArena,
    name: String,
    parent: u32,
    depth: u16,
) -> u32 {
    let idx = arena.alloc(TreeNode {
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
    });
    idx
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

/// Link `child` as the next sibling of the parent's last child.
fn link_child(arena: &mut TreeNodeArena, lc: &mut HashMap<u32, u32>, parent: u32, child: u32) {
    match lc.get(&parent) {
        Some(&last) => arena.nodes[last as usize].next_sibling = child,
        None => arena.nodes[parent as usize].first_child = child,
    }
    lc.insert(parent, child);
}


// â”€â”€â”€ macOS scanner (jwalk parallel traversal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        let live_entries = config.live_entries.clone();
        let top_count = config.top_files_count;
        let mut arena = TreeNodeArena::with_estimated_capacity(root_path);
        let root_idx = alloc_root(&mut arena, root_path);
        let mut ptix: HashMap<String, u32> = HashMap::new();
        ptix.insert(root_path.into(), root_idx);
        let mut lc: HashMap<u32, u32> = HashMap::new();
        let mut last_progress = Instant::now();
        let cancel = config.cancelled.clone();
        let mut files_found: u64 = 0;
        let mut dirs_found: u64 = 0;
        let mut bytes_found: u64 = 0;
        let mut iter_count = 0u64;
        let mut path_buf = String::with_capacity(4096);
        // Dynamic node cap: scale with available RAM (~128 bytes/node est.),
        // bounded between 500k and 20M. On low-memory machines we stop earlier
        // instead of risking OOM; on big machines we still cap runaway scans.
        let node_cap = {
            let avail = available_memory_bytes();
            (avail / 128).clamp(500_000, 20_000_000) as usize
        };
        let mut termination = ScanTermination::Completed;

        // jwalk 0.9 collects a whole directory before its process_read_dir hook
        // or next() yields. It exposes no entry-level heartbeat/cancellation
        // hook, so Linux/fallback scans can still time out on a slow, moving
        // batch. Fixing that requires changing traversal or the dependency;
        // a timer heartbeat would instead conceal genuinely blocked I/O.
        let mut entries = WalkDir::new(root_path).follow_links(config.follow_symlinks).sort(false).parallelism(jwalk::Parallelism::RayonNewPool(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(1, 8))).into_iter();
        loop {
            if cancel.as_ref().is_some_and(|cf| cf.load(Ordering::Relaxed)) {
                termination = ScanTermination::Cancelled;
                break;
            }
            if let Some(message) = config.activity.timeout_message(config.scan_timeout_secs, root_path) {
                record_error(&config.errors, message);
                termination = ScanTermination::TimedOut;
                break;
            }
            let operation = config.activity.operation(root_path, "jwalk next (scan root; internal active directory unknown)");
            let Some(entry_result) = entries.next() else { break; };
            config.activity.progress();
            drop(operation);
            if arena.nodes.len() > node_cap {
                termination = ScanTermination::LimitReached;
                break;
            }
            iter_count += 1;
            let entry = match entry_result {
                Ok(e) => e,
                Err(e) => {
                    record_error(&config.errors, format!("jwalk: {}", e));
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
            if iter_count.is_multiple_of(100) {
                push_live(&live_entries, &file_name);
            }

            let is_dir = entry.file_type().is_dir();
            let parent = os_path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| root_path.into());
            let pi = *ptix.get(&parent).unwrap_or(&root_idx);

            if is_dir {
                dirs_found += 1;
                if path_is_skipped(&path_buf, &skip_dirs) {
                    continue;
                }
                let depth = child_depth(&arena, pi, root_idx);
                let ci = alloc_directory(&mut arena, file_name.into_owned(), pi, depth);
                link_child(&mut arena, &mut lc, pi, ci);
                ptix.insert(path_buf.clone(), ci);
            } else {
                files_found += 1;
                let _operation = config.activity.operation(&path_buf, "metadata");
                let meta = entry.metadata();
                config.activity.progress();
                if let Err(ref e) = meta { record_error(&config.errors, format!("metadata: {:?}: {}", path_buf, e)); }
                let sz = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                bytes_found += sz;
                let depth = child_depth(&arena, pi, root_idx);
                let mtime = meta.as_ref()
                    .map(|m| m.modified().map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs()).unwrap_or(0))
                    .unwrap_or(0);
                let fname = file_name.into_owned();
                if sz > 0 {
                    top_files.insert(&path_buf, sz, top_count);
                    file_types.add(&fname, sz);
                }
                let ci = alloc_file(&mut arena, fname, sz, pi, depth, mtime);
                link_child(&mut arena, &mut lc, pi, ci);
            }
            if last_progress.elapsed().as_millis() >= 100 {
                progress(files_found, dirs_found, bytes_found, &path_buf);
                last_progress = Instant::now();
            }
        }
        progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
        finish_scan(start, arena, top_files, file_types, progress, termination, &config.activity)
    }
}

pub(crate) fn finish_scan(
    start: Instant,
    mut arena: TreeNodeArena,
    top_files: Arc<TopFilesAccum>,
    file_types: Arc<FileTypeAccum>,
    _progress: &ScanProgressCallback,
    termination: ScanTermination,
    activity: &Arc<ScanActivity>,
) -> Result<ScanResult> {
    let _operation = activity.operation("", "Finalizing tree (no native I/O)");
    let n = arena.nodes.len();
    let mut total_files: u64 = 0;
    let mut total_dirs: u64 = 1; // root is a directory
    for i in (1..n).rev() {
        if i.is_multiple_of(1024) { activity.progress(); }
        let node = &arena.nodes[i];
        let p = node.parent;
        let s = node.size;
        let fc = node.file_count;
        let dc = node.dir_count;
        if node.is_file() {
            total_files += 1;
        } else {
            total_dirs += 1;
        }
        if p != u32::MAX {
            let parent = &mut arena.nodes[p as usize];
            parent.size += s;
            parent.file_count += fc;
            parent.dir_count += dc;
        }
    }
    let elapsed = start.elapsed().as_millis() as u64;
    let total_size = arena.nodes[0].size;
    let stats = ScanStats {
        total_files,
        total_dirs,
        total_size,
        scan_time_ms: elapsed,
        top_files: match Arc::try_unwrap(top_files) {
            Ok(t) => t.into_inner(),
            Err(arc) => {
                warn!("top_files Arc still referenced; cloning");
                arc.files.lock().clone()
            }
        },
        file_type_breakdown: match Arc::try_unwrap(file_types) {
            Ok(t) => t.into_sorted(),
            Err(arc) => {
                warn!("file_types Arc still referenced; cloning");
                arc.sorted_clone()
            }
        },
    };
    Ok(ScanResult { arena, stats, termination })
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
    let root_idx = alloc_root(&mut arena, root_path);
    let mut ptix: HashMap<String, u32> = HashMap::new();
    ptix.insert(root_path.into(), root_idx);
    let mut lc: HashMap<u32, u32> = HashMap::new();
    let mut files_found: u64 = 0;
    let mut dirs_found: u64 = 0;
    let mut bytes_found: u64 = 0;
    let mut last_progress = Instant::now();
    let mut iter_count: u64 = 0;
    // Cap the fallback scanner (used for $Recycle.Bin etc.): a recycle bin can
    // hold millions of deleted files; a tree that big is useless and heavy.
    let node_cap = {
        let avail = available_memory_bytes();
        (avail / 512).clamp(250_000, 1_000_000) as usize
    };
    // Iteration cap: access-denied entries don't add nodes, so a recycle bin
    // with millions of unreadable files could otherwise never reach node_cap
    // and the scan would never end. Bound total work by entries processed too.
    let iter_cap: u64 = 1_500_000;
    let mut termination = ScanTermination::Completed;

    let mut entries = WalkDir::new(root_path).follow_links(false).into_iter();
    let mut current_directory = root_path.to_owned();
    loop {
        if config.cancelled.as_ref().is_some_and(|cf| cf.load(Ordering::Relaxed)) {
            termination = ScanTermination::Cancelled;
            break;
        }
        if let Some(message) = config.activity.timeout_message(config.scan_timeout_secs, root_path) {
            record_error(&config.errors, message);
            termination = ScanTermination::TimedOut;
            break;
        }
        let operation = config.activity.operation(&current_directory, "walkdir next (last yielded directory; internal active directory unknown)");
        let Some(entry_result) = entries.next() else { break; };
        config.activity.progress();
        drop(operation);
        if arena.nodes.len() > node_cap {
            termination = ScanTermination::LimitReached;
            break;
        }
        iter_count += 1;
        if iter_count > iter_cap {
            termination = ScanTermination::LimitReached;
            break;
        }
        let entry = match entry_result {
            Ok(e) => e,
            Err(e) => {
                record_error(&config.errors, format!("walkdir: {}", e));
                continue;
            }
        };
        let full = entry.path().to_string_lossy().to_string();
        if entry.file_type().is_dir() { current_directory = full.clone(); }
        if full == root_path {
            continue;
        }
        if iter_count.is_multiple_of(100) {
            push_live(&config.live_entries, entry.file_name().to_string_lossy().as_ref());
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
            if path_is_skipped(&full, &skip_dirs) {
                continue;
            }
            let depth = child_depth(&arena, pi, root_idx);
            let ci = alloc_directory(&mut arena, file_name, pi, depth);
            link_child(&mut arena, &mut lc, pi, ci);
            ptix.insert(full.clone(), ci);
        } else {
            files_found += 1;
            let _operation = config.activity.operation(&full, "metadata");
            let meta = entry.metadata();
            config.activity.progress();
            if let Err(ref e) = meta { record_error(&config.errors, format!("metadata: {:?}: {}", full, e)); }
            let sz = meta.map(|m| m.len()).unwrap_or(0);
            bytes_found += sz;
            let depth = child_depth(&arena, pi, root_idx);
            if sz > 0 {
                top_files.insert(&full, sz, top_count);
                file_types.add(&file_name, sz);
            }
            let ci = alloc_file(&mut arena, file_name, sz, pi, depth, 0);
            link_child(&mut arena, &mut lc, pi, ci);
        }
        if last_progress.elapsed().as_millis() >= 100 {
            progress(files_found, dirs_found, bytes_found, &full);
            last_progress = Instant::now();
        }
    }
    progress(files_found, dirs_found, bytes_found, "Finalizing tree...");
    finish_scan(start, arena, top_files, file_types, progress, termination, &config.activity)
}

fn log_panic(context: &str, panic: Box<dyn std::any::Any + Send>) {
    let msg = panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown".to_string());
    error!(context, panic = %msg, "Scanner panic, falling back");
}

pub fn scan_directory_with_progress(
    config: ScanConfig,
    progress: ScanProgressCallback,
) -> Result<ScanResult> {
    let root_path = config.root_path.clone();
    config.activity.progress();
    #[cfg(target_os = "windows")]
    if root_path.contains("$Recycle.Bin") {
        return empty_scan_result(&root_path);
    }

    #[cfg(target_os = "windows")]
    {
        let progress_arc: Arc<ScanProgressCallback> = Arc::new(progress);
        let fast = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::scanner::ntfs_fast::scan(&config, progress_arc.clone(), &root_path)
        }));
        match fast {
            Ok(Ok(scan_result)) => return Ok(scan_result),
            Ok(Err(e)) => {
                warn!(error = %e, "ntfs_fast scan error, falling back to jwalk");
            }
            Err(panic) => log_panic("ntfs_fast scanner", panic),
        }
        try_fallback_jwalk_walkdir(&config, progress_arc.as_ref(), &root_path, "Win32")
    }
    #[cfg(target_os = "macos")]
    {
        let progress_arc: Arc<ScanProgressCallback> = Arc::new(progress);
        let fast = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::scanner::macos_fast::scan(&config, progress_arc.clone(), &root_path)
        }));
        match fast {
            Ok(Ok(scan_result)) => return Ok(scan_result),
            Ok(Err(e)) => {
                warn!(error = %e, "macos_fast scan error, falling back to jwalk");
            }
            Err(panic) => log_panic("macos_fast scanner", panic),
        }
        try_fallback_jwalk_walkdir(&config, progress_arc.as_ref(), &root_path, "macOS")
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        try_fallback_jwalk_walkdir(&config, &progress, &root_path, "jwalk")
    }
}

fn try_fallback_jwalk_walkdir(
    config: &ScanConfig,
    progress: &ScanProgressCallback,
    root_path: &str,
    context: &str,
) -> Result<ScanResult> {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        platform::scan(config, progress, root_path)
    }));
    match result {
        Ok(Ok(scan_result)) => Ok(scan_result),
        Ok(Err(e)) => {
            warn!(context, error = %e, "jwalk scan error, falling back to walkdir");
            scan_simple(config, progress, root_path)
        }
        Err(panic) => {
            log_panic(&format!("{} jwalk scanner", context), panic);
            scan_simple(config, progress, root_path)
        }
    }
}

/// Build a ScanResult containing only the root node (no files) â€” used for
/// paths that can't be meaningfully walked (e.g. the Windows recycle bin).
#[cfg(target_os = "windows")]
fn empty_scan_result(root_path: &str) -> Result<ScanResult> {
    let mut arena = TreeNodeArena::with_estimated_capacity(root_path);
    let root_name = std::path::Path::new(root_path)
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
    });
    Ok(ScanResult {
        arena,
        stats: ScanStats {
            total_files: 0,
            total_dirs: 0,
            total_size: 0,
            scan_time_ms: 0,
            top_files: Vec::new(),
            file_type_breakdown: Vec::new(),
        },
        termination: ScanTermination::Completed,
    })
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
        accum.insert("a", 100, 5);
        accum.insert("b", 200, 5);
        let result = accum.into_inner();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].size, 200);
    }

    #[test]
    fn test_top_files_truncates() {
        let accum = TopFilesAccum::default();
        accum.insert("a", 100, 3);
        accum.insert("b", 200, 3);
        accum.insert("c", 50, 3);
        accum.insert("d", 150, 3);
        let result = accum.into_inner();
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].size, 200);
        assert_eq!(result[1].size, 150);
        assert_eq!(result[2].size, 100);
    }

    #[test]
    fn test_top_files_skips_small() {
        let accum = TopFilesAccum::default();
        accum.insert("a", 200, 2);
        accum.insert("b", 100, 2);
        accum.insert("c", 50, 2);
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

    #[test]
    fn test_scan_empty_dir_completes() {
        let dir = std::env::temp_dir().join("diskraptor_walker_empty");
        let _ = std::fs::create_dir_all(&dir);
        let cfg = super::ScanConfig {
            root_path: dir.to_string_lossy().to_string(),
            ..Default::default()
        };
        let cb: super::ScanProgressCallback = Box::new(|_, _, _, _| {});
        let r = super::scan_directory_with_progress(cfg, cb);
        assert!(
            r.is_ok(),
            "empty dir scan should return Ok, got error: {:?}",
            r.as_ref().err()
        );
        let sr = r.unwrap();
        eprintln!(
            "nodes={} files={} dirs={}",
            sr.arena.nodes.len(),
            sr.stats.total_files,
            sr.stats.total_dirs
        );
        assert!(sr.stats.total_files == 0 && sr.stats.total_dirs == 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_scan_nonexistent_path_completes() {
        let missing = std::env::temp_dir()
            .join("diskraptor_walker_missing_7f9a3")
            .to_string_lossy()
            .to_string();
        let cfg = super::ScanConfig {
            root_path: missing,
            ..Default::default()
        };
        let cb: super::ScanProgressCallback = Box::new(|_, _, _, _| {});
        let start = std::time::Instant::now();
        let r = super::scan_directory_with_progress(cfg, cb);
        eprintln!(
            "nonexistent path: Ok={} err={:?} elapsed_ms={}",
            r.is_ok(),
            r.as_ref().err(),
            start.elapsed().as_millis()
        );
        assert!(start.elapsed().as_secs() < 5, "scan hung on nonexistent path");
    }

    /// Canonicalize an arena into a sortable, comparable form so parallel scans
    /// with different node orders can be compared directly.
    #[cfg(target_os = "macos")]
    fn canonical(arena: &crate::scanner::tree::TreeNodeArena) -> Vec<(String, u8, u64, u64, u64, u64)> {
        let mut paths: Vec<String> = vec![String::new(); arena.nodes.len()];
        for i in 1..arena.nodes.len() {
            let n = &arena.nodes[i];
            if n.parent != u32::MAX {
                paths[i] = format!("{}/{}", paths[n.parent as usize], n.name);
            }
        }
        let mut out: Vec<(String, u8, u64, u64, u64, u64)> = arena
            .nodes
            .iter()
            .enumerate()
            .map(|(i, n)| {
                (
                    paths[i].clone(),
                    n.node_type as u8,
                    n.size,
                    n.file_count,
                    n.dir_count,
                    n.mtime,
                )
            })
            .collect();
        out.sort();
        out
    }

    /// The macOS fast scanner (getattrlistbulk) must produce a byte-identical
    /// tree structure to the jwalk walker, including symlink handling.
    #[cfg(target_os = "macos")]
    #[test]
    fn test_macos_fast_matches_jwalk() {
        let dir = std::env::temp_dir().join(format!("diskraptor_fast_cmp_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(dir.join("a/b/c")).unwrap();
        std::fs::create_dir_all(dir.join("empty")).unwrap();
        std::fs::write(dir.join("root.txt"), vec![1u8; 100]).unwrap();
        std::fs::write(dir.join("a/a.txt"), vec![1u8; 200]).unwrap();
        std::fs::write(dir.join("a/b/b.bin"), vec![1u8; 300]).unwrap();
        std::fs::write(dir.join("a/b/c/c.md"), vec![1u8; 400]).unwrap();
        std::os::unix::fs::symlink(dir.join("a"), dir.join("link_to_dir")).unwrap();
        std::os::unix::fs::symlink(dir.join("root.txt"), dir.join("link_to_file")).unwrap();

        let root = dir.to_string_lossy().to_string();
        let cb: super::ScanProgressCallback = Box::new(|_, _, _, _| {});

        let fast_cfg = super::ScanConfig {
            root_path: root.clone(),
            ..Default::default()
        };
        let fast = super::scan_directory_with_progress(fast_cfg, Box::new(|_, _, _, _| {}))
            .expect("fast scan ok");
        let jwalk_cfg = super::ScanConfig {
            root_path: root.clone(),
            ..Default::default()
        };
        let jwalk = crate::scanner::walker::platform::scan(&jwalk_cfg, &cb, &root)
            .expect("jwalk scan ok");

        let fast_nodes = canonical(&fast.arena);
        let jwalk_nodes = canonical(&jwalk.arena);
        assert_eq!(
            fast_nodes, jwalk_nodes,
            "macOS fast scanner tree differs from jwalk\nfast={fast_nodes:?}\njwalk={jwalk_nodes:?}"
        );
        assert_eq!(fast.stats.total_size, jwalk.stats.total_size);
        assert_eq!(fast.stats.total_files, jwalk.stats.total_files);
        assert_eq!(fast.stats.total_dirs, jwalk.stats.total_dirs);
        assert_eq!(fast.termination, super::ScanTermination::Completed);

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── New: path skip logic ────────────────────────────────────

    #[test]
    fn test_path_is_skipped_bare_component() {
        assert!(path_is_skipped("/home/user/Windows/system32", &["Windows".into()]));
        assert!(path_is_skipped("C:\\Users\\user\\target\\debug", &["target".into()]));
        assert!(!path_is_skipped("/home/user/myproject", &["target".into()]));
    }

    #[test]
    fn test_path_is_skipped_full_path_prefix() {
        assert!(path_is_skipped("C:\\Users\\user\\Projects", &["C:\\Users\\user\\Projects".into()]));
        assert!(path_is_skipped("C:\\Users\\user\\Projects\\sub", &["C:\\Users\\user\\Projects".into()]));
    }

    #[test]
    fn test_path_is_skipped_partial_name_ignored() {
        // "bin" should NOT match "binary_folder" or "/usr/bin"
        assert!(!path_is_skipped("/home/user/binary_folder", &["bin".into()]));
    }

    #[test]
    fn test_path_is_skipped_empty_list() {
        assert!(!path_is_skipped("/anything/here", &[]));
    }

    #[test]
    fn test_path_is_skipped_git_dir() {
        assert!(path_is_skipped("/repo/src/.git/objects", &[".git".into()]));
        assert!(path_is_skipped("C:\\repo\\.git\\config", &[".git".into()]));
    }

    // ── New: file extension lowercasing ─────────────────────────

    #[test]
    fn test_file_ext_lower_ascii() {
        assert_eq!(file_ext_lower("photo.JPG"), "jpg");
        assert_eq!(file_ext_lower("archive.TAR.GZ"), "tar.gz");
        assert_eq!(file_ext_lower("README"), "(none)");
        assert_eq!(file_ext_lower("style.CSS"), "css");
    }

    #[test]
    fn test_file_ext_lower_already_lower() {
        // Fast path: already-lowercase ASCII returns without allocating
        let result = file_ext_lower("photo.jpg");
        assert_eq!(result, "jpg");
    }

    #[test]
    fn test_file_ext_lower_unicode() {
        let result = file_ext_lower("foto.JPG");
        assert!(result == "jpg");
    }

    // ── New: tree node allocation helpers ───────────────────────

    #[test]
    fn test_alloc_root() {
        use super::super::tree::TreeNodeArena;
        let mut arena = TreeNodeArena::new();
        let idx = super::alloc_root(&mut arena, "/home/user");
        assert_eq!(idx, 0);
        assert_eq!(arena.nodes.len(), 1);
        assert_eq!(arena.nodes[0].name, "user");
        assert!(arena.nodes[0].is_directory());
        assert_eq!(arena.nodes[0].depth, 0);
    }

    #[test]
    fn test_alloc_directory() {
        use super::super::tree::{NodeType, TreeNodeArena};
        let mut arena = TreeNodeArena::new();
        let root = arena.alloc(super::super::tree::TreeNode {
            name: "root".into(), size: 0, file_count: 0, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0, mtime: 0,
        });
        let child = super::alloc_directory(&mut arena, "src".into(), root, 1);
        assert_eq!(child, 1);
        assert!(arena.nodes[child as usize].is_directory());
        assert_eq!(arena.nodes[child as usize].depth, 1);
        assert_eq!(arena.nodes[root as usize].first_child, u32::MAX);
        super::link_child(&mut arena, &mut std::collections::HashMap::new(), root, child);
        assert_eq!(arena.nodes[root as usize].first_child, child);
    }

    #[test]
    fn test_alloc_file() {
        use super::super::tree::{NodeType, TreeNodeArena};
        let mut arena = TreeNodeArena::new();
        let root = arena.alloc(super::super::tree::TreeNode {
            name: "root".into(), size: 0, file_count: 0, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0, mtime: 0,
        });
        let file = super::alloc_file(&mut arena, "main.rs".into(), 4096, root, 1, 1_700_000_000);
        assert_eq!(file, 1);
        assert!(arena.nodes[file as usize].is_file());
        assert_eq!(arena.nodes[file as usize].size, 4096);
        assert_eq!(arena.nodes[file as usize].file_count, 1);
    }

    #[test]
    fn test_link_child() {
        use super::super::tree::{NodeType, TreeNodeArena};
        let mut arena = TreeNodeArena::new();
        let root = arena.alloc(super::super::tree::TreeNode {
            name: "root".into(), size: 0, file_count: 0, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0, mtime: 0,
        });
        let d1 = super::alloc_directory(&mut arena, "a".into(), root, 1);
        let d2 = super::alloc_directory(&mut arena, "b".into(), root, 1);
        super::link_child(&mut arena, &mut std::collections::HashMap::new(), root, d1);
        // link_child with empty map sets first_child; second call updates sibling
        let mut lc = std::collections::HashMap::new();
        lc.insert(root, d1);
        super::link_child(&mut arena, &mut lc, root, d2);
        assert_eq!(arena.nodes[root as usize].first_child, d1);
        assert_eq!(arena.nodes[d1 as usize].next_sibling, d2);
    }

    // ── New: ScanTermination serialization ──────────────────────

    #[test]
    fn test_scan_termination_serde() {
        use super::super::walker::ScanTermination;
        let completed = serde_json::to_string(&ScanTermination::Completed).unwrap();
        assert_eq!(completed, "\"completed\"");
        let cancelled = serde_json::to_string(&ScanTermination::Cancelled).unwrap();
        assert_eq!(cancelled, "\"cancelled\"");
        let timed_out = serde_json::to_string(&ScanTermination::TimedOut).unwrap();
        assert_eq!(timed_out, "\"timed_out\"");
        let limit = serde_json::to_string(&ScanTermination::LimitReached).unwrap();
        assert_eq!(limit, "\"limit_reached\"");
    }

    // ── New: finish_scan counts ─────────────────────────────────

    #[test]
    fn test_finish_scan_counts() {
        use super::super::tree::{NodeType, TreeNodeArena};
        let mut arena = TreeNodeArena::with_capacity(8);
        let root = arena.alloc(super::super::tree::TreeNode {
            name: "root".into(), size: 300, file_count: 2, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0, chunk_id: 0, mtime: 0,
        });
        arena.alloc(super::super::tree::TreeNode {
            name: "a.txt".into(), size: 100, file_count: 1, dir_count: 0,
            node_type: NodeType::File, parent: root,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 1, chunk_id: 0, mtime: 0,
        });
        arena.alloc(super::super::tree::TreeNode {
            name: "b.txt".into(), size: 200, file_count: 1, dir_count: 0,
            node_type: NodeType::File, parent: root,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 1, chunk_id: 0, mtime: 0,
        });
        let top = std::sync::Arc::new(TopFilesAccum::default());
        let ft = std::sync::Arc::new(FileTypeAccum::default());
        let activity = std::sync::Arc::new(super::super::activity::ScanActivity::default());
         let progress: ScanProgressCallback = Box::new(|_, _, _, _| {});
         let result = super::finish_scan(
             std::time::Instant::now(), arena, top, ft,
             &progress, ScanTermination::Completed, &activity,
         ).unwrap();
        assert_eq!(result.stats.total_files, 2);
        assert_eq!(result.stats.total_dirs, 1);
        assert_eq!(result.stats.total_size, 600);
    }
}
