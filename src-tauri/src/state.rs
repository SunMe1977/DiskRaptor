//! Shared application state types.
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::Arc;
use parking_lot::Mutex;
use std::time::Instant;
use serde::Serialize;
use crate::scanner;

/// Keeps the system-tray icon alive for the app's lifetime.
#[allow(dead_code)]
pub struct Tray {
    pub _tray: tauri::tray::TrayIcon,
}

pub type LiveEntries = std::sync::Arc<parking_lot::Mutex<std::collections::VecDeque<String>>>;

#[allow(dead_code)]
pub struct ScanState {
    pub result: Mutex<Option<ScanResultData>>,
    pub files_found: AtomicU64,
    pub dirs_found: AtomicU64,
    pub bytes_found: AtomicU64,
    pub current_dir: Mutex<String>,
    pub start_time: Mutex<Instant>,
    pub running: AtomicBool,
    pub cancelled: AtomicBool,
    pub cancel_flag: Mutex<Option<Arc<AtomicBool>>>,
    pub errors: Mutex<Vec<String>>,
    /// The scan id currently active (or last started). Responses/events are
    /// only valid while they match this id.
    pub active_scan_id: AtomicU64,
    pub live_entries: Mutex<Option<LiveEntries>>,
    /// Serialized `get_scan_result` payload cached once per scan (keyed by scan
    /// id) so repeated IPC calls don't rebuild the whole JSON every time.
    pub cached_result: Mutex<Option<(u64, serde_json::Value)>>,
}

impl Default for ScanState {
    fn default() -> Self {
        Self {
            result: Mutex::new(None),
            files_found: AtomicU64::new(0),
            dirs_found: AtomicU64::new(0),
            bytes_found: AtomicU64::new(0),
            current_dir: Mutex::new(String::new()),
            start_time: Mutex::new(Instant::now()),
            running: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
            cancel_flag: Mutex::new(None),
            errors: Mutex::new(Vec::new()),
            active_scan_id: AtomicU64::new(0),
            live_entries: Mutex::new(None),
            cached_result: Mutex::new(None),
        }
    }
}

// -- Duplicate scanner state ------------------------------------------------

#[derive(Default)]
pub struct DupState {
    pub running: AtomicBool,
    pub cancelled: AtomicBool,
    pub phase: AtomicU64,
    pub files_scanned: AtomicU64,
    pub current_file: Mutex<String>,
    pub groups: Mutex<Vec<serde_json::Value>>,
    pub wasted_bytes: Mutex<u64>,
}

// -- App managed state ------------------------------------------------------

pub struct AppState {
    pub scan: ScanState,
    pub dup: DupState,
    pub settings_path: Mutex<std::path::PathBuf>,
    /// Monotonic scan id counter so `start_scan` can hand back a real `scan_id`.
    pub scan_counter: AtomicU64,
    #[allow(dead_code)] // used on Linux for pkexec caching
    pub smart_cache: Mutex<std::collections::HashMap<String, (std::time::Instant, JsonResult)>>,
    /// Last scanned path (used by the tray "Open last scan" item).
    pub last_scan_path: Mutex<Option<String>>,
    /// Resolved UI locale code ("en", "de", …) used to localize native menus.
    pub locale: Mutex<String>,
    /// Translated labels for native (tray / window) menus, sent from the webview.
    pub menu_strings: Mutex<std::collections::HashMap<String, String>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            scan: ScanState::default(),
            dup: DupState::default(),
            settings_path: Mutex::new(std::path::PathBuf::new()),
            scan_counter: AtomicU64::new(0),
            smart_cache: Mutex::new(std::collections::HashMap::new()),
            last_scan_path: Mutex::new(None),
            locale: Mutex::new("en".to_string()),
            menu_strings: Mutex::new(std::collections::HashMap::new()),
        }
    }
}

// -- Helper types -----------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[must_use]
pub struct JsonResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl JsonResult {
    pub fn ok(data: serde_json::Value) -> Self {
        Self { success: true, data: Some(data), error: None }
    }
    pub fn ok_empty() -> Self {
        Self { success: true, data: None, error: None }
    }
    pub fn err(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
    /// Extract the inner data payload, or an empty object on error/empty.
    pub fn into_data(self) -> serde_json::Value {
        self.data.unwrap_or_else(|| serde_json::json!({}))
    }
}

#[allow(dead_code)]
pub struct ScanResultData {
    pub arena: scanner::tree::TreeNodeArena,
    pub stats: scanner::tree::ScanStats,
    pub scan_time_ms: u64,
    pub errors: Vec<String>,
    pub termination: scanner::walker::ScanTermination,
    /// Absolute path that was scanned; used to build real paths for insights /
    /// tree-search results (arena nodes only store relative names).
    pub root_path: String,
    /// Precomputed "plain-language" insight payload (#4) attached to stats.
    pub insights: serde_json::Value,
}