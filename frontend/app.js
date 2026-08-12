/**
 * DiskRaptor - Main application controller.
 */
(function () {
  "use strict";

  async function init() {
    console.debug("DiskRaptor booting...");
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
      try {
        const w = window.__TAURI__.window.getCurrentWindow();
        await w.maximize();
      } catch (_) {}
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

    // ── IPC contract guard ────────────────────────────────────────────────
    // Wrap invoke so every response is validated against the documented shapes
    // in contracts.js. Log-only: a violation logs a console warning but never
    // throws, so a contract drift can never break the running app.
    (function wrapInvokeForContract() {
      const contract = window.__contract;
      if (!contract) return;
      const wrap = function (invoke) {
        return async function (cmd, ...args) {
          const res = await invoke(cmd, ...args);
          try {
            contract.check(cmd, res);
          } catch (e) {
            /* contract check must never affect the app */
          }
          return res;
        };
      };
      // Tauri v2 exposes `window.__TAURI__.invoke` / `core.invoke` as
      // non-writable properties, so assignment throws and would break app
      // startup. Wrap best-effort: only replace when writable (or redefinable)
      // and swallow any error so this guard can never crash the app.
      const tryWrap = function (owner, key) {
        if (!owner || typeof owner[key] !== "function") return;
        try {
          const desc = Object.getOwnPropertyDescriptor(owner, key);
          if (desc && !desc.writable) {
            if (!desc.configurable) return; // cannot redefine → skip
            Object.defineProperty(owner, key, {
              value: wrap(owner[key].bind(owner)),
              writable: true,
              configurable: true,
            });
            return;
          }
          owner[key] = wrap(owner[key].bind(owner));
        } catch (e) {
          /* best-effort only — never break the running app */
        }
      };
      const api = window.__TAURI__;
      if (api) {
        tryWrap(api, "invoke");
        if (api.core) tryWrap(api.core, "invoke");
      }
    })();

    console.debug("DiskRaptor initializing...");

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
      } catch (e) {
        console.warn("load_settings failed:", e && e.message ? e.message : e);
      }
      return fallback;
    };
    window.app.setSetting = async function (key, val) {
      try {
        const o = {};
        o[key] = val;
        await window.__TAURI__.invoke("save_settings", { settings: o });
      } catch (e) {
        console.warn("save_settings failed:", e && e.message ? e.message : e);
      }
    };
    const getSetting = window.app.getSetting;
    const setSetting = window.app.setSetting;

    // ── Theme toggle ───────────────────────────────────────
    await window.app.initTheme(getSetting, setSetting);

    // ── Sandbox notice (macOS App Store build) ─────────────
    (async function () {
      try {
        const r = await window.__TAURI__.invoke("is_sandboxed");
        if (r && r.sandboxed) {
          if (window.showToast) {
            window.showToast(
              "App Store sandbox: some tools (S.M.A.R.T., trash via Finder) are limited.",
              "info",
            );
          }
          const sb = document.querySelector(".status-bar");
          if (sb) sb.textContent = "Running in App Store sandbox mode";
          // Hide tools that rely on subprocesses forbidden in the sandbox.
          document
            .querySelectorAll(
              '.tools-item[data-action="smart-tools"], .tools-item[data-action="trash"]',
            )
            .forEach(function (el) { el.style.display = "none"; });
        }
      } catch (e) { console.debug("[DiskRaptor]", e); }
    })();

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
      let resizeRAF = null;
      document.addEventListener("mousemove", function (e) {
        if (!dragCol) return;
        if (resizeRAF) return;
        resizeRAF = requestAnimationFrame(function () {
          resizeRAF = null;
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
    const welcomeDont = document.getElementById("welcome-dont-show");
    const welcomeScanBtn = document.getElementById("welcome-scan-btn");
    const welcomeBrowseBtn = document.getElementById("welcome-browse-btn");
    const welcomeAboutBtn = document.getElementById("welcome-about-btn");

    // ── Exit button (toolbar) ────────────────────────────
    const btnExit = document.getElementById("btn-exit");
    if (btnExit) {
      btnExit.addEventListener("click", function () {
        window.__TAURI__
          .invoke("exit_app")
          .catch(function (e) { console.warn("Exit failed:", e); });
      });
    }

    function hideWelcome() {
      if (welcomeEl) welcomeEl.classList.add("hidden");
    }

    function showWelcome() {
      if (welcomeEl) welcomeEl.classList.remove("hidden");
    }

    // "Don't show again" only collapses the onboarding banner (🚀/title/star),
    // keeping the start page (drives, scan history, quick scan) visible.
    function hideOnboarding() {
      const ob = document.getElementById("welcome-onboarding");
      if (ob) ob.classList.add("hidden");
    }

    if (welcomeClose) {
      welcomeClose.addEventListener("click", function () {
        if (welcomeDont && welcomeDont.checked) {
          window.__TAURI__
            .invoke("save_settings", { settings: { welcome_dismissed: true } })
            .catch(function () {});
        }
        hideOnboarding();
      });
    }

    (async function () {
      try {
        const s = await window.__TAURI__.invoke("load_settings", {});
        if (s && s.welcome_dismissed) hideOnboarding();
      } catch (e) { console.debug("[DiskRaptor]", e); }
    })();

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

    // ── Focus trap for the about + settings modals ─────────
    // Activates whenever the overlay becomes visible (class .active or display
    // flex), so Tab/Shift+Tab stays inside the modal.
    (function initModalFocusTraps() {
      const aboutOv = document.getElementById("about-overlay");
      const settingsOv = document.getElementById("settings-overlay");
      const targets = [aboutOv, settingsOv].filter(Boolean);
      let untrap = null;

      function check() {
        const anyActive = targets.some(function (ov) {
          return (
            ov.classList.contains("active") ||
            (ov.style && ov.style.display === "flex")
          );
        });
        if (anyActive && !untrap) {
          const card = aboutOv && aboutOv.classList.contains("active")
            ? aboutOv
            : settingsOv;
          untrap = window.trapFocus ? window.trapFocus(card) : null;
        } else if (!anyActive && untrap) {
          untrap();
          untrap = null;
        }
      }

      targets.forEach(function (ov) {
        new MutationObserver(check).observe(ov, {
          attributes: true,
          attributeFilter: ["class", "style"],
        });
      });
      // Also trap while settings is toggled via style.display changes.
      check();
    })();

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
    // Apply saved default scan path first, falling back to home dir.
    try {
      const saved = await window.__TAURI__.invoke("load_settings");
      const savedPath =
        saved && saved.default_scan_path
          ? String(saved.default_scan_path)
          : "";
      if (savedPath && scanPath && !scanPath.value) {
        scanPath.value = savedPath;
      }
    } catch (e) { console.debug("[DiskRaptor]", e); }
    try {
      const home = await window.__TAURI__.invoke("get_home_dir");
      let homePath = null;
      if (typeof home === "string") {
        if (home.charAt(0) === "{") {
          try {
            const j = JSON.parse(home);
            if (j && j.data) homePath = String(j.data);
          } catch (e) { console.debug("[DiskRaptor]", e); }
        }
        if (!homePath) homePath = home;
      } else if (home && typeof home === "object") {
        homePath =
          typeof home.path === "string"
            ? home.path
            : home.data
              ? String(home.data)
              : null;
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

    // ── Scan history on the start page ──────────────────
    (async function renderStartHistory() {
      const wrap = document.getElementById("start-history");
      if (!wrap) return;
      try {
        const s = await window.__TAURI__.invoke("load_settings", {});
        const hist = Array.isArray(s && s.scan_history) ? s.scan_history : [];
        if (hist.length === 0) {
          wrap.style.display = "none";
          return;
        }
        let html =
          '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:600;display:flex;align-items:center;gap:8px;">' +
          "\uD83D\uDDD2 Scan History</div>";
        for (let hi = 0; hi < Math.min(hist.length, 8); hi++) {
          const p = String(hist[hi] || "");
          if (!p) continue;
          html +=
            '<div class="history-item" data-path="' +
            p.replace(/"/g, "&quot;") +
            '" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-primary);">' +
            '<span style="font-size:13px;">\uD83D\uDCC1</span>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") +
            "</span>" +
            "</div>";
        }
        wrap.innerHTML = html;
        wrap.querySelectorAll(".history-item").forEach(function (el) {
          el.addEventListener("click", function () {
            const p = el.dataset.path;
            if (!p) return;
            scanPath.value = p;
            if (btnScan) btnScan.click();
          });
        });
      } catch (e) {
        console.debug("[DiskRaptor]", e);
      }
    })();

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
      const scripts = [
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
      let loaded = 0;
      let failedAny = false;
      scripts.forEach(function (src) {
        var s = document.createElement("script");
        s.src = src;
        s.onload = function () {
          loaded++;
          if (loaded === scripts.length) check();
        };
        s.onerror = function () {
          failedAny = true;
          console.error("Failed to load galaxy script:", src);
          loaded++;
          if (loaded === scripts.length) check();
        };
        document.head.appendChild(s);
      });
      function check() {
        if (window.GalaxyView && window.GalaxyView.GalaxyView) {
          callback();
        } else if (failedAny) {
          console.error("GalaxyView: some scripts failed to load");
          callback();
        } else {
          setTimeout(check, 50);
        }
      }
      // Global timeout: never spin forever waiting for scripts.
      setTimeout(function () {
        if (!(window.GalaxyView && window.GalaxyView.GalaxyView)) {
          console.error("GalaxyView: timed out waiting for scripts");
          callback();
        }
      }, 15000);
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
          if (galaxyView) {
            try { galaxyView.hide(); } catch (e) { console.debug("[DiskRaptor]", e); }
            try { if (galaxyView.dispose) galaxyView.dispose(); } catch (e) { console.debug("[DiskRaptor]", e); }
            galaxyView = null;
          }
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
      const scanPathInput = document.getElementById("scan-path");
      const path =
        (scanPathInput && scanPathInput.value.trim()) ||
        (state.currentStats && state.currentStats.scanPath) ||
        "";
      if (!path) {
        window.__TAURI__
          .invoke("get_home_dir")
          .then(function (home) {
            const p =
              typeof home === "string" ? home : (home?.data || "");
            if (p) dupScanner.start(p);
          })
          .catch(function () {
            const fallback =
              typeof window.__TAURI__ !== "undefined" &&
              window.__TAURI__.path &&
              window.__TAURI__.path.homeDir;
            if (fallback) {
              fallback()
                .then(function (h) { if (h) dupScanner.start(String(h)); })
                .catch(function () {});
            } else {
              const t0 = window.__ || function (s) { return s; };
              window.showToast(t0("toast.select_folder_first"), "info");
            }
          });
      } else {
        dupScanner.start(path);
      }
    });

    // About dialog
    try {
      const v = await window.__TAURI__.invoke("get_app_info");
      const ver = v && v.version ? v.version : (v && v.data ? v.data.version : "");
      if (ver) {
        const el = document.querySelector(".about-version");
        if (el) {
          el.innerHTML =
            '<span data-i18n="about.version">Version</span> ' + ver;
        }
        const wsub = document.querySelector(".welcome-subtitle");
        if (wsub) {
          const sep = document.createElement("span");
          sep.style.cssText = "color:var(--text-muted);margin:0 6px;";
          sep.textContent = "·";
          const vspan = document.createElement("span");
          vspan.style.color = "var(--text-muted)";
          vspan.textContent = "v" + ver;
          wsub.appendChild(sep);
          wsub.appendChild(vspan);
        }
        const firstCh = document.querySelector(
          "#about-tab-changelog b",
        );
        if (firstCh) {
          firstCh.textContent = "v" + ver;
        }
      }
    } catch (e) {
      console.debug("Version fetch failed:", e);
    }

    // Load real GitHub release notes into the Changelog tab.
    (async function loadReleaseNotes() {
      const changelog = document.querySelector("#about-tab-changelog > div");
      if (!changelog) return;
      try {
        const res = await fetch(
          "https://api.github.com/repos/SunMe1977/DiskRaptor/releases?per_page=15",
        );
        const releases = await res.json();
        if (!Array.isArray(releases) || releases.length === 0) return;
        let html = "";
        for (let ri = 0; ri < releases.length; ri++) {
          const r = releases[ri];
          const tag = r.tag_name || "";
          const body = r.body || "";
          const date = (r.published_at || "").substring(0, 10);
          html +=
            "<div style='margin-bottom:12px;'>" +
            "<b style='color:var(--text-primary);'>" +
            escapeHtml(tag) +
            "</b>" +
            (date ? " <span style='color:var(--text-muted);font-size:10px;'>" + date + "</span>" : "") +
            "<div style='white-space:pre-wrap;word-break:break-word;margin-top:4px;'>" +
            (body ? escapeHtml(body) : "") +
            "</div></div>";
        }
        changelog.innerHTML = html;
      } catch (e) {
        // Keep the static fallback changelog if the network call fails.
        console.debug("Release notes fetch failed:", e);
      }
    })();

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
    if (aboutClose) {
      aboutClose.addEventListener("click", function () {
        aboutOverlay.classList.remove("active");
      });
    }
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
    let _currentVersion = "";
    try {
      const vv = await window.__TAURI__.invoke("get_app_info");
      _currentVersion = vv && vv.version ? (vv.version || "") : (vv && vv.data ? (vv.data.version || "") : "");
    } catch (e) { console.debug("[DiskRaptor]", e); }
    // Deferred external links (replaces inline onclick handlers so script CSP
    // does not need 'unsafe-inline').
    document.addEventListener("click", function (ev) {
      const target = ev.target && ev.target.closest
        ? ev.target.closest("[data-open-url]")
        : null;
      if (!target) return;
      const url = target.getAttribute("data-open-url");
      if (!url) return;
      ev.preventDefault();
      window.__TAURI__.invoke("open_url", { url: url }).catch(function () {});
    });
    const aboutLogo = document.getElementById("about-logo-img");
    if (aboutLogo) {
      aboutLogo.addEventListener("error", function () {
        aboutLogo.style.display = "none";
      });
    }
    const updateCheckEl = document.getElementById("about-update-check");
    if (updateCheckEl) {
      // Store builds (Mac App Store) update via the store. The About entry
      // becomes a button that opens the DiskRaptor page in the Mac App Store
      // app (macOS routes apps.apple.com URLs to the App Store app).
      if (updateCheckEl.getAttribute("data-store") === "true") {
        updateCheckEl.textContent = "\u{1F3EC} Open in Mac App Store";
        updateCheckEl.style.color = "var(--accent-green)";
        updateCheckEl.style.cursor = "pointer";
        updateCheckEl.style.textDecoration = "underline";
        updateCheckEl.addEventListener("click", function () {
          window.__TAURI__.invoke("open_url", {
            url: "https://apps.apple.com/us/app/diskraptor/id6793462969?mt=12",
          }).catch(function () {});
        });
      } else {
        updateCheckEl.addEventListener("click", function () {
          window.__checkUpdate();
        });
      }
    }
    window.__checkUpdate = async function () {
      const el = document.getElementById("about-update-check");
      const openPopup = function (contentHtml, clickHandler) {
        const overlay = document.createElement("div");
        overlay.style.cssText =
          "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);" +
          "display:flex;align-items:center;justify-content:center;";
        const card = document.createElement("div");
        card.style.cssText =
          "background:var(--bg-secondary,#1c2128);border:1px solid var(--border,#30363d);" +
          "border-radius:12px;max-width:420px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,0.5);" +
          "overflow:hidden;text-align:center;";
        const body = document.createElement("div");
        body.style.cssText =
          "padding:22px 24px;font-size:13px;color:var(--text-primary,#e6edf3);" +
          "line-height:1.6;word-break:break-word;";
        body.innerHTML = contentHtml;
        const footer = document.createElement("div");
        footer.style.cssText =
          "padding:10px 16px;border-top:1px solid var(--border,#30363d);" +
          "display:flex;justify-content:flex-end;gap:8px;";
        const btnClose = document.createElement("button");
        btnClose.textContent = "Close";
        btnClose.style.cssText =
          "padding:7px 16px;border-radius:6px;font-size:13px;cursor:pointer;" +
          "border:1px solid var(--border,#30363d);background:var(--bg-tertiary,#161b22);color:var(--text-primary);";
        btnClose.addEventListener("click", close);
        footer.appendChild(btnClose);
        if (clickHandler) {
          const btnAction = document.createElement("button");
          btnAction.textContent = "⬇ Download";
          btnAction.style.cssText =
            "padding:7px 16px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border,#30363d);" +
            "background:linear-gradient(135deg,#238636,var(--accent-green,#2ea043));color:#fff;font-weight:600;";
          btnAction.addEventListener("click", function () { clickHandler(); });
          footer.insertBefore(btnAction, btnClose);
        }
        function close() {
          document.removeEventListener("keydown", onKey);
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }
        function onKey(e) { if (e.key === "Escape") close(); }
        document.addEventListener("keydown", onKey);
        card.appendChild(body);
        card.appendChild(footer);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        return { close: close, body: body };
      };

      // Store builds (MAS/MSIX) distribute updates via the store itself, so do
      // not contact GitHub. On the Mac App Store build, open the App Store page
      // instead of checking (macOS opens the App Store app for apps.apple.com).
      const disableUpdates =
        el && el.getAttribute("data-store") === "true";
      if (disableUpdates) {
        window.__TAURI__.invoke("open_url", {
          url: "https://apps.apple.com/us/app/diskraptor/id6793462969?mt=12",
        }).catch(function () {});
        return;
      }

      // Show a popup with live status instead of only inline text.
      const popup = openPopup(
        "<div id='upd-status' style='font-size:14px;'>" +
          "<div style='font-size:18px;margin-bottom:6px;'>🔍</div>" +
          "<b>Checking for updates…</b>" +
          "<div id='upd-sub' style='margin-top:6px;color:var(--text-secondary);font-size:12px;'>Contacting GitHub…</div>" +
          "</div>",
      );
      const setStatus = function (icon, title, sub, isSuccess) {
        const st = popup.body.querySelector("#upd-status");
        if (!st) return;
        st.innerHTML =
          "<div style='font-size:18px;margin-bottom:6px;'>" + icon + "</div>" +
          "<b style='color:" + (isSuccess ? "var(--accent-green)" : "inherit") + "'>" + title + "</b>" +
          (sub ? "<div style='margin-top:6px;color:var(--text-secondary);font-size:12px;'>" + sub + "</div>" : "");
      };

      const current = _currentVersion || "0.0.0";
      try {
        // Prefer the native check (knows installed version, does the network call off the UI thread).
        const res = await window.__TAURI__.invoke("check_for_updates");
        const data = res && res.data ? res.data : res;
        const latest = data && data.latest ? String(data.latest) : "";
        if (latest && latest !== current) {
          const platform = (navigator.platform || "").toLowerCase();
          const isMac = platform.indexOf("mac") === 0;
          const isWin = platform.indexOf("win") === 0;
          const asset =
            isMac
              ? "DiskRaptor-" + latest + "-macos-universal.dmg"
              : isWin
                ? "DiskRaptor-" + latest + "-windows-x64.exe"
                : "DiskRaptor-" + latest + "-linux-x86_64.AppImage";
          const dl =
            "https://github.com/SunMe1977/DiskRaptor/releases/download/v" +
            latest +
            "/" +
            asset;
          setStatus(
            "⬇️",
            "Update available: v" + latest,
            "You are on v" + current + ". Download the latest version below.",
            true,
          );
          const btn = document.createElement("button");
          btn.textContent = "⬇ Download v" + latest;
          btn.style.cssText =
            "margin-top:14px;padding:9px 18px;border-radius:8px;font-size:13px;cursor:pointer;border:none;" +
            "background:linear-gradient(135deg,#238636,var(--accent-green,#2ea043));color:#fff;font-weight:600;";
          btn.addEventListener("click", function () {
            window.__TAURI__.invoke("open_url", { url: dl }).catch(function () {});
          });
          popup.body.appendChild(btn);
          if (el) {
            el.textContent = "\u2B07\uFE0F Install v" + latest;
            el.style.color = "var(--accent-orange)";
            el.style.cursor = "pointer";
            el.style.textDecoration = "underline";
            el.onclick = function () {
              window.__TAURI__.invoke("open_url", { url: dl }).catch(function () {});
            };
          }
        } else {
          setStatus(
            "✅",
            "No update needed",
            "You are on the latest version (v" + current + ").",
            true,
          );
          if (el) {
            el.textContent = "\u2705 No update available (v" + current + ")";
            el.style.color = "var(--accent-green)";
            el.style.cursor = "default";
            el.style.textDecoration = "none";
            el.onclick = null;
          }
        }
      } catch (e) {
        // Fallback: query GitHub directly from the frontend.
        try {
          const r = await fetch(
            "https://api.github.com/repos/SunMe1977/DiskRaptor/releases/latest",
          );
          const d2 = await r.json();
          const latest2 = (d2.tag_name || "").replace(/^v/, "");
          if (latest2 && latest2 !== current) {
            const platform = (navigator.platform || "").toLowerCase();
            const isMac = platform.indexOf("mac") === 0;
            const isWin = platform.indexOf("win") === 0;
            const asset =
              isMac
                ? "DiskRaptor-" + latest2 + "-macos-universal.dmg"
                : isWin
                  ? "DiskRaptor-" + latest2 + "-windows-x64.exe"
                  : "DiskRaptor-" + latest2 + "-linux-x86_64.AppImage";
            const dl =
              "https://github.com/SunMe1977/DiskRaptor/releases/download/v" +
              latest2 +
              "/" +
              asset;
            setStatus(
              "⬇️",
              "Update available: v" + latest2,
              "You are on v" + current + ". Download the latest version below.",
              true,
            );
            const btn = document.createElement("button");
            btn.textContent = "⬇ Download v" + latest2;
            btn.style.cssText =
              "margin-top:14px;padding:9px 18px;border-radius:8px;font-size:13px;cursor:pointer;border:none;" +
              "background:linear-gradient(135deg,#238636,var(--accent-green,#2ea043));color:#fff;font-weight:600;";
            btn.addEventListener("click", function () {
              window.__TAURI__.invoke("open_url", { url: dl }).catch(function () {});
            });
            popup.body.appendChild(btn);
          } else {
            setStatus(
              "✅",
              "No update needed",
              "You are on the latest version (v" + current + ").",
              true,
            );
          }
        } catch (e2) {
          setStatus(
            "⚠️",
            "Update check failed",
            "Could not reach GitHub. Check your internet connection.",
            false,
          );
        }
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

      langFilter.addEventListener("input", window.debounce(function () {
        renderLangs(this.value);
      }, 150));

      document.addEventListener("click", function (e) {
        if (!e.target.closest(".lang-dropdown-wrap")) {
          langMenu.classList.remove("active");
        }
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") langMenu.classList.remove("active");
      });

      // Arrow-key navigation through the language list; Enter selects.
      langMenu.addEventListener("keydown", function (e) {
        const items = langMenu.querySelectorAll(".lang-item");
        if (items.length === 0) return;
        let idx = Array.prototype.indexOf.call(items, document.activeElement);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          items[Math.min(idx + 1, items.length - 1)].focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          items[Math.max(idx - 1, 0)].focus();
        } else if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (idx >= 0) items[idx].click();
        }
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

    // Menu events from Tauri (handled natively via Rust eval)

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
            } catch (e) { console.debug("[DiskRaptor]", e); }
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

    console.debug("DiskRaptor ready.");
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
        sb.textContent = "Init error: " + (err && err.message ? err.message : err);
        sb.style.color = "var(--accent-red)";
      }
      // Offer a retry dialog so the user isn't left staring at a dead window.
      window.alertDialog(
        "DiskRaptor failed to initialize.\n\n" +
          (err && err.message ? err.message : String(err)) +
          "\n\nClick OK to reload the app, or close this dialog to continue.",
      ).then(function (ok) {
        if (ok) window.location.reload();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", safeInit);
  } else {
    safeInit();
  }

  // Global error handlers: surface uncaught errors instead of a silent blank UI.
  window.addEventListener("error", function (e) {
    if (window.showToast) {
      window.showToast("Unexpected error: " + (e.message || "unknown"), "error");
    }
  });
  window.addEventListener("unhandledrejection", function (e) {
    if (window.showToast) {
      const msg = e && e.reason && e.reason.message ? e.reason.message : String(e && e.reason);
      window.showToast("Unhandled: " + msg.substring(0, 120), "error");
    }
  });
})();
