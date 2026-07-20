/**
 * DiskRaptor — GalaxyView main entry
 * The third view: a WebGL/Canvas3D galaxy visualization of the filesystem.
 * Renders drives as stars, folders as planets, files as moons, and more.
 *
 * Integration: Instantiated by app.js, toggled via diagram-mode buttons.
 * Runs inside Qt WebEngine WebView. Uses WebGL for 3D, Canvas 2D for overlays.
 */
(function () {
  "use strict";

  // Polyfill CanvasRenderingContext2D.roundRect if not available
  if (!CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
      return this;
    };
  }

  const CFG = window.GalaxyViewConfig;
  const GV = window.GalaxyView || {};

  function noop() {}

  class FallbackDataMapper {
    mapData(scanResult, stats, topFiles) {
      const totalSize = (stats && stats.total_size) || 0;
      return [
        {
          type: "star",
          id: "fallback-star",
          name: "Root",
          position: [0, 0, 0],
          scale: Math.max(6, Math.min(20, Math.log10(Math.max(1, totalSize)) + 2)),
          color: [1, 0.85, 0.3],
          glow: 0.6,
          alpha: 1,
          active: true,
          data: { totalFiles: (stats && stats.total_files) || 0, totalSize: totalSize },
        },
      ];
    }
  }

  class FallbackNoop {
    constructor() {}
    initUI() {}
    update() {}
    dispose() {}
    buildClusters() {}
    simulateHistory() {}
    analyze() {}
    clear() {}
    insert() {}
    onClick() {}
    onHover() {}
    renderOverlay() {}
    updateAndRenderParticles() {}
  }

  class GalaxyView {
    /**
     * @param {string|HTMLElement} container - Container element or selector
     */
    constructor(container) {
      this.container = typeof container === "string"
        ? document.querySelector(container)
        : container;

      if (!this.container) throw new Error("GalaxyView: container not found");

      // ── Core state ──────────────────────────────────────────
      this.active = false;
      this.objects = [];
      this.scanData = null;
      this.stats = null;
      this.frameCount = 0;
      this.lastFpsTime = 0;
      this.fps = 0;

      // ── Camera state ────────────────────────────────────────
      this.camera = {
        position: new Float32Array(CFG.camera.defaultPosition),
        target: new Float32Array([0, 0, 0]),
        up: new Float32Array([0, 1, 0]),
        lookAt: function (target) {
          // Camera look-at is handled in render loop via manual matrix
        },
      };

      // ── Engine modules ──────────────────────────────────────
      const DataMapperCtor = GV.DataMapper || FallbackDataMapper;
      const EffectCtor = GV.EffectManager || FallbackNoop;
      const AnimationCtor = GV.AnimationEngine || FallbackNoop;
      const InteractionCtor = GV.InteractionController || FallbackNoop;
      const LODCtor = GV.LODManager || FallbackNoop;
      const TimelineCtor = GV.TimelineEngine || FallbackNoop;
      const LiveScanCtor = GV.LiveScanEngine || FallbackNoop;
      const InsightCtor = GV.AIInsightsEngine || FallbackNoop;
      const PluginCtor = GV.PluginAPI || FallbackNoop;
      const SpatialCtor = GV.SpatialIndex || FallbackNoop;

      this.dataMapper = new DataMapperCtor();
      this.effects = null;
      this.animation = new AnimationCtor();
      this.interaction = null;
      this.lod = new LODCtor();
      this.timeline = new TimelineCtor(this);
      this.liveScan = new LiveScanCtor(this, this.dataMapper);
      this.insights = new InsightCtor(this);
      this.pluginAPI = new PluginCtor(this);
      this.spatialIndex = new SpatialCtor(10000);

      this._EffectCtor = EffectCtor;
      this._InteractionCtor = InteractionCtor;

      // Background star field
      this.backgroundStars = [];
      this._generateBackground();

      // Custom types registry
      this.customBodyTypes = new Map();
      this.customAnimations = new Map();
      this.insightProviders = [];

      // FPS tracking
      this._fpsValues = [];
    }

    /** Initialize the GalaxyView: canvas, UI, event handlers */
    init() {
      console.log("[GalaxyView] Initializing...");

      // Remove any existing galaxy canvases from container first
      var oldCanvases = this.container.querySelectorAll('canvas.galaxy-canvas');
      for (var ci = 0; ci < oldCanvases.length; ci++) {
        oldCanvases[ci].parentNode.removeChild(oldCanvases[ci]);
      }
      var oldToolbars = this.container.querySelectorAll('.galaxy-toolbar');
      for (var ti = 0; ti < oldToolbars.length; ti++) {
        oldToolbars[ti].parentNode.removeChild(oldToolbars[ti]);
      }

      // Build UI
      this._createCanvas();
      this._createUI();
      this._createTimeline();

      // Connect renderer to canvas
      this.effects = new this._EffectCtor(this.canvas, null);

      // Connect interaction to canvas
      this.interaction = new this._InteractionCtor(this.canvas, this.camera);

      // Init Insights
      if (this.insights && typeof this.insights.initUI === "function") {
        this.insights.initUI(this.container);
      }

      // Set up interaction handlers
      if (this.interaction && typeof this.interaction.onClick === "function") {
        this.interaction.onClick((x, y, camera) => this._handleClick(x, y));
      }
      if (this.interaction && typeof this.interaction.onHover === "function") {
        this.interaction.onHover((x, y, camera) => this._handleHover(x, y));
      }

      // Register built-in plugins
      if (typeof GV.registerBuiltinPlugins === "function") {
        GV.registerBuiltinPlugins(this.pluginAPI);
      }

      // Init timeline
      if (this.timeline && typeof this.timeline.initUI === "function") {
        this.timeline.initUI(this.container.querySelector(".galaxy-timeline-wrap"));
      }

      console.log("[GalaxyView] Initialized");
      return this;
    }

    // ── Canvas & UI ─────────────────────────────────────────────

    _createCanvas() {
      this.canvas = document.createElement("canvas");
      this.canvas.className = "galaxy-canvas";
      this.canvas.width = this.container.clientWidth;
      this.canvas.height = this.container.clientHeight;
      this.container.appendChild(this.canvas);

      // Canvas 2D context for rendering
      this.ctx = this.canvas.getContext("2d");

      // Resize handler
      this._resizeHandler = () => this._resize();
      window.addEventListener("resize", this._resizeHandler);
    }

    _resize() {
      if (!this.canvas || !this.container) return;
      // Use window dimensions directly (avoid container client sizing bugs)
      var w = window.innerWidth;
      var h = window.innerHeight;
      if (w <= 0 || h <= 0) {
        w = this.container.clientWidth || 800;
        h = this.container.clientHeight || 600;
      }
      this.canvas.width = w;
      this.canvas.height = h;
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      if (this.effects) this.effects.resize();
    }

    _createUI() {
      // Toolbar actions
      const toolbar = document.createElement("div");
      toolbar.className = "galaxy-toolbar";
      toolbar.innerHTML = `
        <button class="gbtn" id="g-close" title="Close Galaxy (Esc)">✖</button>
        <div class="g-separator"></div>
        <button class="gbtn" id="g-reset" title="Reset Camera (R)">⟲</button>
        <button class="gbtn" id="g-timeline-toggle" title="Time Travel">⏱</button>
        <button class="gbtn" id="g-insights-toggle" title="Toggle AI Insights">💡</button>
        <button class="gbtn" id="g-fullscreen" title="Fullscreen">⛶</button>
        <div class="g-separator"></div>
        <span class="g-fps" id="g-fps-display">60 FPS</span>
      `;
      this.container.appendChild(toolbar);

      // Bind toolbar buttons
      document.getElementById("g-close")?.addEventListener("click", () => this.hide());
      document.getElementById("g-timeline-toggle")?.addEventListener("click", () => {
        const wrap = this.container.querySelector(".galaxy-timeline-wrap");
        if (wrap) wrap.style.display = wrap.style.display === "none" ? "block" : "none";
      });
      document.getElementById("g-insights-toggle")?.addEventListener("click", () => {
        if (this.insights) {
          this.insights.autoShow = !this.insights.autoShow;
          if (this.insights.autoShow) this.insights.show();
          else this.insights.hide();
        }
      });
      document.getElementById("g-fullscreen")?.addEventListener("click", () => {
        if (this.container.requestFullscreen) {
          this.container.requestFullscreen();
        }
      });

      // Empty state
      this.emptyState = document.createElement("div");
      this.emptyState.className = "galaxy-empty";
      this.emptyState.innerHTML = `
        <div class="galaxy-empty-icon">🌌</div>
        <div class="galaxy-empty-text" data-i18n="galaxy.empty">Scan a directory to explore the galaxy</div>
      `;
      this.container.appendChild(this.emptyState);

      // Scan stats overlay container (for LiveScanEngine)
      this.scanStatsContainer = document.createElement("div");
      this.scanStatsContainer.className = "galaxy-stats-container";
      this.container.appendChild(this.scanStatsContainer);

      // Timeline wrap
      const tlWrap = document.createElement("div");
      tlWrap.className = "galaxy-timeline-wrap";
      tlWrap.style.display = "none";
      this.container.appendChild(tlWrap);
    }

    _createTimeline() {
      // Timeline UI is created by TimelineEngine.initUI()
    }

    // ── Data Loading ────────────────────────────────────────────

    /**
     * Load scan data and build the galaxy.
     * @param {Object} scanResult - from get_scan_result
     * @param {Object} stats - {total_files, total_dirs, total_size}
     * @param {Array} topFiles - [{path, size, ...}]
     * @param {Array} duplicates - optional duplicate groups
     */
    loadData(scanResult, stats, topFiles, duplicates) {
      console.log("[GalaxyView] Loading scan data...");

      // Show canvas, hide empty state
      this.canvas.style.display = "block";
      if (this.emptyState) this.emptyState.style.display = "none";

      this.scanData = scanResult;
      this.stats = stats;

      // Map data to galaxy objects
      this.objects = this.dataMapper.mapData(scanResult, stats, topFiles);

      // Build spatial index
      this.spatialIndex.clear();
      for (const obj of this.objects) {
        obj.active = true;
        this.spatialIndex.insert(obj);
      }

      // Auto-zoom camera to fit all objects
      this._autoFitCamera();

      // Build LOD clusters
      this.lod.buildClusters(this.objects);

      // Generate timeline snapshots
      this.timeline.simulateHistory(this.objects);

      // AI insights
      this.insights.analyze(stats, topFiles, duplicates);

      // Start render loop
      this._startRenderLoop();

      console.log(`[GalaxyView] Galaxy created: ${this.objects.length} objects`);
    }

    /** Auto-zoom camera to fit all objects in view */
    _autoFitCamera() {
      if (!this.objects || this.objects.length === 0) return;
      // Find bounding sphere centered on origin (where star is)
      var maxDist = 10;
      for (var di = 0; di < this.objects.length; di++) {
        var pp = this.objects[di].position;
        if (pp) {
          var dx = pp[0], dy = pp[1], dz = pp[2];
          var d = Math.sqrt(dx*dx + dy*dy + dz*dz) + (this.objects[di].scale || 5);
          if (d > maxDist) maxDist = d;
        }
      }
      // Position camera to fit the bounding sphere with some margin
      var fovRad = CFG.camera.fov * Math.PI / 180;
      if (fovRad <= 0) fovRad = 1;
      var dist = maxDist / Math.sin(fovRad / 2) * 1.8;
      dist = Math.max(dist, CFG.camera.minZoom);
      dist = Math.min(dist, CFG.camera.maxZoom);
      this.camera.position[0] = 0;
      this.camera.position[1] = dist * 0.3;
      this.camera.position[2] = dist;
      this.camera.target[0] = 0;
      this.camera.target[1] = 0;
      this.camera.target[2] = 0;
    }

    /** Update data during live scan */
    updateLiveScan(progress) {
      if (!this.active) return;
      this.liveScan.update(progress);
    }

    // ── Render Loop ─────────────────────────────────────────────

    _startRenderLoop() {
      this.active = true;
      this.lastTimestamp = performance.now();
      this._renderFrame(this.lastTimestamp);
    }

    _renderFrame(timestamp) {
      if (!this.active) return;

      const dt = timestamp - this.lastTimestamp;
      this.lastTimestamp = timestamp;

      // FPS calculation
      this.frameCount++;
      if (timestamp - this.lastFpsTime > 1000) {
        this.fps = Math.round(this.frameCount * 1000 / (timestamp - this.lastFpsTime));
        this.frameCount = 0;
        this.lastFpsTime = timestamp;
        this._updateFpsDisplay();
      }

      // Skip frame if too slow (maintain at least 15 FPS)
      if (dt > 100) {
        requestAnimationFrame((t) => this._renderFrame(t));
        return;
      }

      // ── Update phase ─────────────────────────────────────
      // Run hook
      this.pluginAPI.runHook("beforeUpdate", this.objects, this.camera);

      // Update animations
      this.animation.update(timestamp, this.objects, this.camera);

      // Update interaction
      this.interaction.update(dt);

      // Update spatial index for visible objects
      this._updateVisibleObjects();

      // Run hook
      this.pluginAPI.runHook("beforeRender", this.objects, this.camera);

      // ── Render phase ─────────────────────────────────────
      this._renderScene(timestamp, dt);

      // Run hook
      this.pluginAPI.runHook("afterRender", this.fps, this.objects.filter(o => o.active).length);

      // Continue loop
      requestAnimationFrame((t) => this._renderFrame(t));
    }

    _renderScene(timestamp, dt) {
      const ctx = this.ctx;
      const w = this.canvas.width;
      const h = this.canvas.height;
      const time = timestamp * 0.001;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Background
      const bgColor = CFG.palettes.normal.background;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);

      // Welcome overlay - brighter for visibility
      ctx.save();
      ctx.fillStyle = "rgba(180,220,255,0.35)";
      ctx.font = "bold 22px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("✦ DiskRaptor Galaxy ✦", w/2, 16);
      ctx.fillStyle = "rgba(180,220,255,0.25)";
      ctx.font = "14px system-ui, sans-serif";
      ctx.fillText("Objects: " + (this.objects ? this.objects.length : 0) + " | " + (this.stats ? (this.stats.total_files || "") + " files, " + (this.stats.total_size ? this._fmtSize(this.stats.total_size) : "") : "loading..."), w/2, 48);
      ctx.restore();

      // Draw background stars
      this._renderBackgroundStars(ctx, time);

      // Camera transform: calculate view-projection matrix
      const viewMatrix = this._calculateViewMatrix();
      const projMatrix = this._calculateProjectionMatrix(w, h);

      // Sort objects by depth (back to front)
      const visible = this._getVisibleObjects();
      visible.sort((a, b) => {
        const az = a._screenZ || 0;
        const bz = b._screenZ || 0;
        return az - bz; // Far to near
      });

      // Render celestial objects
      ctx.save();
      for (const obj of visible) {
        if (!obj || !obj.active) continue;

        // Project to screen
        const screen = this._project(obj.position, viewMatrix, projMatrix, w, h);
        if (!screen) continue;
        obj._screenX = screen.x;
        obj._screenY = screen.y;
        obj._screenZ = screen.z;

        // Get animation state
        const state = this.animation.getState(obj);

        // Render based on type
        switch (obj.type) {
          case "star":
            this._renderStar(ctx, screen, obj, state, time);
            break;
          case "planet":
            this._renderPlanet(ctx, screen, obj, state, time);
            break;
          case "moon":
            this._renderMoon(ctx, screen, obj, state, time);
            break;
          case "blackHole":
            this._renderBlackHole(ctx, screen, obj, state, time);
            break;
          case "nebula":
            this._renderNebula(ctx, screen, obj, state, time);
            break;
          case "particleCloud":
            this._renderParticleCloud(ctx, screen, obj, state);
            break;
          case "comet":
            this._renderComet(ctx, screen, obj, state, time);
            break;
          case "diamond":
            this._renderDiamond(ctx, screen, obj, state, time);
            break;
          case "satellite":
            this._renderSatellite(ctx, screen, obj, state, time);
            break;
          case "meteor":
            this._renderMeteor(ctx, screen, obj, state);
            break;
          case "cluster":
            this._renderCluster(ctx, screen, obj, state);
            break;
          default:
            // Custom body types
            this._renderCustomBody(ctx, screen, obj, state, time);
            break;
        }
      }
      ctx.restore();

      // Overlay effects (meteors, trails, particles) - composited onto main canvas
      if (this.effects) {
        this.effects.renderOverlay(viewMatrix, { width: w, height: h }, time);
        this.effects.compositeOverlay(ctx);
        this.effects.updateAndRenderParticles(ctx, timestamp);
      }

      // Hover label
      this._renderHoverLabel(ctx);
    }

    // ── 3D Math ─────────────────────────────────────────────────

    _calculateViewMatrix() {
      const pos = this.camera.position;
      const target = this.camera.target;
      const up = this.camera.up || [0, 1, 0];

      const zAxis = [
        pos[0] - target[0],
        pos[1] - target[1],
        pos[2] - target[2],
      ];
      const zLen = Math.sqrt(zAxis[0]*zAxis[0] + zAxis[1]*zAxis[1] + zAxis[2]*zAxis[2]);
      if (zLen > 0) { zAxis[0] /= zLen; zAxis[1] /= zLen; zAxis[2] /= zLen; }

      const xAxis = [
        up[1] * zAxis[2] - up[2] * zAxis[1],
        up[2] * zAxis[0] - up[0] * zAxis[2],
        up[0] * zAxis[1] - up[1] * zAxis[0],
      ];
      const xLen = Math.sqrt(xAxis[0]*xAxis[0] + xAxis[1]*xAxis[1] + xAxis[2]*xAxis[2]);
      if (xLen > 0) { xAxis[0] /= xLen; xAxis[1] /= xLen; xAxis[2] /= xLen; }

      const yAxis = [
        zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1],
        zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2],
        zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0],
      ];

      return [
        xAxis[0], yAxis[0], zAxis[0], 0,
        xAxis[1], yAxis[1], zAxis[1], 0,
        xAxis[2], yAxis[2], zAxis[2], 0,
        -(xAxis[0]*pos[0] + xAxis[1]*pos[1] + xAxis[2]*pos[2]),
        -(yAxis[0]*pos[0] + yAxis[1]*pos[1] + yAxis[2]*pos[2]),
        -(zAxis[0]*pos[0] + zAxis[1]*pos[1] + zAxis[2]*pos[2]),
        1,
      ];
    }

    _calculateProjectionMatrix(w, h) {
      const fov = CFG.camera.fov * Math.PI / 180;
      const aspect = w / h;
      const near = CFG.camera.near;
      const far = CFG.camera.far;
      const f = 1 / Math.tan(fov / 2);
      const nf = 1 / (near - far);

      return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, 2 * far * near * nf, 0,
      ];
    }

    _project(position, viewMatrix, projMatrix, w, h) {
      if (!position) return null;

      // View transform
      let x = viewMatrix[0] * position[0] + viewMatrix[4] * position[1] + viewMatrix[8] * position[2] + viewMatrix[12];
      let y = viewMatrix[1] * position[0] + viewMatrix[5] * position[1] + viewMatrix[9] * position[2] + viewMatrix[13];
      let z = viewMatrix[2] * position[0] + viewMatrix[6] * position[1] + viewMatrix[10] * position[2] + viewMatrix[14];
      let w2 = viewMatrix[3] * position[0] + viewMatrix[7] * position[1] + viewMatrix[11] * position[2] + viewMatrix[15];

      if (w2 === 0) return null;

      // Projection transform
      const px = projMatrix[0] * x + projMatrix[4] * y + projMatrix[8] * z + projMatrix[12] * w2;
      const py = projMatrix[1] * x + projMatrix[5] * y + projMatrix[9] * z + projMatrix[13] * w2;
      const pz = projMatrix[2] * x + projMatrix[6] * y + projMatrix[10] * z + projMatrix[14] * w2;
      const pw = projMatrix[3] * x + projMatrix[7] * y + projMatrix[11] * z + projMatrix[15] * w2;

      if (pw === 0) return null;

      // Normalize to NDC
      const nx = px / pw;
      const ny = py / pw;
      const nz = pz / pw;

      // Behind camera?
      if (nz > 1 || nz < -1) return null;

      // To screen coordinates
      return {
        x: (nx + 1) * 0.5 * w,
        y: (1 - ny) * 0.5 * h,
        z: nz,
        depth: w2, // Distance from camera
      };
    }

    // ── Rendering: Celestial Bodies ───────────────────────────

    _renderStar(ctx, screen, star, state, time) {
      const r = star.scale * (1 + state.pulse * 0.1);
      const c = star.color;
      const glow = state.glow;

      if (r < 1) return;

      // Outer glow
      if (glow > 0.1) {
        const gRadius = r * (2 + glow * 3);
        const grad = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, gRadius);
        grad.addColorStop(0, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${glow * 0.3})`);
        grad.addColorStop(0.5, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${glow * 0.1})`);
        grad.addColorStop(1, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, gRadius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Star body
      ctx.save();
      ctx.shadowColor = `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${glow})`;
      ctx.shadowBlur = r * 2;
      ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderPlanet(ctx, screen, planet, state, time) {
      const r = planet.scale * state.pulse;
      const c = planet.color;
      const rotation = state.rotation || 0;

      if (r < 1) return;

      ctx.save();

      // Orbit trail hint
      if (planet.orbitRadius > 30) {
        ctx.strokeStyle = `rgba(100,100,180,0.08)`;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.arc(0, 0, planet.orbitRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Glow
      if (state.glow > 0.1) {
        ctx.shadowColor = `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${state.glow * 0.4})`;
        ctx.shadowBlur = r * 3;
      }

      // Planet body
      ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Surface detail (crude band)
      ctx.strokeStyle = `rgba(255,255,255,0.08)`;
      ctx.lineWidth = Math.max(1, r * 0.2);
      ctx.beginPath();
      ctx.ellipse(screen.x, screen.y, r * 0.7, r * 0.15, rotation, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }

    _renderMoon(ctx, screen, moon, state, time) {
      const r = moon.scale * 0.8;
      const c = moon.color;
      if (r < 0.3) return;

      ctx.save();

      // Sparkle (if recently modified)
      if (moon.sparkle && state.sparkle > 0.3) {
        ctx.shadowColor = `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${state.sparkle * 0.5})`;
        ctx.shadowBlur = r * 4;
      }

      ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderBlackHole(ctx, screen, bh, state, time) {
      const r = state.eventHorizonScale || bh.scale;
      if (r < 2) return;

      // Gravitational lensing ring
      for (let i = 3; i >= 0; i--) {
        const ringR = r + i * 2;
        const alpha = 0.15 - i * 0.03;
        ctx.save();
        ctx.strokeStyle = `rgba(100,100,200,${alpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Event horizon (black disk)
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.8)";
      ctx.shadowBlur = r * 2;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Accretion disk glow
      const grad = ctx.createRadialGradient(screen.x, screen.y, r * 0.5, screen.x, screen.y, r * 2);
      grad.addColorStop(0, "rgba(255,100,50,0)");
      grad.addColorStop(0.3, `rgba(255,150,80,${0.05 + state.lensing * 0.05})`);
      grad.addColorStop(0.7, `rgba(100,100,255,${0.03 + state.lensing * 0.03})`);
      grad.addColorStop(1, "rgba(100,100,255,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    _renderNebula(ctx, screen, nebula, state, time) {
      const r = nebula.scale * state.nebulaPulse;
      if (r < 2) return;
      const c = nebula.color;

      ctx.save();
      const grad = ctx.createRadialGradient(screen.x, screen.y, 0, screen.x, screen.y, r);
      grad.addColorStop(0, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${nebula.alpha * 0.5})`);
      grad.addColorStop(0.4, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${nebula.alpha * 0.2})`);
      grad.addColorStop(0.7, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${nebula.alpha * 0.05})`);
      grad.addColorStop(1, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},0)`);
      ctx.fillStyle = grad;

      // Slightly irregular shape
      ctx.beginPath();
      const points = 8;
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const noise = 0.7 + Math.sin(angle * 3 + time) * 0.15 + Math.sin(angle * 5 + time * 0.5) * 0.1;
        const px = screen.x + Math.cos(angle) * r * noise;
        const py = screen.y + Math.sin(angle) * r * noise;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    _renderParticleCloud(ctx, screen, cloud, state) {
      const r = cloud.scale * 0.3;
      if (r < 1) return;
      ctx.save();
      ctx.globalAlpha = cloud.alpha * 0.3;
      ctx.fillStyle = `rgba(100,100,150,${0.1})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderComet(ctx, screen, comet, state, time) {
      const alpha = state.alpha;
      if (alpha <= 0) return;

      const r = state.scale * 0.5;
      ctx.save();
      ctx.globalAlpha = alpha;

      // Tail
      const tailLen = (comet.tailLength || 20) * (1 - alpha);
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.3})`;
      ctx.lineWidth = Math.max(1, r);
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y);

      // Tail points away from comet velocity
      if (comet.velocity) {
        ctx.lineTo(screen.x - comet.velocity[0] * tailLen, screen.y + comet.velocity[1] * tailLen);
      } else {
        ctx.lineTo(screen.x + tailLen, screen.y);
      }
      ctx.stroke();

      // Head
      ctx.shadowColor = `rgba(255,255,255,${alpha * 0.5})`;
      ctx.shadowBlur = r * 4;
      ctx.fillStyle = `rgba(255,255,255,${alpha})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderDiamond(ctx, screen, diamond, state, time) {
      const r = diamond.scale * (0.8 + state.shimmer * 0.2);
      const c = diamond.color;

      ctx.save();
      // Strong glow
      ctx.shadowColor = `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${0.5 + state.shimmer * 0.3})`;
      ctx.shadowBlur = r * 8;

      // Diamond shape
      ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`;
      ctx.beginPath();
      ctx.moveTo(screen.x, screen.y - r);
      ctx.lineTo(screen.x + r * 0.7, screen.y);
      ctx.lineTo(screen.x, screen.y + r);
      ctx.lineTo(screen.x - r * 0.7, screen.y);
      ctx.closePath();
      ctx.fill();

      // Inner sparkle
      ctx.fillStyle = `rgba(255,255,255,${0.3 + state.shimmer * 0.4})`;
      ctx.beginPath();
      ctx.arc(screen.x - r * 0.15, screen.y - r * 0.15, r * 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderSatellite(ctx, screen, sat, state, time) {
      const r = sat.scale * 0.4;
      if (r < 0.3) return;
      ctx.save();
      ctx.globalAlpha = sat.alpha;
      ctx.fillStyle = `rgba(150,150,200,${sat.alpha})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderMeteor(ctx, screen, meteor, state) {
      const alpha = state.alpha;
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgba(255,200,100,${alpha})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    _renderCluster(ctx, screen, cluster, state) {
      const r = cluster.scale;
      ctx.save();
      ctx.globalAlpha = cluster.alpha || 0.6;
      ctx.fillStyle = `rgba(${cluster.color[0]*255|0},${cluster.color[1]*255|0},${cluster.color[2]*255|0},${cluster.alpha || 0.6})`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
      ctx.fill();

      // Count badge for very large clusters
      if (cluster.data && cluster.data.count > 1000) {
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "9px monospace";
        ctx.textAlign = "center";
        ctx.fillText(`~${(cluster.data.count / 1000).toFixed(0)}k`, screen.x, screen.y + 3);
      }
      ctx.restore();
    }

    _renderCustomBody(ctx, screen, obj, state, time) {
      const typeDef = this.customBodyTypes.get(obj.type);
      if (typeDef && typeDef.render) {
        typeDef.render(ctx, obj, this.camera);
      } else {
        // Fallback: generic dot
        ctx.save();
        ctx.fillStyle = `rgba(${obj.color[0]*255|0},${obj.color[1]*255|0},${obj.color[2]*255|0},${obj.alpha || 0.5})`;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    // ── Background Stars ───────────────────────────────────────

    _generateBackground() {
      this.backgroundStars = [];
      const count = CFG.galaxy.particleCount;
      for (let i = 0; i < count; i++) {
        this.backgroundStars.push({
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          size: 0.3 + Math.random() * 1.2,
          alpha: 0.2 + Math.random() * 0.6,
          twinklePhase: Math.random() * Math.PI * 2,
          twinkleSpeed: 0.5 + Math.random() * 2,
        });
      }
    }

    _renderBackgroundStars(ctx, time) {
      const w = this.canvas.width;
      const h = this.canvas.height;

      for (const star of this.backgroundStars) {
        const twinkle = Math.sin(time * star.twinkleSpeed + star.twinklePhase) * 0.3 + 0.7;
        const sx = star.x * w;
        const sy = star.y * h;
        const alpha = star.alpha * twinkle;

        ctx.fillStyle = `rgba(200,200,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(sx, sy, star.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Visibility & Culling ──────────────────────────────────

    _updateVisibleObjects() {
      // Simple distance culling
      const cam = this.camera;
      for (const obj of this.objects) {
        if (!obj || !obj.position) continue;
        const dx = obj.position[0] - cam.position[0];
        const dy = obj.position[1] - cam.position[1];
        const dz = obj.position[2] - cam.position[2];
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        obj._distance = dist;

        // Hide objects too far away
        if (dist > CFG.camera.far * 0.95) {
          obj._visible = false;
        } else if (obj.scale && dist > 3000 && obj.type !== 'star') {
          obj._visible = false;
        } else {
          obj._visible = true;
        }
      }
    }

    _getVisibleObjects() {
      return this.objects.filter(o => o.active && o._visible !== false);
    }

    // ── Interaction Helpers ────────────────────────────────────

    _handleClick(x, y) {
      // Find nearest visible object
      const visible = this._getVisibleObjects();
      let nearest = null;
      let nearestDist = Infinity;

      for (const obj of visible) {
        if (obj._screenX === undefined) continue;
        const dx = obj._screenX - x;
        const dy = obj._screenY - y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const hitRadius = Math.max((obj.scale || 5) * 3, 10);
        if (dist < hitRadius && dist < nearestDist) {
          nearest = obj;
          nearestDist = dist;
        }
      }

      if (nearest) {
        this.selectedObject = nearest;
        this._onObjectSelected(nearest);

        // Fly to the object
        const target = nearest.position || this.camera.target;
        const flyPos = [target[0], target[1] + 20, target[2] + 50];
        this.animation.flyTo(flyPos, [...target]);
      }
    }

    _handleHover(x, y) {
      const visible = this._getVisibleObjects();
      let nearest = null;
      let nearestDist = 30;

      for (const obj of visible) {
        if (obj._screenX === undefined) continue;
        const dx = obj._screenX - x;
        const dy = obj._screenY - y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        const hitRadius = Math.max((obj.scale || 5) * 2, 8);
        if (dist < hitRadius && dist < nearestDist) {
          nearest = obj;
          nearestDist = dist;
        }
      }

      this.hoveredObject = nearest;

      // Cursor change
      this.canvas.style.cursor = nearest ? "pointer" : "grab";
    }

    _renderHoverLabel(ctx) {
      if (!this.hoveredObject || !CFG.interaction.hoverMetadata) return;

      const obj = this.hoveredObject;
      const sx = obj._screenX || 0;
      const sy = (obj._screenY || 0) - Math.max((obj.scale || 5) + 10, 15);

      const label = this._getMetadata(obj);
      if (!label) return;

      ctx.save();
      ctx.font = "11px system-ui, sans-serif";
      const metrics = ctx.measureText(label);
      const pw = metrics.width + 12;
      const ph = 22;

      ctx.fillStyle = "rgba(10,10,30,0.8)";
      ctx.beginPath();
      ctx.roundRect(sx - pw/2, sy - ph/2, pw, ph, 4);
      ctx.fill();

      ctx.strokeStyle = "rgba(100,100,200,0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(sx - pw/2, sy - ph/2, pw, ph, 4);
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, sx, sy);
      ctx.restore();
    }

    _getMetadata(obj) {
      if (!obj) return "";
      switch (obj.type) {
        case "star":
          return obj.name + " ★ " + (obj.data?.totalFiles?.toLocaleString() || "") + " files";
        case "planet":
          return obj.name + " · " + this._fmtSize(obj.data?.size || 0) + " · " + (obj.data?.files || 0) + " files";
        case "moon":
          return (obj.name || "").substring(0, 30) + " · " + this._fmtSize(obj.data?.size || 0);
        case "blackHole":
          return "🕳 " + obj.name + " · " + this._fmtSize(obj.data?.size || 0);
        case "nebula":
          return "🌌 " + (obj.dominantType || "Mixed") + " nebula · " + (obj.data?.fileCount || 0) + " files";
        case "diamond":
          return "💎 " + (obj.name || "") + " · " + this._fmtSize(obj.data?.size || 0);
        case "comet":
          return "☄ " + (obj.name || "") + " · recent";
        default:
          return obj.name || obj.type || "";
      }
    }

    _onObjectSelected(obj) {
      if (!obj) return;
      const event = new CustomEvent("galaxyview:selected", {
        detail: { object: obj },
        bubbles: true,
      });
      this.container.dispatchEvent(event);
    }

    _updateFpsDisplay() {
      const el = document.getElementById("g-fps-display");
      if (el) el.textContent = this.fps + " FPS";
    }

    // ── Lifecycle ─────────────────────────────────────────────

    show() {
      this.active = true;
      this.container.style.display = "flex";
      this.container.style.position = "fixed";
      this.container.style.top = "0";
      this.container.style.left = "0";
      this.container.style.width = "100vw";
      this.container.style.height = "100vh";
      this.container.style.zIndex = "9999";
      this.container.style.background = "#112233";
      this._resize();
      if (this.objects.length > 0) {
        this._startRenderLoop();
      }
      // Don't hide main-layout - galaxy overlays on top with z-index
      // Just hide the toolbar for clean view
      var toolbar = document.getElementById("toolbar");
      if (toolbar) toolbar.style.display = "none";
      // Escape key to close
      this._escHandler = (e) => { if (e.key === "Escape") this.hide(); };
      document.addEventListener("keydown", this._escHandler);
    }

    hide() {
      this.active = false;
      this.container.style.display = "none";
      this.container.style.position = "";
      this.container.style.top = "";
      this.container.style.left = "";
      this.container.style.width = "";
      this.container.style.height = "";
      this.container.style.zIndex = "";
      this.container.style.background = "";
      // Restore toolbar
      var toolbar = document.getElementById("toolbar");
      if (toolbar) toolbar.style.display = "";
      // Remove Escape handler
      if (this._escHandler) {
        document.removeEventListener("keydown", this._escHandler);
        this._escHandler = null;
      }
    }

    /** Format bytes */
    _fmtSize(bytes) {
      if (!bytes || bytes <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const v = bytes / Math.pow(1024, i);
      return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
    }

    dispose() {
      this.active = false;
      if (this._resizeHandler) window.removeEventListener("resize", this._resizeHandler);
      if (this.effects) this.effects.dispose();
      if (this.animation) this.animation.dispose();
      if (this.interaction) this.interaction.dispose();
      if (this.lod) this.lod.dispose();
      if (this.timeline) this.timeline.dispose();
      if (this.insights) this.insights.dispose();
      if (this.liveScan) this.liveScan.dispose();
      if (this.pluginAPI) this.pluginAPI.dispose();
      if (this.canvas && this.canvas.parentElement) {
        this.canvas.parentElement.removeChild(this.canvas);
      }
      this.objects = [];
      this.container.innerHTML = "";
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.GalaxyView = GalaxyView;
})();
