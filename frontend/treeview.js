/**
 * TreeView — Virtual tree view for the directory hierarchy.
 * With right-click context menu matching the diagram menu.
 */
class TreeView {
  /**
   * Create a virtual tree view for the directory hierarchy.
   * @param {string} containerId - The DOM element ID for the tree container
   * @param {ChunkLoader} chunkLoader - The ChunkLoader instance for data access
   */
  constructor(containerId, chunkLoader) {
    this.loader = chunkLoader;
    this.visibleNodes = [];
    this.expanded = new Set();
    this.selectedIndex = null;
    this.onSelect = null;
    this.maxSize = 0;
    this.maxFileCount = 0;
    this.maxDirCount = 0;
    this.sortBy = "size";
    this.sortDesc = true;
    this._isLinux =
      /linux/i.test(navigator.platform || "") ||
      /linux/i.test(navigator.userAgent || "");
    this._isMac =
      /mac/i.test(navigator.platform || "") ||
      /mac/i.test(navigator.userAgent || "");
    this._filterText = "";
    this._typeFilter = "all";
    this._initScroll();
    this._initContextMenu();
    this._initDiagramJump();
    this._initSortControls();
    this._initFilter();
    this._initTypeFilters();
    this._initKeyboard();
  }

  /** Listen for diagram "jump in tree" clicks */
  _initSortControls() {
    const self = this;
    // Default sort: size desc
    document.querySelectorAll(".tree-col-sort").forEach(function(btn) {
      if (btn.dataset.col === "size") {
        btn.classList.add("sort-desc");
      }
      btn.addEventListener("click", function() {
        const col = this.dataset.col;
        if (self.sortBy === col) {
          self.sortDesc = !self.sortDesc;
        } else {
          self.sortBy = col;
          self.sortDesc = true;
        }
        document.querySelectorAll(".tree-col-sort").forEach(function(b) {
          b.classList.remove("sort-asc", "sort-desc");
        });
        this.classList.add(self.sortDesc ? "sort-desc" : "sort-asc");
        self.rebuild();
      });
    });
  }

  _initFilter() {
    const self = this;
    const el = document.getElementById("tree-filter");
    if (!el) return;
    el.addEventListener("input", function() {
      self._filterText = this.value.toLowerCase().trim();
      self.rebuild();
    });
  }

  _initTypeFilters() {
    const self = this;
    document.querySelectorAll(".type-filter").forEach(function(btn) {
      btn.addEventListener("click", function() {
        document.querySelectorAll(".type-filter").forEach(function(b) { b.classList.remove("active"); });
        this.classList.add("active");
        self._typeFilter = this.dataset.ext;
        self.rebuild();
      });
    });
  }

  _initKeyboard() {
    const self = this;
    document.addEventListener("keydown", function(e) {
      // Only handle when tree is visible and not typing in filter
      const filter = document.getElementById("tree-filter");
      if (filter && document.activeElement === filter) return;
      if (self.visibleNodes.length === 0) return;
      let cur = self.selectedIndex;
      if (cur === null || cur === undefined) cur = self.visibleNodes[0];
      let idx = self.visibleNodes.indexOf(cur);
      if (idx === -1) idx = 0;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        idx = Math.min(idx + 1, self.visibleNodes.length - 1);
        self.select(self.visibleNodes[idx]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        idx = Math.max(idx - 1, 0);
        self.select(self.visibleNodes[idx]);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const node = self.loader.getNode(cur);
        if (node && (node.node_type === "Directory" || node.node_type === 0)) {
          self.toggleExpand(cur);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const node = self.loader.getNode(cur);
        if (node && self.expanded.has(cur)) {
          self.toggleExpand(cur);
        } else if (node && node.parent !== 4294967295) {
          self.select(node.parent);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        self._handleOpenFile(cur);
      }
    });
  }

  _initDiagramJump() {
    const self = this;
    window.addEventListener("diagram-jump-to-path", async function (e) {
      const fullPath = e.detail && e.detail.path;
      if (!fullPath || !self.loader || !self.loader.allNodes) {
        console.warn("Jump: no loader data yet");
        return;
      }
      const scanPath = document.getElementById("scan-path");
      if (!scanPath || !scanPath.value) {
        console.warn("Jump: no scan path");
        return;
      }
      const root = scanPath.value.replace(/[\\/]+$/, "");
      const fullNorm = fullPath.replace(new RegExp("/", "g"), "\\");
      const rootNorm = root.replace(new RegExp("/", "g"), "\\");
      if (fullNorm.toUpperCase().indexOf(rootNorm.toUpperCase()) !== 0) {
        console.warn("Jump: path mismatch", fullPath, "vs", root);
        return;
      }
      const rel = fullNorm.substring(rootNorm.length).replace(/^[\\/]/, "");
      if (!rel) return; // clicking root
      const parts = rel.split(/[\\/]+/);
      if (parts.length === 0) return;

      let currentIdx = 0;
      let found = true;
      for (let pi = 0; pi < parts.length; pi++) {
        const seg = parts[pi];
        if (!seg) continue;

        // Mark as expanded
        if (!self.expanded.has(currentIdx)) {
          self.expanded.add(currentIdx);
        }

        // First, scan all loaded nodes manually (more thorough than getChildrenIndices)
        let match = -1;
        for (let ni = 0; ni < self.loader.allNodes.length; ni++) {
          const n = self.loader.allNodes[ni];
          if (n && n.parent === currentIdx && n.name === seg) {
            match = ni;
            break;
          }
        }

        // If not found, try getChildrenIndices
        if (match === -1) {
          const children = self.loader.getChildrenIndices(currentIdx);
          for (let ci = 0; ci < children.length; ci++) {
            const n = self.loader.getNode(children[ci]);
            if (n && n.name === seg) {
              match = children[ci];
              break;
            }
          }
        }

        // If still not found, fetch from backend
        if (match === -1) {
          try {
            const rawKids = await self.loader.fetchChildren(currentIdx);
            if (rawKids && rawKids.length > 0) {
              for (let ri = 0; ri < rawKids.length; ri++) {
                if (rawKids[ri].name === seg) {
                  const newIdx = self.loader.allNodes.length;
                  rawKids[ri]._arenaIndex = newIdx;
                  self.loader.allNodes.push(rawKids[ri]);
                  const existing = self.loader.parentMap.get(currentIdx) || [];
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
        const sb = document.querySelector(".status-bar");
        const t = window.__ || function(s){return s;};
        if (sb) sb.textContent = t("status.jumped").replace("{path}", fullPath);
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
      maxHeight: "70vh",
      overflowY: "auto",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    });
    const explorerLabel = this._isMac ? "Open in Finder" : this._isLinux ? "Open in File Manager" : "Open in Explorer";
    this._ctxMenu.innerHTML =
      '<div class="tctx-item" data-action="explorer">\u{1F4C2} ' + explorerLabel + '</div>' +
      '<div class="tctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
      '<div class="tctx-item" data-action="scan-here">🔍 Scan this Folder</div>' +
      '<div class="tctx-sep"></div>' +
      '<div class="tctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
      '<div class="tctx-item" data-action="copy">\u{1F4CB} ' + (window.__ ? window.__("action.copy_path") : "Copy Path") + '</div>' +
      '<div class="tctx-item" data-action="copy-size">\u{1F4B0} ' + (window.__ ? window.__("action.copy_size") : "Copy Size") + '</div>' +
      '<div class="tctx-sep"></div>' +
      '<div class="tctx-item tctx-del" data-action="delete">\u{1F5D1}\uFE0F ' + (window.__ ? window.__("action.move_to_trash") : "Move to Trash") + '</div>';
    document.body.appendChild(this._ctxMenu);

    // Show context menu on right-click
    const self = this;
    const scrollEl = document.getElementById("tree-scroll");
    if (scrollEl) {
      scrollEl.addEventListener("contextmenu", function(e) {
        const row = e.target.closest(".tree-row");
        if (!row) return;
        e.preventDefault();
        const arenaIdx = parseInt(row.dataset.index);
        if (isNaN(arenaIdx)) return;
        self._ctxMenu._arenaIdx = arenaIdx;
        self._ctxMenu.style.display = "block";
        self._placeContextMenu(e.clientX, e.clientY);
      });
    }

    const style = document.createElement("style");
    style.textContent =
      ".tctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:var(--text-primary);}" +
      ".tctx-item:hover{background:#30363d;}" +
      ".tctx-sep{height:1px;background:#30363d;margin:4px 8px;}" +
      ".tctx-del{color:var(--accent-red);}";
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
      if (action === "scan-here") this._handleScanHere(idx);
      if (action === "terminal") this._handleTerminal(idx);
      if (action === "explorer") this._handleExplorer(idx);
      if (action === "copy") this._handleCopyPath(idx);
      if (action === "copy-size") this._handleCopySize(idx);
      if (action === "properties") this._handleProperties(idx);
    });
  }

  async _handleDelete(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    const name = node.name || "?";
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    const t = window.__ || function(s){return s;};
    if (!(await window.confirmDialog((isDir ? t("confirm.move_trash_folder") : t("confirm.move_trash_file")) + path))) return;
    try {
      const res = await window.__TAURI__.invoke("delete_path", { path: path });
      if (res && res.success === false) {
        window.alertDialog("Failed: " + (res.error || "unknown error"));
        return;
      }
      document.querySelector(".status-bar").textContent = t("status.moved_to_trash").replace("{name}", name);
      this._removeNodeFromTree(arenaIdx);
      await this.rebuild();
    } catch (e) {
      window.alertDialog("Failed: " + e);
    }
  }

  _removeNodeFromTree(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    const parent = node.parent;

    const toRemove = [arenaIdx];
    let i = 0;
    while (i < toRemove.length) {
      const children = this.loader.getChildrenIndices(toRemove[i]);
      for (let ci = 0; ci < children.length; ci++) {
        toRemove.push(children[ci]);
      }
      i++;
    }

    for (let ri = 0; ri < toRemove.length; ri++) {
      const idx = toRemove[ri];
      this.loader.allNodes[idx] = null;
      this.expanded.delete(idx);
      this.loader.parentMap.delete(idx);
    }

    if (parent !== 4294967295) {
      const siblings = this.loader.parentMap.get(parent);
      if (siblings) {
        const filtered = [];
        for (let si = 0; si < siblings.length; si++) {
          if (toRemove.indexOf(siblings[si]) === -1) filtered.push(siblings[si]);
        }
        this.loader.parentMap.set(parent, filtered);
      }
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
      const t = window.__ || function(s){return s;};
      document.querySelector(".status-bar").textContent = t("status.copied").replace("{path}", path);
    } catch (e) {
      console.warn("Copy failed:", e);
    }
  }

  async _handleScanHere(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    const sp = document.getElementById("scan-path");
    const btn = document.getElementById("btn-scan");
    if (sp && btn) {
      sp.value = path;
      btn.click();
    }
  }

  async _handleCopySize(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    const sizeStr = this._formatSize(node.size);
    try {
      await navigator.clipboard.writeText(sizeStr);
      const t = window.__ || function(s){return s;};
      document.querySelector(".status-bar").textContent = t("status.copied").replace("{path}", sizeStr);
    } catch(e) {}
  }

  async _handleOpenFile(arenaIdx) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;
    if (node.node_type === "Directory" || node.node_type === 0) return; // only files
    const path = this._buildPath(arenaIdx);
    if (!path) return;
    try {
      await window.__TAURI__.invoke("open_explorer", { path: path });
    } catch (e) {
      console.warn("Open failed:", e);
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
      const root = scanPath.value.replace(/[\\/]+$/, "");
      const sep = this._pathSep(root);
      return root + sep + parts.join(sep);
    }
    return parts.join(this._pathSep(""));
  }

  _buildParentPath(arenaIdx) {
    const path = this._buildPath(arenaIdx);
    if (!path) return null;
    const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return idx >= 0 ? path.substring(0, idx) : path;
  }

  _pathSep(rootPath) {
    if (typeof rootPath === "string" && rootPath.indexOf("\\") >= 0) return "\\";
    // macOS always uses forward slashes
    if (/mac/i.test(navigator.platform || "")) return "/";
    return "/";
  }

  _placeContextMenu(x, y) {
    const menu = this._ctxMenu;
    if (!menu) return;
    const menuW = menu.offsetWidth || 220;
    const menuH = menu.offsetHeight || 220;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const left = Math.max(8, Math.min(x, vw - menuW - 8));
    const top = Math.max(8, Math.min(y, vh - menuH - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  /**
   * Rebuild the visible node list and re-render the tree.
   */
  async rebuild() {
    const scrollEl = document.getElementById("tree-scroll");
    const savedScroll = scrollEl ? scrollEl.scrollTop : 0;

    this.visibleNodes = [];
    try {
      await this._buildList(0, 0);
    } catch (e) {
      console.warn("_buildList error:", e);
    }

    this.maxSize = 0;
    this.maxFileCount = 0;
    this.maxDirCount = 0;
    for (const idx of this.visibleNodes) {
      const node = this.loader.getNode(idx);
      if (node && node.size > this.maxSize) this.maxSize = node.size;
      if (node && (node.file_count || 0) > this.maxFileCount) this.maxFileCount = node.file_count || 0;
      if (node && (node.dir_count || 0) > this.maxDirCount) this.maxDirCount = node.dir_count || 0;
    }

    const totalItems = this.visibleNodes.length;
    this.vs.setTotalItems(totalItems, totalItems * 26);
    this.vs.refresh();

    // Restore scroll position
    if (scrollEl && savedScroll > 0) scrollEl.scrollTop = savedScroll;

    const t = window.__ || function(s){return s;};
    const nc = document.getElementById("node-count");
    if (nc) nc.textContent = t("tree.shown").replace("{n}", totalItems.toLocaleString());

    const se = document.querySelector("#tree-panel .status-bar");
    if (se)
      se.textContent = t("tree.visible").replace("{n}", totalItems).replace("{s}", totalItems === 1 ? "" : "s");
  }

  async _buildList(arenaIdx, depth) {
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    // Apply filter: show node if name matches OR it's an ancestor of a match
    let filterMatch = true;
    if (this._filterText) {
      filterMatch = (node.name || "").toLowerCase().indexOf(this._filterText) !== -1;
      if (!filterMatch && depth > 0) {
        // Check if any descendant matches (keep ancestors visible)
        filterMatch = this._hasMatchingDescendant(arenaIdx);
      }
    }
    if (depth > 0 && this._filterText && !filterMatch) return;

    // File type filter
    if (this._typeFilter && this._typeFilter !== "all" && !isDir) {
      let ext = (node.name || "").toLowerCase();
      const dot = ext.lastIndexOf(".");
      ext = dot >= 0 ? ext.substring(dot + 1) : "";
      const exts = this._typeFilter.split("|");
      if (exts.indexOf(ext) === -1) return;
    }

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
        if (!na || !nb) return 0;
        let cmp = 0;
        if (this.sortBy === "name") {
          cmp = (na.name || "").localeCompare(nb.name || "");
        } else if (this.sortBy === "pct") {
          cmp = (na.size || 0) - (nb.size || 0);
        } else if (this.sortBy === "files") {
          cmp = (na.file_count || 0) - (nb.file_count || 0);
        } else if (this.sortBy === "dirs") {
          cmp = (na.dir_count || 0) - (nb.dir_count || 0);
        } else if (this.sortBy === "date") {
          cmp = (na.mtime || 0) - (nb.mtime || 0);
        } else {
          cmp = (na.size || 0) - (nb.size || 0);
        }
        return this.sortDesc ? -cmp : cmp;
      });
      for (const childIdx of sorted) {
        const childNode = this.loader.getNode(childIdx);
        if (childNode) await this._buildList(childIdx, depth + 1);
      }
    }
  }

  _hasMatchingDescendant(arenaIdx) {
    const filter = this._filterText;
    if (!filter) return true;
    const children = this.loader.getChildrenIndices(arenaIdx);
    for (let ci = 0; ci < children.length; ci++) {
      const child = this.loader.getNode(children[ci]);
      if (!child) continue;
      if ((child.name || "").toLowerCase().indexOf(filter) !== -1) return true;
      if (this._hasMatchingDescendant(children[ci])) return true;
    }
    return false;
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

  /**
   * Toggle the expanded/collapsed state of a directory node.
   * @param {number} arenaIdx - The arena index of the node to toggle
   */
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

  /**
   * Select a node by its arena index.
   * @param {number} arenaIdx - The arena index of the node to select
   */
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
    el.ondblclick = (e) => {
      if (isDir) {
        this.toggleExpand(arenaIdx);
      } else {
        this._handleOpenFile(arenaIdx);
      }
    };

    el.oncontextmenu = (e) => {
      e.preventDefault();
      this.select(arenaIdx);
      this._ctxMenu._arenaIdx = arenaIdx;
      this._ctxMenu.style.display = "block";
      this._placeContextMenu(e.clientX, e.clientY);
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
    const iconEl = document.createElement("span");
    iconEl.className = "icon";
    iconEl.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;";
    iconEl.textContent = isDir ? "📁" : this._fileIcon(node.name || "");
    el.appendChild(iconEl);
    if (window.__ICON_CACHE__) {
      const iconKey = isDir ? "__folder__" : node.name || "file";
      window.__ICON_CACHE__
        .getIcon(iconKey, isDir)
        .then(function (iconResult) {
          if (
            typeof iconResult === "string" &&
            iconResult.indexOf("data:") === 0
          ) {
            iconEl.innerHTML = "";
            const img = document.createElement("img");
            img.src = iconResult;
            img.style.cssText = "width:16px;height:16px;display:block;";
            iconEl.appendChild(img);
          } else if (typeof iconResult === "string" && iconResult.length < 10) {
            iconEl.textContent = iconResult;
          }
        })
        .catch(function () {});
    }

    // Gradient percentage bar (green → yellow → red, like RAM bar)
    const pct = this.maxSize > 0 ? (node.size / this.maxSize) * 100 : 0;
    const pctBar = document.createElement("span");
    pctBar.className = "tree-pct-bar";
    const pctFill = document.createElement("span");
    pctFill.className = "tree-pct-fill";
    pctFill.style.width = Math.max(1, pct) + "%";
    // Gradient color based on usage: green < 40% < yellow < 70% < red
    if (pct > 70) pctFill.style.background = "linear-gradient(90deg, var(--accent-red), var(--accent-red))";
    else if (pct > 40) pctFill.style.background = "linear-gradient(90deg, var(--accent-orange), #bb8009)";
    else if (pct > 10) pctFill.style.background = "linear-gradient(90deg, #3fb950, var(--accent-green))";
    else pctFill.style.background = "var(--accent-green)";
    pctBar.appendChild(pctFill);
    el.appendChild(pctBar);

    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = node.name || "(root)";
    el.appendChild(name);

    // Percentage column
    const pctText = document.createElement("span");
    pctText.className = "node-pct";
    pctText.textContent = pct.toFixed(1) + "%";
    el.appendChild(pctText);

    const size = document.createElement("span");
    size.className = "node-size";
    size.textContent = this._formatSize(node.size);
    el.appendChild(size);

    // File count column
    const fc = document.createElement("span");
    fc.className = "node-files";
    fc.textContent = isDir ? (node.file_count || 0).toLocaleString() : "—";
    el.appendChild(fc);

    // Directory count column
    const dc = document.createElement("span");
    dc.className = "node-dirs";
    dc.textContent = isDir ? (node.dir_count || 0).toLocaleString() : "—";
    el.appendChild(dc);

    // Date column
    const dateEl = document.createElement("span");
    dateEl.className = "node-date";
    if (node.mtime && node.mtime > 0) {
      const d = new Date((node.mtime) * 1000);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      dateEl.textContent = d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
    } else {
      dateEl.textContent = "—";
    }
    el.appendChild(dateEl);

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
    if (!node) {
      document.querySelectorAll(".sel-action").forEach(function (b) {
        b.disabled = true;
      });
      return;
    }
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
    // Enable action buttons and attach click handlers
    const path = this._buildPath(this.selectedIndex);
    const self = this;
    document.querySelectorAll(".sel-action").forEach(function (btn) {
      btn.disabled = false;
      btn._path = path;
      btn._nodeIdx = self.selectedIndex;
      // Replace click handler
      btn.onclick = function (e) {
        const action = this.dataset.action;
        const idx = this._nodeIdx;
        if (action === "explorer") self._handleExplorer(idx);
        else if (action === "terminal") self._handleTerminal(idx);
        else if (action === "properties") self._handleProperties(idx);
        else if (action === "copy") self._handleCopyPath(idx);
        else if (action === "delete" || action === "trash") self._handleDelete(idx);
      };
    });
  }

  _fileIcon(name) {
    const ext = name.lastIndexOf(".") >= 0 ? name.substring(name.lastIndexOf(".")).toLowerCase() : "";
    if (/\.(jpg|jpeg|png|gif|bmp|webp|svg|ico|heic|avif)$/i.test(ext)) return "🖼️";
    if (/\.(mp4|mov|avi|mkv|wmv|flv|webm|m4v)$/i.test(ext)) return "🎬";
    if (/\.(mp3|wav|flac|ogg|aac|m4a|wma)$/i.test(ext)) return "🎵";
    if (/\.(zip|tar|gz|bz2|7z|rar|dmg|iso)$/i.test(ext)) return "🗜️";
    if (/\.(pdf)$/i.test(ext)) return "📕";
    if (/\.(doc|docx|xls|xlsx|ppt|pptx|pages|numbers|key)$/i.test(ext)) return "📄";
    if (/\.(exe|msi|dll|app|dmg|pkg)$/i.test(ext)) return "⚙️";
    if (/\.(deb|rpm|apk)$/i.test(ext)) return "📦";
    if (/\.(txt|md|rtf|csv|log|json|xml|yml|yaml|toml)$/i.test(ext)) return "📝";
    if (/\.(js|ts|py|rs|cpp|c|h|hpp|java|go|rb|php|swift|kt)$/i.test(ext)) return "💻";
    if (/\.(html|css|scss|less)$/i.test(ext)) return "🌐";
    if (/\.(ttf|otf|woff|woff2)$/i.test(ext)) return "🔤";
    return "📄";
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + " B" : val.toFixed(2) + " " + units[i];
  }
}
