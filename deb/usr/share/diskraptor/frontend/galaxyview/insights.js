/**
 * DiskRaptor — GalaxyView AI Insights Engine
 * Overlay text explaining the galaxy:
 * Largest storage consumer, duplicates, rapid growth, etc.
 * Reads file system data and generates human-readable insights.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class AIInsightsEngine {
    constructor(galaxyView) {
      this.gv = galaxyView;
      this.insights = [];
      this.activeInsight = null;
      this.overlayEl = null;
      this.insightQueue = [];
      this.currentIndex = 0;
      this.busy = false;
      this.autoShow = CFG.insights.autoShow;
    }

    /** Initialize the insights overlay UI */
    initUI(container) {
      this.overlayEl = document.createElement("div");
      this.overlayEl.className = "galaxy-insight-overlay";
      this.overlayEl.innerHTML = `
        <div class="galaxy-insight-card">
          <div class="insight-icon">💡</div>
          <div class="insight-content">
            <div class="insight-title" data-i18n="galaxy.insight.title">AI Insight</div>
            <div class="insight-text">Loading insights...</div>
          </div>
          <button class="insight-close" title="Close">✕</button>
        </div>
      `;
      this.overlayEl.style.display = "none";
      container.appendChild(this.overlayEl);

      // Close button
      const closeBtn = this.overlayEl.querySelector(".insight-close");
      if (closeBtn) {
        closeBtn.addEventListener("click", () => this.hide());
      }

      // Auto-rotate insights
      setInterval(() => this._nextInsight(), CFG.insights.refreshInterval + CFG.insights.displayDuration);
    }

    /**
     * Analyze scan data and generate insights.
     * @param {Object} stats - scan stats {total_files, total_dirs, total_size}
     * @param {Array} topFiles - largest files [{name, path, size}]
     * @param {Array} duplicates - duplicate file groups
     */
    analyze(stats, topFiles, duplicates) {
      this.insights = [];
      if (!stats) return;

      const files = stats.total_files || stats.totalFiles || 0;
      const dirs = stats.total_dirs || stats.totalDirs || 0;
      const size = stats.total_size || stats.totalSize || 0;
      const top = topFiles || [];

      // 1. Largest storage consumer
      if (top.length > 0) {
        const largest = top[0];
        const largestSize = largest.size || 0;
        const largestName = (largest.path || largest.name || "").split(/[/\\]/).pop() || "";
        this.insights.push({
          icon: "📦",
          priority: 1,
          text: `Largest file: "${largestName}" — ${this._fmtSize(largestSize)}`,
          detail: `${this._fmtSize(largestSize)} single file`,
        });
      }

      // 2. Total scan summary
      this.insights.push({
        icon: "📊",
        priority: 2,
        text: `Scan found ${files.toLocaleString()} files in ${dirs.toLocaleString()} folders — ${this._fmtSize(size)} total`,
        detail: `${((size / (1024*1024*1024)) || 0).toFixed(1)} GB across ${files.toLocaleString()} files`,
      });

      // 3. File type distribution
      if (top.length > 0) {
        const typeSizes = {};
        let totalSize = 0;
        for (const f of top.slice(0, 200)) {
          const ext = ((f.path || f.name || "").split(".").pop() || "").toLowerCase();
          const fSize = f.size || 0;
          typeSizes[ext] = (typeSizes[ext] || 0) + fSize;
          totalSize += fSize;
        }
        if (totalSize > 0) {
          const sorted = Object.entries(typeSizes).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            const topType = sorted[0];
            const pct = (topType[1] / totalSize * 100).toFixed(0);
            this.insights.push({
              icon: "📁",
              priority: 3,
              text: `".${topType[0]}" files dominate — ${pct}% of scanned data`,
              detail: `${sorted.slice(0, 3).map(([e, s]) => `.${e}: ${this._fmtSize(s)}`).join(", ")}`,
            });
          }
        }
      }

      // 4. Growth/activity insight (if we have top files)
      if (top.length > 5) {
        this.insights.push({
          icon: "📈",
          priority: 3,
          text: `${Math.min(top.length, 50)} largest files account for ${this._fmtSize(top.slice(0, 50).reduce((a, f) => a + (f.size || 0), 0))}`,
          detail: "Top files by size",
        });
      }

      // 5. Directory depth insight
      if (dirs > 0) {
        const avgFilesPerDir = (files / Math.max(dirs, 1)).toFixed(1);
        this.insights.push({
          icon: "🌳",
          priority: 4,
          text: `Average ${avgFilesPerDir} files per directory`,
          detail: `${files.toLocaleString()} files / ${dirs.toLocaleString()} dirs`,
        });
      }

      // 6. Duplicate insight
      if (duplicates && duplicates.length > 0) {
        const wastedSpace = duplicates.reduce((a, g) => {
          if (g.size_human) {
            const match = g.size_human.match(/[\d.]+/);
            return a + (match ? parseFloat(match[0]) * 1e9 : 0);
          }
          return a + (g.wasted_size || g.wasted || 0);
        }, 0);
        this.insights.push({
          icon: "🔍",
          priority: 1,
          text: `${duplicates.length} duplicate group${duplicates.length > 1 ? "s" : ""} found — ~${this._fmtSize(wastedSpace)} reclaimable`,
          detail: "Check duplicates panel for details",
        });
      }

      // Sort by priority
      this.insights.sort((a, b) => a.priority - b.priority);

      // Queue for display
      this.insightQueue = [...this.insights];
      this.currentIndex = 0;

      if (this.autoShow && this.insights.length > 0) {
        this._showInsight(0);
      }
    }

    _showInsight(index) {
      if (!this.overlayEl || index >= this.insights.length) return;
      this.busy = true;
      this.currentIndex = index;
      const insight = this.insights[index];

      const iconEl = this.overlayEl.querySelector(".insight-icon");
      const textEl = this.overlayEl.querySelector(".insight-text");
      const titleEl = this.overlayEl.querySelector(".insight-title");

      if (iconEl) iconEl.textContent = insight.icon || "💡";
      if (textEl) {
        textEl.textContent = insight.text;
        textEl.title = insight.detail || "";
      }
      if (titleEl) titleEl.textContent = "Insight " + (index + 1);

      // Fade in
      this.overlayEl.style.display = "block";
      this.overlayEl.style.opacity = 0;
      requestAnimationFrame(() => {
        this.overlayEl.style.transition = `opacity ${CFG.insights.fadeInDuration}ms ease`;
        this.overlayEl.style.opacity = CFG.insights.overlayOpacity;
      });

      setTimeout(() => {
        if (!this.autoShow) return;
        this.busy = false;
      }, CFG.insights.displayDuration);
    }

    _nextInsight() {
      if (!this.autoShow || this.busy || this.insights.length === 0) return;
      const nextIdx = (this.currentIndex + 1) % this.insights.length;

      // Fade out
      if (this.overlayEl) {
        this.overlayEl.style.opacity = 0;
      }

      setTimeout(() => {
        this._showInsight(nextIdx);
      }, 300);
    }

    show() {
      if (this.overlayEl && this.insights.length > 0) {
        this._showInsight(0);
      }
    }

    hide() {
      if (this.overlayEl) {
        this.overlayEl.style.display = "none";
        this.overlayEl.style.opacity = 0;
      }
      this.busy = false;
    }

    /** Format bytes to human-readable string */
    _fmtSize(bytes) {
      if (!bytes || bytes <= 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const v = bytes / Math.pow(1024, i);
      return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
    }

    dispose() {
      if (this.overlayEl && this.overlayEl.parentElement) {
        this.overlayEl.parentElement.removeChild(this.overlayEl);
      }
      this.insights = [];
      this.insightQueue = [];
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.AIInsightsEngine = AIInsightsEngine;
})();
