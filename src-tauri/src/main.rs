// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use diskraptor_lib::commands;
use tauri::{
    CustomMenuItem, Manager, Menu, Submenu, SystemTray, SystemTrayMenu, SystemTrayMenuItem,
};

fn main() {
    #[cfg(windows)]
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

    // System Tray with Open and Exit menus
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("tray_open", "Open DiskRaptor"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("tray_quit", "Quit"));
    let tray = SystemTray::new().with_menu(tray_menu);

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
        .on_system_tray_event(|app, event| {
            if let tauri::SystemTrayEvent::MenuItemClick { id, .. } = event {
                match id.as_str() {
                    "tray_open" => {
                        if let Some(window) = app.get_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "tray_quit" => {
                        std::process::exit(0);
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            // Maximize the main window after creation
            if let Some(window) = app.get_window("main") {
                let _ = window.maximize();
            }
            Ok(())
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
            commands::open_terminal,
            commands::open_explorer,
            commands::open_properties,
            commands::get_icon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiskRaptor");
}
