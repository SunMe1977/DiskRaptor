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

    // ── Topfiles Splitter (between Selection and Top 50) ────
    var tfSplit = document.getElementById("tf-splitter");
    var topfilesCard = document.getElementById("topfiles-card");
    var detailPanel = document.getElementById("detail-panel");

    if (tfSplit && topfilesCard && detailPanel) {
      var tfDragging = false;
      var tfStartY = 0;
      var tfStartHeight = 0;

      tfSplit.addEventListener("mousedown", function (e) {
        tfDragging = true;
        tfStartY = e.clientY;
        // Use getBoundingClientRect for accurate height even when flex=1
        tfStartHeight = topfilesCard.getBoundingClientRect().height;
        if (tfStartHeight < 50) tfStartHeight = 150; // fallback
        tfSplit.classList.add("active");
        document.body.style.cursor = "row-resize";
        document.body.style.userSelect = "none";
      });

      document.addEventListener("mousemove", function (e) {
        if (!tfDragging) return;
        // Invert: drag down = topfiles larger, drag up = smaller
        var dy = tfStartY - e.clientY;
        var newHeight = tfStartHeight + dy;
        // Clamp between 60px and available space minus 200px for stats
        var maxH = Math.max(60, detailPanel.offsetHeight - 220);
        newHeight = Math.max(60, Math.min(newHeight, maxH));
        topfilesCard.style.flex = "none";
        topfilesCard.style.height = newHeight + "px";
      });

      document.addEventListener("mouseup", function () {
        if (tfDragging) {
          tfDragging = false;
          tfSplit.classList.remove("active");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });
    }
  });
})();
