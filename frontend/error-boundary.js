/**
 * error-boundary.js — global frontend error boundary for DiskRaptor.
 * Catches uncaught exceptions and unhandled promise rejections, surfaces a
 * non-blocking toast + status-bar message, and shows a recoverable banner
 * for fatal errors instead of leaving the UI in a broken silent state.
 */
(function () {
  "use strict";

  var banner = null;
  var errorCount = 0;

  function statusBar() {
    try {
      return document.querySelector(".status-bar");
    } catch (_) {
      return null;
    }
  }

  function showBanner(message) {
    try {
      if (banner && document.contains(banner)) {
        var msg = banner.querySelector("[data-eb-msg]");
        if (msg) msg.textContent = message;
        return;
      }
      banner = document.createElement("div");
      banner.setAttribute("role", "alert");
      banner.style.cssText =
        "position:fixed;left:12px;right:12px;bottom:12px;z-index:10000;" +
        "background:rgba(248,81,73,0.12);border:1px solid #f85149;border-radius:8px;" +
        "padding:10px 12px;display:flex;gap:10px;align-items:center;" +
        "font-size:12px;color:var(--text-primary);backdrop-filter:blur(6px);";
      var icon = document.createElement("span");
      icon.textContent = "\u26A0\uFE0F";
      var text = document.createElement("span");
      text.setAttribute("data-eb-msg", "");
      text.style.flex = "1";
      text.textContent = message;
      var reloadBtn = document.createElement("button");
      reloadBtn.textContent = "Reload";
      reloadBtn.style.cssText =
        "padding:5px 12px;border:1px solid var(--border);border-radius:6px;" +
        "background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;";
      reloadBtn.onclick = function () {
        try {
          window.location.reload();
        } catch (_) {}
      };
      var dismissBtn = document.createElement("button");
      dismissBtn.textContent = "\u2715";
      dismissBtn.setAttribute("aria-label", "Dismiss");
      dismissBtn.style.cssText =
        "padding:5px 10px;border:none;background:none;color:var(--text-muted);cursor:pointer;";
      dismissBtn.onclick = function () {
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      };
      banner.appendChild(icon);
      banner.appendChild(text);
      banner.appendChild(reloadBtn);
      banner.appendChild(dismissBtn);
      document.body.appendChild(banner);
    } catch (_) {}
  }

  function report(kind, err) {
    errorCount += 1;
    var message = "";
    try {
      message = (err && (err.message || err.reason || err)) || "Unknown error";
      message = String(message).slice(0, 300);
    } catch (_) {
      message = "Unknown error";
    }
    try {
      console.error("[DiskRaptor error-boundary][" + kind + "]", err);
    } catch (_) {}
    try {
      if (window.showToast) {
        var t = (window.__ || window.t || function (s) { return s; })("toast.failed");
        window.showToast(
          typeof t === "string" && t.indexOf("{err}") >= 0
            ? t.replace("{err}", message)
            : "Failed: " + message,
          "error",
        );
      }
    } catch (_) {}
    var sb = statusBar();
    if (sb) {
      try {
        sb.textContent = "Error: " + message;
        sb.style.color = "#f85149";
      } catch (_) {}
    }
    // Only escalate to a banner when errors repeat (a single transient
    // failure shouldn't block the UI).
    if (errorCount >= 3) showBanner("DiskRaptor hit repeated errors: " + message);
  }

  window.addEventListener("error", function (event) {
    report("uncaught", event && (event.error || event.message));
  });
  window.addEventListener("unhandledrejection", function (event) {
    report("unhandledrejection", event && (event.reason || event));
  });

  window.__errorBoundary = {
    reset: function () {
      errorCount = 0;
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
    },
  };
})();
