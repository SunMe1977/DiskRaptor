// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_lib::commands;

// DiskRaptor main entry point
fn main() {
    env_logger::init();

    // Catch panics to prevent process abort
    std::panic::set_hook(Box::new(|info| {
        eprintln!("[DiskRaptor] Panic: {}", info);
    }));

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::start_scan,
            commands::get_chunk,
            commands::get_stats,
            commands::get_children,
            commands::release_scan,
            commands::pick_directory,
            commands::get_scan_progress,
            commands::get_scan_result,
            commands::delete_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiskRaptor");
}
