(function () {
  "use strict";

  // Custom modal dialogs that replace native prompt()/confirm()/alert().
  // Native dialogs are blocked/unstyled inside Tauri v2 webviews.

  function dialog({ message, placeholder, confirmText, cancelText, value }) {
    return new Promise(function (resolve) {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.55);" +
        "display:flex;align-items:center;justify-content:center;";
      overlay.className = "dlg-overlay";

      const card = document.createElement("div");
      card.style.cssText =
        "background:var(--bg-secondary,#1c2128);border:1px solid var(--border,#30363d);" +
        "border-radius:12px;max-width:420px;width:90%;box-shadow:0 16px 48px rgba(0,0,0,0.5);" +
        "overflow:hidden;";
      card.className = "dlg-card";

      const body = document.createElement("div");
      body.style.cssText =
        "padding:18px 20px;font-size:13px;color:var(--text-primary,var(--text-primary));" +
        "line-height:1.5;white-space:pre-wrap;word-break:break-word;";
      body.textContent = message;

      const input = placeholder !== undefined ? document.createElement("input") : null;
      if (input) {
        input.type = "text";
        input.value = value || "";
        input.style.cssText =
          "width:100%;margin-top:12px;padding:8px 10px;border-radius:6px;" +
          "border:1px solid var(--border,#30363d);background:var(--bg-tertiary,#161b22);" +
          "color:var(--text-primary,var(--text-primary));font-size:13px;";
        body.appendChild(input);
      }

      const footer = document.createElement("div");
      footer.style.cssText =
        "padding:10px 16px;border-top:1px solid var(--border,#30363d);" +
        "display:flex;justify-content:flex-end;gap:8px;background:var(--bg-secondary,#1c2128);";

      function makeBtn(text, isPrimary) {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText =
          "padding:7px 16px;border-radius:6px;font-size:13px;cursor:pointer;border:1px solid var(--border,#30363d);" +
          (isPrimary
            ? "background:linear-gradient(135deg,#238636,var(--accent-green));color:#fff;font-weight:600;"
            : "background:var(--bg-tertiary,#161b22);color:var(--text-primary);");
        return b;
      }

      function close(result) {
        document.removeEventListener("keydown", onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }

      function onKey(e) {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && input) close(input.value);
      }
      document.addEventListener("keydown", onKey);

      if (cancelText) {
        const cancel = makeBtn(cancelText, false);
        cancel.addEventListener("click", function () { close(null); });
        footer.appendChild(cancel);
      }
      const ok = makeBtn(confirmText, true);
      ok.addEventListener("click", function () {
        if (input) { close(input.value); } else { close(true); }
      });
      footer.appendChild(ok);

      overlay.appendChild(card);
      card.appendChild(body);
      card.appendChild(footer);
      document.body.appendChild(overlay);
      if (input) input.focus();
    });
  }

  /**
   * Confirmation dialog. Resolves true/false.
   */
  function confirmDialog(message) {
    return dialog({ message, confirmText: "OK", cancelText: "Cancel" });
  }

  /**
   * Alert dialog. Resolves undefined when dismissed.
   */
  function alertDialog(message) {
    return dialog({ message, confirmText: "OK" });
  }

  /**
   * Prompt dialog. Resolves the entered string, or null on cancel.
   */
  function promptDialog(message, defaultValue) {
    return dialog({ message, placeholder: "", value: defaultValue, confirmText: "OK", cancelText: "Cancel" });
  }

  window.confirmDialog = confirmDialog;
  window.alertDialog = alertDialog;
  window.promptDialog = promptDialog;
})();
