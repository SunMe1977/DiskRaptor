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
      if (savedTheme === undefined || savedTheme === null) savedTheme = "auto";
      var isLight = false;
      if (savedTheme === "auto") {
        isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
      } else if (savedTheme === "light") {
        isLight = true;
      } // else "dark" → isLight stays false
      if (isLight) {
        document.body.classList.add("light-theme");
        btnTheme.textContent = "\u2600";
        btnTheme.title = "Switch to dark mode";
      } else {
        document.body.classList.remove("light-theme");
        btnTheme.textContent = "\u263E";
        btnTheme.title = "Switch to light mode";
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

    // Wire zoom buttons
    diagram.onZoomChanged = function(zoom) {
      var label = document.getElementById('zoom-label');
      if (label) label.textContent = Math.round(zoom * 100) + '%';
      var btns = document.querySelectorAll('.zoom-btn');
      btns.forEach(function(b) {
        var z = b.dataset.zoom;
        if (z === 'fit') return;
        b.classList.toggle('active', Math.abs(Number(z) - zoom) < 0.01);
      });
    };
    document.querySelectorAll('.zoom-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var z = this.dataset.zoom;
        document.querySelectorAll('.zoom-btn').forEach(function(b) { b.classList.remove('active'); });
        this.classList.add('active');
        diagram.setZoom(z);
      });
    });

    // ── Welcome placeholder ──────────────────────────────
    var welcomeEl = document.getElementById("welcome-placeholder");
    var welcomeClose = document.getElementById("welcome-close");
    var welcomeScanBtn = document.getElementById("welcome-scan-btn");
    var welcomeBrowseBtn = document.getElementById("welcome-browse-btn");
    var welcomeAboutBtn = document.getElementById("welcome-about-btn");

    function hideWelcome() {
      if (welcomeEl) welcomeEl.classList.add("hidden");
    }
    function showWelcome() {
      if (welcomeEl) welcomeEl.classList.remove("hidden");
    }

    if (welcomeClose) {
      welcomeClose.addEventListener("click", hideWelcome);
    }

    // Welcome Start Scan button — scans home directory
    if (welcomeScanBtn) {
      welcomeScanBtn.addEventListener("click", function() {
        window.__TAURI__.invoke("get_home_dir").then(function(home) {
          var path = typeof home === "string" ? home : (home?.data || "");
          if (path && scanPath) {
            scanPath.value = path;
          }
          if (btnScan) btnScan.click();
        }).catch(function() {
          if (btnScan) btnScan.click();
        });
      });
    }

    // Welcome Browse button
    if (welcomeBrowseBtn) {
      welcomeBrowseBtn.addEventListener("click", function() {
        if (btnBrowse) btnBrowse.click();
      });
    }



    // Welcome About button
    if (welcomeAboutBtn) {
      welcomeAboutBtn.addEventListener("click", function() {
        var ov = document.getElementById("about-overlay");
        if (ov) ov.classList.add("active");
      });
    }

    let isScanning = false;
    let currentStats = null;
    let currentScanResult = null;
    let currentScanId = 0;
    let lastFilesFound = 0;
    let lastDirsFound = 0;

    // ── Collapsible detail cards ─────────────────────────
    document.querySelectorAll(".collapsible .card-header").forEach(function(h) {
      h.addEventListener("click", function() {
        var card = this.closest(".collapsible");
        if (card) card.classList.toggle("collapsed");
      });
    });

    loader.onProgress = (loaded, total) => {
      const el = document.querySelector("#tree-panel .status-bar");
      if (el) el.textContent = "Loading chunks... " + loaded + "/" + total;
    };

    treeView.onSelect = function () {};

    // DOM refs
    var scanPath = document.getElementById("scan-path");
    var btnBrowse = document.getElementById("btn-browse");
    var btnScan = document.getElementById("btn-scan");
    var btnRescan = document.getElementById("btn-rescan");
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
        // Check if it's JSON-wrapped
        if (home.charAt(0) === '{') {
          try { var j = JSON.parse(home); if (j && j.data) homePath = String(j.data); } catch(e) {}
        }
        if (!homePath) homePath = home;
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

    // ── Favorites/Bookmarked directories ─────────────────
    var btnFav = document.getElementById("btn-fav");
    var favMenu = document.getElementById("fav-menu");
    var favorites = [];

    async function loadFavorites() {
      try {
        var s = await window.__TAURI__.invoke("load_settings", {});
        if (s && s.favorites) favorites = s.favorites;
      } catch(e) {}
    }
    async function saveFavorites() {
      await window.__TAURI__.invoke("save_settings", { favorites: favorites }).catch(function(){});
    }
    function renderFavorites() {
      if (!favMenu) return;
      if (favorites.length === 0) {
        favMenu.classList.remove("active");
        return;
      }
      var html = "";
      for (var fi = 0; fi < favorites.length; fi++) {
        var f = favorites[fi];
        html += '<div class="fav-item" data-path="' + f.replace(/"/g, "&quot;") + '"><span>📌</span><span style="overflow:hidden;text-overflow:ellipsis;">' + f + '</span><span class="fav-del" data-idx="' + fi + '">✕</span></div>';
      }
      favMenu.innerHTML = html;
    }
    loadFavorites().then(renderFavorites);

    if (btnFav && favMenu) {
      btnFav.addEventListener("click", function(e) {
        e.stopPropagation();
        var path = scanPath.value.trim();
        if (!path) return;
        // Toggle bookmark
        var idx = favorites.indexOf(path);
        if (idx >= 0) {
          favorites.splice(idx, 1);
          btnFav.textContent = "☆";
        } else {
          favorites.push(path);
          btnFav.textContent = "★";
        }
        saveFavorites();
        renderFavorites();
      });
      // Show favorites dropdown on focus
      scanPath.addEventListener("focus", function() {
        renderFavorites();
        if (favorites.length > 0) favMenu.classList.add("active");
      });
      scanPath.addEventListener("blur", function() {
        setTimeout(function() { favMenu.classList.remove("active"); }, 200);
      });
      favMenu.addEventListener("click", function(e) {
        var item = e.target.closest(".fav-item");
        var del = e.target.closest(".fav-del");
        if (del) {
          var idx = parseInt(del.dataset.idx);
          if (!isNaN(idx) && idx >= 0 && idx < favorites.length) {
            favorites.splice(idx, 1);
            saveFavorites();
            renderFavorites();
            if (favorites.length === 0) favMenu.classList.remove("active");
          }
          return;
        }
        if (item) {
          var path = item.dataset.path;
          if (path && scanPath) {
            scanPath.value = path;
            favMenu.classList.remove("active");
          }
        }
      });
      document.addEventListener("click", function() {
        favMenu.classList.remove("active");
      });
      // Update star state when path changes
      scanPath.addEventListener("input", function() {
        btnFav.textContent = favorites.indexOf(scanPath.value.trim()) >= 0 ? "★" : "☆";
      });
    }

    // ── Volume stats on welcome page ─────────────────────
    (async function() {
      try {
        var vols = await window.__TAURI__.invoke("get_volume_stats", {});
        var container = document.getElementById("welcome-volumes");
        if (!container) return;
        if (!vols || vols.length === 0) {
          container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;">No volumes detected</div>';
          return;
        }
        var html = '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:600;display:flex;align-items:center;gap:8px;">💾 Drives<span id="refresh-volumes" style="font-size:11px;cursor:pointer;color:var(--text-muted);font-weight:400;">↻ refresh</span></div>';
        var shown = 0;
        for (var vi = 0; vi < vols.length && shown < 10; vi++) {
          var v = vols[vi];
          if (!v.total_bytes && !v.name && !v.path) continue;
          var pct = Math.min(100, Math.max(0, v.usage_pct || 0));
          var color = pct > 90 ? "#f85149" : pct > 70 ? "#d29922" : "#3fb950";
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:var(--bg-tertiary);margin-bottom:4px;">';
          html += '<span style="font-size:14px;">💽</span>';
          html += '<span style="flex:1;font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (v.name || v.path || "Drive") + '</span>';
          html += '<div style="width:80px;height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;"><div style="width:' + pct + '%;height:100%;background:' + color + ';border-radius:3px;"></div></div>';
          html += '<span style="font-size:11px;color:var(--text-secondary);font-family:var(--font-mono);white-space:nowrap;">' + (v.used_human || (v.total_bytes ? "0 B" : "")) + (v.total_human ? ' / ' + v.total_human : '') + '</span>';
          html += '</div>';
          shown++;
        }
        if (vols.length > 10) {
          html += '<div style="font-size:10px;color:var(--text-muted);text-align:center;padding:4px;">+ ' + (vols.length - 10) + ' more</div>';
        }
        container.innerHTML = html;
      } catch(e) { console.warn("Volume stats:", e); }
    })();

    // Galaxy view state
    var galaxyView = null;
    var galaxyContainer = document.getElementById("galaxy-container");
    var diagramContainer = document.getElementById("diagram-container");
    var isGalaxyMode = false;

    // Galaxy scripts are pre-loaded in index.html, so just check and callback
    function loadGalaxyScripts(callback) {
      if (window.GalaxyView && window.GalaxyView.GalaxyView) {
        callback();
        return;
      }
      // Scripts should already be loaded from index.html tags, but wait briefly
      var checkCount = 0;
      function check() {
        checkCount++;
        if (window.GalaxyView && window.GalaxyView.GalaxyView) {
          callback();
        } else if (checkCount < 200) {
          setTimeout(check, 50);
        } else {
          console.error("Galaxy scripts not loaded after 10s");
        }
      }
      check();
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
            // Force layout so clientWidth/Height are available
            void galaxyContainer.offsetHeight;
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
                  // Ensure canvas has proper size
                  galaxyView._resize();
                  setTimeout(function() {
                    galaxyView._resize();
                    galaxyView.show();
                    _feedGalaxyView();
                  }, 50);
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

    // ── Duplicate Scanner ───────────────────────────────
    var dupScanner = new DupScanner();

    // Hidden button that C++ Tools→Find Duplicates menu clicks
    var btnDup = document.createElement("button");
    btnDup.id = "btn-duplicates";
    btnDup.style.display = "none";
    document.body.appendChild(btnDup);

    btnDup.addEventListener("click", function() {
      // Get current scan path or home dir
      var path = currentStats ? (currentStats.scanPath || "") : "";
      if (!path) {
        window.__TAURI__.invoke("get_home_dir").then(function(home) {
          var p = typeof home === "string" ? home : (home?.data || "");
          if (p) dupScanner.start(p);
        }).catch(function(){
          dupScanner.start("C:/Users/");
        });
      } else {
        dupScanner.start(path);
      }
    });

    // Theme switcher
    document.querySelectorAll(".theme-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var theme = this.dataset.theme;
        if (window.__diagram && typeof window.__diagram.setTheme === "function") {
          window.__diagram.setTheme(theme);
        }
        // Highlight active theme
        document.querySelectorAll(".theme-btn").forEach(function (b) {
          b.style.borderColor = "transparent";
        });
        this.style.borderColor = "#fff";
      });
    });

    // About dialog
    aboutClose.addEventListener("click", function () {
      aboutOverlay.classList.remove("active");
    });
    aboutOverlay.addEventListener("click", function (e) {
      if (e.target === aboutOverlay) aboutOverlay.classList.remove("active");
    });
    document.addEventListener("keydown", function escAbout(e) {
      if (e.key === "Escape" && aboutOverlay.classList.contains("active")) {
        aboutOverlay.classList.remove("active");
      }
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
      document.addEventListener("keydown", function(e) {
        if (e.key === "Escape") langMenu.classList.remove("active");
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
            btnScan.click();
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
          // Check if it's JSON-wrapped (e.g. {"data":"path","success":true})
          if (selected.charAt(0) === '{') {
            try { var j = JSON.parse(selected); if (j && j.data) dir = String(j.data); } catch(e) {}
          }
          if (!dir) dir = selected;
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
      if (btnRescan) btnRescan.disabled = true;
      btnBrowse.disabled = true;
      btnCancel.disabled = false;
      btnExport.disabled = true;
      // Save to scan history
      (async function() {
        try {
          var s = await window.__TAURI__.invoke("load_settings", {});
          var hist = (s && s.scan_history) || [];
          if (path && hist[0] !== path) {
            hist = [path].concat(hist.filter(function(h){return h !== path;})).slice(0, 10);
            await window.__TAURI__.invoke("save_settings", { scan_history: hist });
          }
        } catch(e) {}
      })();

      // Multi-path: if path contains semicolons, scan each separately
      var paths = path.split(";").map(function(p){return p.trim();}).filter(function(p){return p;});
      if (paths.length > 1) {
        // Scan first path, then queue the rest
        path = paths[0];
        // Store remaining paths for sequential scanning
        window.__pendingScans = paths.slice(1);
      }
      // Set engine text with thread count
      var engineEl = document.getElementById("progress-engine");
      if (engineEl) {
        var tc = navigator.hardwareConcurrency || 4;
        engineEl.textContent = (window.__ || function(s){return s;})("progress.engine_text").replace("{threads}", tc);
      }
      // Fire-and-forget TCC permission pre-flight (silent on non-macOS)
      window.__TAURI__.invoke("request_permissions", {}).catch(function(){});
      var followLinks = chkFollow.querySelector("input").checked;

      var safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
      }, 1800000); // 30 min safety

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
        speedChartCanvas.width = speedChartCanvas.clientWidth || speedChartCanvas.width;
        var w = speedChartCanvas.width;
        var h = speedChartCanvas.height;
        var ctx = speedChartCtx;
        ctx.clearRect(0, 0, w, h);
        if (speedSamples.length < 2) return;
        var maxBps = Math.max.apply(null, speedSamples.map(function(s){return s.bps})) || 1;

        // Y-axis labels
        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.font = "8px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        function fmtSpeed(bps) { return (bps / 1024 / 1024).toFixed(bps > 1048576 ? 0 : 1) + " MB/s"; }
        ctx.fillText(fmtSpeed(maxBps), w - 4, pad + 2);
        ctx.fillText("0 MB/s", w - 4, h - pad - 2);
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
        currentScanId = scanId;

        // Poll tracking
        var prevFilesFound = 0;
        var lastFilesFound = 0;
        var lastDirsFound = 0;
        var pollStartTime = Date.now();

        var done = false;
        var zeroCount = 0;
        for (var i = 0; i < 3600; i++) {
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
          lastFilesFound = filesFound;
          lastDirsFound = dirsFound;

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

          var mins = Math.floor(elapsedSecs / 60);
          var secs = elapsedSecs % 60;
          var elapsedStr = (mins < 10 ? "0" : "") + mins + ":" + (secs < 10 ? "0" : "") + secs;
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

          // ── Progress percentage (estimate based on rate) ──
          var pctBar = document.getElementById("progress-pct-bar");
          var pctText = document.getElementById("progress-pct-text");
          if (pctBar && pctText) {
            var pct = Math.min(95, Math.max(1, (elapsedSecs > 5) ? Math.min(95, (filesFound / Math.max(1, filesFound + dirsFound)) * 50 + (elapsedSecs / 1200) * 50) : (filesFound / 5000) * 20));
            pctBar.style.width = pct + "%";
            pctText.textContent = Math.round(pct) + "%";
          }

          // ── ETA ──
          if (elapsedSecs > 5 && filesFound > 100 && filesFound > lastFilesFound) {
            var rate = filesFound / elapsedSecs;
            var remaining = (lastFilesFound > 0 && filesFound > lastFilesFound) ? (filesFound * (filesFound / Math.max(1, filesFound - lastFilesFound) - 1)) / rate : 0;
            remaining = Math.max(0, Math.min(36000, remaining));
            var etaM = Math.floor(remaining / 60);
            var etaS = Math.floor(remaining % 60);
            var etaEl = document.getElementById("progress-eta-val");
            if (etaEl) etaEl.textContent = (etaM < 10 ? "0" : "") + etaM + ":" + (etaS < 10 ? "0" : "") + etaS;
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
        for (var ri = 0; ri < 20; ri++) {
          result = await window.__TAURI__
            .invoke("get_scan_result", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (result && result.stats) break;
          if (ri < 5) await sleep(100);
          else await sleep(500);
        }
clearTimeout(safetyTimer);
        progressOverlay.classList.remove("active");
        hideWelcome();

        if (result && result.stats && result.stats.total_files > 0) {
          currentScanResult = result;
          currentStats = result.stats;
          statsPanel.render(result.stats);
          diagram.setData(result.stats);
          var files = Number(result.stats.total_files || 0).toLocaleString("en-US");
          var dirs = Number(result.stats.total_dirs || 0).toLocaleString("en-US");
          var t = window.__ || function(s){return s;};
          document.querySelector(".status-bar").textContent =
            t("status.complete").replace("{files}", files).replace("{dirs}", dirs);
          topFiles.render(result.stats ? result.stats.top_files : [], true);
        } else {
          // Fallback: use last known progress data
          var fbStats = {
            total_files: lastFilesFound || 0,
            total_dirs: lastDirsFound || 0,
            total_size: 0,
            scan_time_ms: Date.now() - pollStartTime,
            top_files: [],
            file_type_breakdown: []
          };
          currentStats = fbStats;
          if (fbStats.total_files > 0) {
            statsPanel.render(fbStats);
            diagram.setData(fbStats);
          }
          var totalSecs = Math.floor((Date.now() - pollStartTime) / 1000);
          var em = Math.floor(totalSecs / 60);
          var es = totalSecs % 60;
          progressElapsedValEl.textContent = (em < 10 ? "0" : "") + em + ":" + (es < 10 ? "0" : "") + es;
          document.querySelector(".status-bar").textContent =
            t("status.complete").replace("{files}", lastFilesFound.toLocaleString()).replace("{dirs}", lastDirsFound.toLocaleString());
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
          
          // Load remaining chunks in parallel batches (20 at a time)
          (async function() {
            var BATCH = 20;
            for (var start = 1; start < loader.totalChunks; start += BATCH) {
              var end = Math.min(start + BATCH, loader.totalChunks);
              var promises = [];
              for (var ci = start; ci < end; ci++) {
                if (!loader.loadedChunks.has(ci)) {
                  promises.push(loader.loadChunk(ci).catch(function(){}));
                }
              }
              if (promises.length > 0) {
                await Promise.all(promises);
                try { await treeView.rebuild(); } catch(e) {}
                await sleep(0);
              }
            }
            try { await treeView.rebuild(); } catch(e) {}
          })();
        } else if (currentStats && currentStats.total_files > 0) {
          // Synthetic root node so the tree shows something
          try {
            var rootNode = { name: scanPath.value, size: currentStats.total_size || 0, file_count: currentStats.total_files || 0, dir_count: currentStats.total_dirs || 0, node_type: 0, parent: 4294967295, first_child: 4294967295, next_sibling: 4294967295, depth: 0, chunk_id: 0, _arenaIndex: 0, _children: [] };
            loader.totalNodes = 1;
            loader.totalChunks = 0;
            loader.allNodes = [rootNode];
            loader.scanId = scanId;
            treeView.expanded.add(0);
            try { await treeView.rebuild(); } catch(e) {}
          } catch(e) { console.warn("Synthetic root:", e); }
        }

        // Trigger next queued scan if multi-path
        if (window.__pendingScans && window.__pendingScans.length > 0) {
          var nextPath = window.__pendingScans.shift();
          if (nextPath && scanPath) { scanPath.value = nextPath; btnScan.click(); }
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
        if (btnRescan) btnRescan.disabled = false;
        btnBrowse.disabled = false;
        btnCancel.disabled = true;
        progressOverlay.classList.remove("active");
      }
    });

    // Rescan (same path)
    if (btnRescan) {
      btnRescan.addEventListener("click", function() {
        if (btnScan && !btnScan.disabled) btnScan.click();
      });
    }

    // Cancel (toolbar + progress overlay)
    btnCancel.addEventListener("click", async function () {
      document.getElementById("progress-status").textContent = (window.__ || function(s){return s;})("status.cancelling");
      btnCancel.disabled = true;
      // 1. Tell Rust to stop scanning
      try { await window.__TAURI__.invoke("cancel_scan", {}); } catch(e) {}
      // 2. Poll until scan is no longer running (max 5s)
      for (var ci = 0; ci < 25; ci++) {
        await sleep(200);
        try {
          var sp = await window.__TAURI__.invoke("get_scan_progress", { scanId: currentScanId });
          if (!sp.is_running) break;
        } catch(e) { break; }
      }
      // 3. Try to get whatever we have so far
      try {
        var partial = await window.__TAURI__.invoke("get_scan_result", { scanId: currentScanId });
        if (partial && partial.stats && partial.stats.total_files > 0) {
          currentScanResult = partial;
          currentStats = partial.stats;
          statsPanel.render(partial.stats);
          diagram.setData(partial.stats);
          var files = Number(partial.stats.total_files || 0).toLocaleString("en-US");
          var dirs = Number(partial.stats.total_dirs || 0).toLocaleString("en-US");
          document.querySelector(".status-bar").textContent =
            t("status.cancelled_partial").replace("{files}", files).replace("{dirs}", dirs);
          topFiles.render(partial.stats ? partial.stats.top_files : [], true);
          // Try to load tree chunks BEFORE releasing the loader
          if (partial.root_info && partial.root_info.total_chunks > 0) {
            loader.totalNodes = partial.root_info.total_nodes;
            loader.totalChunks = partial.root_info.total_chunks;
            loader.allNodes = new Array(loader.totalNodes);
            loader.scanId = currentScanId;
            try { await loader.loadChunk(0); } catch(e) { console.warn("cancel chunk 0:", e); }
            treeView.expanded.add(0);
            try { await treeView.rebuild(); } catch(e) { console.warn("cancel rebuild:", e); }
          }
        } else {
          document.querySelector(".status-bar").textContent =
            (window.__ || function(s){return s;})("status.scan_cancelled").replace("{files}", lastFilesFound.toLocaleString());
        }
      } catch(e) {
        console.warn("cancel partial error:", e);
        document.querySelector(".status-bar").textContent =
          "Scan cancelled - " + lastFilesFound.toLocaleString() + " files found";
      }
      // Release AFTER loading chunks
      try { await loader.release(); } catch(e) {}
      isScanning = false;
      btnScan.disabled = false;
      btnBrowse.disabled = false;
      btnCancel.disabled = true;
      btnExport.disabled = false;
      progressOverlay.classList.remove("active");
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
        var fmt = prompt((window.__ || function(s){return s;})("status.export_prompt"), "CSV");
        if (!fmt) return;
        fmt = fmt.toUpperCase();
        var stats = currentStats || {};
        var scanPathVal = scanPath.value || "";
        if (fmt === "CSV") {
          // Build CSV from tree nodes
          var csv = "Path,Size,File Count,Dir Count,Type\n";
          var nodes = loader.allNodes || [];
          for (var ni = 0; ni < nodes.length; ni++) {
            var n = nodes[ni];
            if (!n) continue;
            var fullPath = scanPathVal;
            if (n.name && n.name !== scanPathVal) {
              // Walk up to reconstruct path from arena index
              var parts = [n.name];
              var p = n.parent;
              var safety = 0;
              while (p !== 4294967295 && p !== undefined && safety < 100) {
                var parent = nodes[p];
                if (parent && parent.name) parts.unshift(parent.name);
                p = parent ? parent.parent : 4294967295;
                safety++;
              }
              fullPath = scanPathVal + "/" + parts.join("/");
            }
            var esc = function(v) { return '"' + String(v).replace(/"/g, '""') + '"'; };
            csv += esc(fullPath) + "," + (n.size || 0) + "," + (n.file_count || 0) + "," + (n.dir_count || 0) + "," + (n.node_type === 1 ? "File" : "Directory") + "\n";
          }
          var blob = new Blob([csv], { type: "text/csv" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "diskraptor-export-" + Date.now() + ".csv";
          a.click();
          URL.revokeObjectURL(url);
        } else {
          var json = JSON.stringify({ export_time: new Date().toISOString(), scan_path: scanPathVal, stats: stats }, null, 2);
          var blob = new Blob([json], { type: "application/json" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = "diskraptor-export-" + Date.now() + ".json";
          a.click();
          URL.revokeObjectURL(url);
        }
        var t = window.__ || function(s){return s;};
        document.querySelector(".status-bar").textContent = (window.__ || function(s){return s;})("status.exported").replace("{fmt}", fmt);
      } catch (err) {
        console.error("Export failed:", err);
        alert("Export failed: " + err);
      }
    });

    // ── Drag & drop from Finder ─────────────────────────
    document.addEventListener("dragover", function(e) { e.preventDefault(); });
    document.addEventListener("drop", function(e) {
      e.preventDefault();
      var items = e.dataTransfer.items;
      if (!items || items.length === 0) return;
      for (var di = 0; di < items.length; di++) {
        var item = items[di];
        if (item.kind === "file") {
          var file = item.getAsFile();
          if (file && file.path) {
            scanPath.value = file.path;
            btnScan.click();
            return;
          }
        }
      }
    });

    // ── Settings dialog ─────────────────────────────────
    (function() {
      var so = document.getElementById("settings-overlay");
      if (!so) return;
      document.getElementById("settings-close")?.addEventListener("click", function() { so.style.display = "none"; });
      document.getElementById("settings-save")?.addEventListener("click", async function() {
        var defPath = document.getElementById("settings-default-path")?.value || "";
        var selTheme = document.getElementById("settings-theme")?.value || "auto";
        await window.__TAURI__.invoke("save_settings", { default_scan_path: defPath, theme: selTheme }).catch(function(){});
        // Apply theme immediately
        if (selTheme === "light") document.body.classList.add("light-theme");
        else if (selTheme === "dark") document.body.classList.remove("light-theme");
        else {
          var isLight = window.matchMedia('(prefers-color-scheme: light)').matches;
          document.body.classList.toggle("light-theme", isLight);
        }
        so.style.display = "none";
      });
      so.addEventListener("click", function(e) { if (e.target === so) so.style.display = "none"; });
    })();

    // ── Tools dropdown ──────────────────────────────────
    var btnTools = document.getElementById("btn-tools");
    var toolsMenu = document.getElementById("tools-menu");
    if (btnTools && toolsMenu) {
      btnTools.addEventListener("click", function(e) {
        e.stopPropagation();
        toolsMenu.classList.toggle("active");
      });
      document.addEventListener("click", function() {
        toolsMenu.classList.remove("active");
      });
      toolsMenu.addEventListener("click", async function(e) {
        var item = e.target.closest(".tools-item");
        if (!item) return;
        var action = item.dataset.action;
        toolsMenu.classList.remove("active");
        if (action === "scan-downloads") {
          window.__TAURI__.invoke("get_home_dir").then(function(home) {
            var p = typeof home === "string" ? home : (home?.data || "");
            var dl = p ? p.replace(/[\\/]+$/, "") + "/Downloads" : "";
            if (dl && scanPath) { scanPath.value = dl; btnScan.click(); }
          }).catch(function(){});
        } else if (action === "scan-trash") {
          window.__TAURI__.invoke("get_home_dir").then(function(home) {
            var p = typeof home === "string" ? home : (home?.data || "");
            var tr = p ? p.replace(/[\\/]+$/, "") + "/.Trash" : "";
            if (tr && scanPath) { scanPath.value = tr; btnScan.click(); }
          }).catch(function(){});
        } else if (action === "clear-scan") {
          currentStats = null;
          currentScanResult = null;
          loader.release().catch(function(){});
          treeView.visibleNodes = [];
          treeView.expanded.clear();
          treeView.selectedIndex = null;
          treeView.rebuild().catch(function(){});
          statsPanel.clear();
          diagram.setData(null);
          topFiles.render([], true);
          document.querySelector(".status-bar").textContent = (window.__ || function(s){return s;})("status.clear_scan");
          showWelcome();
        } else if (action === "settings") {
          var so = document.getElementById("settings-overlay");
          if (so) {
            // Load current settings
            var defPath = document.getElementById("settings-default-path");
            var selTheme = document.getElementById("settings-theme");
            if (defPath) defPath.value = scanPath.value || "";
            if (selTheme) selTheme.value = "auto";
            window.__TAURI__.invoke("load_settings", {}).then(function(s) {
              if (s) {
                if (defPath && s.default_scan_path) defPath.value = s.default_scan_path;
                if (selTheme && s.theme) selTheme.value = s.theme;
              }
            }).catch(function(){});
            so.style.display = "flex";
          }
        } else if (action === "duplicates") {
          var dupBtn = document.getElementById("btn-duplicates");
          if (dupBtn) dupBtn.click();
        } else if (action === "empty-folders") {
          var loader = window.__loader;
          if (!loader || !loader.allNodes) break;
          var nodes = loader.allNodes;
          var emptyDirs = [];
          for (var ni = 0; ni < nodes.length; ni++) {
            var n = nodes[ni];
            if (n && (n.node_type === 0 || n.node_type === "Directory") && n.file_count === 0 && n.dir_count === 0 && n.parent !== 4294967295) {
              emptyDirs.push({ name: n.name, arenaIdx: ni });
            }
          }
          if (emptyDirs.length === 0) { alert("No empty folders found"); break; }
          var html2 = '<div style="padding:16px;max-height:300px;overflow-y:auto;">';
          for (var ei = 0; ei < Math.min(emptyDirs.length, 500); ei++) {
            html2 += '<div class="empty-folder-item" data-idx="' + emptyDirs[ei].arenaIdx + '" style="padding:3px 8px;cursor:pointer;border-radius:4px;font-size:12px;">📂 ' + emptyDirs[ei].name + '</div>';
          }
          if (emptyDirs.length > 500) html2 += '<div style="padding:4px;text-align:center;color:var(--text-muted);font-size:11px;">+ ' + (emptyDirs.length-500) + ' more</div>';
          html2 += '</div>';
          var ov2 = document.createElement("div");
          ov2.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
          var card2 = document.createElement("div");
          card2.style.cssText = "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:400px;width:90%;max-height:80vh;overflow:hidden;";
          card2.innerHTML = '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">📂 Empty Folders (' + emptyDirs.length + ')</div>' + html2 +
            '<div style="padding:8px 16px;border-top:1px solid var(--border);text-align:right;"><button class="ef-close-btn" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button></div>';
          ov2.appendChild(card2);
          document.body.appendChild(ov2);
          ov2.querySelector(".ef-close-btn").onclick = function(){ document.body.removeChild(ov2); };
          ov2.onclick = function(e) { if (e.target === ov2) document.body.removeChild(ov2); };
          ov2.querySelectorAll(".empty-folder-item").forEach(function(el) {
            el.onclick = function() {
              var idx = parseInt(this.dataset.idx);
              if (!isNaN(idx) && window.__treeView) { window.__treeView.select(idx); document.body.removeChild(ov2); }
            };
            el.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
            el.onmouseleave = function() { this.style.background = "transparent"; };
          });
        } else if (action === "export-html") {
          var stats = currentStats || {};
          var svg = document.querySelector('#diagram-container canvas');
          var chartData = "";
          try { chartData = svg ? svg.toDataURL() : ""; } catch(e) {}
          var fileRows = "";
          var nodes = (window.__loader && window.__loader.allNodes) || [];
          for (var hni = 0; hni < Math.min(nodes.length, 200); hni++) {
            var hn = nodes[hni];
            if (!hn) continue;
            fileRows += "<tr><td>" + (hn.name || "") + "</td><td>" + (hn.size || 0) + "</td></tr>\n";
          }
          var htmlReport = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>DiskRaptor Report</title><style>body{font-family:sans-serif;margin:20px;color:#333}h1{color:#2ea043}table{border-collapse:collapse;width:100%}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #eee}th{background:#f5f5f5}</style></head><body>' +
            '<h1>🦖 DiskRaptor Report</h1>' +
            '<p>Path: ' + (scanPath.value || "") + '</p>' +
            '<p>Files: ' + (stats.total_files || 0) + ' | Dirs: ' + (stats.total_dirs || 0) + ' | Size: ' + (stats.size_human || "0 B") + '</p>' +
            (chartData ? '<img src="' + chartData + '" style="max-width:600px;">' : '') +
            '<h2>Files</h2><table><tr><th>Name</th><th>Size</th></tr>' + fileRows + '</table>' +
            '<p style="color:#999;font-size:11px;margin-top:20px;">Generated by DiskRaptor</p></body></html>';
          var blob = new Blob([htmlReport], { type: "text/html" });
          var url = URL.createObjectURL(blob);
          var a = document.createElement("a");
          a.href = url; a.download = "diskraptor-report-" + Date.now() + ".html"; a.click();
          URL.revokeObjectURL(url);
        } else if (action === "find-files") {
          var query = prompt("Find files by name (e.g. *.jpg, *test*, partial name):", "*");
          if (!query) break;
          var loader = window.__loader;
          var treeView = window.__treeView;
          if (!loader || !loader.allNodes) break;
          var nodes = loader.allNodes;
          var results = [];
          var pattern = query.replace(/\*/g, ".*").replace(/\?/g, ".").toLowerCase();
          try { var re = new RegExp("^" + pattern + "$", "i"); } catch(e) { break; }
          for (var ni = 0; ni < nodes.length; ni++) {
            var n = nodes[ni];
            if (n && n.name && re.test(n.name)) {
              var fullPath = scanPath.value.replace(/[\\/]+$/, "");
              var parts = [n.name]; var p = n.parent; var safety = 0;
              while (p !== 4294967295 && p !== undefined && safety < 20) {
                var parent = nodes[p]; if (parent && parent.name) parts.unshift(parent.name);
                p = parent ? parent.parent : 4294967295; safety++;
              }
              results.push({ name: n.name, path: fullPath + "/" + parts.join("/"), size: n.size, arenaIdx: ni });
            }
          }
          if (results.length === 0) { alert("No files found matching: " + query); break; }
          results.sort(function(a,b){return b.size - a.size;});
          var html = '<div style="padding:16px;max-height:300px;overflow-y:auto;">';
          for (var ri = 0; ri < Math.min(results.length, 200); ri++) {
            var r = results[ri];
            html += '<div class="find-file-item" data-idx="' + r.arenaIdx + '" style="padding:4px 8px;cursor:pointer;border-radius:4px;font-size:12px;display:flex;gap:8px;">';
            html += '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + r.name + '</span>';
            html += '<span style="font-family:monospace;color:var(--text-muted);font-size:11px;">' + (r.size ? (r.size/1024).toFixed(1) + " KB" : "") + '</span>';
            html += '</div>';
          }
          if (results.length > 200) html += '<div style="padding:4px;text-align:center;color:var(--text-muted);font-size:11px;">+ ' + (results.length-200) + ' more</div>';
          html += '</div>';
          var ov = document.createElement("div");
          ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
          var card = document.createElement("div");
          card.style.cssText = "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:500px;width:90%;max-height:80vh;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.4);";
          card.innerHTML = '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">🔎 Find Files (' + results.length + ' matches)</div>' + html +
            '<div style="padding:8px 16px;border-top:1px solid var(--border);text-align:right;"><button class="find-close-btn" style="padding:5px 14px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button></div>';
          ov.appendChild(card);
          document.body.appendChild(ov);
          ov.querySelector(".find-close-btn").onclick = function(){ document.body.removeChild(ov); };
          ov.onclick = function(e) { if (e.target === ov) document.body.removeChild(ov); };
          ov.querySelectorAll(".find-file-item").forEach(function(el) {
            el.onclick = function() {
              var idx = parseInt(this.dataset.idx);
              if (!isNaN(idx) && treeView) {
                treeView.select(idx);
                document.body.removeChild(ov);
              }
            };
            el.onmouseenter = function() { this.style.background = "var(--bg-hover)"; };
            el.onmouseleave = function() { this.style.background = "transparent"; };
          });
        } else if (action === "trash-recovery") {
          if (!window.__trashRecovery) window.__trashRecovery = new TrashRecovery();
          window.__trashRecovery.open();
        } else if (action === "trash") {
          var t = window.__ || function(s){return s;};
          if (!confirm(t("confirm.empty_trash"))) return;
          try {
            item.textContent = "⏳ Emptying...";
            await window.__TAURI__.invoke("empty_trash", {});
            var t = window.__ || function(s){return s;};
            document.querySelector(".status-bar").textContent = t("status.trash_emptied");
          } catch(e) {
            console.warn("Empty trash:", e);
            alert("Failed: " + e);
          }
          setTimeout(function() { item.textContent = "🗑️ Empty Trash"; }, 3000);
        }
      });
    }

    scanPath.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btnScan.click();
    });

    // ── RAM status bars (bottom of page) ────────────────────
    var ramAppFill = document.getElementById("ram-app-fill");
    var ramSysFill = document.getElementById("ram-sys-fill");
    var ramAppText = document.getElementById("ram-app-text");
    var ramSysText = document.getElementById("ram-sys-text");
    function formatBytes(v) {
      var u = ["B","KB","MB","GB","TB"];
      var i = 0;
      while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
      return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
    }
    async function updateRam() {
      try {
        var [sysMem, procMem] = await Promise.all([
          window.__TAURI__.invoke("get_memory_info").catch(e=>null),
          window.__TAURI__.invoke("get_process_memory").catch(e=>null),
        ]);
        if (sysMem && sysMem.total_bytes > 0) {
          var total = sysMem.total_bytes;
          var sysUsed = sysMem.used_bytes;
          var sysPct = Math.round(sysUsed / total * 100);
          ramSysFill.style.width = sysPct + "%";
          ramSysFill.className = "ram-bar-fill-sys" + (sysPct > 85 ? " critical" : sysPct > 70 ? " warning" : "");
          ramSysText.textContent = formatBytes(sysUsed) + " / " + formatBytes(total) + " (" + sysPct + "%)";
        }
        if (procMem && procMem.resident_bytes > 0) {
          var appMem = procMem.resident_bytes;
          var appPct = Math.round(appMem / total * 100);
          ramAppFill.style.width = appPct + "%";
          ramAppText.textContent = formatBytes(appMem) + " (" + appPct + "%)";
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
