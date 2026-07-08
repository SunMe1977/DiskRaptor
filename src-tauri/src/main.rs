// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_lib::commands;
use tauri::{CustomMenuItem, Menu, Submenu, SystemTray};

fn main() {
    env_logger::init();

    std::panic::set_hook(Box::new(|info| {
        eprintln!("[DiskRaptor] Panic: {}", info);
    }));

    // Native Menu
    let view_pie = CustomMenuItem::new("view_pie", "Pie Chart").accelerator("CmdOrCtrl+1");
    let view_treemap = CustomMenuItem::new("view_treemap", "Treemap").accelerator("CmdOrCtrl+2");
    let view_menu = Submenu::new(
        "View",
        Menu::new().add_item(view_pie).add_item(view_treemap),
    );

    let about = CustomMenuItem::new("about", "About DiskRaptor").accelerator("CmdOrCtrl+I");
    let help_menu = Submenu::new("Help", Menu::new().add_item(about));

    let menu = Menu::new().add_submenu(view_menu).add_submenu(help_menu);

    // System Tray (minimal - icon will be loaded from config)
    let tray = SystemTray::new();

    tauri::Builder::default()
        .menu(menu)
        .system_tray(tray)
        .on_menu_event(|event| {
            let win = event.window();
            match event.menu_item_id() {
                "view_pie" => {
                    let _ = win.emit("menu-view-pie", ());
                }
                "view_treemap" => {
                    let _ = win.emit("menu-view-treemap", ());
                }
                "about" => {
                    let _ = win.emit("menu-about", ());
                }
                _ => {}
            }
        })
        .on_system_tray_event(|_app, _event| {
            // Tray events handled per platform
        })
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
