/**
 * Ctrl/Cmd+J quick jump (#15): fuzzy-ish path search over the scanned tree,
 * backed by the `search_tree` command. Enter/click jumps the main tree to the
 * matched node via the proven path-based jump event.
 */
(function () {
  "use strict";

  let overlay = null;
  let inputEl = null;
  let listEl = null;
  let hintEl = null;
  let results = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const esc = function (s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  const unwrap = function (res) {
    if (Array.isArray(res)) return res;
    if (res && typeof res === "object" && "data" in res) return res.data;
    if (res && typeof res === "object" && "result" in res) return res.result;
    return res;
  };

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return;
    overlay = document.createElement("div");
    overlay.id = "jump-overlay";
    overlay.style.cssText =
      "position:fixed;top:64px;left:50%;transform:translateX(-50%);width:min(620px,92vw);z-index:2000;" +
      "background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;" +
      "box-shadow:0 18px 60px rgba(0,0,0,0.55);display:none;overflow:hidden;font-size:13px;";
    overlay.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-light);">' +
      '<span style="opacity:.7;">🔎</span>' +
      '<input id="jump-input" type="text" placeholder="Jump to folder…  (min. 2 characters)" ' +
      'style="flex:1;border:0;outline:none;background:transparent;color:var(--text-primary);font-size:13px;" autocomplete="off" spellcheck="false">' +
      '<span id="jump-hint" style="font-size:11px;color:var(--text-muted);"></span>' +
      '<button id="jump-close" style="border:0;background:transparent;color:var(--text-muted);cursor:pointer;font-size:14px;">✕</button></div>' +
      '<div id="jump-list" style="max-height:min(420px,60vh);overflow-y:auto;padding:4px;"></div>';
    document.body.appendChild(overlay);
    inputEl = overlay.querySelector("#jump-input");
    listEl = overlay.querySelector("#jump-list");
    hintEl = overlay.querySelector("#jump-hint");
    overlay.querySelector("#jump-close").addEventListener("click", close);
    overlay.addEventListener("keydown", onKey);
    inputEl.addEventListener("input", onInput);
    inputEl.addEventListener("keydown", onInputKey);
  }

  function open() {
    ensureOverlay();
    overlay.style.display = "block";
    results = [];
    active = -1;
    seq++;
    hintEl.textContent = "";
    listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">Type to search…</div>';
    if (inputEl.value) inputEl.value = "";
    inputEl.focus();
    if (window.__treeView && !document.getElementById("tree-scroll")) {
      // nothing to jump into yet
    }
  }

  function close() {
    seq++;
    if (timer) clearTimeout(timer);
    timer = null;
    if (overlay) overlay.style.display = "none";
  }

  async function run(q) {
    const mySeq = ++seq;
    if (q.length < 2) {
      hintEl.textContent = "";
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">Type at least 2 characters…</div>';
      return;
    }
    hintEl.textContent = "Searching…";
    try {
      const res = await window.__TAURI__.invoke("search_tree", { query: q, limit: 60 });
      if (mySeq !== seq) return; // stale response
      results = unwrap(res);
      if (!Array.isArray(results)) results = [];
      hintEl.textContent = results.length ? results.length + " match(es)" : "";
      render();
    } catch (e) {
      if (mySeq !== seq) return;
      hintEl.textContent = "";
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--accent-red);font-size:12px;">Search failed.</div>';
    }
  }

  function render() {
    if (!results.length) {
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">No matches.</div>';
      return;
    }
    let html = "";
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const sel = i === active ? "background:var(--bg-tertiary);" : "";
      html +=
        '<div class="jump-row" data-i="' + i + '" style="display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:6px;cursor:pointer;' + sel + '">' +
        "<span>" + (r.is_dir ? "📁" : "📄") + "</span>" +
        '<span style="flex:1;min-width:0;">' +
        '<span style="color:var(--text-primary);font-weight:500;">' + esc(r.name) + "</span>" +
        '<span style="display:block;color:var(--text-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(r.path || "") + "</span>" +
        "</span>" +
        '<span style="color:var(--text-muted);font-size:11px;white-space:nowrap;">' + esc(r.size_human || window.fmtSize(r.size || 0)) + "</span></div>";
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll(".jump-row").forEach(function (row) {
      row.addEventListener("click", function () {
        const i = parseInt(row.getAttribute("data-i"), 10);
        if (!isNaN(i)) jump(i);
      });
      row.addEventListener("mousemove", function () {
        const i = parseInt(row.getAttribute("data-i"), 10);
        if (!isNaN(i) && i !== active) { active = i; render(); }
      });
    });
    const selRow = listEl.querySelector('.jump-row[data-i="' + active + '"]');
    if (selRow) selRow.scrollIntoView({ block: "nearest" });
  }

  function jump(i) {
    const r = results[i];
    if (!r || !r.path) return;
    close();
    window.dispatchEvent(new CustomEvent("diagram-jump-to-path", { detail: { path: r.path } }));
  }

  function onInput() {
    if (timer) clearTimeout(timer);
    const q = inputEl.value.trim();
    if (!q) {
      hintEl.textContent = "";
      listEl.innerHTML = '<div style="padding:18px;text-align:center;color:var(--text-muted);font-size:12px;">Type to search…</div>';
      return;
    }
    timer = setTimeout(function () { run(q); }, 160);
  }

  function onInputKey(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (results.length) { active = (active + 1) % results.length; render(); }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (results.length) { active = (active - 1 + results.length) % results.length; render(); }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0 && results[active]) jump(active);
      else if (results.length === 1) jump(0);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
      inputEl.blur();
    }
  }

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  document.addEventListener("keydown", function (e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "j" || e.key === "J")) {
      // Only intercept when the tree has data (searching is meaningless without it).
      if (!window.__treeView || !document.getElementById("scan-path") || !document.getElementById("scan-path").value) {
        return;
      }
      e.preventDefault();
      if (overlay && overlay.style.display === "block") {
        close();
      } else {
        open();
      }
    }
  });

  // Keep public for tests / menu hooks.
  window.__jumpSearch = { open: open, close: close };
})();
