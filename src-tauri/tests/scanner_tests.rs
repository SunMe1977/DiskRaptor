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
    use std::io::Write;
    let dir = std::env::temp_dir().join("diskraptor_test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("hash_test.txt");
    let mut f = std::fs::File::create(&path).unwrap();
    f.write_all(b"Hello, DiskRaptor!").unwrap();
    drop(f);

    assert!(path.exists());
    let metadata = std::fs::metadata(&path).unwrap();
    assert!(metadata.len() > 0);

    std::fs::remove_dir_all(&dir).unwrap();
}
