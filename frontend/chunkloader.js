/**
 * ChunkLoader — Loads tree data from the Tauri backend in chunks.
 *
 * NOTE: Tauri v1 uses snake_case parameter names matching Rust function params.
 */
class ChunkLoader {
  constructor() {
    this.scanId = null;
    this.totalNodes = 0;
    this.totalChunks = 0;
    this.allNodes = [];
    this.parentMap = new Map();
    this.loadedChunks = new Set();
    this.loadedCount = 0;
    this.onProgress = null;
    this._scanResolve = null;
    this._scanReject = null;
  }

  /** Start a scan (async — returns promise that resolves when scan completes). */
  startScan(path) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self._scanResolve = resolve;
      self._scanReject = reject;
      self._doStartScan(path);
    });
  }

  /**
   * Continue with an already-started scan (scan ID known).
   * Polls for completion and loads chunks.
   */
  startScanWithId(scanId, path) {
    var self = this;
    return new Promise(function (resolve, reject) {
      self._scanResolve = resolve;
      self._scanReject = reject;
      self._pollScanComplete(scanId);
    });
  }

  /** Internal: poll for scan completion by scan ID. */
  async _pollScanComplete(scanId) {
    var self = this;

    // Release previous scan
    if (this.scanId) {
      try {
        await self._invoke("release_scan", { scanId: this.scanId });
      } catch (e) {}
    }
    // Save resolve/reject before _reset() clears them
    var savedResolve = this._scanResolve;
    var savedReject = this._scanReject;
    this._reset();
    this._scanResolve = savedResolve;
    this._scanReject = savedReject;
    this.scanId = scanId;

    try {
      // Poll for completion (max 100 iterations = ~30s safety)
      for (var pollIter = 0; pollIter < 100; pollIter++) {
        var prog = await self
          ._invoke("get_scan_progress", { scanId: scanId })
          .catch(function () {
            return null;
          });
        if (!prog) {
          continue;
        }
        if (prog && !prog.is_running && prog.phase !== 3) {
          throw new Error(prog.error || "Scan did not complete successfully.");
        }

        var result = await self
          ._invoke("get_scan_result", { scanId: scanId })
          .catch(function () {
            return null;
          });
        if (result) {
          // Scan finished
          self.totalNodes = result.root_info.total_nodes;
          self.totalChunks = result.root_info.total_chunks;
          self.allNodes = new Array(self.totalNodes);

          if (self.totalChunks > 0) {
            await self.loadChunk(0);
          }

          if (self._scanResolve) {
            self._scanResolve(result);
          }
          return;
        }
        await new Promise(function (r) {
          setTimeout(r, 300);
        });
      }
      // If we exhaust all iterations, reject
      if (self._scanReject)
        self._scanReject(new Error("Polling timed out (100 iterations)"));
    } catch (e) {
      if (self._scanReject) self._scanReject(e);
    }
  }

  /** Internal: start scan, poll for completion. */
  async _doStartScan(path) {
    var self = this;

    // Save resolve/reject before _reset() clears them
    var savedResolve = this._scanResolve;
    var savedReject = this._scanReject;

    if (this.scanId) {
      try {
        await self._invoke("release_scan", { scanId: this.scanId });
      } catch (e) {}
    }
    this._reset();

    // Restore resolve/reject after _reset()
    this._scanResolve = savedResolve;
    this._scanReject = savedReject;

    try {
      var initResult = await self._invoke("start_scan", { path: path });
      this.scanId = initResult.scan_id;
      await self._pollScanComplete(this.scanId);
    } catch (e) {
      if (self._scanReject) self._scanReject(e);
    }
  }

  /** Load all chunks from a scan result directly (fast path — no per-chunk FFI calls) */
  loadFromResult(result) {
    if (!result || !result.chunks) {
      console.warn("loadFromResult: no chunks in result");
      return;
    }

    var chunksArray;
    if (typeof result.chunks === "string") {
      try { chunksArray = JSON.parse(result.chunks); } catch(e) {
        console.warn("Failed to parse chunks JSON:", e);
        return;
      }
    } else if (Array.isArray(result.chunks)) {
      chunksArray = result.chunks;
    } else {
      console.warn("loadFromResult: unknown chunks type:", typeof result.chunks);
      return;
    }

    if (!Array.isArray(chunksArray) || chunksArray.length === 0) {
      console.warn("loadFromResult: empty or invalid chunks array");
      return;
    }

    this.scanId = result.scan_id || this.scanId;
    this.totalChunks = chunksArray.length;
    this.loadedChunks = new Set();
    this.parentMap = new Map();

    // First pass: count total nodes
    var totalNodes = 0;
    if (result.root_info && result.root_info.total_nodes) {
      totalNodes = result.root_info.total_nodes;
    } else {
      for (var ci = 0; ci < chunksArray.length; ci++) {
        totalNodes += (chunksArray[ci].nodes || []).length;
      }
    }
    this.totalNodes = totalNodes;
    this.allNodes = new Array(totalNodes);

    // Second pass: populate all nodes and parent map
    var nodeIdx = 0;
    for (var ci = 0; ci < chunksArray.length; ci++) {
      var chunk = chunksArray[ci];
      if (!chunk || !chunk.nodes) continue;
      for (var ni = 0; ni < chunk.nodes.length; ni++) {
        var node = chunk.nodes[ni];
        if (!node) continue;
        node._arenaIndex = nodeIdx;
        node._children = [];
        node._loadedChildren = false;
        this.allNodes[nodeIdx] = node;

        if (node.parent !== 4294967295 && node.parent !== undefined) {
          if (!this.parentMap.has(node.parent)) {
            this.parentMap.set(node.parent, []);
          }
          this.parentMap.get(node.parent).push(nodeIdx);
        }
        nodeIdx++;
      }
      this.loadedChunks.add(ci);
    }
    this.loadedCount = nodeIdx;

    // Sort children by size (largest first)
    var self = this;
    var entries = Array.from(this.parentMap.entries());
    for (var ei = 0; ei < entries.length; ei++) {
      var children = entries[ei][1];
      children.sort(function (a, b) {
        var na = self.allNodes[a];
        var nb = self.allNodes[b];
        return (nb ? nb.size : 0) - (na ? na.size : 0);
      });
    }

    if (this.onProgress) {
      this.onProgress(this.loadedChunks.size, this.totalChunks);
    }
  }

  async loadChunk(chunkIndex) {
    if (this.loadedChunks.has(chunkIndex)) return;

    var self = this;
    var chunk = await this._invoke("get_chunk", {
      scanId: this.scanId,
      chunkIndex: chunkIndex,
    });

    var baseIdx = chunkIndex * 10000;
    for (var i = 0; i < chunk.nodes.length; i++) {
      var arenaIdx = baseIdx + i;
      var node = chunk.nodes[i];
      node._arenaIndex = arenaIdx;
      node._children = [];
      node._loadedChildren = false;
      this.allNodes[arenaIdx] = node;

      if (node.parent !== 4294967295) {
        if (!this.parentMap.has(node.parent)) {
          this.parentMap.set(node.parent, []);
        }
        this.parentMap.get(node.parent).push(arenaIdx);
      }
    }

    this.loadedChunks.add(chunkIndex);
    this.loadedCount += chunk.nodes.length;

    var _self = this;
    var entries = Array.from(this.parentMap.entries());
    for (var ei = 0; ei < entries.length; ei++) {
      var children = entries[ei][1];
      children.sort(function (a, b) {
        var na = _self.allNodes[a];
        var nb = _self.allNodes[b];
        return (nb ? nb.size : 0) - (na ? na.size : 0);
      });
    }

    if (this.onProgress) {
      this.onProgress(this.loadedChunks.size, this.totalChunks);
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
    var cached = this.getChildrenIndices(arenaIndex);
    if (cached && cached.length > 0) {
      return cached;
    }
    // Fallback to backend (useful when chunks not yet loaded)
    var result = await this._invoke("get_children", {
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
    var promises = [];
    for (var i = startChunk; i < endChunk && i < this.totalChunks; i++) {
      if (!this.loadedChunks.has(i)) {
        promises.push(this.loadChunk(i));
      }
    }
    await Promise.all(promises);
  }

  async getStats() {
    return this._invoke("get_stats", { scanId: this.scanId });
  }

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
    this._scanResolve = null;
    this._scanReject = null;
  }
}
