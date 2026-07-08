/**
 * IconCache — Loads and caches real Windows shell icons via Tauri IPC.
 * Falls back to Unicode characters when backend is unavailable.
 */
class IconCache {
  constructor() {
    this.cache = new Map();
    this.pending = new Map();
    this._initBuiltin();
  }

  _initBuiltin() {
    this._fallback = {
      folder: "\uD83D\uDCC1",
      "folder-open": "\uD83D\uDCC2",
      file: "\uD83D\uDCC4",
      exe: "\u2699\uFE0F",
      iso: "\uD83D\uDCBF",
      zip: "\uD83D\uDCE6",
      pdf: "\uD83D\uDCC4",
      image: "\uD83D\uDDBC\uFE0F",
      video: "\uD83C\uDFA5",
      audio: "\uD83C\uDFB5",
      txt: "\uD83D\uDCDD",
    };
  }

  async getIcon(path, isDir) {
    var key = isDir
      ? "__folder__"
      : (path.split(".").pop() || "file").toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);

    if (this.pending.has(key)) {
      return new Promise(
        function (resolve, reject) {
          this.pending.get(key).push([resolve, reject]);
        }.bind(this),
      );
    }

    var pending = [];
    this.pending.set(key, pending);

    try {
      var result = await this._loadIcon(path, isDir);
      pending.forEach(function (r) {
        r[0](result);
      });
      return result;
    } catch (e) {
      console.warn("IconCache: failed for", key, e.message || e);
      var fallback = this._getFallback(key);
      // Resolve with fallback so callers get something
      pending.forEach(function (r) {
        r[0](fallback);
      });
      return fallback;
    } finally {
      this.pending.delete(key);
    }
  }

  async _loadIcon(path, isDir) {
    if (!window.__TAURI__ || !window.__TAURI__.invoke)
      throw new Error("No invoke");

    var base64 = await window.__TAURI__.invoke("get_icon", {
      path: path,
      isDir: isDir,
    });
    if (!base64 || base64.length < 100)
      throw new Error(
        "Invalid icon data (" + (base64 || "").length + " bytes)",
      );

    // Decode base64 to RGBA pixel data
    var binaryStr = atob(base64);
    var len = Math.min(binaryStr.length, 1024); // 16*16*4 = 1024

    // Create canvas and draw icon
    var canvas = document.createElement("canvas");
    canvas.width = 16;
    canvas.height = 16;
    var ctx = canvas.getContext("2d");
    var imageData = ctx.createImageData(16, 16);

    for (var i = 0; i < len; i++) {
      imageData.data[i] = binaryStr.charCodeAt(i);
    }
    ctx.putImageData(imageData, 0, 0);

    var dataUri = canvas.toDataURL();
    var key = isDir
      ? "__folder__"
      : (path.split(".").pop() || "file").toLowerCase();
    this.cache.set(key, dataUri);
    console.log("IconCache: cached", key, "(" + dataUri.length + " bytes)");
    return dataUri;
  }

  _getFallback(key) {
    if (key === "__folder__") return this._fallback["folder"];
    if (["exe", "dll", "msi"].indexOf(key) >= 0) return this._fallback["exe"];
    if (["iso", "vhd", "vhdx"].indexOf(key) >= 0) return this._fallback["iso"];
    if (["zip", "rar", "7z", "gz"].indexOf(key) >= 0)
      return this._fallback["zip"];
    if (["pdf"].indexOf(key) >= 0) return this._fallback["pdf"];
    if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].indexOf(key) >= 0)
      return this._fallback["image"];
    if (["mp4", "avi", "mkv", "mov", "wmv"].indexOf(key) >= 0)
      return this._fallback["video"];
    if (["mp3", "wav", "flac", "ogg", "aac"].indexOf(key) >= 0)
      return this._fallback["audio"];
    if (
      ["txt", "log", "md", "csv", "json", "xml", "yml", "yaml"].indexOf(key) >=
      0
    )
      return this._fallback["txt"];
    return this._fallback["file"];
  }
}

window.__ICON_CACHE__ = new IconCache();
console.log("IconCache initialized");
