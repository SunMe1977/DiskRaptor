pub mod apfs;
pub mod browser;
pub mod cmds;
pub mod ipc;
pub mod lifecycle;
pub mod log;
pub mod menu;
pub mod menu_i18n;
pub mod scanner;
pub mod smart;
pub mod state;
pub mod streaming;
pub mod tray;
pub mod trash;
pub mod window;
#[cfg(feature = "ffi")]
pub mod scanner_api;
#[cfg(feature = "test-server")]
pub mod test_server;

// Re-export state types at crate root for backward compatibility
pub use state::{AppState, JsonResult, LiveEntries, ScanResultData, ScanState, DupState};
