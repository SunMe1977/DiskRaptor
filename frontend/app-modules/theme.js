(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initTheme = async function (getSetting, setSetting) {
    // ── Theme toggle ───────────────────────────────────────
    const btnTheme = document.getElementById("btn-theme");
    getSetting("theme", "auto").then(function (savedTheme) {
      if (savedTheme === undefined || savedTheme === null) savedTheme = "auto";
      let isLight = false;
      if (savedTheme === "auto") {
        isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
      } else if (savedTheme === "light") {
        isLight = true;
      }
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
    btnTheme.addEventListener("click", function () {
      const isLight = document.body.classList.toggle("light-theme");
      setSetting("theme", isLight ? "light" : "dark");
      btnTheme.textContent = isLight ? "\u2600" : "\u263E";
      btnTheme.title = isLight ? "Switch to dark mode" : "Switch to light mode";
    });

    getSetting("language", "auto").then(function (savedLang) {
      if (savedLang && savedLang !== "auto" && window.I18N) {
        window.I18N.setLocale(savedLang);
      }
    });

    // ── Diagram theme buttons ─────────────────────────────
    const themeHint = document.getElementById("theme-hint");
    if (themeHint) {
      themeHint.textContent = "Choose a diagram style to preview the layout instantly";
    }
    document.querySelectorAll(".theme-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const theme = this.dataset.theme;
        if (
          window.__diagram &&
          typeof window.__diagram.setTheme === "function"
        ) {
          window.__diagram.setTheme(theme);
        }
        document.querySelectorAll(".theme-btn").forEach(function (b) {
          b.style.borderColor = "transparent";
        });
        this.style.borderColor = "#fff";
      });
    });
  };
})();
