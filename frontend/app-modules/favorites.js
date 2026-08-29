(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initFavorites = function (scanPath, btnFav) {
    const favMenu = document.getElementById("fav-menu");
    let favorites = [];

    function deriveLabel(path) {
      const base = (path || "").split(/[\\/]/).filter(Boolean).pop();
      return base || "Favorite";
    }

    function normalizeFavorites(raw) {
      if (!Array.isArray(raw)) return [];
      return raw
        .map(function (entry) {
          if (typeof entry === "string") {
            return { path: entry, label: deriveLabel(entry), note: "", createdAt: new Date().toISOString() };
          }
          if (entry && typeof entry === "object" && entry.path) {
            return {
              path: entry.path,
              label: entry.label || deriveLabel(entry.path),
              note: entry.note || "",
              createdAt: entry.createdAt || new Date().toISOString(),
            };
          }
          return null;
        })
        .filter(Boolean);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;");
    }

    async function loadFavorites() {
      try {
        const s = await window.__TAURI__.invoke("load_settings", {});
        if (s && s.favorites) favorites = normalizeFavorites(s.favorites);
      } catch (e) { console.debug("[DiskRaptor]", e); }
    }

    async function saveFavorites() {
      await window.__TAURI__
        .invoke("save_settings", { settings: { favorites: favorites } })
        .catch(function (e) {
          console.warn("Failed to save favorites:", e && e.message ? e.message : e);
        });
    }

    function renderFavorites() {
      if (!favMenu) return;
      if (favorites.length === 0) {
        favMenu.classList.remove("active");
        favMenu.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:var(--text-muted);">No favorites yet</div>';
        return;
      }
      let html = '<div class="fav-hint" style="padding:6px 8px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);">Tip: add labeled folders for fast reuse</div>';
      for (let fi = 0; fi < favorites.length; fi++) {
        const f = favorites[fi];
        const label = escapeHtml(f.label || deriveLabel(f.path));
        const path = escapeHtml(f.path);
        const note = f.note
          ? '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(f.note) + '</div>'
          : "";
        html +=
          '<div class="fav-item" data-path="' + path + '" style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);cursor:pointer;">' +
          '<div style="min-width:0;flex:1;">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + label + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + path + '</div>' +
          note +
          '</div>' +
          '<div style="display:flex;gap:4px;align-items:center;">' +
          '<button class="fav-edit" data-idx="' + fi + '" style="border:none;background:transparent;color:var(--text-muted);cursor:pointer;">✎</button>' +
          '<button class="fav-del" data-idx="' + fi + '" style="border:none;background:transparent;color:#f85149;cursor:pointer;">✕</button>' +
          '</div></div>';
      }
      favMenu.innerHTML = html;
    }

    function showFavoriteEditor(path, existingIndex, onDone) {
      const ov = document.createElement("div");
      ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;";
      const card = document.createElement("div");
      card.style.cssText = "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;width:min(92vw,360px);overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.4);";
      const existing = existingIndex != null ? favorites[existingIndex] : null;
      card.innerHTML =
        '<div style="padding:12px 16px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600;">⭐ Favorite folder</div>' +
        '<div style="padding:16px;display:flex;flex-direction:column;gap:10px;">' +
        '<label style="font-size:12px;color:var(--text-secondary);">Name</label>' +
        '<input id="fav-label" value="' + escapeHtml(existing ? existing.label : deriveLabel(path)) + '" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);" />' +
        '<label style="font-size:12px;color:var(--text-secondary);"><span data-i18n="fav.note">Note</span></label>' +
        '<textarea id="fav-note" rows="3" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);resize:vertical;">' + escapeHtml(existing ? existing.note : "") + '</textarea>' +
        '<div style="font-size:11px;color:var(--text-muted);" data-i18n="fav.saved_hint">Saved folders are available from the bookmark menu for quick reuse.</div>' +
        '</div>' +
        '<div style="padding:10px 16px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;">' +
        '<button id="fav-cancel" style="padding:6px 12px;border:1px solid var(--border);border-radius:6px;background:var(--bg-tertiary);color:var(--text-primary);cursor:pointer;"><span data-i18n="btn.cancel">Cancel</span></button>' +
        '<button id="fav-save" style="padding:6px 12px;border:none;border-radius:6px;background:linear-gradient(135deg,#238636,#2ea043);color:#fff;cursor:pointer;font-weight:600;"><span data-i18n="settings.save">Save</span></button>' +
        '</div>';
      ov.appendChild(card);
      document.body.appendChild(ov);
      const close = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
      card.querySelector("#fav-cancel").onclick = close;
      card.querySelector("#fav-save").onclick = function () {
        const label = card.querySelector("#fav-label").value.trim() || deriveLabel(path);
        const note = card.querySelector("#fav-note").value.trim();
        close();
        onDone({ path: path, label: label, note: note, createdAt: existing ? existing.createdAt : new Date().toISOString() });
      };
      ov.onclick = function (e) { if (e.target === ov) close(); };
    }

    loadFavorites().then(renderFavorites);

    if (btnFav && favMenu) {
      btnFav.addEventListener("click", function (e) {
        e.stopPropagation();
        const path = scanPath.value.trim();
        if (!path) return;
        const idx = favorites.findIndex(function (f) { return f.path === path; });
        if (idx >= 0) {
          favorites.splice(idx, 1);
          btnFav.textContent = "☆";
          saveFavorites();
          renderFavorites();
          return;
        }
        showFavoriteEditor(path, null, function (entry) {
          favorites.unshift(entry);
          btnFav.textContent = "★";
          saveFavorites();
          renderFavorites();
        });
      });
      scanPath.addEventListener("focus", function () {
        renderFavorites();
        if (favorites.length > 0) favMenu.classList.add("active");
      });
      scanPath.addEventListener("blur", function () {
        setTimeout(function () {
          favMenu.classList.remove("active");
        }, 200);
      });
      favMenu.addEventListener("click", function (e) {
        const item = e.target.closest(".fav-item");
        const del = e.target.closest(".fav-del");
        const edit = e.target.closest(".fav-edit");
        if (del) {
          const idx = parseInt(del.dataset.idx);
          if (!isNaN(idx) && idx >= 0 && idx < favorites.length) {
            favorites.splice(idx, 1);
            saveFavorites();
            renderFavorites();
            if (favorites.length === 0) favMenu.classList.remove("active");
          }
          return;
        }
        if (edit) {
          const idx = parseInt(edit.dataset.idx);
          if (!isNaN(idx) && idx >= 0 && idx < favorites.length) {
            showFavoriteEditor(favorites[idx].path, idx, function (entry) {
              favorites[idx] = entry;
              saveFavorites();
              renderFavorites();
            });
          }
          return;
        }
        if (item) {
          const path = item.dataset.path;
          if (path && scanPath) {
            scanPath.value = path;
            favMenu.classList.remove("active");
          }
        }
      });
      document.addEventListener("click", function () {
        favMenu.classList.remove("active");
      });
      scanPath.addEventListener("input", function () {
        const path = scanPath.value.trim();
        const isFavorite = favorites.some(function (f) { return f.path === path; });
        btnFav.textContent = isFavorite ? "★" : "☆";
      });
    }
  };
})();
