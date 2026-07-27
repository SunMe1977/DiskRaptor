(function () {
  "use strict";
  window.app = window.app || {};

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
      showWelcome,
      sleep,
    } = refs;

    // Scan
    btnScan.addEventListener("click", async function () {
      if (state.isScanning) return;

      let path = scanPath.value.trim();
      if (!path) {
        window.showToast("Please enter or select a directory path.", "error");
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
              scan_history: hist,
            });
          }
        } catch (e) {}
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

      window.__TAURI__.invoke("request_permissions", {}).catch(function () {});

      const followLinks = chkFollow.querySelector("input").checked;

      const safetyTimer = setTimeout(function () {
        progressOverlay.classList.remove("active");
        document.querySelector(".status-bar").textContent = "Timeout triggered";
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

      function formatBytesPerSec(bps) {
        if (bps <= 0) return "0 MB/s";
        const mbps = bps / (1024 * 1024);
        return mbps.toFixed(mbps < 10 ? 2 : 1) + " MB/s";
      }

      function speedColor(ratio) {
        if (ratio > 0.8) return "#f85149";
        if (ratio > 0.4) return "#3fb950";
        return "#d29922";
      }

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

      progressFilesEl.textContent = "0";
      progressDirsEl.textContent = "0";
      progressSpeedValEl.textContent = "";
      progressElapsedValEl.textContent = "0s";
      progressDirEl.textContent = "";
      speedSamples.length = 0;

      try {
        const initScan = await window.__TAURI__.invoke("start_scan", {
          path: path,
          follow_symlinks: followLinks,
          timeout_secs: 30,
        });
        if (initScan && initScan.error) {
          throw new Error(initScan.error);
        }
        const scanId = (initScan && initScan.scan_id) || 1;
        state.currentScanId = scanId;

        let prevFilesFound = 0;
        let lastFilesFound = 0;
        let lastDirsFound = 0;
        const pollStartTime = Date.now();

        let done = false;
        let zeroCount = 0;
        for (let i = 0; i < 3600; i++) {
          await sleep(500);
          const p = await window.__TAURI__
            .invoke("get_scan_progress", { scanId: scanId })
            .catch(function () {
              return null;
            });
          if (!p) continue;

          const rawDisplay = document.getElementById("progress-raw");
          if (rawDisplay) {
            try {
              rawDisplay.textContent =
                "raw: " + JSON.stringify(p).substring(0, 150);
            } catch (e) {}
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
            const filesPerSec = filesFound / elapsedSecs;
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
            speedSamples.push({ fps: filesPerSec, bps: bytesPerSec });
            if (speedSamples.length > maxSamples) speedSamples.shift();
            drawSpeedChart();
          } else {
            progressSpeedValEl.textContent = "\u2014";
            progressSpeedValEl.style.color = "#8b949e";
          }

          const pctBar = document.getElementById("progress-pct-bar");
          const pctText = document.getElementById("progress-pct-text");
          if (pctBar && pctText) {
            const pct = Math.min(
              95,
              Math.max(
                1,
                elapsedSecs > 5
                  ? Math.min(
                      95,
                      (filesFound / Math.max(1, filesFound + dirsFound)) *
                        50 +
                        (elapsedSecs / 1200) * 50,
                    )
                  : (filesFound / 5000) * 20,
              ),
            );
            pctBar.style.width = pct + "%";
            pctText.textContent = Math.round(pct) + "%";
          }

          if (elapsedSecs > 5 && filesFound > 100 && filesFound > prevFilesFound) {
            const rate = filesFound / elapsedSecs;
            let remaining =
              prevFilesFound > 0 && filesFound > prevFilesFound
                ? (filesFound *
                    (filesFound / Math.max(1, filesFound - prevFilesFound) -
                      1)) /
                  rate
                : 0;
            remaining = Math.max(0, Math.min(36000, remaining));
            const etaM = Math.floor(remaining / 60);
            const etaS = Math.floor(remaining % 60);
            const etaEl = document.getElementById("progress-eta-val");
            if (etaEl)
              etaEl.textContent =
                (etaM < 10 ? "0" : "") +
                etaM +
                ":" +
                (etaS < 10 ? "0" : "") +
                etaS;
          }

          statsPanel.updateLive(filesFound, dirsFound, elapsedSecs);

          if (p.error_count > 0 && errDisplay) {
            const errMsg = p.last_error || "";
            errDisplay.textContent =
              "\u26A0 " +
              p.error_count +
              " permission denied \u2014 " +
              errMsg.substring(0, 80);
            errDisplay.style.display = "block";
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

          prevFilesFound = filesFound;

          const isRunning =
            p.is_running !== undefined ? p.is_running : true;
          const isDone = p.phase === 3 || !isRunning;
          if (isDone) {
            await sleep(500);
            done = true;
            break;
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
          if (fbStats.total_files > 0) {
            statsPanel.render(fbStats);
            diagram.setData(fbStats);
          }
          const totalSecs = Math.floor(
            (Date.now() - pollStartTime) / 1000,
          );
          const em = Math.floor(totalSecs / 60);
          const es = totalSecs % 60;
          progressElapsedValEl.textContent =
            (em < 10 ? "0" : "") + em + ":" + (es < 10 ? "0" : "") + es;
          const t = window.__ || function (s) { return s; };
          document.querySelector(".status-bar").textContent = t(
            "status.complete",
          )
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

        const treeStatusBar = document.querySelector(
          "#tree-panel .status-bar",
        );
        let hadChunks = false;

        if (
          result &&
          result.root_info &&
          result.root_info.total_chunks > 0 &&
          result.root_info.total_nodes > 0
        ) {
          loader.totalNodes = result.root_info.total_nodes;
          loader.totalChunks = result.root_info.total_chunks;
          loader.allNodes = new Array(loader.totalNodes);
          loader.scanId = scanId;

          try {
            await loader.loadChunk(0);
            hadChunks = true;
          } catch (e) {
            console.warn("Chunk 0:", e);
          }
          treeView.expanded.add(0);
          try {
            await treeView.rebuild();
          } catch (e) {}

          (async function () {
            const BATCH = 20;
            const total = loader.totalChunks;
            for (let start = 1; start < total; start += BATCH) {
              const end = Math.min(start + BATCH, total);
              if (treeStatusBar)
                treeStatusBar.textContent =
                  "Loading tree... " +
                  Math.round((end / total) * 100) +
                  "%";
              const promises = [];
              for (let ci = start; ci < end; ci++) {
                if (!loader.loadedChunks.has(ci)) {
                  promises.push(
                    loader.loadChunk(ci).catch(function () {}),
                  );
                }
              }
              if (promises.length > 0) {
                await Promise.all(promises);
                try {
                  await treeView.rebuild();
                } catch (e) {}
                await sleep(0);
              }
            }
            try {
              await treeView.rebuild();
            } catch (e) {}
            if (treeStatusBar) treeStatusBar.textContent = "Ready";
            showCleanupPanel();
          })();
        }

        if (
          !hadChunks &&
          state.currentStats &&
          state.currentStats.total_files > 0
        ) {
          try {
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
              _children: [],
            };
            loader.totalNodes = 1;
            loader.totalChunks = 0;
            loader.allNodes = [rootNode];
            loader.scanId = scanId;
            treeView.expanded.add(0);
            try {
              await treeView.rebuild();
            } catch (e) {}
          } catch (e) {
            console.warn("Synthetic root:", e);
          }
          showCleanupPanel();
        }

        function showCleanupPanel() {
          const spv = (scanPath && scanPath.value) || "";
          if (spv.toLowerCase().indexOf("download") < 0) return;
          const stb = document.querySelector(".status-bar");
          if (stb)
            stb.textContent = "Analyzing Downloads for cleanup...";
          const nodes = loader.allNodes || [];
          let count = 0;
          for (let cni = 0; cni < nodes.length; cni++)
            if (nodes[cni]) count++;
          if (count < 2) {
            if (stb) stb.textContent = "Cleanup: not enough data";
            return;
          }
          const cleanable = [];
          const seen = {};
          for (let cni = 0; cni < nodes.length; cni++) {
            const cn = nodes[cni];
            if (!cn || cn.node_type === 0 || cn.node_type === "Directory")
              continue;
            const cname = (cn.name || "").toLowerCase();
            const cext =
              cname.lastIndexOf(".") >= 0
                ? cname.substring(cname.lastIndexOf("."))
                : "";
            const csize = cn.size || 0;
            const isCleanable = /\.(dmg|zip|tar|gz|bz2|7z|rar|exe|msi|pkg|iso)$/i.test(
              cext,
            );
            const isDup = /\(\d+\)\.[a-z0-9]+$/i.test(cname);
            const isOld =
              cn.mtime &&
              cn.mtime > 0 &&
              Date.now() / 1000 - cn.mtime > 60 * 86400;
            if (isCleanable || isDup || (isOld && csize > 1048576)) {
              const displayName = cn.name || "?";
              const reason = isDup
                ? "duplicate"
                : isOld
                  ? "old"
                  : "installer";
              if (seen[displayName]) continue;
              seen[displayName] = true;
              cleanable.push({
                name: displayName,
                size: csize,
                reason: reason,
                mtime: cn.mtime,
              });
            }
          }
          if (cleanable.length === 0) return;
          cleanable.sort(function (a, b) {
            return b.size - a.size;
          });
          const existing = document.getElementById("cleanup-panel");
          if (existing) existing.remove();
          const panel = document.createElement("div");
          panel.id = "cleanup-panel";
          panel.style.cssText =
            "margin-top:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);overflow:hidden;";
          const totalWaste = cleanable.reduce(function (s, i) {
            return s + i.size;
          }, 0);
          let listHtml = "";
          for (
            let cni2 = 0;
            cni2 < Math.min(cleanable.length, 100);
            cni2++
          ) {
            const ci = cleanable[cni2];
            const badge =
              ci.reason === "duplicate"
                ? "\uD83D\uDD01"
                : ci.reason === "old"
                  ? "\u23F3"
                  : "\uD83D\uDCE6";
            const escName = ci.name
              .replace(/&/g, "&amp;")
              .replace(/"/g, "&quot;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");
            listHtml +=
              '<div class="cleanup-item" data-file="' +
              escName +
              '" style="display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;color:var(--text-secondary);">' +
              '<input type="checkbox" checked style="width:14px;height:14px;cursor:pointer;flex-shrink:0;">' +
              "<span>" +
              badge +
              "</span>" +
              '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;">' +
              ci.name +
              "</span>" +
              '<span style="font-family:monospace;font-size:11px;color:var(--text-muted);">' +
              (function (b) {
                const u = ["B", "KB", "MB", "GB"];
                const i = Math.min(
                  Math.floor(Math.log(b || 1) / Math.log(1024)),
                  3,
                );
                return (
                  (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) +
                  " " +
                  u[i]
                );
              })(ci.size) +
              "</span>" +
              '<span style="font-size:10px;color:var(--text-muted);padding:1px 5px;border-radius:3px;background:var(--bg-tertiary);">' +
              ci.reason +
              "</span>" +
              "</div>";
          }
          panel.innerHTML =
            '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">' +
            '<h4 style="margin:0;font-size:13px;color:var(--text-primary);">\uD83E\uDDF9 Downloads Cleanup</h4>' +
            '<span style="font-size:11px;color:var(--text-muted);">' +
            cleanable.length +
            " items \u00B7 " +
            (function (b) {
              const u = ["B", "KB", "MB", "GB"];
              const i = Math.min(
                Math.floor(Math.log(b || 1) / Math.log(1024)),
                3,
              );
              return (
                (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) +
                " " +
                u[i]
              );
            })(totalWaste) +
            " reclaimable</span>" +
            "</div>" +
            '<div style="max-height:250px;overflow-y:auto;padding:4px 0;">' +
            listHtml +
            "</div>" +
            '<div style="padding:8px 14px;border-top:1px solid var(--border);display:flex;gap:6px;justify-content:flex-end;">' +
            '<button id="cleanup-select-all" style="padding:4px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Select All</button>' +
            '<button id="cleanup-move-trash" style="padding:4px 12px;font-size:11px;border:none;border-radius:4px;background:linear-gradient(135deg,#da3633,#f85149);color:#fff;cursor:pointer;">\uD83D\uDDD1\uFE0F Move to Trash</button>' +
            '<button id="cleanup-close" style="padding:4px 12px;font-size:11px;border:1px solid var(--border);border-radius:4px;background:var(--bg-tertiary);cursor:pointer;">Close</button>' +
            "</div>";
          const tfSplit = document.getElementById("tf-splitter");
          if (tfSplit && tfSplit.parentNode) {
            tfSplit.parentNode.insertBefore(panel, tfSplit);
          } else {
            const dp = document.getElementById("detail-panel");
            if (dp) dp.appendChild(panel);
          }
          document.getElementById("cleanup-close").onclick = function () {
            panel.style.display = "none";
          };
          document.getElementById("cleanup-select-all").onclick =
            function () {
              const allChecked = panel.querySelectorAll(
                '.cleanup-item input[type="checkbox"]',
              );
              const someUnchecked = Array.from(allChecked).some(function (
                cb,
              ) {
                return !cb.checked;
              });
              allChecked.forEach(function (cb) {
                cb.checked = someUnchecked;
              });
            };
          document.getElementById("cleanup-move-trash").onclick =
            function () {
              const items = panel.querySelectorAll(
                '.cleanup-item input[type="checkbox"]:checked',
              );
              const files = Array.from(items).map(function (cb) {
                return cb.closest(".cleanup-item").dataset.file;
              });
              if (files.length === 0) {
                window.showToast("No items selected", "warning");
                return;
              }
              if (
                !confirm(
                  "Move " + files.length + " file(s) to Trash?",
                )
              )
                return;
              const rootPath = (
                scanPath && scanPath.value || ""
              ).replace(/[\\/]+$/, "");
              (async function () {
                for (let fi = 0; fi < files.length; fi++) {
                  const fullPath = rootPath + "/" + files[fi];
                  try {
                    await window.__TAURI__.invoke("delete_path", {
                      path: fullPath,
                    });
                  } catch (e) {
                    console.warn("Cleanup failed:", fullPath, e);
                  }
                }
                panel.style.display = "none";
                if (btnScan) btnScan.click();
              })();
            };
          panel
            .querySelectorAll(".cleanup-item")
            .forEach(function (row) {
              row.onclick = function (e) {
                if (e.target.tagName === "INPUT") return;
                const cb = this.querySelector(
                  'input[type="checkbox"]',
                );
                if (cb) {
                  cb.checked = !cb.checked;
                }
              };
              row.onmouseenter = function () {
                this.style.background = "var(--bg-hover)";
              };
              row.onmouseleave = function () {
                this.style.background = "transparent";
              };
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
      document.getElementById("progress-status").textContent =
        (window.__ || function (s) { return s; })("status.cancelling");
      btnCancel.disabled = true;
      try {
        await window.__TAURI__.invoke("cancel_scan", {});
      } catch (e) {}
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
            loader.totalNodes = partial.root_info.total_nodes;
            loader.totalChunks = partial.root_info.total_chunks;
            loader.allNodes = new Array(loader.totalNodes);
            loader.scanId = state.currentScanId;
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
        document.querySelector(".status-bar").textContent =
          "Scan cancelled - " +
          (state.lastFilesFound || 0).toLocaleString() +
          " files found";
      }
      try {
        await loader.release();
      } catch (e) {}
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
