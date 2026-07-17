use crate::scanner::tree::*;
use anyhow::Result;

/// Chunk size in number of nodes.
/// Optimal for transfer: ~10 000 nodes per chunk.
/// With ~56 bytes/node + string content, this is roughly 1–2 MB per chunk.
pub const CHUNK_SIZE: u32 = 10_000;

/// Splits the arena tree into ordered chunks for streaming to the UI.
///
/// The chunking uses a BFS order so that parent nodes reliably arrive before
/// their children — the UI can insert them immediately without back‑patching.
///
/// # Arguments
/// * `arena` - The completed arena tree.
///
/// # Returns
/// A vector of `TreeChunk` objects, each containing up to `CHUNK_SIZE` nodes.
pub fn chunk_tree(arena: &TreeNodeArena) -> Result<Vec<TreeChunk>> {
    let total = arena.nodes.len() as u32;
    let total_chunks = total.div_ceil(CHUNK_SIZE);
    let mut chunks = Vec::with_capacity(total_chunks as usize);

    // BFS order: process breadth‑first for parent‑before‑child guarantee
    let bfs_order = bfs_indices(arena);

    for chunk_id in 0..total_chunks {
        let start = (chunk_id * CHUNK_SIZE) as usize;
        let end = ((chunk_id + 1) * CHUNK_SIZE).min(total) as usize;

        let mut nodes: Vec<TreeNode> = Vec::with_capacity(end - start);
        for &idx in &bfs_order[start..end] {
            let mut node = arena.nodes[idx as usize].clone();
            node.chunk_id = chunk_id;
            nodes.push(node);
        }

        chunks.push(TreeChunk {
            chunk_id,
            total_chunks,
            total_nodes: total,
            nodes,
        });
    }

    Ok(chunks)
}

/// Generate BFS ordering of node indices.
/// Level‑by‑level traversal from the root (index 0).
fn bfs_indices(arena: &TreeNodeArena) -> Vec<u32> {
    let mut result = Vec::with_capacity(arena.nodes.len());

    // Simple BFS using a Vec as a queue
    let mut queue = Vec::with_capacity(arena.nodes.len());
    // Start from root (always index 0)
    if arena.nodes.is_empty() {
        return result;
    }
    queue.push(0u32);
    let mut head = 0;
    while head < queue.len() {
        let idx = queue[head];
        head += 1;
        result.push(idx);

        // Enqueue all children
        let node = &arena.nodes[idx as usize];
        let mut child = node.first_child;
        while child != u32::MAX {
            queue.push(child);
            child = arena.nodes[child as usize].next_sibling;
        }
    }

    result
}

/// Root node info sent to the UI immediately (before any chunk).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScanRootInfo {
    pub root_index: u32,
    pub total_nodes: u32,
    pub total_chunks: u32,
}

/// Get the root info for a scan result.
pub fn get_root_info(arena: &TreeNodeArena) -> ScanRootInfo {
    let total = arena.nodes.len() as u32;
    ScanRootInfo {
        root_index: 0,
        total_nodes: total,
        total_chunks: total.div_ceil(CHUNK_SIZE),
    }
}

/// Safe chunk generator for large trees — only creates root + first-level children.
/// Returns a single TreeChunk that fits on the stack.
pub fn make_root_chunk(arena: &TreeNodeArena) -> Vec<TreeChunk> {
    let total = arena.nodes.len() as u32;
    let mut nodes = Vec::new();
    // Root (index 0)
    if !arena.nodes.is_empty() {
        let mut root = arena.nodes[0].clone();
        root.chunk_id = 0;
        nodes.push(root);
        // First-level children
        let mut child = arena.nodes[0].first_child;
        while child != u32::MAX {
            let mut node = arena.nodes[child as usize].clone();
            node.chunk_id = 0;
            nodes.push(node);
            child = arena.nodes[child as usize].next_sibling;
        }
    }
    vec![TreeChunk {
        chunk_id: 0,
        total_chunks: 1,
        total_nodes: total,
        nodes,
    }]
}
