/**
 * DiskRaptor — GalaxyView Animation Engine
 * Controls orbits, rotations, pulses, glows, sparkles, transitions.
 * Every animation communicates information — never decorative.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class AnimationEngine {
    constructor() {
      this.time = 0;
      this.deltaTime = 0;
      this.lastTimestamp = 0;
      this.animations = new Map();    // id -> animation state
      this.transitions = [];
      this.paused = false;
      this.speed = 1.0;
    }

    /** Update all animations. Called every frame. */
    update(timestamp, objects, camera) {
      if (this.paused) return;

      this.deltaTime = timestamp - (this.lastTimestamp || timestamp);
      this.lastTimestamp = timestamp;
      this.time += this.deltaTime * this.speed;

      const dt = this.deltaTime * this.speed;
      const t = this.time;

      // Update celestial object animations
      for (const obj of objects) {
        if (!obj || !obj.active) continue;

        switch (obj.type) {
          case "star":
            this._animateStar(obj, t);
            break;
          case "planet":
            this._animatePlanet(obj, t);
            break;
          case "moon":
            this._animateMoon(obj, t);
            break;
          case "blackHole":
            this._animateBlackHole(obj, t);
            break;
          case "comet":
            this._animateComet(obj, t, dt);
            break;
          case "diamond":
            this._animateDiamond(obj, t);
            break;
          case "satellite":
            this._animateSatellite(obj, t);
            break;
          case "nebula":
            this._animateNebula(obj, t);
            break;
          case "meteor":
            this._animateMeteor(obj, t, dt);
            break;
        }
      }

      // Update camera transitions
      this._updateTransitions(dt, camera);

      // Advance time
      this.time += dt;
    }

    _animateStar(star, t) {
      // Slow rotation pulse
      star._rotation = (star._rotation || 0) + 0.0005;
      // Subtle glow pulse based on usage
      const pulse = Math.sin(t * CFG.animation.glowPulseSpeed + (star.data?.totalFiles || 0) * 0.001) * 0.1 + 0.9;
      star._currentGlow = (star.glow || 0.5) * pulse;
    }

    _animatePlanet(planet, t) {
      // Orbit motion
      planet.orbitAngle = (planet.orbitAngle || 0) + (planet.orbitSpeed || CFG.animation.orbitSpeed) * t * 0.01;
      if (planet.position && planet.orbitRadius) {
        const rad = planet.orbitRadius + Math.sin(t * 0.0001) * 2; // slight eccentricity
        planet.position[0] = Math.cos(planet.orbitAngle) * rad;
        planet.position[2] = Math.sin(planet.orbitAngle) * rad;
      }

      // Pulse: recent activity = stronger pulse
      if (planet.pulsePhase !== undefined) {
        const activity = planet.data?.files > 1000 ? 1 : planet.data?.files > 100 ? 0.5 : 0.2;
        const pulse = Math.sin(t * CFG.animation.pulseSpeed * activity + planet.pulsePhase) * 0.15 + 0.85;
        planet._pulse = pulse;
      }

      // Rotation
      planet._rotation = (planet._rotation || 0) + (planet.rotationSpeed || 0.001) * t * 0.01;
    }

    _animateMoon(moon, t) {
      // Orbit around parent
      if (moon.parentPosition && moon.orbitRadius) {
        moon.orbitAngle = (moon.orbitAngle || 0) + (moon.orbitSpeed || 0.003) * t * 0.01;
        const rad = moon.orbitRadius;
        moon.position[0] = moon.parentPosition[0] + Math.cos(moon.orbitAngle) * rad;
        moon.position[2] = moon.parentPosition[2] + Math.sin(moon.orbitAngle) * rad;
      }

      // Sparkle
      if (moon.sparkle) {
        moon._sparkle = Math.sin(t * CFG.animation.sparkleSpeed + (moon.id || "").length) * 0.5 + 0.5;
      }
    }

    _animateBlackHole(bh, t) {
      // Slow rotation
      bh._rotation = (bh._rotation || 0) + (bh.rotationSpeed || 0.0003) * t * 0.01;

      // Event horizon pulse
      const pulse = Math.sin(t * 0.0005) * 0.1 + 0.9;
      bh._eventHorizonScale = bh.scale * pulse;

      // Gravitational lensing effect intensifies
      bh._lensing = Math.sin(t * 0.0002) * 0.3 + 0.7;
    }

    _animateComet(comet, t, dt) {
      // Move comet along trajectory
      if (comet.velocity) {
        comet.position[0] += comet.velocity[0] * dt * 0.05;
        comet.position[1] += comet.velocity[1] * dt * 0.05;
        comet.position[2] += comet.velocity[2] * dt * 0.05;
      }

      // Fade out based on lifetime
      const elapsed = Date.now() - (comet.birthTime || 0);
      const remaining = 1 - (elapsed / (comet.lifetime || 5000));
      comet._alpha = Math.max(0, remaining);

      // Decay size
      comet._currentScale = (comet.scale || 1) * (0.8 + remaining * 0.2);
    }

    _animateDiamond(diamond, t) {
      // Hovering motion
      if (diamond.position) {
        diamond.position[1] = 35 + Math.sin(t * 0.002) * 3;
      }

      // Shimmer
      if (diamond.shimmer) {
        diamond._shimmer = Math.sin(t * 0.003) * 0.3 + 0.7;
      }

      // Rotation
      diamond._rotation = (diamond._rotation || 0) + 0.01 * t * 0.01;
    }

    _animateSatellite(sat, t) {
      // Fast orbit
      sat.orbitAngle = (sat.orbitAngle || 0) + (sat.orbitSpeed || 0.005) * t * 0.01;
      if (sat.orbitRadius) {
        sat.position[0] = Math.cos(sat.orbitAngle) * sat.orbitRadius;
        sat.position[2] = Math.sin(sat.orbitAngle) * sat.orbitRadius;
      }
    }

    _animateNebula(nebula, t) {
      // Gentle pulsing
      nebula._pulse = Math.sin(t * 0.0003 + (nebula.position ? nebula.position[0] : 0)) * 0.1 + 0.9;
      // Slight movement (nebula drift)
      if (nebula.position) {
        nebula.position[0] += Math.sin(t * 0.0001) * 0.01;
        nebula.position[2] += Math.cos(t * 0.00012) * 0.01;
      }
    }

    _animateMeteor(meteor, t, dt) {
      if (meteor.velocity) {
        meteor.position[0] += meteor.velocity[0] * dt * 0.05;
        meteor.position[1] += meteor.velocity[1] * dt * 0.05;
        meteor.position[2] += meteor.velocity[2] * dt * 0.05;
      }

      const elapsed = Date.now() - (meteor.birthTime || 0);
      const remaining = 1 - (elapsed / (meteor.lifetime || 3000));
      meteor._alpha = Math.max(0, remaining);
    }

    // ── Camera Transitions ────────────────────────────────────

    /** Queue a cinematic camera transition */
    flyTo(targetPosition, targetTarget, duration) {
      duration = duration || CFG.camera.cinematicTransitionDuration;
      this.transitions.push({
        startPosition: null,  // captured on first update
        targetPosition: targetPosition,
        startTarget: null,
        targetTarget: targetTarget,
        startTime: this.time,
        duration: duration,
        progress: 0,
      });
    }

    _updateTransitions(dt, camera) {
      if (!this.transitions.length || !camera) return;

      const transition = this.transitions[0];

      // Capture start positions on first frame
      if (!transition.startPosition && camera.position) {
        transition.startPosition = [...camera.position];
        transition.startTarget = camera.target ? [...camera.target] : [0, 0, 0];
      }

      transition.progress += dt / transition.duration;
      if (transition.progress >= 1) {
        transition.progress = 1;
        this.transitions.shift(); // Complete
      }

      // Smooth interpolation (ease-in-out cubic)
      const t = transition.progress;
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      if (camera.position && transition.startPosition && transition.targetPosition) {
        camera.position[0] = transition.startPosition[0] + (transition.targetPosition[0] - transition.startPosition[0]) * ease;
        camera.position[1] = transition.startPosition[1] + (transition.targetPosition[1] - transition.startPosition[1]) * ease;
        camera.position[2] = transition.startPosition[2] + (transition.targetPosition[2] - transition.startPosition[2]) * ease;
      }

      if (camera.target && transition.startTarget && transition.targetTarget) {
        camera.target[0] = transition.startTarget[0] + (transition.targetTarget[0] - transition.startTarget[0]) * ease;
        camera.target[1] = transition.startTarget[1] + (transition.targetTarget[1] - transition.startTarget[1]) * ease;
        camera.target[2] = transition.startTarget[2] + (transition.targetTarget[2] - transition.startTarget[2]) * ease;
      }
    }

    // ── Control ───────────────────────────────────────────────

    pause() { this.paused = true; }
    resume() { this.paused = false; }
    setSpeed(speed) { this.speed = Math.max(0, Math.min(speed, 10)); }

    /** Get current animation state for an object (interpolated values) */
    getState(obj) {
      if (!obj) return null;
      return {
        rotation: obj._rotation || 0,
        pulse: obj._pulse || 1,
        glow: obj._currentGlow !== undefined ? obj._currentGlow : (obj.glow || 0),
        sparkle: obj._sparkle || 0,
        alpha: obj._alpha !== undefined ? obj._alpha : (obj.alpha || 1),
        scale: obj._currentScale !== undefined ? obj._currentScale : (obj.scale || 1),
        shimmer: obj._shimmer || 0,
        eventHorizonScale: obj._eventHorizonScale || obj.scale,
        lensing: obj._lensing || 0,
        nebulaPulse: obj._pulse || 1,
      };
    }

    clear() {
      this.animations.clear();
      this.transitions = [];
      this.time = 0;
    }

    dispose() {
      this.clear();
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.AnimationEngine = AnimationEngine;
})();
