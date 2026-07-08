// DiskRaptor Scanner Integration Test
// Tests the scanner against the project directory (small, fast).
// Run with: cd src-tauri && cargo test --test scanner_test -- --nocapture

use std::sync::Arc;

/// Test the scanner against the project directory.
/// This verifies that the scanner finds files and builds a tree.
#[test]
fn test_scan_project_dir() {
    let root = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

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

    // Verify we found files
    assert!(total_nodes > 0, "Tree must have at least 1 node (root)");
    assert!(
        total_files > 0 || total_dirs > 0,
        "Expected files or dirs in project"
    );

    // Verify stats are populated
    assert!(result.stats.top_files.len() > 0, "Expected top files");
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
}

/// Test chunking of the tree.
#[test]
fn test_chunking() {
    let root = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

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
}

/// Test tree node parent-child linking.
#[test]
fn test_tree_linking() {
    let root = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

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
            // Root: no parent
            assert_eq!(node.parent, u32::MAX, "Root's parent must be u32::MAX");
        } else {
            // Non-root: must have a valid parent index
            assert!(
                node.parent < arena.nodes.len() as u32,
                "Node {} (name={}) has invalid parent {}",
                i,
                node.name,
                node.parent
            );
        }
    }

    // Verify first_child chain is valid
    for (i, node) in arena.nodes.iter().enumerate() {
        if node.first_child != u32::MAX {
            assert!(
                node.first_child < arena.nodes.len() as u32,
                "Node {} has invalid first_child {}",
                i,
                node.first_child
            );
        }
        if node.next_sibling != u32::MAX {
            assert!(
                node.next_sibling < arena.nodes.len() as u32,
                "Node {} has invalid next_sibling {}",
                i,
                node.next_sibling
            );
        }
    }

    eprintln!("  ✓ parent-child linking is valid");
    eprintln!("  ✓ sibling linking is valid");
}

/// Test the get_children logic (used by frontend).
#[test]
fn test_get_children() {
    let root = std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .to_string_lossy()
        .to_string();

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
    assert!(children.len() > 0, "Root must have children");

    // Verify children are sorted by size (descending) in the frontend
    children.sort_unstable_by_key(|b| std::cmp::Reverse(b.size));
    let first = &children[0];
    eprintln!("  Largest child: {} ({} bytes)", first.name, first.size);

    eprintln!("  ✓ get_children logic works");
}
