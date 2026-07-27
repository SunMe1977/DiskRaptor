/**
 * DiskRaptor - Main application controller.
 */
(function () {
  "use strict";

  async function init() {
    console.log("DiskRaptor booting...");
    const statusBar = document.querySelector(".status-bar");

    const bridgeReady = new Promise((resolve) => {
      if (window.__TAURI__ && typeof window.__TAURI__.invoke === "function" && window.__TAURI__.__qtBridgeReady) {
        resolve(true);
        return;
      }
      if (window.__TAURI__ && typeof window.__TAURI__.invoke === "function") {
        const check = () => {
          if (window.__TAURI__.__qtBridgeReady) { resolve(true); return; }
          setTimeout(check, 50);
        };
        check();
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

    // ── Shared state ────────────────────────────────────
    window.app = window.app || {};
    const state = window.app.state = {
      isScanning: false,
      currentStats: null,
      currentScanResult: null,
      currentScanId: 0,
      lastFilesFound: 0,
      lastDirsFound: 0,
    };

    // ── Settings helpers ───────────────────────────────────
    window.app.getSetting = async function (key, fallback) {
      try {
        const r = await window.__TAURI__.invoke("load_settings");
        if (r && r[key] !== undefined) return r[key];
      } catch (e) {}
      return fallback;
    };
    window.app.setSetting = async function (key, val) {
      try {
        const o = {};
        o[key] = val;
        await window.__TAURI__.invoke("save_settings", o);
      } catch (e) {}
    };
    const getSetting = window.app.getSetting;
    const setSetting = window.app.setSetting;

    // ── Theme toggle ───────────────────────────────────────
    await window.app.initTheme(getSetting, setSetting);

    const loader = new ChunkLoader();
    window.__loader = loader;
    const treeView = new TreeView("tree-viewport", loader);
    window.__treeView = treeView;

    // ── Column resize ────────────────────────────────────
    (function () {
      let dragCol = null,
        startX = 0,
        startW = 0;
      document.addEventListener("mousedown", function (e) {
        const handle = e.target.closest(".col-resize");
        if (!handle) return;
        dragCol = handle.parentElement;
        startX = e.clientX;
        startW = parseInt(dragCol.style.width) || dragCol.offsetWidth;
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragCol) return;
        const w = Math.max(40, startW + (e.clientX - startX));
        dragCol.style.width = w + "px";
        dragCol.style.flex = "none";
        const colIdx = Array.from(dragCol.parentElement.children).indexOf(
          dragCol,
        );
        if (colIdx >= 0) {
          document.querySelectorAll(".tree-row").forEach(function (row) {
            const cell = row.children[colIdx];
            if (cell) cell.style.width = w - 8 + "px";
          });
        }
      });
      document.addEventListener("mouseup", function () {
        dragCol = null;
      });
    })();

    const topFiles = new TopFilesPanel();
    window.__topFiles = topFiles;
    const statsPanel = new StatsPanel();
    window.__statsPanel = statsPanel;
    const diagram = new DiagramRenderer("diagram-container");
    window.__diagram = diagram;

    // Wire zoom buttons
    diagram.onZoomChanged = function (zoom) {
      const label = document.getElementById("zoom-label");
      if (label) label.textContent = Math.round(zoom * 100) + "%";
      const btns = document.querySelectorAll(".zoom-btn");
      btns.forEach(function (b) {
        const z = b.dataset.zoom;
        if (z === "fit") return;
        b.classList.toggle("active", Math.abs(Number(z) - zoom) < 0.01);
      });
    };
    document.querySelectorAll(".zoom-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const z = this.dataset.zoom;
        document
          .querySelectorAll(".zoom-btn")
          .forEach(function (b) {
            b.classList.remove("active");
          });
        this.classList.add("active");
        diagram.setZoom(z);
      });
    });

    // ── Welcome placeholder ──────────────────────────────
    const welcomeEl = document.getElementById("welcome-placeholder");
    const welcomeClose = document.getElementById("welcome-close");
    const welcomeScanBtn = document.getElementById("welcome-scan-btn");
    const welcomeBrowseBtn = document.getElementById("welcome-browse-btn");
    const welcomeAboutBtn = document.getElementById("welcome-about-btn");

    function hideWelcome() {
      if (welcomeEl) welcomeEl.classList.add("hidden");
    }

    function showWelcome() {
      if (welcomeEl) welcomeEl.classList.remove("hidden");
    }

    if (welcomeClose) {
      welcomeClose.addEventListener("click", hideWelcome);
    }

    if (welcomeScanBtn) {
      welcomeScanBtn.addEventListener("click", function () {
        window.__TAURI__
          .invoke("get_home_dir")
          .then(function (home) {
            const path =
              typeof home === "string" ? home : (home?.data || "");
            if (path && scanPath) {
              scanPath.value = path;
            }
            if (btnScan) btnScan.click();
          })
          .catch(function () {
            if (btnScan) btnScan.click();
          });
      });
    }

    if (welcomeBrowseBtn) {
      welcomeBrowseBtn.addEventListener("click", function () {
        if (btnBrowse) btnBrowse.click();
      });
    }

    if (welcomeAboutBtn) {
      welcomeAboutBtn.addEventListener("click", function () {
        const ov = document.getElementById("about-overlay");
        if (ov) ov.classList.add("active");
      });
    }

    // ── Collapsible detail cards ─────────────────────────
    document.querySelectorAll(".collapsible .card-header").forEach(function (
      h,
    ) {
      h.addEventListener("click", function () {
        const card = this.closest(".collapsible");
        if (card) card.classList.toggle("collapsed");
      });
    });

    loader.onProgress = (loaded, total) => {
      const el = document.querySelector("#tree-panel .status-bar");
      if (el) el.textContent = "Loading chunks... " + loaded + "/" + total;
    };

    treeView.onSelect = function () {};

    // DOM refs
    const scanPath = document.getElementById("scan-path");
    const btnBrowse = document.getElementById("btn-browse");
    const btnScan = document.getElementById("btn-scan");
    const btnRescan = document.getElementById("btn-rescan");
    const btnCancel = document.getElementById("btn-cancel");
    const btnExport = document.getElementById("btn-export");
    const progressOverlay = document.getElementById("progress-overlay");
    const progressPath = document.getElementById("progress-path");
    const aboutOverlay = document.getElementById("about-overlay");
    const aboutClose = document.getElementById("btn-about-close");
    const btnFav = document.getElementById("btn-fav");

    // Set default scan path to user home after init and DOM binding.
    try {
      const home = await window.__TAURI__.invoke("get_home_dir");
      let homePath = null;
      if (typeof home === "string") {
        if (home.charAt(0) === "{") {
          try {
            const j = JSON.parse(home);
            if (j && j.data) homePath = String(j.data);
          } catch (e) {}
        }
        if (!homePath) homePath = home;
      } else if (home && typeof home === "object") {
        homePath = home.data ? String(home.data) : null;
      }
      if (homePath && scanPath && !scanPath.value) {
        scanPath.value = homePath;
      }
    } catch (e) {
      console.warn("get_home_dir failed:", e && e.message ? e.message : e);
    }

    // ── Favorites/Bookmarked directories ─────────────────
    window.app.initFavorites(scanPath, btnFav);

    // ── Drive Selector ──────────────────────────────────
    window.app.initDrives(scanPath, btnScan);

    // Galaxy view state
    let galaxyView = null;
    const galaxyContainer = document.getElementById("galaxy-container");
    const diagramContainer = document.getElementById("diagram-container");
    let isGalaxyMode = false;

    function loadGalaxyScripts(callback) {
      if (window.GalaxyView && window.GalaxyView.GalaxyView) {
        callback();
        return;
      }
      let checkCount = 0;
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
      if (!galaxyView || !state.currentStats) return;
      const scanResult = state.currentScanResult || state.currentStats;
      const topFilesData =
        (state.currentStats && state.currentStats.top_files) || [];
      try {
        galaxyView.loadData(scanResult, state.currentStats, topFilesData, []);
      } catch (e) {
        console.error("GalaxyView load failed:", e);
      }
    }

    // Diagram mode switcher (in detail panel)
    const diagramModes = document.querySelectorAll(".diagram-mode");
    diagramModes.forEach(function (btn) {
      btn.addEventListener("click", function () {
        diagramModes.forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");

        const mode = btn.dataset.mode;
        if (mode === "galaxy") {
          isGalaxyMode = true;
          if (diagramContainer) diagramContainer.style.display = "none";
          if (galaxyContainer) {
            galaxyContainer.style.display = "block";
            void galaxyContainer.offsetHeight;
            if (!galaxyView) {
              loadGalaxyScripts(function () {
                try {
                  if (
                    !window.GalaxyView ||
                    !window.GalaxyView.GalaxyView
                  ) {
                    throw new Error("Galaxy scripts not loaded");
                  }
                  galaxyContainer.style.minHeight = "400px";
                  galaxyView = new GalaxyView.GalaxyView(galaxyContainer);
                  galaxyView.init();
                  galaxyView._resize();
                  setTimeout(function () {
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
          isGalaxyMode = false;
          if (galaxyContainer) galaxyContainer.style.display = "none";
          if (galaxyView) galaxyView.hide();
          if (diagramContainer) diagramContainer.style.display = "block";
          diagram.setMode(mode);
        }
      });
    });

    // ── Duplicate Scanner ───────────────────────────────
    const dupScanner = new DupScanner();

    const btnDup = document.createElement("button");
    btnDup.id = "btn-duplicates";
    btnDup.style.display = "none";
    document.body.appendChild(btnDup);

    btnDup.addEventListener("click", function () {
      const path = state.currentStats
        ? state.currentStats.scanPath || ""
        : "";
      if (!path) {
        window.__TAURI__
          .invoke("get_home_dir")
          .then(function (home) {
            const p =
              typeof home === "string" ? home : (home?.data || "");
            if (p) dupScanner.start(p);
          })
          .catch(function () {
            dupScanner.start("C:/Users/");
          });
      } else {
        dupScanner.start(path);
      }
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
    // About tabs
    document.querySelectorAll(".about-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document
          .querySelectorAll(".about-tab")
          .forEach(function (t) {
            t.classList.remove("active");
          });
        document
          .querySelectorAll(".about-tab-content")
          .forEach(function (c) {
            c.style.display = "none";
          });
        this.classList.add("active");
        const target = document.getElementById(
          "about-tab-" + this.dataset.tab,
        );
        if (target) target.style.display = "";
      });
    });
    // Update check
    window.__checkUpdate = async function () {
      const el = document.getElementById("about-update-check");
      if (!el) return;
      el.textContent = "\u23F3 Checking...";
      try {
        const r = await fetch(
          "https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest",
        );
        const data = await r.json();
        const latest = (data.tag_name || "").replace(/^v/, "");
        const current = "1.0.0";
        if (latest && latest !== current) {
          el.textContent =
            "\u2B07\uFE0F Update available: v" +
            latest +
            " (current: v" +
            current +
            ")";
          el.style.color = "var(--accent-orange)";
        } else {
          el.textContent =
            "\u2705 You have the latest version (v" + current + ")";
          el.style.color = "var(--accent-green)";
        }
      } catch (e) {
        el.textContent = "\u26A0\uFE0F Update check failed";
        el.style.color = "var(--accent-red)";
      }
    };

    // ── Language Switcher ──────────────────────────────────
    (function initLangSwitcher() {
      const btnLang = document.getElementById("btn-lang");
      const langMenu = document.getElementById("lang-menu");
      const langList = document.getElementById("lang-list");
      const langFilter = document.getElementById("lang-filter");

      function renderLangs(filter) {
        filter = (filter || "").toLowerCase();
        const current = window.I18N.getLocale().raw;
        let html = "";
        const autoActive =
          current === "auto" ? ' class="lang-item active"' : "";
        html +=
          '<button data-lang="auto"' +
          autoActive +
          ' class="lang-item"><span class="lang-flag">\uD83D\uDDA5\uFE0F</span> <span>' +
          window.__("lang.auto") +
          '</span> <span class="lang-code">auto</span></button>';
        html +=
          '<hr style="border:none;border-top:1px solid var(--border-light);margin:4px 0">';

        window.I18N.LANGUAGES.forEach(function (lang) {
          if (
            filter &&
            !lang.label.toLowerCase().includes(filter) &&
            !lang.code.includes(filter)
          )
            return;
          const active =
            current === lang.code ? ' class="lang-item active"' : "";
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

        langList.querySelectorAll(".lang-item").forEach(function (btn) {
          btn.addEventListener("click", function () {
            const code = this.getAttribute("data-lang");
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

      langFilter.addEventListener("input", function () {
        renderLangs(this.value);
      });

      document.addEventListener("click", function (e) {
        if (!e.target.closest(".lang-dropdown-wrap")) {
          langMenu.classList.remove("active");
        }
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") langMenu.classList.remove("active");
      });

      langFilter.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
          langMenu.classList.remove("active");
          btnLang.focus();
        }
      });

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
            document
              .querySelectorAll(".diagram-mode")
              .forEach(function (b) {
                b.classList.remove("active");
              });
            const btn = document.querySelector(
              '.diagram-mode[data-mode="' + mode + '"]',
            );
            if (btn) btn.classList.add("active");
            diagram.setMode(mode);
          });
        });
        window.__TAURI__.event.listen("menu-about", function () {
          aboutOverlay.classList.add("active");
        });
        window.I18N.LANGUAGES.forEach(function (lang) {
          const eventName = "menu-lang-" + lang.code;
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

    window.addEventListener("locale-changed", function () {});

    // Browse
    btnBrowse.addEventListener("click", async function () {
      try {
        const selected = await window.__TAURI__.invoke("pick_directory");
        let dir = null;
        if (typeof selected === "string" && selected.length > 0) {
          if (selected.charAt(0) === "{") {
            try {
              const j = JSON.parse(selected);
              if (j && j.data) dir = String(j.data);
            } catch (e) {}
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
        document.querySelector(".status-bar").textContent =
          "Click to type path manually";
        document.getElementById("scan-path").focus();
        document.getElementById("scan-path").select();
      }
    });

    // ── Follow symlinks toggle ──
    let chkFollow = document.getElementById("chk-follow-symlinks");
    if (!chkFollow) {
      chkFollow = document.createElement("label");
      chkFollow.id = "chk-follow-symlinks";
      chkFollow.className = "symlink-toggle";
      chkFollow.innerHTML =
        '<input type="checkbox"> Follow symlinks';
      btnScan.parentNode.insertBefore(chkFollow, btnScan);
    }

    // ── Error display ──
    let errDisplay = document.getElementById("scan-errors");
    if (!errDisplay) {
      errDisplay = document.createElement("div");
      errDisplay.id = "scan-errors";
      errDisplay.className = "scan-errors";
      errDisplay.style.display = "none";
      document.getElementById("progress-overlay").appendChild(errDisplay);
    }

    // ── Scan ────────────────────────────────────────────
    window.app.initScan({
      loader: loader,
      treeView: treeView,
      diagram: diagram,
      topFiles: topFiles,
      statsPanel: statsPanel,
      scanPath: scanPath,
      btnBrowse: btnBrowse,
      btnScan: btnScan,
      btnRescan: btnRescan,
      btnCancel: btnCancel,
      btnExport: btnExport,
      progressOverlay: progressOverlay,
      progressPath: progressPath,
      chkFollow: chkFollow,
      errDisplay: errDisplay,
      hideWelcome: hideWelcome,
      showWelcome: showWelcome,
      sleep: sleep,
    });

    // ── Export ──────────────────────────────────────────
    window.app.initExport({
      scanPath: scanPath,
      btnExport: btnExport,
      loader: loader,
    });

    // ── Drag & drop from Finder ─────────────────────────
    document.addEventListener("dragover", function (e) {
      e.preventDefault();
    });
    document.addEventListener("drop", function (e) {
      e.preventDefault();
      const items = e.dataTransfer.items;
      if (!items || items.length === 0) return;
      for (let di = 0; di < items.length; di++) {
        const item = items[di];
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file && file.path) {
            scanPath.value = file.path;
            btnScan.click();
            return;
          }
        }
      }
    });

    // ── Settings ────────────────────────────────────────
    window.app.initSettings({
      scanPath: scanPath,
      btnScan: btnScan,
      btnBrowse: btnBrowse,
    });

    // ── Tools dropdown ──────────────────────────────────
    window.app.initTools({
      scanPath: scanPath,
      btnScan: btnScan,
      showWelcome: showWelcome,
    });

    console.log("DiskRaptor ready.");
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function safeInit() {
    init().catch(function (err) {
      console.error("DiskRaptor init failed:", err);
      const sb = document.querySelector(".status-bar");
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
