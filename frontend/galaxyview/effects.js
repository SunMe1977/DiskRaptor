/**
 * DiskRaptor — GalaxyView Visual Effects
 * GPU-accelerated post-processing: bloom, glow, trails, particles.
 * Uses Canvas 2D overlays for effects that WebGL can't handle well.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class EffectManager {
    constructor(canvas, gl) {
      this.canvas = canvas;
      this.gl = gl;
      this.overlayCanvas = document.createElement("canvas");
      this.overlayCtx = this.overlayCanvas.getContext("2d");
      this.overlayCanvas.style.position = "absolute";
      this.overlayCanvas.style.top = "0";
      this.overlayCanvas.style.left = "0";
      this.overlayCanvas.style.pointerEvents = "none";
      canvas.parentElement.appendChild(this.overlayCanvas);

      this.bloomBuffer = null;
      this.particles = [];
      this.trails = [];
      this.meteors = [];
      this.shimmerParticles = [];

      this._resize();
      this._initBlooom();
    }

    _resize() {
      this.overlayCanvas.width = this.canvas.width;
      this.overlayCanvas.height = this.canvas.height;
    }

    _initBlooom() {
      // Simple bloom via canvas composite operations
      // Full bloom would need WebGL framebuffers - this is a lightweight approximation
      this.bloomCanvas = document.createElement("canvas");
      this.bloomCtx = this.bloomCanvas.getContext("2d");
    }

    /** Render bloom effect (Canvas 2D approximation) */
    renderBloom(renderFunc) {
      if (!CFG.renderer.bloomStrength) return;

      const w = this.canvas.width;
      const h = this.canvas.height;
      this.bloomCanvas.width = w;
      this.bloomCanvas.height = h;
      const ctx = this.bloomCtx;

      // Draw bright-pass filter onto bloom canvas
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, w, h);
      ctx.filter = `blur(${CFG.renderer.bloomRadius * 8}px)`;
      ctx.globalAlpha = CFG.renderer.bloomStrength * 0.5;

      // Capture bright areas from main canvas
      ctx.drawImage(this.canvas, 0, 0);

      // Overlay bloom onto overlay canvas
      const oc = this.overlayCtx;
      oc.globalCompositeOperation = "screen";
      oc.filter = "none";
      oc.drawImage(this.bloomCanvas, 0, 0);
      oc.globalCompositeOperation = "source-over";
    }

    /** Add a meteor streak */
    addMeteor(startPos, endPos, color, lifetime) {
      this.meteors.push({
        start: [startPos[0], startPos[1]],
        end: [endPos[0], endPos[1]],
        color: color || [1, 0.8, 0.3],
        lifetime: lifetime || 2000,
        birthTime: Date.now(),
        alpha: 1,
      });
    }

    /** Add orbit trail for an object */
    addTrail(object, color) {
      this.trails.push({
        object: object,
        color: color || [0.4, 0.4, 0.7],
        positions: [[object.position[0], object.position[1], object.position[2]]],
        maxLength: 50,
        alpha: 0.5,
      });
    }

    /** Add shimmer particles around a bright object */
    addShimmer(position, color, count) {
      count = count || 20;
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = 1 + Math.random() * 3;
        this.shimmerParticles.push({
          position: [
            position[0] + Math.cos(angle) * radius,
            position[1] + (Math.random() - 0.5) * radius,
            position[2] + Math.sin(angle) * radius,
          ],
          color: color || [1, 1, 1],
          size: 0.5 + Math.random() * 1.5,
          phase: Math.random() * Math.PI * 2,
          speed: 0.5 + Math.random() * 1.5,
          lifetime: 3000 + Math.random() * 3000,
          birthTime: Date.now(),
        });
      }
    }

    /** Draw a glow sprite on overlay canvas */
    drawGlow(ctx, x, y, radius, color, alpha) {
      ctx.save();
      const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
      const c = color || [1, 1, 1];
      gradient.addColorStop(0, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${alpha || 0.5})`);
      gradient.addColorStop(0.3, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},${(alpha||0.5)*0.3})`);
      gradient.addColorStop(1, `rgba(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0},0)`);
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    /** Project 3D position to 2D screen coordinates */
    projectTo2D(pos, cameraMatrix, viewport) {
      if (!pos || !cameraMatrix) return null;
      // Simple perspective projection
      const hw = viewport.width / 2;
      const hh = viewport.height / 2;

      // Extract camera transform from matrix (simplified)
      // In production, use the actual projection matrix from WebGL
      const dx = pos[0] - (cameraMatrix[12] || 0);
      const dy = pos[1] - (cameraMatrix[13] || 0);
      const dz = pos[2] - (cameraMatrix[14] || 0);

      // Simple perspective
      const fov = CFG.camera.fov * Math.PI / 180;
      const scale = hh / Math.tan(fov / 2);
      if (dz <= 0) return null;

      const x = hw + (dx / dz) * scale;
      const y = hh - (dy / dz) * scale;

      return { x, y, z: dz };
    }

    /** Render all 2D overlay effects */
    renderOverlay(cameraMatrix, viewport, time) {
      const ctx = this.overlayCtx;
      const w = this.overlayCanvas.width;
      const h = this.overlayCanvas.height;

      ctx.clearRect(0, 0, w, h);

      // Render meteor streaks
      this._renderMeteors(ctx, cameraMatrix, viewport, time);

      // Render orbit trails
      this._renderTrails(ctx, cameraMatrix, viewport, time);

      // Render shimmer particles
      this._renderShimmer(ctx, cameraMatrix, viewport, time);

      // Update overlay canvas size if needed
      if (this.overlayCanvas.width !== this.canvas.width) {
        this._resize();
      }
    }

    _renderMeteors(ctx, cameraMatrix, viewport, time) {
      const now = Date.now();
      this.meteors = this.meteors.filter(m => (now - m.birthTime) < m.lifetime);

      for (const m of this.meteors) {
        const elapsed = now - m.birthTime;
        const progress = elapsed / m.lifetime;
        const alpha = 1 - progress;

        const x = m.start[0] + (m.end[0] - m.start[0]) * progress;
        const y = m.start[1] + (m.end[1] - m.start[1]) * progress;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = `rgb(${m.color[0]*255|0},${m.color[1]*255|0},${m.color[2]*255|0})`;
        ctx.lineWidth = 2 - progress;
        ctx.beginPath();
        ctx.moveTo(m.start[0], m.start[1]);
        ctx.lineTo(x, y);
        ctx.stroke();

        // Glow at head
        const gradient = ctx.createRadialGradient(x, y, 0, x, y, 8);
        gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
        gradient.addColorStop(1, `rgba(255,255,255,0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    _renderTrails(ctx, cameraMatrix, viewport, time) {
      for (const trail of this.trails) {
        if (!trail.object || !trail.object.position) continue;

        // Update trail positions
        trail.positions.push([
          trail.object.position[0],
          trail.object.position[1],
          trail.object.position[2],
        ]);
        if (trail.positions.length > trail.maxLength) {
          trail.positions.shift();
        }

        // Project and draw trail
        ctx.save();
        ctx.globalAlpha = trail.alpha;
        ctx.beginPath();

        for (let i = 0; i < trail.positions.length; i++) {
          const screen = this.projectTo2D(trail.positions[i], cameraMatrix, viewport);
          if (!screen) continue;
          if (i === 0) ctx.moveTo(screen.x, screen.y);
          else ctx.lineTo(screen.x, screen.y);
        }

        ctx.strokeStyle = `rgba(${trail.color[0]*255|0},${trail.color[1]*255|0},${trail.color[2]*255|0},${trail.alpha})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }

    _renderShimmer(ctx, cameraMatrix, viewport, time) {
      const now = Date.now();
      this.shimmerParticles = this.shimmerParticles.filter(p => (now - p.birthTime) < p.lifetime);

      for (const p of this.shimmerParticles) {
        const elapsed = now - p.birthTime;
        const alpha = Math.sin(elapsed * p.speed * 0.001 + p.phase) * 0.5 + 0.5;

        const screen = this.projectTo2D(p.position, cameraMatrix, viewport);
        if (!screen) continue;

        ctx.save();
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    /** Create particle burst effect (for explosions/new objects) */
    particleBurst(position, color, count) {
      count = count || 30;
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 0.5 + Math.random() * 2;
        this.particles.push({
          x: position[0],
          y: position[1],
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          size: 1 + Math.random() * 2,
          color: color || [0.5, 0.8, 1],
          lifetime: 1000 + Math.random() * 1500,
          birthTime: Date.now(),
        });
      }
    }

    updateAndRenderParticles(ctx, time) {
      const now = Date.now();
      this.particles = this.particles.filter(p => (now - p.birthTime) < p.lifetime);

      for (const p of this.particles) {
        const elapsed = now - p.birthTime;
        const progress = elapsed / p.lifetime;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.98;
        p.vy *= 0.98;

        ctx.save();
        ctx.globalAlpha = 1 - progress;
        ctx.fillStyle = `rgba(${p.color[0]*255|0},${p.color[1]*255|0},${p.color[2]*255|0},${1-progress})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (1 - progress), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    resize() {
      this._resize();
    }

    clear() {
      this.particles = [];
      this.trails = [];
      this.meteors = [];
      this.shimmerParticles = [];
      const ctx = this.overlayCtx;
      if (ctx) ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    }

    dispose() {
      this.clear();
      if (this.overlayCanvas && this.overlayCanvas.parentElement) {
        this.overlayCanvas.parentElement.removeChild(this.overlayCanvas);
      }
      this.bloomCanvas = null;
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.EffectManager = EffectManager;
})();
