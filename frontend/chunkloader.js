/**
 * ChunkLoader — Loads tree data from the Tauri backend in chunks.
 *
 * NOTE: Tauri v1 uses snake_case parameter names matching Rust function params.
 */
class ChunkLoader {
  /**
   * Create a new ChunkLoader for loading tree data from the Tauri backend.
   */
  constructor() {
    this.scanId = null;
    this.totalNodes = 0;
    this.totalChunks = 0;
    this.allNodes = [];
    this.parentMap = new Map();
    this.loadedChunks = new Set();
    this.loadedCount = 0;
    this.onProgress = null;
  }

  /**
   * Reset state for a new scan's tree. CRITICAL: clears loadedChunks/parentMap
   * so a previous scan's chunk indices can't leak into the new tree (which
   * caused empty trees after switching scans).
   */
  prepare(totalNodes, totalChunks, scanId) {
    this.scanId = scanId;
    this.totalNodes = totalNodes;
    this.totalChunks = totalChunks;
    // Lazily grown instead of `new Array(totalNodes)` — pre-allocating a
    // 20M-element array for huge scans spikes memory before any chunk loads.
    this.allNodes = [];
    this.loadedChunks = new Set();
    this.parentMap = new Map();
    this.loadedCount = 0;
  }

  /**
   * Load a single chunk of nodes from the backend.
   * @param {number} chunkIndex - The chunk index to load
   */
  async loadChunk(chunkIndex) {
    if (this.loadedChunks.has(chunkIndex)) return;
    if (chunkIndex < 0 || chunkIndex >= this.totalChunks) {
      console.warn("loadChunk: index out of range", chunkIndex, "total", this.totalChunks);
      return;
    }

    const chunk = await this._invoke("get_chunk", {
      scanId: this.scanId,
      chunkIndex: chunkIndex,
    });
    if (!chunk || !Array.isArray(chunk.nodes)) {
      console.warn("loadChunk: invalid chunk payload for", chunkIndex);
      return;
    }

    const baseIdx =
      typeof chunk.start_index === "number"
        ? chunk.start_index
        : chunkIndex * 10000;
    const touchedParents = new Set();
    for (let i = 0; i < chunk.nodes.length; i++) {
      const arenaIdx = baseIdx + i;
      if (arenaIdx >= this.totalNodes) {
        console.warn("loadChunk: arena index out of bounds", arenaIdx, "totalNodes", this.totalNodes);
        break;
      }
      const node = chunk.nodes[i];
      node._arenaIndex = arenaIdx;
      node._children = [];
      node._loadedChildren = false;
      this.allNodes[arenaIdx] = node;

      if (node.parent !== 4294967295) {
        if (!this.parentMap.has(node.parent)) {
          this.parentMap.set(node.parent, []);
        }
        this.parentMap.get(node.parent).push(arenaIdx);
        touchedParents.add(node.parent);
      }
    }

    this.loadedChunks.add(chunkIndex);
    this.loadedCount += chunk.nodes.length;

    // Only re-sort the parent lists that actually gained children this round
    // (avoids an O(all_nodes log n) sort on every chunk load).
    const _self = this;
    const entries = Array.from(touchedParents);
    for (let ei = 0; ei < entries.length; ei++) {
      const children = this.parentMap.get(entries[ei]) || [];
      children.sort(function (a, b) {
        const na = _self.allNodes[a];
        const nb = _self.allNodes[b];
        return (nb ? nb.size : 0) - (na ? na.size : 0);
      });
    }

    if (this.onProgress) {
      this.onProgress(this.loadedChunks.size, this.totalChunks);
    }
  }

  /** Pre-load all remaining chunks in parallel batches of 20 */
  _preloadRemainingChunks() {
    const BATCH_SIZE = 20;
    let start = 1; // chunk 0 already loaded
    const self = this;

    function loadBatch() {
      const end = Math.min(start + BATCH_SIZE, self.totalChunks);
      const promises = [];
      for (let i = start; i < end; i++) {
        if (!self.loadedChunks.has(i)) {
          promises.push(self.loadChunk(i));
        }
      }
      if (promises.length > 0) {
        Promise.all(promises).then(function() {
          start = end;
          if (start < self.totalChunks) {
            // Yield to event loop between batches
            setTimeout(loadBatch, 5);
          }
        }).catch(function() {
          start = end;
          if (start < self.totalChunks) {
            setTimeout(loadBatch, 5);
          }
        });
      }
    }
    // Start loading batches asynchronously
    if (start < this.totalChunks) {
      setTimeout(loadBatch, 10);
    }
  }

  getNode(arenaIndex) {
    return this.allNodes[arenaIndex] || null;
  }

  getChildrenIndices(arenaIndex) {
    return this.parentMap.get(arenaIndex) || [];
  }

  async fetchChildren(arenaIndex) {
    if (arenaIndex === 4294967295) return [];
    // Use the locally-built parentMap first (populated by loadChunk)
    const cached = this.getChildrenIndices(arenaIndex);
    if (cached && cached.length > 0) {
      return cached;
    }
    // Fallback to backend (useful when chunks not yet loaded)
    const result = await this._invoke("get_children", {
      scanId: this.scanId,
      nodeIndex: arenaIndex,
    });
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.children)) {
      return result.children;
    }
    return [];
  }

  async ensureChunks(startChunk, endChunk) {
    const promises = [];
    for (let i = startChunk; i < endChunk && i < this.totalChunks; i++) {
      if (!this.loadedChunks.has(i)) {
        promises.push(this.loadChunk(i));
      }
    }
    await Promise.all(promises);
  }

  async getStats() {
    return this._invoke("get_stats", { scanId: this.scanId });
  }

  /**
   * Release the current scan and reset the loader state.
   */
  async release() {
    if (this.scanId) {
      await this._invoke("release_scan", { scanId: this.scanId });
    }
    this._reset();
  }

  async _invoke(cmd, args) {
    try {
      return await window.__TAURI__.invoke(cmd, args);
    } catch (err) {
      console.error("Tauri invoke error (" + cmd + "):", err);
      throw err;
    }
  }

  _reset() {
    this.scanId = null;
    this.totalNodes = 0;
    this.totalChunks = 0;
    this.allNodes = [];
    this.parentMap = new Map();
    this.loadedChunks = new Set();
    this.loadedCount = 0;
  }
}
