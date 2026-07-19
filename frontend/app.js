/**
 * DiskRaptor - Main application controller.
 */
(function () {
  "use strict";

  async function init() {
    console.log("DiskRaptor booting...");
    var statusBar = document.querySelector(".status-bar");

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
      setTimeout(() => reject(new Error("Tauri bridge timeout")), 30000),
    );

    if (statusBar) statusBar.textContent = "Connecting to backend...";
    try {
      await Promise.race([bridgeReady, timeout]);
      if (statusBar) statusBar.textContent = "Backend connected";
    } catch (err) {
      console.error("Tauri backend not connected:", err);
      if (statusBar)
        statusBar.textContent = "Backend not connected. " + err.message;
      return;
    }

    if (!window.__TAURI__ || typeof window.__TAURI__.invoke !== "function") {
      console.error("Tauri invoke still unavailable");
      return;
    }

    console.log("DiskRaptor initializing...");

    // ── Settings helpers ───────────────────────────────────
    async function getSetting(key, fallback) {
      try {
        var r = await window.__TAURI__.invoke("load_settings");
        if (r && r[key] !== undefined) return r[key];
      } catch {}
      return fallback;
    }
    async function setSetting(key, val) {
      try {
        var o = {}; o[key] = val;
        await window.__TAURI__.invoke("save_settings", o);
      } catch {}
    }

    // ── Theme toggle ───────────────────────────────────────
    var btnTheme = document.getElementById("btn-theme");
    getSetting("theme", "auto").then(function(savedTheme) {
      var isLight = false;
      if (savedTheme === "light") {
        isLight = true;
      } else if (savedTheme === "auto" || savedTheme === "dark") {
        isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      }
      if (isLight) {
        document.body.classList.add("light-theme");
        btnTheme.textContent = "\u2600";
        btnTheme.title = "Switch to dark mode";
      }
    });
    getSetting("language", "auto").then(function(savedLang) {
      if (savedLang && savedLang !== "auto" && window.I18N) {
        window.I18N.setLocale(savedLang);
      }
    });
    btnTheme.addEventListener("click", function () {
      var isLight = document.body.classList.toggle("light-theme");
      setSetting("theme", isLight ? "light" : "dark");
      btnTheme.textContent = isLight ? "\u2600" : "\u263E";
      btnTheme.title = isLight ? "Switch to dark mode" : "Switch to light mode";
    });

    const loader = new ChunkLoader();
    window.__loader = loader;
    const treeView = new TreeView("tree-viewport", loader);
    window.__treeView = treeView;

    // ── Column resize ────────────────────────────────────
    (function() {
      var dragCol = null, startX = 0, startW = 0;
      document.addEventListener("mousedown", function(e) {
        var handle = e.target.closest(".col-resize");
        if (!handle) return;
        dragCol = handle.parentElement;
        startX = e.clientX;
        startW = parseInt(dragCol.style.width) || dragCol.offsetWidth;
        e.preventDefault();
      });
      document.addEventListener("mousemove", function(e) {
        if (!dragCol) return;
        var w = Math.max(40, startW + (e.clientX - startX));
        dragCol.style.width = w + "px";
        dragCol.style.flex = "none";
        // Update matching data cells
        var colIdx = Array.from(dragCol.parentElement.children).indexOf(dragCol);
        if (colIdx >= 0) {
          document.querySelectorAll(".tree-row").forEach(function(row) {
            var cell = row.children[colIdx];
            if (cell) cell.style.width = (w - 8) + "px";
          });
        }
      });
      document.addEventListener("mouseup", function() {
        dragCol = null;
      });
    })();
    const topFiles = new TopFilesPanel();
    const statsPanel = new StatsPanel();
    const diagram = new DiagramRenderer("diagram-container");
    window.__diagram = diagram;

    let isScanning = false;
    let currentStats = null;
    let currentScanResult = null;

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

    // Set default scan path to user home after init and DOM binding.
    try {
      var home = await window.__TAURI__.invoke("get_home_dir");
      var homePath = null;
      if (typeof home === "string") {
        homePath = home;
      } else if (home && typeof home === "object") {
        // Handle wrapped response format
        homePath = home.data ? String(home.data) : null;
      }
      if (homePath && scanPath && !scanPath.value) {
        scanPath.value = homePath;
      }
    } catch (e) {
      console.warn("get_home_dir failed:", e && e.message ? e.message : e);
    }

    // Galaxy view state
    var galaxyView = null;
    var galaxyContainer = document.getElementById("galaxy-container");
    var diagramContainer = document.getElementById("diagram-container");
    var isGalaxyMode = false;

    // Lazy-load galaxy scripts only when galaxy mode is first activated
    function loadGalaxyScripts(callback) {
      if (window.GalaxyView && window.GalaxyView.GalaxyView) {
        callback();
        return;
      }
      var scripts = [
        "galaxyview/config.js",
        "galaxyview/spatial-index.js",
        "galaxyview/data-mapper.js",
        "galaxyview/animation.js",
        "galaxyview/effects.js",
        "galaxyview/interaction.js",
        "galaxyview/lod.js",
        "galaxyview/timeline.js",
        "galaxyview/live-scan.js",
        "galaxyview/insights.js",
        "galaxyview/plugin-api.js",
        "galaxyview.js",
      ];
      var loaded = 0;
      function onLoad() {
        loaded++;
        if (loaded === scripts.length) callback();
      }
      for (var i = 0; i < scripts.length; i++) {
        var s = document.createElement("script");
        s.src = scripts[i];
        s.onload = onLoad;
        s.onerror = onLoad; // Continue even if one fails
        document.head.appendChild(s);
      }
    }

    function _feedGalaxyView() {
      if (!galaxyView || !currentStats) return;
      var scanResult = currentScanResult || currentStats;
      var topFiles = (currentStats && currentStats.top_files) || [];
      try {
        galaxyView.loadData(scanResult, currentStats, topFiles, []);
      } catch (e) {
        console.error("GalaxyView load failed:", e);
      }
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
              // Lazy-load galaxy scripts first time
              loadGalaxyScripts(function() {
                try {
                  if (!window.GalaxyView || !window.GalaxyView.GalaxyView) {
                    throw new Error("Galaxy scripts not loaded");
                  }
                  galaxyContainer.style.minHeight = "400px";
                  galaxyView = new GalaxyView.GalaxyView(galaxyContainer);
                  galaxyView.init();
                  galaxyView._resize();
                  if (galaxyView) {
                    galaxyView.show();
                    _feedGalaxyView();
                  }
                } catch (e) {
                  console.error("GalaxyView init failed:", e);
                  galaxyView = null;
                }
              });
            } else {
              galaxyView._resize();
              galaxyView.show();
              _feedGalaxyView();
            }
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
            setSetting("language", code);
            langMenu.classList.remove("active");
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

    // Progress i18n is handled by the static labels in the HTML
    window.addEventListener("locale-changed", function () {
      // Metrics use icons + short labels — no i18n needed
    });

    // ── Drive Selector Dropdown ────────────────────────────
    var btnDrive = document.getElementById("btn-drive");
    var driveMenu = document.getElementById("drive-menu");
    var driveSelected = document.getElementById("drive-selected");

    // Toggle dropdown
    btnDrive.addEventListener("click", function(e) {
      e.stopPropagation();
      driveMenu.classList.toggle("active");
      if (driveMenu.classList.contains("active")) {
        loadDrives();
      }
    });
    // Close on outside click
    document.addEventListener("click", function(e) {
      if (!e.target.closest(".drive-dropdown-wrap")) {
        driveMenu.classList.remove("active");
      }
    });

    async function loadDrives() {
      try {
        var drivesRaw = await window.__TAURI__.invoke("list_drives");
        var drives = typeof drivesRaw === "string" ? JSON.parse(drivesRaw) : drivesRaw;
        if (!drives || drives.length === 0) return;

        function driveIcon(type, path) {
          if (path === "/") return "🖥️";
          switch(type) {
            case "system": return "🖥️";
            case "usb": return "💾";
            case "dvd": return "💿";
            case "ram": return "⚡";
            case "local": return path && path.startsWith("/") ? "💽" : "🖥️";
            default: return "💽";
          }
        }
        function formatSize(bytes) {
          if (!bytes || bytes === 0) return "0 B";
          var units = ["B","KB","MB","GB","TB"];
          var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
          var v = bytes / Math.pow(1024, i);
          return v.toFixed(1) + " " + units[i];
        }

        var html = "";
        for (var i = 0; i < drives.length; i++) {
          var d = drives[i];
          var path = d.path || "";
          var isRoot = path === "/" || path === "/System/Volumes/Data";
          var type = d.type || "local";
          // On macOS, use volume name or last path component
          var isWin = path.indexOf(":") >= 0;
          var label;
          if (isWin) {
            label = path.replace(":\\", "").replace(":/", "") + ":";
          } else {
            // macOS/Linux: use name if available, else last path component
            label = d.name || path;
            if (path === "/" && navigator.platform === "MacIntel") label = "Macintosh HD";
            if (path === "/" && navigator.platform !== "MacIntel") label = "/ (Root)";
          }
          var name = d.name || label;
          var total = d.totalBytes || 0;
          var used = d.usedBytes || 0;
          var pct = d.percentFull !== undefined ? Math.round(d.percentFull) :
                    (total > 0 ? Math.round((used/total)*100) : 0);
          var free = d.freeBytes || 0;
          var icon = driveIcon(type, path);
          // Highlight active drive
          var curPath = scanPath.value;
          var isActive = isWin
            ? curPath.toUpperCase().startsWith(label.toUpperCase())
            : curPath === path || curPath.startsWith(path + "/");
          html += '<div class="drive-item' + (isActive ? ' active' : '') + '" data-path="' + path + '">' +
            '<span class="drive-icon">' + icon + '</span>' +
            '<div class="drive-info">' +
              '<div class="drive-info-top">' +
                '<span class="drive-label">' + label + '</span>' +
                '<span class="drive-name">' + name + '</span>' +
              '</div>' +
              '<div class="drive-bar-row">' +
                '<div class="drive-bar-wrap"><div class="drive-bar-fill" style="width:' + pct + '%"></div></div>' +
                '<span class="drive-pct">' + pct + '%</span>' +
              '</div>' +
              '<span class="drive-size">' + formatSize(free) + ' free / ' + formatSize(total) + '</span>' +
            '</div>' +
          '</div>';
        }
        driveMenu.innerHTML = html;
        driveMenu.querySelectorAll(".drive-item").forEach(function(el) {
          el.addEventListener("click", function() {
            driveMenu.querySelectorAll(".drive-item").forEach(function(e) { e.classList.remove("active"); });
            el.classList.add("active");
            var p = el.dataset.path;
            scanPath.value = p;
            driveSelected.textContent = p;
            driveMenu.classList.remove("active");
          });
        });
        // Auto-select first real drive if none is active
        var hasActive = driveMenu.querySelector(".drive-item.active");
        if (!hasActive) {
          var firstItem = driveMenu.querySelector(".drive-item");
          if (firstItem) {
            var p = firstItem.dataset.path;
            if (scanPath.value) {
              driveSelected.textContent = scanPath.value;
            } else {
              scanPath.value = p;
              driveSelected.textContent = p;
            }
          }
        }
      } catch (e) { console.warn("Drive load:", e); }
    }

    // Load drives on startup (without opening menu)
    loadDrives();

    // Browse
    btnBrowse.addEventListener("click", async function () {
      try {
        var selected = await window.__TAURI__.invoke("pick_directory");
        var dir = null;
        if (typeof selected === "string" && selected.length > 0) {
          dir = selected;
        } else if (selected && typeof selected === "object" && selected.data) {
          dir = String(selected.data);
        }
        if (dir) {
          scanPath.value = dir;
          document.querySelector(".status-bar").textContent =
            "Selected: " + dir;
        }
      } catch (err) {
        // If dialog fails (e.g. headless), focus the input for manual entry
        document.querySelector(".status-bar").textContent =
          "Click to type path manually";
        document.getElementById("scan-path").focus();
        document.getElementById("scan-path").select();
      }
    });

    // ── Follow symlinks toggle ──
    var chkFollow = document.getElementById("chk-follow-symlinks");
    if (!chkFollow) {
      chkFollow = document.createElement("label");
      chkFollow.id = "chk-follow-symlinks";
      chkFollow.className = "symlink-toggle";
      chkFollow.innerHTML = '<input type="checkbox"> Follow symlinks';
      btnScan.parentNode.insertBefore(chkFollow, btnScan);
    }

    // ── Error display ──
    var errDisplay = document.getElementById("scan-errors");
    if (!errDisplay) {
      errDisplay = document.createElement("div");
      errDisplay.id = "scan-errors";
      errDisplay.className = "scan-errors";
      errDisplay.style.display = "none";
      document.getElementById("progress-overlay").appendChild(errDisplay);
    }

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
      var followLinks = chkFollow.querySelector("input").checked;

      var safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
      }, 1200000);

      // Progress elements (new rich layout)
      var progressFilesEl = document.getElementById("progress-files");
      var progressDirsEl = document.getElementById("progress-dirs");
      var progressSpeedValEl = document.getElementById("progress-speed-val");
      var progressElapsedValEl = document.getElementById("progress-elapsed-val");
      var progressDirEl = document.getElementById("progress-dir");
      var speedChartCanvas = document.getElementById("speed-chart");
      var speedChartCtx = speedChartCanvas ? speedChartCanvas.getContext("2d") : null;
      var speedSamples = [];
      var maxSamples = 40;

      function formatBytesPerSec(bps) {
        if (bps <= 0) return "0 MB/s";
        var mbps = bps / (1024 * 1024);
        return mbps.toFixed(mbps < 10 ? 2 : 1) + " MB/s";
      }

      function speedColor(ratio) {
        if (ratio > 0.8) return "#f85149";  // red (peak)
        if (ratio > 0.4) return "#3fb950";  // green (normal)
        return "#d29922";  // yellow (low)
      }

      function drawSpeedChart() {
        if (!speedChartCtx) return;
        var w = speedChartCanvas.width;
        var h = speedChartCanvas.height;
        var ctx = speedChartCtx;
        ctx.clearRect(0, 0, w, h);
        if (speedSamples.length < 2) return;
        var maxBps = Math.max.apply(null, speedSamples.map(function(s){return s.bps})) || 1;
        var pad = 4;
        var cw = w - pad * 2;
        var ch = h - pad * 2;
        var step = cw / Math.max(speedSamples.length - 1, 1);

        // Draw filled area with gradient colors
        for (var si = 0; si < speedSamples.length; si++) {
          var sx = pad + si * step;
          var sy = pad + ch - (speedSamples[si].bps / maxBps) * ch;
          var ratio = speedSamples[si].bps / maxBps;
          ctx.fillStyle = speedColor(ratio);
          ctx.globalAlpha = 0.15;
          ctx.fillRect(sx - step/2, sy, step, h - pad - sy);
        }
        ctx.globalAlpha = 1;

        // Draw speed line with segment colors (thicker, smoother)
        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur = 3;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        for (var si = 0; si < speedSamples.length - 1; si++) {
          var sx1 = pad + si * step;
          var sy1 = pad + ch - (speedSamples[si].bps / maxBps) * ch;
          var sx2 = pad + (si + 1) * step;
          var sy2 = pad + ch - (speedSamples[si+1].bps / maxBps) * ch;
          var ratio = (speedSamples[si].bps + speedSamples[si+1].bps) / 2 / maxBps;
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.strokeStyle = speedColor(ratio);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;

        // Center: MB/s large green, f/s smaller below
        var current = speedSamples[speedSamples.length - 1];
        if (current) {
          var cx = w / 2;
          var cy = h / 2;
          var mbps = current.bps / (1024 * 1024);
          var mbColor = mbps > 100 ? "#3fb950" : mbps > 30 ? "#d29922" : "#e6edf3";
          ctx.fillStyle = mbColor;
          ctx.shadowColor = "rgba(0,0,0,0.7)";
          ctx.shadowBlur = 6;
          ctx.font = "bold 28px monospace";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(formatBytesPerSec(current.bps), cx, cy - 8);
          ctx.fillStyle = "#e6edf3";
          ctx.shadowBlur = 3;
          ctx.font = "bold 11px monospace";
          ctx.fillText(Math.round(current.fps).toLocaleString() + " files/sec", cx, cy + 18);
          ctx.shadowBlur = 0;
        }

        // Peak labels top-right
        ctx.shadowBlur = 3;
        ctx.fillStyle = "#f85149";
        ctx.font = "10px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("peak " + formatBytesPerSec(maxBps), w - pad, pad);
        ctx.fillStyle = "#8b949e";
        ctx.shadowBlur = 0;
      }

      progressOverlay.classList.add("active");
      progressPath.textContent = "Scanning: " + path;

      // Reset progress display
      progressFilesEl.textContent = "0";
      progressDirsEl.textContent = "0";
      progressSpeedValEl.textContent = "";
      progressElapsedValEl.textContent = "0s";
      progressDirEl.textContent = "";
      speedSamples = [];

      try {
        var initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
          follow_symlinks: followLinks,
          timeout_secs: 30,
        });
        // Check for error response (e.g. "Rust scanner not loaded")
        if (initScan && initScan.error) {
          throw new Error(initScan.error);
        }
        // Handle optional scan_id — bridge may or may not return one
        var scanId = (initScan && initScan.scan_id) || 1;

        // Poll tracking
        var prevFilesFound = 0;
        var lastFilesFound = 0;
        var lastDirsFound = 0;
        var pollStartTime = Date.now();

        var done = false;
        var zeroCount = 0;
        for (var i = 0; i < 1200; i++) {
          await sleep(500);
          var p = await window.__TAURI__
            .invoke("get_scan_progress", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (!p) continue;

          // Show raw data for debugging if fields are missing
          var rawDisplay = document.getElementById("progress-raw");
          if (rawDisplay) {
            try { rawDisplay.textContent = "raw: " + JSON.stringify(p).substring(0, 150); } catch(e) {}
          }

          var filesFound = Number(p.files_found || p.filesFound || 0);
          var dirsFound = Number(p.dirs_found || p.dirsFound || 0);
          var bytesFound = Number(p.bytes_found || p.bytesFound || 0);
          var elapsedSecs = p.elapsed_secs || p.elapsedSecs || 0;

          // Track consecutive zero counts
          if (filesFound === 0 && dirsFound === 0) {
            zeroCount++;
            if (zeroCount === 10) { // 5 seconds of no progress
              console.warn("Scan showing 0 files after 5s, raw:", JSON.stringify(p).substring(0, 200));
              if (rawDisplay) rawDisplay.style.display = "block";
            }
          } else {
            zeroCount = 0;
          }

          // ── Update 3-icon metrics ──
          progressFilesEl.textContent = filesFound.toLocaleString("en-US");
          progressDirsEl.textContent = dirsFound.toLocaleString("en-US");

          var elapsedStr = "0s";
          if (elapsedSecs > 0) {
            var mins = Math.floor(elapsedSecs / 60);
            var secs = elapsedSecs % 60;
            elapsedStr = (mins > 0 ? mins + "m " : "") + secs + "s";
          }
          progressElapsedValEl.textContent = elapsedStr;

          // ── Speed (MB/s primary, files/sec secondary) ──
          if (elapsedSecs > 0 && filesFound > 0) {
            var filesPerSec = (filesFound / elapsedSecs);
            var bytesPerSec = (bytesFound / elapsedSecs);
            var mbPerSec = bytesPerSec / (1024 * 1024);
            progressSpeedValEl.textContent = mbPerSec.toFixed(mbPerSec < 10 ? 2 : 1) + " MB/s";
            progressSpeedValEl.style.color = mbPerSec > 100 ? "#3fb950" : mbPerSec > 30 ? "#d29922" : "#8b949e";
            // Track sample for chart
            speedSamples.push({fps: filesPerSec, bps: bytesPerSec});
            if (speedSamples.length > maxSamples) speedSamples.shift();
            drawSpeedChart();
          } else {
            progressSpeedValEl.textContent = "—";
            progressSpeedValEl.style.color = "#8b949e";
          }

          // ── Live stats panel update ──
          statsPanel.updateLive(filesFound, dirsFound, elapsedSecs);

          // ── Errors ──
          if (p.error_count > 0 && errDisplay) {
            var errMsg = p.last_error || "";
            errDisplay.textContent = "⚠ " + p.error_count + " permission denied — " + errMsg.substring(0, 80);
            errDisplay.style.display = "block";
          } else if (errDisplay) {
            errDisplay.style.display = "none";
          }

          // ── Current dir ──
          var dirInfo = "";
          if (p.current_dir || p.currentDir) {
            var dir = p.current_dir || p.currentDir;
            var parts = dir.split("\\");
            dirInfo = parts[parts.length - 1];
            progressDirEl.textContent = "📂 " + dirInfo;
          }

          prevFilesFound = filesFound;
          lastFilesFound = filesFound;
          lastDirsFound = dirsFound;

          // Check completion
          var isRunning = p.is_running !== undefined ? p.is_running : true;
          var isDone = p.phase === 3 || !isRunning;
          if (isDone) {
            await sleep(500);
            done = true;
            break;
          }
        }  // <-- end for-loop

        if (!done) throw new Error("Scan timeout");

        // Update progress to done state
        progressSpeedValEl.textContent = "✓";

        var result = null;
        // Try up to 5 times with 100ms delay (max 500ms) instead of 60x500ms
        for (var ri = 0; ri < 5; ri++) {
          result = await window.__TAURI__
            .invoke("get_scan_result", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (result && result.stats) break;
          await sleep(100);
        }
clearTimeout(safetyTimer);
        progressOverlay.classList.remove("active");

        if (result && result.stats && result.stats.total_files > 0) {
          currentScanResult = result;
          currentStats = result.stats;
          statsPanel.render(result.stats);
          diagram.setData(result.stats);
          var files = Number(result.stats.total_files || 0).toLocaleString("en-US");
          var dirs = Number(result.stats.total_dirs || 0).toLocaleString("en-US");
          document.querySelector(".status-bar").textContent =
            "Complete - " + files + " files, " + dirs + " dirs";
          topFiles.render(result.stats ? result.stats.top_files : [], true);
        } else {
          // Fallback: use last known progress data
          progressElapsedValEl.textContent = statsPanel._formatDuration(Date.now() - pollStartTime);
          document.querySelector(".status-bar").textContent =
            "Complete - " + lastFilesFound.toLocaleString() + " files, " + lastDirsFound.toLocaleString() + " dirs";
          topFiles.render([], true);
        }

        // Load tree chunks sequentially after scan
        if (result && result.root_info && result.root_info.total_chunks > 0) {
          loader.totalNodes = result.root_info.total_nodes;
          loader.totalChunks = result.root_info.total_chunks;
          loader.allNodes = new Array(loader.totalNodes);
          loader.scanId = scanId;
          
          // Load first chunk immediately (root)
          try { await loader.loadChunk(0); } catch(e) { console.warn("Chunk 0:", e); }
          treeView.expanded.add(0);
          try { await treeView.rebuild(); } catch(e) {}
          
          // Load remaining chunks in background (no await - let UI breathe)
          (async function() {
            for (var ci = 1; ci < loader.totalChunks; ci++) {
              try { await loader.loadChunk(ci); } catch(e) {}
              if (ci % 10 === 0) {
                try { await treeView.rebuild(); } catch(e) {}
                await sleep(0); // yield to UI
              }
            }
            try { await treeView.rebuild(); } catch(e) {}
          })();
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

    // Cancel (toolbar + progress overlay)
    btnCancel.addEventListener("click", async function () {
      await loader.release();
      isScanning = false;
      btnScan.disabled = false;
      btnCancel.disabled = true;
      progressOverlay.classList.remove("active");
      document.querySelector(".status-bar").textContent = "Cancelled";
    });
    var progressCancelBtn = document.getElementById("progress-cancel");
    if (progressCancelBtn) {
      progressCancelBtn.addEventListener("click", function() {
        btnCancel.click();
      });
    }

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

    // ── RAM status bar ──────────────────────────────────────
    var ramFill = document.getElementById("ram-bar-fill");
    var ramText = document.getElementById("ram-text");
    function formatBytes(v) {
      var u = ["B","KB","MB","GB","TB"];
      var i = 0;
      while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
      return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
    }
    async function updateRam() {
      try {
        var m = await window.__TAURI__.invoke("get_memory_info");
        if (m && m.percent_used !== undefined) {
          var pct = Math.round(m.percent_used);
          var used = formatBytes(m.used_bytes);
          var total = formatBytes(m.total_bytes);
          ramFill.style.width = pct + "%";
          ramFill.className = "ram-bar-fill" + (pct > 85 ? " critical" : pct > 70 ? " warning" : "");
          ramText.textContent = "RAM  " + used + " / " + total + "  (" + pct + "%)";
        }
      } catch(e) {}
    }
    updateRam();
    setInterval(updateRam, 3000);

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
