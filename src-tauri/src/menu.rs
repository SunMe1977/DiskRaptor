use tauri::Manager;

const MENU_LANGUAGES: &[(&str, &str)] = &[
    ("lang_en", "English"),
    ("lang_de", "Deutsch"),
    ("lang_fr", "Français"),
    ("lang_es", "Español"),
    ("lang_it", "Italiano"),
    ("lang_pt", "Português"),
    ("lang_nl", "Nederlands"),
    ("lang_pl", "Polski"),
    ("lang_sv", "Svenska"),
    ("lang_da", "Dansk"),
    ("lang_nb", "Norsk"),
    ("lang_fi", "Suomi"),
    ("lang_cs", "Čeština"),
    ("lang_ro", "Română"),
    ("lang_tr", "Türkçe"),
    ("lang_id", "Bahasa Indonesia"),
    ("lang_vi", "Tiếng Việt"),
    ("lang_ru", "Русский"),
    ("lang_uk", "Українська"),
    ("lang_ar", "العربية"),
    ("lang_zh", "简体中文"),
    ("lang_zh-tw", "繁體中文"),
    ("lang_ja", "日本語"),
    ("lang_ko", "한국어"),
    ("lang_hi", "हिन्दी"),
];

#[cfg(desktop)]
pub fn build_native_menu<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let about = MenuItem::with_id(app, "about", "About DiskRaptor", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let app_submenu = Submenu::with_items(
        app,
        "DiskRaptor",
        true,
        &[
            &about as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let view_pie = MenuItem::with_id(app, "view_pie", "Pie Chart", true, Some("CmdOrCtrl+1"))?;
    let view_galaxy = MenuItem::with_id(app, "view_galaxy", "Galaxy", true, Some("CmdOrCtrl+3"))?;
    let view_treemap = MenuItem::with_id(app, "view_treemap", "Treemap", true, Some("CmdOrCtrl+4"))?;

    let lang_auto = MenuItem::with_id(app, "lang_auto", "Auto (System)", true, None::<&str>)?;
    let lang_sep = PredefinedMenuItem::separator(app)?;
    let mut lang_items_owned: Vec<tauri::menu::MenuItem<R>> =
        Vec::with_capacity(MENU_LANGUAGES.len());
    for (id, label) in MENU_LANGUAGES {
        lang_items_owned.push(MenuItem::with_id(app, *id, *label, true, None::<&str>)?);
    }
    let mut lang_items: Vec<&dyn IsMenuItem<R>> = vec![&lang_auto, &lang_sep];
    for item in &lang_items_owned {
        lang_items.push(item);
    }
    let lang_submenu = Submenu::with_items(app, "Language", true, &lang_items)?;

    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &view_pie as &dyn IsMenuItem<R>,
            &view_galaxy,
            &view_treemap,
            &PredefinedMenuItem::separator(app)?,
            &lang_submenu,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let scan_dl =
        MenuItem::with_id(app, "scan_downloads", "Scan Downloads", true, None::<&str>)?;
    let scan_trash = MenuItem::with_id(app, "scan_trash", "Scan Trash", true, None::<&str>)?;
    let trash_recovery =
        MenuItem::with_id(app, "trash_recovery", "Trash Recovery…", true, None::<&str>)?;
    let find_files = MenuItem::with_id(app, "find_files", "Find Files…", true, None::<&str>)?;
    let empty_folders =
        MenuItem::with_id(app, "empty_folders", "Empty Folders…", true, None::<&str>)?;
    let cleanup_dl =
        MenuItem::with_id(app, "cleanup_downloads", "Downloads Cleanup", true, None::<&str>)?;
    let smart_tools =
        MenuItem::with_id(app, "smart_tools", "S.M.A.R.T. Tools…", true, None::<&str>)?;
    let browser_tools =
        MenuItem::with_id(app, "browser_tools", "Clean Browser Tools…", true, None::<&str>)?;
    let apfs_snapshots =
        MenuItem::with_id(app, "apfs_snapshots", "APFS & Purgeable…", true, None::<&str>)?;
    let find_dupes =
        MenuItem::with_id(app, "find_duplicates", "Find Duplicate Files…", true, Some("CmdOrCtrl+D"))?;
    let export_html =
        MenuItem::with_id(app, "export_html", "Export HTML Report…", true, None::<&str>)?;
    let preferences =
        MenuItem::with_id(app, "preferences", "Preferences…", true, None::<&str>)?;
    let clear_scan = MenuItem::with_id(app, "clear_scan", "Clear Scan", true, None::<&str>)?;
    let empty_trash = MenuItem::with_id(app, "empty_trash", "Empty Trash…", true, None::<&str>)?;
    let exit_app_item = MenuItem::with_id(app, "menu_exit", "Exit", true, Some("CmdOrCtrl+Q"))?;
    let tools_submenu = Submenu::with_items(
        app,
        "Tools",
        true,
        &[
            &scan_dl as &dyn IsMenuItem<R>,
            &scan_trash,
            &trash_recovery,
            &find_files,
            &empty_folders,
            &cleanup_dl,
            &smart_tools,
            &browser_tools,
            &apfs_snapshots,
            &find_dupes,
            &PredefinedMenuItem::separator(app)?,
            &export_html,
            &preferences,
            &clear_scan,
            &PredefinedMenuItem::separator(app)?,
            &empty_trash,
            &PredefinedMenuItem::separator(app)?,
            &exit_app_item,
        ],
    )?;

    let window_submenu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)? as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let check_updates =
        MenuItem::with_id(app, "check_updates", "Check for Updates…", true, None::<&str>)?;
    let help_about = MenuItem::with_id(app, "about_help", "About DiskRaptor", true, Some("CmdOrCtrl+I"))?;
    let help_submenu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &check_updates as &dyn IsMenuItem<R>,
            &PredefinedMenuItem::separator(app)?,
            &help_about,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_submenu as &dyn IsMenuItem<R>,
            &view_submenu,
            &tools_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

#[cfg(desktop)]
pub fn handle_menu_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, id: &str) {
    let run = |js: &str| {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.eval(js);
        }
    };
    let click = |sel: &str| run(&format!("var e=document.querySelector(\"{sel}\");if(e)e.click();"));
    match id {
        "view_pie" => click(".diagram-mode[data-mode='pie']"),
        "view_galaxy" => click(".diagram-mode[data-mode='galaxy']"),
        "view_treemap" => click(".diagram-mode[data-mode='treemap']"),
        "scan_downloads" => click(".tools-item[data-action='scan-downloads']"),
        "scan_trash" => click(".tools-item[data-action='scan-trash']"),
        "trash_recovery" => click(".tools-item[data-action='trash-recovery']"),
        "find_files" => click(".tools-item[data-action='find-files']"),
        "empty_folders" => click(".tools-item[data-action='empty-folders']"),
        "cleanup_downloads" => click(".tools-item[data-action='cleanup-downloads']"),
        "smart_tools" => click(".tools-item[data-action='smart-tools']"),
        "browser_tools" => click(".tools-item[data-action='browser-tools']"),
        "apfs_snapshots" => click(".tools-item[data-action='apfs-snapshots']"),
        "find_duplicates" => click("#btn-duplicates"),
        "export_html" => click(".tools-item[data-action='export-html']"),
        "preferences" => click(".tools-item[data-action='settings']"),
        "clear_scan" => click(".tools-item[data-action='clear-scan']"),
        "empty_trash" => click(".tools-item[data-action='trash']"),
        "menu_exit" => {
            app.exit(0);
        }
        "check_updates" => run("if(window.__checkUpdate)window.__checkUpdate();"),
        "settings" => run("var s=document.getElementById('settings-overlay');if(s)s.style.display='flex';"),
        "about" | "about_help" => run("var o=document.getElementById('about-overlay');if(o)o.classList.add('active');"),
        "lang_auto" => run("if(window.I18N)window.I18N.setLocale('auto');"),
        _ => {
            if let Some(code) = id.strip_prefix("lang_") {
                run(&format!("if(window.I18N)window.I18N.setLocale('{code}');"));
            }
        }
    }
}
