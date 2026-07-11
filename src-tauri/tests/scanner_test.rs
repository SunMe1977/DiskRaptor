// DiskRaptor Scanner Integration Test
// Tests the scanner against a small temp directory (fast, reliable, cross-platform).
// Run with: cd src-tauri && cargo test --test scanner_test -- --nocapture

use std::path::PathBuf;
use std::sync::Arc;

fn make_test_dir(name: &str) -> PathBuf {
    let tmp = std::env::temp_dir().join("diskraptor_test").join(name);
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp.join("sub1")).unwrap();
    std::fs::create_dir_all(&tmp.join("sub1").join("sub2")).unwrap();
    std::fs::write(tmp.join("root.txt"), "hello root").unwrap();
    std::fs::write(tmp.join("sub1").join("a.rs"), "fn a() {}").unwrap();
    std::fs::write(tmp.join("sub1").join("b.rs"), "fn b() {}").unwrap();
    std::fs::write(tmp.join("sub1").join("sub2").join("c.rs"), "fn c() {}").unwrap();
    std::fs::write(tmp.join("data.bin"), &[0u8; 4096]).unwrap();
    tmp
}

fn scan_dir(root: &str) -> diskraptor_lib::scanner::walker::ScanResult {
    let cb: Box<dyn Fn(u64, u64, &str) + Send + Sync> = Box::new(|_, _, _| {});
    let config = diskraptor_lib::scanner::walker::ScanConfig {
        root_path: root.into(),
        skip_dirs: vec![],
        top_file_min_size: 0,
        top_files_count: 50,
    };
    diskraptor_lib::scanner::walker::scan_directory_with_progress(config, cb)
        .expect("Scan failed")
}

#[test]
fn test_scan_small_dir() {
    let tmp = make_test_dir("scan");
    let root = tmp.to_string_lossy().to_string();
    eprintln!("Testing scanner on: {}", root);

    let result = scan_dir(&root);
    eprintln!("Files: {}  Dirs: {}  Nodes: {}", result.stats.total_files, result.stats.total_dirs, result.arena.len());
    eprintln!("Top files: {}", result.stats.top_files.len());
    eprintln!("File types: {}", result.stats.file_type_breakdown.len());
    eprintln!("Scan time: {} ms", result.stats.scan_time_ms);
    eprintln!("Root size: {}", result.arena.nodes[0].size);

    assert!(result.arena.len() >= 4, "Expected >=4 nodes, got {}", result.arena.len());
    assert!(result.stats.total_files >= 3, "Expected >=3 files, got {}", result.stats.total_files);
    assert!(result.stats.total_dirs >= 2, "Expected >=2 dirs, got {}", result.stats.total_dirs);
    assert!(result.stats.top_files.len() > 0, "Expected top files");
    assert!(result.stats.file_type_breakdown.len() > 0, "Expected file type breakdown");
    assert!(result.stats.total_size > 0, "Expected total size > 0");

    let root_node = &result.arena.nodes[0];
    assert_eq!(root_node.parent, u32::MAX);
    assert!(root_node.file_count > 0);
    assert!(root_node.size > 0);

    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn test_chunking() {
    let tmp = make_test_dir("chunk");
    let root = tmp.to_string_lossy().to_string();
    let result = scan_dir(&root);

    let chunks = diskraptor_lib::streaming::chunker::chunk_tree(&result.arena)
        .expect("Chunking failed");
    assert!(!chunks.is_empty(), "Expected at least 1 chunk");
    eprintln!("Total chunks: {}", chunks.len());

    let root_in_chunk = chunks[0].nodes.iter().any(|n| n.parent == u32::MAX);
    assert!(root_in_chunk, "Chunk 0 must contain root node");

    let sum: usize = chunks.iter().map(|c| c.nodes.len()).sum();
    assert_eq!(sum as u32, result.arena.len() as u32);

    let root_info = diskraptor_lib::streaming::chunker::get_root_info(&result.arena);
    assert_eq!(root_info.total_nodes, result.arena.len() as u32);
    assert_eq!(root_info.total_chunks, chunks.len() as u32);

    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

#[test]
fn test_tree_linking() {
    let tmp = make_test_dir("linking");
    let root = tmp.to_string_lossy().to_string();
    let result = scan_dir(&root);
    let arena = &result.arena;

    for (i, node) in arena.nodes.iter().enumerate() {
        if i == 0 {
            assert_eq!(node.parent, u32::MAX, "Root's parent must be u32::MAX");
        } else {
            assert!(node.parent < arena.nodes.len() as u32,
                "Node {} has invalid parent {}", i, node.parent);
        }
        if node.first_child != u32::MAX {
            assert!(node.first_child < arena.nodes.len() as u32);
        }
        if node.next_sibling != u32::MAX {
            assert!(node.next_sibling < arena.nodes.len() as u32);
        }
    }
    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

#[test]
fn test_get_children() {
    let tmp = make_test_dir("children");
    let root = tmp.to_string_lossy().to_string();
    let result = scan_dir(&root);
    let arena = &result.arena;

    let mut children = Vec::new();
    let mut child = arena.nodes[0].first_child;
    while child != u32::MAX {
        children.push(arena.nodes[child as usize].clone());
        child = arena.nodes[child as usize].next_sibling;
    }

    assert!(children.len() >= 1, "Root must have >=1 child, got {}", children.len());
    eprintln!("Root has {} children", children.len());
    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

#[test]
fn test_format_size() {
    let size_str = diskraptor_lib::commands::test_format_size_dup(1024);
    assert_eq!(size_str, "1.00 KB",
        "Expected 1.00 KB, got '{}'", size_str);
    let size_str = diskraptor_lib::commands::test_format_size_dup(1048576);
    assert_eq!(size_str, "1.00 MB",
        "Expected 1.00 MB, got '{}'", size_str);
    let size_str = diskraptor_lib::commands::test_format_size_dup(0);
    assert_eq!(size_str, "0 B",
        "Expected 0 B, got '{}'", size_str);
    eprintln!("  ✓ test_format_size_dup works");
}
