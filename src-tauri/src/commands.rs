use crate::scanner::tree::*;
use crate::scanner::walker::{self, ScanConfig, ScanProgressCallback};
use crate::streaming::chunker::{self, ScanRootInfo};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

/// Holds state for an active scan.
pub struct ScanState {
    pub arena: TreeNodeArena,
    pub stats: ScanStats,
    pub chunks: Vec<TreeChunk>,
}

/// Live progress of a running scan.
pub struct ScanProgress {
    pub files_found: AtomicU64,
    pub dirs_found: AtomicU64,
    pub is_running: AtomicU64,
    pub phase: AtomicU64,
    pub current_dir: Mutex<String>,
    pub start_time: AtomicU64, // unix millis
    pub error: Mutex<Option<String>>,
}

impl ScanProgress {
    pub fn new() -> Arc<Self> {
        use std::time::{SystemTime, UNIX_EPOCH};
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        Arc::new(Self {
            files_found: AtomicU64::new(0),
            dirs_found: AtomicU64::new(0),
            is_running: AtomicU64::new(1),
            phase: AtomicU64::new(0),
            current_dir: Mutex::new(String::new()),
            start_time: AtomicU64::new(now),
            error: Mutex::new(None),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressPayload {
    pub scan_id: String,
    pub files_found: u64,
    pub dirs_found: u64,
    pub is_running: bool,
    pub phase: u64,
    pub current_dir: String,
    pub elapsed_secs: u64,
    pub error: Option<String>,
}

// Global state
static SCANS: OnceLock<Mutex<HashMap<String, Arc<ScanState>>>> = OnceLock::new();
static SCAN_PROGRESS: OnceLock<Mutex<HashMap<String, Arc<ScanProgress>>>> = OnceLock::new();

fn scans() -> &'static Mutex<HashMap<String, Arc<ScanState>>> {
    SCANS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn scan_progress() -> &'static Mutex<HashMap<String, Arc<ScanProgress>>> {
    SCAN_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ── Commands ─────────────────────────────────────────────────────────────

/// Start a scan in the background. Returns immediately with a scan ID.
/// Poll `get_scan_progress` and `get_scan_result` to track completion.
#[tauri::command]
pub fn start_scan(path: String) -> Result<ScanResponse, String> {
    let progress = ScanProgress::new();
    let scan_id = format!("scan_{}", chrono_id());
    scan_progress()
        .lock()
        .insert(scan_id.clone(), progress.clone());

    let path_c = path.clone();
    let scan_id_c = scan_id.clone();
    let prog = progress.clone();

    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        let config = ScanConfig {
            root_path: path_c.clone(),
            ..Default::default()
        };
        let prog_cb = prog.clone();
        let progress_cb: ScanProgressCallback = Box::new(move |files, dirs, current_dir| {
            prog_cb.files_found.store(files, Ordering::Relaxed);
            prog_cb.dirs_found.store(dirs, Ordering::Relaxed);
            if !current_dir.is_empty() {
                *prog_cb.current_dir.lock() = current_dir.to_string();
            }
        });

        // Phase 1: Scanning
        let scan_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            walker::scan_directory_with_progress(config, progress_cb)
        }))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("Scan panicked")));
        match scan_result {
            Ok(result) => {
                // Phase 2: Building tree
                prog.phase.store(1, Ordering::Relaxed);

                match chunker::chunk_tree(&result.arena) {
                    Ok(chunks) => {
                        // Phase 3: Chunking done, storing result
                        prog.phase.store(2, Ordering::Relaxed);
                        let scan_state = Arc::new(ScanState {
                            arena: result.arena,
                            stats: result.stats,
                            chunks,
                        });
                        scans().lock().insert(scan_id_c.clone(), scan_state);
                        prog.is_running.store(0, Ordering::Relaxed);
                        prog.phase.store(3, Ordering::Relaxed);
                        log::info!("Scan {} completed in {:?}", scan_id_c, start.elapsed());
                    }
                    Err(e) => {
                        prog.is_running.store(0, Ordering::Relaxed);
                        *prog.error.lock() = Some(format!("Chunking failed: {}", e));
                        log::error!("Chunking failed for {}: {}", scan_id_c, e);
                    }
                }
            }
            Err(e) => {
                prog.is_running.store(0, Ordering::Relaxed);
                *prog.error.lock() = Some(format!("Scan failed: {}", e));
                log::error!("Scan {} failed: {}", scan_id_c, e);
            }
        }
    });

    // Return immediately with scan ID and no stats yet
    Ok(ScanResponse {
        scan_id,
        root_info: chunker::ScanRootInfo {
            root_index: 0,
            total_nodes: 0,
            total_chunks: 0,
        },
        stats: ScanStats {
            total_files: 0,
            total_dirs: 0,
            total_size: 0,
            scan_time_ms: 0,
            top_files: vec![],
            file_type_breakdown: vec![],
        },
    })
}

/// Check if a scan has finished and return its result.
#[tauri::command]
pub fn get_scan_result(scan_id: String) -> Result<Option<ScanResponse>, String> {
    let scans_lock = scans().lock();
    if let Some(state) = scans_lock.get(&scan_id) {
        let root_info = chunker::get_root_info(&state.arena);
        let stats = state.stats.clone();
        Ok(Some(ScanResponse {
            scan_id,
            root_info,
            stats,
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn get_scan_progress(scan_id: String) -> Result<ProgressPayload, String> {
    let p = scan_progress().lock();
    let prog = p.get(&scan_id).ok_or_else(|| "No such scan".to_string())?;
    let error = prog.error.lock().clone();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let elapsed = (now - prog.start_time.load(Ordering::Relaxed)) / 1000;
    let dir = prog.current_dir.lock().clone();
    Ok(ProgressPayload {
        scan_id: scan_id.clone(),
        files_found: prog.files_found.load(Ordering::Relaxed),
        dirs_found: prog.dirs_found.load(Ordering::Relaxed),
        is_running: prog.is_running.load(Ordering::Relaxed) == 1,
        phase: prog.phase.load(Ordering::Relaxed),
        current_dir: dir,
        elapsed_secs: elapsed,
        error,
    })
}

#[tauri::command]
pub fn get_chunk(scan_id: String, chunk_index: u32) -> Result<TreeChunk, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    let chunk = state
        .chunks
        .get(chunk_index as usize)
        .ok_or_else(|| {
            format!(
                "Chunk {} out of range (total: {})",
                chunk_index,
                state.chunks.len()
            )
        })?
        .clone();
    Ok(chunk)
}

#[tauri::command]
pub fn get_stats(scan_id: String) -> Result<ScanStats, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    Ok(state.stats.clone())
}

#[tauri::command]
pub fn get_children(scan_id: String, node_index: u32) -> Result<Vec<TreeNode>, String> {
    let scans = scans().lock();
    let state = scans
        .get(&scan_id)
        .ok_or_else(|| format!("Scan '{}' not found", scan_id))?;
    let node = state
        .arena
        .nodes
        .get(node_index as usize)
        .ok_or_else(|| format!("Node {} not found", node_index))?;

    let mut children = Vec::new();
    let mut child = node.first_child;
    while child != u32::MAX {
        children.push(state.arena.nodes[child as usize].clone());
        child = state.arena.nodes[child as usize].next_sibling;
    }
    children.sort_unstable_by_key(|b| std::cmp::Reverse(b.size));
    Ok(children)
}

#[tauri::command]
pub fn release_scan(scan_id: String) -> Result<(), String> {
    scans().lock().remove(&scan_id);
    scan_progress().lock().remove(&scan_id);
    Ok(())
}

/// Delete a file or directory at the given path.
#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path not found: {}", path));
    }
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        std::fs::remove_file(p).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    Ok(())
}

// ── Response types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ScanResponse {
    pub scan_id: String,
    pub root_info: ScanRootInfo,
    pub stats: ScanStats,
}

#[derive(Debug, Clone, Serialize)]
pub struct PickDirectoryResponse {
    pub path: Option<String>,
}

/// Open a native directory picker dialog using the OS file dialog.
#[tauri::command]
pub fn pick_directory() -> Result<String, String> {
    // Use `rfd` for native file dialog
    rfd::FileDialog::new()
        .set_title("Select directory to scan")
        .pick_folder()
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .ok_or_else(|| "No directory selected".into())
}

fn chrono_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", nanos)
}
