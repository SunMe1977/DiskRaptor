(function () {
  "use strict";

  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement("div");
      container.id = "toast-container";
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

  function showToast(message, type) {
    type = type || "info";
    const duration = DURATIONS[type] || 4000;
    const c = getContainer();

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

    const closeBtn = document.createElement("button");
    closeBtn.className = "toast-close";
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
