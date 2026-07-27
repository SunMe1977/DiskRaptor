(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initFavorites = function (scanPath, btnFav) {
    const favMenu = document.getElementById("fav-menu");
    let favorites = [];

    async function loadFavorites() {
      try {
        const s = await window.__TAURI__.invoke("load_settings", {});
        if (s && s.favorites) favorites = s.favorites;
      } catch (e) {}
    }

    async function saveFavorites() {
      await window.__TAURI__
        .invoke("save_settings", { favorites: favorites })
        .catch(function () {});
    }

    function renderFavorites() {
      if (!favMenu) return;
      if (favorites.length === 0) {
        favMenu.classList.remove("active");
        return;
      }
      let html = "";
      for (let fi = 0; fi < favorites.length; fi++) {
        const f = favorites[fi];
        html +=
          '<div class="fav-item" data-path="' +
          f.replace(/"/g, "&quot;") +
          '"><span>\uD83D\uDCCC</span><span style="overflow:hidden;text-overflow:ellipsis;">' +
          f +
          '</span><span class="fav-del" data-idx="' +
          fi +
          '">\u2715</span></div>';
      }
      favMenu.innerHTML = html;
    }

    loadFavorites().then(renderFavorites);

    if (btnFav && favMenu) {
      btnFav.addEventListener("click", function (e) {
        e.stopPropagation();
        const path = scanPath.value.trim();
        if (!path) return;
        const idx = favorites.indexOf(path);
        if (idx >= 0) {
          favorites.splice(idx, 1);
          btnFav.textContent = "\u2606";
        } else {
          favorites.push(path);
          btnFav.textContent = "\u2605";
        }
        saveFavorites();
        renderFavorites();
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
        btnFav.textContent =
          favorites.indexOf(scanPath.value.trim()) >= 0 ? "\u2605" : "\u2606";
      });
    }
  };
})();
