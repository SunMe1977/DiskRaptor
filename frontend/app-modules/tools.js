(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initTools = function (refs) {
    const state = window.app.state;
    const { scanPath, btnScan, showWelcome } = refs;

    const btnTools = document.getElementById("btn-tools");
    const toolsMenu = document.getElementById("tools-menu");
    if (!btnTools || !toolsMenu) return;

    function resetAllState(message) {
      if (state.isScanning) {
        window.__TAURI__.invoke("cancel_scan", {}).catch(function () {});
        state.isScanning = false;
      }
      state.currentStats = null;
      state.currentScanResult = null;
      const loader = window.__loader;
      const treeView = window.__treeView;
      if (loader) loader.release().catch(function () {});
      if (treeView) {
        treeView.visibleNodes = [];
        treeView.expanded.clear();
        treeView.selectedIndex = null;
        treeView.rebuild().catch(function () {});
      }
      if (window.__statsPanel) window.__statsPanel.clear();
      if (window.__diagram) window.__diagram.setData(null);
      if (window.__topFiles) window.__topFiles.render([], true);
      const expBtn = document.getElementById("btn-export");
      if (expBtn) expBtn.disabled = true;
      const dupBtn = document.getElementById("btn-duplicates");
      if (dupBtn) dupBtn.style.display = "none";
      document.querySelector(".status-bar").textContent = message;
      showWelcome();
    }

    btnTools.addEventListener("click", function (e) {
      e.stopPropagation();
      toolsMenu.classList.toggle("active");
    });

    // Keyboard navigation: ArrowUp/Down move, Enter/Space activates.
    btnTools.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!toolsMenu.classList.contains("active")) {
          toolsMenu.classList.add("active");
        }
        const items = toolsMenu.querySelectorAll(".tools-item");
        if (items.length === 0) return;
        let idx = Array.prototype.indexOf.call(items, document.activeElement);
        if (idx < 0) idx = -1;
        if (e.key === "ArrowDown") idx = Math.min(idx + 1, items.length - 1);
        else if (e.key === "ArrowUp") idx = Math.max(idx - 1, 0);
        else {
          // Enter/Space on the trigger opens the menu and focuses the first item.
          idx = 0;
        }
        items[idx].focus();
      }
    });
    toolsMenu.addEventListener("keydown", function (e) {
      const items = toolsMenu.querySelectorAll(".tools-item");
      const idx = Array.prototype.indexOf.call(items, document.activeElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[Math.min(idx + 1, items.length - 1)].focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        items[Math.max(idx - 1, 0)].focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (idx >= 0) items[idx].click();
      } else if (e.key === "Escape") {
        toolsMenu.classList.remove("active");
        btnTools.focus();
      }
    });

    document.addEventListener("click", function () {
      toolsMenu.classList.remove("active");
    });

    toolsMenu.addEventListener("click", async function (e) {
      const item = e.target.closest(".tools-item");
      if (!item) return;
      const action = item.dataset.action;
      toolsMenu.classList.remove("active");

      if (action === "open-current") {
        const current = (scanPath.value || "").trim();
        if (!current) {
          window.showToast("Enter or select a folder first", "info");
          return;
        }
        window.__TAURI__.invoke("get_dir_stats", { path: current }).then(function (res) {
          const st = res && res.data ? res.data : (res || {});
          const sizeStr = fmtBytes(st.total_bytes);
          const preview = "Open this folder?\n\n" + current + (sizeStr ? "\nSize: " + sizeStr : "");
          window.confirmDialog(preview).then(function (ok) {
            if (!ok) return;
            btnScan.click();
          });
        }).catch(function () {
          btnScan.click();
        });
      } else if (action === "scan-downloads" || action === "scan-trash") {
        const isTrash = action === "scan-trash";
        const resolveDir = isTrash
          ? window.__TAURI__.invoke("get_trash_path")
          : window.__TAURI__.invoke("get_home_dir");
        resolveDir
          .then(function (p) {
            const dir =
              typeof p === "string" ? p : (p?.data || "");
            if (!dir) return;
            window.__TAURI__
              .invoke("get_dir_stats", { path: dir })
              .then(function (res) {
                const st = res && res.data ? res.data : (res || {});
                const sizeStr = fmtBytes(st.total_bytes);
                const t0 = window.__ || function (s) { return s; };
                const label =
                  action === "scan-downloads" ? "Downloads" : "Trash";
                const preview =
                  t0("tools.scan_preview").replace("{folder}", label) +
                  (sizeStr ? "\n" + t0("tools.preview_size").replace("{size}", sizeStr) : "") +
                  (st.files != null ? "\n" + t0("tools.preview_files").replace("{n}", st.files) : "") +
                  (st.dirs != null ? "\n" + t0("tools.preview_dirs").replace("{n}", st.dirs) : "");
                window.confirmDialog(preview).then(function (ok) {
                  if (!ok) return;
                  scanPath.value = dir;
                  btnScan.click();
                });
              })
              .catch(function () {
                scanPath.value = dir;
                btnScan.click();
              });
          })
          .catch(function () {});
      } else if (action === "clear-scan" || action === "reset-view") {
        resetAllState(
          action === "clear-scan"
            ? (window.__ || function (s) { return s; })("status.clear_scan")
            : "View reset",
        );
      } else if (action === "settings") {
        const so = document.getElementById("settings-overlay");
        if (so) {
          const defPath = document.getElementById("settings-default-path");
          const selTheme = document.getElementById("settings-theme");
          const selLang = document.getElementById("settings-language");
          if (defPath) defPath.value = scanPath.value || "";
          if (selTheme) selTheme.value = "auto";
          if (selLang) selLang.value = "auto";
          window.__TAURI__
            .invoke("load_settings", {})
            .then(function (s) {
              if (s) {
                if (defPath && s.default_scan_path)
                  defPath.value = s.default_scan_path;
                if (selTheme && s.theme)
                  selTheme.value = s.theme;
                if (selLang && s.language)
                  selLang.value = s.language;
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
            const parts = [n.name];
            let p = n.parent;
            let safety = 0;
            while (p !== 4294967295 && p !== undefined && safety < 1000) {
              const parent = nodes[p];
              if (parent && parent.name) parts.unshift(parent.name);
              p = parent ? parent.parent : 4294967295;
              safety++;
            }
            emptyDirs.push({ name: n.name, path: parts.join("/"), arenaIdx: ni });
          }
        }
        if (emptyDirs.length === 0) {
          const t0 = window.__ || function (s) { return s; };
          window.showToast(t0("toast.no_empty_folders"), "info");
          return;
        }
        const base = scanPath.value.replace(/[\\/]+$/, "");
        let html2 =
          '<div style="padding:12px 16px;max-height:300px;overflow-y:auto;">' +
          '<label style="display:flex;align-items:center;gap:6px;padding:2px 6px;font-size:12px;color:var(--text-secondary);cursor:pointer;margin-bottom:4px;"><input type="checkbox" id="ef-select-all" checked style="width:14px;height:14px;cursor:pointer;"> Select all</label>';
        for (let ei = 0; ei < Math.min(emptyDirs.length, 500); ei++) {
          const full = base + "/" + emptyDirs[ei].path;
          html2 +=
            '<label class="empty-folder-item" data-idx="' + emptyDirs[ei].arenaIdx +
            '" title="' + esc(full) + '" style="display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;border-radius:4px;font-size:12px;">' +
            '<input type="checkbox" class="ef-cb" data-path="' + esc(full) + '" checked style="width:14px;height:14px;cursor:pointer;flex-shrink:0;">' +
            '\uD83D\uDCC2 <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(emptyDirs[ei].path) + "</span></label>";
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
          "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:480px;width:90%;max-height:80vh;overflow:hidden;";
        card2.innerHTML =
          '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">\uD83D\uDCC2 Empty Folders (' +
          emptyDirs.length +
          ")</div>" +
          html2 +
          '<div style="padding:8px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<button class="ef-delete-btn" style="padding:6px 14px;font-size:12px;border:none;border-radius:6px;background:linear-gradient(135deg,#da3633,var(--accent-red));color:#fff;cursor:pointer;">\uD83D\uDDD1 Delete selected</button>' +
          '<button class="ef-close-btn" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button>' +
          "</div>";
        ov2.appendChild(card2);
        document.body.appendChild(ov2);
        const efSelAll = ov2.querySelector("#ef-select-all");
        if (efSelAll) {
          efSelAll.onchange = function () {
            ov2.querySelectorAll(".ef-cb").forEach(function (cb) {
              cb.checked = efSelAll.checked;
            });
          };
        }
        ov2.querySelector(".ef-close-btn").onclick = function () {
          document.body.removeChild(ov2);
        };
        ov2.querySelector(".ef-delete-btn").onclick = async function () {
          const btn = this;
          const paths = [];
          ov2.querySelectorAll(".ef-cb:checked").forEach(function (cb) {
            paths.push(cb.dataset.path);
          });
          if (paths.length === 0) {
            window.showToast("Nothing selected", "info");
            return;
          }
          btn.disabled = true;
          btn.textContent = "Checking\u2026";
          const ok = await window.confirmDialog(
            window.__ ? window.__("tools.empty_folders_delete_confirm").replace("{n}", paths.length) : "Move " + paths.length + " empty folder(s) to Trash?",
          );
          if (!ok) { btn.disabled = false; btn.textContent = "\uD83D\uDDD1 Delete selected"; return; }
          let done = 0, failed = 0, skipped = 0;
          for (let ei = 0; ei < paths.length; ei++) {
            btn.textContent = "Deleting " + (ei + 1) + "/" + paths.length + "\u2026";
            try {
              const st = await window.__TAURI__.invoke("get_dir_stats", { path: paths[ei] });
              const d = st && st.data ? st.data : (st || {});
              if ((d.files === undefined && d.dirs === undefined) || (Number(d.files || 0) === 0 && Number(d.dirs || 0) === 0)) {
                const r = await window.__TAURI__.invoke("delete_path", { path: paths[ei] });
                if (r && r.success === false) failed++;
                else done++;
              } else {
                skipped++;
              }
            } catch (e) { failed++; }
          }
          document.body.removeChild(ov2);
          window.showToast(
            done + " moved to trash" + (failed ? ", " + failed + " failed" : "") + (skipped ? ", " + skipped + " skipped (no longer empty)" : ""),
            failed ? "warning" : "success",
          );
          if (btnScan) btnScan.click();
        };
        ov2.onclick = function (e) {
          if (e.target === ov2) document.body.removeChild(ov2);
        };
        ov2.querySelectorAll(".empty-folder-item").forEach(function (
          el,
        ) {
          el.onclick = function (e) {
            if (e.target.tagName === "INPUT") return;
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
        } catch (e) {
          console.warn("Chart export failed (tainted canvas):", e);
          chartData = "";
        }
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
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DiskRaptor Report</title><style>body{font-family:sans-serif;margin:20px;color:#333}h1{color:var(--accent-green)}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#f5f5f5}</style></head><body>' +
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
        const params = await findFilesDialog();
        if (!params) return;
        const loader = window.__loader;
        const treeView = window.__treeView;
        if (!loader || !loader.allNodes) return;
        const nodes = loader.allNodes;
        const query = params.name || "*";
        function escapeRegex(s) {
          return s
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\\*/g, ".*")
            .replace(/\\\?/g, ".");
        }
        const pattern = escapeRegex(query).toLowerCase();
        let re;
        try {
          re = new RegExp("^" + pattern + "$", "i");
        } catch (e) {
          return;
        }
        const minSize = params.minBytes || 0;
        const maxSize = params.maxBytes || 0;
        const ext = params.ext ? params.ext.toLowerCase() : "";
        const results = [];
        const st0 = document.querySelector(".status-bar");
        const CHUNK = 50000;

        function showFindResults() {
          if (results.length === 0) {
            const t0 = window.__ || function (s) { return s; };
            window.showToast(t0("tools.find_no_results"), "info");
            return;
          }
          results.sort(function (a, b) {
            return b.size - a.size;
          });
          let html =
            '<div style="padding:16px;max-height:300px;overflow-y:auto;">';
          for (let ri = 0; ri < Math.min(results.length, 500); ri++) {
            const r = results[ri];
            html +=
              '<div class="find-file-item" data-idx="' +
              r.arenaIdx +
              '" title="' + esc(r.path) + '" style="padding:4px 8px;cursor:pointer;border-radius:4px;font-size:12px;display:flex;gap:8px;align-items:center;">';
            html +=
              '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
              esc(r.name) +
              "</span>";
            html +=
              '<span style="font-family:monospace;color:var(--text-muted);font-size:11px;white-space:nowrap;">' +
              (r.size ? fmtBytes(r.size) : "") +
              "</span>";
            html +=
              '<button class="ff-open" title="Open containing folder" aria-label="Open containing folder" style="border:none;background:none;color:var(--accent);cursor:pointer;font-size:13px;padding:2px 4px;">\uD83D\uDCC2</button>' +
              "</div>";
          }
          if (results.length > 500)
            html +=
              '<div style="padding:4px;text-align:center;color:var(--text-muted);font-size:11px;">+ ' +
              (results.length - 500) +
              " more</div>";
          html += "</div>";
          const ov = document.createElement("div");
          ov.style.cssText =
            "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
          const card = document.createElement("div");
          card.style.cssText =
            "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:560px;width:90%;max-height:80vh;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.4);";
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
            el.onclick = function (e) {
              if (e.target.classList.contains("ff-open")) return;
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
          const ffOpenBtns = ov.querySelectorAll(".ff-open");
          for (let fi = 0; fi < ffOpenBtns.length; fi++) {
            (function (btn, r) {
              btn.onclick = function (e) {
                e.stopPropagation();
                if (r && r.path) {
                  window.__TAURI__.invoke("open_explorer", { path: r.path }).catch(function () {});
                }
              };
            })(ffOpenBtns[fi], results[fi]);
          }
        }

        function processChunk(start) {
          const end = Math.min(start + CHUNK, nodes.length);
          for (let ni = start; ni < end; ni++) {
            const n = nodes[ni];
            if (!n || !n.name) continue;
            if (n.node_type === 0 || n.node_type === "Directory") continue;
            if (ext && !n.name.toLowerCase().endsWith("." + ext)) continue;
            if (minSize && (n.size || 0) < minSize) continue;
            if (maxSize && (n.size || 0) > maxSize) continue;
            if (re.test(n.name)) {
              const fullPath = scanPath.value.replace(/[\\/]+$/, "");
              const parts = [n.name];
              let p = n.parent;
              let safety = 0;
              while (
                p !== 4294967295 &&
                p !== undefined &&
                safety < 1000
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
          if (end < nodes.length) {
            if (st0) st0.textContent = "Searching... " + Math.round((end / nodes.length) * 100) + "%";
            if (typeof requestIdleCallback === "function") {
              requestIdleCallback(function () { processChunk(end); });
            } else {
              setTimeout(function () { processChunk(end); }, 0);
            }
          } else {
            if (st0) st0.textContent = "";
            showFindResults();
          }
        }
        processChunk(0);
      } else if (action === "cleanup-downloads") {
        openDownloadsCleanup(scanPath, btnScan);
      } else if (action === "smart-tools") {
        openSmartTools();
      } else if (action === "browser-tools") {
        openBrowserTools();
      } else if (action === "trash-recovery") {
        if (!window.__trashRecovery)
          window.__trashRecovery = new TrashRecovery();
        window.__trashRecovery.open();
      } else if (action === "trash") {
        const t = window.__ || function (s) { return s; };
        let trashInfo = "";
        try {
          const items = await window.__TAURI__.invoke("list_trash", {});
          const arr = Array.isArray(items) ? items : [];
          if (arr.length > 0) {
            const sz = arr.reduce(function (s2, it) { return s2 + (it.size || 0); }, 0);
            trashInfo = "\n\n" + arr.length + " item(s) \u00B7 " + fmtBytes(sz);
          }
        } catch (e) {}
        if (!(await window.confirmDialog(t("confirm.empty_trash") + trashInfo))) return;
        try {
          item.textContent = "\u23F3 Emptying...";
          await window.__TAURI__.invoke("empty_trash", {});
          document.querySelector(".status-bar").textContent = t(
            "status.trash_emptied",
          );
          // Refresh the view if we're currently showing the trash folder.
          const cur = ((scanPath && scanPath.value) || "").toLowerCase();
          if (cur.indexOf(".trash") >= 0 || cur.indexOf("recycle") >= 0) {
            if (btnScan && !btnScan.disabled) btnScan.click();
          }
        } catch (e) {
          console.warn("Empty trash:", e);
          const t0 = window.__ || function (s) { return s; };
          window.showToast(t0("toast.failed").replace("{err}", e), "error");
        }
        setTimeout(function () {
          item.textContent = "\uD83D\uDDD1\uFE0F Empty Trash";
        }, 3000);
      } else if (action === "exit") {
        try {
          await window.__TAURI__.invoke("exit_app");
        } catch (e) {
          console.warn("Exit failed:", e);
        }
      }
    });
  };

  // ── Downloads Cleanup overlay ────────────────────────────
  function openDownloadsCleanup(scanPath, btnScan) {
    const old = document.getElementById("downloads-cleanup-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "downloads-cleanup-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText =
      "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:640px;width:92%;max-height:82vh;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.5);display:flex;flex-direction:column;";
    card.innerHTML =
      '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
      '<span style="font-size:14px;font-weight:600;">\uD83E\uDDF9 Downloads Cleanup</span>' +
      '<button class="dlc-close" aria-label="Close" style="padding:3px 8px;font-size:14px;border:none;background:none;color:var(--text-muted);cursor:pointer;">\u2715</button>' +
      "</div>" +
      '<div class="dlc-toolbar" style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
      '<button class="dlc-refresh" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\u27F3 Refresh</button>' +
      '<button class="dlc-select-all" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">Select All</button>' +
      '<button class="dlc-select-none" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">Select None</button>' +
      '<button class="dlc-select-old" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">90+ days old</button>' +
      '<span class="dlc-status" style="flex:1;font-size:12px;color:var(--text-muted);text-align:right;"></span>' +
      "</div>" +
      '<div class="dlc-list" style="flex:1;overflow-y:auto;padding:8px;min-height:200px;"></div>' +
      '<div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
      '<span class="dlc-total" style="font-size:12px;color:var(--text-muted);"></span>' +
      '<button class="dlc-clean" style="padding:7px 16px;font-size:12px;border:none;border-radius:6px;background:linear-gradient(135deg,#da3633,var(--accent-red));color:#fff;cursor:pointer;font-weight:600;">\uD83D\uDDD1 Move Selected to Trash</button>' +
      "</div>";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const listEl = card.querySelector(".dlc-list");
    const statusEl = card.querySelector(".dlc-status");
    const totalEl = card.querySelector(".dlc-total");
    const cleanBtn = card.querySelector(".dlc-clean");
    let files = [];

    function close() { overlay.remove(); }
    card.querySelector(".dlc-close").onclick = close;
    overlay.onclick = function (e) { if (e.target === overlay) close(); };
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    });

    function selectedFiles() {
      return files.filter(function (f, i) {
        const cb = listEl.querySelector('.dlc-item[data-idx="' + i + '"] input');
        return cb && cb.checked;
      });
    }

    function render() {
      if (files.length === 0) {
        listEl.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;">No large, old, or temporary files found in Downloads.</div>';
        totalEl.textContent = "";
        cleanBtn.disabled = true;
        return;
      }
      let html = "";
      let totalSize = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        totalSize += f.size || 0;
        const tags = [];
        if (f.is_temp) tags.push('<span style="font-size:10px;color:var(--accent-orange);border:1px solid var(--accent-orange);border-radius:3px;padding:0 4px;margin-left:4px;">TEMP</span>');
        if (f.is_old) tags.push('<span style="font-size:10px;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:0 4px;margin-left:4px;">' + (f.age_days || 0) + 'd old</span>');
        if (f.is_large) tags.push('<span style="font-size:10px;color:var(--accent-red);border:1px solid var(--accent-red);border-radius:3px;padding:0 4px;margin-left:4px;">LARGE</span>');
        html +=
          '<div class="dlc-item" data-idx="' + i + '" title="' + esc(f.path) + '" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;">' +
          '<input type="checkbox" style="width:14px;height:14px;cursor:pointer;flex-shrink:0;" />' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' + esc(f.name) + tags.join("") + "</span>" +
          '<span style="font-family:monospace;font-size:11px;color:var(--text-muted);white-space:nowrap;">' + (f.size_human || fmtBytes(f.size)) + "</span>" +
          '<button class="dlc-open" title="Open containing folder" aria-label="Open containing folder" style="border:none;background:none;color:var(--accent);cursor:pointer;font-size:13px;padding:2px 4px;">\uD83D\uDCC2</button>' +
          "</div>";
      }
      listEl.innerHTML = html;
      listEl.querySelectorAll(".dlc-item").forEach(function (row) {
        row.onclick = function (e) {
          if (e.target.tagName === "INPUT" || e.target.classList.contains("dlc-open")) return;
          const cb = this.querySelector('input');
          if (cb) { cb.checked = !cb.checked; }
        };
        row.onmouseenter = function () { this.style.background = "var(--bg-hover)"; };
        row.onmouseleave = function () { this.style.background = "transparent"; };
      });
      listEl.querySelectorAll(".dlc-open").forEach(function (btn) {
        btn.onclick = function (e) {
          e.stopPropagation();
          const i = parseInt(btn.closest(".dlc-item").dataset.idx);
          const f = files[i];
          if (f && f.path) {
            window.__TAURI__.invoke("open_explorer", { path: f.path }).catch(function () {});
          }
        };
      });
      totalEl.textContent = files.length + " candidate(s) \u00B7 " + fmtBytes(totalSize) + " total";
      cleanBtn.disabled = false;
    }

    function load() {
      statusEl.textContent = "\u23F3 Scanning Downloads\u2026";
      window.__TAURI__
        .invoke("list_downloads_candidates")
        .then(function (res) {
          // The bridge unwraps `data`, so `res` may be the file list object
          // ({files:[...]}) or the raw array; handle all shapes.
          const filesArr = Array.isArray(res)
            ? res
            : res && res.files
              ? res.files
              : res && res.data && res.data.files
                ? res.data.files
                : [];
          files = filesArr;
          render();
          statusEl.textContent = files.length + " candidate(s) found";
        })
        .catch(function (e) {
          files = [];
          listEl.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-muted);font-size:13px;">Error: ' + esc(e && e.message ? e.message : e) + "</div>";
          statusEl.textContent = "Error";
        });
    }

    card.querySelector(".dlc-refresh").onclick = load;
    card.querySelector(".dlc-select-all").onclick = function () {
      listEl.querySelectorAll(".dlc-item input").forEach(function (c) { c.checked = true; });
    };
    card.querySelector(".dlc-select-none").onclick = function () {
      listEl.querySelectorAll(".dlc-item input").forEach(function (c) { c.checked = false; });
    };
    card.querySelector(".dlc-select-old").onclick = function () {
      listEl.querySelectorAll(".dlc-item").forEach(function (row) {
        const i = parseInt(row.dataset.idx);
        const cb = row.querySelector("input");
        if (cb && files[i] && files[i].is_old) cb.checked = true;
      });
    };

    cleanBtn.onclick = async function () {
      const sel = selectedFiles();
      if (sel.length === 0) { const t0 = window.__ || function (s) { return s; }; window.showToast(t0("toast.nothing_selected"), "warning"); return; }
      const totalSel = sel.reduce(function (s, f) { return s + (f.size || 0); }, 0);
      const ok = await window.confirmDialog(
        window.__ ? window.__("tools.cleanup_confirm").replace("{n}", sel.length).replace("{size}", fmtBytes(totalSel)) : "Move " + sel.length + " file(s) to Trash?",
      );
      if (!ok) return;
      cleanBtn.disabled = true;
      cleanBtn.textContent = "\u23F3 Moving\u2026";
      let done = 0, failed = 0;
      for (let si = 0; si < sel.length; si++) {
        cleanBtn.textContent = "\u23F3 Moving " + (si + 1) + "/" + sel.length + "...";
        try {
          const r = await window.__TAURI__.invoke("delete_path", { path: sel[si].path });
          if (r && r.success === false) failed++;
          else done++;
        } catch (e) { failed++; }
      }
      window.showToast(
        done + " file(s) moved to trash, freed " + fmtBytes(totalSel) + (failed ? " (" + failed + " failed)" : ""),
        failed ? "warning" : "success",
      );
      cleanBtn.textContent = "\uD83D\uDDD1 Move Selected to Trash";
      cleanBtn.disabled = false;
      load();
    };

    load();
  }

  // ── Find Files dialog ────────────────────────────────────
  function findFilesDialog() {
    return new Promise(function (resolve) {
      const ov = document.createElement("div");
      ov.style.cssText =
        "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
      const card = document.createElement("div");
      card.style.cssText =
        "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:420px;width:90%;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.4);";
      card.innerHTML =
        '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">\uD83D\uDD0E Find Files</div>' +
        '<div style="padding:16px;display:flex;flex-direction:column;gap:10px;">' +
        '<label style="font-size:12px;color:var(--text-secondary);">Name pattern (e.g. *.jpg, *test*, partial name)</label>' +
        '<input id="ff-name" type="text" value="*" style="padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />' +
        '<label style="font-size:12px;color:var(--text-secondary);">File extension (optional, e.g. jpg)</label>' +
        '<input id="ff-ext" type="text" value="" style="padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />' +
        '<label style="font-size:12px;color:var(--text-secondary);">Min size (MB, optional)</label>' +
        '<input id="ff-min" type="number" min="0" value="" style="padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />' +
        '<label style="font-size:12px;color:var(--text-secondary);">Max size (MB, optional)</label>' +
        '<input id="ff-max" type="number" min="0" value="" style="padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />' +
        "</div>" +
        '<div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;">' +
        '<button id="ff-cancel" style="padding:6px 14px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">Cancel</button>' +
        '<button id="ff-ok" style="padding:6px 16px;font-size:12px;border:none;border-radius:6px;background:linear-gradient(135deg,#238636,var(--accent-green));color:#fff;cursor:pointer;font-weight:600;">Search</button>' +
        "</div>";
      ov.appendChild(card);
      document.body.appendChild(ov);
      function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
      function submit() {
        const name = card.querySelector("#ff-name").value || "*";
        const ext = (card.querySelector("#ff-ext").value || "").replace(/^\./, "").trim();
        const minMB = parseFloat(card.querySelector("#ff-min").value);
        const maxMB = parseFloat(card.querySelector("#ff-max").value);
        close();
        resolve({
          name: name,
          ext: ext,
          minBytes: minMB > 0 ? minMB * 1024 * 1024 : 0,
          maxBytes: maxMB > 0 ? maxMB * 1024 * 1024 : 0,
        });
      }
      card.querySelector("#ff-cancel").onclick = function () { close(); resolve(null); };
      card.querySelector("#ff-ok").onclick = submit;
      ov.onclick = function (e) { if (e.target === ov) { close(); resolve(null); } };
      card.querySelector("#ff-name").addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
      card.querySelector("#ff-name").focus();
    });
  }

  // ── S.M.A.R.T. Tools overlay ─────────────────────────────
  function fmtBytes(b) {
    if (!b || b <= 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 4);
    return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + " " + u[i];
  }
  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
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
      '<button class="smart-refresh-btn" id="smart-refresh" title="Refresh drive list">\u27F3</button>' +
      '<button class="smart-close" id="smart-close" title="Close" aria-label="Close">\u2715</button>' +
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
    const refreshBtn = overlay.querySelector("#smart-refresh");
    const select = overlay.querySelector("#smart-drive");
    const scanBtn = overlay.querySelector("#smart-scan");
    const statusEl = overlay.querySelector("#smart-status");
    const resultEl = overlay.querySelector("#smart-result");

    function close() { overlay.remove(); }
    closeBtn.addEventListener("click", close);
    refreshBtn.addEventListener("click", loadDrives);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    }
    document.addEventListener("keydown", onKey);

    function loadDrives() {
      statusEl.className = "smart-status";
      statusEl.innerHTML = '<span class="smart-spinner"></span>Loading drives\u2026';
      select.disabled = true;
      scanBtn.disabled = true;
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
          const parts = [];
          if (d.serial) parts.push(d.serial);
          if (d.model) parts.push(d.model);
          opt.textContent =
            (d.name || "Disk " + d.id) + (sizeStr ? " \u2014 " + sizeStr : "") +
            (parts.length ? " \u00B7 " + parts.join(" \u00B7 ") : "");
          select.appendChild(opt);
        });
        select.value = String(disks[0].id);
        select.disabled = false;
        scanBtn.disabled = false;
        statusEl.textContent = "Select a drive and press Scan Health.";
      })
      .catch(function (e) {
        select.innerHTML = '<option value="">Error</option>';
        const msg = e && e.message ? e.message : String(e);
        statusEl.textContent = "Could not list drives: " + msg;
        if (/sandbox|sandboxed/i.test(msg)) {
          statusEl.innerHTML =
            "S.M.A.R.T. is limited in the App Store build.<br>" +
            '<span style="font-size:12px;color:var(--text-secondary);">Download DiskRaptor from the website for the full S.M.A.R.T. report (smartmontools).</span>';
        } else if (/smartctl|smartmontools/i.test(msg)) {
          statusEl.innerHTML =
            "Could not list drives.<br>" +
            '<span style="font-size:12px;color:var(--text-secondary);">Install smartmontools to enable full S.M.A.R.T. reports:</span>' +
            '<div style="margin-top:8px;font-family:monospace;font-size:12px;background:rgba(0,0,0,0.4);padding:8px 10px;border-radius:6px;border:1px solid var(--border);">brew install smartmontools</div>' +
            '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">Then relaunch DiskRaptor and scan again.</div>';
        }
      });
    }
    loadDrives();

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
          const msg = e && e.message ? e.message : String(e);
          if (/smartctl|smartmontools/i.test(msg)) {
            statusEl.innerHTML =
              "S.M.A.R.T. requires smartmontools, which is not installed.<br>" +
              '<span style="font-size:12px;color:var(--text-secondary);">Install it via Homebrew, then relaunch:</span>' +
              '<div style="margin-top:8px;font-family:monospace;font-size:12px;background:rgba(0,0,0,0.4);padding:8px 10px;border-radius:6px;border:1px solid var(--border);">brew install smartmontools</div>';
          } else {
            statusEl.textContent = "Error: " + msg;
          }
        })
        .finally(function () {
          scanBtn.disabled = false;
          scanBtn.textContent = "Scan Health";
        });
    });

    function renderSmartResult(r) {
      if (!r) {
        statusEl.className = "smart-status err";
        statusEl.textContent = "No data returned.";
        return;
      }
      const attrs = Array.isArray(r.attributes) ? r.attributes : [];
      const unsupported = r.smart_supported === false || r.status === "Not Supported";
      const statusTxt = unsupported
        ? "S.M.A.R.T. Not Supported"
        : r.status || (Number(r.score) >= 85 ? "Healthy" : Number(r.score) >= 55 ? "Warning" : "Critical");
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

      function shorten(s, max) {
        s = String(s || "");
        return s.length > max ? s.substring(0, max) + "\u2026" : s;
      }
      function cell(label, value, title) {
        return (
          '<div class="smart-info-cell"><div class="c-label">' +
          esc(label) +
          '</div><div class="c-value" title="' +
          esc(title || value) +
          '">' +
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
        '<div style="text-align:right;padding:4px 0 8px;display:flex;justify-content:flex-end;gap:6px;">' +
        '<button class="smart-export-btn" id="smart-export" style="padding:4px 10px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\uD83D\uDCC4 Export .txt</button>' +
        '<button class="smart-export-btn" id="smart-export-json" style="padding:4px 10px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\u2699\uFE0F Export .json</button>' +
        "</div>" +
        '<div class="smart-info-grid">' +
        cell("Model", r.model || "\u2014") +
        cell("Firmware", r.firmware || "\u2014") +
        cell("Serial", shorten(r.serial, 22), r.serial) +
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

      const exportBtn = resultEl.querySelector("#smart-export");
      if (exportBtn) {
        exportBtn.onclick = function () {
          const lines = [];
          lines.push("DiskRaptor S.M.A.R.T. Report");
          lines.push("Generated: " + new Date().toISOString());
          lines.push("Model: " + (r.model || ""));
          lines.push("Firmware: " + (r.firmware || ""));
          lines.push("Serial: " + (r.serial || ""));
          lines.push("Interface: " + (r.interface || ""));
          lines.push("Capacity: " + capacityStr);
          lines.push("Media: " + mediaLabel(r.media_type));
          lines.push("Status: " + statusTxt);
          lines.push("Health Score: " + (r.score != null ? r.score : ""));
          lines.push("Temperature: " + tempStr);
          lines.push("Wear: " + (wear != null ? wear + "%" : ""));
          lines.push("Power-On Hours: " + fmtHours(powh));
          lines.push("Power Cycles: " + (cycles != null ? cycles : ""));
          lines.push("Uncorrected Errors: " + uncorrected);
          lines.push("");
          if (attrs.length === 0) {
            lines.push("No S.M.A.R.T. attributes available for this drive.");
          } else {
            lines.push("ID\tAttribute\tCurrent\tWorst\tThreshold\tRAW\tStatus");
            for (let ai = 0; ai < attrs.length; ai++) {
              const a = attrs[ai];
              lines.push(
                [a.id != null ? a.id : "", a.name || "", a.current != null ? a.current : "", a.worst != null ? a.worst : "", a.threshold != null ? a.threshold : "", a.raw || "", a.status || ""].join("\t")
              );
            }
          }
          const blob = new Blob([lines.join("\n")], { type: "text/plain" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "smart-report-" + (r.model || "disk").replace(/\W+/g, "_") + ".txt";
          a.click();
          URL.revokeObjectURL(url);
        };
      }
      const jsonBtn = resultEl.querySelector("#smart-export-json");
      if (jsonBtn) {
        jsonBtn.onclick = function () {
          const payload = {
            generated: new Date().toISOString(),
            device_id: r.device_id || "",
            model: r.model || "",
            firmware: r.firmware || "",
            serial: r.serial || "",
            interface: r.interface || "",
            capacity: r.capacity || 0,
            media: mediaLabel(r.media_type),
            status: statusTxt,
            score: r.score != null ? r.score : null,
            temperature_c: r.temperature_c != null ? r.temperature_c : null,
            wear: wear != null ? wear : null,
            power_on_hours: powh,
            power_cycles: cycles != null ? cycles : null,
            uncorrected: uncorrected,
            attributes: attrs,
          };
          const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "smart-report-" + (r.model || "disk").replace(/\W+/g, "_") + ".json";
          a.click();
          URL.revokeObjectURL(url);
        };
      }

      statusEl.className = "smart-status";
      if (unsupported) {
        statusEl.innerHTML =
          "This drive does not expose S.M.A.R.T. data (common for virtualized/SCSI disks). " +
          "Basic identification shown below.";
      } else {
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
  }

  // ── Clean Browser Tools overlay ─────────────────────────────
  function fmtSize(b) {
    if (!b || b <= 0) return "0 B";
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(2) + " GB";
    const mb = b / (1024 * 1024);
    if (mb >= 1) return mb.toFixed(1) + " MB";
    return Math.round(b / 1024) + " KB";
  }

  function openBrowserTools() {
    const old = document.getElementById("browser-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "browser-overlay";
    overlay.className = "smart-overlay";
    overlay.innerHTML =
      '<div class="smart-card browser-card">' +
      '<div class="smart-header">' +
      '<span class="smart-title">\uD83E\uDDF9 Clean Browser Tools</span>' +
      '<button class="smart-close" id="browser-close" title="Close" aria-label="Close">\u2715</button>' +
      "</div>" +
      '<div class="smart-body">' +
      '<div class="browser-toolbar">' +
      '<button class="browser-btn ghost" id="browser-refresh">\u27F3 Refresh</button>' +
      '<button class="browser-btn ghost" id="browser-select-all">Select All</button>' +
      '<button class="browser-btn ghost" id="browser-select-none">Select None</button>' +
      '<button class="browser-btn ghost" id="browser-select-cookies">Select All Cookies</button>' +
      '<button class="browser-btn ghost" id="browser-select-caches">Select All Caches</button>' +
      '<button class="browser-btn danger" id="browser-clean">\uD83D\uDDD1\uFE0F Clean Selected</button>' +
      "</div>" +
      '<div class="smart-status" id="browser-status"></div>' +
      '<div class="browser-list" id="browser-list"></div>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector("#browser-close");
    const refreshBtn = overlay.querySelector("#browser-refresh");
    const selectAllBtn = overlay.querySelector("#browser-select-all");
    const selectNoneBtn = overlay.querySelector("#browser-select-none");
    const cleanBtn = overlay.querySelector("#browser-clean");
    const statusEl = overlay.querySelector("#browser-status");
    const listEl = overlay.querySelector("#browser-list");

    function close() { overlay.remove(); }
    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    function onKey(e) {
      if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
    }
    document.addEventListener("keydown", onKey);

    let browsers = [];
    const browserIconCache = {};

    const BROWSER_EMOJI = {
      "Google Chrome": "\uD83C\uDF10",
      "Microsoft Edge": "\uD83C\uDF00",
      Safari: "\uD83E\uDD85",
      Firefox: "\uD83E\uDD8A",
      Opera: "\u2B55",
      "Opera GX": "\uD83C\uDFAE",
      Brave: "\uD83E\uDD81",
      Chromium: "\u2699\uFE0F",
      Vivaldi: "\uD83C\uDFBB",
      "Yandex Browser": "\uD83E\uDDF2",
      "Tor Browser": "\uD83E\uDDC5",
      "Internet Explorer": "\uD83C\uDD38\uFE0F",
      Waterfox: "\uD83E\uDD8A",
      "Pale Moon": "\uD83C\uDF19",
      Maxthon: "\uD83E\uDDED",
      Arc: "\uD83D\uDD36",
      "Avast Secure Browser": "\uD83D\uDEE1\uFE0F",
      "AVG Secure Browser": "\uD83D\uDEE1\uFE0F",
      CocCoc: "\uD83C\uDF0F",
      "Epic Privacy Browser": "\uD83D\uDD12",
      Slimjet: "\uD83D\uDE80",
    };

    function loadBrowserIcons() {
      listEl.querySelectorAll(".browser-icon").forEach(function (img) {
        const exe = img.dataset.exe;
        if (!exe) return;
        const wrap = img.parentElement;
        const emoji = wrap ? wrap.querySelector(".browser-emoji") : null;
        function apply(src) {
          if (!src) return;
          if (emoji) emoji.style.display = "none";
          img.src = src;
          img.style.display = "block";
        }
        if (browserIconCache[exe]) {
          apply(browserIconCache[exe]);
          return;
        }
        window.__TAURI__
          .invoke("get_browser_icon", { exe: exe })
          .then(function (res) {
            const src =
              typeof res === "string" && res.indexOf("data:") === 0
                ? res
                : null;
            if (src) {
              browserIconCache[exe] = src;
              apply(src);
            }
          })
          .catch(function () {});
      });
    }

    function renderList() {
      if (browsers.length === 0) {
        listEl.innerHTML =
          '<div style="padding:22px;text-align:center;color:var(--text-muted);font-size:13px;">No installed browsers with cookies/cache found.</div>';
        return;
      }
      let html =
        '<div class="browser-row browser-row-head">' +
        '<span class="browser-name">\u2714 Browser</span>' +
        '<span class="browser-size">\uD83C\uDF6A Cookies</span>' +
        '<span class="browser-size">\uD83D\uDCBE Cache</span>' +
        '<span class="browser-total">Total</span>' +
        "</div>";
      for (let i = 0; i < browsers.length; i++) {
        const b = browsers[i];
        const emoji = BROWSER_EMOJI[b.name] || "\uD83C\uDF10";
        const cookiePaths = Array.isArray(b.cookie_paths) ? b.cookie_paths : [];
        const cachePaths = Array.isArray(b.cache_paths) ? b.cache_paths : [];
        const pathTitle = (cookiePaths.concat(cachePaths)).map(function (p) { return p; }).join("\n") || "";
        html +=
          '<div class="browser-row" data-name="' + esc(b.name) + '" title="' + esc(pathTitle) + '">' +
          '<span class="browser-name">' +
          '<input type="checkbox" class="browser-row-check" title="Select all for ' + esc(b.name) + '" />' +
          '<span class="browser-icon-wrap">' +
          '<span class="browser-emoji">' + emoji + "</span>" +
          '<img class="browser-icon" data-exe="' + esc(b.exe || "") + '" alt="" style="display:none;" />' +
          "</span>" +
          '<span class="browser-name-text">' + esc(b.name) + "</span>" +
          "</span>" +
          '<label class="browser-part" title="Clean cookies for ' + esc(b.name) + '">' +
          '<input type="checkbox" class="browser-check" data-name="' + esc(b.name) + '" data-part="cookies" />' +
          '<span class="browser-size cookie">' + fmtSize(b.cookie_size) + (cookiePaths.length > 0 ? '<span class="browser-fcount"> \u00B7 ' + cookiePaths.length + "</span>" : "") + "</span>" +
          "</label>" +
          '<label class="browser-part" title="Clean cache for ' + esc(b.name) + '">' +
          '<input type="checkbox" class="browser-check" data-name="' + esc(b.name) + '" data-part="cache" />' +
          '<span class="browser-size cache">' + fmtSize(b.cache_size) + (cachePaths.length > 0 ? '<span class="browser-fcount"> \u00B7 ' + cachePaths.length + "</span>" : "") + "</span>" +
          "</label>" +
          '<span class="browser-total">' + fmtSize(b.total_size || (b.cookie_size + b.cache_size)) + "</span>" +
          "</div>";
      }
      listEl.innerHTML = html;
      // Per-browser row select: checks both parts.
      listEl.querySelectorAll(".browser-row-check").forEach(function (rc) {
        rc.onchange = function () {
          const row = rc.closest(".browser-row");
          row.querySelectorAll(".browser-check").forEach(function (c) { c.checked = rc.checked; });
        };
      });
      loadBrowserIcons();
      cleanBtn.disabled = false;
    }

    function load() {
      statusEl.className = "smart-status";
      statusEl.innerHTML = '<span class="smart-spinner"></span>Scanning browsers\u2026';
      cleanBtn.disabled = true;
      window.__TAURI__
        .invoke("list_browser_data")
        .then(function (res) {
          browsers = Array.isArray(res) ? res : (res && res.data ? res.data : []);
          renderList();
          statusEl.className = "smart-status";
          statusEl.textContent =
            browsers.length + " browser(s) detected. Select browsers to clean their cookies and cache.";
        })
        .catch(function (e) {
          statusEl.className = "smart-status err";
          statusEl.textContent = "Error: " + (e && e.message ? e.message : e);
        });
    }

    refreshBtn.addEventListener("click", load);
    selectAllBtn.addEventListener("click", function () {
      listEl.querySelectorAll(".browser-check").forEach(function (c) { c.checked = true; });
    });
    selectNoneBtn.addEventListener("click", function () {
      listEl.querySelectorAll(".browser-check").forEach(function (c) { c.checked = false; });
    });
    document
      .getElementById("browser-select-cookies")
      .addEventListener("click", function () {
        listEl
          .querySelectorAll('.browser-check[data-part="cookies"]')
          .forEach(function (c) { c.checked = true; });
      });
    document
      .getElementById("browser-select-caches")
      .addEventListener("click", function () {
        listEl
          .querySelectorAll('.browser-check[data-part="cache"]')
          .forEach(function (c) { c.checked = true; });
      });

    cleanBtn.addEventListener("click", async function () {
      const byName = {};
      listEl.querySelectorAll(".browser-check:checked").forEach(function (c) {
        const n = c.dataset.name;
        const part = c.dataset.part;
        if (!byName[n]) byName[n] = { cookies: false, cache: false };
        byName[n][part] = true;
      });
      const names = Object.keys(byName);
      if (names.length === 0) {
        statusEl.className = "smart-status";
        statusEl.textContent = "Nothing selected. Tick the cookies/cache boxes you want to clean.";
        return;
      }
      const selCount = names.reduce(function (s, n) {
        return s + (byName[n].cookies ? 1 : 0) + (byName[n].cache ? 1 : 0);
      }, 0);
      const ok = await window.confirmDialog(
        "Clean " + selCount + " selection(s) in " + names.length + " browser(s)?\n\nCleaning cookies will sign you out of websites in those browsers.",
      );
      if (!ok) return;
      cleanBtn.disabled = true;
      let freed = 0;
      let failed = 0;
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        statusEl.innerHTML =
          '<span class="smart-spinner"></span>Cleaning ' + (i + 1) + "/" + names.length + ": " + esc(n) + "\u2026";
        try {
          const r = await window.__TAURI__.invoke("clean_browser", {
            name: n,
            cookies: byName[n].cookies,
            cache: byName[n].cache,
          });
          freed += (r && r.freed) || 0;
        } catch (e) {
          failed++;
          console.warn("Clean failed:", n, e);
        }
      }
      statusEl.className = "smart-status";
      if (failed > 0) {
        statusEl.textContent =
          "Cleaned " + (names.length - failed) + " browser(s), " + failed + " failed. Freed " + fmtSize(freed) + ".";
      } else {
        statusEl.textContent =
          "Cleaned " + names.length + " browser(s). Freed " + fmtSize(freed) + ".";
      }
      load();
    });

    load();
  }
})();
