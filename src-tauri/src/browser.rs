//! Browser cache / cookie cleanup tools.

use crate::JsonResult;

// â”€â”€ Browser Cleanup Tools â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[derive(Clone)]
struct BrowserDef {
    name: &'static str,
    #[allow(dead_code)] // used by browser_paths_windows
    sub: &'static str,
    kind: &'static str,
    #[allow(dead_code)] // used by browser_paths_windows
    base: &'static str, // "local" | "appdata"
}

fn dir_size(path: &std::path::Path) -> u64 {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    if let Ok(rd) = std::fs::read_dir(path) {
        for entry in rd.flatten() {
            total += dir_size(&entry.path());
        }
    }
    total
}

fn sum_sizes(paths: &[std::path::PathBuf]) -> u64 {
    paths.iter().map(|p| dir_size(p)).sum()
}

fn delete_path_recursive(path: &std::path::Path) -> u64 {
    let size = dir_size(path);
    if size > 0 {
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
    }
    size
}

fn browser_defs() -> Vec<BrowserDef> {
    vec![
        BrowserDef { name: "Google Chrome", sub: r"Google\Chrome\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Microsoft Edge", sub: r"Microsoft\Edge\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Safari", sub: r"com.apple.Safari", kind: "safari", base: "local" },
        BrowserDef { name: "Chromium", sub: r"Chromium\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Brave", sub: r"BraveSoftware\Brave-Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Vivaldi", sub: r"Vivaldi\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Yandex Browser", sub: r"Yandex\YandexBrowser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Avast Secure Browser", sub: r"AVAST Software\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "AVG Secure Browser", sub: r"AVG\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "CocCoc", sub: r"CocCoc\Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Maxthon", sub: r"Maxthon5\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Arc", sub: r"Arc\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Epic Privacy Browser", sub: r"Epic Privacy Browser\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Slimjet", sub: r"Slimjet\User Data", kind: "chrome", base: "local" },
        BrowserDef { name: "Opera", sub: r"Opera Software\Opera Stable", kind: "opera", base: "appdata" },
        BrowserDef { name: "Opera GX", sub: r"Opera Software\Opera GX Stable", kind: "opera", base: "appdata" },
        BrowserDef { name: "Firefox", sub: r"Mozilla\Firefox\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Waterfox", sub: r"Waterfox\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Pale Moon", sub: r"Moonchild Productions\Pale Moon\Profiles", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Tor Browser", sub: r"Tor Browser\Browser\TorBrowser\Data\Browser", kind: "firefox", base: "appdata" },
        BrowserDef { name: "Internet Explorer", sub: r"Microsoft\Windows\Cookies", kind: "ie", base: "appdata" },
    ]
}

#[cfg(target_os = "windows")]
fn browser_paths_windows(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let appdata = std::env::var("APPDATA").ok()?;
    let base_dir = if def.base == "local" { &local } else { &appdata };
    let base = std::path::PathBuf::from(base_dir).join(def.sub);
    let (cookies, cache) = match def.kind {
        "chrome" | "opera" => (
            vec![
                base.join("Default").join("Network").join("Cookies"),
                base.join("Default").join("Cookies"),
            ],
            vec![
                base.join("Default").join("Cache"),
                base.join("Default").join("Code Cache"),
                base.join("Default").join("GPUCache"),
                base.join("Default").join("Service Worker").join("CacheStorage"),
            ],
        ),
        "firefox" => {
            let mut cookies = Vec::new();
            let mut cache = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    let ck = p.join("cookies.sqlite");
                    if ck.exists() { cookies.push(ck); }
                    cache.push(p.join("cache2"));
                    cache.push(p.join("startupCache"));
                }
            }
            (cookies, cache)
        }
        "ie" => (
            vec![base.join("Cookies")],
            vec![std::path::PathBuf::from(&local).join(r"Microsoft\Windows\INetCache")],
        ),
        _ => (Vec::new(), Vec::new()),
    };
    Some((base, cookies, cache))
}

#[cfg(target_os = "linux")]
fn browser_paths_linux(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let home = std::env::var("HOME").ok()?;
    let cfg = |p: &str| std::path::PathBuf::from(&home).join(".config").join(p);
    let cache = |p: &str| std::path::PathBuf::from(&home).join(".cache").join(p);
    let (base, cookies, cache_paths): (std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) = match def.name {
        "Google Chrome" => (cfg("google-chrome"), vec![cfg("google-chrome/Default/Network/Cookies")], vec![cache("google-chrome/Default/Cache")]),
        "Chromium" => (cfg("chromium"), vec![cfg("chromium/Default/Network/Cookies")], vec![cache("chromium/Default/Cache")]),
        "Microsoft Edge" => (cfg("microsoft-edge"), vec![cfg("microsoft-edge/Default/Network/Cookies")], vec![cache("microsoft-edge/Default/Cache")]),
        "Brave" => (cfg("BraveSoftware/Brave-Browser"), vec![cfg("BraveSoftware/Brave-Browser/Default/Network/Cookies")], vec![cache("BraveSoftware/Brave-Browser/Default/Cache")]),
        "Opera" => (cfg("opera"), vec![cfg("opera/Default/Network/Cookies")], vec![cache("opera/Default/Cache")]),
        "Firefox" => {
            let base = std::path::PathBuf::from(&home).join(".mozilla").join("firefox");
            let mut cookies = Vec::new();
            let mut caches = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    if p.join("cookies.sqlite").exists() { cookies.push(p.join("cookies.sqlite")); }
                    caches.push(p.join("cache2"));
                }
            }
            (base, cookies, caches)
        }
        _ => return None,
    };
    Some((base, cookies, cache_paths))
}

#[cfg(target_os = "macos")]
fn browser_paths_macos(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    let home = std::env::var("HOME").ok()?;
    let support = |p: &str| std::path::PathBuf::from(&home).join("Library/Application Support").join(p);
    let caches = |p: &str| std::path::PathBuf::from(&home).join("Library/Caches").join(p);
    let (base, cookies, cache_paths) = match def.name {
        "Google Chrome" => (support("Google/Chrome"), vec![support("Google/Chrome/Default/Network/Cookies")], vec![caches("Google/Chrome/Default/Cache")]),
        "Microsoft Edge" => (support("Microsoft Edge"), vec![support("Microsoft Edge/Default/Network/Cookies")], vec![caches("Microsoft Edge/Default/Cache")]),
        "Safari" => {
            let base = support("com.apple.Safari");
            let container = std::path::PathBuf::from(&home).join("Library/Containers/com.apple.Safari/Data/Library");
            let cookies = if container.join("Cookies/Cookies.binarycookies").exists() {
                vec![container.join("Cookies/Cookies.binarycookies")]
            } else {
                vec![base.join("Cookies.binarycookies")]
            };
            let mut cache = Vec::new();
            for p in [
                container.join("Caches/com.apple.Safari"),
                container.join("WebKit/com.apple.WebKit"),
                container.join("WebKit/com.apple.Safari"),
                caches("com.apple.Safari"),
            ] {
                if p.exists() { cache.push(p); }
            }
            if cache.is_empty() { cache.push(base.join("Cache")); }
            (base, cookies, cache)
        }
        "Firefox" => {
            let base = support("Firefox/Profiles");
            let mut cookies = Vec::new();
            let mut caches = Vec::new();
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    if !p.is_dir() { continue; }
                    if p.join("cookies.sqlite").exists() { cookies.push(p.join("cookies.sqlite")); }
                    caches.push(p.join("cache2"));
                }
            }
            (base, cookies, caches)
        }
        _ => return None,
    };
    Some((base, cookies, cache_paths))
}

#[allow(clippy::needless_return)] // cfg-gated returns keep each platform arm type-consistent
fn browser_paths(def: &BrowserDef) -> Option<(std::path::PathBuf, Vec<std::path::PathBuf>, Vec<std::path::PathBuf>)> {
    #[cfg(target_os = "windows")]
    { return browser_paths_windows(def); }
    #[cfg(target_os = "linux")]
    { return browser_paths_linux(def); }
    #[cfg(target_os = "macos")]
    { return browser_paths_macos(def); }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    { None }
}

#[cfg(target_os = "windows")]
fn browser_exe_path(name: &str) -> Option<std::path::PathBuf> {
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let pf = std::env::var("ProgramFiles").unwrap_or_default();
    let pf86 = std::env::var("ProgramFiles(x86)").unwrap_or_default();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    match name {
        "Google Chrome" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Google\Chrome\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Google\Chrome\Application\chrome.exe"));
        }
        "Microsoft Edge" => {
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Microsoft\Edge\Application\msedge.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Microsoft\Edge\Application\msedge.exe"));
        }
        "Firefox" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Mozilla Firefox\firefox.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Mozilla Firefox\firefox.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Mozilla Firefox\firefox.exe"));
        }
        "Opera" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera\opera.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera\launcher.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Opera\launcher.exe"));
        }
        "Opera GX" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera GX\opera.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Programs\Opera GX\launcher.exe"));
        }
        "Brave" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"BraveSoftware\Brave-Browser\Application\brave.exe"));
        }
        "Chromium" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Chromium\Application\chrome.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Chromium\Application\chrome.exe"));
        }
        "Vivaldi" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Vivaldi\Application\vivaldi.exe"));
            candidates.push(std::path::PathBuf::from(&pf).join(r"Vivaldi\Application\vivaldi.exe"));
        }
        "Yandex Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Yandex\YandexBrowser\Application\browser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"Yandex\YandexBrowser\Application\browser.exe"));
        }
        "Avast Secure Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"AVAST Software\Browser\Application\AvastBrowser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"AVAST Software\Browser\Application\AvastBrowser.exe"));
        }
        "AVG Secure Browser" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"AVG\Browser\Application\AVGBrowser.exe"));
            candidates.push(std::path::PathBuf::from(&local).join(r"AVG\Browser\Application\AVGBrowser.exe"));
        }
        "Tor Browser" => {
            candidates.push(std::path::PathBuf::from(&local).join(r"Tor Browser\Browser\firefox.exe"));
        }
        "Internet Explorer" => {
            candidates.push(std::path::PathBuf::from(&pf).join(r"Internet Explorer\iexplore.exe"));
            candidates.push(std::path::PathBuf::from(&pf86).join(r"Internet Explorer\iexplore.exe"));
        }
        _ => {}
    }
    candidates.into_iter().find(|p| p.exists())
}

#[cfg(target_os = "windows")]
fn simple_hash(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{:016x}", h)
}

#[tauri::command]
pub fn get_browser_icon(exe: String) -> JsonResult {
    #[cfg(target_os = "windows")]
    {
        let cache_dir = dirs::config_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("diskraptor").join("browser-icons");
        let cache_file = cache_dir.join(format!("{}.txt", simple_hash(&exe)));
        // Fast path: read previously extracted icon from disk cache.
        if let Ok(s) = std::fs::read_to_string(&cache_file) {
            if s.starts_with("data:image") {
                return JsonResult::ok(serde_json::Value::String(s.trim().to_string()));
            }
        }
        // Native shell icon extraction (SHGetFileInfoW) — no PowerShell.
        if let Some(data_url) = crate::native_browser_icon(&exe) {
            let _ = std::fs::create_dir_all(&cache_dir);
            let _ = std::fs::write(&cache_file, &data_url);
            return JsonResult::ok(serde_json::Value::String(data_url));
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = &exe; }
    JsonResult::err("Could not extract browser icon")
}

#[tauri::command]
pub async fn list_browser_data() -> JsonResult {
    // Summing cache sizes walks large directory trees, so run it off the
    // main/UI thread to avoid freezing the window.
    tauri::async_runtime::spawn_blocking(|| {
        let mut list: Vec<serde_json::Value> = Vec::new();
        for def in browser_defs() {
            if let Some((_base, cookies, cache)) = browser_paths(&def) {
                let cookie_size = sum_sizes(&cookies);
                let cache_size = sum_sizes(&cache);
                if cookie_size == 0 && cache_size == 0 { continue; }
                let exe: Option<String> = {
                    #[cfg(target_os = "windows")]
                    {
                        browser_exe_path(def.name).map(|p| p.to_string_lossy().to_string())
                    }
                    #[cfg(not(target_os = "windows"))]
                    { None }
                };
                let cookie_paths: Vec<String> = cookies.iter()
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                let cache_paths: Vec<String> = cache.iter()
                    .filter(|p| p.exists())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                list.push(serde_json::json!({
                    "name": def.name,
                    "cookie_size": cookie_size,
                    "cache_size": cache_size,
                    "total_size": cookie_size + cache_size,
                    "kind": def.kind,
                    "exe": exe,
                    "cookie_paths": cookie_paths,
                    "cache_paths": cache_paths,
                }));
            }
        }
        list.sort_by(|a, b| b["total_size"].as_u64().unwrap_or(0).cmp(&a["total_size"].as_u64().unwrap_or(0)));
        JsonResult::ok(serde_json::json!(list))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Browser scan failed: {e}")))
}

#[tauri::command]
pub async fn clean_browser(name: String, cookies: bool, cache: bool) -> JsonResult {
    tauri::async_runtime::spawn_blocking(move || {
        for def in browser_defs() {
            if def.name != name { continue; }
            if let Some((_base, cookie_paths, cache_paths)) = browser_paths(&def) {
                let mut freed = 0u64;
                if cookies {
                    for p in &cookie_paths {
                        if p.exists() { freed += delete_path_recursive(p); }
                    }
                }
                if cache {
                    for p in &cache_paths {
                        if p.exists() { freed += delete_path_recursive(p); }
                    }
                }
                return JsonResult::ok(serde_json::json!({
                    "name": name, "freed": freed,
                }));
            }
        }
        JsonResult::err(format!("Browser not found: {}", name))
    })
    .await
    .unwrap_or_else(|e| JsonResult::err(format!("Clean failed: {e}")))
}
