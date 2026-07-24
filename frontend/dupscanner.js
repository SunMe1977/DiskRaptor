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

    try {
      await window.__TAURI__.invoke("find_duplicates", { path: path });
    } catch(e) {
      this._running = false;
      this.overlay.style.display = "none";
      console.error("Failed to start duplicate scan:", e);
      return;
    }

    var self = this;
    var poll = setInterval(async function() {
      if (!self._running) { clearInterval(poll); return; }
      try {
        var stats = await window.__TAURI__.invoke("get_dup_stats", {});
        if (stats) {
          self._updateProgress(stats);
          if (stats.phase === 3) {
            clearInterval(poll);
            self.overlay.style.display = "none";
            try {
              var data = await window.__TAURI__.invoke("get_dup_result", {});
              if (data && data.groups) {
                self._showResults(data);
              }
            } catch(e) {
              console.error("Failed to get dup result:", e);
            }
          } else if (stats.phase === 0) {
            clearInterval(poll);
            self.overlay.style.display = "none";
          }
        }
      } catch(e) {}
    }, 200);
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
      list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">\u2728 No duplicate files found</div>';
      if (summary) summary.textContent = "0 groups";
      this.resultsPanel.style.display = "block";
      return;
    }

    var totalWasted = data.wastedBytes || 0;
    if (summary) {
      summary.textContent = groups.length + " groups \u00B7 " + this._fmtSize(totalWasted) + " reclaimable";
    }

    // Add delete selected button
    var toolbar = document.createElement("div");
    toolbar.style.cssText = "padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg-tertiary);";
    toolbar.innerHTML = `
      <span style="font-size:13px;color:var(--text-primary);font-weight:500;">\uD83D\uDD0D <span id="dup-selected-count">0</span> files selected to delete</span>
      <button id="dup-delete-btn" style="padding:8px 20px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#da3633,#f85149);border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(248,81,73,0.3);">\uD83D\uDDD1 Delete Selected</button>
    `;
    list.appendChild(toolbar);

    var self = this;
    var checkStates = {}; // groupIndex -> set of file indices to delete
    var totalChecked = 0;

    function updateSelectedCount() {
      var el = document.getElementById("dup-selected-count");
      if (el) el.textContent = totalChecked;
    }

    groups.forEach(function(g, gi) {
      // Pre-select all except the first file (keep one copy)
      var preSelected = [];
      for (var fi = 1; fi < g.files.length; fi++) preSelected.push(fi);
      checkStates[gi] = new Set(preSelected);
      totalChecked += preSelected.length;

      var card = document.createElement("div");
      card.style.cssText = "margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden;opacity:0;transform:translateY(10px);transition:opacity 0.3s,transform 0.3s;";

      var header = document.createElement("div");
      header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-tertiary);cursor:pointer;user-select:none;";
      header.innerHTML = `
        <span style="font-size:13px;color:var(--text-primary);font-weight:500;">\uD83D\uDCC1 ${g.count} copies \u00B7 ${g.sizeHuman || self._fmtSize(g.size)} each</span>
        <span style="font-size:12px;color:var(--text-muted);">\u267B ${g.wastedHuman || self._fmtSize(g.wasted)} <span style="color:#f85149;">reclaimable</span></span>
      `;
      card.appendChild(header);

      var body = document.createElement("div");
      body.style.cssText = "padding:4px 0;background:var(--bg-secondary);";

      (g.files || []).forEach(function(fp, fi) {
        var checked = preSelected.indexOf(fi) >= 0;
        var row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:0;font-size:12px;color:var(--text-secondary);transition:background 0.15s;";
        row.innerHTML = `
          <input type="checkbox" ${checked ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;accent-color:#f85149;flex-shrink:0;">
          <span style="color:var(--text-muted);font-size:10px;width:20px;flex-shrink:0;">${fi === 0 ? '\uD83D\uDD19 keep' : '\uD83D\uDDD1'}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${fp}</span>
          <span style="color:var(--text-muted);font-size:10px;">${self._fmtSize(g.size)}</span>
        `;
        
        var cb = row.querySelector('input');
        cb.onchange = function() {
          if (cb.checked) {
            checkStates[gi].add(fi);
            totalChecked++;
          } else {
            checkStates[gi].delete(fi);
            totalChecked--;
          }
          updateSelectedCount();
        };

        // Click on row (not checkbox) toggles checkbox
        row.onclick = function(e) {
          if (e.target !== cb) {
            cb.checked = !cb.checked;
            cb.onchange();
          }
        };
        row.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
        row.onmouseleave = function() { this.style.background = "transparent"; };

        body.appendChild(row);
      });
      card.appendChild(body);

      // Toggle expand
      var expanded = true;
      header.onclick = function() {
        expanded = !expanded;
        body.style.display = expanded ? "block" : "none";
        header.querySelector('span:first-child').textContent = (expanded ? '\u25BC' : '\u25B6') + ' ' + g.count + ' copies';
      };

      list.appendChild(card);

      // Animate cards appearing one by one
      (function(cardEl, delay) {
        setTimeout(function() {
          cardEl.style.opacity = "1";
          cardEl.style.transform = "translateY(0)";
        }, delay);
      })(card, gi * 120);
    });

    updateSelectedCount();

    // Delete button handler
    var self2 = this;
    document.getElementById("dup-delete-btn").onclick = function() {
      var toDelete = [];
      groups.forEach(function(g, gi) {
        var selected = checkStates[gi];
        if (!selected) return;
        selected.forEach(function(fi) {
          if (g.files[fi]) toDelete.push(g.files[fi]);
        });
      });

      if (toDelete.length === 0) {
        alert("No files selected to delete.");
        return;
      }

      if (!confirm("Delete " + toDelete.length + " duplicate files?\nThis cannot be undone.")) return;

      // Delete one by one with status updates
      var delBtn = document.getElementById("dup-delete-btn");
      delBtn.disabled = true;
      delBtn.textContent = "Deleting...";

      (function deleteNext(idx) {
        if (idx >= toDelete.length) {
          delBtn.textContent = "\u2705 Deleted " + toDelete.length + " files";
          delBtn.style.background = "#238636";
          return;
        }
        window.__TAURI__.invoke("delete_path", { path: toDelete[idx] })
          .then(function() {
            delBtn.textContent = "Deleting " + (idx + 1) + "/" + toDelete.length + "...";
            setTimeout(function() { deleteNext(idx + 1); }, 200);
          })
          .catch(function(err) {
            alert("Failed to delete: " + toDelete[idx] + "\n" + err);
            setTimeout(function() { deleteNext(idx + 1); }, 200);
          });
      })(0);
    };

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
