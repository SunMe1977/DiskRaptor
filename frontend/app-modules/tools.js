(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initTools = function (refs) {
    const state = window.app.state;
    const { scanPath, btnScan, showWelcome } = refs;

    const btnTools = document.getElementById("btn-tools");
    const toolsMenu = document.getElementById("tools-menu");
    if (!btnTools || !toolsMenu) return;

    btnTools.addEventListener("click", function (e) {
      e.stopPropagation();
      toolsMenu.classList.toggle("active");
    });

    document.addEventListener("click", function () {
      toolsMenu.classList.remove("active");
    });

    toolsMenu.addEventListener("click", async function (e) {
      const item = e.target.closest(".tools-item");
      if (!item) return;
      const action = item.dataset.action;
      toolsMenu.classList.remove("active");

      if (action === "scan-downloads") {
        window.__TAURI__
          .invoke("get_home_dir")
          .then(function (home) {
            const p =
              typeof home === "string" ? home : (home?.data || "");
            const dl = p
              ? p.replace(/[\\/]+$/, "") + "/Downloads"
              : "";
            if (dl && scanPath) {
              scanPath.value = dl;
              btnScan.click();
            }
          })
          .catch(function () {});
      } else if (action === "scan-trash") {
        window.__TAURI__
          .invoke("get_home_dir")
          .then(function (home) {
            const p =
              typeof home === "string" ? home : (home?.data || "");
            const tr = p
              ? p.replace(/[\\/]+$/, "") + "/.Trash"
              : "";
            if (tr && scanPath) {
              scanPath.value = tr;
              btnScan.click();
            }
          })
          .catch(function () {});
      } else if (action === "clear-scan") {
        state.currentStats = null;
        state.currentScanResult = null;
        const loader = window.__loader;
        const treeView = window.__treeView;
        if (loader)
          loader.release().catch(function () {});
        if (treeView) {
          treeView.visibleNodes = [];
          treeView.expanded.clear();
          treeView.selectedIndex = null;
          treeView.rebuild().catch(function () {});
        }
        if (window.__statsPanel) window.__statsPanel.clear();
        if (window.__diagram) window.__diagram.setData(null);
        if (window.__topFiles) window.__topFiles.render([], true);
        document.querySelector(".status-bar").textContent = (
          window.__ || function (s) { return s; }
        )("status.clear_scan");
        showWelcome();
      } else if (action === "settings") {
        const so = document.getElementById("settings-overlay");
        if (so) {
          const defPath = document.getElementById("settings-default-path");
          const selTheme = document.getElementById("settings-theme");
          if (defPath) defPath.value = scanPath.value || "";
          if (selTheme) selTheme.value = "auto";
          window.__TAURI__
            .invoke("load_settings", {})
            .then(function (s) {
              if (s) {
                if (defPath && s.default_scan_path)
                  defPath.value = s.default_scan_path;
                if (selTheme && s.theme)
                  selTheme.value = s.theme;
              }
            })
            .catch(function () {});
          so.style.display = "flex";
        }
      } else if (action === "duplicates") {
        const dupBtn = document.getElementById("btn-duplicates");
        if (dupBtn) dupBtn.click();
      } else if (action === "empty-folders") {
        const loader = window.__loader;
        if (!loader || !loader.allNodes) return;
        const nodes = loader.allNodes;
        const emptyDirs = [];
        for (let ni = 0; ni < nodes.length; ni++) {
          const n = nodes[ni];
          if (
            n &&
            (n.node_type === 0 || n.node_type === "Directory") &&
            n.file_count === 0 &&
            n.dir_count === 0 &&
            n.parent !== 4294967295
          ) {
            emptyDirs.push({ name: n.name, arenaIdx: ni });
          }
        }
        if (emptyDirs.length === 0) {
          window.showToast("No empty folders found", "info");
          return;
        }
        let html2 =
          '<div style="padding:16px;max-height:300px;overflow-y:auto;">';
        for (
          let ei = 0;
          ei < Math.min(emptyDirs.length, 500);
          ei++
        ) {
          html2 +=
            '<div class="empty-folder-item" data-idx="' +
            emptyDirs[ei].arenaIdx +
            '" style="padding:3px 8px;cursor:pointer;border-radius:4px;font-size:12px;">\uD83D\uDCC2 ' +
            emptyDirs[ei].name +
            "</div>";
        }
        if (emptyDirs.length > 500)
          html2 +=
            '<div style="padding:4px;text-align:center;color:var(--text-muted);font-size:11px;">+ ' +
            (emptyDirs.length - 500) +
            " more</div>";
        html2 += "</div>";
        const ov2 = document.createElement("div");
        ov2.style.cssText =
          "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
        const card2 = document.createElement("div");
        card2.style.cssText =
          "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:400px;width:90%;max-height:80vh;overflow:hidden;";
        card2.innerHTML =
          '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">\uD83D\uDCC2 Empty Folders (' +
          emptyDirs.length +
          ")</div>" +
          html2 +
          '<div style="padding:8px 16px;border-top:1px solid var(--border);text-align:right;"><button class="ef-close-btn" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button></div>';
        ov2.appendChild(card2);
        document.body.appendChild(ov2);
        ov2.querySelector(".ef-close-btn").onclick = function () {
          document.body.removeChild(ov2);
        };
        ov2.onclick = function (e) {
          if (e.target === ov2) document.body.removeChild(ov2);
        };
        ov2.querySelectorAll(".empty-folder-item").forEach(function (
          el,
        ) {
          el.onclick = function () {
            const idx = parseInt(this.dataset.idx);
            if (!isNaN(idx) && window.__treeView) {
              window.__treeView.select(idx);
              document.body.removeChild(ov2);
            }
          };
          el.onmouseenter = function () {
            this.style.background = "var(--bg-hover)";
          };
          el.onmouseleave = function () {
            this.style.background = "transparent";
          };
        });
      } else if (action === "export-html") {
        const stats = state.currentStats || {};
        const svg = document.querySelector(
          "#diagram-container canvas",
        );
        let chartData = "";
        try {
          chartData = svg ? svg.toDataURL() : "";
        } catch (e) {}
        let fileRows = "";
        const nodes =
          (window.__loader && window.__loader.allNodes) || [];
        for (
          let hni = 0;
          hni < Math.min(nodes.length, 200);
          hni++
        ) {
          const hn = nodes[hni];
          if (!hn) continue;
          fileRows +=
            "<tr><td>" +
            (hn.name || "") +
            "</td><td>" +
            (hn.size || 0) +
            "</td></tr>\n";
        }
        const htmlReport =
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DiskRaptor Report</title><style>body{font-family:sans-serif;margin:20px;color:#333}h1{color:#2ea043}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#f5f5f5}</style></head><body>' +
          "<h1>\uD83E\uDD96 DiskRaptor Report</h1>" +
          "<p>Path: " +
          (scanPath.value || "") +
          "</p>" +
          "<p>Files: " +
          (stats.total_files || 0) +
          " | Dirs: " +
          (stats.total_dirs || 0) +
          " | Size: " +
          (stats.size_human || "0 B") +
          "</p>" +
          (chartData
            ? '<img src="' + chartData + '" style="max-width:600px;">'
            : "") +
          "<h2>Files</h2><table><tr><th>Name</th><th>Size</th></tr>" +
          fileRows +
          "</table>" +
          '<p style="color:#999;font-size:11px;margin-top:20px;">Generated by DiskRaptor</p></body></html>';
        const blob = new Blob([htmlReport], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "diskraptor-report-" + Date.now() + ".html";
        a.click();
        URL.revokeObjectURL(url);
      } else if (action === "find-files") {
        const query = prompt(
          "Find files by name (e.g. *.jpg, *test*, partial name):",
          "*",
        );
        if (!query) return;
        const loader = window.__loader;
        const treeView = window.__treeView;
        if (!loader || !loader.allNodes) return;
        const nodes = loader.allNodes;
        const results = [];
        const pattern = query
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
          .toLowerCase();
        let re;
        try {
          re = new RegExp("^" + pattern + "$", "i");
        } catch (e) {
          return;
        }
        for (let ni = 0; ni < nodes.length; ni++) {
          const n = nodes[ni];
          if (n && n.name && re.test(n.name)) {
            const fullPath = scanPath.value.replace(/[\\/]+$/, "");
            const parts = [n.name];
            let p = n.parent;
            let safety = 0;
            while (
              p !== 4294967295 &&
              p !== undefined &&
              safety < 20
            ) {
              const parent = nodes[p];
              if (parent && parent.name)
                parts.unshift(parent.name);
              p = parent ? parent.parent : 4294967295;
              safety++;
            }
            results.push({
              name: n.name,
              path: fullPath + "/" + parts.join("/"),
              size: n.size,
              arenaIdx: ni,
            });
          }
        }
        if (results.length === 0) {
          window.showToast(
            "No files found matching: " + query,
            "info",
          );
          return;
        }
        results.sort(function (a, b) {
          return b.size - a.size;
        });
        let html =
          '<div style="padding:16px;max-height:300px;overflow-y:auto;">';
        for (let ri = 0; ri < Math.min(results.length, 200); ri++) {
          const r = results[ri];
          html +=
            '<div class="find-file-item" data-idx="' +
            r.arenaIdx +
            '" style="padding:4px 8px;cursor:pointer;border-radius:4px;font-size:12px;display:flex;gap:8px;">';
          html +=
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            r.name +
            "</span>";
          html +=
            '<span style="font-family:monospace;color:var(--text-muted);font-size:11px;">' +
            (r.size
              ? (r.size / 1024).toFixed(1) + " KB"
              : "") +
            "</span>";
          html += "</div>";
        }
        if (results.length > 200)
          html +=
            '<div style="padding:4px;text-align:center;color:var(--text-muted);font-size:11px;">+ ' +
            (results.length - 200) +
            " more</div>";
        html += "</div>";
        const ov = document.createElement("div");
        ov.style.cssText =
          "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
        const card = document.createElement("div");
        card.style.cssText =
          "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:500px;width:90%;max-height:80vh;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.4);";
        card.innerHTML =
          '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">\uD83D\uDD0E Find Files (' +
          results.length +
          " matches)</div>" +
          html +
          '<div style="padding:8px 16px;border-top:1px solid var(--border);text-align:right;"><button class="find-close-btn" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button></div>';
        ov.appendChild(card);
        document.body.appendChild(ov);
        ov.querySelector(".find-close-btn").onclick = function () {
          document.body.removeChild(ov);
        };
        ov.onclick = function (e) {
          if (e.target === ov) document.body.removeChild(ov);
        };
        ov.querySelectorAll(".find-file-item").forEach(function (el) {
          el.onclick = function () {
            const idx = parseInt(this.dataset.idx);
            if (!isNaN(idx) && treeView) {
              treeView.select(idx);
              document.body.removeChild(ov);
            }
          };
          el.onmouseenter = function () {
            this.style.background = "var(--bg-hover)";
          };
          el.onmouseleave = function () {
            this.style.background = "transparent";
          };
        });
      } else if (action === "cleanup-downloads") {
        const stb = document.querySelector(".status-bar");
        if (stb) stb.textContent = "Scanning Downloads...";
        window.__TAURI__.invoke("get_home_dir").then(function (home) {
          var p = typeof home === "string" ? home : (home?.data || "");
          var dl = p ? p.replace(/[\\/]+$/, "") + "/Downloads" : "";
          if (dl && scanPath) {
            scanPath.value = dl;
            btnScan.click();
          }
        }).catch(function () {});
        return;
      } else if (action === "smart-tools") {
        openSmartTools();
      } else if (action === "trash-recovery") {
        if (!window.__trashRecovery)
          window.__trashRecovery = new TrashRecovery();
        window.__trashRecovery.open();
      } else if (action === "trash") {
        const t = window.__ || function (s) { return s; };
        if (!confirm(t("confirm.empty_trash"))) return;
        try {
          item.textContent = "\u23F3 Emptying...";
          await window.__TAURI__.invoke("empty_trash", {});
          document.querySelector(".status-bar").textContent = t(
            "status.trash_emptied",
          );
        } catch (e) {
          console.warn("Empty trash:", e);
          window.showToast("Failed: " + e, "error");
        }
        setTimeout(function () {
          item.textContent = "\uD83D\uDDD1\uFE0F Empty Trash";
        }, 3000);
      }
    });
  };

  // ── S.M.A.R.T. Tools overlay ─────────────────────────────
  function fmtBytes(b) {
    if (!b || b <= 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 4);
    return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + u[i];
  }
  function fmtHours(h) {
    if (!h) return "—";
    const y = Math.floor(h / 8760);
    const d = Math.floor((h % 8760) / 24);
    return y > 0 ? y + "y " + d + "d" : d > 0 ? d + "d " + (h % 24) + "h" : h + "h";
  }
  function mediaLabel(t) {
    if (t === 4) return "SSD";
    if (t === 3) return "HDD";
    return "Unknown";
  }

  function openSmartTools() {
    const old = document.getElementById("smart-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "smart-overlay";
    overlay.className = "smart-overlay";
    overlay.innerHTML =
      '<div class="smart-card">' +
      '<div class="smart-header">' +
      '<span class="smart-title">\uD83D\uDEE1\uFE0F S.M.A.R.T. Tools</span>' +
      '<button class="smart-close" id="smart-close" title="Close">\u2715</button>' +
      "</div>" +
      '<div class="smart-body">' +
      '<div class="smart-drive-row">' +
      '<select class="smart-select" id="smart-drive"><option value="">Loading drives\u2026</option></select>' +
      '<button class="smart-scan-btn" id="smart-scan" disabled>Scan Health</button>' +
      "</div>" +
      '<div class="smart-status" id="smart-status"></div>' +
      '<div class="smart-result" id="smart-result"></div>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector("#smart-close");
    const select = overlay.querySelector("#smart-drive");
    const scanBtn = overlay.querySelector("#smart-scan");
    const statusEl = overlay.querySelector("#smart-status");
    const resultEl = overlay.querySelector("#smart-result");

    function close() { overlay.remove(); }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    }
    document.addEventListener("keydown", onKey);

    window.__TAURI__
      .invoke("list_disks")
      .then(function (res) {
        const disks = Array.isArray(res) ? res : (res && res.data ? res.data : []);
        if (!disks || disks.length === 0) {
          select.innerHTML = '<option value="">No disks found</option>';
          statusEl.textContent = "No physical disks detected.";
          return;
        }
        select.innerHTML = "";
        disks.forEach(function (d) {
          const opt = document.createElement("option");
          opt.value = String(d.id);
          const sizeStr = fmtBytes(typeof d.size === "number" ? d.size : 0);
          opt.textContent =
            (d.name || "Disk " + d.id) + (sizeStr ? " \u2014 " + sizeStr : "");
          select.appendChild(opt);
        });
        scanBtn.disabled = false;
      })
      .catch(function (e) {
        select.innerHTML = '<option value="">Error</option>';
        statusEl.textContent = "Could not list drives: " + (e && e.message ? e.message : e);
      });

    scanBtn.addEventListener("click", function () {
      const id = select.value;
      if (!id) return;
      scanBtn.disabled = true;
      scanBtn.textContent = "Scanning\u2026";
      statusEl.className = "smart-status";
      statusEl.innerHTML = '<span class="smart-spinner"></span>Querying S.M.A.R.T. attributes\u2026';
      resultEl.innerHTML = "";
      window.__TAURI__
        .invoke("get_smart_status", { deviceId: id })
        .then(function (r) {
          renderSmartResult(r);
        })
        .catch(function (e) {
          statusEl.className = "smart-status err";
          statusEl.textContent = "Error: " + (e && e.message ? e.message : e);
        })
        .finally(function () {
          scanBtn.disabled = false;
          scanBtn.textContent = "Scan Health";
        });
    });

    function esc(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function renderSmartResult(r) {
      if (!r) {
        statusEl.className = "smart-status err";
        statusEl.textContent = "No data returned.";
        return;
      }
      const attrs = Array.isArray(r.attributes) ? r.attributes : [];
      const statusTxt = r.status || (Number(r.score) >= 85 ? "Healthy" : Number(r.score) >= 55 ? "Warning" : "Critical");
      const low = statusTxt.toLowerCase();
      const bannerCls = low === "warning" ? "warn" : low === "critical" || low === "unhealthy" ? "crit" : "";
      const tempStr = r.temperature_c != null ? Math.round(r.temperature_c) + "\u00B0C" : "\u2014";

      function findAttr(re) {
        for (let i = 0; i < attrs.length; i++) {
          if (re.test(attrs[i].name || "")) return attrs[i];
        }
        return null;
      }
      const wearAttr = findAttr(/wear/i);
      const powhAttr = findAttr(/power on hours|power_on_hours/i);
      const cyclesAttr = findAttr(/power cycles/i);
      const errAttr = findAttr(/uncorrected|media errors/i);

      const wear =
        r.wear != null ? r.wear : wearAttr ? parseFloat(wearAttr.raw) : null;
      const powh =
        r.power_on_hours != null
          ? r.power_on_hours
          : powhAttr ? parseInt(powhAttr.raw) || 0 : 0;
      const cycles = cyclesAttr ? cyclesAttr.raw : null;
      const uncorrected =
        (r.read_errors_uncorrected || 0) + (r.write_errors_uncorrected || 0) +
        (errAttr ? parseInt(errAttr.raw) || 0 : 0);

      const capacityStr = r.capacity ? fmtBytes(r.capacity) : "";

      function cell(label, value) {
        return (
          '<div class="smart-info-cell"><div class="c-label">' +
          esc(label) +
          '</div><div class="c-value">' +
          esc(value) +
          "</div></div>"
        );
      }
      function tile(icon, label, value) {
        return (
          '<div class="smart-tile"><div class="tile-label">' +
          icon +
          " " +
          esc(label) +
          '</div><div class="tile-value">' +
          esc(value) +
          "</div></div>"
        );
      }

      let tableRows = "";
      if (attrs.length === 0) {
        tableRows =
          '<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--text-muted);">No S.M.A.R.T. attributes available.</td></tr>';
      } else {
        for (let ai = 0; ai < attrs.length; ai++) {
          const a = attrs[ai];
          const st = String(a.status || "OK").toLowerCase();
          const dotCls =
            st === "fail"
              ? "fail"
              : st === "warn" || st === "warning"
                ? "warn"
                : "ok";
          const stText =
            st === "fail" ? "FAIL" : st === "warn" || st === "warning" ? "WARN" : "OK";
          tableRows +=
            '<tr>' +
            '<td class="attr-id">' + esc(a.id != null ? a.id : "\u2014") + "</td>" +
            '<td class="attr-name">' + esc(a.name || "") + "</td>" +
            '<td class="attr-num">' + (a.current != null ? esc(a.current) : "\u2014") + "</td>" +
            '<td class="attr-num">' + (a.worst != null ? esc(a.worst) : "\u2014") + "</td>" +
            '<td class="attr-num">' + (a.threshold != null ? esc(a.threshold) : "\u2014") + "</td>" +
            '<td class="attr-raw">' + esc(a.raw || "\u2014") + "</td>" +
            '<td><span class="attr-status"><span class="attr-dot ' + dotCls + '"></span>' + stText + "</span></td>" +
            "</tr>";
        }
      }

      resultEl.innerHTML =
        '<div class="smart-banner ' + bannerCls + '">' +
        '<div class="banner-temp">' + tempStr + "</div>" +
        '<div class="banner-status">' + esc(statusTxt) + "</div>" +
        '<div class="banner-score">Health Score ' + (r.score != null ? esc(r.score) : "\u2014") + " / 100</div>" +
        '<div class="banner-scale"><div class="scale-track"><div class="scale-fill" style="width:' + Math.max(0, Math.min(100, Number(r.score) || 0)) + '%"></div></div></div>' +
        "</div>" +
        '<div class="smart-info-grid">' +
        cell("Model", r.model || "\u2014") +
        cell("Firmware", r.firmware || "\u2014") +
        cell("Serial", r.serial || "\u2014") +
        cell("Interface", r.interface || "\u2014") +
        cell("Capacity", capacityStr || "\u2014") +
        cell("Media", mediaLabel(r.media_type)) +
        "</div>" +
        '<div class="smart-tiles-row">' +
        tile("\u26A1", "Wear", wear != null ? wear + "%" : "\u2014") +
        tile("\u23F1\uFE0F", "Power-On Hours", fmtHours(powh)) +
        tile("\uD83D\uDD01", "Power Cycles", cycles != null ? cycles : "\u2014") +
        tile("\u274C", "Uncorrected", uncorrected) +
        "</div>" +
        '<div class="smart-table-wrap"><table class="smart-attr-table">' +
        "<thead><tr><th>ID</th><th>Attribute</th><th>Current</th><th>Worst</th><th>Threshold</th><th>RAW</th><th>Status</th></tr></thead>" +
        "<tbody>" + tableRows + "</tbody>" +
        "</table></div>";

      statusEl.className = "smart-status";
      const missingAttrs =
        r.temperature_c == null && (r.wear == null || r.percentage_used == null);
      if (r.source === "wmi" && missingAttrs) {
        statusEl.innerHTML =
          "Basic health report only. Run as administrator for the full S.M.A.R.T. attribute table (temperature, power cycles, percentage used). " +
          '<button class="smart-admin-btn" id="smart-admin-btn">Run as Administrator</button>';
        const ab = document.getElementById("smart-admin-btn");
        if (ab) {
          ab.onclick = function () {
            ab.disabled = true;
            ab.textContent = "Restarting\u2026";
            window.__TAURI__
              .invoke("restart_as_admin", {})
              .catch(function () {
                ab.disabled = false;
                ab.textContent = "Run as Administrator";
              });
          };
        }
      } else if (r.source === "wmi") {
        statusEl.textContent =
          "Health status retrieved from WMI. Install smartmontools for the full CrystalDiskInfo-style table.";
      } else {
        statusEl.textContent = "Scan complete.";
      }
    }
  }
})();
