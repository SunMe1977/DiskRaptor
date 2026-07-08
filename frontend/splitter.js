/**
 * Resizable Splitters
 *
 * 1. Vertical: between #left-column and #detail-panel (drag left/right)
 * 2. Horizontal: between #diagram-panel and #tree-panel (drag up/down)
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    // ── Vertical Splitter ────────────────────────────────────
    var vSplit = document.getElementById("v-splitter");
    var leftCol = document.getElementById("left-column");
    var mainLayout = document.getElementById("main-layout");

    if (vSplit && leftCol && mainLayout) {
      var vDragging = false;
      var vStartX = 0;
      var vStartWidth = 0;

      vSplit.addEventListener("mousedown", function (e) {
        vDragging = true;
        vStartX = e.clientX;
        vStartWidth = leftCol.offsetWidth;
        vSplit.classList.add("active");
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", function (e) {
        if (!vDragging) return;
        var dx = e.clientX - vStartX;
        var newWidth = vStartWidth + dx;
        newWidth = Math.max(
          200,
          Math.min(newWidth, mainLayout.offsetWidth - 300),
        );
        leftCol.style.flex = "none";
        leftCol.style.width = newWidth + "px";
      });

      document.addEventListener("mouseup", function () {
        if (vDragging) {
          vDragging = false;
          vSplit.classList.remove("active");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }

    // ── Horizontal Splitter ──────────────────────────────────
    var hSplit = document.getElementById("h-splitter");
    var diagPanel = document.getElementById("diagram-panel");

    if (hSplit && diagPanel && leftCol) {
      var hDragging = false;
      var hStartY = 0;
      var hStartHeight = 0;

      hSplit.addEventListener("mousedown", function (e) {
        hDragging = true;
        hStartY = e.clientY;
        hStartHeight = diagPanel.offsetHeight;
        hSplit.classList.add("active");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", function (e) {
        if (!hDragging) return;
        var dy = e.clientY - hStartY;
        var newHeight = hStartHeight + dy;
        newHeight = Math.max(
          120,
          Math.min(newHeight, leftCol.offsetHeight - 80),
        );
        diagPanel.style.flex = "none";
        diagPanel.style.height = newHeight + "px";
      });

      document.addEventListener("mouseup", function () {
        if (hDragging) {
          hDragging = false;
          hSplit.classList.remove("active");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }
  });
})();
