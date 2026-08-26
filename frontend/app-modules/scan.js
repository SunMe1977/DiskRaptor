(function () {
  "use strict";
  window.app = window.app || {};

  // Pure helpers kept outside the scan handler so it stays focused on flow.
  function formatBytesPerSec(bps) {
    return window.fmtSpeed(bps);
  }

  function speedColor(ratio) {
    if (ratio > 0.8) return "#f85149";
    if (ratio > 0.4) return "#3fb950";
    return "#d29922";
  }

  function escLive(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // After a scan, append the scanned drive's free space to the status bar.
  function updateFreeSpaceStatus(path) {
    window.__TAURI__
      .invoke("list_drives", {})
      .then(function (res) {
        const drives = Array.isArray(res) ? res : (res && res.data ? res.data : []);
        const p = String(path || "").replace(/\\/g, "/").toLowerCase();
        let best = null;
        drives.forEach(function (d) {
          const root = String(d.path || d.id || "").replace(/\\/g, "/").toLowerCase();
          if (!root) return;
          if (p.indexOf(root) === 0) {
            if (!best || root.length > best.root.length) best = { root: root, d: d };
          }
        });
        if (!best || best.d.free_bytes == null) return;
        const fmt = window.fmtSize || function (b) { return b; };
        const free = best.d.free_bytes;
        const total = best.d.total_bytes || 0;
        const stb = document.querySelector(".status-bar");
        if (!stb) return;
        const extra = total > 0
          ? "Free: " + fmt(free) + " / " + fmt(total)
          : "Free: " + fmt(free);
        stb.textContent = stb.textContent + " \u00b7 " + extra;
      })
      .catch(function () {});
  }

  window.app.initScan = function (refs) {
    const state = window.app.state;

    const {
      loader,
      treeView,
      diagram,
      topFiles,
      statsPanel,
      scanPath,
      btnBrowse,
      btnScan,
      btnRescan,
      btnCancel,
      btnExport,
      progressOverlay,
      progressPath,
      chkFollow,
      errDisplay,
      hideWelcome,
      sleep,
    } = refs;

    // Scan
    btnScan.addEventListener("click", async function () {
      if (state.isScanning) {
        // A scan is already running (e.g. user switched to another folder or
        // trash while a previous scan was in flight). Cancel it first, then
        // wait for the old scan loop's finally to release the UI, so the new
        // path actually scans instead of silently doing nothing.
        try {
          await window.__TAURI__.invoke("cancel_scan", {});
        } catch (e) { console.debug("[DiskRaptor]", e); }
        for (let ci = 0; ci < 25; ci++) {
          await sleep(200);
          try {
            const sp = await window.__TAURI__.invoke("get_scan_progress", {
              scanId: state.currentScanId,
            });
            if (sp && !sp.is_running) break;
          } catch (e) {
            break;
          }
        }
        const cancelDeadline = Date.now() + 8000;
        while (state.isScanning && Date.now() < cancelDeadline) {
          await sleep(100);
        }
      }

      let path = scanPath.value.trim().replace(/^["']+|["']+$/g, "");
      if (!path) {
        const t = window.__ || function (s) { return s; };
        window.showToast(t("toast.need_path"), "error");
        return;
      }

      state.isScanning = true;
      btnScan.disabled = true;
      if (btnRescan) btnRescan.disabled = true;
      btnBrowse.disabled = true;
      btnCancel.disabled = false;
      btnExport.disabled = true;

      // Save to scan history
      (async function () {
        try {
          const s = await window.__TAURI__.invoke("load_settings", {});
          let hist = (s && s.scan_history) || [];
          if (path && hist[0] !== path) {
            hist = [path]
              .concat(
                hist.filter(function (h) {
                  return h !== path;
                }),
              )
              .slice(0, 10);
            await window.__TAURI__.invoke("save_settings", {
              settings: { scan_history: hist },
            });
          }
        } catch (e) { console.debug("[DiskRaptor]", e); }
      })();

      // Multi-path: if path contains semicolons, scan each separately
      const paths = path
        .split(";")
        .map(function (p) {
          return p.trim();
        })
        .filter(function (p) {
          return p;
        });
      if (paths.length > 1) {
        path = paths[0];
        window.__pendingScans = paths.slice(1);
      }

      const engineEl = document.getElementById("progress-engine");
      if (engineEl) {
        const tc = navigator.hardwareConcurrency || 4;
        engineEl.textContent = (window.__ || function (s) { return s; })(
          "progress.engine_text",
        ).replace("{threads}", tc);
      }

      // Trigger any pending macOS permission prompts up-front (before the
      // scanner actually touches protected folders mid-scan) and give the user
      // plenty of time to answer them: while a TCC dialog is open the scanner
      // threads block, so a short timeout would otherwise kill the scan.
      window.__TAURI__
        .invoke("request_permissions", { path: path })
        .catch(function () {});

      const followLinks = chkFollow.querySelector("input").checked;

      const safetyTimer = setTimeout(function () {
        // A scan that runs this long without the poll loop finishing is stuck
        // (e.g. a network drive that never answers). Hide the overlay AND tell
        // the backend to stop so we don't leave a zombie scan running.
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
        window.__TAURI__.invoke("cancel_scan", {}).catch(function () {});
      }, 1800000);

      // Progress elements
      const progressFilesEl = document.getElementById("progress-files");
      const progressDirsEl = document.getElementById("progress-dirs");
      const progressSpeedValEl = document.getElementById("progress-speed-val");
      const progressElapsedValEl = document.getElementById(
        "progress-elapsed-val",
      );
      const progressDirEl = document.getElementById("progress-dir");
      const speedChartCanvas = document.getElementById("speed-chart");
      const speedChartCtx = speedChartCanvas
        ? speedChartCanvas.getContext("2d")
        : null;
      const speedSamples = [];
      const maxSamples = 40;

      function drawSpeedChart() {
        if (!speedChartCtx) return;
        speedChartCanvas.width =
          speedChartCanvas.clientWidth || speedChartCanvas.width;
        const w = speedChartCanvas.width;
        const h = speedChartCanvas.height;
        const ctx = speedChartCtx;
        ctx.clearRect(0, 0, w, h);
        if (speedSamples.length < 2) return;
        const maxBps =
          Math.max.apply(
            null,
            speedSamples.map(function (s) {
              return s.bps;
            }),
          ) || 1;
        const pad = 4;
        const cw = w - pad * 2;
        const ch = h - pad * 2;
        const step = cw / Math.max(speedSamples.length - 1, 1);

        ctx.fillStyle = "rgba(255,255,255,0.3)";
        ctx.font = "8px monospace";
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        (function fmtSpeed(bps) {
          return (
            (bps / 1024 / 1024).toFixed(bps > 1048576 ? 0 : 1) + " MB/s"
          );
        });
        ctx.fillText(
          (function (bps) {
            return (
              (bps / 1024 / 1024).toFixed(bps > 1048576 ? 0 : 1) + " MB/s"
            );
          })(maxBps),
          w - 4,
          pad + 2,
        );
        ctx.fillText("0 MB/s", w - 4, h - pad - 2);

        for (let si = 0; si < speedSamples.length; si++) {
          const sx = pad + si * step;
          const sy =
            pad + ch - (speedSamples[si].bps / maxBps) * ch;
          const ratio = speedSamples[si].bps / maxBps;
          ctx.fillStyle = speedColor(ratio);
          ctx.globalAlpha = 0.15;
          ctx.fillRect(sx - step / 2, sy, step, h - pad - sy);
        }
        ctx.globalAlpha = 1;

        ctx.shadowColor = "rgba(0,0,0,0.4)";
        ctx.shadowBlur = 3;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        for (let si = 0; si < speedSamples.length - 1; si++) {
          const sx1 = pad + si * step;
          const sy1 =
            pad + ch - (speedSamples[si].bps / maxBps) * ch;
          const sx2 = pad + (si + 1) * step;
          const sy2 =
            pad + ch - (speedSamples[si + 1].bps / maxBps) * ch;
          const ratio =
            (speedSamples[si].bps + speedSamples[si + 1].bps) /
            2 /
            maxBps;
          ctx.beginPath();
          ctx.moveTo(sx1, sy1);
          ctx.lineTo(sx2, sy2);
          ctx.strokeStyle = speedColor(ratio);
          ctx.stroke();
        }
        ctx.shadowBlur = 0;

        const current = speedSamples[speedSamples.length - 1];
        if (current) {
          const cx = w / 2;
          const cy = h / 2;
          const mbps = current.bps / (1024 * 1024);
          const mbColor =
            mbps > 100
              ? "#3fb950"
              : mbps > 30
                ? "#d29922"
                : "#e6edf3";
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
          ctx.fillText(
            Math.round(current.fps).toLocaleString() + " files/sec",
            cx,
            cy + 18,
          );
          ctx.shadowBlur = 0;
        }

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
      const scanHint = document.getElementById("scan-hint");
      if (scanHint) {
        scanHint.textContent = "Tip: press Ctrl/Cmd+Enter to start a scan quickly";
      }

      progressFilesEl.textContent = "0";
      progressDirsEl.textContent = "0";
      progressSpeedValEl.textContent = "";
      progressElapsedValEl.textContent = "0s";
      const etaReset = document.getElementById("progress-eta-val");
      if (etaReset) etaReset.textContent = "\u2014";
      progressDirEl.textContent = "";
      speedSamples.length = 0;
      let unlisten = null;

      let lastLiveRender = 0;

      function renderLiveTree(entries) {
        const now = Date.now();
        if (now - lastLiveRender < 400) return;
        lastLiveRender = now;
        const scrollEl = document.getElementById("tree-scroll");
        let live = document.getElementById("live-tree");
        if (!live) {
          live = document.createElement("div");
          live.id = "live-tree";
          live.style.cssText =
            "position:absolute;inset:0;overflow-y:auto;background:var(--bg-primary);z-index:5;padding:8px 12px;font-size:12px;";
          if (scrollEl) scrollEl.appendChild(live);
        }
        const arr = Array.isArray(entries) ? entries : [];
        let html =
          '<div style="color:var(--text-muted);font-size:11px;margin-bottom:6px;">\u23F3 Live scan\u2026 ' +
          arr.length +
          ' items so far</div>';
        const shown = arr.slice(-500);
        for (let i = shown.length - 1; i >= 0; i--) {
          html +=
            '<div style="display:flex;align-items:center;gap:6px;padding:2px 0;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">\uD83D\uDCC4 <span>' +
            escLive(shown[i]) +
            "</span></div>";
        }
        live.innerHTML = html;
      }

      function hideLiveTree() {
        const live = document.getElementById("live-tree");
        if (live) live.remove();
      }

      // Clickable "⚠ N errors" badge in the tree header; opens a detail list.
      function showErrorBadge(errs) {
        const header = document.querySelector("#tree-panel .panel-header");
        const old = document.getElementById("scan-error-badge");
        if (old) old.remove();
        const badge = document.createElement("button");
        badge.id = "scan-error-badge";
        badge.title = "Click to view errors";
        badge.style.cssText =
          "margin-left:8px;padding:3px 9px;font-size:11px;border:1px solid rgba(248,81,73,0.4);border-radius:12px;" +
          "background:rgba(248,81,73,0.12);color:var(--accent-red);cursor:pointer;flex-shrink:0;font-weight:600;";
        badge.textContent = "\u26A0 " + errs.length + " errors";
        header.appendChild(badge);
        badge.addEventListener("click", function () {
          const overlay = document.createElement("div");
          overlay.style.cssText =
            "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;";
          const card = document.createElement("div");
          card.style.cssText =
            "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;max-width:560px;width:92%;" +
            "max-height:80vh;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.5);display:flex;flex-direction:column;";
          const esc = window.escHtml || function (x) { return String(x); };
          let rows = "";
          const shown = errs.slice(0, 200);
          for (let i = 0; i < shown.length; i++) {
            rows +=
              '<div style="padding:6px 10px;font-size:12px;font-family:var(--font-mono);color:var(--text-secondary);border-bottom:1px solid var(--border-light);word-break:break-all;">' +
              esc(String(shown[i])) +
              "</div>";
          }
          if (errs.length > 200)
            rows +=
              '<div style="padding:6px 10px;font-size:11px;color:var(--text-muted);text-align:center;">+' +
              (errs.length - 200) +
              " more</div>";
          card.innerHTML =
            '<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">' +
            '<span style="font-size:14px;font-weight:600;">\u26A0 Scan errors (' + errs.length + ")</span>" +
            '<button class="sb-close" aria-label="Close" style="padding:3px 9px;font-size:14px;border:none;background:none;color:var(--text-muted);cursor:pointer;">\u2715</button></div>' +
            '<div style="flex:1;overflow-y:auto;padding:8px 0;">' + rows + "</div>";
          overlay.appendChild(card);
          document.body.appendChild(overlay);
          card.querySelector(".sb-close").onclick = function () { overlay.remove(); };
          overlay.addEventListener("click", function (e) {
            if (e.target === overlay) overlay.remove();
          });
        });
      }

      try {
        const initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
          follow_symlinks: followLinks,
          timeout_secs: 120,
        });
        if (initScan && initScan.error) {
          throw new Error(initScan.error);
        }
        const scanId = (initScan && initScan.scan_id) || 1;
        state.currentScanId = scanId;

        let lastFilesFound = 0;
        let lastDirsFound = 0;
        const pollStartTime = Date.now();

        let zeroCount = 0;
        let scanDone = false;
        let emaRate = 0;
        let uiRaf = null;
        let pendingUi = null;
        let _lastProgressRender = 0;

        function onProgress(p) {
          if (scanDone) return;
          if (!p) return;

          // Throttle DOM-heavy rendering to ~15 fps; the raw counter fields
          // still update cheaply on every event.
          const now = Date.now();
          if (now - _lastProgressRender < 66) {
            lastFilesFound = Number(p.files_found || p.filesFound || 0);
            lastDirsFound = Number(p.dirs_found || p.dirsFound || 0);
            return;
          }
          _lastProgressRender = now;

          const rawDisplay = document.getElementById("progress-raw");
          if (rawDisplay) {
            try {
              rawDisplay.textContent =
                "raw: " + JSON.stringify(p).substring(0, 150);
            } catch (e) { console.debug("[DiskRaptor]", e); }
          }

          const filesFound = Number(p.files_found || p.filesFound || 0);
          const dirsFound = Number(p.dirs_found || p.dirsFound || 0);
          const bytesFound = Number(p.bytes_found || p.bytesFound || 0);
          const elapsedSecs = p.elapsed_secs || p.elapsedSecs || 0;
          lastFilesFound = filesFound;
          lastDirsFound = dirsFound;

          if (filesFound === 0 && dirsFound === 0) {
            zeroCount++;
            if (zeroCount === 10) {
              console.warn(
                "Scan showing 0 files after 5s, raw:",
                JSON.stringify(p).substring(0, 200),
              );
              if (rawDisplay) rawDisplay.style.display = "block";
            }
          } else {
            zeroCount = 0;
          }

          progressFilesEl.textContent = filesFound.toLocaleString("en-US");
          progressDirsEl.textContent = dirsFound.toLocaleString("en-US");

          const mins = Math.floor(elapsedSecs / 60);
          const secs = elapsedSecs % 60;
          const elapsedStr =
            (mins < 10 ? "0" : "") +
            mins +
            ":" +
            (secs < 10 ? "0" : "") +
            secs;
          progressElapsedValEl.textContent = elapsedStr;

          if (elapsedSecs > 0 && filesFound > 0) {
            const bytesPerSec = bytesFound / elapsedSecs;
            const mbPerSec = bytesPerSec / (1024 * 1024);
            progressSpeedValEl.textContent =
              mbPerSec.toFixed(mbPerSec < 10 ? 2 : 1) + " MB/s";
            progressSpeedValEl.style.color =
              mbPerSec > 100
                ? "#3fb950"
                : mbPerSec > 30
                  ? "#d29922"
                  : "#8b949e";
          } else {
            progressSpeedValEl.textContent = "\u2014";
            progressSpeedValEl.style.color = "#8b949e";
          }

          // EMA-smoothed scan rate for a stable ETA (less wild fluctuation).
          const instRate = elapsedSecs > 0 ? filesFound / elapsedSecs : 0;
          if (instRate > 0) {
            emaRate = emaRate === 0 ? instRate : emaRate * 0.8 + instRate * 0.2;
          }

          // Throttle the expensive UI updates (speed chart, % bar, ETA, stats
          // panel) to once per animation frame so millions of progress events
          // don't overwhelm the renderer.
          pendingUi = { filesFound: filesFound, dirsFound: dirsFound, bytesFound: bytesFound, elapsedSecs: elapsedSecs, liveEntries: p.live_entries };
          if (!uiRaf) {
            uiRaf = requestAnimationFrame(function () {
              uiRaf = null;
              const u = pendingUi;
              pendingUi = null;
              if (!u) return;
              if (u.elapsedSecs > 0 && u.filesFound > 0) {
                const fps = u.filesFound / u.elapsedSecs;
                const bps = u.bytesFound / u.elapsedSecs;
                speedSamples.push({ fps: fps, bps: bps });
                if (speedSamples.length > maxSamples) speedSamples.shift();
                drawSpeedChart();
              }
              const pctBar = document.getElementById("progress-pct-bar");
              const pctText = document.getElementById("progress-pct-text");
              if (pctBar && pctText) {
                const pct = Math.min(95, Math.max(1, u.elapsedSecs > 5
                  ? Math.min(95, (u.filesFound / Math.max(1, u.filesFound + u.dirsFound)) * 50 + (u.elapsedSecs / 1200) * 50)
                  : (u.filesFound / 5000) * 20));
                pctBar.style.width = pct + "%";
                pctText.textContent = Math.round(pct) + "%";
              }
              const ratio = u.filesFound / Math.max(1, u.filesFound + u.dirsFound);
              if (u.elapsedSecs > 5 && ratio > 0 && emaRate > 0) {                const projectedTotal = u.filesFound / ratio;
                const filesLeft = Math.max(0, projectedTotal - u.filesFound);
                const remaining = Math.max(0, Math.min(36000, filesLeft / emaRate));
                if (isFinite(remaining) && !isNaN(remaining)) {
                  const etaM = Math.floor(remaining / 60);
                  const etaS = Math.floor(remaining % 60);
                  const etaEl = document.getElementById("progress-eta-val");
                  if (etaEl)
                    etaEl.textContent =
                      (etaM < 10 ? "0" : "") + etaM + ":" + (etaS < 10 ? "0" : "") + etaS;
                }
              }
              statsPanel.updateLive(u.filesFound, u.dirsFound, u.elapsedSecs);
              if (u.liveEntries) renderLiveTree(u.liveEntries);
            });
          }

          if (p.error_count > 0 && errDisplay) {
            const errMsg = p.last_error || "";
            const escErr = String(errMsg.substring(0, 80))
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;");
            errDisplay.innerHTML =
              '\uD83D\uDD12 <strong>' +
              p.error_count +
              '</strong> permission denied \u2014 ' +
              escErr +
              ' <span style="color:var(--text-muted);font-size:11px;">Some folders could not be scanned.</span> ' +
              ' <button class="retry-admin-btn" data-path="' +
              encodeURIComponent(path) +
              '">Run with elevated permissions</button>';
            errDisplay.style.display = "block";
            var adminBtn = errDisplay.querySelector(".retry-admin-btn");
            if (adminBtn && !adminBtn._listener) {
              adminBtn._listener = true;
              adminBtn.addEventListener("click", async function () {
                this.disabled = true;
                this.textContent = "Restarting...";
                try {
                  await window.__TAURI__.invoke("restart_as_admin", {});
                } catch (e) {
                  this.textContent = "Failed: " + e.message;
                }
              });
            }
          } else if (errDisplay) {
            errDisplay.style.display = "none";
          }

          let dirInfo = "";
          if (p.current_dir || p.currentDir) {
            const dir = p.current_dir || p.currentDir;
            const parts = dir.split("\\");
            dirInfo = parts[parts.length - 1];
            progressDirEl.textContent = "\uD83D\uDCC2 " + dirInfo;
          }

          const isRunning =
            p.is_running !== undefined ? p.is_running : true;
          const isDone = p.phase === 3 || !isRunning;
          if (isDone) {
            scanDone = true;
          }
        }

        unlisten = null;

        let done = false;
        // The backend also emits scan:progress events, but they only carry raw
        // counters — fetching the full payload per event doubles IPC traffic.
        // Poll get_scan_progress at 1 Hz instead: one roundtrip, everything the
        // progress UI needs (phase, is_running, live_entries, errors...).
        for (let i = 0; i < 600; i++) {
          await sleep(1000);
          if (scanDone) {
            done = true;
            break;
          }
          const p = await window.__TAURI__
            .invoke("get_scan_progress", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (p) {
            onProgress(p);
            // Backend reports the scan as finished — stop polling early.
            if (p.is_running === false && p.phase >= 3) {
              done = true;
              break;
            }
          }
        }

        if (!done) throw new Error("Scan timeout");

        progressSpeedValEl.textContent = "\u2713";

        let result = null;
        for (let ri = 0; ri < 20; ri++) {
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

        // A partial scan must never be presented as complete.
        const term = result && result.stats ? result.stats.termination : "";
        if (term && term !== "completed") {
          const msg =
            term === "cancelled"
              ? "Scan was cancelled - results are partial"
              : term === "timed_out"
                ? "Scan timed out - results are partial"
                : term === "limit_reached"
                  ? "Scan hit the size limit - results are partial"
                  : "Scan was interrupted - results are partial";
          window.showToast(msg, "warning");
        }

        if (result && result.stats && result.stats.total_files > 0) {
          state.currentScanResult = result;
          state.currentStats = result.stats;
          statsPanel.render(result.stats);
          diagram.setData(result.stats);
          const files = Number(
            result.stats.total_files || 0,
          ).toLocaleString("en-US");
          const dirs = Number(
            result.stats.total_dirs || 0,
          ).toLocaleString("en-US");
          const t = window.__ || function (s) { return s; };
          document.querySelector(".status-bar").textContent = t(
            "status.complete",
          )
            .replace("{files}", files)
            .replace("{dirs}", dirs);
          topFiles.render(
            result.stats ? result.stats.top_files : [],
            true,
          );
        } else {
          const fbStats = {
            total_files: lastFilesFound || 0,
            total_dirs: lastDirsFound || 0,
            total_size: 0,
            scan_time_ms: Date.now() - pollStartTime,
            top_files: [],
            file_type_breakdown: [],
          };
          state.currentStats = fbStats;
          statsPanel.render(fbStats);
          diagram.setData(fbStats);
          const totalSecs = Math.floor(
            (Date.now() - pollStartTime) / 1000,
          );
          const em = Math.floor(totalSecs / 60);
          const es = totalSecs % 60;
          progressElapsedValEl.textContent =
            (em < 10 ? "0" : "") + em + ":" + (es < 10 ? "0" : "") + es;
          const t = window.__ || function (s) { return s; };
          const isTrashPath =
            /recycle/i.test(path) || /\$recycle\.bin/i.test(path);
          document.querySelector(".status-bar").textContent = isTrashPath
            ? t("trash.empty")
            : t("status.complete")
                .replace(
                  "{files}",
                  lastFilesFound.toLocaleString(),
                )
                .replace(
                  "{dirs}",
                  lastDirsFound.toLocaleString(),
                );
          topFiles.render([], true);
        }

        let hadChunks = false;
        hideLiveTree();

        updateFreeSpaceStatus(path);

        if (
          result &&
          result.root_info &&
          result.root_info.total_chunks > 0 &&
          result.root_info.total_nodes > 0
        ) {
          loader.prepare(
            result.root_info.total_nodes,
            result.root_info.total_chunks,
            scanId,
          );

          try {
            await loader.loadChunk(0);
            hadChunks = true;
          } catch (e) {
            console.warn("Chunk 0:", e);
          }
          treeView.expanded.add(0);
          try {
            await treeView.rebuild();
          } catch (e) { console.debug("[DiskRaptor]", e); }
          showCleanupPanel();
        }

        // If the scan reported errors (e.g. permission denied, or the scan
        // thread failed), surface them via a clickable badge that opens a
        // detail list instead of a silent empty tree.
        try {
          const prog2 = await window.__TAURI__.invoke("get_scan_progress", { scanId: scanId });
          const errs = (prog2 && prog2.data && prog2.data.errors) ||
                       (prog2 && prog2.errors) || [];
          if (Array.isArray(errs) && errs.length > 0) {
            const first = String(errs[0]);
            document.querySelector(".status-bar").textContent =
              "Scan finished with errors: " + first.substring(0, 200);
            if (window.showToast) {
              window.showToast("Scan errors: " + first.substring(0, 160), "warning");
            }
            showErrorBadge(errs);
          }
        } catch (e) { console.debug("[DiskRaptor]", e); }

        if (
          !hadChunks &&
          state.currentStats &&
          state.currentStats.total_files > 0
        ) {          try {
            const rootNode = {
              name: scanPath.value,
              size: state.currentStats.total_size || 0,
              file_count: state.currentStats.total_files || 0,
              dir_count: state.currentStats.total_dirs || 0,
              node_type: 0,
              parent: 4294967295,
              first_child: 4294967295,
              next_sibling: 4294967295,
              depth: 0,
              chunk_id: 0,
              _arenaIndex: 0,
            };
            loader.prepare(1, 0, scanId);
            loader.allNodes = [rootNode];
            treeView.expanded.add(0);
            try {
              await treeView.rebuild();
            } catch (e) { console.debug("[DiskRaptor]", e); }
          } catch (e) {
            console.warn("Synthetic root:", e);
          }
          showCleanupPanel();
        }

        function showCleanupPanel() {
          const spv = (scanPath && scanPath.value) || "";
          if (spv.toLowerCase().indexOf("download") < 0) return;

          const isMac = /mac/i.test(navigator.platform || "");
          const isWin = /win/i.test(navigator.platform || "");

          const installerExt =
            (isMac ? "dmg|pkg|mpkg|dmgpart|toast|" : "") +
            (isWin ? "exe|msi|msp|msu|cab|application|vhd|" : "") +
            (!isWin ? "deb|rpm|appimage|flatpakref|snap|flatpak|run|" : "") +
            "iso|img|zip|tar|gz|bz2|xz|7z|rar|zst";
          const tempExt = "log|tmp|temp|cache|bak|swp|swo|ds_store|thumbs|db";
          const reInstaller = new RegExp("\\.(?:" + installerExt + ")$", "i");
          const reTemp = new RegExp("\\.(?:" + tempExt + ")$", "i");
          const reDup = /\(\d+\)\.[a-z0-9]+$/i;

          const cleanable = [];
          const seen = {};
          const nodes = loader.allNodes || [];
          let count = 0;
          for (let cni = 0; cni < nodes.length; cni++)
            if (nodes[cni]) count++;
          function getNodeRelPath(node, allNodes) {
            const parts = [];
            let cur = node;
            for (;;) {
              parts.unshift(cur.name || "");
              if (cur.parent === 4294967295 || cur.parent === undefined) break;
              cur = allNodes[cur.parent];
              if (!cur) break;
            }
            parts.shift();
            return parts.join("/");
          }
          if (count >= 2) {
            for (let cni = 0; cni < nodes.length; cni++) {
              const cn = nodes[cni];
              if (!cn || cn.node_type === 0 || cn.node_type === "Directory") continue;
              const cname = (cn.name || "").toLowerCase();
              const cext = cname.lastIndexOf(".") >= 0 ? cname.substring(cname.lastIndexOf(".")) : "";
              const csize = cn.size || 0;
              const isInstaller = reInstaller.test(cext);
              const isTemp = reTemp.test(cext);
              const isDup = reDup.test(cname);
              const isOld = cn.mtime && cn.mtime > 0 && Date.now() / 1000 - cn.mtime > 60 * 86400;
              if (isInstaller || isTemp || isDup || (isOld && csize > 1048576)) {
                const relPath = getNodeRelPath(cn, nodes);
                if (seen[relPath]) continue;
                seen[relPath] = true;
                let reason = "installer";
                if (isDup) reason = "duplicate";
                else if (isTemp) reason = "temp";
                else if (isOld) reason = "old";
                cleanable.push({ name: relPath, size: csize, reason: reason, mtime: cn.mtime });
              }
            }
          } else {
            const topFiles = state.currentStats && state.currentStats.top_files;
            if (topFiles && Array.isArray(topFiles)) {
              const rootPath = (scanPath.value || "").replace(/[\\/]+$/, "");
              for (let fi = 0; fi < topFiles.length; fi++) {
                const tf = topFiles[fi];
                const fullPath = typeof tf === "string" ? tf : (tf.path || "");
                const tsize = typeof tf === "string" ? 0 : (tf.size || 0);
                const fname = fullPath.replace(rootPath + "/", "").replace(rootPath + "\\", "");
                if (!fname) continue;
                const cname = fname.toLowerCase();
                const cext = cname.lastIndexOf(".") >= 0 ? cname.substring(cname.lastIndexOf(".")) : "";
                const isInstaller = reInstaller.test(cext);
                const isTemp = reTemp.test(cext);
                const isDup = reDup.test(cname);
                if (isInstaller || isTemp || isDup) {
                  if (seen[fname]) continue;
                  seen[fname] = true;
                  let reason = "installer";
                  if (isDup) reason = "duplicate";
                  else if (isTemp) reason = "temp";
                  cleanable.push({ name: fname, size: tsize || 0, reason: reason, mtime: 0 });
                }
              }
            }
          }
          if (cleanable.length === 0) {
            const stb = document.querySelector(".status-bar");
            if (stb) stb.textContent = "No cleanable files found in Downloads";
            return;
          }
          cleanable.sort(function (a, b) { return b.size - a.size; });
          var existingOverlay = document.getElementById("cleanup-overlay");
          if (existingOverlay) existingOverlay.remove();
          var overlay = document.createElement("div");
          overlay.id = "cleanup-overlay";
          overlay.className = "overlay-base";
          overlay.style.cssText = "display:flex;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);z-index:1000;";
          var card = document.createElement("div");
          card.className = "overlay-card";
          card.style.cssText = "max-width:560px;width:90%;max-height:80vh;display:flex;flex-direction:column;";
          var totalWaste = cleanable.reduce(function (s, i) { return s + i.size; }, 0);
          var headerHtml = '<div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
            '<h3 style="margin:0;font-size:15px;color:var(--text-primary);">\uD83E\uDDF9 Downloads Cleanup</h3>' +
            '<span style="font-size:12px;color:var(--text-muted);">' + cleanable.length + ' items \u00B7 ' +
            window.fmtSize(totalWaste) + ' reclaimable</span></div>';
          var listHtml = '<div style="flex:1;overflow-y:auto;padding:6px 0;">';
          for (var ci = 0; ci < Math.min(cleanable.length, 200); ci++) {
            var item = cleanable[ci];
            var badge = item.reason === "duplicate" ? "\uD83D\uDD01" : item.reason === "old" ? "\u23F3" : item.reason === "temp" ? "\uD83D\uDDD1\uFE0F" : "\uD83D\uDCE6";
            var escName = item.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            var fullPath = (scanPath.value || "").replace(/[\\/]+$/, "") + "/" + escName;
            var sizeStr = window.fmtSize(item.size);
            listHtml += '<div class="cleanup-item" data-file="' + escName + '" title="' + fullPath.replace(/"/g, "&quot;") + '" style="display:flex;align-items:center;gap:8px;padding:5px 14px;cursor:pointer;border-radius:4px;font-size:12px;color:var(--text-secondary);transition:background 0.15s;">' +
              '<input type="checkbox" checked style="width:15px;height:15px;cursor:pointer;flex-shrink:0;">' +
              '<span style="flex-shrink:0;">' + badge + '</span>' +
              '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;">' + escName + '</span>' +
              '<span style="font-family:monospace;font-size:11px;color:var(--text-muted);flex-shrink:0;">' + sizeStr + '</span>' +
              '<span style="font-size:10px;color:var(--text-muted);padding:1px 6px;border-radius:3px;background:var(--bg-tertiary);flex-shrink:0;">' + item.reason + '</span></div>';
          }
          listHtml += '</div>';
          var footerHtml = '<div style="padding:10px 14px;border-top:1px solid var(--border);display:flex;gap:6px;justify-content:flex-end;flex-shrink:0;">' +
            '<button id="cleanup-select-all" style="padding:5px 14px;font-size:12px;border:1px solid var(--border);border-radius:5px;background:var(--bg-tertiary);cursor:pointer;color:var(--text-primary);">Select All</button>' +
            '<button id="cleanup-move-trash" style="padding:5px 14px;font-size:12px;border:none;border-radius:5px;background:linear-gradient(135deg,#da3633,#f85149);color:#fff;cursor:pointer;">\uD83D\uDDD1\uFE0F Move to Trash</button>' +
            '<button id="cleanup-close-btn" style="padding:5px 14px;font-size:12px;border:1px solid var(--border);border-radius:5px;background:var(--bg-tertiary);cursor:pointer;color:var(--text-primary);">Close</button></div>';
          card.innerHTML = headerHtml + listHtml + footerHtml;
          overlay.appendChild(card);
          document.body.appendChild(overlay);
          overlay.addEventListener("click", function (e) { if (e.target === overlay) overlay.style.display = "none"; });
          document.getElementById("cleanup-close-btn").onclick = function () { overlay.remove(); };
          document.getElementById("cleanup-select-all").onclick = function () {
            var btn = document.getElementById("cleanup-select-all");
            var cbs = overlay.querySelectorAll('.cleanup-item input[type="checkbox"]');
            var someUnchecked = Array.from(cbs).some(function (cb) { return !cb.checked; });
            cbs.forEach(function (cb) { cb.checked = someUnchecked; });
            if (btn) btn.textContent = someUnchecked ? "Select All" : "Select None";
          };
          document.getElementById("cleanup-move-trash").onclick = function () {
            var items = overlay.querySelectorAll('.cleanup-item input[type="checkbox"]:checked');
            var files = Array.from(items).map(function (cb) { return cb.closest(".cleanup-item").dataset.file; });
            if (files.length === 0) { const t0 = window.__ || function (s) { return s; }; window.showToast(t0("toast.no_items"), "warning"); return; }
            window.confirmDialog("Move " + files.length + " file(s) to Trash?").then(function (ok) {
              if (!ok) return;
            var rootPath = (scanPath && scanPath.value || "").replace(/[\\/]+$/, "");
            (async function () {
              var ok2 = 0, fail = 0;
              for (var fi = 0; fi < files.length; fi++) {
                var fullPath = rootPath + "/" + files[fi];
                try {
                  var delRes = await window.__TAURI__.invoke("delete_path", { path: fullPath });
                  if (delRes && delRes.success === false) { fail++; console.warn("Cleanup failed:", fullPath, delRes.error); }
                  else { ok2++; }
                } catch (e) { fail++; console.warn("Cleanup failed:", fullPath, e); }
              }
              overlay.remove();
              if (window.showToast) {
                if (fail > 0) window.showToast(ok2 + " moved to trash, " + fail + " failed", "warning");
                else if (ok2 > 0) window.showToast(ok2 + " file(s) moved to trash", "success");
              }
              if (btnScan) btnScan.click();
            })();
            });
          };
          overlay.querySelectorAll(".cleanup-item").forEach(function (row) {
            row.onclick = function (e) { if (e.target.tagName === "INPUT") return; var cb = this.querySelector('input[type="checkbox"]'); if (cb) cb.checked = !cb.checked; };
            row.onmouseenter = function () { this.style.background = "var(--bg-hover)"; };
            row.onmouseleave = function () { this.style.background = "transparent"; };
          });
        }

        // Trigger next queued scan if multi-path
        if (
          window.__pendingScans &&
          window.__pendingScans.length > 0
        ) {
          const nextPath = window.__pendingScans.shift();
          if (nextPath && scanPath) {
            scanPath.value = nextPath;
            btnScan.click();
          }
        }
        btnExport.disabled = false;
        const nc = document.getElementById("node-count");
        if (nc)
          nc.textContent =
            treeView.visibleNodes.length.toLocaleString() + " shown";
      } catch (err) {
        console.error("Scan failed:", err);
        document.querySelector(".status-bar").textContent =
          "Error: " + err;
      } finally {
        hideLiveTree();
        if (unlisten && typeof unlisten === "function") unlisten();
        clearTimeout(safetyTimer);
        state.isScanning = false;
        btnScan.disabled = false;
        if (btnRescan) btnRescan.disabled = false;
        btnBrowse.disabled = false;
        btnCancel.disabled = true;
        progressOverlay.classList.remove("active");
      }
    });

    // Rescan (same path)
    if (btnRescan) {
      btnRescan.addEventListener("click", function () {
        if (btnScan && !btnScan.disabled) btnScan.click();
      });
    }

    // Cancel (toolbar)
    btnCancel.addEventListener("click", async function () {
      const psEl = document.getElementById("progress-status");
      if (psEl)
        psEl.textContent =
          (window.__ || function (s) { return s; })("status.cancelling");
      btnCancel.disabled = true;
      try {
        await window.__TAURI__.invoke("cancel_scan", {});
      } catch (e) { console.debug("[DiskRaptor]", e); }
      for (let ci = 0; ci < 25; ci++) {
        await sleep(200);
        try {
          const sp = await window.__TAURI__.invoke("get_scan_progress", {
            scanId: state.currentScanId,
          });
          if (!sp.is_running) break;
        } catch (e) {
          break;
        }
      }
      try {
        const partial = await window.__TAURI__.invoke("get_scan_result", {
          scanId: state.currentScanId,
        });
        if (
          partial &&
          partial.stats &&
          partial.stats.total_files > 0
        ) {
          state.currentScanResult = partial;
          state.currentStats = partial.stats;
          statsPanel.render(partial.stats);
          diagram.setData(partial.stats);
          const files = Number(
            partial.stats.total_files || 0,
          ).toLocaleString("en-US");
          const dirs = Number(
            partial.stats.total_dirs || 0,
          ).toLocaleString("en-US");
          const t = window.__ || function (s) { return s; };
          document.querySelector(".status-bar").textContent = t(
            "status.cancelled_partial",
          )
            .replace("{files}", files)
            .replace("{dirs}", dirs);
          topFiles.render(
            partial.stats ? partial.stats.top_files : [],
            true,
          );
          if (
            partial.root_info &&
            partial.root_info.total_chunks > 0
          ) {
            loader.prepare(
              partial.root_info.total_nodes,
              partial.root_info.total_chunks,
              state.currentScanId,
            );
            try {
              await loader.loadChunk(0);
            } catch (e) {
              console.warn("cancel chunk 0:", e);
            }
            treeView.expanded.add(0);
            try {
              await treeView.rebuild();
            } catch (e) {
              console.warn("cancel rebuild:", e);
            }
          }
        } else {
          const fbStats = {
            total_files: state.lastFilesFound || 0,
            total_dirs: state.lastDirsFound || 0,
            total_size: 0,
            scan_time_ms: 0,
            top_files: [],
            file_type_breakdown: [],
          };
          state.currentStats = fbStats;
          statsPanel.render(fbStats);
          diagram.setData(fbStats);
          topFiles.render([], true);
          document.querySelector(".status-bar").textContent = (
            window.__ || function (s) { return s; }
          )("status.scan_cancelled")
            .replace(
              "{files}",
              (state.lastFilesFound || 0).toLocaleString(),
            );
        }
      } catch (e) {
        console.warn("cancel partial error:", e);
        try {
          const emptyStats = {
            total_files: 0, total_dirs: 0, total_size: 0,
            scan_time_ms: 0, top_files: [], file_type_breakdown: [],
          };
          statsPanel.render(emptyStats);
          diagram.setData(emptyStats);
          topFiles.render([], true);
        } catch (e2) {}
        document.querySelector(".status-bar").textContent =
          "Scan cancelled - " +
          (state.lastFilesFound || 0).toLocaleString() +
          " files found";
      }
      try {
        await loader.release();
      } catch (e) { console.debug("[DiskRaptor]", e); }
      state.isScanning = false;
      btnScan.disabled = false;
      btnBrowse.disabled = false;
      btnCancel.disabled = true;
      btnExport.disabled = false;
      progressOverlay.classList.remove("active");
    });

    const progressCancelBtn = document.getElementById("progress-cancel");
    if (progressCancelBtn) {
      progressCancelBtn.addEventListener("click", function () {
        btnCancel.click();
      });
    }
  };
})();
