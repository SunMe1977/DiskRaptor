/**
 * Resizable Splitters
 *
 * 1. Vertical: between #left-column and #detail-panel (drag left/right)
 * 2. Horizontal: between #diagram-panel and #tree-panel (drag up/down)
 * 3. Topfiles: between Selection and Top 50
 *
 * Double-click any splitter to reset to 50/50.
 */
(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", function () {
    // ── Vertical Splitter ────────────────────────────────────
    const vSplit = document.getElementById("v-splitter");
    const leftCol = document.getElementById("left-column");
    const mainLayout = document.getElementById("main-layout");

    if (vSplit && leftCol && mainLayout) {
      let vDragging = false;
      let vStartX = 0;
      let vStartWidth = 0;

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
        const dx = e.clientX - vStartX;
        const newWidth = vStartWidth + dx;
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

      // Double-click to reset width
      vSplit.addEventListener("dblclick", function () {
        leftCol.style.flex = "";
        leftCol.style.width = "";
      });
    }

    // ── Horizontal Splitter ──────────────────────────────────
    const hSplit = document.getElementById("h-splitter");
    const diagPanel = document.getElementById("diagram-panel");
    const treePanel = document.getElementById("tree-panel");

    if (hSplit && diagPanel && leftCol) {
      let hDragging = false;
      let hStartY = 0;
      let hStartHeight = 0;

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
        const dy = e.clientY - hStartY;
        const newHeight = hStartHeight + dy;
        newHeight = Math.max(
          80,
          Math.min(newHeight, leftCol.offsetHeight - 80),
        );
        diagPanel.style.flex = "none";
        diagPanel.style.height = newHeight + "px";
        // Allow tree panel to fill rest
        if (treePanel) {
          treePanel.style.flex = "";
        }
      });

      document.addEventListener("mouseup", function () {
        if (hDragging) {
          hDragging = false;
          hSplit.classList.remove("active");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        }
      });

      // Double-click to reset to 50/50
      hSplit.addEventListener("dblclick", function () {
        diagPanel.style.flex = "";
        diagPanel.style.height = "";
        diagPanel.style.flex = "1";
        if (treePanel) {
          treePanel.style.flex = "1";
        }
      });
    }

    // ── Topfiles Splitter (between Selection and Top 50) ────
    const tfSplit = document.getElementById("tf-splitter");
    const topfilesCard = document.getElementById("topfiles-card");
    const detailPanel = document.getElementById("detail-panel");

    if (tfSplit && topfilesCard && detailPanel) {
      let tfDragging = false;
      let tfStartY = 0;
      let tfStartHeight = 0;

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
        const dy = tfStartY - e.clientY;
        const newHeight = tfStartHeight + dy;
        // Clamp between 60px and available space minus 200px for stats
        const maxH = Math.max(60, detailPanel.offsetHeight - 220);
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

      // Double-click to reset topfiles splitter
      tfSplit.addEventListener("dblclick", function () {
        topfilesCard.style.flex = "";
        topfilesCard.style.height = "";
      });
    }
  });
})();
