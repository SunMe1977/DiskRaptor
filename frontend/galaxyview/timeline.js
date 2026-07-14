/**
 * DiskRaptor — GalaxyView Timeline Engine (Time Travel)
 * Galaxy morphs based on file growth, access frequency, modification history.
 * Slider: Today → 7 days → 30 days → 90 days.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class TimelineEngine {
    constructor(galaxyView) {
      this.galaxyView = galaxyView;
      this.currentSnapshot = "today";
      this.snapshots = {};
      this.timelinePosition = 0; // 0..1
      this.isTransitioning = false;
      this.listeners = [];
      this.container = null;
      this.sliderEl = null;
    }

    /** Initialize the timeline UI */
    initUI(container) {
      this.container = container;

      const wrap = document.createElement("div");
      wrap.className = "galaxy-timeline";

      wrap.innerHTML = `
        <div class="timeline-label">
          <span class="timeline-icon">⏱</span>
          <span class="timeline-title" data-i18n="galaxy.timeline">Time Travel</span>
        </div>
        <div class="timeline-slider-wrap">
          <input type="range" class="timeline-slider" min="0" max="1" step="0.01" value="0" />
          <div class="timeline-marks">
            <span data-pos="0">Today</span>
            <span data-pos="0.33">7 days</span>
            <span data-pos="0.66">30 days</span>
            <span data-pos="1">90 days</span>
          </div>
        </div>
      `;

      container.appendChild(wrap);

      this.sliderEl = wrap.querySelector(".timeline-slider");
      this.sliderEl.addEventListener("input", () => {
        this.timelinePosition = parseFloat(this.sliderEl.value);
        this._onTimelineChange();
      });
    }

    /** Record a snapshot of galaxy state for a time period */
    recordSnapshot(label, galaxyObjects) {
      this.snapshots[label] = JSON.parse(JSON.stringify(galaxyObjects));
    }

    /** Load a pre-recorded snapshot */
    loadSnapshot(label) {
      if (!this.snapshots[label]) return;
      this.currentSnapshot = label;
      this.isTransitioning = true;

      const target = this.snapshots[label];
      const current = this.galaxyView.objects;

      // Morph current objects to target state
      if (target && current) {
        this._morphObjects(current, target);
      }

      setTimeout(() => {
        this.isTransitioning = false;
        this._notify("snapshot-loaded", { snapshot: label });
      }, CFG.timeline.transitionDuration);
    }

    _morphObjects(current, target) {
      // Scale objects towards target sizes and positions
      const duration = CFG.timeline.transitionDuration;
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = this._easeInOutCubic(progress);

        for (let i = 0; i < Math.min(current.length, target.length); i++) {
          const c = current[i];
          const t = target[i];
          if (!c || !t) continue;

          // Interpolate scale
          if (t.scale !== undefined && c.scale !== undefined) {
            c.scale = c.scale + (t.scale - c.scale) * ease;
          }

          // Interpolate position
          if (t.position && c.position) {
            c.position[0] = c.position[0] + (t.position[0] - c.position[0]) * ease;
            c.position[1] = c.position[1] + (t.position[1] - c.position[1]) * ease;
            c.position[2] = c.position[2] + (t.position[2] - c.position[2]) * ease;
          }

          // Interpolate color
          if (t.color && c.color) {
            c.color[0] = c.color[0] + (t.color[0] - c.color[0]) * ease;
            c.color[1] = c.color[1] + (t.color[1] - c.color[1]) * ease;
            c.color[2] = c.color[2] + (t.color[2] - c.color[2]) * ease;
          }
        }

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      animate();
    }

    _easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    _onTimelineChange() {
      const pos = this.timelinePosition;
      let label = "today";
      if (pos < 0.2) label = "today";
      else if (pos < 0.5) label = "7days";
      else if (pos < 0.8) label = "30days";
      else label = "90days";

      if (label !== this.currentSnapshot) {
        this.loadSnapshot(label);
      }

      this._notify("timeline-changed", { position: pos, snapshot: label });
    }

    /** Simulate historical data based on current scan */
    simulateHistory(objects) {
      if (!objects) return;

      // 7 days ago: slightly smaller, less active
      const days7 = objects.map(o => {
        const c = JSON.parse(JSON.stringify(o));
        if (c.scale) c.scale *= 0.85 + Math.random() * 0.1;
        if (c.glow) c.glow *= 0.7;
        if (c.orbitSpeed) c.orbitSpeed *= 1.2; // faster orbit = newer
        if (c.position) {
          c.position[0] += (Math.random() - 0.5) * 20;
          c.position[2] += (Math.random() - 0.5) * 20;
        }
        return c;
      });
      this.snapshots["7days"] = days7;

      // 30 days ago: smaller, less organized
      const days30 = objects.map(o => {
        const c = JSON.parse(JSON.stringify(o));
        if (c.scale) c.scale *= 0.6 + Math.random() * 0.15;
        if (c.glow) c.glow *= 0.4;
        if (c.alpha) c.alpha *= 0.8;
        if (c.position) {
          c.position[0] += (Math.random() - 0.5) * 50;
          c.position[2] += (Math.random() - 0.5) * 50;
        }
        return c;
      });
      this.snapshots["30days"] = days30;

      // 90 days ago: sparse, dim
      const days90 = objects.map(o => {
        const c = JSON.parse(JSON.stringify(o));
        if (c.scale) c.scale *= 0.3 + Math.random() * 0.1;
        if (c.glow) c.glow *= 0.2;
        if (c.alpha) c.alpha *= 0.6;
        if (c.position) {
          c.position[0] += (Math.random() - 0.5) * 100;
          c.position[2] += (Math.random() - 0.5) * 100;
        }
        if (c.orbitSpeed) c.orbitSpeed *= 2;
        return c;
      });
      this.snapshots["90days"] = days90;

      // Today's snapshot is the current state
      this.snapshots["today"] = JSON.parse(JSON.stringify(objects));
    }

    on(event, callback) {
      this.listeners.push({ event, callback });
    }

    _notify(event, data) {
      for (const l of this.listeners) {
        if (l.event === event) l.callback(data);
      }
    }

    show() {
      if (this.container) this.container.style.display = "block";
    }

    hide() {
      if (this.container) this.container.style.display = "none";
    }

    dispose() {
      this.listeners = [];
      if (this.container) {
        const el = this.container.querySelector(".galaxy-timeline");
        if (el) el.remove();
      }
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.TimelineEngine = TimelineEngine;
})();
