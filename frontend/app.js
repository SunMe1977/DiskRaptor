
// Qt bridge polyfill for Tauri compatibility
(function() {
    if (!window.__TAURI__ && window.bridge) {
        window.__TAURI__ = {
            invoke: function(cmd, args) {
                if (window.bridge && typeof window.bridge[cmd] === 'function') {
                    var result = window.bridge[cmd](args ? JSON.stringify(args) : '{}');
                    try { return JSON.parse(result).data; } catch(e) { return result; }
                }
                return Promise.resolve(null);
            },
            event: {
                listen: function(event, cb) {
                    document.addEventListener(event, function(e) { cb({ payload: e.detail }); });
                },
                emit: function(event, data) {
                    document.dispatchEvent(new CustomEvent(event, { detail: data }));
                }
            }
        };
    }
})();
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

    // Galaxy view state
    var galaxyView = null;
    var galaxyContainer = document.getElementById("galaxy-container");
    var diagramContainer = document.getElementById("diagram-container");
    var isGalaxyMode = false;

    function _feedGalaxyView() {
      if (!galaxyView || !currentStats) return;
      galaxyView.loadData(currentStats, currentStats, currentStats.top_files, []);
    }

    // Diagram mode switcher (in detail panel)
    var diagramModes = document.querySelectorAll(".diagram-mode");
    diagramModes.forEach(function (btn) {
      btn.addEventListener("click", function () {
        diagramModes.forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");

        var mode = btn.dataset.mode;
        if (mode === "galaxy") {
          // Switch to galaxy view
          isGalaxyMode = true;
          if (diagramContainer) diagramContainer.style.display = "none";
          if (galaxyContainer) {
            galaxyContainer.style.display = "block";
            if (!galaxyView) {
              try {
                galaxyView = new GalaxyView.GalaxyView(galaxyContainer);
                galaxyView.init();
              } catch (e) {
                console.error("GalaxyView init failed:", e);
              }
            }
            galaxyView.show();
            _feedGalaxyView();
          }
        } else {
          // Switch to pie/treemap
          isGalaxyMode = false;
          if (galaxyContainer) galaxyContainer.style.display = "none";
          if (galaxyView) galaxyView.hide();
          if (diagramContainer) diagramContainer.style.display = "block";
          diagram.setMode(mode);
        }
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

      isScanning = true;
      btnScan.disabled = true;
      btnBrowse.disabled = true;
      btnCancel.disabled = false;
      btnExport.disabled = true;

      var safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
      }, 600000);

      // Progress elements (now static in HTML)
      var progressFilesEl = document.getElementById("progress-files");
      var progressLabelEl = document.getElementById("progress-label");
      var progressDirEl = document.getElementById("progress-dir");
      var progressSpeedEl = document.getElementById("progress-speed");
      var progressElapsedEl = document.getElementById("progress-elapsed");

      progressOverlay.classList.add("active");
      progressPath.textContent = "Scanning: " + path;

      // Reset progress display
      progressFilesEl.textContent = "0";
      progressLabelEl.textContent = "files found, scanning...";
      progressDirEl.textContent = "";
      progressSpeedEl.textContent = "";
      progressElapsedEl.textContent = "";

      try {
        var initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
        });
        // Handle optional scan_id — bridge may or may not return one
        var scanId = (initScan && initScan.scan_id) || 1;

        // Poll tracking
        var prevFilesFound = 0;
        var pollStartTime = Date.now();

        var done = false;
        for (var i = 0; i < 600; i++) {
          await sleep(500);
          var p = await window.__TAURI__
            .invoke("get_scan_progress", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (!p) continue;

          var filesFound = Number(p.files_found || 0);
          progressFilesEl.textContent = filesFound.toLocaleString("en-US");

          var dirInfo = "";
          if (p.current_dir) {
            var parts = p.current_dir.split("\\");
            dirInfo = parts[parts.length - 1];
            progressDirEl.textContent = "📂 " + dirInfo;
          }

          var phaseLabels = [
            "scanning...",
            "building tree...",
            "chunking...",
            "done",
          ];
          var label = phaseLabels[p.phase] || "";
          if (dirInfo) label += " -> " + dirInfo;
          progressLabelEl.textContent = label;

          // Speed / bandwidth
          var elapsedSecs = p.elapsed_secs || 0;
          if (elapsedSecs > 0) {
            var filesPerSec = (filesFound / elapsedSecs).toFixed(1);
            progressSpeedEl.textContent = "⚡ " + filesPerSec + " files/sec";
          }

          // Elapsed time
          if (elapsedSecs) {
            var mins = Math.floor(elapsedSecs / 60);
            var secs = elapsedSecs % 60;
            var elapsedStr =
              (mins > 0 ? mins + "m " : "") + secs + "s";
            progressElapsedEl.textContent = "⏱ " + elapsedStr;
          }

          prevFilesFound = filesFound;

          if (!p.is_running || p.phase === 3) {
            await sleep(500);
            done = true;
            break;
          }
        }

        if (!done) throw new Error("Scan timeout");

        // Update progress to done state
        progressLabelEl.textContent = "✓ Scan complete";
        progressSpeedEl.textContent = "";

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
