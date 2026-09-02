(function () {
  "use strict";

  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
      // Announce new toasts to screen readers without stealing focus.
      container.setAttribute("aria-live", "polite");
      container.setAttribute("aria-atomic", "false");
      document.body.appendChild(container);
    }
    return container;
  }

  const DURATIONS = {
    error: 6000,
    success: 4000,
    info: 4000,
    warning: 4000,
  };

  /**
   * Show a toast notification.
   * @param {string} message - The message to display
   * @param {'error'|'success'|'info'|'warning'} [type='info'] - Toast type
   * @param {{label?: string, onClick?: Function}} [action] - Optional action
   *        button (e.g. an "Undo" for destructive operations).
   */
  function showToast(message, type, action) {
    type = type || "info";
    const duration = (action && action.label) ? 10000 : (DURATIONS[type] || 4000);
    const c = getContainer();

    // Cap visible toasts so a burst of notifications doesn't stack forever.
    const MAX_VISIBLE = 3;
    while (c.children.length >= MAX_VISIBLE) {
      const first = c.firstElementChild;
      if (first) c.removeChild(first);
    }

    const toast = document.createElement("div");
    toast.className = "toast toast-" + type;

    const icons = {
      error: "✖",
      success: "✓",
      info: "ℹ",
      warning: "⚠",
    };
    const iconSpan = document.createElement("span");
    iconSpan.className = "toast-icon";
    iconSpan.textContent = icons[type] || "ℹ";
    toast.appendChild(iconSpan);

    const msgSpan = document.createElement("span");
    msgSpan.className = "toast-message";
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action && action.label && typeof action.onClick === "function") {
      const btn = document.createElement("button");
      btn.textContent = action.label;
      btn.style.cssText =
        "flex-shrink:0;padding:4px 12px;font-size:12px;font-weight:600;border:1px solid var(--accent);" +
        "border-radius:6px;background:var(--accent);color:#fff;cursor:pointer;";
      btn.addEventListener("click", function () {
        dismiss(toast);
        action.onClick();
      });
      toast.appendChild(btn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "toast-close";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = "&times;";
    closeBtn.addEventListener("click", function () {
      dismiss(toast);
    });
    toast.appendChild(closeBtn);

    c.appendChild(toast);

    requestAnimationFrame(function () {
      toast.classList.add("toast-visible");
    });

    let autoTimer = setTimeout(function () {
      dismiss(toast);
    }, duration);

    toast.addEventListener("mouseenter", function () {
      clearTimeout(autoTimer);
    });
    toast.addEventListener("mouseleave", function () {
      autoTimer = setTimeout(function () {
        dismiss(toast);
      }, duration);
    });

    function dismiss(el) {
      if (!el || el.classList.contains("toast-leaving")) return;
      el.classList.remove("toast-visible");
      el.classList.add("toast-leaving");
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }
  }

  window.showToast = showToast;
})();
