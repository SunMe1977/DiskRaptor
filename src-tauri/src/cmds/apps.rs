//! Native App Manager backend for macOS and Linux.
//!
//! Windows keeps its registry/winget implementation in `system.rs`; this module
//! provides the equivalent inventory, icon extraction, update check and
//! uninstall paths for the other two desktop platforms.
//!
//! Most helpers are deliberately platform-agnostic (pure parsers, PATH lookup,
//! command capture) so they are compiled and unit-tested on every build host —
//! the macOS/Linux branches cannot rot silently on a Windows CI machine.

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

use crate::cmds::system::{dir_size, in_mac_sandbox};

// ── Shared helpers ──────────────────────────────────────────────────────────

/// Run a command and capture its output, including non-zero exits (several
/// package managers use exit codes to signal "updates available").
fn run_capture(cmd: &str, args: &[&str]) -> Option<(bool, String, String)> {
    // Force a predictable locale: every parser below relies on the C locale
    // (column headers, "is owned by", pacman field names, …).
    let out = Command::new(cmd)
        .args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        // apt/dpkg otherwise try to open debconf and needrestart prompts, which
        // a GUI process with no terminal can never answer.
        .env("DEBIAN_FRONTEND", "noninteractive")
        .env("NEEDRESTART_MODE", "a")
        .output()
        .ok()?;
    Some((
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    ))
}

/// Package ids are passed to package managers as arguments; reject values that
/// could be parsed as options or that contain shell-hostile whitespace.
fn valid_package_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && !id.chars().any(|ch| ch.is_whitespace() || ch.is_control())
}

/// Is `name` present in `PATH`? Deliberately avoids spawning `which`.
pub(crate) fn command_exists(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

fn first_error(stderr: &str) -> String {
    stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string()
}

/// Parse human-readable sizes like `12.34 MiB`, `1.2 GB` or a bare byte count.
fn parse_size(text: &str) -> u64 {
    let mut number = String::new();
    let mut unit = String::new();
    for ch in text.chars() {
        if ch.is_ascii_digit() || ch == '.' || ch == ',' {
            number.push(if ch == ',' { '.' } else { ch });
        } else if ch.is_ascii_alphabetic() {
            unit.push(ch.to_ascii_lowercase());
        }
    }
    let Ok(value) = number.parse::<f64>() else {
        return 0;
    };
    let multiplier = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" | "kib" => 1024.0,
        "m" | "mb" | "mib" => 1024.0 * 1024.0,
        "g" | "gb" | "gib" => 1024.0 * 1024.0 * 1024.0,
        "t" | "tb" | "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (value * multiplier) as u64
}

#[derive(Clone, Debug)]
struct AppUpdate {
    name: String,
    id: String,
    version: String,
    available: String,
    source: String,
}

impl AppUpdate {
    fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "id": self.id,
            "version": self.version,
            "available": self.available,
            "source": self.source,
        })
    }
}

fn updates_json(updates: &[AppUpdate]) -> Value {
    Value::Array(updates.iter().map(AppUpdate::to_json).collect())
}

// ── .desktop parsing (Linux) ────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct DesktopEntry {
    name: String,
    exec: String,
    icon: String,
    app_type: String,
    no_display: bool,
    hidden: bool,
    only_show_in: Vec<String>,
    not_show_in: Vec<String>,
    flatpak_id: String,
}

/// Parse the `[Desktop Entry]` group. Values from action groups (`[Desktop
/// Action ...]`) must not leak into the inventory, so only the main group is
/// considered.
fn parse_desktop_entry(content: &str) -> DesktopEntry {
    let mut entry = DesktopEntry::default();
    let mut in_main = false;
    for raw in content.lines() {
        let line = raw.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        if !in_main || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim();
        match key {
            "Name" => entry.name = value.to_string(),
            "Exec" => entry.exec = value.to_string(),
            "Icon" => entry.icon = value.to_string(),
            "Type" => entry.app_type = value.to_string(),
            "NoDisplay" => entry.no_display = value.eq_ignore_ascii_case("true"),
            "Hidden" => entry.hidden = value.eq_ignore_ascii_case("true"),
            "OnlyShowIn" => entry.only_show_in = split_desktop_list(value),
            "NotShowIn" => entry.not_show_in = split_desktop_list(value),
            "X-Flatpak" => entry.flatpak_id = value.to_string(),
            _ => {}
        }
    }
    entry
}

fn split_desktop_list(value: &str) -> Vec<String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .collect()
}

/// Split an `Exec=` line into tokens, honouring quotes and backslash escapes.
fn split_command(exec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in exec.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match quote {
            Some(q) => {
                if ch == q {
                    quote = None;
                } else if ch == '\\' {
                    escaped = true;
                } else {
                    current.push(ch);
                }
            }
            None => {
                if ch == '"' || ch == '\'' {
                    quote = Some(ch);
                } else if ch == '\\' {
                    escaped = true;
                } else if ch.is_whitespace() {
                    if !current.is_empty() {
                        out.push(std::mem::take(&mut current));
                    }
                } else {
                    current.push(ch);
                }
            }
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    // Drop desktop-entry field codes (%f, %U, %i, …).
    out.retain(|token| !(token.starts_with('%') && token.len() == 2));
    out
}

/// First real executable of an `Exec=` line, skipping `env` and `VAR=value`
/// prefixes that desktop files occasionally use.
fn exec_program(exec: &str) -> Option<String> {
    let tokens = split_command(exec);
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "env" {
            index += 1;
            while index < tokens.len() && tokens[index].contains('=') {
                index += 1;
            }
            continue;
        }
        if !token.contains('/') && token.contains('=') {
            index += 1;
            continue;
        }
        break;
    }
    tokens.get(index).cloned()
}

fn flatpak_app_id(exec: &str) -> Option<String> {
    let tokens = split_command(exec);
    let pos = tokens.iter().position(|token| {
        Path::new(token).file_name().and_then(|name| name.to_str()) == Some("flatpak")
    })?;
    let run = tokens[pos + 1..].iter().position(|token| token == "run")? + pos + 1;
    tokens[run + 1..]
        .iter()
        .find(|token| !token.starts_with('-') && !token.contains('='))
        .cloned()
}

fn snap_package(exec: &str, desktop_stem: &str) -> String {
    let tokens = split_command(exec);
    if let Some(pos) = tokens.iter().position(|token| {
        Path::new(token).file_name().and_then(|name| name.to_str()) == Some("snap")
    }) {
        if tokens.get(pos + 1).map(String::as_str) == Some("run") {
            if let Some(package) = tokens.get(pos + 2) {
                return package.clone();
            }
        }
    }
    for token in &tokens {
        if let Some(rest) = token.strip_prefix("/snap/bin/") {
            return rest.split('/').next().unwrap_or(rest).to_string();
        }
    }
    desktop_stem
        .split('_')
        .next()
        .unwrap_or(desktop_stem)
        .to_string()
}

fn resolve_exec(program: &str) -> Option<PathBuf> {
    if program.is_empty() {
        return None;
    }
    let path = Path::new(program);
    if path.is_absolute() {
        return Some(path.to_path_buf());
    }
    let search = std::env::var_os("PATH")?;
    std::env::split_paths(&search)
        .map(|dir| dir.join(program))
        .find(|candidate| candidate.is_file())
}

fn desktop_visible(entry: &DesktopEntry) -> bool {
    let current: Vec<String> = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .map(|part| part.trim().to_lowercase())
        .filter(|part| !part.is_empty())
        .collect();
    if current.is_empty() {
        return true;
    }
    if !entry.only_show_in.is_empty()
        && !entry
            .only_show_in
            .iter()
            .any(|desktop| current.contains(desktop))
    {
        return false;
    }
    !entry
        .not_show_in
        .iter()
        .any(|desktop| current.contains(desktop))
}

// ── Linux icon index ────────────────────────────────────────────────────────

fn linux_icon_search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/icons"));
        dirs.push(home.join(".icons"));
        dirs.push(home.join(".local/share/flatpak/exports/share/icons"));
        dirs.push(home.join(".local/share/pixmaps"));
    }
    dirs.push(PathBuf::from("/usr/local/share/icons"));
    dirs.push(PathBuf::from("/usr/local/share/pixmaps"));
    dirs.push(PathBuf::from("/usr/share/icons"));
    dirs.push(PathBuf::from("/usr/share/pixmaps"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/icons"));
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/icons"));
    if let Ok(data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for dir in data_dirs.split(':').filter(|dir| !dir.is_empty()) {
            dirs.push(PathBuf::from(dir).join("icons"));
            dirs.push(PathBuf::from(dir).join("pixmaps"));
        }
    }
    let mut seen = HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()) && dir.is_dir());
    dirs
}

fn icon_pixel_size(path: &Path) -> u32 {
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    let mut best = 0u32;
    let mut index = 0usize;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        let width = text[start..index].parse::<u32>().unwrap_or(0);
        if index < bytes.len() && (bytes[index] == b'x' || bytes[index] == b'X') {
            let height_start = index + 1;
            let mut height_end = height_start;
            while height_end < bytes.len() && bytes[height_end].is_ascii_digit() {
                height_end += 1;
            }
            if height_end > height_start {
                let height = text[height_start..height_end].parse::<u32>().unwrap_or(0);
                best = best.max(width.min(height));
                index = height_end;
            }
        }
    }
    best
}

fn icon_score(path: &Path) -> u32 {
    let lower = path.to_string_lossy().to_lowercase();
    let scalable = lower.contains("/scalable/") || lower.ends_with(".svg");
    if scalable {
        return 4096;
    }
    icon_pixel_size(path).max(1)
}

fn icon_aliases(stem: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    if let Some((_, last)) = stem.rsplit_once('.') {
        aliases.push(last.to_string());
    }
    if let Some((first, _)) = stem.split_once('_') {
        aliases.push(first.to_string());
    }
    if let Some(rest) = stem.strip_prefix("snap.") {
        aliases.push(rest.to_string());
        if let Some((_, last)) = rest.rsplit_once('.') {
            aliases.push(last.to_string());
        }
    }
    aliases
}

/// Index every icon file under `dirs` by file stem, keeping the highest
/// resolution variant. Alias entries cover snap/flatpak naming schemes.
fn build_icon_index_from(dirs: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut index: HashMap<String, (u32, PathBuf)> = HashMap::new();
    let mut insert = |name: &str, score: u32, path: &Path| {
        let key = name.trim().to_lowercase();
        if key.is_empty() {
            return;
        }
        if index.get(&key).is_none_or(|(current, _)| score > *current) {
            index.insert(key, (score, path.to_path_buf()));
        }
    };
    for dir in dirs {
        for entry in walkdir::WalkDir::new(dir)
            .max_depth(7)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.to_ascii_lowercase());
            if !matches!(
                extension.as_deref(),
                Some("png") | Some("svg") | Some("xpm")
            ) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let score = icon_score(path);
            insert(stem, score, path);
            for alias in icon_aliases(&stem.to_lowercase()) {
                insert(&alias, score, path);
            }
        }
    }
    index
        .into_iter()
        .map(|(name, (_, path))| (name, path))
        .collect()
}

fn linux_icon_index() -> &'static HashMap<String, PathBuf> {
    static INDEX: OnceLock<HashMap<String, PathBuf>> = OnceLock::new();
    INDEX.get_or_init(|| build_icon_index_from(&linux_icon_search_dirs()))
}

fn resolve_icon(candidates: &[String], index: &HashMap<String, PathBuf>) -> String {
    for candidate in candidates {
        if candidate.is_empty() {
            continue;
        }
        let path = Path::new(candidate);
        if path.is_absolute() && path.is_file() {
            return candidate.clone();
        }
        if candidate.contains('/') {
            continue;
        }
        if let Some(found) = index.get(&candidate.to_lowercase()) {
            return found.to_string_lossy().into_owned();
        }
    }
    String::new()
}

// ── Linux package ownership / sizes / versions ──────────────────────────────

fn native_source() -> Option<&'static str> {
    if command_exists("dpkg") || command_exists("apt-get") {
        Some("apt")
    } else if command_exists("dnf") {
        Some("dnf")
    } else if command_exists("zypper") {
        Some("zypper")
    } else if command_exists("pacman") {
        Some("pacman")
    } else if command_exists("rpm") {
        Some("rpm")
    } else {
        None
    }
}

fn rpm_owner(path: &str) -> Option<String> {
    let (ok, out, _) = run_capture("rpm", &["-qf", "--queryformat", "%{NAME}", path])?;
    let name = out.trim();
    if ok && !name.is_empty() && !name.contains('/') && !name.contains(' ') {
        Some(name.to_string())
    } else {
        None
    }
}

fn pacman_owner(path: &str) -> Option<String> {
    let (_, out, _) = run_capture("pacman", &["-Qo", path])?;
    let (_, rest) = out.split_once(" is owned by ")?;
    rest.split_whitespace().next().map(str::to_string)
}

/// Map executable paths to the native package that owns them. Debian-family
/// systems answer in one `dpkg -S` call; rpm/pacman are queried in parallel.
fn native_owners(paths: &[String]) -> HashMap<String, String> {
    let mut owners = HashMap::new();
    if paths.is_empty() {
        return owners;
    }
    if command_exists("dpkg") {
        for chunk in paths.chunks(200) {
            let mut args: Vec<&str> = vec!["-S"];
            args.extend(chunk.iter().map(String::as_str));
            // dpkg exits non-zero when some files are unowned but still prints
            // the matches it found, so the exit status is ignored on purpose.
            if let Some((_, out, _)) = run_capture("dpkg", &args) {
                for line in out.lines() {
                    let Some((packages, path)) = line.split_once(": ") else {
                        continue;
                    };
                    let package = packages.split(',').next().unwrap_or("").trim();
                    if !package.is_empty() && !package.contains(' ') {
                        owners
                            .entry(path.trim().to_string())
                            .or_insert_with(|| package.to_string());
                    }
                }
            }
        }
    } else if command_exists("rpm") {
        let results: Vec<(String, Option<String>)> = paths
            .par_iter()
            .map(|path| (path.clone(), rpm_owner(path)))
            .collect();
        for (path, owner) in results {
            if let Some(owner) = owner {
                owners.insert(path, owner);
            }
        }
    } else if command_exists("pacman") {
        let results: Vec<(String, Option<String>)> = paths
            .par_iter()
            .map(|path| (path.clone(), pacman_owner(path)))
            .collect();
        for (path, owner) in results {
            if let Some(owner) = owner {
                owners.insert(path, owner);
            }
        }
    }
    owners
}

/// Installed package name → (size in bytes, version).
fn native_package_meta() -> HashMap<String, (u64, String)> {
    let mut meta = HashMap::new();
    if command_exists("dpkg-query") {
        if let Some((true, out, _)) = run_capture(
            "dpkg-query",
            &["-W", "-f=${Package}\t${Installed-Size}\t${Version}\n"],
        ) {
            for line in out.lines() {
                let mut fields = line.split('\t');
                let (Some(package), Some(size_kb), Some(version)) =
                    (fields.next(), fields.next(), fields.next())
                else {
                    continue;
                };
                let size = size_kb
                    .trim()
                    .parse::<u64>()
                    .unwrap_or(0)
                    .saturating_mul(1024);
                meta.insert(package.to_string(), (size, version.trim().to_string()));
            }
        }
    } else if command_exists("rpm") {
        if let Some((true, out, _)) = run_capture(
            "rpm",
            &["-qa", "--queryformat", "%{NAME}\t%{SIZE}\t%{VERSION}\n"],
        ) {
            for line in out.lines() {
                let mut fields = line.split('\t');
                let (Some(package), Some(size), Some(version)) =
                    (fields.next(), fields.next(), fields.next())
                else {
                    continue;
                };
                meta.insert(
                    package.to_string(),
                    (
                        size.trim().parse::<u64>().unwrap_or(0),
                        version.trim().to_string(),
                    ),
                );
            }
        }
    } else if command_exists("pacman") {
        if let Some((true, out, _)) = run_capture("pacman", &["-Qi"]) {
            let mut name = String::new();
            let mut version = String::new();
            let mut size = 0u64;
            for line in out.lines() {
                let Some((key, value)) = line.split_once(':') else {
                    continue;
                };
                match key.trim() {
                    "Name" => {
                        if !name.is_empty() {
                            meta.insert(
                                std::mem::take(&mut name),
                                (size, std::mem::take(&mut version)),
                            );
                            size = 0;
                        }
                        name = value.trim().to_string();
                    }
                    "Version" => version = value.trim().to_string(),
                    "Installed Size" => size = parse_size(value),
                    _ => {}
                }
            }
            if !name.is_empty() {
                meta.insert(name, (size, version));
            }
        }
    }
    meta
}

fn flatpak_versions() -> HashMap<String, String> {
    let mut versions = HashMap::new();
    if let Some((true, out, _)) = run_capture(
        "flatpak",
        &["list", "--app", "--columns=application,version"],
    ) {
        for line in out.lines() {
            let line = line.trim_end();
            if line.trim().is_empty() {
                continue;
            }
            match line.split_once('\t') {
                Some((id, version)) => {
                    versions.insert(id.trim().to_string(), version.trim().to_string());
                }
                None => {
                    versions.insert(line.trim().to_string(), String::new());
                }
            }
        }
    }
    versions
}

fn flatpak_size(id: &str) -> u64 {
    run_capture("flatpak", &["info", "--show-size", id])
        .map(|(ok, out, _)| if ok { parse_size(out.trim()) } else { 0 })
        .unwrap_or(0)
}

fn snap_versions() -> HashMap<String, String> {
    let mut versions = HashMap::new();
    if let Some((true, out, _)) = run_capture("snap", &["list"]) {
        for (index, line) in out.lines().enumerate() {
            if index == 0 || line.trim().is_empty() || line.starts_with('-') {
                continue;
            }
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 2 {
                versions.insert(fields[0].to_string(), fields[1].to_string());
            }
        }
    }
    versions
}

fn snap_size(package: &str) -> u64 {
    let link = Path::new("/snap").join(package).join("current");
    let resolved = std::fs::canonicalize(&link).unwrap_or(link);
    dir_size(&resolved)
}

// ── Linux app inventory ─────────────────────────────────────────────────────

#[derive(Clone, Copy)]
enum DesktopKind {
    Native,
    Flatpak,
    Snap,
}

struct DesktopSource {
    dir: PathBuf,
    priority: i32,
    kind: DesktopKind,
}

struct LinuxApp {
    name: String,
    version: String,
    exec_path: Option<PathBuf>,
    install_location: String,
    icon_candidates: Vec<String>,
    icon: String,
    package_id: String,
    package_source: String,
    size: u64,
    priority: i32,
}

fn linux_desktop_sources() -> Vec<DesktopSource> {
    let mut sources: Vec<DesktopSource> = Vec::new();
    let mut add = |dir: PathBuf, priority: i32, kind: DesktopKind| {
        if dir.is_dir() {
            sources.push(DesktopSource {
                dir,
                priority,
                kind,
            });
        }
    };
    if let Some(home) = dirs::home_dir() {
        add(
            home.join(".local/share/flatpak/exports/share/applications"),
            55,
            DesktopKind::Flatpak,
        );
        add(
            home.join(".local/share/applications"),
            60,
            DesktopKind::Native,
        );
    }
    if let Ok(data_home) = std::env::var("XDG_DATA_HOME") {
        if !data_home.is_empty() {
            add(
                PathBuf::from(data_home).join("applications"),
                58,
                DesktopKind::Native,
            );
        }
    }
    add(
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        45,
        DesktopKind::Flatpak,
    );
    add(
        PathBuf::from("/var/lib/snapd/desktop/applications"),
        40,
        DesktopKind::Snap,
    );
    add(
        PathBuf::from("/usr/local/share/applications"),
        30,
        DesktopKind::Native,
    );
    add(
        PathBuf::from("/usr/share/applications"),
        20,
        DesktopKind::Native,
    );
    if let Ok(data_dirs) = std::env::var("XDG_DATA_DIRS") {
        for dir in data_dirs.split(':').filter(|dir| !dir.is_empty()) {
            if dir != "/usr/share" && dir != "/usr/local/share" {
                add(
                    PathBuf::from(dir).join("applications"),
                    25,
                    DesktopKind::Native,
                );
            }
        }
    }
    let mut seen = HashSet::new();
    sources.retain(|source| seen.insert(source.dir.clone()));
    sources
}

fn linux_apps() -> Vec<LinuxApp> {
    let mut apps: Vec<LinuxApp> = Vec::new();
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for source in linux_desktop_sources() {
        let Ok(entries) = std::fs::read_dir(&source.dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            let desktop = parse_desktop_entry(&content);
            if desktop.name.is_empty()
                || desktop.no_display
                || desktop.hidden
                || (!desktop.app_type.is_empty()
                    && !desktop.app_type.eq_ignore_ascii_case("application"))
                || !desktop_visible(&desktop)
            {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("")
                .to_string();
            let program = exec_program(&desktop.exec).unwrap_or_default();
            let exec_path = resolve_exec(&program);

            let (package_id, package_source, install_location) = match source.kind {
                DesktopKind::Flatpak => {
                    let id = if !desktop.flatpak_id.is_empty() {
                        desktop.flatpak_id.clone()
                    } else if let Some(id) = flatpak_app_id(&desktop.exec) {
                        id
                    } else {
                        stem.clone()
                    };
                    (
                        id,
                        "flatpak".to_string(),
                        path.to_string_lossy().into_owned(),
                    )
                }
                DesktopKind::Snap => (
                    snap_package(&desktop.exec, &stem),
                    "snap".to_string(),
                    path.to_string_lossy().into_owned(),
                ),
                DesktopKind::Native => (
                    String::new(),
                    String::new(),
                    exec_path
                        .as_ref()
                        .map(|exe| exe.to_string_lossy().into_owned())
                        .unwrap_or_else(|| program.clone()),
                ),
            };

            let mut icon_candidates = vec![desktop.icon.clone(), stem.clone()];
            if !package_id.is_empty() {
                icon_candidates.push(package_id.clone());
            }
            let simple_name = desktop.name.to_lowercase().replace(' ', "-");
            icon_candidates.push(simple_name);

            let app = LinuxApp {
                name: desktop.name,
                version: String::new(),
                exec_path,
                install_location,
                icon_candidates,
                icon: String::new(),
                package_id,
                package_source,
                size: 0,
                priority: source.priority,
            };

            let key = app.name.to_lowercase();
            match by_name.get(&key) {
                Some(&existing) if apps[existing].priority > app.priority => {}
                Some(&existing) => {
                    // Prefer a later, higher-priority copy (user override,
                    // flatpak export, …) over the system-wide entry.
                    apps[existing] = app;
                }
                None => {
                    by_name.insert(key, apps.len());
                    apps.push(app);
                }
            }
        }
    }
    apps
}

fn annotate_native_packages(apps: &mut [LinuxApp]) {
    let mut candidate_paths: Vec<String> = Vec::new();
    for app in apps.iter() {
        if !app.package_source.is_empty() {
            continue;
        }
        if let Some(path) = &app.exec_path {
            let raw = path.to_string_lossy().into_owned();
            candidate_paths.push(raw.clone());
            if let Ok(canonical) = std::fs::canonicalize(path) {
                let canonical = canonical.to_string_lossy().into_owned();
                if canonical != raw {
                    candidate_paths.push(canonical);
                }
            }
        }
    }
    candidate_paths.sort();
    candidate_paths.dedup();

    let owners = native_owners(&candidate_paths);
    let meta = native_package_meta();
    let source = native_source().unwrap_or("");

    for app in apps.iter_mut() {
        if app.package_source.is_empty() {
            if let Some(path) = &app.exec_path {
                let raw = path.to_string_lossy().into_owned();
                let canonical = std::fs::canonicalize(path)
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned());
                let package = owners
                    .get(&raw)
                    .or_else(|| canonical.as_ref().and_then(|path| owners.get(path)));
                if let Some(package) = package {
                    app.package_id = package.clone();
                    app.package_source = source.to_string();
                    if let Some((size, version)) = meta.get(package) {
                        app.size = *size;
                        app.version = version.clone();
                    }
                }
            }
            if app.size == 0 {
                app.size = app
                    .exec_path
                    .as_ref()
                    .and_then(|path| std::fs::metadata(path).ok())
                    .map(|meta| meta.len())
                    .unwrap_or(0);
            }
        }
    }
}

pub(crate) fn list_linux_apps() -> Result<Vec<Value>, String> {
    let mut apps = linux_apps();
    annotate_native_packages(&mut apps);

    let flatpak_versions = flatpak_versions();
    let snap_versions = snap_versions();
    for app in apps.iter_mut() {
        match app.package_source.as_str() {
            "flatpak" => {
                if let Some(version) = flatpak_versions.get(&app.package_id) {
                    app.version = version.clone();
                }
                if app.size == 0 {
                    app.size = flatpak_size(&app.package_id);
                }
            }
            "snap" => {
                if let Some(version) = snap_versions.get(&app.package_id) {
                    app.version = version.clone();
                }
                if app.size == 0 {
                    app.size = snap_size(&app.package_id);
                }
            }
            _ => {}
        }
    }

    let index = linux_icon_index();
    for app in apps.iter_mut() {
        app.icon = resolve_icon(&app.icon_candidates, index);
    }

    apps.sort_by_key(|a| a.name.to_lowercase());
    Ok(apps
        .into_iter()
        .map(|app| {
            json!({
                "name": app.name,
                "version": app.version,
                "publisher": "",
                "install_location": app.install_location,
                "uninstall_string": "",
                "quiet_uninstall": "",
                "icon_path": app.icon,
                "install_size": app.size,
                "install_date": "",
                "estimated_size_kb": app.size / 1024,
                "package_id": app.package_id,
                "package_source": app.package_source,
            })
        })
        .collect())
}

// ── macOS inventory ─────────────────────────────────────────────────────────

fn mac_app_dirs() -> Vec<(i32, PathBuf)> {
    let mut paths: Vec<(i32, PathBuf)> = vec![
        (10, PathBuf::from("/System/Applications")),
        (11, PathBuf::from("/System/Applications/Utilities")),
        (20, PathBuf::from("/Applications")),
        (21, PathBuf::from("/Applications/Utilities")),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.push((40, home.join("Applications")));
    }
    paths
}

/// Collect `.app` bundles below `dir`, including vendor folders such as
/// `/Applications/Adobe …/Photoshop.app`. Bundles themselves are never
/// descended into, so helper apps nested inside another bundle are ignored.
fn collect_mac_app_paths(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_bundle = path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"));
        if is_bundle {
            // Follows symlinks, so /Applications links to /System apps count.
            if path.is_dir() {
                out.push(path);
            }
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // Don't follow directory symlinks; they can form cycles.
        if file_type.is_dir() {
            collect_mac_app_paths(&path, depth - 1, out);
        }
    }
}

/// Information read from an app bundle's `Contents/Info.plist`.
#[derive(Clone, Debug, Default)]
struct MacBundleInfo {
    version: String,
    build_version: String,
    bundle_id: String,
    icon: Option<String>,
    feed_url: String,
    public_ed_key: String,
    app_store: bool,
}

impl MacBundleInfo {
    /// The update channel the app itself exposes. App Store apps update through
    /// the App Store; direct apps use their own Sparkle appcast. Anything else is
    /// deliberately treated as "no native update channel" instead of falling
    /// back to a package manager.
    fn native_update_source(&self) -> &'static str {
        if self.app_store {
            "appstore"
        } else if self.feed_url.trim().to_ascii_lowercase().starts_with("https://")
            && !self.public_ed_key.trim().is_empty()
        {
            "sparkle"
        } else {
            ""
        }
    }
}

/// Read version, bundle id, icon and native update information from
/// `Contents/Info.plist`. Uses the `plist` crate so binary plists (the default
/// for most built bundles) work.
fn mac_bundle_info(app: &Path) -> MacBundleInfo {
    let app_store = app.join("Contents/_MASReceipt/receipt").is_file();
    let plist_path = app.join("Contents/Info.plist");
    let Ok(value) = plist::Value::from_file(&plist_path) else {
        return MacBundleInfo {
            app_store,
            ..MacBundleInfo::default()
        };
    };
    let Some(dictionary) = value.as_dictionary() else {
        return MacBundleInfo {
            app_store,
            ..MacBundleInfo::default()
        };
    };
    let get = |key: &str| {
        dictionary
            .get(key)
            .and_then(|value| value.as_string())
            .map(str::to_string)
    };
    let build_version = get("CFBundleVersion").unwrap_or_default();
    let version = get("CFBundleShortVersionString")
        .filter(|version| !version.is_empty())
        .or_else(|| {
            if build_version.is_empty() {
                None
            } else {
                Some(build_version.clone())
            }
        })
        .unwrap_or_default();
    let bundle_id = get("CFBundleIdentifier").unwrap_or_default();
    let icon = get("CFBundleIconFile").or_else(|| get("CFBundleIconName"));
    MacBundleInfo {
        version,
        build_version,
        bundle_id,
        icon,
        feed_url: get("SUFeedURL").unwrap_or_default(),
        public_ed_key: get("SUPublicEDKey").unwrap_or_default(),
        app_store,
    }
}

fn mac_bundle_icon(app: &Path, icon: Option<&str>) -> String {
    let resources = app.join("Contents/Resources");
    if let Some(icon) = icon {
        let mut candidates = vec![resources.join(icon)];
        if !icon.to_ascii_lowercase().ends_with(".icns") {
            candidates.push(resources.join(format!("{icon}.icns")));
        }
        for candidate in candidates {
            if candidate.is_file() {
                return candidate.to_string_lossy().into_owned();
            }
        }
    }
    // Fall back to the largest .icns in the bundle.
    let mut best: Option<(u64, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(&resources) {
        for entry in entries.flatten() {
            let path = entry.path();
            let is_icns = path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("icns"))
                .unwrap_or(false);
            if !is_icns {
                continue;
            }
            let len = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if best.as_ref().is_none_or(|(current, _)| len > *current) {
                best = Some((len, path));
            }
        }
    }
    best.map(|(_, path)| path.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn list_macos_apps() -> Result<Vec<Value>, String> {
    let mut chosen: HashMap<String, (i32, Value)> = HashMap::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    for (priority, dir) in mac_app_dirs() {
        let mut candidates = Vec::new();
        collect_mac_app_paths(&dir, 3, &mut candidates);
        for path in candidates {
            let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen_paths.insert(identity) {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let info = mac_bundle_info(&path);
            let icon_path = mac_bundle_icon(&path, info.icon.as_deref());
            // A few entries in /Applications are symlinks into /System; size the
            // target, not the link (dir_size uses symlink_metadata).
            let size_path = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let install_size = dir_size(&size_path);
            let install_date = std::fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .map(|time| {
                    chrono::DateTime::<chrono::Local>::from(time)
                        .format("%Y-%m-%d")
                        .to_string()
                })
                .unwrap_or_default();

            let app = json!({
                "name": name,
                "version": info.version,
                "publisher": info.bundle_id,
                "install_location": path.to_string_lossy(),
                "uninstall_string": "",
                "quiet_uninstall": "",
                "icon_path": icon_path,
                "install_size": install_size,
                "install_date": install_date,
                "estimated_size_kb": install_size / 1024,
                "package_id": info.bundle_id,
                "package_source": info.native_update_source(),
            });

            let key = if info.bundle_id.is_empty() {
                format!("name:{}", name.to_lowercase())
            } else {
                format!("id:{}", info.bundle_id.to_lowercase())
            };
            match chosen.get(&key) {
                Some((current, _)) if *current > priority => {}
                _ => {
                    chosen.insert(key, (priority, app));
                }
            }
        }
    }
    let mut apps: Vec<Value> = chosen.into_values().map(|(_, app)| app).collect();
    apps.sort_by(|a, b| {
        let left = a["name"].as_str().unwrap_or("").to_lowercase();
        let right = b["name"].as_str().unwrap_or("").to_lowercase();
        left.cmp(&right)
    });
    Ok(apps)
}

/// A bundle that exposes a native update channel. Sizes and icons are not
/// needed here, so the update check stays fast even with hundreds of apps.
#[derive(Clone, Debug)]
struct MacUpdateCandidate {
    name: String,
    version: String,
    build_version: String,
    bundle_id: String,
    feed_url: String,
    app_store: bool,
}

fn mac_update_candidates() -> Vec<MacUpdateCandidate> {
    let mut chosen: HashMap<String, (i32, MacUpdateCandidate)> = HashMap::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    for (priority, dir) in mac_app_dirs() {
        let mut paths = Vec::new();
        collect_mac_app_paths(&dir, 3, &mut paths);
        for path in paths {
            let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen_paths.insert(identity.clone()) {
                continue;
            }
            // Apple updates system apps through macOS itself, not the App
            // Store page or an appcast.
            if identity.starts_with("/System") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let info = mac_bundle_info(&path);
            if info.bundle_id.is_empty() || info.native_update_source().is_empty() {
                continue;
            }
            let candidate = MacUpdateCandidate {
                name: name.to_string(),
                version: info.version,
                build_version: info.build_version,
                bundle_id: info.bundle_id.clone(),
                feed_url: info.feed_url,
                app_store: info.app_store,
            };
            let key = info.bundle_id.to_lowercase();
            match chosen.get(&key) {
                Some((current, _)) if *current > priority => {}
                _ => {
                    chosen.insert(key, (priority, candidate));
                }
            }
        }
    }
    chosen.into_values().map(|(_, app)| app).collect()
}

// ── macOS icons ─────────────────────────────────────────────────────────────

/// Prefer an icon between 64 and 256 px: crisp on screen without turning a
/// single 1024 px ICNS payload into a multi-megabyte IPC response. If the
/// bundle only has tiny or huge variants, pick the closest usable one.
fn icon_width_rank(width: u32) -> (u8, u32) {
    if (64..=256).contains(&width) {
        (2, width)
    } else if width < 64 {
        (1, width)
    } else {
        (0, u32::MAX - width)
    }
}

/// Extract a moderately sized PNG-encoded icon from an `.icns` container.
/// Modern macOS bundles embed PNG payloads (ic07…ic14); older formats fall
/// back to `sips` on the caller side.
fn icns_png(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 8 || &bytes[..4] != b"icns" {
        return None;
    }
    let declared = u32::from_be_bytes(bytes[4..8].try_into().ok()?) as usize;
    let end = declared.min(bytes.len());
    let mut position = 8usize;
    let mut best: Option<((u8, u32), Vec<u8>)> = None;
    while position.saturating_add(8) <= end {
        let length =
            u32::from_be_bytes(bytes[position + 4..position + 8].try_into().ok()?) as usize;
        if length < 8 || position.saturating_add(length) > end {
            break;
        }
        let payload = &bytes[position + 8..position + length];
        if payload.len() >= 24 && &payload[..8] == b"\x89PNG\r\n\x1a\n" {
            let width = u32::from_be_bytes(payload[16..20].try_into().ok()?);
            let rank = icon_width_rank(width);
            if best.as_ref().is_none_or(|(current, _)| rank > *current) {
                best = Some((rank, payload.to_vec()));
            }
        }
        position += length;
    }
    best.map(|(_, data)| data)
}

fn icns_via_sips(path: &Path) -> Option<Vec<u8>> {
    if in_mac_sandbox() {
        return None;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    let output = std::env::temp_dir().join(format!(
        "diskraptor-icon-{}-{stamp}.png",
        std::process::id()
    ));
    let status = Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg(path)
        .arg("--out")
        .arg(&output)
        .status()
        .ok()?;
    if !status.success() {
        let _ = std::fs::remove_file(&output);
        return None;
    }
    let bytes = std::fs::read(&output).ok();
    let _ = std::fs::remove_file(&output);
    bytes
}

fn file_data_url(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    let bytes = std::fs::read(path).ok()?;
    let (mime, data) = match extension.as_str() {
        "icns" => (
            "image/png",
            icns_png(&bytes).or_else(|| icns_via_sips(path))?,
        ),
        "png" => ("image/png", bytes),
        "svg" => ("image/svg+xml", bytes),
        "jpg" | "jpeg" => ("image/jpeg", bytes),
        "webp" => ("image/webp", bytes),
        _ => return None,
    };
    Some(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(data)
    ))
}

/// Return a data URL for an app icon. `path` may be an icon file, an `.app`
/// bundle (macOS) or a bare icon name (Linux).
pub(crate) fn icon_data_url(path: &str) -> Option<String> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let candidate = Path::new(path);
    if candidate.is_dir() {
        let icon = mac_bundle_icon(candidate, None);
        if icon.is_empty() {
            return None;
        }
        return file_data_url(Path::new(&icon));
    }
    if candidate.is_file() {
        return file_data_url(candidate);
    }
    #[cfg(target_os = "linux")]
    {
        linux_icon_index()
            .get(&path.to_lowercase())
            .and_then(|found| file_data_url(found))
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

// ── Update discovery ────────────────────────────────────────────────────────

fn http_agent(timeout_secs: u64) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout_secs)))
        .build();
    ureq::Agent::new_with_config(config)
}

fn http_get_text(url: &str, timeout_secs: u64) -> Result<String, String> {
    let agent = http_agent(timeout_secs);
    let mut response = agent
        .get(url)
        .header("User-Agent", concat!("DiskRaptor/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|error| format!("Request failed for {url}: {error}"))?;
    response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("Could not read response from {url}: {error}"))
}

fn http_get_json(url: &str, timeout_secs: u64) -> Result<Value, String> {
    let text = http_get_text(url, timeout_secs)?;
    serde_json::from_str(&text)
        .map_err(|error| format!("Invalid response from {url}: {error}"))
}

fn http_download(url: &str, destination: &Path) -> Result<(), String> {
    let agent = http_agent(600);
    let mut response = agent
        .get(url)
        .header("User-Agent", concat!("DiskRaptor/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|error| format!("Download failed for {url}: {error}"))?;
    let mut reader = response.body_mut().as_reader();
    let mut file = std::fs::File::create(destination)
        .map_err(|error| format!("Could not create {}: {error}", destination.display()))?;
    let copied = std::io::copy(&mut reader, &mut file)
        .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
    if copied == 0 {
        return Err("The downloaded update is empty".to_string());
    }
    Ok(())
}

fn numeric_version_parts(version: &str) -> Vec<u64> {
    version
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

/// Compare dotted versions numerically. Text suffixes such as `1.2.3-beta`
/// are ignored for ordering, and missing components count as zero.
fn version_is_newer(available: &str, installed: &str) -> bool {
    let available = available.trim();
    let installed = installed.trim();
    if available.is_empty() || installed.is_empty() {
        return false;
    }
    let next = numeric_version_parts(available);
    let current = numeric_version_parts(installed);
    if next.is_empty() || current.is_empty() {
        return available != installed;
    }
    for index in 0..next.len().max(current.len()) {
        let left = next.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SparkleRelease {
    version: String,
    version_is_build: bool,
    build_version: Option<String>,
    enclosure_url: String,
    ed_signature: Option<String>,
}

fn sparkle_release_is_newer(release: &SparkleRelease, version: &str, build: &str) -> bool {
    if release.version_is_build {
        return version_is_newer(&release.version, build);
    }
    version_is_newer(&release.version, version)
        || release
            .build_version
            .as_deref()
            .is_some_and(|candidate| version_is_newer(candidate, build))
}

fn xml_local_name(name: &str) -> &str {
    name.rsplit(':').next().unwrap_or(name)
}

fn enclosure_attributes(event: &BytesStart, url: &mut String, signature: &mut Option<String>) {
    for attribute in event.attributes().flatten() {
        let key = xml_local_name(attribute.key.as_ref());
        let Ok(value) = attribute.normalized_value(XmlVersion::Implicit1_0) else {
            continue;
        };
        match key {
            "url" => *url = value.into_owned(),
            "edSignature" => *signature = Some(value.into_owned()),
            _ => {}
        }
    }
}

/// Atom feeds use `<link rel="enclosure" href="...">` instead of Sparkle's
/// `<enclosure>` element. Supporting both keeps older feeds working.
fn atom_enclosure(event: &BytesStart, url: &mut String) {
    let mut relation = String::new();
    let mut href = String::new();
    for attribute in event.attributes().flatten() {
        let key = xml_local_name(attribute.key.as_ref());
        let Ok(value) = attribute.normalized_value(XmlVersion::Implicit1_0) else {
            continue;
        };
        match key {
            "rel" => relation = value.into_owned(),
            "href" => href = value.into_owned(),
            _ => {}
        }
    }
    if relation == "enclosure" && !href.is_empty() {
        *url = href;
    }
}

/// Parse a Sparkle appcast and return the newest release. Sparkle uses RSS
/// `<item>` elements with `sparkle:shortVersionString` and an `<enclosure>`;
/// some feeds use Atom `<entry>`/`<link>` instead.
fn parse_sparkle_appcast(xml: &str) -> Option<SparkleRelease> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut in_item = false;
    let mut short_version = String::new();
    let mut build_version = String::new();
    let mut channel = String::new();
    let mut enclosure_url = String::new();
    let mut ed_signature: Option<String> = None;
    let mut text_target: Option<String> = None;
    let mut text = String::new();
    let mut best: Option<SparkleRelease> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let local = xml_local_name(event.name().as_ref()).to_string();
                if local == "item" || local == "entry" {
                    in_item = true;
                    short_version.clear();
                    build_version.clear();
                    channel.clear();
                    enclosure_url.clear();
                    ed_signature = None;
                    text_target = None;
                    text.clear();
                } else if in_item
                    && (local == "shortVersionString" || local == "version" || local == "channel")
                {
                    text_target = Some(local);
                    text.clear();
                } else if in_item && local == "enclosure" {
                    enclosure_attributes(&event, &mut enclosure_url, &mut ed_signature);
                } else if in_item && local == "link" {
                    atom_enclosure(&event, &mut enclosure_url);
                }
            }
            Ok(Event::Empty(event)) => {
                let local = xml_local_name(event.name().as_ref()).to_string();
                if in_item && local == "enclosure" {
                    enclosure_attributes(&event, &mut enclosure_url, &mut ed_signature);
                } else if in_item && local == "link" {
                    atom_enclosure(&event, &mut enclosure_url);
                }
            }
            Ok(Event::Text(event)) => {
                if text_target.is_some() {
                    text.push_str(event.as_ref());
                }
            }
            Ok(Event::CData(event)) => {
                if text_target.is_some() {
                    text.push_str(event.as_ref());
                }
            }
            Ok(Event::End(event)) => {
                let local = xml_local_name(event.name().as_ref()).to_string();
                if in_item {
                    if let Some(target) = text_target.take() {
                        let value = text.trim().to_string();
                        match target.as_str() {
                            "shortVersionString" => short_version = value,
                            "channel" => channel = value,
                            _ => build_version = value,
                        }
                        text.clear();
                    }
                    if local == "item" || local == "entry" {
                        let (version, version_is_build) =
                            if short_version.trim().is_empty() {
                                (build_version.trim().to_string(), true)
                            } else {
                                (short_version.trim().to_string(), false)
                            };
                        let release_build_version = if build_version.trim().is_empty() {
                            None
                        } else {
                            Some(build_version.trim().to_string())
                        };
                        // Channels are optional. Only empty/stable releases are
                        // installed automatically; beta and nightly feeds stay
                        // opt-in through the app itself.
                        let stable_channel = {
                            let channel = channel.trim().to_ascii_lowercase();
                            channel.is_empty()
                                || matches!(
                                    channel.as_str(),
                                    "stable" | "release" | "production"
                                )
                        };
                        if stable_channel
                            && !version.is_empty()
                            && !enclosure_url.trim().is_empty()
                        {
                            let signature = ed_signature
                                .take()
                                .map(|signature| signature.trim().to_string())
                                .filter(|signature| !signature.is_empty());
                            // Sparkle rejects unsigned updates, so never offer a
                            // release that cannot be verified after download.
                            if let Some(signature) = signature {
                                let release = SparkleRelease {
                                    version,
                                    version_is_build,
                                    build_version: release_build_version,
                                    enclosure_url: enclosure_url.trim().to_string(),
                                    ed_signature: Some(signature),
                                };
                                if best.as_ref().is_none_or(|current| {
                                    version_is_newer(&release.version, &current.version)
                                }) {
                                    best = Some(release);
                                }
                            }
                        }
                        in_item = false;
                        short_version.clear();
                        build_version.clear();
                        channel.clear();
                        enclosure_url.clear();
                        ed_signature = None;
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => return None,
            _ => {}
        }
    }
    best
}

fn safe_bundle_id(bundle_id: &str) -> bool {
    !bundle_id.is_empty()
        && bundle_id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
}

/// Ask Apple's public lookup API for the current App Store version. This uses
/// the native App Store catalogue rather than a command-line package manager;
/// installs are handed back to the App Store itself.
fn check_app_store_update(app: &MacUpdateCandidate) -> Result<Option<AppUpdate>, String> {
    if !safe_bundle_id(&app.bundle_id) {
        return Err("Invalid bundle identifier".to_string());
    }
    let url = format!(
        "https://itunes.apple.com/lookup?bundleId={}&entity=macSoftware",
        app.bundle_id
    );
    let value = http_get_json(&url, 10)?;
    let Some(item) = value
        .get("results")
        .and_then(Value::as_array)
        .and_then(|results| results.first())
    else {
        return Ok(None);
    };
    let available = item
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !version_is_newer(available, &app.version) {
        return Ok(None);
    }
    Ok(Some(AppUpdate {
        name: app.name.clone(),
        id: app.bundle_id.clone(),
        version: app.version.clone(),
        available: available.to_string(),
        source: "appstore".to_string(),
    }))
}

fn check_sparkle_update(app: &MacUpdateCandidate) -> Result<Option<AppUpdate>, String> {
    let xml = http_get_text(&app.feed_url, 10)?;
    let Some(release) = parse_sparkle_appcast(&xml) else {
        // A feed with only unsigned or prerelease entries is not actionable.
        return Ok(None);
    };
    if !sparkle_release_is_newer(&release, &app.version, &app.build_version) {
        return Ok(None);
    }
    Ok(Some(AppUpdate {
        name: app.name.clone(),
        id: app.bundle_id.clone(),
        version: app.version.clone(),
        available: release.version,
        source: "sparkle".to_string(),
    }))
}

fn parse_apt_upgradable(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with("Listing")
            || line.starts_with("WARNING")
            || line.starts_with("N:")
        {
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(name_field) = fields.next() else {
            continue;
        };
        let Some(available) = fields.next() else {
            continue;
        };
        // Localised "Listing…" headers and warnings do not contain a
        // package/component pair; real apt versions always start with a digit
        // (or an epoch such as `1:2.0`).
        if !name_field.contains('/')
            || !available
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        let Some(name) = name_field.split('/').next().filter(|name| !name.is_empty()) else {
            continue;
        };
        let installed = line
            .split("[upgradable from:")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        updates.push(AppUpdate {
            name: name.to_string(),
            id: name.to_string(),
            version: installed,
            available: available.to_string(),
            source: "apt".to_string(),
        });
    }
    updates
}

fn parse_dnf_check_update(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with("Obsoleting")
            || line.starts_with("Last metadata")
            || line.starts_with("Security:")
            || line.starts_with("Package")
        {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let Some((name, _arch)) = fields[0].rsplit_once('.') else {
            continue;
        };
        if name.is_empty()
            || !fields[1]
                .chars()
                .next()
                .is_some_and(|ch| ch.is_ascii_digit())
        {
            continue;
        }
        updates.push(AppUpdate {
            name: name.to_string(),
            id: name.to_string(),
            version: String::new(),
            available: fields[1].to_string(),
            source: "dnf".to_string(),
        });
    }
    updates
}

fn parse_pacman_qu(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 4 || fields[2] != "->" {
            continue;
        }
        updates.push(AppUpdate {
            name: fields[0].to_string(),
            id: fields[0].to_string(),
            version: fields[1].to_string(),
            available: fields[3].to_string(),
            source: "pacman".to_string(),
        });
    }
    updates
}

fn parse_zypper_updates(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty()
            || line.starts_with('S')
            || line.starts_with('+')
            || line.starts_with('-')
            || line.starts_with('V')
        {
            continue;
        }
        let fields: Vec<&str> = line.split('|').map(str::trim).collect();
        if fields.len() < 5 {
            continue;
        }
        let name = fields[2];
        let current = fields[3];
        let available = fields[4];
        if name.is_empty() || available.is_empty() {
            continue;
        }
        updates.push(AppUpdate {
            name: name.to_string(),
            id: name.to_string(),
            version: current.to_string(),
            available: available.to_string(),
            source: "zypper".to_string(),
        });
    }
    updates
}

fn parse_flatpak_updates(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let (id, available) = match line.split_once('\t') {
            Some((id, version)) => (id.trim(), version.trim()),
            None => (line.trim(), ""),
        };
        // Flatpak application ids are reverse-DNS; anything else is a warning
        // or progress line.
        if !id.contains('.') || id.contains(' ') {
            continue;
        }
        updates.push(AppUpdate {
            name: id.to_string(),
            id: id.to_string(),
            version: String::new(),
            available: available.to_string(),
            source: "flatpak".to_string(),
        });
    }
    updates
}

fn parse_snap_refresh(text: &str) -> Vec<AppUpdate> {
    let mut updates = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("Name") || line.starts_with('-') {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        // "All snaps up to date." and similar status lines are not table rows;
        // real rows always have a numeric revision in the third column.
        if fields[2].parse::<u64>().is_err() {
            continue;
        }
        updates.push(AppUpdate {
            name: fields[0].to_string(),
            id: fields[0].to_string(),
            version: String::new(),
            available: fields[1].to_string(),
            source: "snap".to_string(),
        });
    }
    updates
}

fn dedupe_updates(updates: &mut Vec<AppUpdate>) {
    let mut seen = HashSet::new();
    updates.retain(|update| seen.insert((update.source.clone(), update.id.clone())));
}

pub(crate) fn check_macos_updates() -> Value {
    if in_mac_sandbox() {
        return json!({
            "supported": false,
            "error": "App updates in the sandboxed Mac App Store build are handled by the App Store.",
            "updates": [],
        });
    }
    let candidates = mac_update_candidates();
    if candidates.is_empty() {
        return json!({
            "supported": false,
            "error": "No App Store or Sparkle-based applications were found.",
            "updates": [],
        });
    }

    // App Store lookups and appcast requests are independent; checking them in
    // parallel keeps the manager responsive on machines with many apps.
    let results: Vec<Result<Option<AppUpdate>, String>> = candidates
        .par_iter()
        .map(|app| {
            if app.app_store {
                check_app_store_update(app)
            } else {
                check_sparkle_update(app)
            }
        })
        .collect();

    let mut updates = Vec::new();
    let mut errors = Vec::new();
    let mut checked = 0usize;
    for result in results {
        match result {
            Ok(update) => {
                checked += 1;
                if let Some(update) = update {
                    updates.push(update);
                }
            }
            Err(error) => errors.push(error),
        }
    }

    if checked == 0 {
        return json!({
            "supported": false,
            "error": if errors.is_empty() {
                "Could not query any native update source.".to_string()
            } else {
                errors.join("; ")
            },
            "updates": [],
        });
    }
    dedupe_updates(&mut updates);
    json!({ "supported": true, "updates": updates_json(&updates) })
}

pub(crate) fn check_linux_updates() -> Value {
    let mut updates = Vec::new();
    let mut sources: Vec<&str> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    let native_checked = if command_exists("apt") {
        match run_capture("apt", &["list", "--upgradable"]) {
            Some((true, out, _)) => {
                updates.extend(parse_apt_upgradable(&out));
                sources.push("apt");
                true
            }
            Some((false, _, err)) => {
                errors.push(format!("apt: {}", first_error(&err)));
                true
            }
            None => false,
        }
    } else if command_exists("dnf") {
        // dnf exits 100 when updates are available, so the status is ignored.
        match run_capture("dnf", &["-q", "check-update"]) {
            Some((_, out, _)) => {
                updates.extend(parse_dnf_check_update(&out));
                sources.push("dnf");
                true
            }
            None => false,
        }
    } else if command_exists("zypper") {
        match run_capture("zypper", &["-q", "list-updates"]) {
            Some((_, out, _)) => {
                updates.extend(parse_zypper_updates(&out));
                sources.push("zypper");
                true
            }
            None => false,
        }
    } else if command_exists("pacman") {
        // pacman -Qu exits 1 when nothing is upgradable.
        match run_capture("pacman", &["-Qu"]) {
            Some((_, out, _)) => {
                updates.extend(parse_pacman_qu(&out));
                sources.push("pacman");
                true
            }
            None => false,
        }
    } else {
        false
    };
    if !native_checked {
        errors.push("No native package manager found (apt, dnf, zypper, pacman)".to_string());
    }

    if command_exists("flatpak") {
        if let Some((true, out, _)) = run_capture(
            "flatpak",
            &["remote-ls", "--updates", "--columns=application,version"],
        ) {
            updates.extend(parse_flatpak_updates(&out));
            sources.push("flatpak");
        } else {
            errors.push("Flatpak update check failed".to_string());
        }
    }
    if command_exists("snap") {
        if let Some((true, out, _)) = run_capture("snap", &["refresh", "--list"]) {
            updates.extend(parse_snap_refresh(&out));
            sources.push("snap");
        } else {
            errors.push("Snap update check failed".to_string());
        }
    }

    if sources.is_empty() {
        return json!({
            "supported": false,
            "error": if errors.is_empty() {
                "No supported package manager found (apt, dnf, zypper, pacman, flatpak, snap)."
                    .to_string()
            } else {
                errors.join("; ")
            },
            "updates": [],
        });
    }
    dedupe_updates(&mut updates);
    json!({ "supported": true, "updates": updates_json(&updates) })
}

// ── Applying updates ────────────────────────────────────────────────────────

fn run_elevated(program: &str, args: &[&str]) -> Option<(bool, String, String)> {
    // GUI processes cannot answer a sudo password prompt; prefer polkit and use
    // non-interactive sudo as a fallback for terminals/desktop sessions with
    // cached credentials.
    if command_exists("pkexec") {
        let mut all: Vec<&str> = Vec::with_capacity(args.len() + 1);
        all.push(program);
        all.extend_from_slice(args);
        if let Some(result) = run_capture("pkexec", &all) {
            return Some(result);
        }
    }
    if command_exists("sudo") {
        let mut all: Vec<&str> = Vec::with_capacity(args.len() + 2);
        all.push("-n");
        all.push(program);
        all.extend_from_slice(args);
        if let Some(result) = run_capture("sudo", &all) {
            return Some(result);
        }
    }
    run_capture(program, args)
}

enum MacUpdateOutcome {
    Installed(String),
    Pending(String),
}

fn find_mac_app_by_bundle_id(bundle_id: &str) -> Option<PathBuf> {
    for (_, dir) in mac_app_dirs() {
        let mut paths = Vec::new();
        collect_mac_app_paths(&dir, 3, &mut paths);
        for path in paths {
            let canonical = std::fs::canonicalize(&path).unwrap_or(path);
            if canonical.starts_with("/System") {
                continue;
            }
            let info = mac_bundle_info(&canonical);
            if info.bundle_id.eq_ignore_ascii_case(bundle_id) {
                return Some(canonical);
            }
        }
    }
    None
}

fn sparkle_archive_extension(url: &str) -> Option<&'static str> {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let extension = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "zip" => Some("zip"),
        "dmg" => Some("dmg"),
        "pkg" => Some("pkg"),
        _ => None,
    }
}

struct TempWorkspace {
    path: PathBuf,
    cleanup: bool,
}

impl TempWorkspace {
    fn new() -> Result<Self, String> {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "diskraptor-mac-update-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("Could not create update workspace: {error}"))?;
        Ok(Self {
            path,
            cleanup: true,
        })
    }

    /// Keep the downloaded archive around when an external installer has to
    /// open it after this function returns.
    fn keep(mut self) {
        self.cleanup = false;
    }
}

impl Drop for TempWorkspace {
    fn drop(&mut self) {
        if self.cleanup {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

struct MountedDmg {
    mount: PathBuf,
}

impl MountedDmg {
    fn attach(archive: &Path, mount: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(mount)
            .map_err(|error| format!("Could not create mount point: {error}"))?;
        let status = Command::new("hdiutil")
            .args([
                "attach",
                "-nobrowse",
                "-readonly",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(mount)
            .arg(archive)
            .status()
            .map_err(|error| format!("Could not mount the update image: {error}"))?;
        if !status.success() {
            return Err("Could not mount the downloaded update image".to_string());
        }
        Ok(Self {
            mount: mount.to_path_buf(),
        })
    }
}

impl Drop for MountedDmg {
    fn drop(&mut self) {
        let _ = Command::new("hdiutil")
            .args(["detach", "-force"])
            .arg(&self.mount)
            .status();
    }
}

fn code_team_id(bundle: &Path) -> Option<String> {
    let output = Command::new("codesign")
        .args(["-dv", "--verbose=4"])
        .arg(bundle)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stderr);
    text.lines().find_map(|line| {
        line.strip_prefix("TeamIdentifier=")
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != "not set")
            .map(str::to_string)
    })
}

fn verify_mac_code_signature(bundle: &Path) -> Result<(), String> {
    let output = Command::new("codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(bundle)
        .output()
        .map_err(|error| format!("Could not verify the update signature: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = first_error(&String::from_utf8_lossy(&output.stderr));
        Err(format!(
            "The downloaded application is not correctly signed: {detail}"
        ))
    }
}

fn clean_base64(value: &str) -> String {
    value.chars().filter(|ch| !ch.is_whitespace()).collect()
}

/// Verify the Ed25519 signature Sparkle publishes for the archive. This is the
/// same signature Sparkle itself checks before installing an update.
fn verify_sparkle_signature(
    app: &Path,
    archive: &Path,
    signature: Option<&str>,
) -> Result<(), String> {
    let info = mac_bundle_info(app);
    let public_key = clean_base64(&info.public_ed_key);
    if public_key.is_empty() {
        return Err("This app does not publish a Sparkle Ed25519 public key".to_string());
    }
    let signature = signature
        .map(clean_base64)
        .filter(|signature| !signature.is_empty())
        .ok_or_else(|| "The update is not signed in the appcast".to_string())?;

    let key_bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key)
        .map_err(|error| format!("Invalid Sparkle public key: {error}"))?;
    if key_bytes.len() != 32 {
        return Err("Invalid Sparkle public key length".to_string());
    }
    let mut key_array = [0u8; 32];
    key_array.copy_from_slice(&key_bytes);
    let verifying_key = VerifyingKey::from_bytes(&key_array)
        .map_err(|error| format!("Invalid Sparkle public key: {error}"))?;

    let signature_bytes = base64::engine::general_purpose::STANDARD
        .decode(signature)
        .map_err(|error| format!("Invalid Sparkle signature: {error}"))?;
    if signature_bytes.len() != 64 {
        return Err("Invalid Sparkle signature length".to_string());
    }
    let mut signature_array = [0u8; 64];
    signature_array.copy_from_slice(&signature_bytes);
    let signature = Signature::from_bytes(&signature_array);

    let bytes = std::fs::read(archive)
        .map_err(|error| format!("Could not read the downloaded update: {error}"))?;
    verifying_key
        .verify(&bytes, &signature)
        .map_err(|_| "The update signature is invalid".to_string())
}

fn find_app_with_bundle_id(root: &Path, bundle_id: &str) -> Option<PathBuf> {
    let mut paths = Vec::new();
    collect_mac_app_paths(root, 5, &mut paths);
    paths.into_iter().find(|path| {
        mac_bundle_info(path)
            .bundle_id
            .eq_ignore_ascii_case(bundle_id)
    })
}

fn mac_bundle_is_newer(next: &MacBundleInfo, current: &MacBundleInfo) -> bool {
    if version_is_newer(&next.version, &current.version) {
        return true;
    }
    next.version == current.version
        && !next.build_version.is_empty()
        && !current.build_version.is_empty()
        && version_is_newer(&next.build_version, &current.build_version)
}

fn install_bundle_update(
    old_path: &Path,
    new_path: &Path,
    expected: &MacBundleInfo,
) -> Result<String, String> {
    let new_info = mac_bundle_info(new_path);
    if !new_info.bundle_id.eq_ignore_ascii_case(&expected.bundle_id) {
        return Err("The update contains a different application".to_string());
    }
    if !mac_bundle_is_newer(&new_info, expected) {
        return Err(format!(
            "The downloaded version ({}) is not newer than the installed version ({})",
            new_info.version, expected.version
        ));
    }
    verify_mac_code_signature(new_path)?;

    let old_team = code_team_id(old_path)
        .ok_or_else(|| "The installed app has no Developer ID signature".to_string())?;
    let new_team = code_team_id(new_path)
        .ok_or_else(|| "The downloaded app has no Developer ID signature".to_string())?;
    if old_team != new_team {
        return Err("The update is signed by a different developer".to_string());
    }

    quit_mac_app(old_path);
    let name = old_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Application.app");
    let backup = old_path.with_file_name(format!(
        ".{name}.diskraptor-backup-{}",
        std::process::id()
    ));
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&backup);
    }
    std::fs::rename(old_path, &backup).map_err(|error| {
        format!(
            "Could not replace {name}: {error}. Administrator permission may be required."
        )
    })?;

    let copied = Command::new("ditto")
        .arg(new_path)
        .arg(old_path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !copied {
        let _ = std::fs::remove_dir_all(old_path);
        let _ = std::fs::rename(&backup, old_path);
        return Err(format!("Could not copy the update into {name}"));
    }

    let installed = mac_bundle_info(old_path);
    if !installed.bundle_id.eq_ignore_ascii_case(&expected.bundle_id)
        || !mac_bundle_is_newer(&installed, expected)
    {
        let _ = std::fs::remove_dir_all(old_path);
        let _ = std::fs::rename(&backup, old_path);
        return Err("The installed app did not report the expected version".to_string());
    }
    if ::trash::delete(&backup).is_err() {
        let _ = std::fs::remove_dir_all(&backup);
    }
    Ok(installed.version)
}

fn install_sparkle_archive(
    old_path: &Path,
    expected: &MacBundleInfo,
    archive: &Path,
    workspace: &TempWorkspace,
) -> Result<MacUpdateOutcome, String> {
    let extension = archive
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "zip" => {
            let extract = workspace.path.join("extract");
            std::fs::create_dir_all(&extract)
                .map_err(|error| format!("Could not prepare the update: {error}"))?;
            let status = Command::new("ditto")
                .args(["-x", "-k"])
                .arg(archive)
                .arg(&extract)
                .status()
                .map_err(|error| format!("Could not extract the update: {error}"))?;
            if !status.success() {
                return Err("Could not extract the downloaded update".to_string());
            }
            let new_app = find_app_with_bundle_id(&extract, &expected.bundle_id)
                .ok_or_else(|| "The update archive does not contain the app".to_string())?;
            install_bundle_update(old_path, &new_app, expected).map(MacUpdateOutcome::Installed)
        }
        "dmg" => {
            let mount = workspace.path.join("mount");
            let mounted = MountedDmg::attach(archive, &mount)?;
            let result = match find_app_with_bundle_id(&mount, &expected.bundle_id) {
                Some(new_app) => install_bundle_update(old_path, &new_app, expected)
                    .map(MacUpdateOutcome::Installed),
                None => {
                    drop(mounted);
                    Command::new("open")
                        .arg(archive)
                        .status()
                        .map_err(|error| format!("Could not open the update image: {error}"))?;
                    Ok(MacUpdateOutcome::Pending(
                        "Opened the official update image; finish the installation in Finder."
                            .to_string(),
                    ))
                }
            };
            result
        }
        "pkg" => {
            let status = Command::new("open")
                .arg(archive)
                .status()
                .map_err(|error| format!("Could not open the update installer: {error}"))?;
            if !status.success() {
                return Err("Could not open the update installer".to_string());
            }
            Ok(MacUpdateOutcome::Pending(
                "Opened the signed package installer; finish the installation there.".to_string(),
            ))
        }
        _ => Err("Unsupported update archive type".to_string()),
    }
}

fn run_sparkle_update(bundle_id: &str) -> Result<Value, String> {
    let app_path = find_mac_app_by_bundle_id(bundle_id)
        .ok_or_else(|| "Could not find the installed application".to_string())?;
    let info = mac_bundle_info(&app_path);
    if info.app_store {
        return Err("This application is managed by the App Store".to_string());
    }
    if !info.feed_url.trim().to_ascii_lowercase().starts_with("https://") {
        return Err("This application does not publish a secure update feed".to_string());
    }

    let xml = http_get_text(&info.feed_url, 10)?;
    let release = parse_sparkle_appcast(&xml)
        .ok_or_else(|| "No usable release found in the appcast".to_string())?;
    if !sparkle_release_is_newer(&release, &info.version, &info.build_version) {
        return Err("This application is already up to date".to_string());
    }
    let extension = sparkle_archive_extension(&release.enclosure_url)
        .ok_or_else(|| "The update URL does not point to a supported archive".to_string())?;
    if !release.enclosure_url.trim().to_ascii_lowercase().starts_with("https://") {
        return Err("The update download is not served over HTTPS".to_string());
    }

    let workspace = TempWorkspace::new()?;
    let archive = workspace.path.join(format!("update.{extension}"));
    http_download(&release.enclosure_url, &archive)?;
    verify_sparkle_signature(&app_path, &archive, release.ed_signature.as_deref())?;

    match install_sparkle_archive(&app_path, &info, &archive, &workspace)? {
        MacUpdateOutcome::Installed(version) => Ok(json!({
            "success": true,
            "output": format!("Updated {} to {version}", info.bundle_id),
        })),
        MacUpdateOutcome::Pending(message) => {
            // The external installer still needs the downloaded file after we
            // return, so do not let the workspace guard delete it yet.
            workspace.keep();
            Ok(json!({
                "success": true,
                "pending": true,
                "output": message,
            }))
        }
    }
}

fn open_app_store_updates() -> Result<Value, String> {
    let opened = Command::new("open")
        .arg("macappstore://showUpdatesPage")
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !opened {
        let fallback = Command::new("open")
            .args(["-a", "App Store"])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !fallback {
            return Err("Could not open the App Store".to_string());
        }
    }
    Ok(json!({
        "success": true,
        "pending": true,
        "output": "Opened the App Store Updates page. Finish the update there.",
    }))
}

pub(crate) fn run_macos_update(id: &str, source: &str) -> Result<Value, String> {
    if in_mac_sandbox() {
        return Err(
            "Updating apps is not available in the sandboxed Mac App Store build.".to_string(),
        );
    }
    let id = id.trim();
    if !safe_bundle_id(id) {
        return Err("Invalid bundle identifier".to_string());
    }
    match source {
        "appstore" => open_app_store_updates(),
        "sparkle" => run_sparkle_update(id),
        other => Err(format!("Unknown update source: {other}")),
    }
}

pub(crate) fn run_linux_update(id: &str, source: &str) -> Result<Value, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("Missing package id".to_string());
    }
    if !valid_package_id(id) {
        return Err("Invalid package id".to_string());
    }
    let (program, args): (&str, Vec<&str>) = match source {
        "apt" => ("apt-get", vec!["install", "--only-upgrade", "-y", id]),
        "dnf" => ("dnf", vec!["upgrade", "-y", id]),
        "zypper" => ("zypper", vec!["--non-interactive", "update", id]),
        "pacman" => ("pacman", vec!["-S", "--noconfirm", id]),
        "flatpak" => ("flatpak", vec!["update", "-y", "--app", id]),
        "snap" => ("snap", vec!["refresh", id]),
        other => return Err(format!("Unknown update source: {other}")),
    };

    let result = if source == "flatpak" {
        // User installations need no elevation; system installations use
        // polkit, so retry once through pkexec if the direct call fails.
        match run_capture(program, &args) {
            Some((true, out, err)) => (true, out, err),
            Some(failed) => run_elevated(program, &args).unwrap_or(failed),
            None => return Err(format!("{program} is not available")),
        }
    } else {
        run_elevated(program, &args).ok_or_else(|| format!("{program} could not be executed"))?
    };

    let (ok, out, err) = result;
    if ok {
        Ok(json!({ "success": true, "output": out.trim() }))
    } else {
        let detail = if err.trim().is_empty() {
            out.trim().to_string()
        } else {
            err.trim().to_string()
        };
        Err(format!("{program} could not update {id}: {detail}"))
    }
}

// ── Uninstall ───────────────────────────────────────────────────────────────

fn validate_mac_bundle(location: &str) -> Result<PathBuf, String> {
    let location = location.trim();
    if location.is_empty() {
        return Err("No application bundle path was provided".to_string());
    }
    let raw = PathBuf::from(location);
    if !raw.is_absolute() {
        return Err("Application path must be absolute".to_string());
    }
    let path =
        std::fs::canonicalize(&raw).map_err(|error| format!("Application not found: {error}"))?;
    if path.extension().and_then(|ext| ext.to_str()) != Some("app") || !path.is_dir() {
        return Err("Not a macOS application bundle".to_string());
    }
    if path.starts_with("/System") || path.starts_with("/usr") || path.starts_with("/bin") {
        return Err("macOS system applications cannot be removed".to_string());
    }
    if !path.join("Contents/Info.plist").is_file() {
        return Err("Not a macOS application bundle (missing Contents/Info.plist)".to_string());
    }
    Ok(path)
}

fn quit_mac_app(path: &Path) {
    if in_mac_sandbox() {
        return;
    }
    let bundle_id = mac_bundle_info(path).bundle_id;
    let script = if bundle_id.is_empty() {
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
            return;
        };
        format!(
            "tell application \"{}\" to quit",
            name.replace('\\', "\\\\").replace('"', "\\\"")
        )
    } else {
        format!(
            "tell application id \"{}\" to quit",
            bundle_id.replace('\\', "\\\\").replace('"', "\\\"")
        )
    };
    let _ = Command::new("osascript").args(["-e", &script]).status();
    std::thread::sleep(std::time::Duration::from_millis(400));
}

fn wait_path_gone(path: &Path) -> bool {
    for attempt in 0..20 {
        if !path.exists() {
            return true;
        }
        if attempt < 19 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    false
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn uninstall_macos(
    name: &str,
    install_location: &str,
    package_id: &str,
    package_source: &str,
    uninstall_string: &str,
    quiet_uninstall: &str,
) -> Result<(), String> {
    if in_mac_sandbox() {
        return Err(
            "Uninstalling applications is not available in the sandboxed Mac App Store build. \
             Drag the app from Applications to the Trash in Finder instead."
                .to_string(),
        );
    }

    let custom = if quiet_uninstall.trim().is_empty() {
        uninstall_string.trim()
    } else {
        quiet_uninstall.trim()
    };
    if !custom.is_empty() {
        let status = Command::new("sh")
            .args(["-c", custom])
            .status()
            .map_err(|error| format!("Failed to execute uninstaller: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Uninstaller failed with exit code {:?}",
                status.code()
            ));
        }
        return Ok(());
    }

    let path = validate_mac_bundle(install_location).map_err(|error| {
        if install_location.trim().is_empty() {
            format!("{error} (no bundle path for '{name}')")
        } else {
            error
        }
    })?;

    let _ = (package_id, package_source);
    quit_mac_app(&path);
    ::trash::delete(&path)
        .map_err(|error| format!("Could not move {} to the Trash: {error}", path.display()))?;

    if wait_path_gone(&path) {
        return Ok(());
    }
    Err(format!(
        "{} is still present after uninstalling. It may be protected by macOS.",
        path.display()
    ))
}

fn resolve_linux_package(install_location: &str) -> Option<(String, String)> {
    let location = install_location.trim();
    if location.is_empty() {
        return None;
    }
    let path = Path::new(location);
    if let Some(rest) = location.strip_prefix("/snap/bin/") {
        return Some((
            rest.split('/').next().unwrap_or(rest).to_string(),
            "snap".to_string(),
        ));
    }
    if location.contains("/var/lib/snapd/desktop/applications/") {
        let stem = path.file_stem().and_then(|stem| stem.to_str())?;
        return Some((
            stem.split('_').next().unwrap_or(stem).to_string(),
            "snap".to_string(),
        ));
    }
    if location.contains("/flatpak/exports/share/applications/") {
        let stem = path.file_stem().and_then(|stem| stem.to_str())?;
        return Some((stem.to_string(), "flatpak".to_string()));
    }

    let mut candidates = vec![location.to_string()];
    if let Ok(canonical) = std::fs::canonicalize(path) {
        let canonical = canonical.to_string_lossy().into_owned();
        if canonical != location {
            candidates.push(canonical);
        }
    }
    let owners = native_owners(&candidates);
    let package = candidates
        .iter()
        .find_map(|candidate| owners.get(candidate))?
        .clone();
    let source = native_source()?;
    Some((package, source.to_string()))
}

fn package_installed(source: &str, id: &str) -> bool {
    match source {
        "apt" => run_capture("dpkg-query", &["-W", "-f=${Status}", id])
            .map(|(ok, out, _)| ok && out.contains("install ok installed"))
            .unwrap_or(false),
        "dnf" | "zypper" | "rpm" => run_capture("rpm", &["-q", id])
            .map(|(ok, _, _)| ok)
            .unwrap_or(false),
        "pacman" => run_capture("pacman", &["-Q", id])
            .map(|(ok, _, _)| ok)
            .unwrap_or(false),
        "flatpak" => run_capture("flatpak", &["info", id])
            .map(|(ok, _, _)| ok)
            .unwrap_or(false),
        "snap" => run_capture("snap", &["list", id])
            .map(|(ok, _, _)| ok)
            .unwrap_or(false),
        _ => false,
    }
}

pub(crate) fn uninstall_linux(
    name: &str,
    install_location: &str,
    package_id: &str,
    package_source: &str,
    uninstall_string: &str,
    quiet_uninstall: &str,
) -> Result<(), String> {
    let custom = if quiet_uninstall.trim().is_empty() {
        uninstall_string.trim()
    } else {
        quiet_uninstall.trim()
    };
    if !custom.is_empty() {
        let status = Command::new("sh")
            .args(["-c", custom])
            .status()
            .map_err(|error| format!("Failed to execute uninstaller: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Uninstaller failed with exit code {:?}",
                status.code()
            ));
        }
        return Ok(());
    }

    let (id, source) = if package_id.trim().is_empty() {
        resolve_linux_package(install_location).ok_or_else(|| {
            format!(
                "Could not determine which package owns '{}'. Uninstall '{name}' with your package manager instead.",
                if install_location.is_empty() {
                    name
                } else {
                    install_location
                }
            )
        })?
    } else {
        let source = if package_source.trim().is_empty() {
            // Older callers may not send package_source; recover it from the
            // desktop file / executable location when possible.
            resolve_linux_package(install_location)
                .map(|(_, source)| source)
                .or_else(|| native_source().map(str::to_string))
                .unwrap_or_default()
        } else {
            package_source.trim().to_string()
        };
        (package_id.trim().to_string(), source)
    };

    if !valid_package_id(&id) {
        return Err("Invalid package id".to_string());
    }

    let (program, args): (&str, Vec<&str>) = match source.as_str() {
        "apt" => ("apt-get", vec!["remove", "-y", id.as_str()]),
        "dnf" => ("dnf", vec!["remove", "-y", id.as_str()]),
        "zypper" => ("zypper", vec!["--non-interactive", "remove", id.as_str()]),
        "pacman" => ("pacman", vec!["-Rns", "--noconfirm", id.as_str()]),
        "rpm" => ("rpm", vec!["-e", id.as_str()]),
        "flatpak" => ("flatpak", vec!["uninstall", "-y", "--app", id.as_str()]),
        "snap" => ("snap", vec!["remove", id.as_str()]),
        other => return Err(format!("Unknown package source: {other}")),
    };

    let result = if source == "flatpak" {
        match run_capture(program, &args) {
            Some((true, out, err)) => (true, out, err),
            Some(failed) => run_elevated(program, &args).unwrap_or(failed),
            None => return Err(format!("{program} is not available")),
        }
    } else {
        run_elevated(program, &args).ok_or_else(|| format!("{program} is not available"))?
    };

    let (ok, out, err) = result;
    if !ok {
        let detail = if err.trim().is_empty() {
            out.trim().to_string()
        } else {
            err.trim().to_string()
        };
        return Err(format!("{program} could not uninstall {id}: {detail}"));
    }

    // The command exiting 0 is not proof: wait until the package is actually
    // gone, the same way the Windows path verifies the registry entry.
    for attempt in 0..20 {
        if !package_installed(&source, &id) {
            return Ok(());
        }
        if attempt < 19 {
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    }
    Err(format!(
        "{program} finished, but '{id}' is still installed. Administrator privileges or user interaction may be required."
    ))
}

// ── Platform dispatch ───────────────────────────────────────────────────────

pub(crate) fn platform_list_apps() -> Result<Vec<Value>, String> {
    #[cfg(target_os = "macos")]
    {
        list_macos_apps()
    }
    #[cfg(target_os = "linux")]
    {
        list_linux_apps()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err("Unsupported platform".to_string())
    }
}

pub(crate) fn platform_check_updates() -> Value {
    #[cfg(target_os = "macos")]
    {
        check_macos_updates()
    }
    #[cfg(target_os = "linux")]
    {
        check_linux_updates()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        json!({ "supported": false, "error": "Unsupported platform", "updates": [] })
    }
}

pub(crate) fn platform_run_update(id: &str, source: &str) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        run_macos_update(id, source)
    }
    #[cfg(target_os = "linux")]
    {
        run_linux_update(id, source)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (id, source);
        Err("Unsupported platform".to_string())
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn platform_uninstall(
    name: &str,
    install_location: &str,
    package_id: &str,
    package_source: &str,
    uninstall_string: &str,
    quiet_uninstall: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        uninstall_macos(
            name,
            install_location,
            package_id,
            package_source,
            uninstall_string,
            quiet_uninstall,
        )
    }
    #[cfg(target_os = "linux")]
    {
        uninstall_linux(
            name,
            install_location,
            package_id,
            package_source,
            uninstall_string,
            quiet_uninstall,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (
            name,
            install_location,
            package_id,
            package_source,
            uninstall_string,
            quiet_uninstall,
        );
        Err("Unsupported platform".to_string())
    }
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_entry_reads_only_main_group() {
        let entry = parse_desktop_entry(
            "[Desktop Entry]\n\
             Name=Firefox\n\
             Exec=/usr/lib/firefox/firefox %u\n\
             Icon=firefox\n\
             Type=Application\n\
             NoDisplay=false\n\
             \n\
             [Desktop Action new-window]\n\
             Name=New Window\n\
             Exec=/usr/lib/firefox/firefox --new-window\n",
        );
        assert_eq!(entry.name, "Firefox");
        assert_eq!(entry.icon, "firefox");
        assert_eq!(entry.app_type, "Application");
        assert!(!entry.no_display);
        assert_eq!(
            exec_program(&entry.exec).as_deref(),
            Some("/usr/lib/firefox/firefox")
        );
    }

    #[test]
    fn desktop_entry_flags_hidden_apps() {
        let entry =
            parse_desktop_entry("[Desktop Entry]\nName=Helper\nHidden=true\nNoDisplay=true\n");
        assert!(entry.hidden);
        assert!(entry.no_display);
    }

    #[test]
    fn exec_program_skips_env_and_assignments() {
        let program = exec_program(
            "env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %U",
        );
        assert_eq!(program.as_deref(), Some("/snap/bin/firefox"));

        let quoted = exec_program("\"/opt/My App/bin/app\" --flag %F");
        assert_eq!(quoted.as_deref(), Some("/opt/My App/bin/app"));

        let assignment = exec_program("FOO=bar /usr/bin/thing");
        assert_eq!(assignment.as_deref(), Some("/usr/bin/thing"));
    }

    #[test]
    fn flatpak_and_snap_ids_are_extracted() {
        assert_eq!(
            flatpak_app_id(
                "/usr/bin/flatpak run --branch=stable --arch=x86_64 org.gnome.Builder %U"
            )
            .as_deref(),
            Some("org.gnome.Builder")
        );
        assert_eq!(
            snap_package("/snap/bin/firefox %U", "firefox_firefox"),
            "firefox"
        );
        assert_eq!(
            snap_package("snap run code --unity-launch", "code_code"),
            "code"
        );
        assert_eq!(
            snap_package("/usr/bin/foo", "org.example.App_App"),
            "org.example.App"
        );
    }

    #[test]
    fn apt_upgradable_parser() {
        let text = "Listing...\n\
                    Paketlisten werden gelesen…\n\
                    firefox/jammy-updates 1:1snap1-0ubuntu2 amd64 [upgradable from: 1:1snap1-0ubuntu1]\n\
                    libfoo/jammy 2.0-1 amd64 [upgradable from: 1.0-1]\n";
        let updates = parse_apt_upgradable(text);
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].name, "firefox");
        assert_eq!(updates[0].available, "1:1snap1-0ubuntu2");
        assert_eq!(updates[0].version, "1:1snap1-0ubuntu1");
        assert_eq!(updates[0].source, "apt");
    }

    #[test]
    fn dnf_check_update_parser() {
        let text = "Last metadata expiration check: 0:10:00 ago.\n\
                    kernel.x86_64                 6.9.4-200.fc40          updates\n\
                    firefox.x86_64                125.0.3-1.fc40          updates\n\
                    Obsoleting Packages\n";
        let updates = parse_dnf_check_update(text);
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].name, "kernel");
        assert_eq!(updates[0].available, "6.9.4-200.fc40");
        assert_eq!(updates[1].id, "firefox");
    }

    #[test]
    fn pacman_qu_parser() {
        let updates =
            parse_pacman_qu("linux 6.9.1.arch1-1 -> 6.9.2.arch1-1\nfirefox 125.0-1 -> 126.0-1\n");
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].version, "6.9.1.arch1-1");
        assert_eq!(updates[0].available, "6.9.2.arch1-1");
        assert_eq!(updates[1].source, "pacman");
    }

    #[test]
    fn zypper_updates_parser() {
        let text = "S  | Repository | Name | Current Version | Available Version | Arch\n\
                    ---+------------+------+-----------------+-------------------+-----\n\
                    v  | repo-oss   | zypper | 1.14.68-1       | 1.14.70-1         | x86_64\n";
        let updates = parse_zypper_updates(text);
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0].name, "zypper");
        assert_eq!(updates[0].version, "1.14.68-1");
        assert_eq!(updates[0].available, "1.14.70-1");
    }

    #[test]
    fn flatpak_and_snap_update_parsers() {
        let flatpak = parse_flatpak_updates("org.gnome.Builder\t46.1\norg.gnome.Platform\t46\n");
        assert_eq!(flatpak.len(), 2);
        assert_eq!(flatpak[0].id, "org.gnome.Builder");
        assert_eq!(flatpak[0].available, "46.1");

        let snap = parse_snap_refresh(
            "Name     Version   Rev    Size   Publisher   Notes\n\
             firefox  126.0-1   4173   250MB  mozilla✓    -\n\
             All snaps up to date.\n",
        );
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, "firefox");
    }

    #[test]
    fn version_comparison_handles_numeric_parts() {
        assert!(version_is_newer("1.10.0", "1.9.9"));
        assert!(version_is_newer("2.0", "1.99.99"));
        assert!(version_is_newer("1.2.3", "1.2"));
        assert!(!version_is_newer("1.2.3", "1.2.3"));
        assert!(!version_is_newer("1.2.3", "1.2.4"));
        assert!(!version_is_newer("", "1.2.3"));
    }

    #[test]
    fn sparkle_appcast_picks_the_newest_signed_release() {
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
            <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel>
                <title>Updates</title>
                <item>
                  <title>Old</title>
                  <sparkle:shortVersionString>1.0.0</sparkle:shortVersionString>
                  <enclosure url="https://example.com/old.zip" sparkle:edSignature="old"/>
                </item>
                <item>
                  <title>New</title>
                  <sparkle:shortVersionString>1.4.2</sparkle:shortVersionString>
                  <sparkle:version>142</sparkle:version>
                  <enclosure url="https://example.com/new.zip" sparkle:edSignature="new"/>
                </item>
              </channel>
            </rss>"#;
        let release = parse_sparkle_appcast(xml).expect("release");
        assert_eq!(release.version, "1.4.2");
        assert_eq!(release.enclosure_url, "https://example.com/new.zip");
        assert_eq!(release.ed_signature.as_deref(), Some("new"));
    }

    #[test]
    fn sparkle_appcast_skips_prerelease_channels() {
        let xml = r#"<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel>
                <item>
                  <sparkle:shortVersionString>1.5.0</sparkle:shortVersionString>
                  <enclosure url="https://example.com/stable.zip" sparkle:edSignature="stable"/>
                </item>
                <item>
                  <sparkle:shortVersionString>2.0.0-beta.1</sparkle:shortVersionString>
                  <sparkle:channel>beta</sparkle:channel>
                  <enclosure url="https://example.com/beta.zip" sparkle:edSignature="beta"/>
                </item>
              </channel>
            </rss>"#;
        let release = parse_sparkle_appcast(xml).expect("stable release");
        assert_eq!(release.version, "1.5.0");
        assert_eq!(release.enclosure_url, "https://example.com/stable.zip");
    }

    #[test]
    fn sparkle_appcast_uses_build_version_when_short_version_is_missing() {
        let xml = r#"<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel><item>
                <sparkle:version>142</sparkle:version>
                <enclosure url="https://example.com/app.zip" sparkle:edSignature="sig"/>
              </item></channel>
            </rss>"#;
        let release = parse_sparkle_appcast(xml).expect("release");
        assert_eq!(release.version, "142");
        assert!(release.version_is_build);
    }

    #[test]
    fn sparkle_release_considers_build_number_changes() {
        let short_release = SparkleRelease {
            version: "1.4.2".to_string(),
            version_is_build: false,
            build_version: Some("143".to_string()),
            enclosure_url: "https://example.com/app.zip".to_string(),
            ed_signature: Some("sig".to_string()),
        };
        assert!(sparkle_release_is_newer(
            &short_release,
            "1.4.2",
            "142"
        ));
        assert!(!sparkle_release_is_newer(
            &short_release,
            "1.4.2",
            "143"
        ));

        let build_release = SparkleRelease {
            version: "143".to_string(),
            version_is_build: true,
            build_version: Some("143".to_string()),
            enclosure_url: "https://example.com/app.zip".to_string(),
            ed_signature: Some("sig".to_string()),
        };
        assert!(sparkle_release_is_newer(
            &build_release,
            "1.4.2",
            "142"
        ));
        assert!(!sparkle_release_is_newer(
            &build_release,
            "1.4.2",
            "143"
        ));
    }

    #[test]
    fn mac_bundle_build_version_can_make_an_update_newer() {
        let installed = MacBundleInfo {
            version: "1.4.2".to_string(),
            build_version: "142".to_string(),
            ..MacBundleInfo::default()
        };
        let updated = MacBundleInfo {
            version: "1.4.2".to_string(),
            build_version: "143".to_string(),
            ..MacBundleInfo::default()
        };
        assert!(mac_bundle_is_newer(&updated, &installed));
        assert!(!mac_bundle_is_newer(&installed, &updated));
    }

    #[test]
    fn sparkle_appcast_ignores_unsigned_releases() {
        let xml = r#"<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel>
                <item>
                  <sparkle:shortVersionString>1.5.0</sparkle:shortVersionString>
                  <enclosure url="https://example.com/old.zip" sparkle:edSignature="old"/>
                </item>
                <item>
                  <sparkle:shortVersionString>2.0.0</sparkle:shortVersionString>
                  <enclosure url="https://example.com/unsigned.zip"/>
                </item>
              </channel>
            </rss>"#;
        let release = parse_sparkle_appcast(xml).expect("signed release");
        assert_eq!(release.version, "1.5.0");
        assert_eq!(release.enclosure_url, "https://example.com/old.zip");
    }

    #[test]
    fn sparkle_appcast_ignores_entries_without_an_enclosure() {
        let xml = r#"<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
              <channel><item>
                <sparkle:shortVersionString>9.0</sparkle:shortVersionString>
              </item></channel>
            </rss>"#;
        assert!(parse_sparkle_appcast(xml).is_none());
    }

    #[test]
    fn package_ids_are_safe_to_pass_as_arguments() {
        assert!(valid_package_id("firefox"));
        assert!(valid_package_id("org.gnome.Builder"));
        assert!(valid_package_id("code-insiders@1.2"));
        assert!(!valid_package_id(""));
        assert!(!valid_package_id("--help"));
        assert!(!valid_package_id("foo bar"));
        assert!(!valid_package_id("foo\nbar"));
    }

    #[test]
    fn size_parsing_handles_package_manager_formats() {
        assert_eq!(parse_size("12.34 MiB"), 12_939_427);
        assert_eq!(parse_size("1024"), 1024);
        assert_eq!(parse_size("1.5 GB"), 1_610_612_736);
        assert_eq!(parse_size("nonsense"), 0);
    }

    fn fake_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&[0, 0, 0, 0]);
        png
    }

    fn fake_icns(entries: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (kind, payload) in entries {
            body.extend_from_slice(*kind);
            body.extend_from_slice(&((payload.len() + 8) as u32).to_be_bytes());
            body.extend_from_slice(payload);
        }
        let mut icns = Vec::new();
        icns.extend_from_slice(b"icns");
        icns.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
        icns.extend_from_slice(&body);
        icns
    }

    #[test]
    fn icns_picks_a_reasonable_embedded_png() {
        let small = fake_png(32, 32);
        let medium = fake_png(256, 256);
        let huge = fake_png(1024, 1024);
        let icon = fake_icns(&[
            (b"icp5", small.clone()),
            (b"TOC ", vec![0; 16]),
            (b"ic10", huge.clone()),
            (b"ic08", medium.clone()),
            (b"ic09", fake_png(512, 512)),
        ]);
        assert_eq!(icns_png(&icon), Some(medium));

        // Only tiny icons: use the largest available.
        let tiny = fake_icns(&[(b"icp4", fake_png(16, 16)), (b"icp5", small.clone())]);
        assert_eq!(icns_png(&tiny), Some(small));

        let legacy = fake_icns(&[(b"is32", vec![1, 2, 3, 4])]);
        assert_eq!(icns_png(&legacy), None);
        assert_eq!(icns_png(b"not an icns"), None);
    }

    #[test]
    fn mac_bundle_scan_finds_vendor_folders_but_not_helpers() {
        let root = std::env::temp_dir().join(format!(
            "diskraptor-mac-scan-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("Vendor/Photoshop.app/Contents/Helpers/Helper.app"))
            .unwrap();
        std::fs::create_dir_all(root.join("Utilities/Tool.app")).unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        std::fs::write(root.join("Broken.app"), b"not a bundle").unwrap();

        let mut found = Vec::new();
        collect_mac_app_paths(&root, 3, &mut found);
        let mut names: Vec<String> = found
            .iter()
            .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
            .map(str::to_string)
            .collect();
        names.sort();
        assert_eq!(names, vec!["Photoshop.app", "Tool.app"]);

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn icon_index_prefers_larger_and_finds_aliases() {
        let root = std::env::temp_dir().join(format!(
            "diskraptor-icon-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let small = root.join("hicolor/48x48/apps");
        let large = root.join("hicolor/256x256/apps");
        let scalable = root.join("hicolor/scalable/apps");
        std::fs::create_dir_all(&small).unwrap();
        std::fs::create_dir_all(&large).unwrap();
        std::fs::create_dir_all(&scalable).unwrap();
        std::fs::write(small.join("demo.png"), b"small").unwrap();
        std::fs::write(large.join("demo.png"), b"large").unwrap();
        std::fs::write(scalable.join("snap.other.other.svg"), b"<svg/>").unwrap();

        let index = build_icon_index_from(std::slice::from_ref(&root));
        assert_eq!(index.get("demo").unwrap(), &large.join("demo.png"));
        assert!(index.contains_key("snap.other.other"));
        assert!(index.contains_key("other"));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn mac_bundle_validation_rejects_non_bundles() {
        assert!(validate_mac_bundle("").is_err());
        assert!(validate_mac_bundle("relative/App.app").is_err());
        assert!(validate_mac_bundle("/definitely/not/here.app").is_err());
    }
}
