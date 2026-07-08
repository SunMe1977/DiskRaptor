/**
 * TreeView — Virtual tree view for the directory hierarchy.
 * With right-click context menu matching the diagram menu.
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
    this._initDiagramJump();
  }

  /** Listen for diagram "jump in tree" clicks */
  _initDiagramJump() {
    var self = this;
    window.addEventListener("diagram-jump-to-path", async function (e) {
      var fullPath = e.detail && e.detail.path;
      if (!fullPath || !self.loader || !self.loader.allNodes) {
        console.warn("Jump: no loader data yet");
        return;
      }
      var scanPath = document.getElementById("scan-path");
      if (!scanPath || !scanPath.value) {
        console.warn("Jump: no scan path");
        return;
      }
      var root = scanPath.value.replace(/\\+$/, "");
      if (fullPath.indexOf(root) !== 0) {
        console.warn("Jump: path mismatch", fullPath, "vs", root);
        return;
      }
      var rel = fullPath.substring(root.length).replace(/^\\/, "");
      if (!rel) return; // clicking root
      var parts = rel.split("\\");
      // Remove the last part (the file name) — only navigate to the parent dir
      parts.pop();
      if (parts.length === 0) return;

      var currentIdx = 0;
      var found = true;
      for (var pi = 0; pi < parts.length; pi++) {
        var seg = parts[pi];
        if (!seg) continue;

        // Mark as expanded
        if (!self.expanded.has(currentIdx)) {
          self.expanded.add(currentIdx);
        }

        // First, scan all loaded nodes manually (more thorough than getChildrenIndices)
        var match = -1;
        for (var ni = 0; ni < self.loader.allNodes.length; ni++) {
          var n = self.loader.allNodes[ni];
          if (n && n.parent === currentIdx && n.name === seg) {
            match = ni;
            break;
          }
        }

        // If not found, try getChildrenIndices
        if (match === -1) {
          var children = self.loader.getChildrenIndices(currentIdx);
          for (var ci = 0; ci < children.length; ci++) {
            var n = self.loader.getNode(children[ci]);
            if (n && n.name === seg) {
              match = children[ci];
              break;
            }
          }
        }

        // If still not found, fetch from backend
        if (match === -1) {
          try {
            var rawKids = await self.loader.fetchChildren(currentIdx);
            if (rawKids && rawKids.length > 0) {
              for (var ri = 0; ri < rawKids.length; ri++) {
                if (rawKids[ri].name === seg) {
                  var newIdx = self.loader.allNodes.length;
                  rawKids[ri]._arenaIndex = newIdx;
                  self.loader.allNodes.push(rawKids[ri]);
                  var existing = self.loader.parentMap.get(currentIdx) || [];
                  existing.push(newIdx);
                  self.loader.parentMap.set(currentIdx, existing);
                  match = newIdx;
                  break;
                }
              }
            }
          } catch (err) {
            console.warn("Jump: fetch failed for", seg, err);
            break;
          }
        }

        if (match === -1) {
          found = false;
          break;
        }
        currentIdx = match;
      }

      if (found) {
        await self.rebuild();
        self.select(currentIdx);
        var sb = document.querySelector(".status-bar");
        if (sb) sb.textContent = "Jumped to: " + fullPath;
      } else {
        console.warn("Jump: could not find path in tree:", fullPath);
      }
    });
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
    this._ctxMenu = document.createElement("div");
    this._ctxMenu.id = "tree-context-menu";
    Object.assign(this._ctxMenu.style, {
      display: "none",
      position: "fixed",
      zIndex: 2000,
      background: "#161b22",
      border: "1px solid #30363d",
      borderRadius: "6px",
      padding: "4px 0",
      minWidth: "200px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    });
    this._ctxMenu.innerHTML =
      '<div class="tctx-item" data-action="explorer">\u{1F4C2} Open in Explorer</div>' +
      '<div class="tctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
      '<div class="tctx-sep"></div>' +
      '<div class="tctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
      '<div class="tctx-item" data-action="copy">\u{1F4CB} Copy Path</div>' +
      '<div class="tctx-sep"></div>' +
      '<div class="tctx-item tctx-del" data-action="delete">\u{1F5D1}\uFE0F Delete</div>';
    document.body.appendChild(this._ctxMenu);

    const style = document.createElement("style");
    style.textContent =
      ".tctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:#e6edf3;}" +
      ".tctx-item:hover{background:#30363d;}" +
      ".tctx-sep{height:1px;background:#30363d;margin:4px 8px;}" +
      ".tctx-del{color:#f85149;}";
    document.head.appendChild(style);

    document.addEventListener("click", (e) => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) {
        this._ctxMenu.style.display = "none";
      }
    });

    this._ctxMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".tctx-item");
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
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    const name = node.name || "?";
    const confirmMsg =
      "Delete " + (node.is_file() ? "file" : "folder") + "?\n" + path;
    if (!confirm(confirmMsg)) return;
    try {
      await window.__TAURI__.invoke("delete_path", { path: path });
      document.querySelector(".status-bar").textContent = "Deleted: " + name;
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
    const path = isDir
      ? this._buildPath(arenaIdx)
      : this._buildParentPath(arenaIdx);
    if (!path) return;
    try {
      await window.__TAURI__.invoke("open_terminal", { path: path });
    } catch (e) {
      console.warn("Terminal failed:", e);
    }
  }

  async _handleExplorer(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      await window.__TAURI__.invoke("open_explorer", { path: path });
    } catch (e) {
      console.warn("Explorer failed:", e);
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
      console.warn("Properties failed:", e);
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
    const scanPath = document.getElementById("scan-path");
    if (scanPath && scanPath.value) {
      const root = scanPath.value.replace(/\\+$/, "");
      return root + "\\" + parts.join("\\");
    }
    return parts.join("\\");
  }

  _buildParentPath(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return null;
    const idx = path.lastIndexOf("\\");
    return idx >= 0 ? path.substring(0, idx) : path;
  }

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
            else {
              const newIdx = this.loader.allNodes.length;
              raw._arenaIndex = newIdx;
              this.loader.allNodes.push(raw);
              indices.push(newIdx);
            }
          }
          if (indices.length > 0) {
            this.loader.parentMap.set(arenaIdx, indices);
            children = indices;
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

    el.oncontextmenu = (e) => {
      e.preventDefault();
      this.select(arenaIdx);
      this._ctxMenu._arenaIdx = arenaIdx;
      this._ctxMenu.style.display = "block";
      this._ctxMenu.style.left = e.clientX + "px";
      this._ctxMenu.style.top = e.clientY + "px";
    };

    const indent = document.createElement("span");
    indent.className = "indent";
    indent.style.width = depth * 18 + "px";
    el.appendChild(indent);

    const toggle = document.createElement("span");
    toggle.className = "toggle";
    toggle.textContent = isDir ? (isExpanded ? "\u25BC" : "\u25B6") : "";
    el.appendChild(toggle);

    // Icon: fallback emoji, then replace with real Windows icon from IconCache
    var iconEl = document.createElement("span");
    iconEl.className = "icon";
    iconEl.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;";
    iconEl.textContent = isDir ? "📁" : "📄";
    el.appendChild(iconEl);
    if (window.__ICON_CACHE__) {
      var iconKey = isDir ? "__folder__" : node.name || "file";
      window.__ICON_CACHE__
        .getIcon(iconKey, isDir)
        .then(function (iconResult) {
          if (
            typeof iconResult === "string" &&
            iconResult.indexOf("data:") === 0
          ) {
            // Replace emoji with real icon
            iconEl.innerHTML = "";
            var img = document.createElement("img");
            img.src = iconResult;
            img.style.cssText = "width:16px;height:16px;display:block;";
            iconEl.appendChild(img);
          } else if (typeof iconResult === "string" && iconResult.length < 10) {
            // Update fallback emoji
            iconEl.textContent = iconResult;
          }
        })
        .catch(function () {});
    }

    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = node.name || "(root)";
    el.appendChild(name);

    const size = document.createElement("span");
    size.className = "node-size";
    size.textContent = this._formatSize(node.size);
    el.appendChild(size);

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
