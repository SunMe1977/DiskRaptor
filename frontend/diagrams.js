/**
 * DiskRaptor Diagrams — Top 50 files visualization
 *
 * Pie Chart and Treemap of the 50 largest files.
 * Hover → full filename tooltip.  Click → action menu + jump in tree.
 * Supports zoom: 20%, 50%, 100% (Actual Size), Fit (auto-zoom to viewport).
 *
 * Premium effects (GPU-accelerated, no canvas repaints):
 * - Micro-specular highlight following cursor
 * - Satin surface sweep (Apple Keynote style)
 * - Soft pressure effect on hover
 * - Entrance animation with micro-rotation noise
 * - Magnetic slice hover
 * - Center ripple pulse
 * - Animated numbers with spring easing
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
    this._selectedIndex = -1;
    this._isLinux =
      /linux/i.test(navigator.platform || "") ||
      /linux/i.test(navigator.userAgent || "");

    // Zoom state
    this._zoom = 1;
    this._panX = 0;
    this._panY = 0;
    this._baseW = 0;
    this._baseH = 0;

    // Premium effects state
    this._cursorX = 0;
    this._cursorY = 0;
    this._sweepX = 0;
    this._sweepY = 0;
    this._specOverlay = null;
    this._sweepOverlay = null;
    this._entered = false;
    this._bloomActive = false;
    this._rippleTime = 0;
    this._mouseInside = false;

    // Micro‑Scatter → Reassemble animation
    this._scatterAmt = 0; // 0..1, 0=assembled, 1=fully scattered
    this._scatterTarget = 0;
    this._scatterAnimId = null;
    this._scatterEaseStart = 0;

    this._init();
    this._initPremiumEffects();
  }

  _init() {
    // Canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.canvas.style.position = "relative";
    this.canvas.style.zIndex = "1";
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
    this.canvas.addEventListener("mouseenter", () => { this._mouseInside = true; });
    this.canvas.addEventListener("mouseleave", () => {
      this._mouseInside = false;
      this._hideTooltip();
      this._updateOverlays(-9999, -9999);
    });
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

    // Mouse wheel zoom
    this.canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.05, Math.min(10, this._zoom * delta));
      const rect = this.canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const scale = newZoom / this._zoom;
      this._panX = mx - scale * (mx - this._panX);
      this._panY = my - scale * (my - this._panY);
      this._zoom = newZoom;
      this._updateZoomUI();
      this._draw();
    }, { passive: false });

    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  // ── Premium overlay layers (GPU-accelerated, no canvas repaints) ──

  _initPremiumEffects() {
    // Specular highlight overlay — radial gradient following cursor
    this._specOverlay = document.createElement("div");
    this._specOverlay.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "pointer-events:none;z-index:2;" +
      "background:radial-gradient(circle 60px at 0 0, rgba(255,255,255,0.04) 0%, transparent 70%);" +
      "opacity:0;transition:opacity 0.3s ease;";
    this.container.appendChild(this._specOverlay);

    // Satin surface sweep overlay — linear gradient that follows cursor with delay
    this._sweepOverlay = document.createElement("div");
    this._sweepOverlay.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "pointer-events:none;z-index:2;" +
      "background:linear-gradient(135deg, transparent 35%, rgba(255,255,255,0.03) 45%, rgba(255,255,255,0.05) 50%, rgba(255,255,255,0.03) 55%, transparent 65%);" +
      "background-size:200% 200%;" +
      "opacity:0;transition:opacity 0.4s ease;";
    this.container.appendChild(this._sweepOverlay);

    // Apply GPU-accelerated entrance animation to canvas
    this.canvas.style.transition =
      "transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), filter 0.12s ease-out, box-shadow 0.2s ease";
    this.canvas.style.transform = "scale(0.95) rotate(-3deg)";
    this.canvas.style.opacity = "0";
    this.canvas.style.willChange = "transform, opacity, filter";
  }

  _updateOverlays(cx, cy) {
    if (!this._specOverlay || !this._sweepOverlay) return;
    const rect = this.container.getBoundingClientRect();
    const rx = cx - rect.left;
    const ry = cy - rect.top;

    // Specular: radial gradient follows cursor
    this._specOverlay.style.background =
      "radial-gradient(circle 80px at " + rx + "px " + ry + "px, rgba(255,255,255,0.035) 0%, transparent 70%)";
    this._specOverlay.style.opacity = this._mouseInside ? "1" : "0";

    // Satin sweep: linear gradient position follows cursor with smooth tracking
    const pctX = (rx / rect.width) * 100;
    const pctY = (ry / rect.height) * 100;
    this._sweepOverlay.style.backgroundPosition = pctX + "% " + pctY + "%";
    this._sweepOverlay.style.opacity = this._mouseInside ? "1" : "0";
  }

  // ── Entrance animation ──────────────────────────────

  _playEntrance() {
    if (this._entered) return;
    this._entered = true;
    // Start from micro-rotated, slightly scaled down state
    this.canvas.style.transform = "scale(0.95) rotate(-3deg)";
    this.canvas.style.opacity = "0";
    this.canvas.style.filter = "brightness(0.9)";
    // Force layout
    void this.canvas.offsetWidth;
    // Animate to final state with micro-rotation noise
    const jitter = (Math.random() - 0.5) * 0.4; // ±0.2°
    this.canvas.style.transform = "scale(1) rotate(" + jitter + "deg)";
    this.canvas.style.opacity = "1";
    this.canvas.style.filter = "brightness(1)";
    // Remove jitter after entrance settles
    setTimeout(() => {
      this.canvas.style.transform = "scale(1) rotate(0deg)";
    }, 120);
  }

  // ── Scan completion bloom ───────────────────────────

  _playBloom() {
    if (this._bloomActive) return;
    this._bloomActive = true;
    this.canvas.style.filter = "brightness(1.05) saturate(1.1)";
    this.canvas.style.transition = "filter 0.12s ease-out";
    setTimeout(() => {
      this.canvas.style.filter = "brightness(1) saturate(1)";
      this._bloomActive = false;
    }, 120);
    // Also trigger center ripple
    this._rippleTime = Date.now();
  }

  // ── Micro‑Scatter → Reassemble animation ────────────

  _startScatter(target) {
    this._scatterTarget = target;
    if (this._scatterAnimId) return; // already animating
    this._scatterEaseStart = performance.now();
    const fromAmt = this._scatterAmt;
    const duration = 160; // ms
    const ease = (t) => {
      // cubic-bezier(0.16, 1, 0.3, 1)
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };

    const animate = (now) => {
      let t = (now - this._scatterEaseStart) / duration;
      if (t > 1) t = 1;
      const eased = ease(t);
      this._scatterAmt = fromAmt + (this._scatterTarget - fromAmt) * eased;
      this._draw();
      if (t < 1) {
        this._scatterAnimId = requestAnimationFrame(animate);
      } else {
        this._scatterAmt = this._scatterTarget;
        this._scatterAnimId = null;
      }
    };
    this._scatterAnimId = requestAnimationFrame(animate);
  }

  // ── Spring easing for numbers ───────────────────────

  _springEasing(t) {
    // Physically-based: overshoots 1-2% then settles
    const c = 0.3; // stiffness
    const k = 0.7; // damping
    return 1 - Math.exp(-k * t) * Math.cos(c * t * Math.PI * 2);
  }

  _animateValue(from, to, duration, callback) {
    const start = performance.now();
    const ease = (t) => {
      // Custom momentum curve: fast start, smooth end
      return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
    };
    const step = (now) => {
      let t = (now - start) / duration;
      if (t > 1) t = 1;
      const v = from + (to - from) * ease(t);
      callback(Math.round(v));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ── Zoom API ─────────────────────────────────────────

  setZoom(level) {
    if (level === "fit") {
      this._fitToView();
      return;
    }
    this._zoom = Math.max(0.05, Math.min(10, Number(level) || 1));
    this._panX = 0;
    this._panY = 0;
    this._updateZoomUI();
    this._draw();
  }

  getZoom() { return this._zoom; }

  _fitToView() {
    if (!this.canvas || !this.data || this.files.length === 0) {
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      this._updateZoomUI();
      this._draw();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const viewW = this.canvas.width / dpr;
    const viewH = this.canvas.height / dpr;

    let contentW, contentH;
    if (this.mode === "pie") {
      const margin = 6;
      const legendW = Math.min(120, this._baseW * 0.18 || 120);
      const pieArea = (this._baseW || viewW) - legendW - margin * 3;
      contentW = pieArea + legendW + margin * 3;
      contentH = (this._baseH || viewH || 200);
    } else {
      contentW = this._baseW || viewW;
      contentH = this._baseH || viewH || 200;
    }

    if (contentW <= 0 || contentH <= 0) {
      this._zoom = 1;
      this._panX = 0;
      this._panY = 0;
      this._updateZoomUI();
      this._draw();
      return;
    }

    const scaleX = viewW / (contentW + 20);
    const scaleY = viewH / (contentH + 20);
    this._zoom = Math.min(scaleX, scaleY) * 0.92;
    // Center with extra padding for legend text
    this._panX = (viewW - contentW * this._zoom) / 2;
    this._panY = (viewH - contentH * this._zoom) / 2;
    this._fitPanX = this._panX;
    this._fitPanY = this._panY;
    this._updateZoomUI();
    this._draw();
  }

  onZoomChanged(zoom) {}

  _updateZoomUI() {
    if (this.onZoomChanged) this.onZoomChanged(this._zoom);
  }

  _resize() {
    if (!this.canvas || !this.container) return;
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.canvas.style.width = rect.width + "px";
    this.canvas.style.height = rect.height + "px";
    this._baseW = rect.width;
    this._baseH = rect.height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._fitToView();
  }

  setMode(mode) {
    if (mode !== "pie" && mode !== "treemap") return;
    this.mode = mode;
    this._entered = false;
    this._resize();
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
    this._entered = false;
    this._resize();
    // Play entrance and bloom for new data
    setTimeout(() => this._playEntrance(), 50);
    setTimeout(() => this._playBloom(), 550);
  }

  _draw() {
    if (!this.ctx || !this.canvas || !this.data) return;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    this.ctx.clearRect(0, 0, w, h);
    this.hitRegions = [];

    if (this.files.length === 0) {
      this.ctx.fillStyle = "#484f58";
      this.ctx.font = "14px sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText("No file data. Run a scan first.", w / 2, h / 2);
      return;
    }

    this.ctx.save();
    this.ctx.translate(this._panX, this._panY);
    this.ctx.scale(this._zoom, this._zoom);

    if (this.mode === "pie") {
      this._drawPie(this._baseW, this._baseH);
    } else {
      this._drawTreemap(this._baseW, this._baseH);
    }

    this.ctx.restore();
  }

  // ── Pie Chart with Premium Effects ──────────────────
  _drawPie(w, h) {
    const ctx = this.ctx;
    const margin = 6;
    const legendW = Math.min(120, w * 0.18);
    const pieArea = w - legendW - margin * 3;
    const cx = margin + pieArea / 2;
    const cy = h / 2;
    const radius = Math.min(pieArea / 2, cy) - 4;
    const totalSize = this.files.reduce((s, f) => s + f.size, 1);
    const colors = this._colors();

    // ── Micro‑Scatter → Reassemble ───────────────────────
    // All slices shift slightly on hover, adjacent slices react.
    const scatterStrength = this._scatterAmt || 0; // 0..1

    let startAngle = -Math.PI / 2;
    const maxLabels = Math.min(this.files.length, 8);
    const usedLabelBoxes = [];
    const sliceAngles = [];

    // First pass: collect all slice angles
    this.files.forEach((file, i) => {
      const sliceAngle = (file.size / totalSize) * Math.PI * 2;
      sliceAngles.push(sliceAngle);
    });

    // Draw slices with premium effects
    this.files.forEach((file, i) => {
      const sliceAngle = sliceAngles[i];
      const color = colors[i % colors.length];
      const isHov = i === this._hoveredIndex;
      const isSel = i === this._selectedIndex;

      // Radius: slight pressure scale on hover
      const r = radius * (isHov && this._mouseInside ? 0.985 : 1);

      // Micro‑Scatter offset: each slice moves radially by a weighted amount
      const midAngle = startAngle + sliceAngle / 2;
      const selOffset = isSel ? 8 : 0;
      // Scatter weight: hovered=1, adjacent=0.3, rest=0.05
      let scatterWeight = 0.05;
      if (isHov) scatterWeight = 1.0;
      else if (this._hoveredIndex >= 0) {
        const dist = Math.abs(i - this._hoveredIndex);
        if (dist === 1) scatterWeight = 0.35;
        else if (dist === 2) scatterWeight = 0.15;
      }
      const scatterDist = 3.5 * scatterStrength * scatterWeight;
      const sliceCx = cx + Math.cos(midAngle) * (scatterDist + selOffset);
      const sliceCy = cy + Math.sin(midAngle) * (scatterDist + selOffset);

      // Draw slice
      ctx.beginPath();
      ctx.moveTo(sliceCx, sliceCy);
      ctx.arc(sliceCx, sliceCy, r, startAngle, startAngle + sliceAngle);
      ctx.closePath();

      // Specular-inspired coloring: slightly brighter at edges
      const grad = ctx.createRadialGradient(sliceCx, sliceCy, 0, sliceCx, sliceCy, r);
      grad.addColorStop(0, this._lightenColor(color, isHov ? 15 : 5));
      grad.addColorStop(0.7, color);
      grad.addColorStop(1, this._darkenColor(color, 10));
      ctx.fillStyle = grad;

      // Shadow for depth
      if (isHov || isSel) {
        ctx.shadowColor = "rgba(88,166,255," + (isHov ? "0.35" : "0.25") + ")";
        ctx.shadowBlur = isHov ? 18 : 12;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      // Selection outline
      if (isSel) {
        ctx.strokeStyle = "rgba(88,166,255,0.6)";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      // Hover glow outline
      if (isHov && this._mouseInside) {
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Magnetic effect: adjacent slices shift slightly
      if (this._mouseInside && this._hoveredIndex >= 0 && !isHov) {
        const dist = Math.abs(i - this._hoveredIndex);
        if (dist === 1) {
          // Adjacent slices shift 0.5-1px away
          const adjOffset = 0.8;
          const adjCx = cx + Math.cos(midAngle) * adjOffset;
          const adjCy = cy + Math.sin(midAngle) * adjOffset;
          // Re-draw small background circle for magnetic feel (no real impact)
        }
      }

      this.hitRegions.push({
        index: i,
        path: file.path,
        size: file.size,
        size_human: file.size_human,
        type: "pie",
        cx: sliceCx,
        cy: sliceCy,
        startAngle,
        endAngle: startAngle + sliceAngle,
        radius: r,
      });

      // Labels with smooth fade-style rendering
      if (sliceAngle > 0.2 && i < maxLabels) {
        const mid = startAngle + sliceAngle / 2;
        const lx = sliceCx + Math.cos(mid) * (r * 0.65);
        const ly = sliceCy + Math.sin(mid) * (r * 0.65);
        const name = this._shortName(file.path);
        const drawName = this._ellipsize(name, 16);
        const tw = ctx.measureText(drawName).width;
        const th = 11;
        const box = { x: lx - tw / 2 - 2, y: ly - th / 2, w: tw + 4, h: th };
        const overlaps = usedLabelBoxes.some((b) =>
          box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y,
        );
        if (!overlaps) {
          usedLabelBoxes.push(box);
          ctx.fillStyle = "rgba(255,255,255,0.9)";
          ctx.font = "bold 10px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(drawName, lx, ly);
        }
      }
      startAngle += sliceAngle;
    });

    // ── Center ripple effect ──────────────────────────
    const rippleElapsed = Date.now() - this._rippleTime;
    if (rippleElapsed < 240 && this._mouseInside) {
      const rippleProgress = rippleElapsed / 240;
      const rippleRadius = radius * 0.3 * rippleProgress;
      const rippleAlpha = 0.06 * (1 - rippleProgress);
      ctx.beginPath();
      ctx.arc(cx, cy, rippleRadius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255," + rippleAlpha + ")";
      ctx.fill();
    }

    // Legend
    const lx = w - legendW - margin;
    let ly = 16;
    ctx.font = "10px sans-serif";
    ctx.textBaseline = "top";
    const maxLeg = Math.min(this.files.length, 18);
    for (let i = 0; i < maxLeg; i++) {
      const f = this.files[i];
      const name = this._ellipsize(this._shortName(f.path), 18);
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

  // ── Treemap: Squarified Algorithm ───────────────────
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

    const totalArea = availW * availH;
    const items = this.files.map((f, i) => ({
      index: i, path: f.path, size: f.size,
      size_human: f.size_human,
      area: Math.max(totalArea * 0.001, (f.size / totalSize) * totalArea),
    }));
    const areaSum = items.reduce((s, it) => s + it.area, 0);
    items.forEach((it) => { it.area = (it.area / areaSum) * totalArea; });

    const rects = [];
    const stack = [{ x: margin, y: margin, w: availW, h: availH, items }];

    while (stack.length > 0) {
      const cell = stack.pop();
      if (cell.items.length === 0) continue;
      if (cell.items.length === 1) {
        rects.push({
          index: cell.items[0].index, x: cell.x, y: cell.y,
          w: cell.w, h: cell.h, path: cell.items[0].path,
          size: cell.items[0].size, size_human: cell.items[0].size_human,
        });
        continue;
      }
      const horizontal = cell.w >= cell.h;
      const total = cell.items.reduce((s, it) => s + it.area, 0);
      let splitIdx = 1, bestScore = Infinity, cumSum = 0;
      const halfTotal = total / 2;
      for (let i = 0; i < cell.items.length - 1; i++) {
        cumSum += cell.items[i].area;
        const ratio = cumSum / total;
        const firstSize = horizontal ? cell.w : cell.h;
        const secondSize = horizontal ? cell.w : cell.h;
        const firstDim = ratio * firstSize;
        const secondDim = (1 - ratio) * secondSize;
        const otherDim = horizontal ? cell.h : cell.w;
        const ar1 = horizontal ? firstDim / otherDim : otherDim / firstDim;
        const ar2 = horizontal ? secondDim / otherDim : otherDim / secondDim;
        const score = Math.max(ar1, ar2) + Math.abs(ratio - 0.5) * 2;
        if (score < bestScore) { bestScore = score; splitIdx = i + 1; }
      }
      const leftItems = cell.items.slice(0, splitIdx);
      const rightItems = cell.items.slice(splitIdx);
      const leftArea = leftItems.reduce((s, it) => s + it.area, 0);
      const ratio = leftArea / total;
      if (horizontal) {
        const leftW = Math.max(10, ratio * cell.w);
        const rightW = Math.max(10, cell.w - leftW);
        stack.push({ x: cell.x, y: cell.y, w: leftW, h: cell.h, items: leftItems });
        stack.push({ x: cell.x + leftW, y: cell.y, w: rightW, h: cell.h, items: rightItems });
      } else {
        const topH = Math.max(10, ratio * cell.h);
        const bottomH = Math.max(10, cell.h - topH);
        stack.push({ x: cell.x, y: cell.y, w: cell.w, h: topH, items: leftItems });
        stack.push({ x: cell.x, y: cell.y + topH, w: cell.w, h: bottomH, items: rightItems });
      }
    }

    const gap = 1;
    // Center for ripple
    const centerX = w / 2, centerY = h / 2;

    // ── Draw with Micro‑Scatter effect ──
    for (const r of rects) {
      const isHov = r.index === this._hoveredIndex;
      const color = colors[r.index % colors.length];
      let rx = r.x + gap, ry = r.y + gap;
      let rw = Math.max(2, r.w - gap * 2), rh = Math.max(2, r.h - gap * 2);

      // Micro‑Scatter offset: hovered moves toward center, adjacent shift too
      const scatterStrength = this._scatterAmt || 0;
      let scatterWeight = 0.05;
      if (isHov) scatterWeight = 1.0;
      else if (this._hoveredIndex >= 0) {
        const dist = Math.abs(r.index - this._hoveredIndex);
        if (dist === 1) scatterWeight = 0.35;
        else if (dist === 2) scatterWeight = 0.15;
      }
      if (scatterWeight > 0.05 || isHov) {
        const rectCx = rx + rw / 2;
        const rectCy = ry + rh / 2;
        const dx = centerX - rectCx;
        const dy = centerY - rectCy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const pull = 4 * scatterStrength * scatterWeight;
        rx += (dx / dist) * pull;
        ry += (dy / dist) * pull;
      }

      // Selective glow for selected item
      const isSel = r.index === this._selectedIndex;

      // Premium gradient: radial from top-left for material feel
      const grad = ctx.createRadialGradient(rx, ry, 0, rx, ry, Math.max(rw, rh) * 0.8);
      grad.addColorStop(0, this._lightenColor(color, isHov ? 18 : 8));
      grad.addColorStop(0.6, color);
      grad.addColorStop(1, this._darkenColor(color, 12));
      ctx.fillStyle = grad;

      // Shadow for depth
      if (isHov || isSel) {
        ctx.shadowColor = "rgba(88,166,255," + (isHov ? "0.35" : "0.25") + ")";
        ctx.shadowBlur = isHov ? 18 : 12;
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      ctx.fillRect(rx, ry, rw, rh);
      ctx.shadowBlur = 0;

      // Selection outline
      if (isSel) {
        ctx.strokeStyle = "rgba(88,166,255,0.6)";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(rx, ry, rw, rh);
      }

      // Hover glow outline
      if (isHov && this._mouseInside) {
        ctx.strokeStyle = "rgba(255,255,255,0.15)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(rx, ry, rw, rh);
      }

      this.hitRegions.push({
        index: r.index, path: r.path, size: r.size,
        size_human: r.size_human, type: "treemap",
        x: rx, y: ry, w: rw, h: rh,
      });

      // Labels with fade-style rendering
      if (rw > 44 && rh > 16) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(rx + 1, ry + 1, rw - 2, rh - 2);
        ctx.clip();
        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = "bold 9px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const maxNameChars = Math.max(6, Math.floor((rw - 8) / 5.5));
        const name = this._ellipsize(this._shortName(r.path), maxNameChars);
        ctx.fillText(name, rx + 3, ry + 3);

        if (rh > 28 && rw > 70) {
          ctx.fillStyle = "rgba(255,255,255,0.7)";
          ctx.font = "8px sans-serif";
          ctx.fillText(r.size_human, rx + 3, ry + 14);
        }
        ctx.restore();
      }
    }

    // ── Center ripple effect (adapted for treemap) ──
    const rippleElapsed = Date.now() - this._rippleTime;
    if (rippleElapsed < 240 && this._mouseInside) {
      const rippleProgress = rippleElapsed / 240;
      const rippleRadius = Math.min(w, h) * 0.2 * rippleProgress;
      const rippleAlpha = 0.04 * (1 - rippleProgress);
      // Soft square-ish ripple
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(centerX, centerY, rippleRadius * 1.2, rippleRadius * 0.8, 0, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255," + rippleAlpha + ")";
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = "#8b949e";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("Top " + this.files.length + " Files by Size", w / 2, h - 2);
  }

  // ── Hit Testing ────────────────────────────────────
  _hitTest(mx, my) {
    const mxT = (mx - this._panX) / this._zoom;
    const myT = (my - this._panY) / this._zoom;

    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const r = this.hitRegions[i];
      if (r.type === "pie") {
        const dx = mxT - r.cx, dy = myT - r.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > r.radius) continue;
        let angle = Math.atan2(dy, dx);
        if (angle < 0) angle += Math.PI * 2;
        let sa = r.startAngle, ea = r.endAngle;
        if (sa < 0) sa += Math.PI * 2;
        if (ea < 0) ea += Math.PI * 2;
        if (angle >= sa && angle <= ea) return r;
        if (ea < sa && (angle >= sa || angle <= ea)) return r;
      } else if (r.type === "treemap") {
        if (mxT >= r.x && mxT <= r.x + r.w && myT >= r.y && myT <= r.y + r.h) return r;
      }
    }
    return null;
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._cursorX = e.clientX;
    this._cursorY = e.clientY;
    this._updateOverlays(e.clientX, e.clientY);

    const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      if (this._hoveredIndex !== hit.index) {
        this._hoveredIndex = hit.index;
        // Micro‑Scatter: animate to scattered state
        this._startScatter(1);
      }
      this.canvas.style.cursor = "pointer";
      this.tooltipEl.textContent = hit.path + "  [" + hit.size_human + "]";
      this.tooltipEl.style.display = "block";
      this.tooltipEl.style.left = e.clientX + 12 + "px";
      this.tooltipEl.style.top = e.clientY - 10 + "px";
      // Soft pressure: scale down slightly
      this.canvas.style.transform = "scale(0.985)";
      this.canvas.style.boxShadow = "0 0 20px rgba(88,166,255,0.15)";
    } else {
      this._hideTooltip();
    }
  }

  _hideTooltip() {
    if (this._hoveredIndex !== -1) {
      this._hoveredIndex = -1;
      // Micro‑Reassemble: animate back to assembled state
      this._startScatter(0);
    }
    this.tooltipEl.style.display = "none";
    this.canvas.style.cursor = "default";
    // Reset soft pressure
    this.canvas.style.transform = "scale(1)";
    this.canvas.style.boxShadow = "none";
  }

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const hit = this._hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (hit) {
      this._selectedIndex = hit.index;
      this._draw();
      this._showContextMenu(e.clientX, e.clientY, hit);
    } else {
      this._selectedIndex = -1;
      this._draw();
      this.contextMenu.style.display = "none";
    }
  }

  _showContextMenu(x, y, hit) {
    this.contextMenu.style.display = "block";
    this.contextMenu.style.left = x + "px";
    this.contextMenu.style.top = y + "px";
    this._contextHit = hit;
  }

  _onContextMenuAction(e) {
    const item = e.target.closest(".diag-ctx-item");
    if (!item) return;
    const action = item.dataset.action;
    const filePath = this._contextHit ? this._contextHit.path : "";
    const sb = document.getElementById("tree-status") || document.querySelector(".status-bar");

    switch (action) {
      case "explorer":
        this._invoke("open_explorer", { path: filePath }).catch(() => {});
        if (sb) sb.textContent = "Opened: " + filePath;
        break;
      case "terminal":
        this._invoke("open_terminal", { path: filePath }).catch(() => {});
        if (sb) sb.textContent = "Terminal: " + filePath;
        break;
      case "tree":
        window.dispatchEvent(new CustomEvent("diagram-jump-to-path", { detail: { path: filePath } }));
        break;
      case "properties":
        this._invoke("open_properties", { path: filePath }).catch(() => {});
        break;
      case "copy":
        navigator.clipboard.writeText(filePath).then(() => {
          if (sb) sb.textContent = "Copied: " + filePath;
        });
        break;
      case "delete":
        this._invoke("delete_path", { path: filePath }).then((ok) => {
          if (ok) {
            this.files = this.files.filter((f) => f.path !== filePath);
            this._draw();
            if (sb) sb.textContent = "Deleted: " + filePath;
          }
        });
        break;
    }
    this.contextMenu.style.display = "none";
  }

  _invoke(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.invoke)
      return window.__TAURI__.invoke(cmd, args);
    return Promise.reject(new Error("No invoke"));
  }

  _shortName(p) {
    return p.split("\\").pop() || p.split("/").pop() || p;
  }

  _ellipsize(text, maxChars) {
    if (!text) return "";
    if (text.length <= maxChars) return text;
    if (maxChars <= 1) return text.substring(0, 1);
    return text.substring(0, Math.max(1, maxChars - 1)) + "\u2026";
  }

  _lightenColor(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = Math.min(255, (num >> 16) + Math.round(2.55 * percent));
    const g = Math.min(255, ((num >> 8) & 0xFF) + Math.round(2.55 * percent));
    const b = Math.min(255, (num & 0xFF) + Math.round(2.55 * percent));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  _darkenColor(hex, percent) {
    const num = parseInt(hex.replace("#", ""), 16);
    const r = Math.max(0, (num >> 16) - Math.round(2.55 * percent));
    const g = Math.max(0, ((num >> 8) & 0xFF) - Math.round(2.55 * percent));
    const b = Math.max(0, (num & 0xFF) - Math.round(2.55 * percent));
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  _colors() {
    const c = [
      "#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff",
      "#79c0ff", "#56d364", "#e3b341", "#ff7b72", "#d2a8ff",
      "#8b949e", "#484f58", "#f0883e", "#7ee787", "#a5d6ff",
      "#ffa657", "#ff7b72", "#c9d1d9", "#f778ba", "#db6d28",
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
