/**
 * Shared human-readable size / speed formatting.
 * Kept in one place so every module uses identical output
 * (mirrors the Rust `format_size` helper in scanner/tree.rs).
 */
(function () {
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

  window.fmtSize = fmtSize;
  window.fmtSpeed = fmtSpeed;
})();
