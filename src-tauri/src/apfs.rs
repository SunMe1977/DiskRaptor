//! APFS snapshots & purgeable-space view (macOS only).
//!
//! A normal tree scan cannot see these: snapshots are invisible copy-on-write
//! reserves and "purgeable" space is space macOS is allowed to reclaim itself —
//! often the real cause of "Other" in the Storage settings. On non-macOS
//! platforms the commands return an error so the UI can degrade gracefully.

use crate::JsonResult;

#[tauri::command]
pub(crate) fn list_apfs_volumes() -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        let mut volumes = Vec::new();
        for mount in mount_points() {
            let info = match run("diskutil", &["info", "-plist", mount.as_str()]) {
                Some(s) => s,
                None => continue,
            };
            let fs_type = plist_key(&info, "FilesystemType").unwrap_or_default();
            if !fs_type.eq_ignore_ascii_case("apfs") {
                continue; // only APFS volumes carry snapshots / purgeable space
            }
            let name = plist_key(&info, "VolumeName").unwrap_or_else(|| mount.clone());
            let total = plist_key(&info, "TotalSpace")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let free = plist_key(&info, "FreeSpace")
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0);
            let purgeable = plist_key(&info, "PurgeableSpace")
                .and_then(|v| v.parse::<u64>().ok());
            volumes.push(serde_json::json!({
                "name": name,
                "mount": mount,
                "total_bytes": total,
                "free_bytes": free,
                "purgeable_bytes": purgeable,
                "local_tm_snapshots": list_local_tm_snapshots(&mount),
                "snapshots": list_snapshots(&mount),
            }));
        }
        JsonResult::ok(serde_json::json!({ "volumes": volumes }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        JsonResult::err("APFS & Purgeable is only available on macOS")
    }
}

/// Delete all local Time-Machine snapshots of an APFS volume. This is
/// permanent and cannot be undone — the UI must confirm before calling.
#[tauri::command]
pub(crate) fn delete_local_snapshot(volume: String) -> JsonResult {
    #[cfg(target_os = "macos")]
    {
        match std::process::Command::new("tmutil")
            .args(["deletelocalsnapshots", volume.as_str()])
            .status()
        {
            Ok(status) if status.success() => JsonResult::ok_empty(),
            Ok(status) => JsonResult::err(format!("tmutil failed with status {status}")),
            Err(e) => JsonResult::err(format!("tmutil error: {e}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = volume;
        JsonResult::err("APFS & Purgeable is only available on macOS")
    }
}

#[cfg(target_os = "macos")]
fn mount_points() -> Vec<String> {
    let mut mounts: Vec<String> = sysinfo::Disks::new_with_refreshed_list()
        .list()
        .iter()
        .map(|d| d.mount_point().to_string_lossy().into_owned())
        .collect();
    mounts.sort();
    mounts.dedup();
    mounts
}

/// Run a command, returning stdout as text.
#[cfg(target_os = "macos")]
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).output().ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    if s.trim().is_empty() {
        s = String::from_utf8_lossy(&out.stderr).into_owned();
    }
    Some(s)
}

/// Extract the XML element value that follows `<key>KEY</key>` in a plist,
/// e.g. `<key>PurgeableSpace</key><integer>123456</integer>`.
#[cfg(target_os = "macos")]
fn plist_key(plist: &str, key: &str) -> Option<String> {
    let needle = format!("<key>{}</key>", key);
    let pos = plist.find(&needle)? + needle.len();
    let after = plist[pos..].trim_start();
    let lt = after.find('<')?;
    let tag_end = after[lt + 1..].find('>')?;
    let tag = &after[lt + 1..lt + 1 + tag_end];
    let val_start = lt + 1 + tag_end + 1;
    let close = format!("</{}>", tag);
    let val_end = after[val_start..].find(&close)?;
    Some(after[val_start..val_start + val_end].to_string())
}

/// Local Time-Machine snapshots via `tmutil listlocalsnapshots`.
#[cfg(target_os = "macos")]
fn list_local_tm_snapshots(mount: &str) -> Vec<serde_json::Value> {
    let out = match run("tmutil", &["listlocalsnapshots", mount]) {
        Some(s) => s,
        None => return Vec::new(),
    };
    const PREFIX: &str = "com.apple.TimeMachine.";
    let mut snaps = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if let Some(idx) = line.find(PREFIX) {
            let name = line[idx..].trim().to_string();
            snaps.push(serde_json::json!({
                "name": name,
                "date": name[PREFIX.len()..].to_string(),
            }));
        }
    }
    snaps
}

/// APFS snapshots via `diskutil apfs listSnapshots` (best-effort parse; the
/// output is localized on some systems, so entries that can't be parsed are
/// skipped rather than guessed). Local TM snapshots are filtered out because
/// they are shown separately via tmutil.
#[cfg(target_os = "macos")]
fn list_snapshots(mount: &str) -> Vec<serde_json::Value> {
    let out = match run("diskutil", &["apfs", "listSnapshots", mount]) {
        Some(s) => s,
        None => return Vec::new(),
    };
    let mut snaps: Vec<serde_json::Value> = Vec::new();
    let mut uuid: Option<String> = None;
    let mut name: Option<String> = None;
    let mut date: Option<String> = None;
    let mut size: Option<u64> = None;
    for line in out.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("UUID:") {
            flush_snapshot(&mut snaps, &mut uuid, &mut name, &mut date, &mut size);
            uuid = Some(v.trim().to_string());
            name = None;
            date = None;
            size = None;
        } else if let Some(v) = line.strip_prefix("Name:") {
            name = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Create Date:") {
            date = Some(v.trim().to_string());
        } else if let Some(v) = line.strip_prefix("Size:") {
            size = parse_size(v.trim());
        }
    }
    flush_snapshot(&mut snaps, &mut uuid, &mut name, &mut date, &mut size);
    snaps
}

#[cfg(target_os = "macos")]
fn flush_snapshot(
    snaps: &mut Vec<serde_json::Value>,
    uuid: &mut Option<String>,
    name: &mut Option<String>,
    date: &mut Option<String>,
    size: &mut Option<u64>,
) {
    let uuid = uuid.take();
    let name = name.take();
    if uuid.is_none() && name.is_none() {
        return;
    }
    // Local TM snapshots are reported separately via tmutil.
    if name.as_deref().map_or(false, |n| n.starts_with("com.apple.TimeMachine.")) {
        return;
    }
    let size = size.take();
    snaps.push(serde_json::json!({
        "uuid": uuid,
        "name": name,
        "date": date.take(),
        "size_bytes": size,
    }));
}

/// Parse a human size like "1.2 GB" into bytes (best effort).
#[cfg(target_os = "macos")]
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim().to_ascii_lowercase();
    let (num, unit) = match s.split_once(' ') {
        Some((n, u)) => (n.trim(), u.trim()),
        None => (s.as_str(), ""),
    };
    let value: f64 = num.trim_end_matches('.').parse().ok()?;
    let mult = match unit {
        u if u.starts_with("tb") => 1024u64.pow(4),
        u if u.starts_with("gb") => 1024u64.pow(3),
        u if u.starts_with("mb") => 1024u64.pow(2),
        u if u.starts_with("kb") => 1024,
        _ => 1,
    };
    Some((value * mult as f64) as u64)
}
