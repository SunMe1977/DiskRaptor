/**
 * DiskRaptor - Main application controller.
 */
(function () {
  "use strict";

  async function init() {
    console.log("DiskRaptor booting...");

    const bridgeReady = new Promise((resolve) => {
      if (
        window.__TAURI__ &&
        typeof window.__TAURI__.invoke === "function" &&
        window.__TAURI__.__qtBridgeReady === true
      ) {
        resolve(true);
        return;
      }
      window.addEventListener(
        "tauri-bridge-ready",
        () => {
          if (window.__TAURI__ && window.__TAURI__.__qtBridgeReady === true) {
            resolve(true);
          }
        },
        { once: true },
      );
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
    if (savedTheme !== "dark") {
      document.body.classList.add("light-theme");
      btnTheme.textContent = "☀";
      btnTheme.title = "Switch to dark mode";
      if (!savedTheme) localStorage.setItem("diskraptor-theme", "light");
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

    // Scan path starts empty — user picks a folder or types one in

    // ── GalaxyView (3D visualization) ───────────────────────
    var galaxyView = null;
    try {
      galaxyView = new GalaxyView.GalaxyView("#galaxy-view");
      galaxyView.init();
    } catch (e) {
      console.warn("GalaxyView init failed:", e);
    }

    // Diagram mode switcher (in detail panel)
    var diagramModes = document.querySelectorAll(".diagram-mode");
    var lastDiagramMode = "pie";
    var isGalaxyMode = false;

    diagramModes.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var mode = btn.dataset.mode;
        diagramModes.forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");

        if (mode === "galaxy") {
          isGalaxyMode = true;
          // Hide the standard panels, show galaxy
          var leftCol = document.getElementById("left-column");
          var vSplit = document.getElementById("v-splitter");
          var detailPanel = document.getElementById("detail-panel");
          if (leftCol) leftCol.style.display = "none";
          if (vSplit) vSplit.style.display = "none";
          if (detailPanel) detailPanel.style.display = "none";
          if (galaxyView) {
            galaxyView.show();
            // Load data if we have it
            if (galaxyView.objects.length === 0 && currentStats) {
              _feedGalaxyView();
            }
          }
        } else {
          isGalaxyMode = false;
          if (galaxyView) galaxyView.hide();
          // Restore standard panels
          var leftCol = document.getElementById("left-column");
          var vSplit = document.getElementById("v-splitter");
          var detailPanel = document.getElementById("detail-panel");
          if (leftCol) leftCol.style.display = "";
          if (vSplit) vSplit.style.display = "";
          if (detailPanel) detailPanel.style.display = "";
          lastDiagramMode = mode;
          diagram.setMode(mode);
        }
      });
    });

    /** Feed current scan data to GalaxyView */
    function _feedGalaxyView() {
      if (!galaxyView || !currentStats) return;
      // Build topFiles array from stats
      var topFiles = [];
      if (currentStats.topFiles) {
        topFiles = currentStats.topFiles;
      } else if (currentStats.total_files) {
        // Generate synthetic top files from stats
        for (var i = 0; i < 50; i++) {
          topFiles.push({
            path: "file_" + i + ".dat",
            size: Math.floor(Math.random() * currentStats.total_size * 0.1),
          });
        }
      }
      galaxyView.loadData(currentStats, currentStats, topFiles, null);
    }

    // Listen for galaxy object selection
    if (galaxyView) {
      var galaxyContainer = document.getElementById("galaxy-view");
      if (galaxyContainer) {
        galaxyContainer.addEventListener("galaxyview:selected", function (e) {
          var obj = e.detail && e.detail.object;
          if (obj && obj.path) {
            scanPath.value = obj.path;
            // Update selection panel
            var selName = document.getElementById("sel-name");
            var selSize = document.getElementById("sel-size");
            if (selName) selName.textContent = obj.name || obj.path;
            if (selSize && obj.data && obj.data.size) {
              selSize.textContent = _fmtBytesG(obj.data.size);
            }
          }
        });
      }
    }

    function _fmtBytesG(b) {
      if (!b || b === 0) return "0 B";
      var units = ["B","KB","MB","GB","TB"];
      var i = Math.floor(Math.log(b) / Math.log(1024));
      if (i >= units.length) i = units.length - 1;
      var v = b / Math.pow(1024, i);
      return (i === 0 ? b : v.toFixed(1)) + " " + units[i];
    }

    // About dialog
    aboutClose.addEventListener("click", function () {
      aboutOverlay.classList.remove("active");
    });
    aboutOverlay.addEventListener("click", function (e) {
      if (e.target === aboutOverlay) aboutOverlay.classList.remove("active");
    });

    // ── Drive Selector ─────────────────────────────────────
    (function initDriveSelector() {
      var btnDrives = document.getElementById("btn-drives");
      var drivesDropdown = document.getElementById("drives-dropdown");
      var drivesList = document.getElementById("drives-list");

      function formatBytes(b) {
        if (!b || b === 0) return "?";
        var units = ["B","KB","MB","GB","TB"];
        var i = Math.floor(Math.log(b) / Math.log(1024));
        if (i >= units.length) i = units.length - 1;
        var v = b / Math.pow(1024, i);
        return (i === 0 ? b : v.toFixed(1)) + " " + units[i];
      }

      function loadDrives() {
        if (!window.__TAURI__ || !window.__TAURI__.invoke) return;
        window.__TAURI__.invoke("list_drives").then(function(drives) {
          var html = "";
          drives.forEach(function(d) {
            var letter = d.path.replace(":", "").replace("\\", "");
            // Determine icon
            var icon = "💾";
            var upper = letter.toUpperCase();
            if (upper === "C") icon = "💽";
            else if (upper === "D" || upper === "E") icon = "📀";

            var pct = d.percent_full || 0;
            var barColor = pct > 90 ? "var(--accent-red)" : pct > 75 ? "var(--accent-orange)" : "var(--accent-green)";
            var freeStr = d.free_bytes > 0 ? formatBytes(d.free_bytes) + " free" : "";
            var totalStr = d.total_bytes > 0 ? formatBytes(d.total_bytes) : "";

            html +=
              '<button class="drive-item" data-path="' + d.path + '">' +
              '<span class="drive-icon">' + icon + '</span>' +
              '<div class="drive-info">' +
                '<div class="drive-top">' +
                  '<span class="drive-label">Drive ' + letter + '</span>' +
                  '<span class="drive-pct">' + pct + '%</span>' +
                '</div>' +
                '<div class="drive-bar-wrap"><div class="drive-bar" style="width:' + pct + '%;background:' + barColor + '"></div></div>' +
                '<div class="drive-bottom">' +
                  '<span class="drive-free">' + freeStr + '</span>' +
                  '<span class="drive-total">' + totalStr + '</span>' +
                '</div>' +
              '</div>' +
              '</button>';
          });
          drivesList.innerHTML = html;

          drivesList.querySelectorAll(".drive-item").forEach(function(el) {
            el.addEventListener("click", function() {
              var path = this.getAttribute("data-path");
              scanPath.value = path;
              drivesDropdown.classList.remove("active");
              document.querySelector(".status-bar").textContent = "Selected: " + path;
              setTimeout(function() { btnScan.click(); }, 100);
            });
          });
        }).catch(function(e) {
          console.warn("Drives list failed:", e);
        });
      }

      btnDrives.addEventListener("click", function(e) {
        e.stopPropagation();
        drivesDropdown.classList.toggle("active");
        if (drivesDropdown.classList.contains("active")) {
          loadDrives();
        }
      });

      document.addEventListener("click", function(e) {
        if (!e.target.closest(".drive-selector")) {
          drivesDropdown.classList.remove("active");
        }
      });
    })();

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
        ["pie", "treemap", "galaxy"].forEach(function (mode) {
          window.__TAURI__.event.listen("menu-view-" + mode, function () {
            document.querySelectorAll(".diagram-mode").forEach(function (b) {
              b.classList.remove("active");
            });
            var btn = document.querySelector(
              '.diagram-mode[data-mode="' + mode + '"]',
            );
            if (btn) btn.classList.add("active");

            if (mode === "galaxy") {
              isGalaxyMode = true;
              var leftCol = document.getElementById("left-column");
              var vSplit = document.getElementById("v-splitter");
              var detailPanel = document.getElementById("detail-panel");
              if (leftCol) leftCol.style.display = "none";
              if (vSplit) vSplit.style.display = "none";
              if (detailPanel) detailPanel.style.display = "none";
              if (galaxyView) {
                galaxyView.show();
                if (galaxyView.objects.length === 0 && currentStats) {
                  _feedGalaxyView();
                }
              }
            } else {
              isGalaxyMode = false;
              if (galaxyView) galaxyView.hide();
              var leftCol = document.getElementById("left-column");
              var vSplit = document.getElementById("v-splitter");
              var detailPanel = document.getElementById("detail-panel");
              if (leftCol) leftCol.style.display = "";
              if (vSplit) vSplit.style.display = "";
              if (detailPanel) detailPanel.style.display = "";
              diagram.setMode(mode);
            }
          });
        });
        window.__TAURI__.event.listen("menu-about", function () {
          aboutOverlay.classList.add("active");
        });
        window.__TAURI__.event.listen("menu-find-duplicates", function () {
          var btnDup = document.getElementById("btn-duplicates");
          if (btnDup) btnDup.click();
        });
        window.__TAURI__.event.listen("menu-check-updates", async function () {
          var overlay = document.getElementById("update-overlay");
          if (!overlay) return;
          // Show connecting state
          var icon = document.getElementById("update-icon");
          var status = document.getElementById("update-status");
          var version = document.getElementById("update-version");
          var actions = document.getElementById("update-actions");
          var progress = document.getElementById("update-progress");
          var dlBtn = document.getElementById("btn-update-download");
          var closeBtn = document.getElementById("btn-update-close");
          icon.textContent = "🔗";
          status.textContent = "Connecting to GitHub…";
          version.textContent = "";
          actions.style.display = "none";
          progress.style.display = "none";
          overlay.classList.add("active");
          closeBtn.onclick = function () { overlay.classList.remove("active"); };
          overlay.addEventListener("click", function (e) {
            if (e.target === overlay) overlay.classList.remove("active");
          });
          try {
            await sleep(800);
            var result = await window.__TAURI__.invoke("check_for_updates");
            var currentVer = "v0.2.4";
            var remoteVer = result.trim();
            if (remoteVer > currentVer) {
              icon.textContent = "⬇️";
              status.textContent = "A new version is available!";
              version.textContent = "Current: " + currentVer + " \u2192 Latest: " + remoteVer;
              actions.style.display = "flex";
              dlBtn.style.display = "inline-block";
              dlBtn.onclick = async function () {
                actions.style.display = "none";
                progress.style.display = "block";
                icon.textContent = "⏳";
                status.textContent = "Downloading latest version…";
                try {
                  await window.__TAURI__.invoke("download_and_install", { version: remoteVer });
                } catch (e) {
                  icon.textContent = "❌";
                  status.textContent = "Download failed: " + e;
                  actions.style.display = "flex";
                  dlBtn.style.display = "none";
                  progress.style.display = "none";
                }
              };
            } else {
              icon.textContent = "✅";
              status.textContent = "You\u2019re up to date!";
              version.textContent = "Current: " + currentVer + " (latest)";
              actions.style.display = "flex";
              dlBtn.style.display = "none";
            }
          } catch (e) {
            icon.textContent = "❌";
            status.textContent = "Could not check for updates.";
            version.textContent = e.message || "Network error";
            actions.style.display = "flex";
            dlBtn.style.display = "none";
          }
        });
        // Language menu: single event with language code as payload
        window.__TAURI__.event.listen("lang-changed", function (evt) {
          var code = evt && evt.payload;
          if (typeof code === "string") {
            if (code.length === 2 || code === "auto") {
              window.I18N.setLocale(code);
            }
          }
        });
      } catch (e) {
        console.log("Menu events not available:", e.message);
      }
    }

    // Update progress label on locale change
    window.addEventListener("locale-changed", function () {
      // nothing needed for static stats
    });

    // Browse → after selection auto-start scan
    btnBrowse.addEventListener("click", async function () {
      try {
        var selected = await window.__TAURI__.invoke("pick_directory");
        if (selected && typeof selected === "string") {
          scanPath.value = selected;
          document.querySelector(".status-bar").textContent =
            "Selected: " + selected;
          // Auto-start scan after browse
          await sleep(100);
          btnScan.click();
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

      // Check if admin rights are needed (Windows only, best-effort)
      try {
        if (window.__TAURI__ && window.__TAURI__.invoke) {
          var needsAdmin = await window.__TAURI__.invoke("check_admin_needed", {
            path: path,
          });
          if (needsAdmin) {
            if (
              confirm(
                "Some folders require administrator rights for full visibility.\n" +
                  "Restart DiskRaptor as Administrator?",
              )
            ) {
              await window.__TAURI__.invoke("restart_as_admin");
              return; // process.exit(0) will be called on the Rust side
            }
          }
        }
      } catch (e) {
        // Silently ignore — admin check is optional
        console.log("Admin check skipped:", e.message);
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

      // Reset progress stats
      document.getElementById("pstat-files").textContent = "0";
      document.getElementById("pstat-dirs").textContent = "0";
      document.getElementById("pstat-size").textContent = "—";
      document.getElementById("pstat-files-rate").textContent = "—";
      document.getElementById("pstat-dirs-rate").textContent = "—";
      document.getElementById("pstat-size-rate").textContent = "—";
      document.getElementById("progress-elapsed").textContent = "";
      window._lastPoll = null;
      window._perfData = [];

      progressOverlay.classList.add("active");
      progressPath.textContent = "Scanning: " + path;

      try {
        var initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
        });
        var scanId =
          (initScan && (initScan.scan_id || initScan.scanId)) || 1;

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

          var files = Number(p.files_found || 0);
          var dirs = Number(p.dirs_found || 0);
          var elapsed = Number(p.elapsed_secs || 0);
          if (!files && p.filesFound) files = Number(p.filesFound || 0);
          if (!dirs && p.dirsFound) dirs = Number(p.dirsFound || 0);
          if (!elapsed && p.elapsedSecs) elapsed = Number(p.elapsedSecs || 0);

          // Update counts
          document.getElementById("pstat-files").textContent =
            files.toLocaleString("en-US");
          document.getElementById("pstat-dirs").textContent =
            dirs.toLocaleString("en-US");
          // Estimate size: ~500KB per file average until real data available
          var approxBytes = files * 512000;
          var sizeStr = "—";
          if (approxBytes > 1073741824) {
            sizeStr = (approxBytes / 1073741824).toFixed(1) + " GB";
          } else if (approxBytes > 1048576) {
            sizeStr = (approxBytes / 1048576).toFixed(0) + " MB";
          } else {
            sizeStr = (approxBytes / 1024).toFixed(0) + " KB";
          }
          document.getElementById("pstat-size").textContent = sizeStr;

          // Calculate delta-based rates (items since last poll / poll interval)
          if (!window._lastPoll) window._lastPoll = { files: 0, dirs: 0, time: 0 };
          var pollTime = Date.now();
          var dt = (pollTime - window._lastPoll.time) / 1000;
          var fps, dps;
          if (window._lastPoll.time > 0 && dt > 0) {
            fps = ((files - window._lastPoll.files) / dt).toFixed(0);
            dps = ((dirs - window._lastPoll.dirs) / dt).toFixed(0);
          } else {
            fps = elapsed > 0 ? (files / elapsed).toFixed(0) : "—";
            dps = elapsed > 0 ? (dirs / elapsed).toFixed(0) : "—";
          }
          window._lastPoll = { files: files, dirs: dirs, time: pollTime };

          document.getElementById("pstat-files-rate").textContent =
            fps + "/s";
          document.getElementById("pstat-dirs-rate").textContent =
            dps + "/s";
          // Size rate: how much data scanned per second
          var approxBytesPerSec = elapsed > 0 ? approxBytes / elapsed : 0;
          var rateStr = "—";
          if (approxBytesPerSec > 1073741824) {
            rateStr = (approxBytesPerSec / 1073741824).toFixed(1) + " GB/s";
          } else if (approxBytesPerSec > 1048576) {
            rateStr = (approxBytesPerSec / 1048576).toFixed(0) + " MB/s";
          } else {
            rateStr = (approxBytesPerSec / 1024).toFixed(0) + " KB/s";
          }
          document.getElementById("pstat-size-rate").textContent = rateStr;

          // Push to performance graph data (max 120 entries = 60s)
          var fpsNum = typeof fps === "string" && fps !== "—" ? parseFloat(fps) : (fps || 0);
          var dpsNum = typeof dps === "string" && dps !== "—" ? parseFloat(dps) : (dps || 0);
          window._perfData.push({ time: Date.now(), fps: fpsNum, dps: dpsNum });
          if (window._perfData.length > 120) {
            window._perfData = window._perfData.slice(-120);
          }
          drawPerfGraph();

          // Elapsed time
          var mins = Math.floor(elapsed / 60);
          var secs = elapsed % 60;
          document.getElementById("progress-elapsed").textContent =
            (mins > 0 ? mins + "m " : "") + secs + "s";

          //           }

          var running =
            typeof p.is_running !== "undefined"
              ? p.is_running
              : p.isRunning;
          if (running === false || p.phase === 3) {
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
// Feed GalaxyView live scan
          if (galaxyView && isGalaxyMode) {
            galaxyView.updateLiveScan({
              filesFound: files,
              dirsFound: dirs,
              isRunning: true,
              elapsedSecs: elapsed,
            }

        if (!result) throw new Error("No scan result");

        clearTimeout(safetyTimer);
        progressOverlay.classList.remove("active");

        if (!result.stats) {
          result.stats = {
            total_files: Number(result.totalFiles || result.total_files || 0),
            total_dirs: Number(result.totalDirs || result.total_dirs || 0),
            total_size: Number(result.totalSize || result.total_size || 0),
            scan_time_ms: Number(result.scanTimeMs || result.scan_time_ms || 0),
            top_files: result.topFiles || result.top_files || [],
          };
        }
        if (!result.root_info) {
          result.root_info = { total_nodes: 0, total_chunks: 0 };
        }

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

        // Feed GalaxyView with scan data
        if (galaxyView) {
          var topFilesArr = (result.stats.top_files || result.topFiles || []).map(function(f) {
            return typeof f === "string" ? { path: f, size: 0 } : f;
          });
          galaxyView.loadData(result, result.stats, topFilesArr, null);
          // If galaxy mode is active, show it
          if (isGalaxyMode) {
            galaxyView.show();
          }
        }

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

    // ── Export dropdown ──────────────────────────────────
    (function initExportDropdown() {
      var exportMenu = document.getElementById("export-menu");
      if (!exportMenu) return;

      btnExport.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.classList.toggle("active");
      });

      exportMenu.querySelectorAll(".export-option").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var format = this.dataset.format;
          exportMenu.classList.remove("active");
          handleExport(format, currentStats, scanPath.value);
        });
      });

      document.addEventListener("click", function (e) {
        if (!e.target.closest(".export-dropdown-wrap")) {
          exportMenu.classList.remove("active");
        }
      });
    })();

    function handleExport(format, stats, path) {
      stats = stats || {};
      var topFiles = stats.top_files || [];

      function fmtBytes(b) {
        if (!b || b === 0) return "0 B";
        var units = ["B","KB","MB","GB","TB"];
        var i = Math.floor(Math.log(b) / Math.log(1024));
        if (i >= units.length) i = units.length - 1;
        var v = b / Math.pow(1024, i);
        return (i === 0 ? b : v.toFixed(2)) + " " + units[i];
      }

      function downloadBlob(content, filename, mime) {
        var blob = new Blob([content], { type: mime });
        var url = URL.createObjectURL(blob);
        var a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      }

      if (format === "json") {
        var json = JSON.stringify({
          export_time: new Date().toISOString(),
          scan_path: path,
          stats: stats,
        }, null, 2);
        downloadBlob(json, "diskraptor-export.json", "application/json");
      } else if (format === "csv") {
        var rows = [["Path","Size","SizeHuman"]];
        topFiles.forEach(function (f) {
          rows.push([f.path || "", String(f.size || 0), f.size_human || ""]);
        });
        var csv = rows.map(function (r) {
          return r.map(function (c) {
            if (typeof c === "string" && (c.indexOf(",") >= 0 || c.indexOf('"') >= 0)) {
              return '"' + c.replace(/"/g, '""') + '"';
            }
            return c;
          }).join(",");
        }).join("\n");
        downloadBlob(csv, "diskraptor-export.csv", "text/csv");
      } else if (format === "html") {
        var rows = "";
        topFiles.forEach(function (f, i) {
          rows += "<tr><td>" + (i + 1) + "</td><td>" + escapeHtml(f.path || "") + "</td><td>" + escapeHtml(f.size_human || "") + "</td><td>" + (f.size || 0) + "</td></tr>\n";
        });
        function escapeHtml(s) {
          return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
        }
        var html = '<!doctype html><html><head><meta charset="utf-8"><title>DiskRaptor Export</title>' +
          '<style>body{font-family:sans-serif;margin:20px;background:#fff;color:#333;}table{border-collapse:collapse;width:100%;}' +
          'th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;}th{background:#f0f0f0;font-weight:600;}' +
          'h1,h2{color:#222;}tr:nth-child(even){background:#f9f9f9;}.summary{display:flex;gap:24px;margin:16px 0;}' +
          '.summary-item{background:#f0f4ff;padding:12px 20px;border-radius:8px;text-align:center;}' +
          '.summary-item .label{font-size:12px;color:#666;}.summary-item .value{font-size:18px;font-weight:700;color:#111;}' +
          '</style></head><body>' +
          '<h1>DiskRaptor Scan Report</h1>' +
          '<p><strong>Scan Path:</strong> ' + escapeHtml(path) + '</p>' +
          '<p><strong>Export Time:</strong> ' + new Date().toISOString() + '</p>' +
          '<h2>Summary</h2>' +
          '<div class="summary">' +
          '<div class="summary-item"><div class="label">Files</div><div class="value">' + (stats.total_files || 0).toLocaleString() + '</div></div>' +
          '<div class="summary-item"><div class="label">Directories</div><div class="value">' + (stats.total_dirs || 0).toLocaleString() + '</div></div>' +
          '<div class="summary-item"><div class="label">Total Size</div><div class="value">' + fmtBytes(stats.total_size || 0) + '</div></div>' +
          '</div>' +
          '<h2>Top Files</h2>' +
          '<table><thead><tr><th>#</th><th>Path</th><th>Size</th><th>Bytes</th></tr></thead><tbody>' +
          rows + '</tbody></table></body></html>';
        downloadBlob(html, "diskraptor-export.html", "text/html");
      }

      document.querySelector(".status-bar").textContent =
        "Exported as " + format.toUpperCase();
    }

    // ── Duplicates Panel ───────────────────────────────────
    (function initDuplicates() {
      var btnDup = document.getElementById("btn-duplicates");
      var dupOverlay = document.getElementById("duplicates-overlay");
      var dupClose = document.getElementById("btn-duplicates-close");
      var dupProgress = document.getElementById("dup-progress");
      var dupResults = document.getElementById("duplicates-results");
      var dupSummary = document.getElementById("duplicates-summary");
      var dupBody = document.getElementById("duplicates-body");
      var dupStats = document.getElementById("dup-stats");
      var dupDiagramWrap = document.getElementById("dup-diagram-wrap");

      if (!btnDup || !dupOverlay) return;

      function closeDup() {
        dupOverlay.classList.remove("active");
        if (window._dupPollTimer) {
          clearInterval(window._dupPollTimer);
          window._dupPollTimer = null;
        }
      }

      if (dupClose) dupClose.addEventListener("click", closeDup);
      dupOverlay.addEventListener("click", function (e) {
        if (e.target === dupOverlay) closeDup();
      });

      function fmtBytesDup(b) {
        if (!b || b === 0) return "0 B";
        var units = ["B","KB","MB","GB","TB"];
        var i = Math.floor(Math.log(b) / Math.log(1024));
        if (i >= units.length) i = units.length - 1;
        var v = b / Math.pow(1024, i);
        return (i === 0 ? b : v.toFixed(2)) + " " + units[i];
      }

      // ── Duplicates Context Menu ──────────────────────────
      var dupCtx = document.getElementById("dup-ctx-menu");
      var dupCtxPath = null;

      function closeDupCtx() {
        if (dupCtx) dupCtx.style.display = "none";
        dupCtxPath = null;
      }

      document.addEventListener("click", function (e) {
        if (dupCtx && !dupCtx.contains(e.target)) closeDupCtx();
      });

      if (dupCtx) {
        dupCtx.querySelectorAll(".tctx-item").forEach(function (item) {
          item.addEventListener("click", async function () {
            var action = this.getAttribute("data-dup-action");
            var p = dupCtxPath;
            closeDupCtx();
            if (!p) return;
            try {
              if (action === "explorer") {
                await window.__TAURI__.invoke("open_explorer", { path: p });
              } else if (action === "terminal") {
                await window.__TAURI__.invoke("open_terminal", { path: p });
              } else if (action === "properties") {
                await window.__TAURI__.invoke("open_properties", { path: p });
              } else if (action === "copy") {
                await navigator.clipboard.writeText(p);
                document.querySelector(".status-bar").textContent = "Copied: " + p;
              } else if (action === "delete") {
                if (confirm("Delete this file?\n" + p)) {
                  await window.__TAURI__.invoke("delete_path", { path: p });
                  document.querySelector(".status-bar").textContent = "Deleted: " + p;
                  btnDup.click();
                }
              }
            } catch (e) {
              alert("Action failed: " + e.message);
            }
          });
        });
      }

      btnDup.addEventListener("click", async function () {
        var path = scanPath.value.trim();
        if (!path) {
          alert("Please enter a directory path first.");
          return;
        }

        dupOverlay.classList.add("active");
        dupStatus.style.display = "none";
        dupLoading.style.display = "none";
        dupProgress.style.display = "none";
        dupStats.style.display = "none";
        dupDiagramWrap.style.display = "none";
        dupResults.style.display = "none";
        dupBody.innerHTML = "";

        // Show progress with full live stats (like main scanner)
        dupProgress.style.display = "block";
        document.getElementById("dup-progress-label").textContent = "⚡ Scanning with the ultra-fast parallel Rust engine…";
        document.getElementById("dup-progress-dir").textContent = path;
        document.getElementById("dup-pstat-files").textContent = "0";
        document.getElementById("dup-pstat-files-rate").textContent = "—";
        document.getElementById("dup-pstat-size").textContent = "—";
        document.getElementById("dup-progress-elapsed").textContent = "0s";

        try {
          var started = await window.__TAURI__.invoke("find_duplicates", { path: path });
          if (started !== "started") throw new Error("Failed to start");

          var lastPoll = { files: 0, time: Date.now() };

          for (var pi = 0; pi < 600; pi++) {
            await sleep(500);
            var pp = await window.__TAURI__.invoke("get_duplicate_progress").catch(function () { return null; });
            if (!pp) continue;

            var files = Number(pp.files_found || 0);
            var elapsed = Number(pp.elapsed_secs || 0);

            document.getElementById("dup-pstat-files").textContent = files.toLocaleString("en-US");

            var pollNow = Date.now();
            var dt = (pollNow - lastPoll.time) / 1000;
            if (lastPoll.time > 0 && dt > 0) {
              var fps = ((files - lastPoll.files) / dt).toFixed(0);
              document.getElementById("dup-pstat-files-rate").textContent = fps + "/s";
            } else if (elapsed > 0) {
              document.getElementById("dup-pstat-files-rate").textContent = (files / elapsed).toFixed(0) + "/s";
            }
            lastPoll = { files: files, time: pollNow };

            // Size estimate
            var approxBytes = files * 512000;
            var sizeStr = "—";
            if (approxBytes > 1073741824) sizeStr = (approxBytes / 1073741824).toFixed(1) + " GB";
            else if (approxBytes > 1048576) sizeStr = (approxBytes / 1048576).toFixed(0) + " MB";
            else sizeStr = (approxBytes / 1024).toFixed(0) + " KB";
            document.getElementById("dup-pstat-size").textContent = sizeStr;

            var mins = Math.floor(elapsed / 60);
            var secs = elapsed % 60;
            document.getElementById("dup-progress-elapsed").textContent =
              (mins > 0 ? mins + "m " : "") + secs + "s";

            if (pp.current_dir) {
              document.getElementById("dup-progress-dir").textContent = pp.current_dir;
            }

            if (!pp.is_running) {
              await sleep(500);
              break;
            }
          }

          dupProgress.style.display = "none";

          // Get results
          try {
            var dupResultsArr = await window.__TAURI__.invoke("get_duplicate_results");
            if (dupResultsArr && dupResultsArr.length > 0) {
              renderDupResults(dupResultsArr);
            } else {
              dupStatus.style.display = "block";
              dupStatus.textContent = "No duplicate files found.";
            }
          } catch (e) {
            dupStatus.style.display = "block";
            dupStatus.textContent = "Error: " + e.message;
          }
        } catch (err) {
          dupProgress.style.display = "none";
          dupStatus.style.display = "block";
          dupStatus.textContent = "Error: " + err;
          dupStatus.style.color = "var(--accent-red)";
        }
      });

      function renderDupResults(groups) {
        dupResults.style.display = "block";
        dupDiagramWrap.style.display = "block";

        var totalDups = 0;
        var totalWasted = 0;
        groups.forEach(function (g) { totalDups += g.count; totalWasted += g.size * (g.count - 1); });
        dupSummary.textContent =
          groups.length + " group" + (groups.length === 1 ? "" : "s") +
          " (" + totalDups + " files, " + fmtBytesDup(totalWasted) + " wasted)";

        // Stats
        dupStats.style.display = "flex";
        document.getElementById("dup-stat-groups").textContent = groups.length;
        document.getElementById("dup-stat-files").textContent = totalDups;
        document.getElementById("dup-stat-wasted").textContent = fmtBytesDup(totalWasted);

        var html = "";
        groups.forEach(function (g) {
          html += "<tr>";
          html += "<td>" + g.size_human + "</td>";
          html += "<td>" + g.count + "</td>";
          html += "<td>";
          g.files.forEach(function (f) {
            html +=
              '<span class="dup-file-item" data-path="' +
              escapeAttr(f) +
              '">' +
              escapeHtml(f) +
              "</span>";
          });
          html += "</td>";
          // Delete button (trash icon)
          html += '<td><button class="icon-btn dup-del-btn" style="font-size:14px;padding:4px 6px" data-path="' +
            escapeAttr(g.files[0]) + '" title="Delete first file in group">🗑</button></td>';
          html += "</tr>";
        });
        dupBody.innerHTML = html;

        // Click handler for file items → show context menu
        dupBody.querySelectorAll(".dup-file-item").forEach(function (el) {
          el.addEventListener("click", function (e) {
            var p = this.getAttribute("data-path");
            if (p && dupCtx) {
              dupCtxPath = p;
              dupCtx.style.display = "block";
              dupCtx.style.left = Math.min(e.clientX, window.innerWidth - 200) + "px";
              dupCtx.style.top = Math.min(e.clientY, window.innerHeight - 200) + "px";
            }
          });
        });

        // Delete button handler
        dupBody.querySelectorAll(".dup-del-btn").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            var p = this.getAttribute("data-path");
            if (!p || !confirm("Delete this file?\n" + p)) return;
            try {
              await window.__TAURI__.invoke("delete_path", { path: p });
              document.querySelector(".status-bar").textContent = "Deleted: " + p;
              btnDup.click();
            } catch (e) {
              alert("Delete failed: " + e.message);
            }
          });
        });

        // Small pie chart for top groups
        var canvas = document.getElementById("dup-diagram");
        if (canvas) {
          canvas.width = canvas.parentElement.clientWidth || 400;
          canvas.height = 120;
          var ctx = canvas.getContext("2d");
          var top = groups.slice(0, 10);
          var total = top.reduce(function (s, g) { return s + g.size; }, 0) || 1;
          var colors = ["#0078d4","#e74856","#ff8c00","#ffaa00","#00cc6a","#0099bc","#8764b8","#881798","#00b7c3","#6b69d6"];
          var cx = 60, cy = 60, r = 50;
          var startAngle = -Math.PI / 2;
          top.forEach(function (g, i) {
            var angle = (g.size / total) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, r, startAngle, startAngle + angle);
            ctx.closePath();
            ctx.fillStyle = colors[i % colors.length];
            ctx.fill();
            startAngle += angle;
          });
          var lx = 130, ly = 10;
          top.forEach(function (g, i) {
            if (i >= 5) return;
            ctx.fillStyle = colors[i % colors.length];
            ctx.fillRect(lx, ly + i * 22, 10, 10);
            ctx.fillStyle = "#e0e0e0";
            ctx.font = "10px sans-serif";
            ctx.fillText(g.size_human + " " + g.count + "x", lx + 14, ly + i * 22 + 9);
          });
        }
      }

      function escapeHtml(s) {
        return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
      }
      function escapeAttr(s) {
        return String(s).replace(/"/g,"&quot;").replace(/&/g,"&amp;");
      }
    })();

    // ── Drag & Drop on scan path ──────────────────────────
    scanPath.addEventListener("dragover", function (e) {
      e.preventDefault();
      e.stopPropagation();
      scanPath.classList.add("drag-over");
    });
    scanPath.addEventListener("dragenter", function (e) {
      e.preventDefault();
      e.stopPropagation();
      scanPath.classList.add("drag-over");
    });
    scanPath.addEventListener("dragleave", function (e) {
      e.preventDefault();
      e.stopPropagation();
      scanPath.classList.remove("drag-over");
    });
    scanPath.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      scanPath.classList.remove("drag-over");
      var files = e.dataTransfer.files;
      if (files && files.length > 0) {
        var droppedPath = files[0].path;
        if (droppedPath) {
          scanPath.value = droppedPath;
          document.querySelector(".status-bar").textContent =
            "Dropped: " + droppedPath;
          setTimeout(function () { btnScan.click(); }, 100);
        }
      }
    });

    // ── Ctrl+C Clipboard ───────────────────────────────────
    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
        // Don't intercept if user is typing in an input/textarea/select
        var tag = document.activeElement && document.activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

        if (
          treeView.selectedIndex !== null &&
          treeView.selectedIndex !== undefined
        ) {
          var path = treeView._buildPath(treeView.selectedIndex);
          if (path) {
            e.preventDefault();
            navigator.clipboard.writeText(path).then(function () {
              document.querySelector(".status-bar").textContent =
                "Copied: " + path;
            }).catch(function () {
              // Clipboard write may fail; ignore silently
            });
          }
        }
      }
    });

    scanPath.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btnScan.click();
    });

    // ── Initialize modules ─────────────────────────────────
    (function initModules() {
      var modules = window.DiskRaptorModules || {};
      var moduleKeys = Object.keys(modules);
      if (moduleKeys.length === 0) return;

      // Create a module container in the detail panel, after topfiles-card
      var detailPanel = document.getElementById("detail-panel");
      var topfilesCard = document.getElementById("topfiles-card");
      if (!detailPanel || !topfilesCard) return;

      var modContainer = document.createElement("div");
      modContainer.id = "modules-container";
      modContainer.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:8px";
      detailPanel.insertBefore(modContainer, topfilesCard.nextSibling);

      moduleKeys.forEach(function (key) {
        var ModuleClass = modules[key];
        try {
          var instance = new ModuleClass();
          var panel = instance.createPanel();
          if (panel) {
            panel.dataset.module = key;
            modContainer.appendChild(panel);
            // Wire up the Run button
            var runBtn = panel.querySelector(".module-run-btn");
            if (runBtn) {
              runBtn.addEventListener("click", function () {
                instance.run(loader, scanPath.value);
              });
            }
            // Show the panel (they default to display:none)
            panel.style.display = "block";
          }
          console.log("[Modules] Initialized:", key);
        } catch (e) {
          console.warn("[Modules] Failed to init", key, e);
        }
      });
    })();

    console.log("DiskRaptor ready.");
  }

  function drawPerfGraph() {
    var canvas = document.getElementById("perf-graph");
    if (!canvas || !window._perfData || window._perfData.length < 2) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    var data = window._perfData;
    var maxVal = 1;
    for (var di = 0; di < data.length; di++) {
      if (data[di].fps > maxVal) maxVal = data[di].fps;
      if (data[di].dps > maxVal) maxVal = data[di].dps;
    }
    maxVal = Math.ceil(maxVal * 1.1);

    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (var gy = 0; gy < 4; gy++) {
      var yy = (gy / 4) * h;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }

    // FPS line (accent blue)
    ctx.strokeStyle = "#58a6ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var fi = 0; fi < data.length; fi++) {
      var fx = (fi / data.length) * w;
      var fy = h - (data[fi].fps / maxVal) * h;
      if (fi === 0) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    }
    ctx.stroke();

    // DPS line (green)
    ctx.strokeStyle = "#3fb950";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (var di2 = 0; di2 < data.length; di2++) {
      var dx = (di2 / data.length) * w;
      var dy = h - (data[di2].dps / maxVal) * h;
      if (di2 === 0) ctx.moveTo(dx, dy);
      else ctx.lineTo(dx, dy);
    }
    ctx.stroke();

    // Current values on the right edge
    var last = data[data.length - 1];
    ctx.fillStyle = "#58a6ff";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText(Math.round(last.fps) + "/s", w - 4, 12);
    ctx.fillStyle = "#3fb950";
    ctx.fillText(Math.round(last.dps) + "/s", w - 4, 24);
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  // ── Update check ───────────────────────────────────────
  async function checkForUpdates() {
    var overlay = document.getElementById("update-overlay");
    var versionEl = document.getElementById("update-version");
    var statusEl = document.getElementById("update-status");
    var actionsEl = document.getElementById("update-actions");
    var progressEl = document.getElementById("update-progress");
    var dlBtn = document.getElementById("btn-update-download");
    var closeBtn = document.getElementById("btn-update-close");

    if (!overlay || !window.__TAURI__ || !window.__TAURI__.invoke) return;
    actionsEl.style.display = "flex";
    progressEl.style.display = "none";
    statusEl.textContent = "Checking for updates…";
    versionEl.textContent = "";
    overlay.classList.add("active");

    try {
      var latestTag = await window.__TAURI__.invoke("check_for_updates");
      versionEl.textContent = "Latest: " + latestTag;
      statusEl.textContent = "A new version is available!";
      dlBtn.onclick = async function () {
        actionsEl.style.display = "none";
        progressEl.style.display = "block";
        statusEl.textContent = "Downloading…";
        try {
          await window.__TAURI__.invoke("download_and_install", { version: latestTag });
        } catch (e) {
          statusEl.textContent = "Download failed: " + e;
          actionsEl.style.display = "flex";
          progressEl.style.display = "none";
        }
      };
    } catch (e) {
      statusEl.textContent = "No update available or could not check.";
      versionEl.textContent = "";
    }
    closeBtn.onclick = function () { overlay.classList.remove("active"); };
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.classList.remove("active");
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
