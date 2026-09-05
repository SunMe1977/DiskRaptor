/**
 * StatsPanel — Renders scan summary statistics.
 */
class StatsPanel {
  constructor() {
    this.filesEl = document.getElementById("stat-files");
    this.dirsEl = document.getElementById("stat-dirs");
    this.sizeEl = document.getElementById("stat-size");
    this.timeEl = document.getElementById("stat-time");
    this.wrap = null; // lazily created insights container
    this.insights = null;
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

    this._renderInsights(stats.insights || null);
  }

  clear() {
    this.filesEl.textContent = "—";
    this.dirsEl.textContent = "—";
    this.sizeEl.textContent = "—";
    this.timeEl.textContent = "—";
    this._renderInsights(null);
  }

  // ── Plain-language "Klartext" summary (#4) ───────────────────────────────
  // Backend supplies `insights`: largest directories with %, and a file-age
  // distribution. Rendered as human sentences + jump buttons into the tree.

  _renderInsights(insights) {
    if (!this.wrap) {
      const content = document.getElementById("stats-content");
      if (!content) return;
      this.wrap = document.createElement("div");
      this.wrap.id = "insights-wrap";
      this.wrap.style.cssText =
        "margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light);font-size:12px;line-height:1.5;" +
        "max-height:220px;overflow-y:auto;overscroll-behavior:contain;";
      content.appendChild(this.wrap);
    }
    const t = window.__ || function (s) { return s; };
    const topDirs = (insights && insights.top_dirs) || [];
    const ages = (insights && insights.ages) || [];
    const old = (insights && insights.old_files) || { count: 0, size: 0 };

    let html = "";
    if (topDirs.length > 0) {
      html +=
        '<div style="margin-bottom:6px;font-weight:600;color:var(--text-secondary);">' +
        (t("insights.top_dirs") || "Where is the space?") +
        "</div>";
      for (let i = 0; i < topDirs.length && i < 5; i++) {
        const d = topDirs[i];
        html +=
          '<button type="button" class="insight-dir" data-path="' +
          this._esc(d.path) +
          '" style="display:flex;align-items:center;gap:6px;width:100%;padding:3px 4px;margin:2px 0;border:0;background:transparent;border-radius:4px;cursor:pointer;color:var(--text-primary);text-align:left;font-size:12px;">' +
          '<span style="flex:0 0 8px;width:8px;height:8px;border-radius:2px;background:var(--accent-green);opacity:0.85;"></span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          this._esc(d.name) +
          "</span>" +
          '<span style="font-weight:600;">' +
          this._fmtCount(d.pct || 0) +
          "%</span>" +
          '<span style="color:var(--text-muted);">' +
          this._esc(d.size_human || window.fmtSize(d.size || 0)) +
          "</span></button>";
      }
    }

    const showOld =
      insights &&
      (Number(old.count) > 0) &&
      !(ages.length === 0 && !Number(old.count));
    if (showOld) {
      html +=
        '<div style="margin-top:8px;display:flex;gap:6px;align-items:flex-start;">' +
        '<span style="flex:0 0 auto;">🗄️</span>' +
        '<span>' +
        this._esc(
          (t("insights.old_files") || "{count} files older than 1 year ({size})")
            .replace("{count}", this._fmtCount(old.count))
            .replace("{size}", window.fmtSize(old.size || 0)),
        ) +
        "</span></div>";
    }

    if (ages.length > 0) {
      const labelOf = (key) => {
        switch (key) {
          case "lt_1m": return t("insights.age_lt_1m") || "< 1 month";
          case "1m_6m": return t("insights.age_1m_6m") || "1–6 months";
          case "6m_12m": return t("insights.age_6m_12m") || "6–12 months";
          case "gt_1y": return t("insights.age_gt_1y") || "> 1 year";
          default: return t("insights.age_unknown") || "unknown age";
        }
      };
      html +=
        '<div style="margin-top:10px;margin-bottom:4px;font-weight:600;color:var(--text-secondary);">' +
        (t("insights.age_title") || "Files by age") +
        "</div>";
      for (const b of ages) {
        if (!b || Number(b.size) <= 0) continue;
        const pct = Math.max(2, Math.min(100, Number(b.pct) || 0));
        html +=
          '<div style="margin:3px 0;font-size:11px;">' +
          '<div style="display:flex;justify-content:space-between;">' +
          "<span>" + this._esc(labelOf(b.key)) + "</span>" +
          '<span style="color:var(--text-muted);">' +
          this._esc(window.fmtSize(b.size || 0)) +
          " · " +
          this._fmtCount(b.count) +
          " files</span></div>" +
          '<div style="height:5px;border-radius:3px;background:var(--bg-tertiary);overflow:hidden;margin-top:2px;">' +
          '<div style="height:100%;width:' + pct + "%;background:var(--accent-orange);opacity:0.9;border-radius:3px;\"></div></div></div>";
      }
    }

    this.wrap.innerHTML = html;
    if (topDirs.length > 0) {
      this.wrap.querySelectorAll(".insight-dir").forEach((btn) => {
        btn.addEventListener("click", function () {
          const p = btn.getAttribute("data-path");
          if (!p) return;
          window.dispatchEvent(
            new CustomEvent("diagram-jump-to-path", { detail: { path: p } }),
          );
        });
      });
    }
  }

  _esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
