use serde::{Deserialize, Serialize};
use std::fmt;

/// Compact node type — stored as a single byte.
/// Serialized as integer (0=directory, 1=file) for the JS frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum NodeType {
    Directory = 0,
    File = 1,
}

impl serde::Serialize for NodeType {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(*self as u8)
    }
}

impl<'de> serde::Deserialize<'de> for NodeType {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match u8::deserialize(deserializer)? {
            0 => Ok(NodeType::Directory),
            1 => Ok(NodeType::File),
            v => Err(serde::de::Error::custom(format!(
                "invalid node type: {}",
                v
            ))),
        }
    }
}

impl fmt::Display for NodeType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            NodeType::Directory => write!(f, "directory"),
            NodeType::File => write!(f, "file"),
        }
    }
}

/// A single node in the arena‑allocated tree.
/// All child/sibling references are indices into the arena (`Vec<Node>`).
/// This avoids per‑node `Box`/`Rc` overhead and keeps memory contiguous
/// for cache‑friendly traversal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNode {
    /// File or directory name (not the full path)
    pub name: String,
    /// Total size in bytes (aggregated for directories)
    pub size: u64,
    /// Number of files in this subtree (1 for files)
    pub file_count: u64,
    /// Number of directories in this subtree (1 for directories)
    pub dir_count: u64,
    /// Node type discriminator
    pub node_type: NodeType,
    /// Parent index in the arena. `u32::MAX` = root.
    pub parent: u32,
    /// Index of the first child. `u32::MAX` = none.
    pub first_child: u32,
    /// Index of the next sibling. `u32::MAX` = none.
    pub next_sibling: u32,
    /// Depth in the tree (0 = root)
    pub depth: u16,
    /// Chunk identifier – which serialisation chunk this node belongs to
    pub chunk_id: u32,
    /// Last modification time (Unix epoch seconds). 0 = unknown/not set.
    pub mtime: u64,
}

impl TreeNode {
    pub fn is_directory(&self) -> bool {
        self.node_type == NodeType::Directory
    }

    pub fn is_file(&self) -> bool {
        self.node_type == NodeType::File
    }

    /// Human‑readable size string
    pub fn size_human(&self) -> String {
        format_size(self.size)
    }
}

/// Arena‑allocated tree that can hold millions of nodes.
/// Memory: ~56 bytes per node + string storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeNodeArena {
    pub nodes: Vec<TreeNode>,
}

impl TreeNodeArena {
    pub fn new() -> Self {
        Self { nodes: Vec::new() }
    }

    pub fn with_capacity(cap: usize) -> Self {
        Self {
            nodes: Vec::with_capacity(cap),
        }
    }

    /// Estimate a reasonable initial capacity based on filesystem size.
    /// Uses a default of 1M if the path can't be probed.
    pub fn with_estimated_capacity(root_path: &str) -> Self {
        let cap = estimate_node_capacity(root_path);
        Self { nodes: Vec::with_capacity(cap) }
    }

    /// Allocate a new node and return its index.
    pub fn alloc(&mut self, node: TreeNode) -> u32 {
        let idx = self.nodes.len() as u32;
        self.nodes.push(node);
        idx
    }

    /// Borrow a node by index.
    pub fn get(&self, idx: u32) -> &TreeNode {
        &self.nodes[idx as usize]
    }

    pub fn get_mut(&mut self, idx: u32) -> &mut TreeNode {
        &mut self.nodes[idx as usize]
    }

    /// Total capacity in bytes (approximate)
    pub fn approx_heap_bytes(&self) -> usize {
        self.nodes.capacity() * std::mem::size_of::<TreeNode>()
            + self.nodes.iter().map(|n| n.name.capacity()).sum::<usize>()
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/// Try to estimate number of files/dirs in a tree from filesystem info.
fn estimate_node_capacity(root_path: &str) -> usize {
    // Default: 1M nodes
    let mut cap = 1_000_000usize;
    // Try to get filesystem block count as a proxy for file density
    if let Ok(_meta) = std::fs::metadata(root_path) {
        // Use available space as rough proxy: less free space = more files
        // Typically a modern drive has ~100K-10M files
        cap = 2_000_000;
    }
    // Clamp between 100K and 20M
    cap.clamp(100_000, 20_000_000)
}

/// Format bytes to a human-readable string.
pub fn format_size(bytes: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB", "PB"];
    if bytes == 0 {
        return "0 B".into();
    }
    let bytes_f = bytes as f64;
    // Binary units: use log2 so the unit index matches powers of 1024.
    let unit_idx = (bytes_f.log2() / 10.0).floor() as usize;
    let unit_idx = unit_idx.min(UNITS.len() - 1);
    let value = bytes_f / (1024u64.pow(unit_idx as u32) as f64);
    if unit_idx == 0 {
        format!("{} {}", bytes, UNITS[unit_idx])
    } else {
        format!("{:.2} {}", value, UNITS[unit_idx])
    }
}

// ── Serialisation wrappers ──────────────────────────────────────────────────

/// A chunk of tree data sent to the UI.
/// The UI can insert these nodes into its own virtual tree.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TreeChunk {
    pub chunk_id: u32,
    pub total_chunks: u32,
    pub total_nodes: u32,
    /// Arena index of the first node in this chunk (lets the UI place nodes
    /// without assuming a fixed chunk size).
    pub start_index: u32,
    pub nodes: Vec<TreeNode>,
}

/// Summary statistics for a scan.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanStats {
    pub total_files: u64,
    pub total_dirs: u64,
    pub total_size: u64,
    pub scan_time_ms: u64,
    pub top_files: Vec<TopFileEntry>,
    pub file_type_breakdown: Vec<FileTypeCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopFileEntry {
    pub path: String,
    pub size: u64,
    pub size_human: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTypeCount {
    pub extension: String,
    pub count: u64,
    pub total_size: u64,
    pub size_human: String,
}

impl Default for TreeNodeArena {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_node(name: &str, size: u64, node_type: NodeType) -> TreeNode {
        TreeNode {
            name: name.into(),
            size,
            file_count: if node_type == NodeType::File { 1 } else { 0 },
            dir_count: if node_type == NodeType::Directory { 1 } else { 0 },
            node_type,
            parent: u32::MAX,
            first_child: u32::MAX,
            next_sibling: u32::MAX,
            depth: 0,
            chunk_id: 0,
            mtime: 0,
        }
    }

    #[test]
    fn test_arena_empty() {
        let arena = TreeNodeArena::new();
        assert!(arena.is_empty());
        assert_eq!(arena.len(), 0);
    }

    #[test]
    fn test_arena_alloc_one() {
        let mut arena = TreeNodeArena::new();
        let idx = arena.alloc(make_node("root", 0, NodeType::Directory));
        assert_eq!(idx, 0);
        assert_eq!(arena.len(), 1);
    }

    #[test]
    fn test_arena_alloc_multiple() {
        let mut arena = TreeNodeArena::with_capacity(10);
        let r = arena.alloc(make_node("root", 0, NodeType::Directory));
        let c1 = arena.alloc(make_node("a.txt", 100, NodeType::File));
        let c2 = arena.alloc(make_node("b.txt", 200, NodeType::File));
        assert_eq!(r, 0);
        assert_eq!(c1, 1);
        assert_eq!(c2, 2);
        assert_eq!(arena.len(), 3);
    }

    #[test]
    fn test_arena_get_node() {
        let mut arena = TreeNodeArena::new();
        arena.alloc(make_node("root", 0, NodeType::Directory));
        let node = arena.get(0);
        assert_eq!(node.name, "root");
        assert!(node.is_directory());
    }

    #[test]
    fn test_arena_get_mut() {
        let mut arena = TreeNodeArena::new();
        arena.alloc(make_node("root", 0, NodeType::Directory));
        arena.get_mut(0).size = 999;
        assert_eq!(arena.get(0).size, 999);
    }

    #[test]
    fn test_node_is_file() {
        let f = make_node("f", 10, NodeType::File);
        assert!(f.is_file());
        assert!(!f.is_directory());
    }

    #[test]
    fn test_node_size_human() {
        let f = make_node("f", 1024, NodeType::File);
        assert_eq!(f.size_human(), "1.00 KB");
    }

    #[test]
    fn test_format_size_zero() {
        assert_eq!(format_size(0), "0 B");
    }

    #[test]
    fn test_format_size_kb() {
        assert_eq!(format_size(2048), "2.00 KB");
    }

    #[test]
    fn test_format_size_mb() {
        assert_eq!(format_size(5 * 1024 * 1024), "5.00 MB");
    }

    #[test]
    fn test_arena_with_capacity() {
        let arena = TreeNodeArena::with_capacity(50_000);
        assert!(arena.nodes.capacity() >= 50_000);
    }

    #[test]
    fn test_approx_heap_bytes() {
        let mut arena = TreeNodeArena::new();
        arena.alloc(make_node("hello.txt", 100, NodeType::File));
        assert!(arena.approx_heap_bytes() > 0);
    }
}
