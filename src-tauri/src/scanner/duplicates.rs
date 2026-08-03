//! Shared duplicate-file detection used by both the Tauri command layer and
//! the legacy C FFI (`scanner_api`).
use std::path::{Path, PathBuf};

use crate::scanner::tree::format_size;

/// Number of leading bytes hashed for duplicate detection. Cheap enough for
/// hundreds of thousands of files, accurate after the size pre-filter.
pub const HEAD_HASH_BYTES: usize = 1 << 20;

/// Hash the first `read_len` bytes of a file.
/// Returns `(bytes_read, xxh3_64 hash)`; `(0, 0)` when the file can't be read.
pub fn hash_file_head(path: &Path, read_len: usize) -> (u64, u64) {
    use std::io::Read;
    let mut buf = vec![0u8; read_len];
    let mut n = 0usize;
    if let Ok(mut f) = std::fs::File::open(path) {
        n = f.read(&mut buf).unwrap_or(0);
    }
    buf.truncate(n);
    (n as u64, xxhash_rust::xxh3::xxh3_64(&buf))
}

/// Synchronous duplicate scan: groups files by size, then hashes same-sized
/// candidates. Returns `(groups, total_files_scanned, wasted_bytes)`.
pub fn find_duplicate_groups(root: &str) -> (Vec<serde_json::Value>, u64, u64) {
    use std::collections::HashMap;

    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        total += 1;
        by_size.entry(size).or_default().push(entry.path().to_path_buf());
    }

    let mut groups: Vec<serde_json::Value> = Vec::new();
    let mut wasted: u64 = 0;
    for (size, files) in by_size {
        if files.len() < 2 {
            continue;
        }
        let mut by_hash: HashMap<(u64, u64), Vec<PathBuf>> = HashMap::new();
        for p in &files {
            let h = hash_file_head(p, HEAD_HASH_BYTES);
            by_hash.entry(h).or_default().push(p.clone());
        }
        for ((_len, _h), dup_files) in by_hash {
            if dup_files.len() < 2 {
                continue;
            }
            let wasted_g = size * (dup_files.len() as u64 - 1);
            wasted += wasted_g;
            let paths: Vec<String> = dup_files
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            groups.push(serde_json::json!({
                "count": dup_files.len(),
                "size": size,
                "sizeHuman": format_size(size),
                "wasted": wasted_g,
                "wastedHuman": format_size(wasted_g),
                "files": paths,
            }));
        }
    }
    (groups, total, wasted)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("diskraptor_dups_test").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture_file(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    #[test]
    fn test_hash_file_head_consistency() {
        let dir = fixture_dir("hash");
        let p = fixture_file(&dir, "h.txt", b"DiskRaptor");
        let a = hash_file_head(&p, 4096);
        let b = hash_file_head(&p, 4096);
        assert_eq!(a, b);
        assert_eq!(a.0, b"DiskRaptor".len() as u64);
        assert_ne!(a.1, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_find_duplicate_groups_detects_copies() {
        let dir = fixture_dir("groups");
        fixture_file(&dir, "a.txt", b"same content");
        fixture_file(&dir, "b.txt", b"same content");
        fixture_file(&dir, "c.txt", b"different");
        let (groups, total, wasted) = find_duplicate_groups(&dir.to_string_lossy());
        assert_eq!(total, 3);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0]["count"].as_u64().unwrap(), 2);
        assert!(wasted > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
