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
        <p id="dup-progress-status" style="margin:0 0 20px 0;font-size:13px;color:var(--text-secondary);" data-i18n="dup.scanning">Scanning files...</p>
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

    const self = this;
    const poll = setInterval(async function() {
      if (!self._running) { clearInterval(poll); return; }
      try {
        const stats = await window.__TAURI__.invoke("get_dup_stats", {});
        if (stats) {
          self._updateProgress(stats);
          if (stats.phase === 3) {
            clearInterval(poll);
            self.overlay.style.display = "none";
            try {
              const data = await window.__TAURI__.invoke("get_dup_result", {});
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

  async cancel() {
    this._running = false;
    await window.__TAURI__.invoke("cancel_dup_scan", {}).catch(function(){});
    // Poll for result until available (thread may still be cleaning up)
    let data = null;
    for (let ci = 0; ci < 30; ci++) {
      await new Promise(function(r) { setTimeout(r, 100); });
      try {
        data = await window.__TAURI__.invoke("get_dup_result", {}).catch(function(){return null;});
        // data is valid if it has 'groups' (even empty array is valid)
        if (data && data.groups !== undefined) break;
        data = null;
      } catch(e) {}
    }
    if (data && data.groups) {
      this._showResults(data, true);
    } else {
      this._showResults({ groups: [], totalFilesScanned: (data && data.filesScanned) || 0, cancelled: true }, true);
    }
    this.overlay.style.display = "none";
  }

  _updateProgress(stats) {
    const files = document.getElementById("dup-progress-files");
    const groups = document.getElementById("dup-progress-groups");
    const wasted = document.getElementById("dup-progress-wasted");
    const status = document.getElementById("dup-progress-status");
    const bar = document.getElementById("dup-progress-bar");
    const file = document.getElementById("dup-progress-file");

    if (files) files.textContent = (stats.filesScanned || 0).toLocaleString();
    if (groups) groups.textContent = (stats.groups || 0).toLocaleString();
    if (wasted) wasted.textContent = this._fmtSize(stats.wastedBytes || 0);
    if (file) file.textContent = stats.currentFile || "";
    if (status) {
      const t = window.__ || function(s){return s;};
      if (stats.phase === 3) status.textContent = t("dup.processing");
      else if (stats.phase === 2) status.textContent = t("dup.hashing");
      else status.textContent = t("dup.scanning");
    }
    // Animated bar (indeterminate progress)
    if (bar) {
      const pct = Math.min(95, (stats.filesScanned || 0) / 10000 * 100);
      bar.style.width = pct + "%";
    }
  }

  _showResults(data, cancelled) {
    const list = document.getElementById("dup-groups-list");
    const summary = document.getElementById("dup-summary");
    list.innerHTML = "";

    const groups = data.groups || [];
    const t = window.__ || function(s){return s;};
    let headerText = groups.length + " groups \u00B7 " + this._fmtSize(data.wastedBytes || 0) + " reclaimable";
    if (cancelled && groups.length > 0) {
      headerText = "⚠ " + t("dup.cancelled") + " \u2014 " + headerText + " (partial)";
    } else if (cancelled) {
      headerText = t("dup.cancelled") + " \u2014 " + t("dup.no_duplicates");
    }

    if (groups.length === 0) {
      list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:14px;">\u2728 ' + (cancelled ? t("dup.cancelled") : t("dup.no_duplicates")) + '</div>';
      if (summary) summary.textContent = headerText;
      this.resultsPanel.style.display = "block";
      return;
    }

    if (summary) summary.textContent = headerText;

    // Add delete selected button
    const toolbar = document.createElement("div");
    toolbar.style.cssText = "padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:var(--bg-tertiary);flex-wrap:wrap;gap:6px;";
    toolbar.innerHTML = `
      <span style="font-size:13px;color:var(--text-primary);font-weight:500;">\uD83D\uDD0D <span id="dup-selected-count">0</span> files selected to delete \u00B7 <span style="color:#f85149;">${this._fmtSize(data.wastedBytes || 0)} reclaimable</span></span>
      <span style="display:flex;gap:6px;">
        <button id="dup-select-none" style="padding:6px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">Select None</button>
        <button id="dup-select-all" style="padding:6px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer;">Select All</button>
        <button id="dup-delete-btn" style="padding:8px 20px;font-size:13px;font-weight:600;color:#fff;background:linear-gradient(135deg,#da3633,#f85149);border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 8px rgba(248,81,73,0.3);">\uD83D\uDDD1 <span data-i18n="action.move_selected_to_trash">Move Selected to Trash</span></button>
      </span>
    `;
    list.appendChild(toolbar);

    const self = this;
    const checkStates = {}; // groupIndex -> set of file indices to delete
    let totalChecked = 0;

    function updateSelectedCount() {
      const el = document.getElementById("dup-selected-count");
      if (el) el.textContent = totalChecked;
    }

    // Select None: uncheck everything
    const selNone = document.getElementById("dup-select-none");
    if (selNone) {
      selNone.onclick = function () {
        for (const sg in checkStates) checkStates[sg] = new Set();
        totalChecked = 0;
        list.querySelectorAll('#dup-groups-list input[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
        updateSelectedCount();
      };
    }
    // Select All: keep one copy per group, select the rest
    const selAll = document.getElementById("dup-select-all");
    if (selAll) {
      selAll.onclick = function () {
        totalChecked = 0;
        groups.forEach(function (g, gi) {
          checkStates[gi] = new Set();
          for (let fi = 1; fi < g.files.length; fi++) { checkStates[gi].add(fi); totalChecked++; }
        });
        list.querySelectorAll('.dup-group-body input[type="checkbox"]').forEach(function (cb, ci) {
          cb.checked = true;
        });
        groups.forEach(function (g, gi) {
          const card = list.querySelectorAll(".dup-group-card")[gi];
          if (card) {
            const cbs = card.querySelectorAll('input[type="checkbox"]');
            for (let fi = 0; fi < g.files.length; fi++) {
              if (cbs[fi]) cbs[fi].checked = fi > 0;
            }
          }
        });
        updateSelectedCount();
      };
    }

    groups.forEach(function(g, gi) {
      // Pre-select all except the first file (keep one copy)
      const preSelected = [];
      for (let fi = 1; fi < g.files.length; fi++) preSelected.push(fi);
      checkStates[gi] = new Set(preSelected);
      totalChecked += preSelected.length;

      const card = document.createElement("div");
      card.className = "dup-group-card";
      card.style.cssText = "margin-bottom:8px;border:1px solid var(--border);border-radius:8px;overflow:hidden;opacity:0;transform:translateY(10px);transition:opacity 0.3s,transform 0.3s;";

      const header = document.createElement("div");
      header.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg-tertiary);cursor:pointer;user-select:none;";
      header.innerHTML = `
        <span style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-primary);font-weight:500;"><input type="checkbox" id="selall-${gi}" style="width:14px;height:14px;cursor:pointer;accent-color:#f85149;"> \uD83D\uDCC1 ${g.count} copies \u00B7 ${g.sizeHuman || self._fmtSize(g.size)} each</span>
        <span style="font-size:12px;color:var(--text-muted);">\u267B ${g.wastedHuman || self._fmtSize(g.wasted)} <span style="color:#f85149;">reclaimable</span></span>
      `;
      card.appendChild(header);
      // Select-all checkbox in header
      const selAll = header.querySelector("input");
      selAll.checked = true; // all except first are selected by default
      selAll.onclick = function(e) {
        e.stopPropagation();
        const checked = selAll.checked;
        checkStates[gi] = new Set();
        totalChecked = 0;
        // Recalculate total and update checkboxes
        g.files.forEach(function(fp, fi) {
          const cb = body.querySelectorAll('input[type="checkbox"]')[fi];
          if (cb) {
            if (checked && fi > 0) { // don't select first (keep one)
              cb.checked = true;
              checkStates[gi].add(fi);
            } else {
              cb.checked = fi === 0; // always keep first checked (but excluded)
            }
          }
        });
        if (checked) {
          for (let fi = 1; fi < g.files.length; fi++) checkStates[gi].add(fi);
        }
        totalChecked = 0;
        for (const sg in checkStates) totalChecked += checkStates[sg].size;
        updateSelectedCount();
      };

      const body = document.createElement("div");
      body.className = "dup-group-body";
      body.style.cssText = "padding:4px 0;background:var(--bg-secondary);";

      (g.files || []).forEach(function(fp, fi) {
        const checked = preSelected.indexOf(fi) >= 0;
        const row = document.createElement("div");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px 14px;border-radius:0;font-size:12px;color:var(--text-secondary);transition:background 0.15s;";
        row.innerHTML = `
          <input type="checkbox" ${checked ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;accent-color:#f85149;flex-shrink:0;">
          <span style="color:var(--text-muted);font-size:10px;width:20px;flex-shrink:0;">${fi === 0 ? '\uD83D\uDD19 keep' : '\uD83D\uDDD1'}</span>
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">${fp}</span>
          <span style="color:var(--text-muted);font-size:10px;">${self._fmtSize(g.size)}</span>
        `;
        
        const cb = row.querySelector('input');
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
      let expanded = true;
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
    const self2 = this;
    document.getElementById("dup-delete-btn").onclick = async function() {
      const toDelete = [];
      groups.forEach(function(g, gi) {
        const selected = checkStates[gi];
        if (!selected) return;
        selected.forEach(function(fi) {
          if (g.files[fi]) toDelete.push(g.files[fi]);
        });
      });

      if (toDelete.length === 0) {
        window.alertDialog("No files selected.");
        return;
      }

      const ok = await window.confirmDialog(
        "Move " + toDelete.length + " duplicate files to Trash?",
      );
      if (!ok) return;

      // Move one by one with status updates
      const delBtn = document.getElementById("dup-delete-btn");
      delBtn.disabled = true;
      delBtn.textContent = "Moving to Trash...";

      (function deleteNext(idx) {
        if (idx >= toDelete.length) {
          delBtn.textContent = "\u2705 " + toDelete.length + " files moved to Trash";
          delBtn.style.background = "#238636";
          return;
        }
        window.__TAURI__.invoke("delete_path", { path: toDelete[idx] })
          .then(function() {
            delBtn.textContent = "Moving " + (idx + 1) + "/" + toDelete.length + "...";
            setTimeout(function() { deleteNext(idx + 1); }, 200);
          })
          .catch(function(err) {
            window.alertDialog("Failed: " + toDelete[idx] + "\n" + err);
            setTimeout(function() { deleteNext(idx + 1); }, 200);
          });
      })(0);
    };

    this.resultsPanel.style.display = "block";
  }

  _fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const v = bytes / Math.pow(1024, i);
    return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
  }
}
