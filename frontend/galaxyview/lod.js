/**
 * DiskRaptor — GalaxyView LOD Manager
 * Level-of-detail clustering, object merging, progressive loading.
 * Ensures 60 FPS even with millions of indexed objects.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;

  class LODManager {
    constructor() {
      this.lodLevels = CFG.galaxy.lodDistances; // [near, mid, far, extreme]
      this.clusters = new Map();  // clusterKey -> { position, count, totalSize, objects }
      this.objectPool = [];
      this.poolSize = CFG.performance.objectPoolSize;
      this._initPool();
    }

    _initPool() {
      for (let i = 0; i < this.poolSize; i++) {
        this.objectPool.push({
          active: false,
          position: new Float32Array(3),
          scale: 1,
          color: new Float32Array(3),
          alpha: 1,
          type: null,
          data: null,
          lodLevel: 0,
        });
      }
    }

    allocate() {
      for (let i = 0; i < this.objectPool.length; i++) {
        if (!this.objectPool[i].active) {
          this.objectPool[i].active = true;
          return this.objectPool[i];
        }
      }
      // Pool exhausted - create new
      const obj = {
        active: true,
        position: new Float32Array(3),
        scale: 1,
        color: new Float32Array(3),
        alpha: 1,
        type: null,
        data: null,
        lodLevel: 0,
      };
      this.objectPool.push(obj);
      return obj;
    }

    release(obj) {
      obj.active = false;
      obj.data = null;
      obj.type = null;
    }

    /**
     * Build spatial clusters for dense regions.
     * Groups objects within clusterMergeRadius into cluster nodes.
     */
    buildClusters(objects, clusterRadius) {
      clusterRadius = clusterRadius || CFG.galaxy.clusterMergeRadius;
      this.clusters.clear();
      const threshold = CFG.galaxy.clusterThreshold;

      for (const obj of objects) {
        if (!obj || !obj.position) continue;
        const key = this._clusterKey(obj.position, clusterRadius);
        if (!this.clusters.has(key)) {
          this.clusters.set(key, {
            position: [obj.position[0], obj.position[1], obj.position[2]],
            count: 0,
            totalSize: 0,
            objects: [],
            avgColor: [0, 0, 0],
          });
        }
        const cluster = this.clusters.get(key);
        cluster.count++;
        cluster.totalSize += obj.size || 1;
        cluster.objects.push(obj);
      }

      // Compute average color per cluster
      for (const cluster of this.clusters.values()) {
        if (cluster.count > threshold) {
          let r = 0, g = 0, b = 0;
          for (const obj of cluster.objects) {
            if (obj.color) {
              r += obj.color[0] || 0.5;
              g += obj.color[1] || 0.5;
              b += obj.color[2] || 0.5;
            }
          }
          const n = cluster.objects.length || 1;
          cluster.avgColor = [r / n, g / n, b / n];
        }
      }
    }

    _clusterKey(position, radius) {
      const x = Math.round(position[0] / radius);
      const y = Math.round(position[1] / radius);
      const z = Math.round(position[2] / radius);
      return `${x},${y},${z}`;
    }

    /**
     * Compute LOD for an object based on camera distance.
     * Returns 0 (full detail) through 3 (lowest detail).
     */
    getLODLevel(objectPosition, cameraPosition) {
      if (!objectPosition) return 0;
      const dx = (objectPosition[0] || 0) - cameraPosition[0];
      const dy = (objectPosition[1] || 0) - cameraPosition[1];
      const dz = (objectPosition[2] || 0) - cameraPosition[2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      for (let i = 0; i < this.lodLevels.length; i++) {
        if (dist < this.lodLevels[i]) return i;
      }
      return this.lodLevels.length - 1;
    }

    /**
     * Filter visible objects by LOD and frustum.
     * Returns objects suitable for rendering this frame.
     */
    getVisibleObjects(allObjects, camera, frustumPlanes, maxVisible) {
      maxVisible = maxVisible || CFG.galaxy.maxVisibleObjects;
      const result = [];
      const clusters = this.clusters;

      for (const obj of allObjects) {
        if (!obj || !obj.active) continue;
        const lod = this.getLODLevel(obj.position, camera.position);

        // Skip objects beyond max LOD range
        if (lod >= this.lodLevels.length - 1 && obj.type !== 'star') continue;

        // Frustum culling
        if (frustumPlanes) {
          const r = obj.scale || 1;
          let visible = true;
          for (let p = 0; p < frustumPlanes.length; p++) {
            const plane = frustumPlanes[p];
            const dist = plane[0] * obj.position[0] +
                         plane[1] * obj.position[1] +
                         plane[2] * obj.position[2] +
                         plane[3];
            if (dist < -r) { visible = false; break; }
          }
          if (!visible) continue;
        }

        obj.lodLevel = lod;
        result.push(obj);

        if (result.length >= maxVisible) break;
      }

      // If we have room and clusters were built, add cluster nodes
      // for far-away dense regions instead of individual objects
      if (result.length < maxVisible * 0.7) {
        for (const [key, cluster] of clusters) {
          if (cluster.count > CFG.galaxy.clusterThreshold &&
              result.length < maxVisible) {
            const dist = Math.sqrt(
              Math.pow((cluster.position[0] || 0) - camera.position[0], 2) +
              Math.pow((cluster.position[1] || 0) - camera.position[1], 2) +
              Math.pow((cluster.position[2] || 0) - camera.position[2], 2)
            );
            if (dist > this.lodLevels[1]) {
              result.push({
                active: true,
                position: cluster.position,
                scale: Math.min(cluster.count / 50, 15),
                color: cluster.avgColor,
                alpha: 0.6,
                type: 'cluster',
                data: { count: cluster.count },
                lodLevel: 2,
              });
            }
          }
        }
      }

      return result;
    }

    /**
     * Merge tiny objects into larger particles below a size threshold.
     * Called for massive datasets (>500k objects).
     */
    mergeTinyObjects(objects, threshold) {
      threshold = threshold || 1.0;
      const keep = [];
      const merged = [];

      for (const obj of objects) {
        if ((obj.scale || 0) < threshold && obj.type !== 'star') {
          merged.push(obj);
        } else {
          keep.push(obj);
        }
      }

      if (merged.length > 1000) {
        // Create aggregate particle cloud
        const avgPos = [0, 0, 0];
        let avgColor = [0.4, 0.4, 0.6];
        let count = 0;
        for (const m of merged) {
          if (m.position) {
            avgPos[0] += m.position[0];
            avgPos[1] += m.position[1];
            avgPos[2] += m.position[2];
            count++;
          }
        }
        if (count > 0) {
          avgPos[0] /= count;
          avgPos[1] /= count;
          avgPos[2] /= count;
          keep.push({
            active: true,
            position: avgPos,
            scale: Math.min(merged.length / 100, 20),
            color: avgColor,
            alpha: 0.3,
            type: 'particleCloud',
            data: { mergedCount: merged.length },
            lodLevel: 3,
          });
        }
      }

      return keep;
    }

    /** Compute approximate object count from a stats object */
    estimateComplexity(stats) {
      let count = (stats.total_files || 0) + (stats.total_dirs || 0);
      // Adjust for clusters
      if (count > 500000) {
        const clusters = Math.floor(count / 500);
        count = Math.floor(count * 0.3 + clusters);
      }
      return Math.min(count, CFG.galaxy.maxVisibleObjects);
    }

    dispose() {
      this.clusters.clear();
      this.objectPool = [];
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.LODManager = LODManager;
})();
