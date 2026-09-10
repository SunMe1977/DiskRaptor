/**
 * Shared human-readable size / speed formatting.
 * Kept in one place so every module uses identical output
 * (mirrors the Rust `format_size` helper in scanner/tree.rs).
 */
(function () {
  // Guarantee the i18n translator exists early so modules never have to guard
  // with `window.__ || function(s){return s;}`.
  if (typeof window.__ !== "function") {
    window.__ = function (s) { return s; };
  }

  /**
   * Format a byte count as a human-readable size string.
   * @param {number} bytes - The byte count
   * @returns {string} Formatted size string (e.g. "1.50 MB")
   */
  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const v = bytes / Math.pow(1024, i);
    return i === 0 ? Math.round(bytes) + " B" : v.toFixed(2) + " " + units[i];
  }

  /**
   * Format a bytes-per-second rate as a human-readable speed string.
   * @param {number} bps - The bytes-per-second rate
   * @returns {string} Formatted speed string (e.g. "1.50 MB/s")
   */
  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return "0 B/s";
    const units = ["B/s", "KB/s", "MB/s", "GB/s"];
    const i = Math.min(
      Math.floor(Math.log(bps) / Math.log(1024)),
      units.length - 1,
    );
    const v = bps / Math.pow(1024, i);
    return v.toFixed(v < 10 ? 2 : 1) + " " + units[i];
  }

  // Shared debounce for search/filter inputs — avoids re-running the whole
  // render on every keystroke.
  /**
   * Create a debounced version of a function.
   * @param {function} fn - The function to debounce
   * @param {number} ms - The debounce delay in milliseconds
   * @returns {function} The debounced function
   */
  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(this, args);
      }, ms || 150);
    };
  }

  // Shared HTML-escaping (was duplicated in several modules).
  /**
   * Escape HTML special characters in a string.
   * @param {string} s - The input string
   * @returns {string} The escaped string
   */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  window.fmtSize = fmtSize;
  window.fmtSpeed = fmtSpeed;
  window.debounce = debounce;
  window.escHtml = escHtml;
})();
