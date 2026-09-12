#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apfs;
mod browser;
mod cmds;
mod ipc;
mod lifecycle;
mod menu;
mod menu_i18n;
mod scanner;
mod smart;
mod state;
mod streaming;
#[cfg(feature = "test-server")]
mod test_server;
mod tray;
mod trash;
mod window;

use crate::state::{AppState, JsonResult, ScanResultData};
#[allow(unused_imports)]
use std::sync::atomic::{AtomicBool, AtomicU64};
#[allow(unused_imports)]
use std::sync::Arc;
#[allow(unused_imports)]
use parking_lot::Mutex;
#[allow(unused_imports)]
use std::time::Instant;
#[allow(unused_imports)]
use tauri::Manager;
#[allow(unused_imports)]
use tauri::Emitter;
#[allow(unused_imports)]
use tauri_plugin_autostart::MacosLauncher;
#[allow(unused_imports)]
use serde::Serialize;
#[allow(unused_imports)]
use tracing::{info, error};

// Re-export the command domains so the crate-root API (integration tests,
// sibling modules smart/trash/browser) stays source compatible after splitting
// main.rs into cmds/. Several names are only referenced from #[cfg(test)] or
// platform-gated sibling modules, hence the allow.
#[allow(unused_imports)]
pub(crate) use cmds::{
    cancel_dup_scan, cancel_scan, check_admin_needed, check_for_updates, classify_download,
    delete_path, delete_permanent, exit_app, find_duplicates, get_app_data_dir, get_app_info,
    get_app_version, get_children, get_chunk, get_dir_stats, get_dup_result, get_dup_stats,
    get_home_dir, get_icon, get_memory_info, get_process_memory, get_scan_progress,
    get_scan_result, get_stats, get_trash_path, get_volume_stats, in_mac_sandbox, is_sandboxed,
    list_downloads_candidates, list_drives, list_volumes_via_sysinfo, load_settings, open_explorer,
    open_properties, open_terminal, open_url, parse_system_profiler_disks, pick_directory,
    release_scan, request_permissions, restart_as_admin, sanitize_delete_path, save_settings,
    start_scan, validate_system_path,
};
#[cfg(not(target_os = "windows"))]
#[allow(unused_imports)]
pub(crate) use cmds::run_output;
#[cfg(target_os = "windows")]
#[allow(unused_imports)]
pub(crate) use cmds::native_browser_icon;

// -- Main -------------------------------------------------------------------

fn main() {
    if lifecycle::is_second_instance() {
        lifecycle::focus_existing_and_exit();
    }

    let settings_path = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("diskraptor").join("settings.json");
    if let Some(parent) = settings_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(AppState::default())
        .setup(|app| {
            // System tray
            tray::build_tray(app.handle())?;

            // Autostart
            lifecycle::setup_autostart(app.handle());

            // Test server (for UI tests)
            #[cfg(feature = "test-server")]
            lifecycle::setup_test_server(app.handle());

            // Window setup
            window::setup_window(app.handle());

            // CLI handlers
            lifecycle::setup_cli_handlers(app.handle());

            // Low disk monitor
            lifecycle::setup_low_disk_monitor(app.handle());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                crate::window::save_window_bounds(window);
                let _ = window.hide();
            }
        })
        .menu(menu::build_native_menu)
        .on_menu_event(|app, event| menu::handle_menu_event(app, event.id().as_ref()))
        .invoke_handler(ipc::register_commands())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::scanner::tree::format_size;
    #[cfg(target_os = "macos")]
    use crate::browser::{browser_defs, browser_paths};

    #[test]
    fn parse_system_profiler_handles_empty_input() {
        assert!(parse_system_profiler_disks("").is_empty());
        assert!(parse_system_profiler_disks("not json {").is_empty());
    }

    #[test]
    fn parse_system_profiler_detects_drives() {
        let s = r#"{
          "SPStorageDataType": [
            { "_name": "Apple",
              "bsd_name": "disk1",
              "size_in_bytes": 500277790720,
              "physical_drive": {
                "device_name": "APPLE SSD SM0512",
                "is_internal_disk": "yes",
                "medium_type": "ssd"
              } },
            { "_name": "Backup",
              "bsd_name": "disk2s1",
              "size_in_bytes": 999000000,
              "physical_drive": {
                "device_name": "WD Elements 4TB",
                "is_internal_disk": "no",
                "medium_type": "hdd"
              } },
            { "_name": "Cryptex",
              "bsd_name": "disk4s1",
              "size_in_bytes": 4194304,
              "physical_drive": {
                "device_name": "Disk Image",
                "is_internal_disk": "no",
                "medium_type": "ssd"
              } }
          ]
        }"#;
        let disks = parse_system_profiler_disks(s);
        assert_eq!(disks.len(), 3, "all three distinct physical drives listed");
        assert_eq!(disks[0]["name"], "APPLE SSD SM0512");
        assert_eq!(disks[0]["id"], "disk1");
        assert_eq!(disks[0]["media_type"], 4, "ssd -> media_type 4");
        assert_eq!(disks[0]["is_internal"], true);
        assert_eq!(disks[1]["name"], "WD Elements 4TB");
        assert_eq!(disks[1]["media_type"], 3, "hdd -> media_type 3");
        assert_eq!(disks[1]["is_internal"], false);
    }

    #[test]
    fn parse_system_profiler_dedupes_shared_physical_drive() {
        let s = r#"{
          "SPStorageDataType": [
            { "_name": "Untitled",
              "bsd_name": "disk1s1",
              "physical_drive": { "device_name": "VMware Virtual SATA Hard Drive", "medium_type": "ssd" } },
            { "_name": "Untitled - Data",
              "bsd_name": "disk1s2",
              "physical_drive": { "device_name": "VMware Virtual SATA Hard Drive", "medium_type": "ssd" } }
          ]
        }"#;
        let disks = parse_system_profiler_disks(s);
        assert_eq!(disks.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn browser_defs_include_safari() {
        assert!(browser_defs().iter().any(|d| d.name == "Safari"));
    }

    #[test]
    fn drive_fields_match_frontend_contract() {
        let result = list_drives();
        let ok = result.success;
        assert!(ok);
        if let Some(data) = result.data {
            let arr = data.as_array().cloned().unwrap_or_default();
            if !arr.is_empty() {
                let d = &arr[0];
                assert!(d.get("path").is_some(), "drive missing path");
                assert!(d.get("name").is_some(), "drive missing name");
                assert!(d.get("total_bytes").is_some(), "drive missing total_bytes");
                assert!(d.get("free_bytes").is_some(), "drive missing free_bytes");
                assert!(d.get("used_bytes").is_some(), "drive missing used_bytes");
                assert!(d.get("usage_pct").is_some(), "drive missing usage_pct");
                assert!(d.get("percentFull").is_some(), "drive missing percentFull");
            }
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn safari_paths_fall_back_to_container() {
        for def in browser_defs() {
            if def.name != "Safari" { continue; }
            if let Some((_base, cookies, cache)) = browser_paths(&def) {
                assert!(!cookies.is_empty());
                assert!(!cache.is_empty());
                return;
            }
            panic!("browser_paths returned None for Safari");
        }
        panic!("Safari not in browser_defs");
    }

    #[test]
    fn format_size_known_values() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(1024), "1.00 KB");
        assert_eq!(format_size(1048576), "1.00 MB");
        assert_eq!(format_size(1073741824), "1.00 GB");
    }

    #[test]
    fn classify_download_detects_temp_files() {
        assert_eq!(classify_download("file.part", 100, 1), (true, false, false));
        assert_eq!(classify_download("setup.crdownload", 100, 1), (true, false, false));
        assert_eq!(classify_download("data.tmp", 100, 1), (true, false, false));
        assert_eq!(classify_download("image.download", 100, 1), (true, false, false));
    }

    #[test]
    fn classify_download_detects_old_and_large() {
        assert_eq!(classify_download("archive.zip", 200 * 1024 * 1024, 1), (false, false, true));
        assert_eq!(classify_download("old_file.pdf", 1000, 120), (false, true, false));
        assert_eq!(classify_download("normal.txt", 5000, 5), (false, false, false));
    }

    #[test]
    fn classify_download_is_case_insensitive() {
        assert_eq!(classify_download("BIG.MOVIE.PART", 100, 1), (true, false, false));
    }

    #[test]
    fn get_app_info_returns_expected_fields() {
        let result = get_app_info();
        assert!(result.success);
        if let Some(data) = result.data {
            assert!(data.get("version").is_some());
            assert!(data.get("os").is_some());
            assert!(data.get("arch").is_some());
            assert!(data.get("data_dir").is_some());
            assert_eq!(data["version"], env!("CARGO_PKG_VERSION"));
        }
    }

    #[test]
    fn open_url_rejects_dangerous_schemes() {
        assert!(open_url("file:///etc/passwd".to_string()).error.is_some());
        assert!(open_url("javascript:alert(1)".to_string()).error.is_some());
        assert!(open_url("data:text/html,x".to_string()).error.is_some());
    }

    #[test]
    fn chunk_start_index_matches_arena_offset() {
        use crate::scanner::tree::{NodeType, TreeNode, TreeNodeArena};
        use crate::streaming::chunker::chunk_tree;
        let mut arena = TreeNodeArena::with_capacity(25_000);
        for i in 0..25_000u32 {
            let mut n = TreeNode {
                name: format!("n{i}"),
                size: i as u64,
                file_count: 1,
                dir_count: 0,
                node_type: NodeType::File,
                parent: 0,
                first_child: u32::MAX,
                next_sibling: u32::MAX,
                depth: 1,
                chunk_id: 0,
                mtime: 0,
            };
            if i == 0 {
                n.parent = u32::MAX;
                n.node_type = NodeType::Directory;
                n.dir_count = 1;
                n.file_count = 0;
            }
            arena.nodes.push(n);
        }
         let chunks = chunk_tree(&arena, &None).unwrap();
        assert_eq!(chunks.len(), 3, "25000 nodes -> 3 chunks of 10000");
        assert_eq!(chunks[0].start_index, 0);
        assert_eq!(chunks[1].start_index, 10_000);
        assert_eq!(chunks[2].start_index, 20_000);
        assert_eq!(chunks[0].nodes.len(), 10_000);
        assert_eq!(chunks[2].nodes.len(), 5_000);
    }

    #[test]
    fn borrowed_chunk_json_matches_tree_chunk() {
        use crate::scanner::tree::{
            BorrowedChunk, NodeType, TreeNode, TreeNodeArena, TreeChunk,
        };
        let mut arena = TreeNodeArena::with_capacity(8);
        let root = arena.alloc(TreeNode {
            name: "root".into(), size: 3, file_count: 2, dir_count: 1,
            node_type: NodeType::Directory, parent: u32::MAX,
            first_child: u32::MAX, next_sibling: u32::MAX, depth: 0,
            chunk_id: 0, mtime: 0,
        });
        for (i, (n, s, mt)) in [("a.txt", 1u64, 11u64), ("b.bin", 2, 22)].iter().enumerate() {
            arena.alloc(TreeNode {
                name: n.to_string(), size: *s, file_count: 1, dir_count: 0,
                node_type: NodeType::File, parent: root,
                first_child: u32::MAX, next_sibling: u32::MAX, depth: 1,
                chunk_id: 0, mtime: *mt,
            });
            let _ = i;
        }
        let borrowed = BorrowedChunk::new(7, 1, 3, 0, &arena.nodes);
        let mut owned_nodes = arena.nodes.clone();
        for n in owned_nodes.iter_mut() {
            n.chunk_id = 7;
        }
        let owned = TreeChunk {
            chunk_id: 7, total_chunks: 1, total_nodes: 3, start_index: 0,
            nodes: owned_nodes,
        };
        let a = serde_json::to_value(&borrowed).unwrap();
        let b = serde_json::to_value(&owned).unwrap();

        // Compare chunk-level fields
        assert_eq!(a["chunk_id"], b["chunk_id"]);
        assert_eq!(a["total_chunks"], b["total_chunks"]);
        assert_eq!(a["total_nodes"], b["total_nodes"]);
        assert_eq!(a["start_index"], b["start_index"]);

        // Compare nodes - BorrowedNode has arena_index which TreeNode doesn't
        let a_nodes = a["nodes"].as_array().unwrap();
        let b_nodes = b["nodes"].as_array().unwrap();
        assert_eq!(a_nodes.len(), b_nodes.len());
        for (an, bn) in a_nodes.iter().zip(b_nodes.iter()) {
            // BorrowedNode includes arena_index - skip that
            let mut a_obj = an.as_object().unwrap().clone();
            a_obj.remove("arena_index");
            assert_eq!(a_obj, bn.as_object().unwrap().clone(), "Node fields diverged");
        }
    }
}