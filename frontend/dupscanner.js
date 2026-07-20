/**
 * Duplicate File Scanner — progress overlay + results UI
 * Same animated popup style as the main tree scanner.
 */
class DupScanner {
  constructor() {
    this.overlay = null;
    this.resultsPanel = null;
    this._createUI();
  }

  _createUI() {
    // ── Progress Overlay ──────────────────────────────
    this.overlay = document.createElement("div");
    this.overlay.id = "dup-progress-overlay";
    this.overlay.style.cssText = "display:none;position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);align-items:center;justify-content:center;";
    this.overlay.innerHTML = `
      <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:16px;padding:32px 40px;max-width:480px;width:90%;text-align:center;box-shadow:0 16px 48px rgba(0,0,0,0.4);">
        <div style="font-size:40px;margin-bottom:12px;">🔍</div>
        <h3 style="margin:0 0 6px 0;font-size:16px;color:var(--text-primary);">Scanning for Duplicates</h3>
        <p id="dup-progress-status" style="margin:0 0 20px 0;font-size:13px;color:var(--text-secondary);">Hashing files...</p>
        <div style="display:flex;gap:20px;justify-content:center;margin-bottom:16px;">
          <div><div style="font-size:18px;font-weight:600;color:var(--text-primary);" id="dup-progress-files">0</div><div style="font-size:11px;color:var(--text-muted);">Files</div></div>
          <div><div style="font-size:18px;font-weight:600;color:var(--text-primary);" id="dup-progress-groups">0</div><div style="font-size:11px;color:var(--text-muted);">Groups</div></div>
          <div><div style="font-size:18px;font-weight:600;color:var(--text-primary);" id="dup-progress-wasted">0 B</div><div style="font-size:11px;color:var(--text-muted);">Wasted</div></div>
        </div>
        <div id="dup-progress-bar-wrap" style="width:100%;height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;margin-bottom:16px;">
          <div id="dup-progress-bar" style="width:0%;height:100%;background:linear-gradient(90deg,#238636,#2ea043);border-radius:2px;transition:width 0.3s;"></div>
        </div>
        <div id="dup-progress-file" style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:16px;">—</div>
        <div style="display:flex;gap:8px;justify-content:center;">
          <button id="dup-cancel-btn" style="padding:8px 20px;font-size:13px;color:var(--text-primary);background:var(--bg-tertiary);border:1px solid var(--border);border-radius:6px;cursor:pointer;">✖ Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.overlay);

    // ── Results Panel ──────────────────────────────
    this.resultsPanel = document.createElement("div");
    this.resultsPanel.id = "dup-results-panel";
    this.resultsPanel.style.cssText = "display:none;margin-top:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);overflow:hidden;";
    this.resultsPanel.innerHTML = `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
        <h3 style="margin:0;font-size:14px;color:var(--text-primary);">🔍 Duplicate Files</h3>
        <span id="dup-summary" style="font-size:12px;color:var(--text-muted);"></span>
      </div>
      <div id="dup-groups-list" style="max-height:400px;overflow-y:auto;padding:8px;"></div>
      <div style="padding:8px 16px;border-top:1px solid var(--border);text-align:right;">
        <button id="dup-close-results" style="padding:6px 16px;font-size:12px;color:var(--text-primary);background:var(--bg-tertiary);border:1px solid var(--border);border-radius:4px;cursor:pointer;">Close</button>
      </div>
    `;
    document.body.appendChild(this.resultsPanel);

    // ── Event wiring ──
    document.getElementById("dup-cancel-btn").onclick = () => this.cancel();
    document.getElementById("dup-close-results").onclick = () => {
      this.resultsPanel.style.display = "none";
    };
  }

  async start(path) {
    this.overlay.style.display = "flex";
    this.resultsPanel.style.display = "none";
    document.getElementById("dup-progress-bar").style.width = "0%";
    this._running = true;
    this._groups = [];

    // Poll for progress (module sends status via callback → bridge → JS)
    var self = this;
    var poll = setInterval(async function() {
      if (!self._running) { clearInterval(poll); return; }
      try {
        var stats = await window.__TAURI__.invoke("get_dup_stats", {});
        if (stats) {
          self._updateProgress(stats);
        }
      } catch(e) {}
    }, 200);

    try {
      var result = await window.__TAURI__.invoke("find_duplicates", { path: path });
      this._running = false;
      clearInterval(poll);
      this.overlay.style.display = "none";

      if (result && result.success && result.data) {
        var data = typeof result.data === "string" ? JSON.parse(result.data) : result.data;
        this._showResults(data);
      }
    } catch(e) {
      this._running = false;
      clearInterval(poll);
      this.overlay.style.display = "none";
      console.error("Duplicate scan failed:", e);
    }
  }

  cancel() {
    this._running = false;
    window.__TAURI__.invoke("cancel_dup_scan", {}).catch(function(){});
    this.overlay.style.display = "none";
  }

  _updateProgress(stats) {
    var files = document.getElementById("dup-progress-files");
    var groups = document.getElementById("dup-progress-groups");
    var wasted = document.getElementById("dup-progress-wasted");
    var status = document.getElementById("dup-progress-status");
    var bar = document.getElementById("dup-progress-bar");
    var file = document.getElementById("dup-progress-file");

    if (files) files.textContent = (stats.filesScanned || 0).toLocaleString();
    if (groups) groups.textContent = (stats.groups || 0).toLocaleString();
    if (wasted) wasted.textContent = this._fmtSize(stats.wastedBytes || 0);
    if (file) file.textContent = stats.currentFile || "";
    if (status) {
      if (stats.phase === 3) status.textContent = "Processing results...";
      else status.textContent = "Hashing files...";
    }
    // Animated bar (indeterminate progress)
    if (bar) {
      var pct = Math.min(95, (stats.filesScanned || 0) / 10000 * 100);
      bar.style.width = pct + "%";
    }
  }

  _showResults(data) {
    var list = document.getElementById("dup-groups-list");
    var summary = document.getElementById("dup-summary");
    list.innerHTML = "";

    var groups = data.groups || [];
    if (groups.length === 0) {
      list.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:13px;">No duplicate files found ✨</div>';
      if (summary) summary.textContent = "0 groups";
      this.resultsPanel.style.display = "block";
      return;
    }

    if (summary) {
      summary.textContent = groups.length + " groups · " + this._fmtSize(data.wastedBytes || 0) + " reclaimable";
    }

    groups.forEach(function(g, gi) {
      var card = document.createElement("div");
      card.style.cssText = "margin-bottom:8px;border:1px solid var(--border);border-radius:6px;overflow:hidden;";

      var header = document.createElement("div");
      header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--bg-tertiary);cursor:pointer;";
      header.innerHTML = `
        <span style="font-size:12px;color:var(--text-primary);font-weight:500;">${g.count} copies · ${g.sizeHuman || this._fmtSize(g.size)} each</span>
        <span style="font-size:11px;color:var(--text-muted);">${g.wastedHuman || this._fmtSize(g.wasted)} reclaimable</span>
      `;
      card.appendChild(header);

      var body = document.createElement("div");
      body.style.cssText = "padding:4px 8px;";
      (g.files || []).forEach(function(fp, fi) {
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 4px;border-radius:3px;cursor:pointer;font-size:12px;color:var(--text-secondary);";
        row.innerHTML = `<span style="color:var(--text-muted);">${fi + 1}.</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${fp}</span>`;
        row.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
        row.onmouseleave = function() { this.style.background = "transparent"; };
        row.onclick = function() {
          window.__TAURI__.invoke("open_explorer", { path: fp }).catch(function(){});
        };
        body.appendChild(row);
      });
      card.appendChild(body);

      // Toggle expand on header click
      var expanded = false;
      header.onclick = function() {
        expanded = !expanded;
        body.style.display = expanded ? "block" : "none";
      };
      body.style.display = "none";

      list.appendChild(card);
    });

    this.resultsPanel.style.display = "block";
  }

  _fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    var v = bytes / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
  }
}
