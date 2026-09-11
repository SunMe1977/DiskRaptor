//! IPC command registration.
use tauri::Manager;

use crate::{state::AppState, cmds, menu, smart, browser, apfs, trash};

pub fn register_commands() -> Box<tauri::ipc::InvokeHandler<tauri::Wry>> {
    // Native menu localization
    #[tauri::command]
    fn get_system_locale() -> String {
        sys_locale::get_locale().unwrap_or_else(|| "en-US".to_string())
    }

    #[tauri::command]
    fn set_locale(
        app: tauri::AppHandle,
        locale: String,
        strings: std::collections::HashMap<String, String>,
        raw: String,
    ) {
        let os_base = sys_locale::get_locale()
            .map(|l| l.split('-').next().unwrap_or("en").to_lowercase())
            .unwrap_or_else(|| "en".to_string());
        let push_base = locale.split('-').next().unwrap_or("en").to_lowercase();
        if raw.trim().eq_ignore_ascii_case("auto") && push_base == "en" && os_base != "en" {
            return;
        }
        {
            let st = app.state::<AppState>();
            *st.locale.lock() = locale;
            *st.menu_strings.lock() = strings;
        }
        if let Some(win) = app.get_webview_window("main") {
            if let Ok(m) = menu::build_native_menu(&app) {
                let _ = win.set_menu(m);
            }
        }
        if let Some(tray) = app.tray_by_id("main") {
            if let Ok(m) = menu::build_tray_menu(&app) {
                let _ = tray.set_menu(Some(m));
            }
        }
    }

    // Generate the invoke handler with all commands
    Box::new(tauri::generate_handler![
        cmds::path_ops::delete_path, cmds::path_ops::delete_permanent,
        cmds::path_ops::open_explorer, cmds::path_ops::open_terminal, cmds::path_ops::open_properties, cmds::path_ops::get_icon,
        cmds::system::get_home_dir, cmds::system::pick_directory, cmds::system::get_trash_path, cmds::system::list_drives, cmds::system::get_volume_stats, cmds::system::get_dir_stats,
        cmds::system::list_downloads_candidates,
        cmds::system::get_memory_info, cmds::system::get_process_memory, cmds::system::get_app_version, cmds::system::get_app_data_dir, cmds::system::get_app_info,
        trash::empty_trash, trash::list_trash, trash::restore_trash,
        cmds::system::request_permissions, cmds::system::check_admin_needed, cmds::system::restart_as_admin, cmds::system::is_sandboxed,
        cmds::system::check_for_updates, cmds::path_ops::open_url,
        cmds::scan::start_scan, cmds::scan::get_scan_progress, cmds::scan::get_scan_result,
        cmds::scan::get_chunk, cmds::scan::get_children, cmds::scan::cancel_scan, cmds::scan::release_scan, cmds::scan::get_stats,
        cmds::scan::search_tree,
        cmds::dups::find_duplicates, cmds::dups::get_dup_stats, cmds::dups::get_dup_result, cmds::dups::cancel_dup_scan,
        cmds::settings::save_settings, cmds::settings::load_settings,
        cmds::system::list_disks, cmds::path_ops::exit_app,
        smart::get_smart_status,
        browser::list_browser_data, browser::clean_browser, browser::get_browser_icon,
        apfs::list_apfs_volumes, apfs::delete_local_snapshot, apfs::get_apfs_schedule, apfs::set_apfs_schedule, apfs::run_apfs_cleanup,
        cmds::autostart::set_autostart, cmds::autostart::get_autostart,
        set_locale, get_system_locale,
    ])
}