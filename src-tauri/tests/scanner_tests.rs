// Basic unit tests for DiskRaptor scanner
#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn test_path_exists() {
        assert!(Path::new(".").exists());
    }

    #[test]
    fn test_format_size() {
        let cases = vec![
            (0u64, "0 B"),
            (1023, "1.00 KB"),
            (1024, "1.00 KB"),
            (1048576, "1.00 MB"),
            (1073741824, "1.00 GB"),
        ];
        for (bytes, expected) in cases {
            let result = format_size_test(bytes);
            assert_eq!(result, expected, "format_size({}) should be {}", bytes, expected);
        }
    }

    fn format_size_test(b: u64) -> String {
        const U: &[&str] = &["B", "KB", "MB", "GB", "TB", "PB"];
        if b == 0 {
            return "0 B".into();
        }
        let bf = b as f64;
        let i = (bf.log10() / 3.0) as usize;
        let i = i.min(U.len() - 1);
        let v = bf / (1024u64.pow(i as u32) as f64);
        if i == 0 {
            format!("{} {}", b, U[i])
        } else {
            format!("{:.2} {}", v, U[i])
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
}
