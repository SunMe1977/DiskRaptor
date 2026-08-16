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

  function openApfsPanel() {
    const old = document.getElementById("apfs-overlay");
    if (old) old.remove();

    const overlay = document.createElement("div");
    overlay.id = "apfs-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.55);" +
      "backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);" +
      "display:flex;align-items:center;justify-content:center;";

    const card = document.createElement("div");
    card.style.cssText =
      "background:var(--bg-secondary);border:1px solid var(--border);" +
      "border-radius:16px;max-width:640px;width:92%;max-height:82vh;overflow:hidden;" +
      "box-shadow:0 16px 48px rgba(0,0,0,0.5);display:flex;flex-direction:column;";
    card.innerHTML =
      '<div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
      '<span style="font-size:15px;font-weight:600;">\uD83D\uDCBE APFS &amp; Purgeable</span>' +
      '<span style="display:flex;gap:6px;align-items:center;">' +
      '<button class="apfs-refresh" style="padding:5px 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;">\u27F3 Refresh</button>' +
      '<button class="apfs-close" aria-label="Close" style="padding:3px 9px;font-size:14px;border:none;background:none;color:var(--text-muted);cursor:pointer;">\u2715</button>' +
      "</span></div>" +
      '<div class="apfs-body" style="flex:1;overflow-y:auto;padding:14px 16px;min-height:220px;font-size:13px;"></div>' +
      '<div style="padding:10px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--text-muted);line-height:1.5;">' +
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

    const body = card.querySelector(".apfs-body");

    function load() {
      body.innerHTML =
        '<div style="text-align:center;color:var(--text-muted);padding:24px;">Loading\u2026</div>';
      window.__TAURI__
        .invoke("list_apfs_volumes", {})
        .then(function (res) { render(res); })
        .catch(function (e) {
          const msg = e && e.message ? e.message : String(e);
          body.innerHTML =
            '<div style="color:var(--accent-red);padding:16px;text-align:center;">' +
            (window.escHtml ? window.escHtml(msg) : msg) + "</div>";
        });
    }

    function render(res) {
      const vols = (res && res.volumes) ? res.volumes : [];
      if (vols.length === 0) {
        body.innerHTML =
          '<div style="text-align:center;color:var(--text-muted);padding:24px;">' +
          "No APFS volumes found (or this is not macOS).</div>";
        return;
      }
      let html = "";
      for (let vi = 0; vi < vols.length; vi++) {
        const v = vols[vi];
        const purgeable = v.purgeable_bytes != null ? v.purgeable_bytes : null;
        const tm = v.local_tm_snapshots || [];
        const snaps = v.snapshots || [];
        const purgeStyle =
          purgeable != null && purgeable > 0
            ? "color:var(--accent-green);font-weight:600;"
            : "color:var(--text-muted);";
        html +=
          '<div style="border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px;background:var(--bg-primary);">' +
          '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">' +
          '<span style="font-size:14px;font-weight:600;">' + (window.escHtml ? window.escHtml(v.name || "Volume") : v.name || "Volume") + "</span>" +
          '<span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">' + (window.escHtml ? window.escHtml(v.mount || "") : v.mount || "") + "</span>" +
          "</div>" +
          '<div style="font-size:12px;margin-bottom:6px;display:flex;gap:14px;flex-wrap:wrap;">' +
          "<span>Total: <b>" + fmtSize(v.total_bytes) + "</b></span>" +
          "<span>Free: <b>" + fmtSize(v.free_bytes) + "</b></span>" +
          '<span>Purgeable: <b style="' + purgeStyle + '">' + fmtSize(purgeable) + "</b></span>" +
          "</div>" +
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
        return '<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">\u2014 ' +
          (window.escHtml ? window.escHtml(title) : title) + ": none</div>";
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
          '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:12px;">' +
          '<span style="color:var(--text-muted);flex-shrink:0;">' + (kind === "tm" ? "\u23F0" : "\uD83D\uDCF8") + "</span>" +
          '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--font-mono);">' +
          (window.escHtml ? window.escHtml(label) : label) +
          '<span style="color:var(--text-muted);font-size:11px;">' + (window.escHtml ? window.escHtml(sub) : sub) + "</span>" +
          "</span>" +
          '<span style="color:var(--text-muted);font-size:11px;flex-shrink:0;">' + sizeTxt + "</span>" +
          "</div>";
      }
      if (items.length > 40) {
        rows +=
          '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:2px;">+ ' +
          (items.length - 40) + " more</div>";
      }
      let delBtn = "";
      if (kind === "tm" && volMount && items.length > 0) {
        delBtn =
          '<button data-del="tm" data-vol="' + (window.escHtml ? window.escHtml(String(volMount)) : String(volMount)) +
          '" data-count="' + items.length + '" style="margin-left:auto;padding:3px 10px;font-size:11px;border:1px solid var(--accent-red);border-radius:6px;background:transparent;color:var(--accent-red);cursor:pointer;">\uD83D\uDDD1 Delete all</button>';
      }
      return (
        '<div style="margin-top:8px;border-top:1px solid var(--border-light);padding-top:6px;">' +
        '<div style="font-size:11px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;display:flex;align-items:center;gap:8px;margin-bottom:2px;">' +
        (window.escHtml ? window.escHtml(title) : title) + " (" + items.length + ")" + delBtn +
        "</div>" + rows + "</div>"
      );
    }

    load();
  }

  window.openApfsPanel = openApfsPanel;
})();
