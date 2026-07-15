/**
 * DiskRaptor - Main application controller.
 */
(function () {
  "use strict";

  async function init() {
    console.log("DiskRaptor booting...");

    const bridgeReady = new Promise((resolve) => {
      if (window.__TAURI__ && typeof window.__TAURI__.invoke === "function") {
        resolve(true);
        return;
      }
      window.addEventListener("tauri-bridge-ready", () => resolve(true), {
        once: true,
      });
    });

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Tauri bridge timeout")), 15000),
    );

    try {
      await Promise.race([bridgeReady, timeout]);
    } catch (err) {
      console.error("Tauri backend not connected:", err);
      const sb = document.querySelector(".status-bar");
      if (sb)
        sb.textContent = "Backend not connected. Run via npm run tauri dev.";
      return;
    }

    if (!window.__TAURI__ || typeof window.__TAURI__.invoke !== "function") {
      console.error("Tauri invoke still unavailable");
      return;
    }

    console.log("DiskRaptor initializing...");

    // ── Theme toggle ───────────────────────────────────────
    var btnTheme = document.getElementById("btn-theme");
    var savedTheme = localStorage.getItem("diskraptor-theme");
    if (savedTheme === "light") {
      document.body.classList.add("light-theme");
      btnTheme.textContent = "☀";
      btnTheme.title = "Switch to dark mode";
    }
    btnTheme.addEventListener("click", function () {
      var isLight = document.body.classList.toggle("light-theme");
      localStorage.setItem("diskraptor-theme", isLight ? "light" : "dark");
      btnTheme.textContent = isLight ? "☀" : "☾";
      btnTheme.title = isLight ? "Switch to dark mode" : "Switch to light mode";
    });

    const loader = new ChunkLoader();
    const treeView = new TreeView("tree-viewport", loader);
    const topFiles = new TopFilesPanel();
    const statsPanel = new StatsPanel();
    const diagram = new DiagramRenderer("diagram-container");

    let isScanning = false;
    let currentStats = null;

    loader.onProgress = (loaded, total) => {
      const el = document.querySelector("#tree-panel .status-bar");
      if (el) el.textContent = "Loading chunks... " + loaded + "/" + total;
    };

    treeView.onSelect = function () {};

    // DOM refs
    var scanPath = document.getElementById("scan-path");
    var btnBrowse = document.getElementById("btn-browse");
    var btnScan = document.getElementById("btn-scan");
    var btnCancel = document.getElementById("btn-cancel");
    var btnExport = document.getElementById("btn-export");
    var progressOverlay = document.getElementById("progress-overlay");
    var progressPath = document.getElementById("progress-path");
    var aboutOverlay = document.getElementById("about-overlay");
    var aboutClose = document.getElementById("btn-about-close");

    // Diagram mode switcher (in detail panel)
    var diagramModes = document.querySelectorAll(".diagram-mode");
    diagramModes.forEach(function (btn) {
      btn.addEventListener("click", function () {
        diagramModes.forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        diagram.setMode(btn.dataset.mode);
      });
    });

    // About dialog
    aboutClose.addEventListener("click", function () {
      aboutOverlay.classList.remove("active");
    });
    aboutOverlay.addEventListener("click", function (e) {
      if (e.target === aboutOverlay) aboutOverlay.classList.remove("active");
    });

    // ── Language Switcher ──────────────────────────────────
    (function initLangSwitcher() {
      var btnLang = document.getElementById("btn-lang");
      var langMenu = document.getElementById("lang-menu");
      var langList = document.getElementById("lang-list");
      var langFilter = document.getElementById("lang-filter");

      function renderLangs(filter) {
        filter = (filter || "").toLowerCase();
        var current = window.I18N.getLocale().raw;
        var html = "";
        // Auto (System) entry
        var autoActive = current === "auto" ? ' class="lang-item active"' : "";
        html +=
          '<button data-lang="auto"' +
          autoActive +
          ' class="lang-item"><span class="lang-flag">🖥️</span> <span>' +
          window.__("lang.auto") +
          '</span> <span class="lang-code">auto</span></button>';
        html += '<hr style="border:none;border-top:1px solid var(--border-light);margin:4px 0">';

        window.I18N.LANGUAGES.forEach(function (lang) {
          if (filter && !lang.label.toLowerCase().includes(filter) && !lang.code.includes(filter)) return;
          var active = current === lang.code ? ' class="lang-item active"' : "";
          html +=
            '<button data-lang="' +
            lang.code +
            '"' +
            active +
            ' class="lang-item"><span class="lang-flag">' +
            lang.flag +
            '</span> <span>' +
            lang.label +
            '</span> <span class="lang-code">' +
            lang.code +
            "</span></button>";
        });
        langList.innerHTML = html;

        // Click handlers
        langList.querySelectorAll(".lang-item").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var code = this.getAttribute("data-lang");
            window.I18N.setLocale(code);
            langMenu.classList.remove("active");
            // Emit event to Rust backend for menu label update
            if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.emit) {
              try {
                window.__TAURI__.event.emit("lang-changed", { locale: code });
              } catch (e) { /* ignore */ }
            }
          });
        });
      }

      btnLang.addEventListener("click", function (e) {
        e.stopPropagation();
        langMenu.classList.toggle("active");
        if (langMenu.classList.contains("active")) {
          langFilter.value = "";
          renderLangs("");
          langFilter.focus();
        }
      });

      // Filter on input
      langFilter.addEventListener("input", function () {
        renderLangs(this.value);
      });

      // Close on outside click
      document.addEventListener("click", function (e) {
        if (!e.target.closest(".lang-dropdown-wrap")) {
          langMenu.classList.remove("active");
        }
      });

      // Close on Escape
      langFilter.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          langMenu.classList.remove("active");
          btnLang.focus();
        }
      });

      // Re-render on locale change (for the "auto" label update)
      window.addEventListener("locale-changed", function () {
        if (langMenu.classList.contains("active")) {
          renderLangs(langFilter.value);
        }
      });
    })();

    // Menu events from Tauri
    if (window.__TAURI__ && window.__TAURI__.event) {
      try {
        ["pie", "treemap"].forEach(function (mode) {
          window.__TAURI__.event.listen("menu-view-" + mode, function () {
            document.querySelectorAll(".diagram-mode").forEach(function (b) {
              b.classList.remove("active");
            });
            var btn = document.querySelector(
              '.diagram-mode[data-mode="' + mode + '"]',
            );
            if (btn) btn.classList.add("active");
            diagram.setMode(mode);
          });
        });
        window.__TAURI__.event.listen("menu-about", function () {
          aboutOverlay.classList.add("active");
        });
        // Language menu events from native menu
        window.I18N.LANGUAGES.forEach(function (lang) {
          var eventName = "menu-lang-" + lang.code;
          window.__TAURI__.event.listen(eventName, function () {
            window.I18N.setLocale(lang.code);
          });
        });
        window.__TAURI__.event.listen("menu-lang-auto", function () {
          window.I18N.setLocale("auto");
        });
      } catch (e) {
        console.log("Menu events not available:", e.message);
      }
    }

    // Update progress label on locale change
    window.addEventListener("locale-changed", function () {
      var label = document.getElementById("progress-label");
      if (label && !label.textContent.includes("build") && !label.textContent.includes("chunk")) {
        label.textContent = window.__("progress.files_found");
      }
      var elapsed = document.getElementById("progress-elapsed");
      if (elapsed && elapsed.textContent) {
        // Don't override running elapsed counter, just prefix
        var txt = elapsed.textContent.replace(/^.+?: /, "");
        elapsed.textContent = window.__("progress.elapsed") + txt;
      }
    });

    // Browse
    btnBrowse.addEventListener("click", async function () {
      try {
        var selected = await window.__TAURI__.invoke("pick_directory");
        if (selected && typeof selected === "string") {
          scanPath.value = selected;
          document.querySelector(".status-bar").textContent =
            "Selected: " + selected;
        }
      } catch (err) {
        document.querySelector(".status-bar").textContent =
          "Browse click - manual entry";
        document.getElementById("scan-path").focus();
        document.getElementById("scan-path").select();
      }
    });

    // Scan
    btnScan.addEventListener("click", async function () {
      if (isScanning) return;

      var path = scanPath.value.trim();
      if (!path) {
        alert("Please enter or select a directory path.");
        return;
      }

      // Admin check removed — launcher handles elevation once at startup

      isScanning = true;
      btnScan.disabled = true;
      btnBrowse.disabled = true;
      btnCancel.disabled = false;
      btnExport.disabled = true;

      var safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
      }, 600000);

      // Progress elements
      var progressCard = progressOverlay.querySelector(".progress-card");
      ["progress-files", "progress-label", "progress-elapsed"].forEach(
        function (id) {
          var el = document.getElementById(id);
          if (el) el.remove();
        },
      );

      var progressFilesEl = document.createElement("div");
      progressFilesEl.id = "progress-files";
      progressFilesEl.style.cssText =
        "font-size:24px;font-weight:700;color:var(--accent);margin:8px 0";
      progressFilesEl.textContent = "0";
      var progressLabelEl = document.createElement("div");
      progressLabelEl.id = "progress-label";
      progressLabelEl.style.cssText = "font-size:12px;color:var(--text-muted)";
      progressLabelEl.textContent = "files found, scanning...";
      var elapsedEl = document.createElement("div");
      elapsedEl.id = "progress-elapsed";
      elapsedEl.style.cssText =
        "font-size:11px;color:var(--text-muted);margin-top:4px";
      progressCard.appendChild(progressFilesEl);
      progressCard.appendChild(progressLabelEl);
      progressCard.appendChild(elapsedEl);

      progressOverlay.classList.add("active");
      progressPath.textContent = "Scanning: " + path;

      try {
        var initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
        });
        var scanId = initScan.scan_id;

        // Poll
        var done = false;
        for (var i = 0; i < 600; i++) {
          await sleep(500);
          var p = await window.__TAURI__
            .invoke("get_scan_progress", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (!p) continue;

          progressFilesEl.textContent = Number(
            p.files_found || 0,
          ).toLocaleString("en-US");
          var dirInfo = "";
          if (p.current_dir) {
            var parts = p.current_dir.split("\\");
            dirInfo = parts[parts.length - 1];
          }
          var phaseLabels = [
            "scanning...",
            "building tree...",
            "chunking...",
            "done",
          ];
          var label = phaseLabels[p.phase] || "";
          if (dirInfo) label += " -> " + dirInfo;
          if (p.elapsed_secs) {
            var mins = Math.floor(p.elapsed_secs / 60);
            var secs = p.elapsed_secs % 60;
            elapsedEl.textContent =
              "Elapsed: " + (mins > 0 ? mins + "m " : "") + secs + "s";
          }
          progressLabelEl.textContent = label;

          if (!p.is_running || p.phase === 3) {
            await sleep(500);
            done = true;
            break;
          }
        }

        if (!done) throw new Error("Scan timeout");

        var result = null;
        for (var ri = 0; ri < 60; ri++) {
          result = await window.__TAURI__
            .invoke("get_scan_result", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (result) break;
          await sleep(500);
        }

        if (!result) throw new Error("No scan result");

        clearTimeout(safetyTimer);
        progressOverlay.classList.remove("active");

        currentStats = result.stats;

        // Update stats
        if (result.stats) {
          statsPanel.render(result.stats);
          diagram.setData(result.stats);
          var files = Number(result.stats.total_files || 0).toLocaleString(
            "en-US",
          );
          var dirs = Number(result.stats.total_dirs || 0).toLocaleString(
            "en-US",
          );
          document.querySelector(".status-bar").textContent =
            "Complete - " + files + " files, " + dirs + " dirs";
        }

        topFiles.render(result.stats ? result.stats.top_files : [], true);

        // Load tree
        if (result.root_info && result.root_info.total_chunks > 0) {
          loader.totalNodes = result.root_info.total_nodes;
          loader.totalChunks = result.root_info.total_chunks;
          loader.allNodes = new Array(loader.totalNodes);
          loader.scanId = scanId;

          try {
            await loader.loadChunk(0);
          } catch (e) {
            console.warn("loadChunk(0) failed:", e);
          }

          // Auto-expand root so users see children immediately
          treeView.expanded.add(0);

          try {
            await treeView.rebuild();
          } catch (e) {
            console.warn("Tree rebuild:", e.message);
          }

          // Background chunk loading (parallel batches of 10)
          var BATCH_SIZE = 10;
          for (var ci = 1; ci < loader.totalChunks; ci += BATCH_SIZE) {
            var batch = [];
            for (
              var bj = 0;
              bj < BATCH_SIZE && ci + bj < loader.totalChunks;
              bj++
            ) {
              var chunkIdx = ci + bj;
              if (!loader.loadedChunks.has(chunkIdx)) {
                batch.push(loader.loadChunk(chunkIdx));
              }
            }
            if (batch.length > 0) {
              await Promise.all(batch);
            }
            await sleep(0); // yield to UI
          }
        }

        btnExport.disabled = false;
        var nc = document.getElementById("node-count");
        if (nc)
          nc.textContent =
            treeView.visibleNodes.length.toLocaleString() + " shown";
      } catch (err) {
        console.error("Scan failed:", err);
        document.querySelector(".status-bar").textContent = "Error: " + err;
      } finally {
        clearTimeout(safetyTimer);
        isScanning = false;
        btnScan.disabled = false;
        btnBrowse.disabled = false;
        btnCancel.disabled = true;
        progressOverlay.classList.remove("active");
      }
    });

    // Cancel
    btnCancel.addEventListener("click", async function () {
      await loader.release();
      isScanning = false;
      btnScan.disabled = false;
      btnCancel.disabled = true;
      progressOverlay.classList.remove("active");
      document.querySelector(".status-bar").textContent = "Cancelled";
    });

    // Export
    btnExport.addEventListener("click", async function () {
      try {
        var stats = currentStats || {};
        var json = JSON.stringify(
          {
            export_time: new Date().toISOString(),
            scan_path: scanPath.value,
            stats: stats,
          },
          null,
          2,
        );
        var blob = new Blob([json], { type: "application/json" });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = "diskraptor-export-" + Date.now() + ".json";
        a.click();
        URL.revokeObjectURL(url);
        document.querySelector(".status-bar").textContent =
          "Exported successfully";
      } catch (err) {
        console.error("Export failed:", err);
        alert("Export failed: " + err);
      }
    });

    scanPath.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btnScan.click();
    });

    console.log("DiskRaptor ready.");
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // Wrap init in a global error handler
  function safeInit() {
    init().catch(function (err) {
      console.error("DiskRaptor init failed:", err);
      var sb = document.querySelector(".status-bar");
      if (sb) {
        sb.textContent = "Init error: " + err.message;
        sb.style.color = "#f85149";
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInit);
  } else {
    safeInit();
  }
})();
