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

  /** Live update during scan (partial data, no total_size yet). */
  updateLive(files, dirs, elapsedSecs) {
    if (this.filesEl)
      this.filesEl.textContent = this._fmtCount(files || 0);
    if (this.dirsEl)
      this.dirsEl.textContent = this._fmtCount(dirs || 0);
    if (elapsedSecs !== undefined && this.timeEl)
      this.timeEl.textContent = this._formatDuration(
        (elapsedSecs || 0) * 1000,
      );
  }

  /** Final update with complete scan stats from the backend. */
  render(stats) {
    if (!stats) {
      this.clear();
      return;
    }

    if (this.filesEl)
      this.filesEl.textContent = this._fmtCount(Number(stats.total_files || 0));
    if (this.dirsEl)
      this.dirsEl.textContent = this._fmtCount(Number(stats.total_dirs || 0));
    if (this.sizeEl)
      this.sizeEl.textContent = this._formatSize(stats.total_size || 0);
    if (this.timeEl)
      this.timeEl.textContent = this._formatDuration(stats.scan_time_ms || 0);
  }

  clear() {
    this.filesEl.textContent = "—";
    this.dirsEl.textContent = "—";
    this.sizeEl.textContent = "—";
    this.timeEl.textContent = "—";
  }

  _formatSize(bytes) {
    return window.fmtSize(bytes);
  }

  _fmtCount(n) {
    // Use the language the UI is currently displayed in (set by i18n.js) so
    // thousands separators match the selected locale instead of hard-coded
    // en-US ("1,234" vs. "1.234").
    const locale = (document.documentElement && document.documentElement.lang) || "en-US";
    try {
      return Number(n || 0).toLocaleString(locale);
    } catch (e) {
      return String(n || 0);
    }
  }

  _formatDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)} s`;
    const mins = Math.floor(ms / 60000);
    const secs = ((ms % 60000) / 1000).toFixed(1);
    return `${mins}m ${secs}s`;
  }
}
