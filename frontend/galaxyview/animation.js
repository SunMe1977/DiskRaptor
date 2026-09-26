/**
 * DiskRaptor — GalaxyView Animation Engine
 * Controls orbits, rotations, pulses, glows, sparkles, transitions.
 * Every animation communicates information — never decorative.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  /** Global rotation/orbit tempo (0.5 = half speed). Pulses stay untouched. */
  function rotScale() {
    const s = CFG.animation && CFG.animation.rotationScale;
    return (typeof s === "number" && isFinite(s) && s >= 0) ? s : 1;
  }

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
      this.deltaTime = timestamp - (this.lastTimestamp || timestamp);
      this.lastTimestamp = timestamp;

      // Clamp frame gaps (tab hidden, galaxy closed a while, first frame after
      // show()) for the object animations below. Camera transitions use
      // wall-clock progress instead, so they can't snap or stall.
      // Matches the render loop's own >100ms skip policy.
      if (this.deltaTime > 100) this.deltaTime = 16;
      if (this.deltaTime < 0) this.deltaTime = 0;

      const dt = this.deltaTime * this.speed;

      // Camera transitions always run — even while object animation is
      // paused (e.g. hovering a planet must not freeze the open zoom).
      // Progress is wall-clock based (see _updateTransitions) so flights
      // always take `duration` ms even when frames are slow or skipped.
      this._updateTransitions(dt, camera, timestamp);

      if (this.paused) return;

      this.time += this.deltaTime * this.speed;

      const t = this.time;

      // Update celestial object animations
      // (_followLocked objects are skipped: a selected planet stands still
      // while the camera stays locked onto it.)
      for (const obj of objects) {
        if (!obj || !obj.active || obj._followLocked) continue;

        switch (obj.type) {
          case "star":
            this._animateStar(obj, t);
            break;
          case "planet":
            this._animatePlanet(obj, t, dt);
            break;
          case "moon":
            this._animateMoon(obj, t, dt);
            break;
          case "blackHole":
            this._animateBlackHole(obj, t, dt);
            break;
          case "comet":
            this._animateComet(obj, t, dt);
            break;
          case "diamond":
            this._animateDiamond(obj, t, dt);
            break;
          case "satellite":
            this._animateSatellite(obj, t, dt);
            break;
          case "nebula":
            this._animateNebula(obj, t);
            break;
          case "meteor":
            this._animateMeteor(obj, t, dt);
            break;
        }
      }

      // Advance time
      this.time += dt;
    }

    _animateStar(star, t) {
      // Slow rotation (scaled by global rotation tempo)
      star._rotation = (star._rotation || 0) + 0.0005 * rotScale();
      // Subtle glow pulse based on usage
      const pulse = Math.sin(t * CFG.animation.glowPulseSpeed + (star.data?.totalFiles || 0) * 0.001) * 0.1 + 0.9;
      star._currentGlow = (star.glow || 0.5) * pulse;
    }

    _animatePlanet(planet, t, dt) {
      // Orbit motion at a CONSTANT angular velocity (scaled by global
      // rotation tempo). Must integrate frame dt — the previous form used
      // the absolute clock `t`, so orbits kept accelerating the longer the
      // galaxy stayed open. Factor 0.6 keeps the original tempo.
      planet.orbitAngle = (planet.orbitAngle || 0) + (planet.orbitSpeed || CFG.animation.orbitSpeed) * dt * 0.6 * rotScale();
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

      // Rotation at constant velocity (scaled by global rotation tempo)
      planet._rotation = (planet._rotation || 0) + (planet.rotationSpeed || 0.001) * dt * 0.6 * rotScale();
    }

    _animateMoon(moon, t, dt) {
      // Orbit around parent at constant velocity (scaled by global tempo)
      if (moon.parentPosition && moon.orbitRadius) {
        moon.orbitAngle = (moon.orbitAngle || 0) + (moon.orbitSpeed || 0.003) * dt * 0.6 * rotScale();
        const rad = moon.orbitRadius;
        moon.position[0] = moon.parentPosition[0] + Math.cos(moon.orbitAngle) * rad;
        moon.position[2] = moon.parentPosition[2] + Math.sin(moon.orbitAngle) * rad;
      }

      // Sparkle
      if (moon.sparkle) {
        moon._sparkle = Math.sin(t * CFG.animation.sparkleSpeed + (moon.id || "").length) * 0.5 + 0.5;
      }
    }

    _animateBlackHole(bh, t, dt) {
      // Slow rotation at constant velocity (scaled by global tempo)
      bh._rotation = (bh._rotation || 0) + (bh.rotationSpeed || 0.0003) * dt * 0.6 * rotScale();

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

    _animateDiamond(diamond, t, dt) {
      // Hovering motion
      if (diamond.position) {
        diamond.position[1] = 35 + Math.sin(t * 0.002) * 3;
      }

      // Shimmer
      if (diamond.shimmer) {
        diamond._shimmer = Math.sin(t * 0.003) * 0.3 + 0.7;
      }

      // Rotation at constant velocity (scaled by global rotation tempo)
      diamond._rotation = (diamond._rotation || 0) + 0.01 * dt * 0.6 * rotScale();
    }

    _animateSatellite(sat, t, dt) {
      // Fast orbit at constant velocity (scaled by global rotation tempo)
      sat.orbitAngle = (sat.orbitAngle || 0) + (sat.orbitSpeed || 0.005) * dt * 0.6 * rotScale();
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
        startStamp: null,     // wall-clock start, captured on first update
        duration: duration,
        progress: 0,
      });
    }

    /** Cancel any in-flight camera transition (e.g. user grabs control). */
    cancelTransitions() {
      this.transitions = [];
    }

    _updateTransitions(dt, camera, timestamp) {
      if (!this.transitions.length || !camera) return;

      const transition = this.transitions[0];

      // Capture start positions on first frame
      if (!transition.startPosition && camera.position) {
        transition.startPosition = [...camera.position];
        transition.startTarget = camera.target ? [...camera.target] : [0, 0, 0];
      }
      if (typeof transition.startStamp !== "number" && typeof timestamp === "number" && isFinite(timestamp)) {
        transition.startStamp = timestamp;
      }

      // Wall-clock progress: elapsed real time since the flight started, so
      // the camera always arrives after `duration` ms — even when frames are
      // slow (>100ms in heavy scenes) or skipped by the render loop.
      // (Accumulating clamped frame dt stretched the intro zoom into tens of
      // seconds on large scans and made it look frozen.) Falls back to dt
      // accumulation when no valid timestamp is available.
      if (typeof timestamp === "number" && typeof transition.startStamp === "number" && transition.duration > 0) {
        const elapsed = timestamp - transition.startStamp;
        transition.progress = Math.min(Math.max(elapsed, 0) / transition.duration, 1);
      } else if (!(transition.duration > 0)) {
        transition.progress = 1;
      } else {
        transition.progress += dt / transition.duration;
      }
      if (transition.progress >= 1) {
        // Snap exactly onto the target — no float drift, clean lock
        // (e.g. onto a planet) instead of floating nearby.
        if (camera.position && transition.targetPosition) {
          camera.position[0] = transition.targetPosition[0];
          camera.position[1] = transition.targetPosition[1];
          camera.position[2] = transition.targetPosition[2];
        }
        if (camera.target && transition.targetTarget) {
          camera.target[0] = transition.targetTarget[0];
          camera.target[1] = transition.targetTarget[1];
          camera.target[2] = transition.targetTarget[2];
        }
        this.transitions.shift(); // Complete
        return;
      }

      // Ease-out cubic: immediate, clearly visible motion right at the
      // start of the flight with a soft landing — so even short flights
      // read as animation instead of standing still, then snapping.
      const t = transition.progress;
      const ease = 1 - Math.pow(1 - t, 3);

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
