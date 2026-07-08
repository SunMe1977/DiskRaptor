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

    // Diagram mode switcher
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

    // Listen for menu events from Tauri
    if (window.__TAURI__ && window.__TAURI__.event) {
      try {
        window.__TAURI__.event.listen("menu-view-pie", function () {
          diagramModes.forEach(function (b) {
            b.classList.remove("active");
          });
          document
            .querySelector('.diagram-mode[data-mode="pie"]')
            .classList.add("active");
          diagram.setMode("pie");
        });
        window.__TAURI__.event.listen("menu-view-treemap", function () {
          diagramModes.forEach(function (b) {
            b.classList.remove("active");
          });
          document
            .querySelector('.diagram-mode[data-mode="treemap"]')
            .classList.add("active");
          diagram.setMode("treemap");
        });
        window.__TAURI__.event.listen("menu-about", function () {
          aboutOverlay.classList.add("active");
        });
      } catch (e) {
        console.log("Menu events not available:", e.message);
      }
    }

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
          } catch (e) {}

          try {
            await treeView.rebuild();
          } catch (e) {
            console.warn("Tree rebuild:", e.message);
          }

          // Background chunk loading
          for (var ci = 1; ci < loader.totalChunks; ci++) {
            if (!loader.loadedChunks.has(ci)) {
              await loader.loadChunk(ci);
            }
            if (ci % 5 === 0) await sleep(0);
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
