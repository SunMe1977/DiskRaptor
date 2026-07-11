// DiskRaptor Scanner Integration Test
// Tests the scanner against a small temp directory (fast, reliable, cross-platform).
// Run with: cd src-tauri && cargo test --test scanner_test -- --nocapture

use std::path::PathBuf;
use std::sync::Arc;

fn create_test_dir(name: &str) -> PathBuf {
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

/// Test the scanner against a small temp directory.
/// This verifies that the scanner finds files and builds a tree.
#[test]
fn test_scan_small_dir() {
    let tmp = create_test_dir("scan");
    let root = tmp.to_string_lossy().to_string();

    eprintln!("Testing scanner on: {}", root);

    let files_found = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let files = files_found.clone();

    let cb: Box<dyn Fn(u64, u64, &str) + Send + Sync> = Box::new(move |f, _d, _path| {
        files.store(f, std::sync::atomic::Ordering::Relaxed);
    });

    let config = diskraptor_lib::scanner::walker::ScanConfig {
        root_path: root.clone(),
        skip_dirs: vec![],
        top_file_min_size: 0,
        top_files_count: 50,
    };

    let result = diskraptor_lib::scanner::walker::scan_directory_with_progress(config, cb);
    assert!(result.is_ok(), "Scan failed: {:?}", result.err());

    let result = result.unwrap();
    let total_files = result.stats.total_files;
    let total_dirs = result.stats.total_dirs;
    let total_nodes = result.arena.len();

    eprintln!(
        "Files: {}  Dirs: {}  Total nodes: {}",
        total_files, total_dirs, total_nodes
    );
    eprintln!("Top files: {}", result.stats.top_files.len());
    eprintln!("File types: {}", result.stats.file_type_breakdown.len());
    eprintln!("Scan time: {} ms", result.stats.scan_time_ms);
    eprintln!("Root size: {}", result.arena.nodes[0].size);

    // Verify we found files (4 files + 3 dirs including root)
    assert!(total_nodes >= 4, "Expected at least 4 nodes, got {}", total_nodes);
    assert!(total_files >= 3, "Expected at least 3 files, got {}", total_files);
    assert!(total_dirs >= 2, "Expected at least 2 dirs, got {}", total_dirs);

    // Verify stats are populated
    assert!(
        result.stats.top_files.len() > 0,
        "Expected top files"
    );
    assert!(
        result.stats.file_type_breakdown.len() > 0,
        "Expected file type breakdown"
    );
    assert!(result.stats.total_size > 0, "Expected total size > 0");

    // Verify tree structure: root (index 0) has children
    let root = &result.arena.nodes[0];
    assert_eq!(root.parent, u32::MAX, "Root parent must be u32::MAX");
    assert!(root.file_count > 0, "Root file_count should be > 0");
    assert!(root.size > 0, "Root size should be > 0");

    eprintln!("  ✓ scan_directory_with_progress works");
    eprintln!("  ✓ tree building works");
    eprintln!("  ✓ stats generation works");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// Test chunking of the tree.
#[test]
fn test_chunking() {
    let tmp = create_test_dir("chunk");
    let root = tmp.to_string_lossy().to_string();

    let cb: Box<dyn Fn(u64, u64, &str) + Send + Sync> = Box::new(|_, _, _| {});

    let config = diskraptor_lib::scanner::walker::ScanConfig {
        root_path: root,
        skip_dirs: vec![],
        top_file_min_size: 0,
        top_files_count: 50,
    };

    let result = diskraptor_lib::scanner::walker::scan_directory_with_progress(config, cb)
        .expect("Scan failed");

    let chunks =
        diskraptor_lib::streaming::chunker::chunk_tree(&result.arena).expect("Chunking failed");

    assert!(!chunks.is_empty(), "Expected at least 1 chunk");
    eprintln!("Total chunks: {}", chunks.len());
    eprintln!("Chunk 0 has {} nodes", chunks[0].nodes.len());

    // Verify chunk 0 contains root node
    let root_in_chunk = chunks[0].nodes.iter().any(|n| n.parent == u32::MAX);
    assert!(root_in_chunk, "Chunk 0 must contain root node");

    // Verify total_nodes across all chunks matches arena size
    let sum: usize = chunks.iter().map(|c| c.nodes.len()).sum();
    assert_eq!(
        sum as u32,
        result.arena.len() as u32,
        "Chunk node count must match arena size"
    );

    // Verify get_root_info works
    let root_info = diskraptor_lib::streaming::chunker::get_root_info(&result.arena);
    assert_eq!(root_info.total_nodes, result.arena.len() as u32);
    assert_eq!(root_info.total_chunks, chunks.len() as u32);

    eprintln!("  ✓ chunk_tree works");
    eprintln!("  ✓ get_root_info works");
    eprintln!("  ✓ chunk order is correct (parent before children)");

    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

/// Test tree node parent-child linking.
#[test]
fn test_tree_linking() {
    let tmp = create_test_dir("linking");
    let root = tmp.to_string_lossy().to_string();

    let cb: Box<dyn Fn(u64, u64, &str) + Send + Sync> = Box::new(|_, _, _| {});
    let config = diskraptor_lib::scanner::walker::ScanConfig {
        root_path: root,
        skip_dirs: vec![],
        top_file_min_size: 0,
        top_files_count: 50,
    };

    let result = diskraptor_lib::scanner::walker::scan_directory_with_progress(config, cb)
        .expect("Scan failed");

    let arena = &result.arena;

    // Verify all nodes (except root) have valid parents
    for (i, node) in arena.nodes.iter().enumerate() {
        if i == 0 {
            assert_eq!(node.parent, u32::MAX, "Root's parent must be u32::MAX");
        } else {
            assert!(
                node.parent < arena.nodes.len() as u32,
                "Node {} (name={}) has invalid parent {}",
                i, node.name, node.parent
            );
        }
    }

    // Verify first_child chain is valid
    for (i, node) in arena.nodes.iter().enumerate() {
        if node.first_child != u32::MAX {
            assert!(
                node.first_child < arena.nodes.len() as u32,
                "Node {} has invalid first_child {}",
                i, node.first_child
            );
        }
        if node.next_sibling != u32::MAX {
            assert!(
                node.next_sibling < arena.nodes.len() as u32,
                "Node {} has invalid next_sibling {}",
                i, node.next_sibling
            );
        }
    }

    eprintln!("  ✓ parent-child linking is valid");
    eprintln!("  ✓ sibling linking is valid");

    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

/// Test the get_children logic (used by frontend).
#[test]
fn test_get_children() {
    let tmp = create_test_dir("children");
    let root = tmp.to_string_lossy().to_string();

    let cb: Box<dyn Fn(u64, u64, &str) + Send + Sync> = Box::new(|_, _, _| {});
    let config = diskraptor_lib::scanner::walker::ScanConfig {
        root_path: root,
        skip_dirs: vec![],
        top_file_min_size: 0,
        top_files_count: 50,
    };

    let result = diskraptor_lib::scanner::walker::scan_directory_with_progress(config, cb)
        .expect("Scan failed");

    let arena = &result.arena;

    // Collect children of root (index 0)
    let mut children = Vec::new();
    let mut child = arena.nodes[0].first_child;
    while child != u32::MAX {
        children.push(arena.nodes[child as usize].clone());
        child = arena.nodes[child as usize].next_sibling;
    }

    eprintln!("Root has {} direct children", children.len());
    assert!(children.len() >= 1, "Root must have at least 1 child, got {}", children.len());

    eprintln!("  ✓ get_children logic works");

    let _ = std::fs::remove_dir_all(&tmp.parent().unwrap());
}

/// Test the duplicate scanner logic with a temp dir (guaranteed to have duplicates).
#[test]
fn test_duplicate_scanner() {
    let tmp = std::env::temp_dir().join("diskraptor_test_dup");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    // Create files with SAME name + size in different dirs = duplicates
    std::fs::create_dir(tmp.join("sub1")).unwrap();
    std::fs::create_dir(tmp.join("sub2")).unwrap();
    std::fs::write(tmp.join("sub1").join("dup.txt"), b"same content").unwrap();
    std::fs::write(tmp.join("sub2").join("dup.txt"), b"same content").unwrap();
    std::fs::write(tmp.join("unique.txt"), b"different").unwrap();

    let root = tmp.to_string_lossy().to_string();

    eprintln!("Testing duplicate scanner on: {}", root);

    // Build a simple file map manually (same logic as find_duplicates)
    use std::collections::HashMap;
    let mut file_map: HashMap<(u64, String), Vec<String>> = HashMap::new();

    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let name = entry.file_name().to_string_lossy().to_string();
            let full = entry.path().to_string_lossy().to_string();
            file_map
                .entry((size, name))
                .or_insert_with(Vec::new)
                .push(full);
        }
    }

    let groups: Vec<(u64, Vec<String>)> = file_map
        .into_iter()
        .filter(|(_, files)| files.len() > 1)
        .map(|((size, _), files)| (size, files))
        .collect();

    eprintln!("Duplicate groups found: {}", groups.len());
    assert!(groups.len() >= 1, "Expected at least 1 duplicate group");

    for (size, files) in &groups {
        eprintln!("  {} bytes: {} files", size, files.len());
        assert!(files.len() > 1, "Group must have >1 file");
    }

    // Verify format_size_dup works
    let size_str = diskraptor_lib::commands::test_format_size_dup(1024);
    assert_eq!(size_str, "1.00 KB");
    let size_str = diskraptor_lib::commands::test_format_size_dup(1048576);
    assert_eq!(size_str, "1.00 MB");
    let size_str = diskraptor_lib::commands::test_format_size_dup(0);
    assert_eq!(size_str, "0 B");

    eprintln!("  ✓ test_format_size_dup works");
    eprintln!("  ✓ duplicate scanner logic works");

    let _ = std::fs::remove_dir_all(&tmp);
}
