/**
 * StatsPanel — Renders scan summary statistics.
 */
class StatsPanel {
  constructor() {
    this.filesEl = document.getElementById("stat-files");
    this.dirsEl = document.getElementById("stat-dirs");
    this.sizeEl = document.getElementById("stat-size");
    this.timeEl = document.getElementById("stat-time");
  }

  /** Update with scan stats from the backend. */
  render(stats) {
    if (!stats) {
      this.clear();
      return;
    }

    this.filesEl.textContent = Number(stats.total_files || 0).toLocaleString(
      "en-US",
    );
    this.dirsEl.textContent = Number(stats.total_dirs || 0).toLocaleString(
      "en-US",
    );
    this.sizeEl.textContent = this._formatSize(stats.total_size || 0);
    this.timeEl.textContent = this._formatDuration(stats.scan_time_ms || 0);
  }

  clear() {
    this.filesEl.textContent = "—";
    this.dirsEl.textContent = "—";
    this.sizeEl.textContent = "—";
    this.timeEl.textContent = "—";
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return i === 0 ? `${bytes} B` : `${val.toFixed(2)} ${units[i]}`;
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(1);
    return `${mins}m ${secs}s`;
  }
}
