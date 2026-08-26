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
    this.selectedIndices = [];
    this.onSelect = null;
    this.maxSize = 0;
    this.maxFileCount = 0;
    this.maxDirCount = 0;
    this.sortBy = "size";
    this.sortDesc = true;
    this._pathCache = new Map();
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
        self._saveSortPref();
      });
    });
    // Restore persisted sort preference.
    window.__TAURI__
      .invoke("load_settings", {})
      .then(function (s) {
        const tr = (s && s.tree) || {};
        if (tr.sort_by) {
          self.sortBy = tr.sort_by;
          if (typeof tr.sort_desc === "boolean") self.sortDesc = tr.sort_desc;
          document.querySelectorAll(".tree-col-sort").forEach(function (b) {
            b.classList.remove("sort-asc", "sort-desc");
            if (b.dataset.col === self.sortBy)
              b.classList.add(self.sortDesc ? "sort-desc" : "sort-asc");
          });
          self.rebuild();
        }
      })
      .catch(function () {});
  }

  _saveSortPref() {
    window.__TAURI__
      .invoke("save_settings", {
        settings: {
          tree: { sort_by: this.sortBy, sort_desc: this.sortDesc },
        },
      })
      .catch(function () {});
  }

  _initFilter() {
    const self = this;
    const el = document.getElementById("tree-filter");
    if (!el) return;
    let timer = null;
    el.addEventListener("input", function() {
      self._filterText = this.value.toLowerCase().trim();
      clearTimeout(timer);
      timer = setTimeout(function() {
        self.rebuild();
      }, 200);
    });
  }

  _initTypeFilters() {
    const self = this;
    document.querySelectorAll(".type-filter").forEach(function(btn) {
      btn.addEventListener("click", function() {
        if (this.dataset.ext === "custom") {
          const input = window.prompt("Enter extensions (comma-separated, e.g. md,tsx,toml):", "");
          if (input === null) return;
          const exts = input.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
          if (exts.length === 0) return;
          document.querySelectorAll(".type-filter").forEach(function(b) { b.classList.remove("active"); });
          this.classList.add("active");
          self._typeFilter = exts.join("|");
          self.rebuild();
          return;
        }
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
        const node = self.loader.getNode(cur);
        const isDir = node && (node.node_type === "Directory" || node.node_type === 0);
        if (isDir) {
          self.toggleExpand(cur);
        } else {
          self._handleOpenFile(cur);
        }
      } else if (e.key === "Delete") {
        e.preventDefault();
        self._handleDelete(cur);
      } else if (e.key === "F2") {
        e.preventDefault();
        self._handleCopyPath(cur);
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

        // Fast path: search only this node's children (parentMap is indexed by
        // parent, so there is no need to scan allNodes for every segment).
        let match = -1;
        const children = self.loader.getChildrenIndices(currentIdx);
        for (let ci = 0; ci < children.length; ci++) {
          const n = self.loader.getNode(children[ci]);
          if (n && n.name === seg) {
            match = children[ci];
            break;
          }
        }

        // If still not found, ask the backend for the authoritative child list
        // (complete even when the chunk containing this dir was never loaded).
        if (match === -1) {
          try {
            const rawKids = await self.loader.fetchChildrenBackend(currentIdx);
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
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this._ctxMenu) {
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
    const sizeTxt = this._formatSize(node.size);
    if (!(await window.confirmDialog(
      (isDir ? t("confirm.move_trash_folder") : t("confirm.move_trash_file")) +
        path +
        "\n\nSize: " + sizeTxt +
        "\n\n" + (t("confirm.not_undone") || "This cannot be undone."),
    ))) return;
    try {
      const res = await window.__TAURI__.invoke("delete_path", { path: path });
      if (res && res.success === false) {
        window.alertDialog("Failed: " + (res.error || "unknown error"));
        return;
      }
      document.querySelector(".status-bar").textContent = t("status.moved_to_trash").replace("{name}", name);
      this._removeNodeFromTree(arenaIdx);
      await this.rebuild();
      this._offerUndoTrash(path);
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

  /**
   * Remove tree nodes whose full path matches any of `paths` (used after a
   * move-to-trash so the tree reflects the deletion without a full rescan).
   * Names are pre-filtered so full paths are only built for candidates.
   */
  removePaths(paths) {
    if (!paths || paths.length === 0) return;
    const norm = function (s) {
      return String(s).replace(/[\\/]+$/, "").toLowerCase();
    };
    const wanted = new Set(paths.map(norm));
    const wantedNames = new Set();
    paths.forEach(function (p) {
      const base = String(p).split(/[\\/]/).filter(Boolean).pop() || "";
      if (base) wantedNames.add(base.toLowerCase());
    });
    const all = this.loader.allNodes || [];
    const toRemove = [];
    for (let i = 0; i < all.length; i++) {
      const n = all[i];
      if (!n) continue;
      if (!wantedNames.has((n.name || "").toLowerCase())) continue;
      const p = this._buildPathCached(i);
      if (p && wanted.has(norm(p))) toRemove.push(i);
    }
    if (toRemove.length === 0) return;
    for (let ri = 0; ri < toRemove.length; ri++) {
      this._removeNodeFromTree(toRemove[ri]);
    }
    this._pathCache.clear();
    this.rebuild();
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
    } catch (e) { console.debug("[DiskRaptor]", e); }
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

  // Full path with per-node caching — used for row tooltips so the parent
  // chain isn't climbed on every scroll-frame re-render.
  _buildPathCached(arenaIdx) {
    if (this._pathCache.has(arenaIdx)) return this._pathCache.get(arenaIdx);
    const p = this._buildPath(arenaIdx);
    if (p) this._pathCache.set(arenaIdx, p);
    return p;
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
    this._pathCache.clear();
    try {
      await this._buildList(0, 0);
    } catch (e) {
      console.warn("_buildList error:", e);
    }
    // If the root never materialised, try loading chunk 0 explicitly once.
    if (this.visibleNodes.length === 0 && this.loader && !this.loader.getNode(0)) {
      try {
        if (this.loader.totalChunks > 0 && !this.loader.loadedChunks.has(0)) {
          await this.loader.loadChunk(0);
        }
        await this._buildList(0, 0);
      } catch (e) {
        console.warn("Root chunk fallback failed:", e);
      }
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
    if (se) {
      if (totalItems === 0) {
        // Distinguish "scan still loading chunks" from "truly empty".
        const loading =
          this.loader &&
          this.loader.totalChunks > 0 &&
          this.loader.loadedChunks.size < this.loader.totalChunks;
        se.textContent = loading
          ? "Loading tree..."
          : t("tree.visible").replace("{n}", 0).replace("{s}", "");
      } else {
        se.textContent = t("tree.visible").replace("{n}", totalItems).replace("{s}", totalItems === 1 ? "" : "s");
      }
    }
  }

  async _buildList(rootIdx, rootDepth) {
    // If the requested node isn't loaded yet (chunks still arriving), wait a
    // short moment and retry so we never render a half-empty tree.
    for (let tries = 0; tries < 50 && !this.loader.getNode(rootIdx); tries++) {
      await new Promise(function (r) { setTimeout(r, 100); });
    }
    // Maxima are computed during the same traversal (avoids a second pass over
    // the whole visible list on every rebuild).
    this.maxSize = 0;
    this.maxFileCount = 0;
    this.maxDirCount = 0;
    // Iterative traversal with an explicit stack to avoid JS call-stack
    // overflow on deeply nested directory trees.
    const stack = [{ idx: rootIdx, depth: rootDepth }];
    while (stack.length > 0) {
      const item = stack.pop();
      const arenaIdx = item.idx;
      const depth = item.depth;
      const node = this.loader.getNode(arenaIdx);
      if (!node) continue;

      const isDir = node.node_type === "Directory" || node.node_type === 0;

      // Apply filter: show node if name matches OR it's an ancestor of a match
      let filterMatch = true;
      if (this._filterText) {
        filterMatch = (node.name || "").toLowerCase().indexOf(this._filterText) !== -1;
        if (!filterMatch && depth > 0) {
          filterMatch = this._hasMatchingDescendant(arenaIdx);
        }
      }
      if (depth > 0 && this._filterText && !filterMatch) continue;

      // File type filter
      if (this._typeFilter && this._typeFilter !== "all" && !isDir) {
        let ext = (node.name || "").toLowerCase();
        const dot = ext.lastIndexOf(".");
        ext = dot >= 0 ? ext.substring(dot + 1) : "";
        const exts = this._typeFilter.split("|");
        if (exts.indexOf(ext) === -1) continue;
      }

      this.visibleNodes.push(arenaIdx);
      if (node.size > this.maxSize) this.maxSize = node.size;
      const nfc = node.file_count || 0;
      if (nfc > this.maxFileCount) this.maxFileCount = nfc;
      const ndc = node.dir_count || 0;
      if (ndc > this.maxDirCount) this.maxDirCount = ndc;

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
        // Push children in reverse so the stack pops them in sorted order.
        for (let ci = sorted.length - 1; ci >= 0; ci--) {
          const childNode = this.loader.getNode(sorted[ci]);
          if (childNode) stack.push({ idx: sorted[ci], depth: depth + 1 });
        }
      }
    }
  }

  _hasMatchingDescendant(arenaIdx) {
    const filter = this._filterText;
    if (!filter) return true;
    const stack = this.loader.getChildrenIndices(arenaIdx).slice();
    let checked = 0;
    const BUDGET = 50000;
    while (stack.length > 0 && checked < BUDGET) {
      const ci = stack.pop();
      const child = this.loader.getNode(ci);
      if (!child) continue;
      checked++;
      if ((child.name || "").toLowerCase().indexOf(filter) !== -1) return true;
      const grand = this.loader.getChildrenIndices(ci);
      for (let g = grand.length - 1; g >= 0; g--) stack.push(grand[g]);
    }
    // If the budget ran out without a match, keep the parent visible
    // (conservative) instead of scanning millions of nodes per keystroke.
    return checked >= BUDGET;
  }

  _findNodeByNameAndParent(name, size, parentIdx) {
    const candidates = this.loader.parentMap.get(parentIdx);
    if (candidates) {
      for (const idx of candidates) {
        const n = this.loader.getNode(idx);
        if (n && n.name === name && n.size === size) return idx;
      }
    }
    // Fallback via the name index (only matches for the given name, no full
    // allNodes scan), then a final safety-net linear pass.
    const byName = this.loader.getNodesByName
      ? this.loader.getNodesByName(name)
      : [];
    for (const idx of byName) {
      const n = this.loader.getNode(idx);
      if (n && n.parent === parentIdx && n.size === size) return idx;
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
    this.selectedIndices = [arenaIdx];
    this._updateBatchBar();
    const pos = this.visibleNodes.indexOf(arenaIdx);
    if (pos >= 0) {
      this.vs.scrollToIndex(pos);
      this.vs.refresh();
    }
    this._updateSelection();
    this._updateBreadcrumb(arenaIdx);
    if (this.onSelect) this.onSelect(arenaIdx);
  }

  _esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Clickable path breadcrumb above the tree for the selected node.
  _updateBreadcrumb(arenaIdx) {
    const bar = document.getElementById("tree-breadcrumb");
    if (!bar || !this.loader || !this.loader.allNodes) return;
    const nodes = this.loader.allNodes;
    if (arenaIdx == null || !nodes[arenaIdx]) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    const self = this;
    const chain = [];
    let p = arenaIdx;
    let safety = 0;
    while (p !== 4294967295 && p !== undefined && safety < 1000 && nodes[p]) {
      chain.unshift({ idx: p, name: nodes[p].name || "" });
      p = nodes[p].parent;
      safety++;
    }
    if (chain.length === 0) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    bar.hidden = false;
    let html = "";
    chain.forEach(function (seg, i) {
      if (i > 0) html += '<span class="crumb-sep">/</span>';
      const last = i === chain.length - 1;
      html +=
        '<button class="crumb-seg' + (last ? " last" : "") + '" data-idx="' + seg.idx + '">' +
        self._esc(seg.name) +
        "</button>";
    });
    bar.innerHTML = html;
    bar.querySelectorAll(".crumb-seg:not(.last)").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const idx = parseInt(btn.dataset.idx, 10);
        if (!isNaN(idx)) self.select(idx);
      });
    });
  }

  // Shift-click: toggle a node in the multi-selection set.
  _toggleMulti(arenaIdx) {
    const i = this.selectedIndices.indexOf(arenaIdx);
    if (i >= 0) {
      this.selectedIndices.splice(i, 1);
    } else {
      this.selectedIndices.push(arenaIdx);
    }
    this.selectedIndex = arenaIdx;
    this._updateBatchBar();
    this.vs.refresh();
    this._updateSelection();
  }

  // Floating action bar shown while multiple rows are selected.
  _updateBatchBar() {
    let bar = document.getElementById("tree-batch-bar");
    const n = this.selectedIndices.length;
    if (n < 2) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "tree-batch-bar";
      bar.style.cssText =
        "position:fixed;bottom:36px;left:50%;transform:translateX(-50%);z-index:1001;" +
        "display:flex;align-items:center;gap:10px;padding:8px 14px;border-radius:12px;" +
        "background:var(--bg-secondary);border:1px solid var(--border);box-shadow:0 8px 28px rgba(0,0,0,0.5);font-size:12px;";
      bar.innerHTML =
        '<span class="tbb-count" style="color:var(--text-primary);font-weight:600;"></span>' +
        '<button class="tbb-copy" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\uD83D\uDCCB Copy paths</button>' +
        '<button class="tbb-export" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\uD83D\uDCC4 Export CSV</button>' +
        '<button class="tbb-trash" style="padding:5px 12px;font-size:12px;border:1px solid var(--accent-red);border-radius:6px;background:transparent;color:var(--accent-red);cursor:pointer;">\uD83D\uDDD1 Move to Trash</button>';
      document.body.appendChild(bar);
      bar.querySelector(".tbb-copy").onclick = () => this._handleCopyMany();
      bar.querySelector(".tbb-export").onclick = () => this._handleExportSelection();
      bar.querySelector(".tbb-trash").onclick = () => this._handleDeleteMany();
    }
    bar.querySelector(".tbb-count").textContent =
      n + " selected";
  }

  async _handleDeleteMany() {
    const idxs = this.selectedIndices.slice();
    if (idxs.length < 2) return;
    const paths = [];
    for (const idx of idxs) {
      const p = this._buildPath(idx);
      if (p) paths.push(p);
    }
    const t = window.__ || function (s) { return s; };
    let totalSize = 0;
    for (const idx of idxs) {
      const n = this.loader.getNode(idx);
      if (n) totalSize += n.size || 0;
    }
    if (!(await window.confirmDialog(
      t("confirm.move_trash_multi") || "Move " + paths.length + " item(s) to Trash?\n\n" + paths.slice(0, 5).join("\n") + (paths.length > 5 ? "\n…" : "") + "\n\nTotal: " + this._formatSize(totalSize) + "\n\nThis cannot be undone.",
    ))) return;
    let ok = 0;
    for (const p of paths) {
      try {
        const res = await window.__TAURI__.invoke("delete_path", { path: p });
        if (res && res.success === false) continue;
        ok++;
      } catch (e) { /* keep going */ }
    }
    document.querySelector(".status-bar").textContent =
      t("status.moved_to_trash").replace("{name}", ok + " item(s)");
    this.selectedIndices = [];
    this._updateBatchBar();
    await this.rebuild();
    this._offerUndoTrash(paths);
  }

  // After a move-to-trash, offer a short "Undo" that restores the file from
  // the trash (best-effort; if the item can't be matched it just won't show).
  async _offerUndoTrash(paths) {
    const target = Array.isArray(paths) ? paths : [paths];
    if (target.length === 0) return;
    try {
      const items = await window.__TAURI__.invoke("list_trash", {});
      const arr = Array.isArray(items) ? items : [];
      const toRestore = [];
      for (const it of arr) {
        const orig = it && it.original_path;
        if (!orig) continue;
        const norm = String(orig).toLowerCase();
        for (const p of target) {
          if (norm === String(p).toLowerCase()) {
            toRestore.push({ trashPath: it.path, original: orig });
            break;
          }
        }
      }
      if (toRestore.length === 0) return;
      const t = window.__ || function (s) { return s; };
      window.showToast(
        t("toast.undo_trash") || "Moved to Trash — undo?",
        "info",
        {
          label: "Undo",
          onClick: async function () {
            let ok = 0;
            for (const r of toRestore) {
              try {
                const res = await window.__TAURI__.invoke("restore_trash", {
                  trash_path: r.trashPath,
                  original_path: r.original,
                });
                if (res && res.success === false) continue;
                ok++;
              } catch (e) { /* ignore */ }
            }
            if (ok > 0 && window.showToast) {
              window.showToast("Restored " + ok + " item(s)", "success");
            }
            if (typeof window.__trashRefresh === "function") window.__trashRefresh();
          },
        },
      );
    } catch (e) {
      console.debug("[DiskRaptor]", e);
    }
  }

  async _handleCopyMany() {
    const paths = [];
    for (const idx of this.selectedIndices) {
      const p = this._buildPath(idx);
      if (p) paths.push(p);
    }
    if (paths.length === 0) return;
    try {
      await navigator.clipboard.writeText(paths.join("\n"));
      if (window.showToast) window.showToast("Copied " + paths.length + " paths", "success");
    } catch (e) {
      if (window.alertDialog) window.alertDialog("Could not copy: " + e);
    }
  }

  // Export the current selection (single or multi) as a CSV file.
  _handleExportSelection() {
    const idxs =
      this.selectedIndices.length > 1
        ? this.selectedIndices
        : this.selectedIndex != null
          ? [this.selectedIndex]
          : [];
    if (idxs.length === 0) return;
    const escCsv = function (v) {
      const s = String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    let csv = "Path,Size,File Count,Dir Count,Type\n";
    for (const idx of idxs) {
      const n = this.loader.getNode(idx);
      if (!n) continue;
      const path = this._buildPath(idx);
      if (!path) continue;
      csv +=
        escCsv(path) + "," + (n.size || 0) + "," + (n.file_count || 0) + "," +
        (n.dir_count || 0) + "," + (n.node_type === 1 ? "File" : "Directory") + "\n";
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "diskraptor-selection-" + Date.now() + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  _renderRow(index, el) {
    const arenaIdx = this.visibleNodes[index];
    if (arenaIdx === undefined) return;
    const node = this.loader.getNode(arenaIdx);
    if (!node) return;

    const depth =
      node.depth != null ? node.depth : this._computeDepth(arenaIdx);
    const isDir = node.node_type === "Directory" || node.node_type === 0;
    const isExpanded = this.expanded.has(arenaIdx);

    el.innerHTML = "";
    el.className = "tree-row";
    el.dataset.index = arenaIdx;
    el.title = this._buildPathCached(arenaIdx) || "";
    if (
      arenaIdx === this.selectedIndex ||
      this.selectedIndices.indexOf(arenaIdx) !== -1
    )
      el.classList.add("selected");

    el.onclick = (e) => {
      const toggle = e.target.closest(".toggle");
      if (toggle) {
        this.toggleExpand(arenaIdx);
        return;
      }
      if (e.shiftKey) {
        // Toggle multi-selection without collapsing single selection.
        this._toggleMulti(arenaIdx);
      } else {
        this.select(arenaIdx);
      }
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

    // Build the row with a single innerHTML write (instead of ~11
    // createElement+append calls per row per frame). The name/date strings are
    // HTML-escaped so the previous textContent-level safety is preserved.
    const pct = this.maxSize > 0 ? (node.size / this.maxSize) * 100 : 0;
    let pctBg = "var(--accent-green)";
    if (pct > 70) pctBg = "linear-gradient(90deg, var(--accent-red), var(--accent-red))";
    else if (pct > 40) pctBg = "linear-gradient(90deg, var(--accent-orange), #bb8009)";
    else if (pct > 10) pctBg = "linear-gradient(90deg, #3fb950, var(--accent-green))";

    let dateTxt = "\u2014";
    if (node.mtime && node.mtime > 0) {
      const d = new Date(node.mtime * 1000);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      dateTxt = d.getDate() + " " + months[d.getMonth()] + " " + d.getFullYear();
    }

    el.innerHTML =
      '<span class="indent" style="width:' + (depth * 18) + 'px"></span>' +
      '<span class="toggle">' + (isDir ? (isExpanded ? "\u25BC" : "\u25B6") : "") + "</span>" +
      '<span class="icon" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;">' +
      (isDir ? "\uD83D\uDCC1" : window.escHtml(this._fileIcon(node.name || ""))) +
      "</span>" +
      '<span class="tree-pct-bar"><span class="tree-pct-fill" style="width:' +
      Math.max(1, pct) +
      "%;background:" +
      pctBg +
      '"></span></span>' +
      '<span class="node-name">' + window.escHtml(node.name || "(root)") + "</span>" +
      '<span class="node-pct">' + pct.toFixed(1) + "%</span>" +
      '<span class="node-size">' + window.escHtml(this._formatSize(node.size)) + "</span>" +
      '<span class="node-files">' + (isDir ? (node.file_count || 0).toLocaleString() : "\u2014") + "</span>" +
      '<span class="node-dirs">' + (isDir ? (node.dir_count || 0).toLocaleString() : "\u2014") + "</span>" +
      '<span class="node-date">' + window.escHtml(dateTxt) + "</span>";

    // Icon: the fallback emoji is already in the row; replace it with the real
    // Windows icon from IconCache when it arrives.
    if (window.__ICON_CACHE__) {
      const iconKey = isDir ? "__folder__" : node.name || "file";
      const iconEl = el.querySelector(".icon");
      window.__ICON_CACHE__
        .getIcon(iconKey, isDir)
        .then(function (iconResult) {
          if (!iconEl || !iconEl.parentNode) return;
          if (
            typeof iconResult === "string" &&
            iconResult.indexOf("data:") === 0
          ) {
            iconEl.innerHTML =
              '<img src="' +
              iconResult +
              '" style="width:16px;height:16px;display:block;">';
          } else if (typeof iconResult === "string" && iconResult.length < 10) {
            iconEl.textContent = iconResult;
          }
        })
        .catch(function () {});
    }
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
    return window.fmtSize(bytes);
  }
}
