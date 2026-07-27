/**
 * DiskRaptor — GalaxyView Live Scan Engine
 * Real-time visualization during scanning:
 * - New planets appear live
 * - Nebulae expand
 * - Comets spawn
 * - Meteor streaks show scan speed
 * - Black holes form when huge folders detected
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class LiveScanEngine {
    constructor(galaxyView, dataMapper) {
      this.gv = galaxyView;
      this.dataMapper = dataMapper;
      this.active = false;
      this.lastProgress = 0;
      this.meteorTimer = 0;
      this.scanSpeed = 0;
      this.prevFilesFound = 0;
      this.speedSamples = [];
      this.onComplete = null;

      // Scan stats overlay
      this.statsOverlay = null;
    }

    /** Start live scan mode */
    start(scanPath) {
      this.active = true;
      this.lastProgress = 0;
      this.meteorTimer = 0;
      this.scanSpeed = 0;
      this.prevFilesFound = 0;
      this.speedSamples = [];
      this._createStatsOverlay();
    }

    /** Called each frame during scan with progress data */
    update(progress) {
      if (!this.active || !progress) return;

      const filesFound = progress.filesFound || 0;
      const dirsFound = progress.dirsFound || 0;
      const isRunning = progress.isRunning;
      const elapsedSecs = progress.elapsedSecs || 0;

      // Calculate scan speed (files/second)
      if (this.prevFilesFound > 0) {
        const speed = (filesFound - this.prevFilesFound) / Math.max(0.5, this.lastInterval || 0.5);
        this.speedSamples.push(speed);
        if (this.speedSamples.length > 10) this.speedSamples.shift();
      }
      this.prevFilesFound = filesFound;
      this.lastInterval = 1; // ~1 sec between updates

      this.scanSpeed = this.speedSamples.reduce((a, b) => a + b, 0) / Math.max(this.speedSamples.length, 1);

      // Spawn new celestial objects
      if (filesFound > this.lastProgress + 100) {
        this._spawnScanObjects(filesFound - this.lastProgress, filesFound, dirsFound);
        this.lastProgress = filesFound;
      }

      // Meteor showers proportional to scan speed
      this.meteorTimer++;
      if (this.meteorTimer > Math.max(5, 30 - this.scanSpeed * 0.5)) {
        this._spawnMeteorShower();
        this.meteorTimer = 0;
      }

      // Update overlay
      this._updateStatsOverlay(filesFound, dirsFound, elapsedSecs, isRunning);
    }

    _spawnScanObjects(count, totalFiles, totalDirs) {
      if (!this.gv || !this.dataMapper) return;

      const spawnCount = Math.min(count, 20);
      for (let i = 0; i < spawnCount; i++) {
        const filePath = `scanning:/file_${totalFiles - i}`;
        const fileSize = 1024 * (1 + Math.random() * 1000);

        const obj = this.dataMapper.createLiveObject(filePath, fileSize, totalFiles);
        if (obj) {
          obj.active = true;
          obj.liveSpawned = true;
          obj.birthTime = Date.now();
          obj._spawnProgress = 0; // Grow in over time
          if (this.gv.objects) this.gv.objects.push(obj);
        }
      }
    }

    _spawnMeteorShower() {
      if (!this.gv || !this.gv.effects) return;

      // Direction aligned with scan progress
      const baseX = (Math.random() - 0.5) * 400;
      const baseY = (Math.random() - 0.5) * 200;
      const startPos = [baseX, baseY, -400];
      const endPos = [baseX + (Math.random() - 0.5) * 100, baseY + (Math.random() - 0.5) * 50, 200];

      // Add multiple meteors for streak effect
      const meteorCount = Math.min(Math.floor(this.scanSpeed / 10) + 2, 10);
      for (let i = 0; i < meteorCount; i++) {
        this.gv.effects.addMeteor(
          [startPos[0] + (Math.random() - 0.5) * 20, startPos[1] + (Math.random() - 0.5) * 10, startPos[2]],
          [endPos[0] + (Math.random() - 0.5) * 20, endPos[1] + (Math.random() - 0.5) * 10, endPos[2]],
          [1, 0.7 + Math.random() * 0.3, 0.2],
          1500 + Math.random() * 1000,
        );
      }
    }

    _createStatsOverlay() {
      if (this.statsOverlay) return;

      this.statsOverlay = document.createElement("div");
      this.statsOverlay.className = "galaxy-scan-stats";
      this.statsOverlay.innerHTML = `
        <div class="scan-stat"><span class="scan-stat-icon">📄</span><span class="scan-stat-val" id="gscan-files">0</span><span>files</span></div>
        <div class="scan-stat"><span class="scan-stat-icon">📁</span><span class="scan-stat-val" id="gscan-dirs">0</span><span>dirs</span></div>
        <div class="scan-stat"><span class="scan-stat-icon">⚡</span><span class="scan-stat-val" id="gscan-speed">—</span><span>/s</span></div>
        <div class="scan-stat"><span class="scan-stat-icon">⏱</span><span class="scan-stat-val" id="gscan-elapsed">0s</span></div>
      `;

      if (this.gv && this.gv.container) {
        this.gv.container.appendChild(this.statsOverlay);
      }
    }

    _updateStatsOverlay(files, dirs, elapsed, running) {
      if (!this.statsOverlay) return;

      const fEl = document.getElementById("gscan-files");
      const dEl = document.getElementById("gscan-dirs");
      const sEl = document.getElementById("gscan-speed");
      const eEl = document.getElementById("gscan-elapsed");

      if (fEl) fEl.textContent = files.toLocaleString();
      if (dEl) dEl.textContent = dirs.toLocaleString();
      if (sEl) sEl.textContent = this.scanSpeed > 0 ? Math.round(this.scanSpeed).toLocaleString() : "—";
      if (eEl) eEl.textContent = Math.floor(elapsed) + "s";

      if (!running) {
        setTimeout(() => this._finish(), 500);
      }
    }

    _finish() {
      this.active = false;
      if (this.statsOverlay) {
        const completeMsg = document.createElement("div");
        completeMsg.className = "galaxy-scan-complete";
        completeMsg.textContent = "✓ Scan Complete";
        this.statsOverlay.appendChild(completeMsg);
        setTimeout(() => {
          if (this.statsOverlay) this.statsOverlay.remove();
          this.statsOverlay = null;
        }, 3000);
      }
      if (this.onComplete) this.onComplete();
    }

    stop() {
      this.active = false;
      if (this.statsOverlay) {
        this.statsOverlay.remove();
        this.statsOverlay = null;
      }
    }

    onScanComplete(callback) {
      this.onComplete = callback;
    }

    dispose() {
      this.stop();
      this.dataMapper = null;
      this.gv = null;
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.LiveScanEngine = LiveScanEngine;
})();
