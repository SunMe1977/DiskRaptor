/**
 * Resizable Splitter — drag handle between tree panel and detail panel.
 */
(function() {
  "use strict";

  document.addEventListener("DOMContentLoaded", function() {
    var splitter = document.getElementById("splitter");
    var treePanel = document.getElementById("tree-panel");
    var detailPanel = document.getElementById("detail-panel");
    var mainLayout = document.getElementById("main-layout");

    if (!splitter || !treePanel || !detailPanel) return;

    var isDragging = false;
    var startX = 0;
    var startTreeWidth = 0;

    splitter.addEventListener("mousedown", function(e) {
      isDragging = true;
      startX = e.clientX;
      startTreeWidth = treePanel.offsetWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var newWidth = startTreeWidth + dx;
      var minWidth = 200;
      var maxWidth = mainLayout.offsetWidth - 300;
      newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      treePanel.style.flex = "none";
      treePanel.style.width = newWidth + "px";
    });

    document.addEventListener("mouseup", function() {
      if (isDragging) {
        isDragging = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    });
  });
})();
