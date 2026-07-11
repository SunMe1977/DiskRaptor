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

    // ── Language menu (all 25 languages) ──────────────────
    let lang_auto = CustomMenuItem::new("lang_auto", "🌐 Auto (System)");
    let lang_menu = Menu::new().add_item(lang_auto);

    let languages = [
        ("lang_en", "🇺🇸 English"),
        ("lang_de", "🇩🇪 Deutsch"),
        ("lang_fr", "🇫🇷 Français"),
        ("lang_es", "🇪🇸 Español"),
        ("lang_it", "🇮🇹 Italiano"),
        ("lang_pt", "🇧🇷 Português"),
        ("lang_nl", "🇳🇱 Nederlands"),
        ("lang_pl", "🇵🇱 Polski"),
        ("lang_sv", "🇸🇪 Svenska"),
        ("lang_da", "🇩🇰 Dansk"),
        ("lang_nb", "🇳🇴 Norsk"),
        ("lang_fi", "🇫🇮 Suomi"),
        ("lang_cs", "🇨🇿 Čeština"),
        ("lang_ro", "🇷🇴 Română"),
        ("lang_tr", "🇹🇷 Türkçe"),
        ("lang_id", "🇮🇩 Bahasa Indonesia"),
        ("lang_vi", "🇻🇳 Tiếng Việt"),
        ("lang_ru", "🇷🇺 Русский"),
        ("lang_uk", "🇺🇦 Українська"),
        ("lang_ar", "🇸🇦 العربية"),
        ("lang_zh", "🇨🇳 简体中文"),
        ("lang_zh-tw", "🇹🇼 繁體中文"),
        ("lang_ja", "🇯🇵 日本語"),
        ("lang_ko", "🇰🇷 한국어"),
        ("lang_hi", "🇮🇳 हिन्दी"),
    ];

    // Start building lang submenu — start with a separator after "Auto"
    // by using a dummy label item as visual separator
    let mut lang_menu_built = lang_menu.add_item(CustomMenuItem::new("_lang_sep1", "─"));

    for (id, label) in languages {
        let item = CustomMenuItem::new(id.to_string(), label);
        lang_menu_built = lang_menu_built.add_item(item);
    }

    let lang_submenu = Submenu::new("Language", lang_menu_built);

    // ── View menu ─────────────────────────────────────────
    let view_pie = CustomMenuItem::new("view_pie", "Pie Chart").accelerator("CmdOrCtrl+1");
    let view_treemap = CustomMenuItem::new("view_treemap", "Treemap").accelerator("CmdOrCtrl+2");
    let view_menu = Submenu::new(
        "View",
        Menu::new()
            .add_item(view_pie)
            .add_item(view_treemap)
            .add_submenu(lang_submenu),
    );

    // ── Tools menu ────────────────────────────────────────
    let find_dupes =
        CustomMenuItem::new("find_duplicates", "Find Duplicate Files…").accelerator("CmdOrCtrl+D");
    let tools_menu = Submenu::new("Tools", Menu::new().add_item(find_dupes));

    let check_updates = CustomMenuItem::new("check_updates", "Check for Updates…");
    let about = CustomMenuItem::new("about", "About DiskRaptor").accelerator("CmdOrCtrl+I");
    let help_menu = Submenu::new("Help", Menu::new().add_item(check_updates).add_item(about));

    let menu = Menu::new()
        .add_submenu(view_menu)
        .add_submenu(tools_menu)
        .add_submenu(help_menu);

    // ── System Tray ───────────────────────────────────────
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
            let id = event.menu_item_id();
            match id {
                "view_pie" => {
                    let _ = win.emit("menu-view-pie", ());
                }
                "view_treemap" => {
                    let _ = win.emit("menu-view-treemap", ());
                }
                "find_duplicates" => {
                    let _ = win.emit("menu-find-duplicates", ());
                }
                "check_updates" => {
                    let _ = win.emit("menu-check-updates", ());
                }
                "about" => {
                    let _ = win.emit("menu-about", ());
                }
                "lang_auto" => {
                    let _ = win.emit("lang-changed", "auto");
                }
                _ if id.starts_with("lang_") && !id.starts_with("_lang_") => {
                    let code = id.strip_prefix("lang_").unwrap_or("en");
                    let _ = win.emit("lang-changed", code);
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
            commands::get_home_dir,
            commands::list_drives,
            commands::check_for_updates,
            commands::download_and_install,
            commands::check_admin_needed,
            commands::restart_as_admin,
            commands::find_duplicates,
            commands::get_duplicate_progress,
            commands::get_duplicate_results,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DiskRaptor");
}
