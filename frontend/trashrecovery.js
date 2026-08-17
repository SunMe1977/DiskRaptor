class TrashRecovery {
  constructor() {
    this._items = [];
    this._selected = {};
    this._filter = "";
    this._sort = "name";
    this._shownCount = 200;
    this._createUI();
  }

  _t(key) { return (window.__ || function(s){return s;})(key); }

  _createUI() {
    this.panel = document.createElement("div");
    this.panel.id = "trash-panel";
    this.panel.style.cssText = "display:none;margin-top:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);overflow:hidden;";
    this.panel.innerHTML = `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:14px;color:var(--text-primary);">🗑️ ${this._t("trash.title")}</h3>
        <span id="trash-summary" style="font-size:12px;color:var(--text-muted);"></span>
      </div>
      <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
        <input id="trash-search" placeholder="🔍 Filter by name..." style="flex:1;min-width:120px;padding:5px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />
        <select id="trash-sort" style="padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);">
          <option value="name">Sort: Name</option>
          <option value="size">Sort: Size</option>
          <option value="date">Sort: Deleted date</option>
        </select>
      </div>
      <div id="trash-list" style="max-height:400px;overflow-y:auto;padding:8px;"></div>
      <div style="padding:8px 16px;border-top:1px solid var(--border);display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
        <button id="trash-select-all" style="padding:5px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">${this._t("trash.select_all")}</button>
        <button id="trash-restore-all" style="padding:5px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">♻️ Restore All</button>
        <button id="trash-restore-selected" style="padding:5px 12px;font-size:11px;border:none;border-radius:4px;background:linear-gradient(135deg,#238636,var(--accent-green));color:#fff;cursor:pointer;">${this._t("trash.restore_selected")}</button>
        <button id="trash-delete-selected" style="padding:5px 12px;font-size:11px;border:none;border-radius:4px;background:linear-gradient(135deg,#da3633,var(--accent-red));color:#fff;cursor:pointer;">${this._t("trash.delete_selected")}</button>
        <button id="trash-close" style="padding:5px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">${this._t("trash.close")}</button>
      </div>
    `;
    document.body.appendChild(this.panel);
    document.getElementById("trash-close").onclick = () => { this.panel.style.display = "none"; };
    document.getElementById("trash-select-all").onclick = () => this._toggleAll(true);
    document.getElementById("trash-restore-selected").onclick = () => this._restoreSelected();
    document.getElementById("trash-delete-selected").onclick = () => this._deleteSelected();
    document.getElementById("trash-restore-all").onclick = () => this._restoreAll();
    document.getElementById("trash-search").oninput = window.debounce((e) => {
      this._filter = e.target.value.toLowerCase();
      this._render();
    }, 150);
    document.getElementById("trash-sort").onchange = (e) => {
      this._sort = e.target.value;
      this._render();
    };
  }

  async open() {
    this.panel.style.display = "block";
    document.getElementById("trash-list").innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + this._t("trash.loading") + '</div>';
    try {
      const items = await window.__TAURI__.invoke("list_trash", {});
      this._items = items || [];
      this._selected = {};
      this._render();
    } catch(e) {
      document.getElementById("trash-list").innerHTML = '<div style="padding:20px;text-align:center;color:var(--accent-red);">' + this._t("trash.failed") + '</div>';
    }
  }

  _visible() {
    let items = this._items.map(function (it, i) { return { item: it, idx: i }; });
    if (this._filter) {
      items = items.filter(function (x) {
        return (x.item.name || "").toLowerCase().indexOf(this._filter) !== -1;
      }.bind(this));
    }
    const sort = this._sort;
    items.sort(function (a, b) {
      if (sort === "size") return (b.item.size || 0) - (a.item.size || 0);
      if (sort === "date") return String(b.item.deleted_at || "").localeCompare(String(a.item.deleted_at || ""));
      return String(a.item.name || "").localeCompare(String(b.item.name || ""));
    });
    return items;
  }

  _render() {
    const t = this._t.bind(this);
    const list = document.getElementById("trash-list");
    const summary = document.getElementById("trash-summary");
    const visible = this._visible();
    if (visible.length === 0) {
      list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">🗑️ ' + t("trash.empty") + '</div>';
      if (summary) summary.textContent = this._items.length + " items";
      return;
    }
    let totalSize = 0;
    let html = "";
    const shown = visible.slice(0, this._shownCount);
    for (let vi = 0; vi < shown.length; vi++) {
      const idx = shown[vi].idx;
      const item = this._items[idx];
      const checked = this._selected[idx] || false;
      totalSize += item.size || 0;
      const origPath = item.original_path || "";
      html += '<div class="trash-item" data-idx="' + idx + '" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-secondary);transition:background 0.15s;" title="' + (origPath ? "Original: " + trashEscHtml(origPath) : "") + '">';
      html += '<input type="checkbox" ' + (checked ? 'checked' : '') + ' style="width:14px;height:14px;cursor:pointer;flex-shrink:0;" data-idx="' + idx + '">';
      html += '<span>' + (item.is_dir ? "📁" : "📄") + '</span>';
      html += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + trashEscHtml(item.name || "?") + '</span>';
      if (origPath) {
        html += '<span style="font-size:10px;color:var(--text-muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + trashEscHtml(origPath) + '</span>';
      }
      html += '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:nowrap;">' + (item.size_human || fmtTrash(item.size)) + '</span>';
      html += '<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">' + (item.deleted_at ? item.deleted_at.substring(0,10) : "") + '</span>';
      html += '</div>';
    }
    if (visible.length > shown.length) {
      const remaining = visible.length - shown.length;
      html += '<div style="text-align:center;padding:10px;"><button id="trash-show-more" style="padding:6px 16px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">Show ' + remaining + ' more...</button></div>';
    }
    list.innerHTML = html;
    const that = this;
    const showMore = list.querySelector("#trash-show-more");
    if (showMore) {
      showMore.onclick = function () {
        that._shownCount += 200;
        that._render();
      };
    }
    list.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.onchange = function() {
        const i = parseInt(this.dataset.idx);
        if (!isNaN(i)) { if (this.checked) that._selected[i] = true; else delete that._selected[i]; }
        that._updateSummary();
      };
    });
    list.querySelectorAll(".trash-item").forEach(function(row) {
      row.onclick = function(e) {
        if (e.target.tagName === "INPUT") return;
        const cb = this.querySelector('input[type="checkbox"]');
        if (cb) { cb.checked = !cb.checked; cb.onchange(); }
      };
      row.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
      row.onmouseleave = function() { this.style.background = "transparent"; };
    });
    if (summary) {
      summary.textContent = visible.length + " shown · " + fmtTrash(totalSize) + (this._items.length !== visible.length ? " · " + this._items.length + " total" : "");
    }
  }

  _updateSummary() {
    const summary = document.getElementById("trash-summary");
    const visible = this._visible();
    const shownCount = Math.min(visible.length, this._shownCount);
    let sel = 0, selSize = 0;
    Object.keys(this._selected).forEach(function (i) {
      if (this._selected[i]) { sel++; selSize += (this._items[Number(i)] || {}).size || 0; }
    }.bind(this));
    if (summary) {
      summary.textContent = shownCount + " shown · " + fmtTrash(selSize) + " selected (" + sel + ")";
    }
  }

  _toggleAll(checked) {
    const visible = this._visible();
    for (let vi = 0; vi < visible.length; vi++) {
      if (checked) this._selected[visible[vi].idx] = true;
      else delete this._selected[visible[vi].idx];
    }
    this._render();
  }

  _selectedIndices() {
    return Object.keys(this._selected).map(Number).filter(function(i) { return !isNaN(i) && this._selected[i]; }.bind(this));
  }

  async _restoreIndices(idxs) {
    const t = this._t.bind(this);
    if (idxs.length === 0) { window.alertDialog(t("trash.no_selection")); return; }
    if (!(await window.confirmDialog(t("trash.restore_confirm").replace("{n}", idxs.length)))) return;
    const BATCH = 10;
    let restored = 0, failed = 0;
    const self = this;
    for (let start = 0; start < idxs.length; start += BATCH) {
      const batch = idxs.slice(start, start + BATCH);
      const results = await Promise.allSettled(batch.map(function (i) {
        const item = self._items[i];
        return window.__TAURI__.invoke("restore_trash", {
          trash_path: item.path,
          original_path: item.original_path || "",
        });
      }));
      results.forEach(function (r, ri) {
        const item = self._items[batch[ri]];
        if (r.status === "fulfilled" && r.value && r.value.restored_to) {
          restored++;
          delete self._selected[batch[ri]];
        } else {
          failed++;
          if (item) console.warn("Restore failed:", item.name, r.reason || r.value);
        }
      });
    }
    if (failed > 0) {
      window.showToast(restored + "/" + idxs.length + " restored, " + failed + " failed", "warning");
    } else {
      window.showToast(restored + "/" + idxs.length + " restored", "success");
    }
    await this.open();
  }

  async _restoreSelected() { await this._restoreIndices(this._selectedIndices()); }

  async _restoreAll() {
    const t = this._t.bind(this);
    if (this._items.length === 0) { window.alertDialog(t("trash.empty")); return; }
    const all = this._items.map(function (it, i) { return i; });
    await this._restoreIndices(all);
  }

  async _deleteSelected() {
    const t = this._t.bind(this);
    const idxs = this._selectedIndices();
    if (idxs.length === 0) { window.alertDialog(t("trash.no_selection")); return; }
    if (!(await window.confirmDialog(t("trash.delete_confirm").replace("{n}", idxs.length)))) return;
    for (let ci = 0; ci < idxs.length; ci++) {
      const item = this._items[idxs[ci]];
      if (!item) continue;
      try {
        await window.__TAURI__.invoke("delete_permanent", { path: item.path });
        delete this._selected[idxs[ci]];
      } catch(e) { window.alertDialog(t("trash.delete_failed").replace("{name}", item.name || "?") + "\n" + e); }
    }
    await this.open();
  }
}

function trashEscHtml(s) {
  return window.escHtml(s);
}

function fmtTrash(b) {
  return window.fmtSize(b);
}
