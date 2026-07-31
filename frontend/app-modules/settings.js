(function () {
  "use strict";
  window.app = window.app || {};
  window.app.initSettings = function (config) {
    const { scanPath, btnScan, btnBrowse } = config;
    // ── First-run tips ────────────────────────────────
    (async function () {
      try {
        const s = await window.__TAURI__.invoke("load_settings", {});
        if (s && s.tips_dismissed) return;
      } catch (e) {}
      const tipOv = document.getElementById("tip-overlay");
      const tipClose = document.getElementById("tip-close");
      const tipDont = document.getElementById("tip-dont-show");
      if (tipOv) tipOv.style.display = "flex";
      if (tipClose)
        tipClose.onclick = function () {
          tipOv.style.display = "none";
          if (tipDont && tipDont.checked) {
            window.__TAURI__
              .invoke("save_settings", { settings: { tips_dismissed: true } })
              .catch(function () {});
          }
        };
    })();
    // ── Settings dialog ─────────────────────────────────
    (function () {
      const so = document.getElementById("settings-overlay");
      if (!so) return;
      document
        .getElementById("settings-close")
        ?.addEventListener("click", function () { so.style.display = "none"; });
      document
        .getElementById("settings-save")
        ?.addEventListener("click", async function () {
          const defPath = document.getElementById("settings-default-path")?.value || "";
          const selTheme = document.getElementById("settings-theme")?.value || "auto";
          await window.__TAURI__
            .invoke("save_settings", { settings: { default_scan_path: defPath, theme: selTheme } })
            .catch(function () {});
          if (selTheme === "light") document.body.classList.add("light-theme");
          else if (selTheme === "dark") document.body.classList.remove("light-theme");
          else {
            const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
            document.body.classList.toggle("light-theme", isLight);
          }
          so.style.display = "none";
        });
      so.addEventListener("click", function (e) { if (e.target === so) so.style.display = "none"; });
    })();
    // ── Keyboard shortcuts ────────────────────────────
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (btnScan && !btnScan.disabled) btnScan.click();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        if (btnBrowse && !btnBrowse.disabled) btnBrowse.click();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        const tf = document.getElementById("tree-filter");
        if (tf) { e.preventDefault(); tf.focus(); return; }
      }
      if (e.key === "Escape") {
        document.querySelectorAll("#about-overlay.active,#settings-overlay[style*='flex']").forEach(function (o) {
          o.classList.remove("active"); o.style.display = "none";
        });
      }
    });
    scanPath.addEventListener("keydown", function (e) {
      if (e.key === "Enter") btnScan.click();
    });
    // ── RAM status bars ────────────────────────────────────
    const ramAppFill = document.getElementById("ram-app-fill");
    const ramSysFill = document.getElementById("ram-sys-fill");
    const ramAppText = document.getElementById("ram-app-text");
    const ramSysText = document.getElementById("ram-sys-text");
    function formatBytes(v) {
      const u = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
    }
    async function updateRam() {
      try {
        const [sysMem, procMem] = await Promise.all([
          window.__TAURI__.invoke("get_memory_info").catch(function(){return null}),
          window.__TAURI__.invoke("get_process_memory").catch(function(){return null})
        ]);
        if (sysMem && sysMem.total_bytes > 0) {
          const total = sysMem.total_bytes;
          const sysUsed = sysMem.used_bytes;
          const sysPct = Math.round((sysUsed / total) * 100);
          ramSysFill.style.width = sysPct + "%";
          ramSysFill.className = "ram-bar-fill-sys" + (sysPct > 85 ? " critical" : sysPct > 70 ? " warning" : "");
          ramSysText.textContent = formatBytes(sysUsed) + " / " + formatBytes(total) + " (" + sysPct + "%)";
        }
        if (procMem && procMem.resident_bytes > 0) {
          const total = (sysMem && sysMem.total_bytes) || 1;
          const appMem = procMem.resident_bytes;
          const appPct = Math.round((appMem / total) * 100);
          ramAppFill.style.width = appPct + "%";
          ramAppText.textContent = formatBytes(appMem) + " (" + appPct + "%)";
        }
      } catch(e) {}
    }
    updateRam();
    setInterval(updateRam, 3000);
  };
})();
