class TrashRecovery {
  constructor() {
    this._createUI();
  }

  _t(key) { return (window.__ || function(s){return s;})(key); }

  _createUI() {
    this.panel = document.createElement("div");
    this.panel.id = "trash-panel";
    this.panel.style.cssText = "display:none;margin-top:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);overflow:hidden;";
    this.panel.innerHTML = `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:14px;color:var(--text-primary);">🗑️ ${this._t("trash.title")}</h3>
        <span id="trash-summary" style="font-size:12px;color:var(--text-muted);"></span>
      </div>
      <div id="trash-list" style="max-height:400px;overflow-y:auto;padding:8px;"></div>
      <div style="padding:8px 16px;border-top:1px solid var(--border);display:flex;gap:6px;justify-content:flex-end;">
        <button id="trash-select-all" style="padding:5px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">${this._t("trash.select_all")}</button>
        <button id="trash-restore-selected" style="padding:5px 12px;font-size:11px;border:none;border-radius:4px;background:linear-gradient(135deg,#238636,#2ea043);color:#fff;cursor:pointer;">${this._t("trash.restore_selected")}</button>
        <button id="trash-delete-selected" style="padding:5px 12px;font-size:11px;border:none;border-radius:4px;background:linear-gradient(135deg,#da3633,#f85149);color:#fff;cursor:pointer;">${this._t("trash.delete_selected")}</button>
        <button id="trash-close" style="padding:5px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">${this._t("trash.close")}</button>
      </div>
    `;
    document.body.appendChild(this.panel);
    document.getElementById("trash-close").onclick = () => { this.panel.style.display = "none"; };
    document.getElementById("trash-select-all").onclick = () => this._toggleAll(true);
    document.getElementById("trash-restore-selected").onclick = () => this._restoreSelected();
    document.getElementById("trash-delete-selected").onclick = () => this._deleteSelected();
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

  _render() {
    const t = this._t.bind(this);
    const list = document.getElementById("trash-list");
    const summary = document.getElementById("trash-summary");
    if (this._items.length === 0) {
      list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">🗑️ ' + t("trash.empty") + '</div>';
      if (summary) summary.textContent = "0 items";
      return;
    }
    let totalSize = 0;
    let html = "";
    for (let i = 0; i < this._items.length; i++) {
      const item = this._items[i];
      const checked = this._selected[i] || false;
      totalSize += item.size || 0;
      html += '<div class="trash-item" data-idx="' + i + '" style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-secondary);transition:background 0.15s;">';
      html += '<input type="checkbox" ' + (checked ? 'checked' : '') + ' style="width:14px;height:14px;cursor:pointer;flex-shrink:0;" data-idx="' + i + '">';
      html += '<span>' + (item.is_dir ? "📁" : "📄") + '</span>';
      html += '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + (item.name || "?") + '</span>';
      html += '<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted);white-space:nowrap;">' + (item.size_human || "—") + '</span>';
      html += '<span style="font-size:10px;color:var(--text-muted);white-space:nowrap;">' + (item.deleted_at ? item.deleted_at.substring(0,10) : "") + '</span>';
      html += '</div>';
    }
    list.innerHTML = html;
    list.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
      cb.onchange = function() {
        const idx = parseInt(this.dataset.idx);
        if (!isNaN(idx)) { if (this.checked) that._selected[idx] = true; else delete that._selected[idx]; }
      };
    });
    const that = this;
    list.querySelectorAll(".trash-item").forEach(function(row) {
      row.onclick = function(e) {
        if (e.target.tagName === "INPUT") return;
        const cb = this.querySelector('input[type="checkbox"]');
        if (cb) { cb.checked = !cb.checked; cb.onchange(); }
      };
      row.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
      row.onmouseleave = function() { this.style.background = "transparent"; };
    });
    const fmt = function(b) {
      if (b === 0) return "0 B";
      const u = ["B","KB","MB","GB"];
      const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
      return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + u[i];
    };
    if (summary) summary.textContent = this._items.length + " items · " + fmt(totalSize);
  }

  _toggleAll(checked) {
    for (let i = 0; i < this._items.length; i++) {
      if (checked) this._selected[i] = true;
      else delete this._selected[i];
    }
    this._render();
  }

  async _restoreSelected() {
    const t = this._t.bind(this);
    const idxs = Object.keys(this._selected).map(Number).filter(function(i) { return !isNaN(i); });
    if (idxs.length === 0) { alert(t("trash.no_selection")); return; }
    if (!confirm(t("trash.restore_confirm").replace("{n}", idxs.length))) return;
    for (let ci = 0; ci < idxs.length; ci++) {
      const item = this._items[idxs[ci]];
      if (!item) continue;
      try {
        const r = await window.__TAURI__.invoke("restore_trash", { path: item.path });
        if (r && r.restored_to) delete this._selected[idxs[ci]];
      } catch(e) { alert(t("trash.restore_failed").replace("{name}", item.name || "?") + "\n" + e); }
    }
    await this.open();
  }

  async _deleteSelected() {
    const t = this._t.bind(this);
    const idxs = Object.keys(this._selected).map(Number).filter(function(i) { return !isNaN(i); });
    if (idxs.length === 0) { alert(t("trash.no_selection")); return; }
    if (!confirm(t("trash.delete_confirm").replace("{n}", idxs.length))) return;
    for (let ci = 0; ci < idxs.length; ci++) {
      const item = this._items[idxs[ci]];
      if (!item) continue;
      try {
        await window.__TAURI__.invoke("delete_permanent", { path: item.path });
        delete this._selected[idxs[ci]];
      } catch(e) { alert(t("trash.delete_failed").replace("{name}", item.name || "?") + "\n" + e); }
    }
    await this.open();
  }
}
