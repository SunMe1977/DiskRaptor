/**
 * DiskRaptor — GalaxyView Camera Mixin
 * Fit-to-view, cinematic intro zoom, projection math and follow-lock.
 * Mixed into GalaxyView.prototype so every method keeps its `this`
 * semantics; pure geometry helpers stay unit-testable (see
 * tests/check_camera_math.mjs) because they only use `this.*` + CFG.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;
  const GV = (window.GalaxyView = window.GalaxyView || {});

  const CameraMixin = {
    /** Auto-zoom camera to fit all objects in view.
     * @param {boolean} animate - slowly fly in from far away (galaxy open) */
    _autoFitCamera(animate) {
      if (!this.objects || this.objects.length === 0) return;
      const view = this._computeFitView();
      if (!view) return;
      if (animate === false || !this._introEnabled()) {
        this._applyFitView(view);
        return;
      }
      // Start far outside, then slowly zoom deep into the planets.
      const mult = (CFG.camera && CFG.camera.introStartMultiplier) || 2.6;
      const endMult = (CFG.camera && CFG.camera.introEndMultiplier) || 0.42;
      const duration = (CFG.camera && CFG.camera.introDuration) || 3400;
      if (this.animation && typeof this.animation.cancelTransitions === "function") {
        this.animation.cancelTransitions();
      }
      // Deep end position: well inside the planet orbits, clamped to minZoom.
      const endDist = Math.max(view.dist * endMult, CFG.camera.minZoom);
      const endPos = [0, endDist * 0.42, endDist];
      this.camera.position[0] = view.position[0] * mult;
      this.camera.position[1] = view.position[1] * mult;
      this.camera.position[2] = view.position[2] * mult;
      this.camera.target[0] = 0;
      this.camera.target[1] = 0;
      this.camera.target[2] = 0;
      if (this.animation && typeof this.animation.flyTo === "function") {
        this.animation.flyTo(endPos, view.target, duration);
        this._armIntroCancel();
      } else {
        this.camera.position[0] = endPos[0];
        this.camera.position[1] = endPos[1];
        this.camera.position[2] = endPos[2];
      }
    },

    /** Compute the fitted camera position/target without applying it. */
    _computeFitView() {
      if (!this.objects || this.objects.length === 0) return null;
      // Find bounding sphere centered on origin (where star is)
      let maxDist = 10;
      for (let di = 0; di < this.objects.length; di++) {
        const pp = this.objects[di].position;
        if (pp) {
          const dx = pp[0], dy = pp[1], dz = pp[2];
          const d = Math.sqrt(dx*dx + dy*dy + dz*dz) + (this.objects[di].scale || 5);
          if (d > maxDist) maxDist = d;
        }
      }
      let fovRad = CFG.camera.fov * Math.PI / 180;
      if (fovRad <= 0) fovRad = 1;
      let dist = maxDist / Math.sin(fovRad / 2) * 1.8;
      dist = Math.max(dist, CFG.camera.minZoom);
      dist = Math.min(dist, CFG.camera.maxZoom);
      return {
        position: [0, dist * 0.42, dist],
        target: [0, 0, 0],
        dist: dist,
      };
    },

    _applyFitView(view) {
      this.camera.position[0] = view.position[0];
      this.camera.position[1] = view.position[1];
      this.camera.position[2] = view.position[2];
      this.camera.target[0] = view.target[0];
      this.camera.target[1] = view.target[1];
      this.camera.target[2] = view.target[2];
    },

    _introEnabled() {
      if (CFG.accessibility && CFG.accessibility.reducedMotion) return false;
      if (CFG.animation && CFG.animation.enabled === false) return false;
      if (CFG.animation && CFG.animation.cinematicTransitions === false) return false;
      return true;
    },

    /** Replay the slow open zoom for an already-loaded galaxy. */
    _playOpenZoom() {
      if (!this.objects || this.objects.length === 0) return;
      this._autoFitCamera(true);
    },

    /** Let the user interrupt the intro zoom by grabbing control. */
    _armIntroCancel() {
      if (!this.canvas || !this.animation) return;
      const cancel = () => {
        if (this.animation && typeof this.animation.cancelTransitions === "function") {
          this.animation.cancelTransitions();
        }
      };
      if (this._introCancelHandler && this.canvas) {
        this.canvas.removeEventListener("wheel", this._introCancelHandler);
        this.canvas.removeEventListener("mousedown", this._introCancelHandler);
      }
      this._introCancelHandler = cancel;
      this.canvas.addEventListener("wheel", cancel, { once: true, passive: true });
      this.canvas.addEventListener("mousedown", cancel, { once: true });
    },

    /**
     * Perspective size factor for world-scale radii: focal / distance,
     * clamped so flying through an object can't blow up to an enormous
     * radius. Falls back to 1 before the first frame (no focal yet).
     */
    _perspScale(obj) {
      const focal = this._focal;
      const dist = obj ? obj._distance : 0;
      if (!(focal > 0) || !(dist > 0)) return 1;
      const s = focal / dist;
      return s > 10 ? 10 : s;
    },

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
    },

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
    },

    _project(position, viewMatrix, projMatrix, w, h) {
      if (!position) return null;

      // View transform
      const x = viewMatrix[0] * position[0] + viewMatrix[4] * position[1] + viewMatrix[8] * position[2] + viewMatrix[12];
      const y = viewMatrix[1] * position[0] + viewMatrix[5] * position[1] + viewMatrix[9] * position[2] + viewMatrix[13];
      const z = viewMatrix[2] * position[0] + viewMatrix[6] * position[1] + viewMatrix[10] * position[2] + viewMatrix[14];
      const w2 = viewMatrix[3] * position[0] + viewMatrix[7] * position[1] + viewMatrix[11] * position[2] + viewMatrix[15];

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
    },

    /** Lock the camera onto an object; cleared on any manual control. */
_setFollow(obj) {
       if (this.followTarget && this.followTarget !== obj) this.followTarget._followLocked = false;
       this.followTarget = obj || null;
       // The selected planet itself stands still (no orbit/spin) while locked.
       if (this.followTarget) this.followTarget._followLocked = true;
       this._followPrev = null;
       // Freeze the whole galaxy for calm inspection while selected.
       this._selectionFrozen = !!this.followTarget;
       if (this.followTarget) this.followTarget._frozen = true;
       this._updatePauseState();
     },

     _clearFollow() {
       if (this.followTarget) this.followTarget._followLocked = false;
       if (this.followTarget) this.followTarget._frozen = false;
       this.followTarget = null;
       this._followPrev = null;
       this._selectionFrozen = false;
       this._updatePauseState();
     },

    /**
     * Object motion runs only when nothing is hovered and nothing is
     * selected. Camera flights always keep running (wall-clock).
     */
    _updatePauseState() {
      if (!this.animation) return;
      this.animation.paused = !!(this.hoveredObject || this._selectionFrozen);
    },

    /**
     * Keep the camera glued to the follow target. While a flight is active
     * the flight's end point is moved along with the planet (homing), so the
     * arrival snap lands on the live position; afterwards the camera is
     * translated by the planet's per-frame delta with the aim hard-locked.
     */
    _updateFollow() {
      const obj = this.followTarget;
      if (!obj || !obj.position || !this.camera) return;
      // Flying manually (WASD) releases the lock.
      const k = this.interaction && this.interaction.keys;
      if (k && (k["w"] || k["a"] || k["s"] || k["d"] || k["q"] || k["e"])) {
        this._clearFollow();
        return;
      }
      const p = obj.position;
      if (!this._followPrev) this._followPrev = [p[0], p[1], p[2]];
      const dx = p[0] - this._followPrev[0];
      const dy = p[1] - this._followPrev[1];
      const dz = p[2] - this._followPrev[2];
      this._followPrev = [p[0], p[1], p[2]];
      const tr = this.animation && this.animation.transitions && this.animation.transitions[0];
      if (tr) {
        if (tr.targetPosition) {
          tr.targetPosition[0] += dx;
          tr.targetPosition[1] += dy;
          tr.targetPosition[2] += dz;
        }
        if (tr.targetTarget) {
          tr.targetTarget[0] = p[0];
          tr.targetTarget[1] = p[1];
          tr.targetTarget[2] = p[2];
        }
      } else {
        if (dx || dy || dz) {
          this.camera.position[0] += dx;
          this.camera.position[1] += dy;
          this.camera.position[2] += dz;
        }
        this.camera.target[0] = p[0];
        this.camera.target[1] = p[1];
        this.camera.target[2] = p[2];
      }
    },
  };

  GV.CameraMixin = CameraMixin;
})();
