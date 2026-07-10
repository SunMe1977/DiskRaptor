    (function initDuplicates() {
      var btnDup = document.getElementById("btn-duplicates");
      var dupOverlay = document.getElementById("duplicates-overlay");
      var dupClose = document.getElementById("btn-duplicates-close");
      var dupProgress = document.getElementById("dup-progress");
      var dupProgressFiles = document.getElementById("dup-progress-files");
      var dupStats = document.getElementById("dup-stats");
      var dupStatGroups = document.getElementById("dup-stat-groups");
      var dupStatFiles = document.getElementById("dup-stat-files");
      var dupStatWasted = document.getElementById("dup-stat-wasted");
      var dupDiagramWrap = document.getElementById("dup-diagram-wrap");
      var dupCanvas = document.getElementById("dup-diagram");
      var dupResults = document.getElementById("duplicates-results");
      var dupBody = document.getElementById("duplicates-body");

      if (!btnDup || !dupOverlay) return;

      function closeDup() { dupOverlay.classList.remove("active"); }
      if (dupClose) dupClose.addEventListener("click", closeDup);
      dupOverlay.addEventListener("click", function(e) {
        if (e.target === dupOverlay) closeDup();
      });

      function fmtBytes(b) {
        if (!b || b === 0) return "0 B";
        var u = ["B","KB","MB","GB","TB"];
        var i = Math.floor(Math.log(b) / Math.log(1024));
        if (i >= u.length) i = u.length - 1;
        var v = b / Math.pow(1024, i);
        return (i === 0 ? b : v.toFixed(2)) + " " + u[i];
      }

      function drawDupPie(groups) {
        if (!dupCanvas) return;
        var ctx = dupCanvas.getContext("2d");
        var w = dupCanvas.width, h = dupCanvas.height;
        ctx.clearRect(0, 0, w, h);
        var top = groups.slice(0, 10);
        var total = top.reduce(function(s, g) { return s + g.size; }, 1);
        var colors = ["#58a6ff","#3fb950","#d29922","#f85149","#bc8cff","#79c0ff","#56d364","#e3b341","#ff7b72","#d2a8ff"];
        var cx = 60, cy = 60, r = 50;
        var start = -Math.PI / 2;
        top.forEach(function(g, i) {
          var a = (g.size / total) * Math.PI * 2;
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + a); ctx.closePath();
          ctx.fillStyle = colors[i % colors.length]; ctx.fill();
          start += a;
        });
        // Legend on the right
        var lx = 130, ly = 8;
        ctx.font = "10px sans-serif"; ctx.textBaseline = "top";
        top.forEach(function(g, i) {
          var name = g.files[0] ? g.files[0].split("\\").pop() || g.files[0].split("/").pop() || "?" : "?";
          ctx.fillStyle = colors[i % colors.length];
          ctx.fillRect(lx, ly, 7, 7);
          ctx.fillStyle = "#e6edf3";
          ctx.textAlign = "left";
          ctx.fillText(name + " (" + g.size_human + ")", lx + 10, ly);
          ly += 11;
        });
      }

      function showDupCtxMenu(e, filePath) {
        e.preventDefault();
        var existing = document.getElementById("dup-context-menu");
        if (existing) existing.remove();

        var menu = document.createElement("div");
        menu.id = "dup-context-menu";
        menu.style.cssText = "position:fixed;z-index:3000;background:#1e1e36;border:1px solid var(--border);border-radius:8px;padding:4px 0;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.4)";
        menu.innerHTML =
          '<div class="dup-ctx-item" data-action="explorer">\u{1F4C2} Open in Explorer</div>' +
          '<div class="dup-ctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
          '<div class="dup-ctx-sep"></div>' +
          '<div class="dup-ctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
          '<div class="dup-ctx-item" data-action="copy">\u{1F4CB} Copy Path</div>' +
          '<div class="dup-ctx-sep"></div>' +
          '<div class="dup-ctx-item dup-ctx-del" data-action="delete">\u{1F5D1}\uFE0F Delete</div>';
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";
        menu._filePath = filePath;
        document.body.appendChild(menu);

        // Styles
        var style = document.createElement("style");
        style.textContent =
          ".dup-ctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:#e6edf3;transition:background .15s}" +
          ".dup-ctx-item:hover{background:rgba(255,255,255,0.06)}" +
          ".dup-ctx-sep{height:1px;background:var(--border);margin:4px 8px}" +
          ".dup-ctx-del{color:#f85149}";
        document.head.appendChild(style);

        menu.addEventListener("click", function(ev) {
          var item = ev.target.closest(".dup-ctx-item");
          if (!item) return;
          var action = item.dataset.action;
          var fp = menu._filePath;
          menu.remove();
          if (!fp || !window.__TAURI__ || !window.__TAURI__.invoke) return;
          var invoke = window.__TAURI__.invoke;
          if (action === "explorer") invoke("open_explorer", { path: fp }).catch(function(){});
          else if (action === "terminal") {
            var dir = fp.lastIndexOf("\\") >= 0 ? fp.substring(0, fp.lastIndexOf("\\")) : fp;
            invoke("open_terminal", { path: dir }).catch(function(){});
          } else if (action === "properties") invoke("open_properties", { path: fp }).catch(function(){});
          else if (action === "copy") {
            navigator.clipboard.writeText(fp).then(function() {
              document.querySelector(".status-bar").textContent = "Copied: " + fp;
            }).catch(function(){});
          } else if (action === "delete") {
            if (!confirm("Delete file?\n" + fp)) return;
            invoke("delete_path", { path: fp }).then(function() {
              document.querySelector(".status-bar").textContent = "Deleted: " + fp;
            }).catch(function(err) {
              console.warn("Delete failed:", err);
            });
          }
        });

        document.addEventListener("click", function rm(e) {
          if (!e.target.closest("#dup-context-menu")) {
            var m = document.getElementById("dup-context-menu");
            if (m) m.remove();
            document.removeEventListener("click", rm);
          }
        }, { once: false });
      }

      function runDuplicates(path) {
        dupOverlay.classList.add("active");
        dupProgress.style.display = "block";
        dupStats.style.display = "none";
        dupDiagramWrap.style.display = "none";
        dupResults.style.display = "none";
        dupBody.innerHTML = "";
        dupProgressFiles.textContent = "0";

        // Use setTimeout to let UI update before blocking
        setTimeout(async function() {
          try {
            // Show progress animation by incrementing a counter
            var fakeCount = 0;
            var progInterval = setInterval(function() {
              fakeCount += Math.floor(Math.random() * 500) + 100;
              dupProgressFiles.textContent = fakeCount.toLocaleString("en-US");
            }, 300);

            var groups = await window.__TAURI__.invoke("find_duplicates", { path: path });
            clearInterval(progInterval);

            dupProgress.style.display = "none";

            if (!groups || groups.length === 0) {
              dupStats.style.display = "flex";
              dupStatGroups.textContent = "0";
              dupStatFiles.textContent = "0";
              dupStatWasted.textContent = "0 B";
              return;
            }

            // Calculate stats
            var totalDupFiles = 0;
            var wastedBytes = 0;
            groups.forEach(function(g) {
              totalDupFiles += g.count;
              wastedBytes += g.size * (g.count - 1);
            });

            // Show stats
            dupStats.style.display = "flex";
            dupStatGroups.textContent = groups.length.toLocaleString("en-US");
            dupStatFiles.textContent = totalDupFiles.toLocaleString("en-US");
            dupStatWasted.textContent = fmtBytes(wastedBytes);

            // Draw diagram
            dupDiagramWrap.style.display = "block";
            drawDupPie(groups);

            // Build table
            dupResults.style.display = "block";
            var html = "";
            groups.forEach(function(g) {
              var sizeDisplay = g.size_human || fmtBytes(g.size || 0);
              // Remove duplicates from count display: show "n dupes"
              var countDisplay = g.count;
              html += "<tr>";
              html += "<td style='font-family:var(--font-mono);color:var(--accent-orange);font-weight:600;font-size:12px'>" + sizeDisplay + "</td>";
              html += "<td style='text-align:center;font-weight:600'>" + countDisplay + "</td>";
              html += "<td>";
              g.files.forEach(function(f) {
                var name = f.split("\\").pop() || f.split("/").pop() || f;
                html += '<span class="dup-file-item" data-path="' + f.replace(/"/g,"&quot;") + '" title="' + f.replace(/"/g,"&quot;") + '">' + f.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</span>";
              });
              html += "</td>";
              // Trash icon
              html += '<td><button class="dup-del-btn" data-path="' + g.files[0].replace(/"/g,"&quot;") + '" title="Delete">\uD83D\uDDD1</button></td>';
              html += "</tr>";
            });
            dupBody.innerHTML = html;

            // Delete buttons
            dupBody.querySelectorAll(".dup-del-btn").forEach(function(btn) {
              btn.addEventListener("click", function() {
                var fp = this.getAttribute("data-path");
                if (!confirm("Delete file?\n" + fp)) return;
                window.__TAURI__.invoke("delete_path", { path: fp }).then(function() {
                  document.querySelector(".status-bar").textContent = "Deleted: " + fp;
                  btn.disabled = true;
                  btn.style.opacity = "0.3";
                }).catch(function(err) { console.warn("Delete failed:", err); });
              });
            });

            // Right-click context menu on file paths
            dupBody.querySelectorAll(".dup-file-item").forEach(function(el) {
              el.addEventListener("contextmenu", function(e) {
                showDupCtxMenu(e, this.getAttribute("data-path"));
              });
              el.addEventListener("click", function() {
                var p = this.getAttribute("data-path");
                if (p) navigator.clipboard.writeText(p).then(function() {
                  document.querySelector(".status-bar").textContent = "Copied: " + p;
                }).catch(function(){});
              });
            });

          } catch (err) {
            dupProgress.style.display = "none";
            console.warn("Duplicates failed:", err);
          }
        }, 50);
      }

      btnDup.addEventListener("click", function() {
        var path = scanPath.value.trim();
        if (!path) { alert("Please enter a directory path first."); return; }
        runDuplicates(path);
      });

      // Menu event
      if (window.__TAURI__ && window.__TAURI__.event) {
        try {
          window.__TAURI__.event.listen("menu-find-duplicates", function() {
            var path = scanPath.value.trim();
            if (!path) { alert("Please enter a directory path first."); return; }
            runDuplicates(path);
          });
        } catch(e) { console.log("Menu event not available:", e.message); }
      }
    })();

    // ── Update check ────────────────────────────────────────
    (function initUpdateCheck() {
      var overlay = document.getElementById("update-overlay");
      var icon = document.getElementById("update-icon");
      var heading = document.getElementById("update-heading");
      var status = document.getElementById("update-status");
      var version = document.getElementById("update-version");
      var currVer = document.getElementById("update-currversion");
      var actions = document.getElementById("update-actions");
      var dlBtn = document.getElementById("btn-update-download");
      var closeBtn = document.getElementById("btn-update-close");
      var progress = document.getElementById("update-progress");
      var progressBar = document.getElementById("update-progress-bar");

      if (!overlay) return;

      function resetDialog() {
        icon.textContent = "🔄";
        heading.textContent = "Check for Updates";
        status.textContent = "";
        version.textContent = "";
        dlBtn.style.display = "none";
        progress.style.display = "none";
      }

      function showUpToDate() {
        icon.textContent = "✅";
        heading.textContent = "Up to Date";
        status.textContent = "You have the latest version.";
        version.textContent = "";
        dlBtn.style.display = "none";
      }

      function showUpdateAvailable(latestTag) {
        icon.textContent = "📥";
        heading.textContent = "Update Available";
        status.textContent = "Version " + latestTag + " is ready!";
        version.textContent = "New features and improvements";
        dlBtn.style.display = "inline-flex";
      }

      function showError(msg) {
        icon.textContent = "⚠️";
        heading.textContent = "Could Not Check";
        status.textContent = msg || "Could not reach GitHub.";
        version.textContent = "Check your internet connection.";
        dlBtn.style.display = "none";
      }

      function showDownloading() {
        icon.textContent = "⏳";
        heading.textContent = "Downloading…";
        status.textContent = "Downloading latest version…";
        version.textContent = "This may take a moment.";
        actions.style.display = "none";
        progress.style.display = "block";
        progressBar.style.width = "0%";
        // Animate progress bar
        var p = 0;
        var timer = setInterval(function() {
          p += Math.random() * 8;
          if (p > 85) { p = 85; clearInterval(timer); }
          progressBar.style.width = p + "%";
        }, 500);
        window._updateTimer = timer;
      }

      function showInstalling() {
        icon.textContent = "⚙️";
        heading.textContent = "Installing…";
        status.textContent = "Installing update…";
        version.textContent = "The app will restart.";
        progressBar.style.width = "100%";
      }

      closeBtn.onclick = function() {
        overlay.classList.remove("active");
        if (window._updateTimer) clearInterval(window._updateTimer);
      };
      overlay.addEventListener("click", function(e) {
        if (e.target === overlay) overlay.classList.remove("active");
      });

      async function runUpdateCheck() {
        resetDialog();
        overlay.classList.add("active");
        status.textContent = "Connecting to GitHub…";
        version.textContent = "Fetching latest release…";

        if (!window.__TAURI__ || !window.__TAURI__.invoke) {
          showError("Backend not available");
          return;
        }

        try {
          var latestTag = await window.__TAURI__.invoke("check_for_updates");

          if (!latestTag || latestTag === "v0.2.3" || latestTag === "0.2.3") {
            showUpToDate();
            version.textContent = "Current: v0.2.3 | Latest: " + (latestTag || "v0.2.3");
          } else {
            showUpdateAvailable(latestTag);
            version.textContent = "Current: v0.2.3 → Latest: " + latestTag;

            dlBtn.onclick = async function() {
              showDownloading();
              try {
                await window.__TAURI__.invoke("download_and_install", { version: latestTag });
                showInstalling();
              } catch (e) {
                icon.textContent = "❌";
                status.textContent = "Download failed: " + e;
                version.textContent = "Please try again or download manually.";
                actions.style.display = "flex";
                progress.style.display = "none";
                dlBtn.style.display = "inline-flex";
              }
            };
          }
        } catch (e) {
          showError(String(e));
        }
      }

      // Button click
      var btnDupDummy = document.getElementById("btn-duplicates");
      // Hook into Help → Check for Updates menu
      btnDupDummy = null; // not used

      if (window.__TAURI__ && window.__TAURI__.event) {
        try {
          window.__TAURI__.event.listen("menu-check-updates", function() {
            runUpdateCheck();
          });
        } catch(e) {}
      }

      // Also restore other menu events
      if (window.__TAURI__ && window.__TAURI__.event) {
        try {
          window.__TAURI__.event.listen("menu-view-pie", function() {
            var btn = document.querySelector('.diagram-mode[data-mode="pie"]');
            if (btn) btn.click();
          });
          window.__TAURI__.event.listen("menu-view-treemap", function() {
            var btn = document.querySelector('.diagram-mode[data-mode="treemap"]');
            if (btn) btn.click();
          });
          window.__TAURI__.event.listen("menu-about", function() {
            var aboutOverlay = document.getElementById("about-overlay");
            if (aboutOverlay) aboutOverlay.classList.add("active");
          });
        } catch(e) {}
      }
    })();
