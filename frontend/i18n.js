/**
 * DiskRaptor — Internationalization (i18n)
 *
 * Inline translations for the desktop app.
 * Website version at C:\dev\diskraptor.com uses JSON-based loading.
 */
(function () {
  "use strict";

  var LANGUAGES = [
    { code: "en", flag: "\ud83c\uddfa\ud83c\uddf8", label: "English" },
    { code: "de", flag: "\ud83c\udde9\ud83c\uddea", label: "Deutsch" },
    { code: "fr", flag: "\ud83c\uddeb\ud83c\uddf7", label: "Fran\u00e7ais" },
    { code: "es", flag: "\ud83c\uddea\ud83c\uddf8", label: "Espa\u00f1ol" },
    { code: "it", flag: "\ud83c\uddee\ud83c\uddf9", label: "Italiano" },
    { code: "pt", flag: "\ud83c\udde7\ud83c\uddf7", label: "Portugu\u00eas" },
    { code: "nl", flag: "\ud83c\uddf3\ud83c\uddf1", label: "Nederlands" },
    { code: "pl", flag: "\ud83c\uddf5\ud83c\uddf1", label: "Polski" },
    { code: "sv", flag: "\ud83c\uddf8\ud83c\uddea", label: "Svenska" },
    { code: "da", flag: "\ud83c\udde9\ud83c\uddf0", label: "Dansk" },
    { code: "nb", flag: "\ud83c\uddf3\ud83c\uddf4", label: "Norsk" },
    { code: "fi", flag: "\ud83c\uddeb\ud83c\uddee", label: "Suomi" },
    { code: "cs", flag: "\ud83c\udde8\ud83c\uddff", label: "\u010ce\u0161tina" },
    { code: "ro", flag: "\ud83c\uddf7\ud83c\uddf4", label: "Rom\u00e2n\u0103" },
    { code: "tr", flag: "\ud83c\uddf9\ud83c\uddf7", label: "T\u00fcrk\u00e7e" },
    { code: "id", flag: "\ud83c\uddee\ud83c\udde9", label: "Bahasa Indonesia" },
    { code: "vi", flag: "\ud83c\uddfb\ud83c\uddf3", label: "Ti\u1ebfng Vi\u1ec7t" },
    { code: "ru", flag: "\ud83c\uddf7\ud83c\uddfa", label: "\u0420\u0443\u0441\u0441\u043a\u0438\u0439" },
    { code: "uk", flag: "\ud83c\uddfa\ud83c\udde6", label: "\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430" },
    { code: "ar", flag: "\ud83c\uddf8\ud83c\udde6", label: "\u0627\u0644\u0639\u0631\u0628\u064a\u0629" },
    { code: "zh", flag: "\ud83c\udde8\ud83c\uddf3", label: "\u7b80\u4f53\u4e2d\u6587" },
    { code: "zh-tw", flag: "\ud83c\uddf9\ud83c\uddfc", label: "\u7e41\u9ad4\u4e2d\u6587" },
    { code: "ja", flag: "\ud83c\uddef\ud83c\uddf5", label: "\u65e5\u672c\u8a9e" },
    { code: "ko", flag: "\ud83c\uddf0\ud83c\uddf7", label: "\ud55c\uad6d\uc5b4" },
    { code: "hi", flag: "\ud83c\uddee\ud83c\uddf3", label: "\u0939\u093f\u0928\u094d\u0926\u0940" },
  ];

  // Load app translations from inline data (not JSON — app is self-contained)
  var STRINGS = {
    "toolbar.title":"DiskRaptor","scan.path.placeholder":"Select or type a directory path\u2026","btn.browse":"Browse","btn.scan":"Scan","btn.cancel":"Cancel","btn.export":"Export","theme.toggle.dark":"Switch to dark mode","theme.toggle.light":"Switch to light mode","tree.title":"Directory Tree","tree.nodes":"nodes","tree.ready":"Ready","tree.loading":"Loading chunks\u2026","stats.title":"Scan Summary","stats.files":"Files","stats.directories":"Directories","stats.total_size":"Total Size","stats.scan_time":"Scan Time","sel.title":"Selection","sel.name":"Name","sel.size":"Size","sel.files":"Files","sel.type":"Type","diagram.top50":"Top 50 Files","diagram.pie":"Pie","diagram.treemap":"Treemap","diagram.galaxy":"🌌 Galaxy","galaxy.empty":"Scan a directory to explore the galaxy","galaxy.timeline":"Time Travel","galaxy.insight.title":"AI Insight","progress.scanning":"Scanning directory\u2026","progress.engine":"Scanning with the ultra-fast parallel Rust engine\u2026","progress.files_found":"files found, scanning\u2026","progress.building":"Building tree\u2026","progress.chunking":"Chunking\u2026","progress.elapsed":"Elapsed: ","progress.done":"done","status.complete":"Complete","status.backend_missing":"Backend not connected. Run via npm run tauri dev.","action.explorer":"Open in Explorer","action.terminal":"Open Terminal","action.properties":"Properties","action.copy_path":"Copy Path","action.delete":"Delete","action.jump_in_tree":"Jump in Tree","about.title":"About DiskRaptor","about.version":"Version","about.desc":"Ultra-fast directory scanner","about.tech":"Built with Rust + Tauri","about.done":"Done","lang.label":"Language","lang.auto":"Auto (System)"
  };

  var currentLocale = "auto";
  var resolvedLocale = "en";

  function detectLocale() {
    var l = navigator.languages || [navigator.language || "en"];
    for (var i = 0; i < l.length; i++) {
      var c = l[i].split("-")[0].toLowerCase();
      for (var j = 0; j < LANGUAGES.length; j++) { if (LANGUAGES[j].code === c) return c; }
    }
    return "en";
  }

  function resolveLocale(locale) {
    if (locale === "auto") return detectLocale();
    for (var j = 0; j < LANGUAGES.length; j++) { if (LANGUAGES[j].code === locale) return locale; }
    return "en";
  }

  // German translations (extend for each language as needed)
  var DE = {"toolbar.title":"DiskRaptor","diagram.galaxy":"🌌 Galaxy","galaxy.empty":"Scanne ein Verzeichnis um die Galaxie zu erkunden","galaxy.timeline":"Zeitreise","galaxy.insight.title":"KI-Erkenntnis","scan.path.placeholder":"Verzeichnispfad ausw\u00e4hlen oder eingeben\u2026","btn.browse":"Durchsuchen","btn.scan":"Scannen","btn.cancel":"Abbrechen","btn.export":"Exportieren","theme.toggle.dark":"Zum dunklen Modus wechseln","theme.toggle.light":"Zum hellen Modus wechseln","tree.title":"Verzeichnisbaum","tree.nodes":"Knoten","tree.ready":"Bereit","tree.loading":"Lade Bl\u00f6cke\u2026","stats.title":"Scan-Zusammenfassung","stats.files":"Dateien","stats.directories":"Verzeichnisse","stats.total_size":"Gesamtgr\u00f6\u00dfe","stats.scan_time":"Scan-Zeit","sel.title":"Auswahl","sel.name":"Name","sel.size":"Gr\u00f6\u00dfe","sel.files":"Dateien","sel.type":"Typ","diagram.top50":"Top 50 Dateien","diagram.pie":"Kreisdiagramm","diagram.treemap":"Baumkarte","progress.scanning":"Scanne Verzeichnis\u2026","progress.engine":"Scanne mit der ultraschnellen parallelen Rust-Engine\u2026","progress.files_found":"Dateien gefunden, scanne\u2026","progress.building":"Erstelle Baum\u2026","progress.chunking":"Blockbildung\u2026","progress.elapsed":"Verstrichen: ","progress.done":"fertig","status.complete":"Abgeschlossen","status.backend_missing":"Backend nicht verbunden. Starte mit npm run tauri dev.","action.explorer":"Im Explorer \u00f6ffnen","action.terminal":"Terminal \u00f6ffnen","action.properties":"Eigenschaften","action.copy_path":"Pfad kopieren","action.delete":"L\u00f6schen","action.jump_in_tree":"Im Baum springen","about.title":"\u00dcber DiskRaptor","about.version":"Version","about.desc":"Ultra-schneller Verzeichnisscanner","about.tech":"Entwickelt mit Rust + Tauri","about.done":"Fertig","lang.label":"Sprache","lang.auto":"Auto (System)"};

  function t(key) {
    if (resolvedLocale === "de" && DE[key]) return DE[key];
    return STRINGS[key] !== undefined ? STRINGS[key] : key;
  }

  function apply() {
    document.querySelectorAll("[data-i18n]").forEach(function(el){el.textContent=t(el.getAttribute("data-i18n"));});
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function(el){el.placeholder=t(el.getAttribute("data-i18n-placeholder"));});
    document.querySelectorAll("[data-i18n-title]").forEach(function(el){el.title=t(el.getAttribute("data-i18n-title"));});
  }

  function setLocale(locale, cb) {
    currentLocale = locale;
    resolvedLocale = resolveLocale(locale);
    localStorage.setItem("diskraptor-lang", locale);
    apply();
    document.documentElement.lang = resolvedLocale;
    window.dispatchEvent(new CustomEvent("locale-changed",{detail:{locale:resolvedLocale,raw:currentLocale}}));
    if (cb) cb();
  }

  // Init
  var saved = localStorage.getItem("diskraptor-lang") || "auto";
  var m = window.location.search.match(/[?&]lang=([a-z-]+)/i);
  if (m) saved = m[1].toLowerCase();
  currentLocale = saved;
  resolvedLocale = resolveLocale(saved);
  apply();
  document.documentElement.lang = resolvedLocale;

  window.I18N = { LANGUAGES: LANGUAGES, setLocale: setLocale, getLocale: function(){return{raw:currentLocale,resolved:resolvedLocale};}, t: t, detectLocale: detectLocale };
  window.__ = t;
})();
