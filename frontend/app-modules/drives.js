(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initDrives = function (scanPath, btnScan) {
    // ── Volume stats on welcome page ─────────────────────
    (async function () {
      try {
        const vols = await window.__TAURI__.invoke("get_volume_stats", {});
        const container = document.getElementById("welcome-volumes");
        if (!container) return;
        if (!vols || vols.length === 0) {
          container.innerHTML =
            '<div style="font-size:11px;color:var(--text-muted);text-align:center;">No volumes detected</div>';
          return;
        }
        let html =
          '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px;font-weight:600;display:flex;align-items:center;gap:8px;">\uD83D\uDCBE Drives<span id="refresh-volumes" style="font-size:11px;cursor:pointer;color:var(--text-muted);font-weight:400;">\u21BB refresh</span></div>';
        let shown = 0;
        for (let vi = 0; vi < vols.length && shown < 10; vi++) {
          const v = vols[vi];
          if (!v.total_bytes && !v.name && !v.path) continue;
          const pct = Math.min(100, Math.max(0, v.usage_pct || v.percentFull || 0));
          const color =
            pct > 90 ? "#f85149" : pct > 70 ? "#d29922" : "#3fb950";
          const usedStr = fmtVol(v.used_bytes || v.used || 0);
          const totalStr = fmtVol(v.total_bytes || v.total || 0);
          html +=
            '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:var(--bg-tertiary);margin-bottom:4px;">';
          html += '<span style="font-size:14px;">\uD83D\uDCBD</span>';
          html +=
            '<span style="flex:1;font-size:12px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            (v.name || v.path || "Drive") +
            "</span>";
          html +=
            '<div style="width:80px;height:6px;background:var(--bg-secondary);border-radius:3px;overflow:hidden;"><div style="width:' +
            pct +
            "%;height:100%;background:" +
            color +
            ';border-radius:3px;"></div></div>';
          html +=
            '<span style="font-size:11px;color:var(--text-secondary);font-family:var(--font-mono);white-space:nowrap;">' +
            usedStr +
            (totalStr && totalStr !== "0 B" ? " / " + totalStr : "") +
            "</span>";
          html += "</div>";
          shown++;
        }
        function fmtVol(bytes) {
          const u = ["B", "KB", "MB", "GB", "TB"];
          let v = bytes || 0, i = 0;
          while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
          return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
        }
        if (vols.length > 10) {
          html +=
            '<div style="font-size:10px;color:var(--text-muted);text-align:center;padding:4px;">+ ' +
            (vols.length - 10) +
            " more</div>";
        }
        container.innerHTML = html;
      } catch (e) {
        console.warn("Volume stats:", e);
      }
    })();

    // ── Drive Selector Dropdown ────────────────────────────
    const btnDrive = document.getElementById("btn-drive");
    const driveMenu = document.getElementById("drive-menu");
    const driveSelected = document.getElementById("drive-selected");

    btnDrive.addEventListener("click", function (e) {
      e.stopPropagation();
      driveMenu.classList.toggle("active");
      if (driveMenu.classList.contains("active")) {
        loadDrives();
      }
    });

    document.addEventListener("click", function (e) {
      if (!e.target.closest(".drive-dropdown-wrap")) {
        driveMenu.classList.remove("active");
      }
    });

    // Arrow-key navigation through drive items; Enter activates.
    driveMenu.addEventListener("keydown", function (e) {
      const items = driveMenu.querySelectorAll(".drive-item");
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
      } else if (e.key === "Escape") {
        driveMenu.classList.remove("active");
        btnDrive.focus();
      }
    });

    function driveIcon(type, path) {
      if (path === "/") return "\uD83D\uDDA5\uFE0F";
      switch (type) {
        case "system":
          return "\uD83D\uDDA5\uFE0F";
        case "usb":
          return "\uD83D\uDCBE";
        case "dvd":
          return "\uD83D\uDCBF";
        case "ram":
          return "\u26A1";
        case "local":
          return path && path.startsWith("/") ? "\uD83D\uDCBD" : "\uD83D\uDDA5\uFE0F";
        default:
          return "\uD83D\uDCBD";
      }
    }

    function formatSize(bytes) {
      if (!bytes || bytes === 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
      const v = bytes / Math.pow(1024, i);
      return v.toFixed(1) + " " + units[i];
    }

    async function loadDrives() {
      try {
        const drivesRaw = await window.__TAURI__.invoke("list_drives");
        const drives =
          typeof drivesRaw === "string" ? JSON.parse(drivesRaw) : drivesRaw;
        if (!drives || drives.length === 0) return;

        let html = "";
        for (let i = 0; i < drives.length; i++) {
          const d = drives[i];
          const path = d.path || "";
          const type = d.type || "local";
          const isWin = path.indexOf(":") >= 0;
          let label;
          if (isWin) {
            label = path.replace(":\\", "").replace(":/", "") + ":";
          } else {
            label = d.name || path;
            if (path === "/" && navigator.platform === "MacIntel")
              label = "Macintosh HD";
            if (path === "/" && navigator.platform !== "MacIntel")
              label = "/ (Root)";
          }
          const name = d.name || label;
          const total = d.total_bytes || d.total || 0;
          const used = d.used_bytes || d.used || 0;
          const pct =
            d.percentFull !== undefined
              ? Math.round(d.percentFull)
              : d.usage_pct !== undefined
                ? Math.round(d.usage_pct)
                : total > 0
                  ? Math.round((used / total) * 100)
                  : 0;
          const free = d.free_bytes || d.free || 0;
          const icon = driveIcon(type, path);
          const curPath = scanPath.value;
          const isActive = isWin
            ? curPath.toUpperCase().startsWith(label.toUpperCase())
            : curPath === path || curPath.startsWith(path + "/");
          html +=
            '<div class="drive-item' +
            (isActive ? " active" : "") +
            '" tabindex="0" data-path="' +
            path +
            '">' +
            '<span class="drive-icon">' +
            icon +
            "</span>" +
            '<div class="drive-info">' +
            '<div class="drive-info-top">' +
            '<span class="drive-label">' +
            label +
            "</span>" +
            '<span class="drive-name">' +
            name +
            "</span>" +
            "</div>" +
            '<div class="drive-bar-row">' +
            '<div class="drive-bar-wrap"><div class="drive-bar-fill" style="width:' +
            pct +
            '%"></div></div>' +
            '<span class="drive-pct">' +
            pct +
            "%</span>" +
            "</div>" +
            '<span class="drive-size">' +
            formatSize(free) +
            " free / " +
            formatSize(total) +
            "</span>" +
            "</div>" +
            "</div>";
        }
        driveMenu.innerHTML = html;
        driveMenu.querySelectorAll(".drive-item").forEach(function (el) {
          el.addEventListener("click", function () {
            driveMenu
              .querySelectorAll(".drive-item")
              .forEach(function (e) {
                e.classList.remove("active");
              });
            el.classList.add("active");
            const p = el.dataset.path;
            scanPath.value = p;
            driveSelected.textContent = p;
            driveMenu.classList.remove("active");
            btnScan.click();
          });
        });
        const hasActive = driveMenu.querySelector(".drive-item.active");
        if (!hasActive) {
          const firstItem = driveMenu.querySelector(".drive-item");
          if (firstItem) {
            const p = firstItem.dataset.path;
            if (scanPath.value) {
              driveSelected.textContent = scanPath.value;
            } else {
              scanPath.value = p;
              driveSelected.textContent = p;
            }
          }
        }
      } catch (e) {
        console.warn("Drive load:", e);
      }
    }

    loadDrives();
  };
})();
