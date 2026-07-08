/**
 * TreeView — Virtual tree view for the directory hierarchy.
 * With right-click context menu (Delete, Open Terminal).
 */

class TreeView {
  constructor(containerId, chunkLoader) {
    this.loader = chunkLoader;
    this.visibleNodes = [];
    this.expanded = new Set();
    this.selectedIndex = null;
    this.onSelect = null;
    this.maxSize = 0;
    this._initScroll();
    this._initContextMenu();
  }

  _initScroll() {
    const scrollEl = document.getElementById("tree-scroll");
    this.vs = new VirtualScroll(scrollEl, {
      estimatedRowHeight: 26,
      overscan: 15,
      renderCell: (index, el) => this._renderRow(index, el),
    });
  }

  _initContextMenu() {
    // Create context menu element
    this._ctxMenu = document.createElement("div");
    this._ctxMenu.id = "tree-context-menu";
    this._ctxMenu.style.cssText =
      "display:none;position:fixed;z-index:2000;background:var(--bg-secondary);" +
      "border:1px solid var(--border);border-radius:var(--radius-sm);" +
      "padding:4px 0;min-width:160px;box-shadow:0 4px 12px rgba(0,0,0,0.4);";
    this._ctxMenu.innerHTML =
      '<div class="ctx-item" data-action="explorer">Open in Explorer</div>' +
      '<div class="ctx-item" data-action="terminal">Open Terminal</div>' +
      '<div class="ctx-separator"></div>' +
      '<div class="ctx-item" data-action="copy">Copy Path</div>' +
      '<div class="ctx-item" data-action="properties">Properties</div>' +
      '<div class="ctx-separator"></div>' +
      '<div class="ctx-item" data-action="delete">Delete</div>';
    document.body.appendChild(this._ctxMenu);

    // Style context menu items
    const style = document.createElement("style");
    style.textContent =
      ".ctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:var(--text-primary);}" +
      ".ctx-item:hover{background:var(--bg-hover);}" +
      ".ctx-separator{height:1px;background:var(--border);margin:4px 8px;}" +
      ".ctx-item[data-action=delete]{color:var(--accent-red);}" +
      ".ctx-item[data-action=explorer]{}" +
      ".ctx-item[data-action=copy]{}" +
      ".ctx-item[data-action=properties]{}";
    document.head.appendChild(style);

    // Close on click outside
    document.addEventListener("click", (e) => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) {
        this._ctxMenu.style.display = "none";
      }
    });

    // Handle context menu item clicks
    this._ctxMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".ctx-item");
      if (!item) return;
      const action = item.dataset.action;
      const idx = this._ctxMenu._arenaIdx;
      this._ctxMenu.style.display = "none";
      if (action === "delete") this._handleDelete(idx);
      if (action === "terminal") this._handleTerminal(idx);
      if (action === "explorer") this._handleExplorer(idx);
      if (action === "copy") this._handleCopyPath(idx);
      if (action === "properties") this._handleProperties(idx);
    });
  }

  async _handleDelete(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    // We need the full path - construct from parent chain
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    const name = node.name || "?";
    const confirmMsg =
      "Delete " + (node.is_file() ? "file" : "folder") + "?\n" + path;
    if (!confirm(confirmMsg)) return;
    try {
      await window.__TAURI__.invoke("delete_path", { path: path });
      document.querySelector(".status-bar").textContent = "Deleted: " + name;
      // Refresh tree, removing the deleted node
      this.expanded.delete(arenaIdx);
      await this.rebuild();
    } catch (e) {
      alert("Delete failed: " + e);
    }
  }

  async _handleTerminal(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      if (window.__TAURI__.invoke) {
        await window.__TAURI__
          .invoke("open_terminal", { path: path })
          .catch(() => {
            // Fallback: try shell open
            if (window.__TAURI__.shell) {
              window.__TAURI__.shell.open(path);
            }
          });
      }
    } catch (e) {
      console.warn("Open terminal failed:", e);
    }
  }

  async _handleExplorer(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      await window.__TAURI__.invoke("open_explorer", { path: path });
    } catch (e) {
      console.warn("Open explorer failed:", e);
    }
  }

  async _handleCopyPath(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      document.querySelector(".status-bar").textContent = "Copied: " + path;
    } catch (e) {
      console.warn("Copy failed:", e);
    }
  }

  async _handleProperties(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      await window.__TAURI__.invoke("open_properties", { path: path });
    } catch (e) {
      console.warn("Open properties failed:", e);
    }
  }

  _buildPath(arenaIdx) {
    const parts = [];
    let cur = arenaIdx;
    let safety = 0;
    while (cur !== 0 && cur !== 4294967295 && safety < 200) {
      const n = this.loader.getNode(cur);
      if (!n) break;
      parts.unshift(n.name);
      cur = n.parent;
      safety++;
    }
    if (parts.length === 0) return null;
    // Root name is the scan path, stored separately
    const scanPath = document.getElementById("scan-path");
    if (scanPath && scanPath.value) {
      const root = scanPath.value.replace(/\\+$/, "");
      return root + "\\" + parts.join("\\");
    }
    return parts.join("\\");
  }

  /** Rebuild visible node list from root. */
  async rebuild() {
    this.visibleNodes = [];
    try {
      await this._buildList(0, 0);
    } catch (e) {
      console.warn("_buildList error:", e);
    }

    this.maxSize = 0;
    for (const idx of this.visibleNodes) {
      const node = this.loader.getNode(idx);
      if (node && node.size > this.maxSize) this.maxSize = node.size;
    }

    const totalItems = this.visibleNodes.length;
    this.vs.setTotalItems(totalItems, totalItems * 26);
    this.vs.refresh();

    const nc = document.getElementById("node-count");
    if (nc) nc.textContent = totalItems.toLocaleString() + " shown";

    const se = document.querySelector("#tree-panel .status-bar");
    if (se)
      se.textContent =
        "Root \u2022 " +
        totalItems +
        " item" +
        (totalItems === 1 ? "" : "s") +
        " visible";
  }

  async _buildList(arenaIdx, depth) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    this.visibleNodes.push(arenaIdx);

    const isDir = node.node_type === "Directory" || node.node_type === 0;
    if (isDir && this.expanded.has(arenaIdx)) {
      let children = this.loader.getChildrenIndices(arenaIdx);
      if (children.length === 0) {
        const rawNodes = await this.loader.fetchChildren(arenaIdx);
        if (rawNodes && rawNodes.length > 0) {
          const indices = [];
          for (const raw of rawNodes) {
            const found = this._findNodeByNameAndParent(
              raw.name,
              raw.size,
              arenaIdx,
            );
            if (found !== null) indices.push(found);
          }
          if (indices.length > 0) {
            this.loader.parentMap.set(arenaIdx, indices);
            children = indices;
          } else {
            children = this._registerTemporaryChildren(arenaIdx, rawNodes);
          }
        }
      }
      const sorted = [...children].sort((a, b) => {
        const na = this.loader.getNode(a);
        const nb = this.loader.getNode(b);
        return (nb ? nb.size : 0) - (na ? na.size : 0);
      });
      for (const childIdx of sorted) {
        const childNode = this.loader.getNode(childIdx);
        if (childNode) await this._buildList(childIdx, depth + 1);
      }
    }
  }

  _findNodeByNameAndParent(name, size, parentIdx) {
    const candidates = this.loader.parentMap.get(parentIdx);
    if (candidates) {
      for (const idx of candidates) {
        const n = this.loader.getNode(idx);
        if (n && n.name === name && n.size === size) return idx;
      }
    }
    for (let i = 0; i < this.loader.allNodes.length; i++) {
      const n = this.loader.allNodes[i];
      if (n && n.parent === parentIdx && n.name === name && n.size === size)
        return i;
    }
    return null;
  }

  _registerTemporaryChildren(parentIdx, rawNodes) {
    const indices = [];
    for (const raw of rawNodes) {
      let found = this._findNodeByNameAndParent(raw.name, raw.size, parentIdx);
      if (found === null) {
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

  async toggleExpand(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    if (!isDir) return;
    if (this.expanded.has(arenaIdx)) {
      this.expanded.delete(arenaIdx);
    } else {
      this.expanded.add(arenaIdx);
      await this._ensureChildrenChunks(arenaIdx);
    }
    await this.rebuild();
  }

  async _ensureChildrenChunks(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node || !this.loader.allNodes) return;
    const parentPos = this.loader.allNodes.indexOf(node);
    if (parentPos >= 0) {
      const startChunk = Math.floor((parentPos + 1) / 10000);
      await this.loader.ensureChunks(
        startChunk,
        Math.min(startChunk + 3, this.loader.totalChunks),
      );
    }
  }

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

  _renderRow(index, el) {
    const arenaIdx = this.visibleNodes[index];
    if (arenaIdx === undefined) return;
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    const depth = this._computeDepth(arenaIdx);
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    const isExpanded = this.expanded.has(arenaIdx);

    el.innerHTML = "";
    el.className = "tree-row";
    el.dataset.index = arenaIdx;
    if (arenaIdx === this.selectedIndex) el.classList.add("selected");

    el.onclick = (e) => {
      const toggle = e.target.closest(".toggle");
      if (toggle) {
        this.toggleExpand(arenaIdx);
        return;
      }
      this.select(arenaIdx);
    };

    // Right-click context menu
    el.oncontextmenu = (e) => {
      e.preventDefault();
      this.select(arenaIdx);
      this._ctxMenu._arenaIdx = arenaIdx;
      this._ctxMenu.style.display = "block";
      this._ctxMenu.style.left = e.clientX + "px";
      this._ctxMenu.style.top = e.clientY + "px";
    };

    // Indent
    const indent = document.createElement("span");
    indent.className = "indent";
    indent.style.width = depth * 18 + "px";
    el.appendChild(indent);

    // Toggle
    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = isDir ? (isExpanded ? "\u25BC" : "\u25B6") : "";
    el.appendChild(toggle);

    // Icon
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = isDir
      ? isExpanded
        ? "\uD83D\uDCC2"
        : "\uD83D\uDCC1"
      : "\uD83D\uDCC4";
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
    fill.style.width = Math.max(2, pct) + "%";
    fill.style.background = isDir ? "var(--accent)" : "var(--accent-green)";
    bar.appendChild(fill);
    el.appendChild(bar);
  }

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
      ? "Directory"
      : "File";
    document.getElementById("sel-action").textContent =
      "Right-click for options";
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + " B" : val.toFixed(2) + " " + units[i];
  }
}
