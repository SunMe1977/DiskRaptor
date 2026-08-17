/**
 * DiskRaptor — Internationalization (i18n)
 *
 * Translations live in per-locale files (i18n/<code>.js) that set
 * window.I18N_DATA[code] = { key: value }. Only the active locale (plus the
 * English fallback) is loaded on demand, so startup no longer parses 25
 * inline language tables.
 * Exports: window.__ = translate function
 *          window.I18N = { setLocale, getLocale, t }
 */

(function () {
  "use strict";

  // ── Language definitions ──────────────────────────────────
  const LANGUAGES = [
    { code: "en", flag: "🇺🇸", label: "English" },
    { code: "de", flag: "🇩🇪", label: "Deutsch" },
    { code: "fr", flag: "🇫🇷", label: "Français" },
    { code: "es", flag: "🇪🇸", label: "Español" },
    { code: "it", flag: "🇮🇹", label: "Italiano" },
    { code: "pt", flag: "🇧🇷", label: "Português" },
    { code: "nl", flag: "🇳🇱", label: "Nederlands" },
    { code: "pl", flag: "🇵🇱", label: "Polski" },
    { code: "sv", flag: "🇸🇪", label: "Svenska" },
    { code: "da", flag: "🇩🇰", label: "Dansk" },
    { code: "nb", flag: "🇳🇴", label: "Norsk" },
    { code: "fi", flag: "🇫🇮", label: "Suomi" },
    { code: "cs", flag: "🇨🇿", label: "Čeština" },
    { code: "ro", flag: "🇷🇴", label: "Română" },
    { code: "tr", flag: "🇹🇷", label: "Türkçe" },
    { code: "id", flag: "🇮🇩", label: "Bahasa Indonesia" },
    { code: "vi", flag: "🇻🇳", label: "Tiếng Việt" },
    { code: "ru", flag: "🇷🇺", label: "Русский" },
    { code: "uk", flag: "🇺🇦", label: "Українська" },
    { code: "ar", flag: "🇸🇦", label: "العربية" },
    { code: "zh", flag: "🇨🇳", label: "简体中文" },
    { code: "zh-tw", flag: "🇹🇼", label: "繁體中文" },
    { code: "ja", flag: "🇯🇵", label: "日本語" },
    { code: "ko", flag: "🇰🇷", label: "한국어" },
    { code: "hi", flag: "🇮🇳", label: "हिन्दी" },
  ];

  // Locale data loaded so far: { code: { key: value } }.
  const DATA = window.I18N_DATA || {};
  let loadQueue = null;

  let currentLocale = localStorage.getItem("diskraptor-lang") || "auto";
  let resolvedLocale = "en";

  function hasData(code) {
    return !!(DATA[code] && DATA[code]["toolbar.title"]);
  }

  function detectLocale() {
    // Try navigator.languages first (most reliable for WebView2)
    const navLangs = navigator.languages || [navigator.language || "en"];
    for (const raw of navLangs) {
      const code = raw.split("-")[0].toLowerCase();
      if (LANGUAGES.some(function (l) { return l.code === code; })) return code;
    }
    return "en";
  }

  function resolveLocale(locale) {
    if (locale === "auto") return detectLocale();
    if (LANGUAGES.some(function (l) { return l.code === locale; })) return locale;
    // Fallback: try the base language
    const base = locale.split("-")[0];
    if (LANGUAGES.some(function (l) { return l.code === base; })) return base;
    return "en";
  }

  // Load a locale file (plus the English fallback) if not present yet.
  function ensureLoaded(code) {
    const codes = [];
    if (!hasData(code)) codes.push(code);
    if (code !== "en" && !hasData("en")) codes.push("en");
    if (codes.length === 0) return Promise.resolve();
    if (!loadQueue) {
      loadQueue = Promise.all(
        codes.map(function (c) {
          return new Promise(function (resolve) {
            const s = document.createElement("script");
            s.src = "i18n/" + c + ".js";
            s.onload = function () {
              const g = window.I18N_DATA || {};
              for (const k in g) DATA[k] = g[k];
              resolve();
            };
            s.onerror = function () {
              DATA[c] = DATA[c] || {};
              resolve();
            };
            document.head.appendChild(s);
          });
        }),
      ).then(function () {
        loadQueue = null;
      });
    }
    return loadQueue;
  }

  function setLocale(locale) {
    currentLocale = locale;
    localStorage.setItem("diskraptor-lang", locale);
    resolvedLocale = resolveLocale(locale);
    applyTranslations();
    window.dispatchEvent(
      new CustomEvent("locale-changed", {
        detail: { locale: resolvedLocale, raw: locale },
      }),
    );
    document.documentElement.lang = resolvedLocale;
    // Re-apply once the chosen language's data is present.
    ensureLoaded(resolvedLocale).then(function () {
      resolvedLocale = resolveLocale(currentLocale);
      applyTranslations();
      window.dispatchEvent(
        new CustomEvent("locale-changed", {
          detail: { locale: resolvedLocale, raw: currentLocale },
        }),
      );
      document.documentElement.lang = resolvedLocale;
    });
  }

  function getLocale() {
    return { raw: currentLocale, resolved: resolvedLocale };
  }

  function t(key) {
    const table = DATA[resolvedLocale] || {};
    const val = table[key];
    if (val !== undefined) return val;
    if (resolvedLocale !== "en") {
      const enTable = DATA["en"] || {};
      if (enTable[key] !== undefined) return enTable[key];
    }
    return key;
  }

  // ── DOM translation ─────────────────────────────────
  function applyTranslations() {
    // Elements with data-i18n attribute get their textContent replaced
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = t(key);
    });
    // Elements with data-i18n-placeholder get their placeholder replaced
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.placeholder = t(key);
    });
    // Elements with data-i18n-title get their title replaced
    document.querySelectorAll("[data-i18n-title]").forEach((el) => {
      const key = el.getAttribute("data-i18n-title");
      el.title = t(key);
    });
    // Elements with data-i18n-html get their innerHTML replaced (sparingly)
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      el.innerHTML = t(key);
    });
  }

  // ── Exports ──────────────────────────────────────────
  window.I18N = {
    LANGUAGES,
    setLocale,
    getLocale,
    t,
    detectLocale,
  };
  window.__ = t; // shorthand

  // Auto-detect and apply on load. The locale data loads asynchronously; the
  // UI shows English (or the last selected language) until it arrives.
  resolvedLocale = resolveLocale(currentLocale);
  applyTranslations();
  ensureLoaded(resolvedLocale).then(function () {
    resolvedLocale = resolveLocale(currentLocale);
    applyTranslations();
    window.dispatchEvent(
      new CustomEvent("locale-changed", {
        detail: { locale: resolvedLocale, raw: currentLocale },
      }),
    );
    document.documentElement.lang = resolvedLocale;
  });

  console.debug(
    `[i18n] Detected locale: ${detectLocale()}, selected: ${currentLocale} → ${resolvedLocale}`,
  );
})();
