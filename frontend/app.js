/**
 * DiskRaptor — Main application controller.
 *
 * Wires together the ChunkLoader, TreeView, TopFiles, and Stats panels.
 * Handles toolbar events (scan, browse, export) and progress display.
 */
(function () {
  "use strict";

  async function init() {
    console.log("DiskRaptor booting...");

    // Wait for the Tauri IPC bridge (loaded via tauri-api-bridge.js module).
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
      const errMsg =
        'Tauri backend not connected. Please run via "npm run tauri dev".';
      console.error(errMsg, err);
      const sb = document.querySelector("#tree-panel .status-bar");
      if (sb) sb.textContent = "⚠️ " + errMsg;
      return;
    }

    if (!window.__TAURI__ || typeof window.__TAURI__.invoke !== "function") {
      console.error("Tauri invoke still unavailable after bridge-ready event");
      return;
    }

    console.log("DiskRaptor initializing...");

    // ── State ───────────────────────────────────────────────────────────
    const loader = new ChunkLoader();
    const treeView = new TreeView("tree-viewport", loader);
    const topFiles = new TopFilesPanel();
    const statsPanel = new StatsPanel();

    let isScanning = false;

    // ── Progress callback ───────────────────────────────────────────────
    loader.onProgress = (loaded, total) => {
      const el = document.querySelector("#tree-panel .status-bar");
      if (el) el.textContent = `Loading chunks\u2026 ${loaded}/${total}`;
    };

    // ── Tree selection callback ─────────────────────────────────────────
    treeView.onSelect = (_arenaIdx) => {
      // Selection info is updated inside treeView.select()
    };

    // ── DOM refs ────────────────────────────────────────────────────────
    const scanPath = document.getElementById("scan-path");
    const btnBrowse = document.getElementById("btn-browse");
    const btnScan = document.getElementById("btn-scan");
    const btnCancel = document.getElementById("btn-cancel");
    const btnExport = document.getElementById("btn-export");
    const progressOverlay = document.getElementById("progress-overlay");
    const progressPath = document.getElementById("progress-path");

    // ── Browse button ───────────────────────────────────────────────────
    btnBrowse.addEventListener('click', async function () {
      try {
        var selected = await window.__TAURI__.invoke('pick_directory');
        if (selected && typeof selected === 'string') {
          scanPath.value = selected;
          document.querySelector('.status-bar').textContent = 'Selected: ' + selected;
        }
      } catch (err) {
        console.warn('Browse error:', err);
        document.querySelector('.status-bar').textContent = 'Browse click - manual entry';
        document.getElementById('scan-path').focus();
        document.getElementById('scan-path').select();
      }
    });

    // ── Scan button ─────────────────────────────────────────────────────
    btnScan.addEventListener("click", async () => {
      if (isScanning) return;

      const path = scanPath.value.trim();
      if (!path) {
        alert("Please enter or select a directory path.");
        return;
      }

      isScanning = true;
      btnScan.disabled = true;
      btnBrowse.disabled = true;
      btnCancel.disabled = false;
      btnExport.disabled = true;

      // Safety: dismiss overlay after 10min no matter what
      var safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove('active');
        document.querySelector('.status-bar').textContent = 'Overlay safety timeout triggered';
      }, 600000);

      // Show progress overlay with live file count
      var progressCard = progressOverlay.querySelector('.progress-card');

      // Remove old dynamic children if any
      var oldFiles = document.getElementById('progress-files');
      if (oldFiles) oldFiles.remove();
      var oldLabel = document.getElementById('progress-label');
      if (oldLabel) oldLabel.remove();
      var oldElapsed = document.getElementById('progress-elapsed');
      if (oldElapsed) oldElapsed.remove();

      var progressFilesEl = document.createElement('div');
      progressFilesEl.id = 'progress-files';
      progressFilesEl.style.cssText = 'font-size:24px;font-weight:700;color:var(--accent);margin:8px 0';
      progressFilesEl.textContent = '0';
      var progressLabelEl = document.createElement('div');
      progressLabelEl.id = 'progress-label';
      progressLabelEl.style.cssText = 'font-size:12px;color:var(--text-muted)';
      progressLabelEl.textContent = 'files found, scanning...';
      var progressElapsedEl = document.createElement('div');
      progressElapsedEl.id = 'progress-elapsed';
      progressElapsedEl.style.cssText = 'font-size:11px;color:var(--text-muted);margin-top:4px';
      progressElapsedEl.textContent = '';
      progressCard.appendChild(progressFilesEl);
      progressCard.appendChild(progressLabelEl);
      progressCard.appendChild(progressElapsedEl);

      progressOverlay.classList.add("active");
      progressPath.textContent = 'Scanning: ' + path;

      try {
        // Step 1: Start scan and get scan ID
        var initScan = await window.__TAURI__.invoke('start_scan', { path: path });
        var scanId = initScan.scan_id;
        window.__diskraptorLastScanId = scanId;

        // Step 2: Poll progress until done (with stall detection)
        var lastFilesFound = -1;
        var lastProgressTs = Date.now();
        var stallMs = 120000;
        var progressDone = false;

        while (!progressDone) {
          var p = await window.__TAURI__.invoke('get_scan_progress', { scanId: scanId }).catch(function () { return null; });
          if (!p) {
            await sleep(500);
            continue;
          }

          var filesFound = Number(p.files_found || 0);
          progressFilesEl.textContent = filesFound.toLocaleString('en-US');

          // Show current directory + elapsed
          var phaseLabels = ['scanning...', 'building tree...', 'chunking...', 'done'];
          var phase = p.phase !== undefined ? p.phase : 0;

          var dirInfo = '';
          if (p.current_dir && p.current_dir.length > 0) {
            var parts = p.current_dir.split('\\');
            dirInfo = parts[parts.length - 1];
            if (parts.length > 1) dirInfo = parts[parts.length - 2] + '\\' + dirInfo;
          }

          var elapsed = '';
          if (p.elapsed_secs) {
            var mins = Math.floor(p.elapsed_secs / 60);
            var secs = p.elapsed_secs % 60;
            elapsed = mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
          }
          progressElapsedEl.textContent = elapsed ? 'Elapsed: ' + elapsed : '';

          var label = phaseLabels[phase] || 'processing...';
          if (dirInfo) label += '  \u2192 ' + dirInfo;
          progressLabelEl.textContent = label;

          if (filesFound !== lastFilesFound) {
            lastFilesFound = filesFound;
            lastProgressTs = Date.now();
          }

          // Check if scan is complete
          if (!p.is_running || phase === 3) {
            // Scan done — wait briefly for result to be ready
            await sleep(500);
            progressDone = true;
            break;
          }

          // Stall detection
          if (phase === 0 && (Date.now() - lastProgressTs) > stallMs) {
            console.warn('Scan stalled at', filesFound, 'files — forcing done');
            progressDone = true;
            break;
          }

          await sleep(500);
        }

        // Step 3: Poll for result
        var result = null;
        for (var ri = 0; ri < 60; ri++) {
          result = await window.__TAURI__.invoke('get_scan_result', { scanId: scanId }).catch(function () { return null; });
          if (result) break;
          await sleep(500);
        }

        if (!result) {
          throw new Error('Scan did not produce a result.');
        }

        // ────────────────────────────────────────────────────────────────
        // IMMEDIATELY dismiss overlay and show stats
        // ────────────────────────────────────────────────────────────────
        clearTimeout(safetyTimer);
        progressOverlay.classList.remove("active");

        // Update stats immediately
        if (result.stats) {
          statsPanel.render(result.stats);

          var files = Number(result.stats.total_files || 0).toLocaleString("en-US");
          var dirs = Number(result.stats.total_dirs || 0).toLocaleString("en-US");
          document.querySelector("#tree-panel .status-bar").textContent =
            'Complete \u2014 ' + files + ' files, ' + dirs + ' dirs';
        }

        // Show top files with delete buttons
        topFiles.render(result.stats ? result.stats.top_files : [], true);

        // Step 4: Rebuild tree in background (non-blocking)
        progressPath.textContent = "Building tree\u2026";

        // Load chunk 0 first (contains root node)
        if (result.root_info && result.root_info.total_chunks > 0) {
          loader.totalNodes = result.root_info.total_nodes;
          loader.totalChunks = result.root_info.total_chunks;
          loader.allNodes = new Array(loader.totalNodes);
          loader.scanId = scanId;

          try {
            await loader.loadChunk(0);
          } catch (e) {
            console.warn('Chunk 0 load error:', e);
          }

          // Rebuild tree — this should be fast if root is not expanded
          try {
            await treeView.rebuild();
          } catch (e) {
            console.warn('Tree rebuild error:', e);
          }

          // Load remaining chunks in background
          _loadRemainingChunks(loader);
        }

        btnExport.disabled = false;

        // Update node count
        var nc = document.getElementById('node-count');
        if (nc) nc.textContent = treeView.visibleNodes.length.toLocaleString() + ' shown';
      } catch (err) {
        console.error("Scan failed:", err);
        document.querySelector("#tree-panel .status-bar").textContent = 'Error: ' + err;
        alert('Scan failed: ' + err);
      } finally {
        clearTimeout(safetyTimer);
        window.__diskraptorLastScanId = null;
        isScanning = false;
        btnScan.disabled = false;
        btnBrowse.disabled = false;
        btnCancel.disabled = true;
        progressOverlay.classList.remove("active");
      }
    });

    // ── Cancel button ───────────────────────────────────────────────────
    btnCancel.addEventListener("click", async () => {
      await loader.release();
      isScanning = false;
      btnScan.disabled = false;
      btnCancel.disabled = true;
      progressOverlay.classList.remove("active");
      document.querySelector("#tree-panel .status-bar").textContent =
        "Cancelled";
    });

    // ── Export button ───────────────────────────────────────────────────
    btnExport.addEventListener("click", async () => {
      try {
        const stats = await loader.getStats();
        const exportData = {
          export_time: new Date().toISOString(),
          scan_path: scanPath.value,
          stats: stats,
          note: "Full tree export requires loading all chunks",
        };

        const json = JSON.stringify(exportData, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "diskraptor-export-" + Date.now() + ".json";
        a.click();
        URL.revokeObjectURL(url);

        document.querySelector("#tree-panel .status-bar").textContent =
          "Exported successfully";
      } catch (err) {
        console.error("Export failed:", err);
        alert("Export failed: " + err);
      }
    });

    // ── Enter key in path input ─────────────────────────────────────────
    scanPath.addEventListener("keydown", (e) => {
      if (e.key === "Enter") btnScan.click();
    });

    console.log("DiskRaptor ready.");
  }

  /** Load remaining chunks in the background (non‑blocking). */
  async function _loadRemainingChunks(loader) {
    if (!loader || loader.totalChunks <= 1) return;
    try {
      for (let i = 1; i < loader.totalChunks; i++) {
        if (!loader.loadedChunks.has(i)) {
          await loader.loadChunk(i);
        }
        if (i % 5 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } catch (err) {
      console.warn("Background chunk loading error:", err);
    }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
