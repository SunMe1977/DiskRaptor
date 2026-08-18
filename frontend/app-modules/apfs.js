/**
 * DiskRaptor — APFS Snapshots & Purgeable Space (macOS).
 *
 * Shows per-volume purgeable space and Time-Machine / APFS snapshots — the
 * invisible reserves a normal scan can never see (and often the real cause of
 * "Other" in the macOS Storage settings). Deleting local Time-Machine
 * snapshots is permanent, so it goes through a guarded confirm dialog.
 */
(function () {
  "use strict";

  function fmtSize(bytes) {
    if (bytes == null) return "\u2014";
    return window.fmtSize ? window.fmtSize(bytes) : String(bytes);
  }

  function fmtDate(raw) {
    if (!raw) return "";
    // com.apple.TimeMachine.YYYY-MM-DD-HHMMSS -> readable local date
    const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(String(raw));
    if (m) {
      try {
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).toLocaleString();
      } catch (e) { /* fall through */ }
    }
    return String(raw);
  }

  function esc(s) {
    return window.escHtml ? window.escHtml(s) : String(s);
  }

  function pctColor(pct) {
    if (pct >= 90) return "var(--accent-red)";
    if (pct >= 70) return "#f85149";
    if (pct >= 45) return "var(--accent-orange)";
    return "var(--accent-green)";
  }

  function openApfsPanel() {
    const old = document.getElementById("apfs-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "apfs-overlay";
    overlay.className = "smart-overlay";

    const card = document.createElement("div");
    card.className = "smart-card apfs-card";
    card.innerHTML =
      '<div class="smart-header">' +
      '<span class="smart-title apfs-title">\uD83D\uDCBE APFS &amp; Purgeable</span>' +
      '<span style="display:flex;gap:8px;align-items:center;">' +
      '<button class="apfs-refresh smart-refresh-btn" title="Refresh">\u27F3</button>' +
      '<button class="apfs-close smart-close" aria-label="Close" title="Close">\u2715</button>' +
      "</span></div>" +
      '<div class="smart-body apfs-body"></div>' +
      '<div style="padding:12px 22px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#9aa4b2;line-height:1.6;">' +
      "Snapshots are copy-on-write reserves that share blocks with live files, so their reclaimable size is an estimate. " +
      "Purgeable space is space macOS can reclaim itself." +
      "</div>";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    card.querySelector(".apfs-close").onclick = function () { overlay.remove(); };
    card.querySelector(".apfs-refresh").onclick = function () { load(); };
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) overlay.remove();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        overlay.remove();
        document.removeEventListener("keydown", onKey);
      }
    });

    const body = card.querySelector(".apfs-body");

    function load() {
      body.innerHTML =
        '<div style="text-align:center;color:#9aa4b2;padding:32px;">' +
        '<span class="smart-spinner"></span>Loading APFS volumes\u2026</div>';
      window.__TAURI__
        .invoke("list_apfs_volumes", {})
        .then(function (res) { render(res); })
        .catch(function (e) {
          const msg = e && e.message ? e.message : String(e);
          body.innerHTML =
            '<div class="smart-status err" style="padding:16px;text-align:center;">' +
            esc(msg) + "</div>";
        });
    }

    function render(res) {
      const vols = (res && res.volumes) ? res.volumes : [];
      if (vols.length === 0) {
        body.innerHTML =
          '<div style="text-align:center;color:#9aa4b2;padding:32px;">' +
          "No APFS volumes found (or this is not macOS).</div>";
        return;
      }
      let html = "";
      for (let vi = 0; vi < vols.length; vi++) {
        const v = vols[vi];
        const purgeable = v.purgeable_bytes != null ? v.purgeable_bytes : null;
        const total = v.total_bytes || 0;
        const free = v.free_bytes || 0;
        const used = total > free ? total - free : 0;
        const usedPct = total > 0 ? Math.round((used / total) * 100) : 0;
        const tm = v.local_tm_snapshots || [];
        const snaps = v.snapshots || [];
        const purgeableTag =
          purgeable != null && purgeable > 0
            ? '<span class="apfs-purge-tag">\uD83D\uDCA5 ' + fmtSize(purgeable) + " purgeable</span>"
            : '<span class="apfs-purge-tag none">No purgeable space</span>';

        html +=
          '<div class="apfs-vol">' +
          '<div class="apfs-vol-head">' +
          '<div style="min-width:0;">' +
          '<div class="apfs-vol-name">' + esc(v.name || "Volume") + "</div>" +
          '<div class="apfs-vol-mount">' + esc(v.mount || "") + "</div>" +
          "</div>" +
          '<div class="apfs-tiles">' +
          '<div class="apfs-tile total"><div class="tile-label">Total</div><div class="tile-value">' + fmtSize(total) + "</div></div>" +
          '<div class="apfs-tile used"><div class="tile-label">Used</div><div class="tile-value">' + fmtSize(used) + "</div></div>" +
          '<div class="apfs-tile free"><div class="tile-label">Free</div><div class="tile-value">' + fmtSize(free) + "</div></div>" +
          '<div class="apfs-tile purge"><div class="tile-label">Purgeable</div><div class="tile-value">' + fmtSize(purgeable) + "</div></div>" +
          "</div>" +
          "</div>" +
          '<div class="apfs-bar">' +
          '<div class="apfs-bar-used" style="width:' + Math.max(0.5, usedPct) + '%;background:' + pctColor(usedPct) + ';"></div>' +
          '<div class="apfs-bar-free"></div>' +
          "</div>" +
          '<div class="apfs-bar-labels"><span>' + usedPct + "% used</span><span>" + purgeableTag + "</span></div>" +
          snapBlock("Local Time-Machine snapshots", tm, v.mount, "tm") +
          snapBlock("APFS snapshots", snaps, null, "apfs") +
          "</div>";
      }
      body.innerHTML = html;
      body.querySelectorAll("[data-del]").forEach(function (btn) {
        btn.onclick = function () {
          const vol = btn.getAttribute("data-vol");
          const n = btn.getAttribute("data-count");
          window.confirmDialog(
            "Delete all " + n + " local Time-Machine snapshot(s) for " + vol +
            "?\n\nThis permanently removes restore points and cannot be undone.",
          ).then(function (ok) {
            if (!ok) return;
            btn.disabled = true;
            window.__TAURI__
              .invoke("delete_local_snapshot", { volume: vol })
              .then(function () {
                if (window.showToast) window.showToast("Local snapshots deleted", "success");
                load();
              })
              .catch(function (e) {
                btn.disabled = false;
                const msg = e && e.message ? e.message : String(e);
                if (window.showToast) window.showToast("Delete failed: " + msg, "error");
              });
          });
        };
      });
    }

    function snapBlock(title, items, volMount, kind) {
      if (!items || items.length === 0) {
        return '<div style="font-size:11px;color:#8b93a7;margin-top:8px;">\u2014 ' +
          esc(title) + ": none</div>";
      }
      let rows = "";
      const shown = Math.min(items.length, 40);
      for (let i = 0; i < shown; i++) {
        const s = items[i];
        let label;
        let sub = "";
        if (kind === "tm") {
          label = fmtDate(s.date || s.name || "");
        } else {
          label = s.name || s.date || "";
          if (s.date && s.name) sub = " \u00B7 " + s.date;
        }
        const sizeTxt = s.size_bytes != null ? "\u2248 " + fmtSize(s.size_bytes) : "";
        rows +=
          '<div class="apfs-snap-row">' +
          '<span style="color:#8b93a7;flex-shrink:0;">' + (kind === "tm" ? "\u23F0" : "\uD83D\uDCF8") + "</span>" +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);font-size:12px;">' +
          esc(label) +
          '<span style="color:#8b93a7;font-size:11px;">' + esc(sub) + "</span>" +
          "</span>" +
          '<span style="color:#8b93a7;font-size:11px;flex-shrink:0;">' + sizeTxt + "</span>" +
          "</div>";
      }
      if (items.length > 40) {
        rows +=
          '<div style="font-size:11px;color:#8b93a7;text-align:center;padding:4px;">+ ' +
          (items.length - 40) + " more</div>";
      }
      let delBtn = "";
      if (kind === "tm" && volMount && items.length > 0) {
        delBtn =
          '<button data-del="tm" data-vol="' + esc(String(volMount)) +
          '" data-count="' + items.length + '" class="apfs-del-btn">\uD83D\uDDD1 Delete all</button>';
      }
      return (
        '<div class="apfs-snapblock">' +
        '<div class="apfs-snaphead">' + esc(title) + " (" + items.length + ")" + delBtn +
        "</div>" + rows + "</div>"
      );
    }

    load();
  }

  window.openApfsPanel = openApfsPanel;
})();
