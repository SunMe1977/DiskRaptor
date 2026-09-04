// Integration tests for the DiskRaptor scanner library.
use diskraptor_scanner::scanner::tree::format_size;

#[test]
fn test_format_size_known_values() {
    let cases = vec![
        (0u64, "0 B"),
        (1, "1 B"),
        (1023, "1023 B"),
        (1024, "1.00 KB"),
        (1536, "1.50 KB"),
        (1048576, "1.00 MB"),
        (5 * 1048576, "5.00 MB"),
        (1073741824, "1.00 GB"),
        (2 * 1073741824, "2.00 GB"),
        (1099511627776, "1.00 TB"),
    ];
    for (bytes, expected) in cases {
        let result = format_size(bytes);
        assert_eq!(result, expected, "format_size({}) should be {}", bytes, expected);
    }
}

#[test]
fn test_format_size_monotonic() {
    // Larger inputs must never report a smaller value when parsed back.
    fn parse(s: &str) -> f64 {
        let mut it = s.split(' ');
        let val: f64 = it.next().and_then(|v| v.parse().ok()).unwrap_or(0.0);
        let unit = it.next().unwrap_or("B");
        let mult = match unit {
            "B" => 1.0,
            "KB" => 1024.0,
            "MB" => 1024.0f64.powi(2),
            "GB" => 1024.0f64.powi(3),
            "TB" => 1024.0f64.powi(4),
            "PB" => 1024.0f64.powi(5),
            _ => 1.0,
        };
        val * mult
    }
    let mut prev: f64 = 0.0;
    for bytes in (0..10_000_000).step_by(137) {
        let parsed = parse(&format_size(bytes));
        assert!(
            parsed >= prev,
            "format_size({}) = {:?} is not monotonic",
            bytes,
            format_size(bytes)
        );
        prev = parsed;
    }
}

#[test]
fn test_quick_hash_consistency() {
    use diskraptor_scanner::scanner::duplicates::{hash_file_full, hash_file_head, HEAD_HASH_BYTES};
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("diskraptor_hash_test_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hash_test.txt");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(b"Hello, DiskRaptor!").unwrap();
    drop(f);

    // The head hash of a small file reads the whole file and must be non-zero.
    let (read, head) = hash_file_head(&path, HEAD_HASH_BYTES);
    assert_eq!(read, b"Hello, DiskRaptor!".len() as u64);
    assert_ne!(head, 0, "head hash of a non-empty file must not be zero");

    // Full stream hash must agree with the head hash for a tiny file.
    let (fsize, full, changed) = hash_file_full(&path);
    assert_eq!(fsize, read);
    assert!(!changed, "unchanged file must not report changed_during_scan");
    assert_eq!(full, head, "head and full hash must agree for a small file");

    // Identical content → identical hash; different content → different hash.
    let copy = dir.join("hash_test_copy.txt");
    std::fs::write(&copy, b"Hello, DiskRaptor!").unwrap();
    let (_, copy_full, _) = hash_file_full(&copy);
    assert_eq!(full, copy_full, "identical files must hash identically");
    std::fs::write(&copy, b"Hello, DiskRaptor?").unwrap();
    let (_, changed_full, _) = hash_file_full(&copy);
    assert_ne!(full, changed_full, "different content must hash differently");

    let _ = std::fs::remove_dir_all(&dir);
}
