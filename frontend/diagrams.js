/**
 * DiskRaptor Diagrams — Top 50 files visualization
 *
 * Pie Chart and Treemap of the 50 largest files.
 * Hover → full filename tooltip.  Click → action menu + jump in tree.
 */
class DiagramRenderer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    this.canvas = null;
    this.ctx = null;
    this.mode = "pie";
    this.data = null;
    this.files = [];
    this.hitRegions = [];
    this.tooltipEl = null;
    this.contextMenu = null;
    this._hoveredIndex = -1;
    this._isLinux =
      /linux/i.test(navigator.platform || "") ||
      /linux/i.test(navigator.userAgent || "");
    this._init();
  }

  _init() {
    // Canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");

    // Tooltip
    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "diagram-tooltip";
    Object.assign(this.tooltipEl.style, {
      position: "fixed",
      display: "none",
      zIndex: 3000,
      background: "#1f1f1f",
      border: "1px solid #444",
      borderRadius: "4px",
      padding: "4px 10px",
      fontSize: "12px",
      color: "#e6edf3",
      pointerEvents: "none",
      maxWidth: "500px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
      fontFamily: "monospace",
    });
    document.body.appendChild(this.tooltipEl);

    // Context menu
    this.contextMenu = document.createElement("div");
    Object.assign(this.contextMenu.style, {
      position: "fixed",
      display: "none",
      zIndex: 3001,
      background: "#161b22",
      border: "1px solid #30363d",
      borderRadius: "6px",
      padding: "4px 0",
      minWidth: "200px",
      maxHeight: "70vh",
      overflowY: "auto",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    });
    var explorerLabel = this._isLinux ? "Open in File Manager" : "Open in Explorer";
    this.contextMenu.innerHTML =
      '<div class="diag-ctx-item" data-action="explorer">\u{1F4C2} ' + explorerLabel + '</div>' +
      '<div class="diag-ctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
      '<div class="diag-ctx-item" data-action="tree">\u{1F332} Jump in Tree</div>' +
      '<div class="diag-ctx-sep"></div>' +
      '<div class="diag-ctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
      '<div class="diag-ctx-item" data-action="copy">\u{1F4CB} Copy Path</div>' +
      '<div class="diag-ctx-sep"></div>' +
      '<div class="diag-ctx-item diag-ctx-del" data-action="delete">\u{1F5D1}\uFE0F Delete</div>';
    document.body.appendChild(this.contextMenu);

    // Context menu styles
    const style = document.createElement("style");
    style.textContent =
      ".diag-ctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:#e6edf3;}" +
      ".diag-ctx-item:hover{background:#30363d;}" +
      ".diag-ctx-sep{height:1px;background:#30363d;margin:4px 8px;}" +
      ".diag-ctx-del{color:#f85149;}";
    document.head.appendChild(style);

    // Events
    this.canvas.addEventListener("mousemove", (e) => this._onMouseMove(e));
    this.canvas.addEventListener("mouseleave", () => this._hideTooltip());
    this.canvas.addEventListener("click", (e) => this._onClick(e));
    document.addEventListener("click", (e) => {
      if (
        this.contextMenu &&
        !this.contextMenu.contains(e.target) &&
        e.target !== this.canvas
      ) {
        this.contextMenu.style.display = "none";
      }
    });
    this.contextMenu.addEventListener("click", (e) =>
      this._onContextMenuAction(e),
    );

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  _resize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._draw();
  }

  setMode(mode) {
    if (mode !== "pie" && mode !== "treemap") return;
    this.mode = mode;
    this._draw();
  }

  setData(data) {
    this.data = data;
    const raw = (data && data.top_files) || [];
    this.files = raw.slice(0, 50).map((f, i) => ({
      path: f.path || "?",
      size: f.size || 0,
      size_human: f.size_human || this._formatSize(f.size || 0),
      index: i,
    }));
    this.files.sort((a, b) => b.size - a.size);
    this._draw();
  }

  _draw() {
    if (!this.ctx || !this.canvas || !this.data) return;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, w, h);
    this.hitRegions = [];

    if (this.files.length === 0) {
      this.ctx.fillStyle = "#484f58";
      this.ctx.font = "14px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText("No file data. Run a scan first.", w / 2, h / 2);
      return;
    }

    if (this.mode === "pie") this._drawPie(w, h);
    else this._drawTreemap(w, h);
  }

  // ── Pie Chart ──────────────────────────────────────────────
  _drawPie(w, h) {
    const ctx = this.ctx;
    const margin = 10;
    const legendW = Math.min(160, w * 0.3);
    const pieArea = w - legendW - margin * 3;
    const cx = margin + pieArea / 2;
    const cy = h / 2;
    const radius = Math.min(pieArea / 2, cy) - 8;
    const totalSize = this.files.reduce((s, f) => s + f.size, 1);
    const colors = this._colors();

    let startAngle = -Math.PI / 2;
    const maxLabels = Math.min(this.files.length, 12);

    this.files.forEach((file, i) => {
      const sliceAngle = (file.size / totalSize) * Math.PI * 2;
      const color = colors[i % colors.length];
      const isHov = i === this._hoveredIndex;
      const r = isHov ? radius + 5 : radius;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();

      if (isHov) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      this.hitRegions.push({
        index: i,
        path: file.path,
        size: file.size,
        size_human: file.size_human,
        type: "pie",
        cx,
        cy,
        startAngle,
        endAngle: startAngle + sliceAngle,
        radius: r,
      });

      if (sliceAngle > 0.06 && i < maxLabels) {
        const mid = startAngle + sliceAngle / 2;
        const lx = cx + Math.cos(mid) * (r * 0.65);
        const ly = cy + Math.sin(mid) * (r * 0.65);
        ctx.fillStyle = "#fff";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const name = this._shortName(file.path);
        ctx.fillText(name, lx, ly);
      }
      startAngle += sliceAngle;
    });

    // Legend
    const lx = w - legendW - margin;
    let ly = 16;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "top";
    const maxLeg = Math.min(this.files.length, 18);
    for (let i = 0; i < maxLeg; i++) {
      const f = this.files[i];
      const name = this._shortName(f.path);
      const pct = ((f.size / totalSize) * 100).toFixed(1);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(lx, ly, 8, 8);
      ctx.fillStyle = "#e6edf3";
      ctx.textAlign = "left";
      ctx.fillText(name + " " + pct + "%", lx + 12, ly);
      ly += 15;
    }
    if (this.files.length > 18) {
      ctx.fillStyle = "#8b949e";
      ctx.textAlign = "left";
      ctx.fillText("+" + (this.files.length - 18) + " more", lx + 12, ly);
    }

    // Center label
    ctx.fillStyle = "#8b949e";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Top " + this.files.length, cx, cy - 8);
    ctx.fillStyle = "#e6edf3";
    ctx.font = "bold 13px sans-serif";
    ctx.fillText(this._formatSize(totalSize), cx, cy + 10);
  }

  // ── Treemap: Squarified Algorithm ───────────────────────────
  // Professional layout that fills the entire area without gaps.
  // Each rectangle's area is proportional to the file's size.
  _drawTreemap(w, h) {
    const ctx = this.ctx;
    const totalSize = this.files.reduce((s, f) => s + f.size, 1);
    const colors = this._colors();
    const titleH = 18;
    const margin = 4;
    const availW = w - margin * 2;
    const availH = h - margin * 2 - titleH;

    if (this.files.length === 0 || availW < 20 || availH < 20) {
      ctx.fillStyle = "#484f58";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data", w / 2, h / 2);
      return;
    }

    // Normalized sizes summing to the total area
    const totalArea = availW * availH;
    const items = this.files.map((f, i) => ({
      index: i,
      path: f.path,
      size: f.size,
      size_human: f.size_human,
      area: Math.max(totalArea * 0.001, (f.size / totalSize) * totalArea),
    }));
    // Re-normalize areas to exactly fill totalArea
    const areaSum = items.reduce((s, it) => s + it.area, 0);
    items.forEach((it) => {
      it.area = (it.area / areaSum) * totalArea;
    });

    // Squarified treemap using recursive subdivision
    // We precompute all rectangles into this.rects
    const rects = [];
    const stack = [
      { x: margin, y: margin, w: availW, h: availH, items: items },
    ];

    while (stack.length > 0) {
      const cell = stack.pop();
      if (cell.items.length === 0) continue;
      if (cell.items.length === 1) {
        rects.push({
          index: cell.items[0].index,
          x: cell.x,
          y: cell.y,
          w: cell.w,
          h: cell.h,
          path: cell.items[0].path,
          size: cell.items[0].size,
          size_human: cell.items[0].size_human,
        });
        continue;
      }

      // Decide orientation: split along the longest axis
      const horizontal = cell.w >= cell.h;
      const total = cell.items.reduce((s, it) => s + it.area, 0);

      // Find the split point where items are partitioned as evenly as possible
      // while maintaining good aspect ratios
      let splitIdx = 1;
      let bestScore = Infinity;
      let cumSum = 0;
      const halfTotal = total / 2;

      for (let i = 0; i < cell.items.length - 1; i++) {
        cumSum += cell.items[i].area;
        const ratio = cumSum / total;
        const firstSize = horizontal ? cell.w : cell.h;
        const secondSize = horizontal ? cell.w : cell.h;
        const firstDim = ratio * firstSize;
        const secondDim = (1 - ratio) * secondSize;
        const otherDim = horizontal ? cell.h : cell.w;

        // Aspect ratios of the two sub-rectangles
        const ar1 = horizontal ? firstDim / otherDim : otherDim / firstDim;
        const ar2 = horizontal ? secondDim / otherDim : otherDim / secondDim;

        const score = Math.max(ar1, ar2) + Math.abs(ratio - 0.5) * 2;
        if (score < bestScore) {
          bestScore = score;
          splitIdx = i + 1;
        }
      }

      const leftItems = cell.items.slice(0, splitIdx);
      const rightItems = cell.items.slice(splitIdx);
      const leftArea = leftItems.reduce((s, it) => s + it.area, 0);
      const ratio = leftArea / total;

      if (horizontal) {
        const leftW = Math.max(10, ratio * cell.w);
        const rightW = Math.max(10, cell.w - leftW);
        stack.push({
          x: cell.x,
          y: cell.y,
          w: leftW,
          h: cell.h,
          items: leftItems,
        });
        stack.push({
          x: cell.x + leftW,
          y: cell.y,
          w: rightW,
          h: cell.h,
          items: rightItems,
        });
      } else {
        const topH = Math.max(10, ratio * cell.h);
        const bottomH = Math.max(10, cell.h - topH);
        stack.push({
          x: cell.x,
          y: cell.y,
          w: cell.w,
          h: topH,
          items: leftItems,
        });
        stack.push({
          x: cell.x,
          y: cell.y + topH,
          w: cell.w,
          h: bottomH,
          items: rightItems,
        });
      }
    }

    // Draw all rectangles (no gaps, no overlaps)
    const gap = 1; // 1px gap between rectangles
    for (const r of rects) {
      const isHov = r.index === this._hoveredIndex;
      const color = colors[r.index % colors.length];

      // Shrink slightly for the gap
      const rx = r.x + gap;
      const ry = r.y + gap;
      const rw = Math.max(2, r.w - gap * 2);
      const rh = Math.max(2, r.h - gap * 2);

      ctx.fillStyle = color;
      ctx.fillRect(rx, ry, rw, rh);

      if (isHov) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.strokeRect(rx, ry, rw, rh);
      }

      this.hitRegions.push({
        index: r.index,
        path: r.path,
        size: r.size,
        size_human: r.size_human,
        type: "treemap",
        x: rx,
        y: ry,
        w: rw,
        h: rh,
      });

      // Label if cell is big enough
      if (rw > 28 && rh > 14) {
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const name = this._shortName(r.path);
        ctx.fillText(name, rx + 3, ry + 3);

        // Size on second line if enough height
        if (rh > 26) {
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.font = "8px sans-serif";
          ctx.fillText(r.size_human, rx + 3, ry + 14);
        }
      }
    }

    // Title
    ctx.fillStyle = "#8b949e";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Top " + this.files.length + " Files by Size", w / 2, h - 2);
  }

  // ── Hit Testing ────────────────────────────────────────────
  _hitTest(mx, my) {
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const r = this.hitRegions[i];
      if (r.type === "pie") {
        const dx = mx - r.cx,
          dy = my - r.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r.radius) continue;
        let angle = Math.atan2(dy, dx);
        if (angle < 0) angle += Math.PI * 2;
        let sa = r.startAngle;
        if (sa < 0) sa += Math.PI * 2;
        let ea = r.endAngle;
        if (ea < 0) ea += Math.PI * 2;
        if (sa > ea) ea += Math.PI * 2;
        if (angle < sa) angle += Math.PI * 2;
        if (angle >= sa && angle <= ea) return r;
      } else {
        if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h)
          return r;
      }
    }
    return null;
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      this._hoveredIndex = hit.index;
      this.canvas.style.cursor = "pointer";
      this.tooltipEl.textContent = hit.path + "  [" + hit.size_human + "]";
      this.tooltipEl.style.display = "block";
      this.tooltipEl.style.left = e.clientX + 12 + "px";
      this.tooltipEl.style.top = e.clientY - 10 + "px";
      this._draw();
    } else {
      this._hideTooltip();
    }
  }

  _hideTooltip() {
    if (this._hoveredIndex !== -1) {
      this._hoveredIndex = -1;
      this._draw();
    }
    this.tooltipEl.style.display = "none";
    this.canvas.style.cursor = "default";
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) this._showContextMenu(e.clientX, e.clientY, hit);
    else this.contextMenu.style.display = "none";
  }

  _showContextMenu(x, y, hit) {
    this.contextMenu._filePath = hit.path;
    this.contextMenu._fileName =
      hit.path.split("\\").pop() || hit.path.split("/").pop() || hit.path;
    this.contextMenu.style.display = "block";
    var menuW = this.contextMenu.offsetWidth || 220;
    var menuH = this.contextMenu.offsetHeight || 220;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var left = Math.max(8, Math.min(x, vw - menuW - 8));
    var top = Math.max(8, Math.min(y, vh - menuH - 8));
    this.contextMenu.style.left = left + "px";
    this.contextMenu.style.top = top + "px";
  }

  _onContextMenuAction(e) {
    const item = e.target.closest(".diag-ctx-item");
    if (!item) return;
    const action = item.dataset.action;
    const filePath = this.contextMenu._filePath;
    this.contextMenu.style.display = "none";
    if (!filePath) return;

    const sb = document.querySelector(".status-bar");

    switch (action) {
      case "explorer":
        this._invoke("open_explorer", { path: filePath }).catch(() => {});
        break;
      case "terminal": {
        const dir = filePath.includes("\\")
          ? filePath.substring(0, filePath.lastIndexOf("\\"))
          : filePath.includes("/")
            ? filePath.substring(0, filePath.lastIndexOf("/"))
            : filePath;
        this._invoke("open_terminal", { path: dir }).catch(() => {});
        break;
      }
      case "properties":
        this._invoke("open_properties", { path: filePath }).catch(() => {});
        break;
      case "copy":
        navigator.clipboard
          .writeText(filePath)
          .then(() => {
            if (sb) sb.textContent = "Copied: " + filePath;
          })
          .catch(() => {});
        break;
      case "tree":
        // Dispatch a custom event for the tree to jump to this path
        window.dispatchEvent(
          new CustomEvent("diagram-jump-to-path", {
            detail: { path: filePath },
          }),
        );
        if (sb) sb.textContent = "Locating: " + filePath;
        break;
      case "delete":
        if (confirm("Delete file?\n" + filePath)) {
          this._invoke("delete_path", { path: filePath })
            .then(() => {
              if (sb) sb.textContent = "Deleted: " + this.contextMenu._fileName;
              this.files = this.files.filter((f) => f.path !== filePath);
              if (this.data && this.data.top_files) {
                this.data.top_files = this.data.top_files.filter(
                  (f) => f.path !== filePath,
                );
              }
              this._draw();
            })
            .catch((err) => alert("Delete failed: " + err));
        }
        break;
    }
  }

  _invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.invoke)
      return window.__TAURI__.invoke(cmd, args);
    return Promise.reject(new Error("No invoke"));
  }

  _shortName(p) {
    return p.split("\\").pop() || p.split("/").pop() || p;
  }

  _colors() {
    const c = [
      "#58a6ff",
      "#3fb950",
      "#d29922",
      "#f85149",
      "#bc8cff",
      "#79c0ff",
      "#56d364",
      "#e3b341",
      "#ff7b72",
      "#d2a8ff",
      "#8b949e",
      "#484f58",
      "#f0883e",
      "#7ee787",
      "#a5d6ff",
      "#ffa657",
      "#ff7b72",
      "#c9d1d9",
      "#f778ba",
      "#db6d28",
    ];
    const res = [];
    for (let i = 0; i < 50; i++) res.push(c[i % c.length]);
    return res;
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const u = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const v = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + " B" : v.toFixed(2) + " " + u[i];
  }
}
