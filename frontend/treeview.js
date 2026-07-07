/**
 * TreeView — Virtual tree view for the directory hierarchy.
 *
 * Maintains expand/collapse state and builds a flat visible list
 * via pre‑order traversal. Uses VirtualScroll for rendering.
 * Children are loaded lazily from the backend on expand.
 */
class TreeView {
  constructor(containerId, chunkLoader) {
    this.loader = chunkLoader;

    /** Flat list of arena indices in display order */
    this.visibleNodes = [];

    /** Set of expanded arena indices */
    this.expanded = new Set();

    /** Currently selected arena index */
    this.selectedIndex = null;

    /** Callback: onSelect(arenaIndex) */
    this.onSelect = null;

    /** Max size among visible nodes (for proportional bars) */
    this.maxSize = 0;

    this._initScroll();
  }

  _initScroll() {
    const scrollEl = document.getElementById("tree-scroll");
    this.vs = new VirtualScroll(scrollEl, {
      estimatedRowHeight: 26,
      overscan: 15,
      renderCell: (index, el) => this._renderRow(index, el),
    });
  }

  /** Rebuild the visible node list from root (= index 0). */
  async rebuild() {
    this.visibleNodes = [];
    try {
      await this._buildList(0, 0);
    } catch (e) {
      console.warn('Tree rebuild _buildList error:', e);
    }

    // Calculate max size for proportional bars
    this.maxSize = 0;
    for (const idx of this.visibleNodes) {
      const node = this.loader.getNode(idx);
      if (node && node.size > this.maxSize) this.maxSize = node.size;
    }

    const totalItems = this.visibleNodes.length;
    const totalHeight = totalItems * 26;
    this.vs.setTotalItems(totalItems, totalHeight);
    this.vs.refresh();

    const nc = document.getElementById("node-count");
    if (nc) nc.textContent = totalItems.toLocaleString() + ' shown';

    const statusEl = document.querySelector("#tree-panel .status-bar");
    if (statusEl) statusEl.textContent = 'Root • ' + totalItems + ' item' + (totalItems === 1 ? '' : 's') + ' visible';
  }

  /** Recursive pre‑order traversal building the visible flat list. */
  async _buildList(arenaIdx, depth) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    this.visibleNodes.push(arenaIdx);

    const isDir = node.node_type === "Directory" || node.node_type === 0;
    if (isDir && this.expanded.has(arenaIdx)) {
      // Try to get children from already-loaded chunks
      let children = this.loader.getChildrenIndices(arenaIdx);

      // If not yet loaded, fetch from backend and register them
      if (children.length === 0) {
        const rawNodes = await this.loader.fetchChildren(arenaIdx);
        if (rawNodes && rawNodes.length > 0) {
          // The backend returns TreeNode objects. We need to map them
          // into our parentMap by finding their arenaIndex in allNodes.
          // Since chunks use BFS, we search allNodes sequentially.
          const indices = [];
          for (const rawNode of rawNodes) {
            const foundIdx = this._findNodeByNameAndParent(
              rawNode.name,
              rawNode.size,
              arenaIdx,
            );
            if (foundIdx !== null) {
              indices.push(foundIdx);
            }
          }
          if (indices.length > 0) {
            this.loader.parentMap.set(arenaIdx, indices);
            children = indices;
          } else {
            // Fallback: the chunks may not be loaded yet.
            // We'll just show the node names from fetchChildren directly
            // by allocating temporary indices.
            children = this._registerTemporaryChildren(arenaIdx, rawNodes);
          }
        }
      }

      // Sort by size descending
      const sorted = [...children].sort((a, b) => {
        const na = this.loader.getNode(a);
        const nb = this.loader.getNode(b);
        return (nb ? nb.size : 0) - (na ? na.size : 0);
      });

      for (const childIdx of sorted) {
        const childNode = this.loader.getNode(childIdx);
        if (childNode) {
          await this._buildList(childIdx, depth + 1);
        }
      }
    }
  }

  /** Try to find a node by name + parent in allNodes. */
  _findNodeByNameAndParent(name, size, parentIdx) {
    const candidates = this.loader.parentMap.get(parentIdx);
    if (candidates) {
      for (const idx of candidates) {
        const n = this.loader.getNode(idx);
        if (n && n.name === name && n.size === size) return idx;
      }
    }
    // Brute-force as fallback
    for (let i = 0; i < this.loader.allNodes.length; i++) {
      const n = this.loader.allNodes[i];
      if (n && n.parent === parentIdx && n.name === name && n.size === size) {
        return i;
      }
    }
    return null;
  }

  /** Register children returned by fetchChildren as temporary nodes. */
  _registerTemporaryChildren(parentIdx, rawNodes) {
    const indices = [];
    for (const raw of rawNodes) {
      // Try to find in allNodes first
      let found = this._findNodeByNameAndParent(raw.name, raw.size, parentIdx);
      if (found === null) {
        // Insert into allNodes at the first free slot
        const idx = this.loader.allNodes.length;
        raw._arenaIndex = idx;
        this.loader.allNodes.push(raw);
        found = idx;
      }
      indices.push(found);
    }
    this.loader.parentMap.set(parentIdx, indices);
    return indices;
  }

  /** Toggle expand/collapse. */
  async toggleExpand(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    const isDir = node.node_type === "Directory" || node.node_type === 0;
    if (!isDir) return;

    if (this.expanded.has(arenaIdx)) {
      this.expanded.delete(arenaIdx);
    } else {
      this.expanded.add(arenaIdx);
      // Preload the next few chunks to make children available
      await this._ensureChildrenChunks(arenaIdx);
    }

    await this.rebuild();
  }

  /** Pre‑load the chunks that contain children of this node. */
  async _ensureChildrenChunks(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node || !this.loader.allNodes) return;
    // Estimate the child chunk: children are stored right after the parent
    // in BFS order. Load the next 3 chunks to be safe.
    const parentPos = this.loader.allNodes.indexOf(node);
    if (parentPos >= 0) {
      const startChunk = Math.floor((parentPos + 1) / 10000);
      await this.loader.ensureChunks(
        startChunk,
        Math.min(startChunk + 3, this.loader.totalChunks),
      );
    }
  }

  /** Select a node and update the detail panel. */
  select(arenaIdx) {
    this.selectedIndex = arenaIdx;

    const pos = this.visibleNodes.indexOf(arenaIdx);
    if (pos >= 0) {
      this.vs.scrollToIndex(pos);
      this.vs.refresh();
    }

    this._updateSelection();
    if (this.onSelect) this.onSelect(arenaIdx);
  }

  /** Render a single row via virtual scroll. */
  _renderRow(index, el) {
    const arenaIdx = this.visibleNodes[index];
    if (arenaIdx === undefined) return;

    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    const depth = this._computeDepth(arenaIdx);
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    const isExpanded = this.expanded.has(arenaIdx);

    // Reset element for recycling
    el.innerHTML = "";
    el.className = "tree-row";
    el.dataset.index = arenaIdx;

    if (arenaIdx === this.selectedIndex) {
      el.classList.add("selected");
    }

    el.onclick = (e) => {
      const toggle = e.target.closest(".toggle");
      if (toggle) {
        this.toggleExpand(arenaIdx);
        return;
      }
      this.select(arenaIdx);
    };

    // ── Build row DOM ──

    // Indent
    const indent = document.createElement("span");
    indent.className = "indent";
    indent.style.width = `${depth * 18}px`;
    el.appendChild(indent);

    // Toggle arrow
    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = isDir ? (isExpanded ? "▼" : "▶") : "";
    el.appendChild(toggle);

    // Icon
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = isDir ? (isExpanded ? "📂" : "📁") : "📄";
    el.appendChild(icon);

    // Name
    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = node.name || "(root)";
    el.appendChild(name);

    // Size
    const size = document.createElement("span");
    size.className = "node-size";
    size.textContent = this._formatSize(node.size);
    el.appendChild(size);

    // Size bar
    const bar = document.createElement("span");
    bar.className = "node-bar";
    const fill = document.createElement("span");
    fill.className = "node-bar-fill";
    const pct = this.maxSize > 0 ? (node.size / this.maxSize) * 100 : 0;
    fill.style.width = `${Math.max(2, pct)}%`;
    fill.style.background = isDir ? "var(--accent)" : "var(--accent-green)";
    bar.appendChild(fill);
    el.appendChild(bar);
  }

  /** Compute depth by walking up the parent chain. */
  _computeDepth(arenaIdx) {
    let depth = 0;
    let cur = arenaIdx;
    let safety = 0;
    while (cur !== 0 && cur !== 4294967295 && safety < 200) {
      const n = this.loader.getNode(cur);
      if (!n) break;
      cur = n.parent;
      depth++;
      safety++;
    }
    return depth;
  }

  /** Update the selection info panel. */
  _updateSelection() {
    const node = this.loader.getNode(this.selectedIndex);
    if (!node) return;

    document.getElementById("sel-name").textContent = node.name || "(root)";
    document.getElementById("sel-size").textContent = this._formatSize(
      node.size,
    );
    document.getElementById("sel-files").textContent = (
      node.file_count || 0
    ).toLocaleString();

    const isDir = node.node_type === "Directory" || node.node_type === 0;
    document.getElementById("sel-type").textContent = isDir
      ? "📁 Directory"
      : "📄 File";

    // Delete hint — full path delete available in Top Files panel
    var actionEl = document.getElementById("sel-action");
    actionEl.textContent = isDir ? 'Use Top Files for delete' : 'Use Top Files for delete';
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return i === 0 ? `${bytes} B` : `${val.toFixed(2)} ${units[i]}`;
  }
}
