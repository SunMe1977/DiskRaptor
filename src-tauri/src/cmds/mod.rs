//! Tauri command domains. Splitting the former monolith into thematic modules
//! keeps ownership, review and testing tractable: file operations + native
//! shell/icon interop (`path_ops`), system/info/update commands (`system`),
//! scan streaming (`scan`), duplicate scanning (`dups`) and settings (`settings`).

pub(crate) mod dups;
pub(crate) mod path_ops;
pub(crate) mod scan;
pub(crate) mod settings;
pub(crate) mod system;

// Re-exports keep the crate-root API (invoke_handler, integration tests,
// sibling modules such as smart/trash/browser) source-compatible after the
// split.
pub(crate) use dups::{cancel_dup_scan, find_duplicates, get_dup_result, get_dup_stats};
pub(crate) use path_ops::{
    delete_path, delete_permanent, exit_app, get_icon, open_explorer, open_properties,
    open_terminal, open_url, sanitize_delete_path, validate_system_path,
};
pub(crate) use scan::{
    cancel_scan, get_children, get_chunk, get_scan_progress, get_scan_result, get_stats,
    release_scan, start_scan,
};
pub(crate) use settings::{load_settings, save_settings};
pub(crate) use system::{
    check_admin_needed, check_for_updates, classify_download, get_app_data_dir, get_app_info,
    get_app_version, get_dir_stats, get_home_dir, get_memory_info, get_process_memory,
    get_trash_path, get_volume_stats, in_mac_sandbox, is_sandboxed, list_downloads_candidates,
    list_drives, list_volumes_via_sysinfo, parse_system_profiler_disks, pick_directory,
    request_permissions, restart_as_admin,
};
#[cfg(not(target_os = "windows"))]
pub(crate) use system::{run_output, silent_command};
#[cfg(target_os = "windows")]
pub(crate) use path_ops::native_browser_icon;
