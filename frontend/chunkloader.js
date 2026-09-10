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
    this.nameIndex = new Map();
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
    this.nameIndex = new Map();
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

    const nodes = this.allNodes;
    const chunk = await this._invoke("get_chunk", {
      scanId: this.scanId,
      chunkIndex: chunkIndex,
    });
    if (this.allNodes !== nodes) return;
    if (!chunk || !Array.isArray(chunk.nodes)) {
      console.warn("loadChunk: invalid chunk payload for", chunkIndex);
      return;
    }

    const baseIdx =
      typeof chunk.start_index === "number"
        ? chunk.start_index
        : chunkIndex * 10000;
    for (let i = 0; i < chunk.nodes.length; i++) {
      const arenaIdx = baseIdx + i;
      if (arenaIdx >= this.totalNodes) {
        console.warn("loadChunk: arena index out of bounds", arenaIdx, "totalNodes", this.totalNodes);
        break;
      }
      const node = chunk.nodes[i];
      node._arenaIndex = arenaIdx;
      this.allNodes[arenaIdx] = node;

      // Name index (lowercase name -> arena indices) so node lookups by name
      // never need a linear scan over allNodes.
      const key = (node.name || "").toLowerCase();
      let idxs = this.nameIndex.get(key);
      if (!idxs) {
        idxs = [];
        this.nameIndex.set(key, idxs);
      }
      idxs.push(arenaIdx);

      if (node.parent !== 4294967295) {
        if (!this.parentMap.has(node.parent)) {
          this.parentMap.set(node.parent, []);
        }
        this.parentMap.get(node.parent).push(arenaIdx);
      }
    }

    this.loadedChunks.add(chunkIndex);
    this.loadedCount += chunk.nodes.length;

    if (this.onProgress) {
      this.onProgress(this.loadedChunks.size, this.totalChunks);
    }
  }

   /**
    * Get a node by its arena index.
    * @param {number} arenaIndex - The arena index
    * @returns {Object|null} The node, or null if not found
    */
  getNode(arenaIndex) {
    return this.allNodes[arenaIndex] || null;
  }

  /** Store a node at its stable backend arena identity. */
  storeNode(node, arenaIndex) {
    if (!node || !Number.isInteger(arenaIndex) || arenaIndex < 0 || arenaIndex >= this.totalNodes) return null;
    node._arenaIndex = arenaIndex;
    this.allNodes[arenaIndex] = node;
    if (node.parent !== 4294967295) {
      let children = this.parentMap.get(node.parent);
      if (!children) {
        children = [];
        this.parentMap.set(node.parent, children);
      }
      if (children.indexOf(arenaIndex) === -1) children.push(arenaIndex);
    }
    return arenaIndex;
  }

  /**
    * Arena indices of all loaded nodes with the given (case-insensitive) name.
    * @param {string} name - The name to look up (case-insensitive)
    * @returns {number[]} Array of arena indices
    */
   getNodesByName(name) {
    return this.nameIndex.get(String(name || "").toLowerCase()) || [];
  }

   /**
    * Get child arena indices for a node.
    * @param {number} arenaIndex - The parent node's arena index
    * @returns {number[]} Array of child arena indices
    */
   getChildrenIndices(arenaIndex) {
    return this.parentMap.get(arenaIndex) || [];
  }

   /**
    * Fetch children of a node, using the local parentMap cache first,
    * falling back to the backend if not cached.
    * @param {number} arenaIndex - The parent node's arena index
    * @returns {Promise<Array>} Array of child node indices or objects
    */
   async fetchChildren(arenaIndex) {
    if (arenaIndex === 4294967295) return [];
    // Use the locally-built parentMap first (populated by loadChunk)
    const cached = this.getChildrenIndices(arenaIndex);
    if (cached && cached.length > 0) {
      return cached;
    }
    // Fallback to backend (useful when chunks not yet loaded)
    const nodes = this.allNodes;
    const result = await this._invoke("get_children", {
      scanId: this.scanId,
      nodeIndex: arenaIndex,
    });
    if (this.allNodes !== nodes) return [];
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.children)) {
      return result.children;
    }
    return [];
  }

  /**
    * Always fetch a node's children straight from the backend and return them
    * as full node objects. Unlike `fetchChildren` this never short-circuits on
    * a partially-populated parentMap, so callers (e.g. "jump in tree") can
    * resolve a deep path even when the relevant chunks were never loaded.
    * @param {number} arenaIndex - The parent node's arena index
    * @returns {Promise<Array>} Array of child node objects
    */
   async fetchChildrenBackend(arenaIndex) {
    if (arenaIndex === 4294967295) return [];
    const nodes = this.allNodes;
    const result = await this._invoke("get_children", {
      scanId: this.scanId,
      nodeIndex: arenaIndex,
    });
    if (this.allNodes !== nodes) return [];
    if (Array.isArray(result)) {
      return result;
    }
    if (result && Array.isArray(result.children)) {
      return result.children;
    }
    return [];
  }

   /**
    * Load a range of chunks concurrently.
    * @param {number} startChunk - The first chunk index to load
    * @param {number} endChunk - One past the last chunk index to load
    * @returns {Promise<void>}
    */
   async ensureChunks(startChunk, endChunk) {
    const promises = [];
    for (let i = startChunk; i < endChunk && i < this.totalChunks; i++) {
      if (!this.loadedChunks.has(i)) {
        promises.push(this.loadChunk(i));
      }
    }
    await Promise.all(promises);
  }

   /**
    * Get scan statistics from the backend.
    * @returns {Promise<Object>} Stats object
    */
   async getStats() {
    return this._invoke("get_stats", { scanId: this.scanId });
  }

  /**
   * Release the current scan and reset the loader state.
   * @returns {Promise<void>}
   */
  async release() {
    const scanId = this.scanId;
    this._reset();
    if (scanId) {
      await this._invoke("release_scan", { scanId: scanId });
    }
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
    this.nameIndex = new Map();
    this.loadedChunks = new Set();
    this.loadedCount = 0;
  }
}
