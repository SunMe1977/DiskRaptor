/**
 * IconCache — Loads and caches real Windows shell icons via Tauri IPC.
 * Falls back to Unicode characters when backend is unavailable.
 */
class IconCache {
  constructor() {
    this.cache = new Map();        // key -> data URI (base64 PNG)
    this.pending = new Map();      // key -> [resolve, reject][]
    this._initBuiltin();
  }

  _initBuiltin() {
    // Fallback characters when backend icons aren't loaded yet
    this._fallback = {
      'folder': '\uD83D\uDCC1',
      'folder-open': '\uD83D\uDCC2',
      'file': '\uD83D\uDCC4',
      'exe': '\u2699\uFE0F',
      'iso': '\uD83D\uDCBF',
      'zip': '\uD83D\uDCE6',
      'pdf': '\uD83D\uDCC4',
      'image': '\uD83D\uDDBC\uFE0F',
      'video': '\uD83C\uDFA5',
      'audio': '\uD83C\uDFB5',
      'txt': '\uD83D\uDCDD',
    };
  }

  /**
   * Get an icon data URI for a file path.
   * @param {string} path - File path or extension key
   * @param {boolean} isDir - True if directory
   * @returns {Promise<string>} Data URI or fallback emoji
   */
  async getIcon(path, isDir) {
    const key = isDir ? '__folder__' : (path.split('.').pop() || 'file').toLowerCase();

    // Return cached
    if (this.cache.has(key)) return this.cache.get(key);

    // Check pending
    if (this.pending.has(key)) {
      return new Promise((resolve, reject) => {
        this.pending.get(key).push([resolve, reject]);
      });
    }

    // Load from backend
    const pending = [];
    this.pending.set(key, pending);

    try {
      const result = await this._loadIcon(path, isDir);
      pending.forEach(([r]) => r(result));
      return result;
    } catch (e) {
      const fallback = this._getFallback(key);
      pending.forEach(([_, rej]) => rej(e));
      return fallback;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Load icon from Tauri backend */
  async _loadIcon(path, isDir) {
    if (!window.__TAURI__ || !window.__TAURI__.invoke) throw new Error('No invoke');

    const base64 = await window.__TAURI__.invoke('get_icon', { path: path, isDir: isDir });
    if (!base64 || base64.length < 100) throw new Error('Invalid icon data');

    // Decode base64 to RGBA bytes
    const bytes = new Uint8Array(base64.length);
    for (let i = 0; i < base64.length; i++) {
      bytes[i] = base64.charCodeAt(i);
    }

    // Create canvas with the icon
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(16, 16);

    // Decode base64
    const binaryStr = atob(base64);
    const len = Math.min(binaryStr.length, 1024);
    for (let i = 0; i < len; i++) {
      imageData.data[i] = binaryStr.charCodeAt(i);
    }
    ctx.putImageData(imageData, 0, 0);

    const dataUri = canvas.toDataURL();
    this.cache.set(this._key(path, isDir), dataUri);
    return dataUri;
  }

  _key(path, isDir) {
    return isDir ? '__folder__' : (path.split('.').pop() || 'file').toLowerCase();
  }

  _getFallback(key) {
    if (key === '__folder__') return this._fallback['folder'];
    if (['exe', 'dll', 'msi'].includes(key)) return this._fallback['exe'];
    if (['iso', 'vhd', 'vhdx'].includes(key)) return this._fallback['iso'];
    if (['zip', 'rar', '7z', 'gz'].includes(key)) return this._fallback['zip'];
    if (['pdf'].includes(key)) return this._fallback['pdf'];
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp'].includes(key)) return this._fallback['image'];
    if (['mp4', 'avi', 'mkv', 'mov'].includes(key)) return this._fallback['video'];
    if (['mp3', 'wav', 'flac', 'ogg'].includes(key)) return this._fallback['audio'];
    if (['txt', 'log', 'md'].includes(key)) return this._fallback['txt'];
    return this._fallback['file'];
  }
}

// Global singleton
window.__ICON_CACHE__ = new IconCache();
