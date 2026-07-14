/**
 * DiskRaptor — GalaxyView Spatial Index (Octree)
 * Thread-safe spatial partitioning for millions of objects.
 * Used for frustum culling, collision detection, and LOD clustering.
 */
(function () {
  "use strict";

  const CFG = window.GalaxyViewConfig;
  const MAX_OBJECTS = 8;
  const MAX_DEPTH = 12;

  class OctreeNode {
    constructor(center, halfSize, depth) {
      this.center = center;    // [x, y, z]
      this.halfSize = halfSize;
      this.depth = depth || 0;
      this.objects = [];
      this.children = null;
    }

    getChildIndex(point) {
      let index = 0;
      if (point[0] >= this.center[0]) index |= 1;
      if (point[1] >= this.center[1]) index |= 2;
      if (point[2] >= this.center[2]) index |= 4;
      return index;
    }

    subdivide() {
      const h = this.halfSize / 2;
      const c = this.center;
      this.children = [];
      for (let i = 0; i < 8; i++) {
        const offset = [
          (i & 1) ? h : -h,
          (i & 2) ? h : -h,
          (i & 4) ? h : -h,
        ];
        this.children.push(new OctreeNode(
          [c[0] + offset[0], c[1] + offset[1], c[2] + offset[2]],
          h, this.depth + 1
        ));
      }
      // Redistribute
      for (const obj of this.objects) {
        const idx = this.getChildIndex(obj.position);
        this.children[idx].objects.push(obj);
      }
      this.objects = [];
    }

    insert(obj, depth) {
      depth = depth || 0;
      if (this.children) {
        const idx = this.getChildIndex(obj.position);
        this.children[idx].insert(obj, depth + 1);
        return;
      }
      this.objects.push(obj);
      if (this.objects.length > MAX_OBJECTS && depth < MAX_DEPTH) {
        this.subdivide();
      }
    }

    queryRange(min, max, results) {
      results = results || [];
      // Check if this node overlaps the query range
      if (max[0] < this.center[0] - this.halfSize ||
          min[0] > this.center[0] + this.halfSize ||
          max[1] < this.center[1] - this.halfSize ||
          min[1] > this.center[1] + this.halfSize ||
          max[2] < this.center[2] - this.halfSize ||
          min[2] > this.center[2] + this.halfSize) {
        return results;
      }

      if (this.children) {
        for (const child of this.children) {
          child.queryRange(min, max, results);
        }
      } else {
        for (const obj of this.objects) {
          results.push(obj);
        }
      }
      return results;
    }

    /** Frustum culling: returns objects within frustum planes */
    queryFrustum(planes, results) {
      results = results || [];
      // Sphere-frustum check using node bounding sphere
      const sphereRadius = this.halfSize * 1.732; // sqrt(3)
      for (const plane of planes) {
        const dist = plane[0] * this.center[0] +
                     plane[1] * this.center[1] +
                     plane[2] * this.center[2] +
                     plane[3];
        if (dist < -sphereRadius) return results; // Outside
      }

      if (this.children) {
        for (const child of this.children) {
          child.queryFrustum(planes, results);
        }
      } else {
        for (const obj of this.objects) {
          results.push(obj);
        }
      }
      return results;
    }

    clear() {
      this.objects = [];
      this.children = null;
    }

    getStats() {
      let objCount = this.objects.length;
      let nodeCount = 1;
      if (this.children) {
        for (const child of this.children) {
          const s = child.getStats();
          objCount += s.objects;
          nodeCount += s.nodes;
        }
      }
      return { objects: objCount, nodes: nodeCount };
    }
  }

  class SpatialIndex {
    constructor(worldSize) {
      worldSize = worldSize || 10000;
      this.root = new OctreeNode([0, 0, 0], worldSize, 0);
      this.size = worldSize;
      this.objectCount = 0;
    }

    insert(obj) {
      this.root.insert(obj);
      this.objectCount++;
    }

    queryRange(min, max) {
      return this.root.queryRange(min, max);
    }

    queryFrustum(planes) {
      return this.root.queryFrustum(planes);
    }

    /** Find objects within radius of a point */
    queryRadius(point, radius, results) {
      results = results || [];
      const min = [point[0] - radius, point[1] - radius, point[2] - radius];
      const max = [point[0] + radius, point[1] + radius, point[2] + radius];
      const candidates = this.queryRange(min, max);
      const r2 = radius * radius;
      for (const c of candidates) {
        const dx = c.position[0] - point[0];
        const dy = c.position[1] - point[1];
        const dz = c.position[2] - point[2];
        if (dx * dx + dy * dy + dz * dz <= r2) {
          results.push(c);
        }
      }
      return results;
    }

    clear() {
      this.root.clear();
      this.objectCount = 0;
      this.root = new OctreeNode([0, 0, 0], this.size, 0);
    }

    getStats() {
      return this.root.getStats();
    }
  }

  window.GalaxyView = window.GalaxyView || {};
  window.GalaxyView.SpatialIndex = SpatialIndex;
  window.GalaxyView.OctreeNode = OctreeNode;
})();
