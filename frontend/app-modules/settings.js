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

      // Populate language dropdown from I18N.LANGUAGES
      const langSel = document.getElementById("settings-language");
      if (langSel && window.I18N && Array.isArray(window.I18N.LANGUAGES)) {
        window.I18N.LANGUAGES.forEach(function (lang) {
          const opt = document.createElement("option");
          opt.value = lang.code;
          opt.textContent = (lang.flag ? lang.flag + " " : "") + (lang.label || lang.code);
          langSel.appendChild(opt);
        });
      }
      // Show app data location
      (async function () {
        try {
          const r = await window.__TAURI__.invoke("get_app_data_dir");
          const p = r && r.data ? r.data.path : "";
          const el = document.getElementById("settings-appdata");
          if (el && p) el.textContent = p;
        } catch (e) {}
      })();

      const presets = [
        { label: "Quick Scan", value: "/Users" },
        { label: "Downloads", value: "~/Downloads" },
        { label: "Desktop", value: "~/Desktop" }
      ];
      const presetWrap = document.getElementById("settings-presets");
      if (presetWrap) {
        presetWrap.innerHTML = presets.map(function (p) {
          return '<button type="button" class="settings-preset" data-path="' + p.value + '" style="padding:6px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">' + p.label + '</button>';
        }).join("");
        presetWrap.querySelectorAll(".settings-preset").forEach(function (btn) {
          btn.addEventListener("click", function () {
            const input = document.getElementById("settings-default-path");
            if (input) input.value = this.dataset.path;
          });
        });
      }

      document
        .getElementById("settings-close")
        ?.addEventListener("click", function () { so.style.display = "none"; });
      document
        .getElementById("settings-save")
        ?.addEventListener("click", async function () {
          const defPath = document.getElementById("settings-default-path")?.value || "";
          const selTheme = document.getElementById("settings-theme")?.value || "auto";
          const selLang = (document.getElementById("settings-language")?.value || "auto");
          await window.__TAURI__
            .invoke("save_settings", { settings: { default_scan_path: defPath, theme: selTheme, language: selLang } })
            .catch(function () {});
          if (selTheme === "light") document.body.classList.add("light-theme");
          else if (selTheme === "dark") document.body.classList.remove("light-theme");
          else {
            const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
            document.body.classList.toggle("light-theme", isLight);
          }
          if (selLang !== "auto" && window.I18N && window.I18N.setLocale) {
            window.I18N.setLocale(selLang);
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
        if (sysMem && sysMem.total > 0) {
          const total = sysMem.total;
          const sysUsed = sysMem.used || (total - (sysMem.free || 0));
          const sysPct = Math.round((sysUsed / total) * 100);
          ramSysFill.style.width = sysPct + "%";
          ramSysFill.className = "ram-bar-fill-sys" + (sysPct > 85 ? " critical" : sysPct > 70 ? " warning" : "");
          ramSysText.textContent = formatBytes(sysUsed) + " / " + formatBytes(total) + " (" + sysPct + "%)";
        }
        if (procMem && procMem.resident > 0) {
          const total = (sysMem && sysMem.total) || 1;
          const appMem = procMem.resident;
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
