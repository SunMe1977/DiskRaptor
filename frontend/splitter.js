/**
 * Resizable Splitters
 *
 * 1. v-splitter: between #left-column and #detail-panel (horizontal)
 * 2. h-splitter: between #tree-panel and #diagram-panel (vertical)
 * 3. tf-splitter: between Selection card and #topfiles-card (vertical)
 *
 * All use the same pattern: mousedown on splitter → mousemove on document → mouseup.
 * Uses setPointerCapture for reliable drag tracking.
 */
(function () {
  "use strict";

  function makeSplitter(splitterId, targetId, opts) {
    var splitter = document.getElementById(splitterId);
    var target = document.getElementById(targetId);
    if (!splitter || !target) return;

    var dragging = false;
    var startPos = 0;
    var startSize = 0;
    var isVertical = opts.dir === "vertical"; // col-resize (left/right)
    // isRow = row-resize (up/down)

    splitter.addEventListener("mousedown", function (e) {
      e.preventDefault();
      dragging = true;
      startPos = isVertical ? e.clientX : e.clientY;
      var rect = target.getBoundingClientRect();
      startSize = isVertical ? rect.width : rect.height;
      if (startSize < 20) startSize = opts.min || 100; // fallback
      splitter.classList.add("active");
      document.body.style.cursor = isVertical ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    });

    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      var currentPos = isVertical ? e.clientX : e.clientY;
      var delta = currentPos - startPos;

      // For tf-splitter (inverted: drag down = topfiles larger)
      if (opts.invert) delta = -delta;

      var newSize = startSize + delta;

      // Clamp
      var minSize = opts.min || 60;
      var maxSize = opts.max || 10000;
      if (opts.getMax) maxSize = opts.getMax();
      newSize = Math.max(minSize, Math.min(newSize, maxSize));

      if (isVertical) {
        target.style.flex = "none";
        target.style.width = newSize + "px";
      } else {
        target.style.flex = "none";
        target.style.height = newSize + "px";
      }
    });

    document.addEventListener("mouseup", function () {
      if (dragging) {
        dragging = false;
        splitter.classList.remove("active");
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        if (opts.onDone) opts.onDone();
      }
    });
  }

  // Wait for DOM, then initialize all splitters
  function init() {
    // 1. Vertical: left-column width
    makeSplitter("v-splitter", "left-column", {
      dir: "vertical",
      min: 200,
      getMax: function () {
        var ml = document.getElementById("main-layout");
        return ml ? ml.offsetWidth - 300 : 800;
      },
    });

    // 2. Horizontal: diagram-panel height (below tree)
    // On mouseup, trigger diagram redraw so it fits the new size
    makeSplitter("h-splitter", "diagram-panel", {
      dir: "row",
      min: 80,
      getMax: function () {
        var lc = document.getElementById("left-column");
        return lc ? lc.offsetHeight - 80 : 400;
      },
      onDone: function () {
        // Trigger resize on diagram so it redraws at the new container size
        window.dispatchEvent(new Event("resize"));
        // Also try to call diagram's _resize directly
        var dc = document.getElementById("diagram-container");
        if (dc && dc.__diagram && dc.__diagram._resize) {
          dc.__diagram._resize();
        }
      },
    });

    // 3. Topfiles: topfiles-card height
    // Inverted: drag UP = larger (pushes the detail-panel content up)
    makeSplitter("tf-splitter", "topfiles-card", {
      dir: "row",
      min: 60,
      invert: true,
      getMax: function () {
        var dp = document.getElementById("detail-panel");
        // Reserve ~140px for the two cards above + splitter
        return dp ? Math.max(60, dp.offsetHeight - 160) : 600;
      },
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
