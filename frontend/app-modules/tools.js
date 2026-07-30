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
})();
