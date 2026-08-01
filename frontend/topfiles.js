/**
 * TopFiles — Renders the top 50 files table with right-click context menu.
 * Context menu matches the diagram menu: Explorer, Terminal, Properties, Copy, Delete.
 */
class TopFilesPanel {
  constructor() {
    this.tbody = document.getElementById("topfiles-body");
    this._ensureHeader();
    this._initContextMenu();
  }

  _ensureHeader() {
    const thead = document.querySelector("#topfiles-table thead tr");
    if (thead) {
      thead.innerHTML =
        '<th># <span class="sort-arrow">\u25BC</span></th>' +
        '<th>Path <span class="sort-arrow">\u25B2\u25BC</span></th>' +
        '<th>Size <span class="sort-arrow">\u25BC</span></th>' +
        '<th style="width:40px">Action</th>';
    }
  }

  _getFileIcon(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const icons = {
      iso: "\uD83D\uDCBF",
      vhd: "\uD83D\uDCC0",
      vhdx: "\uD83D\uDCC0",
      zip: "\uD83D\uDCE6",
      rar: "\uD83D\uDCE6",
      "7z": "\uD83D\uDCE6",
      exe: "\u2699\uFE0F",
      dll: "\u2699\uFE0F",
      pdf: "\uD83D\uDCC4",
      doc: "\uD83D\uDCC4",
      docx: "\uD83D\uDCC4",
      png: "\uD83D\uDDBC\uFE0F",
      jpg: "\uD83D\uDDBC\uFE0F",
      jpeg: "\uD83D\uDDBC\uFE0F",
      mp4: "\uD83C\uDFA5",
      avi: "\uD83C\uDFA5",
      mkv: "\uD83C\uDFA5",
      mp3: "\uD83C\uDFB5",
      wav: "\uD83C\uDFB5",
      flac: "\uD83C\uDFB5",
      txt: "\uD83D\uDCDD",
      log: "\uD83D\uDCDD",
      msi: "\u2699\uFE0F",
      crdownload: "\u23F3",
    };
    return icons[ext] || "\uD83D\uDCC4";
  }

  _getFileBadge(path) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const badgeTypes = [
      "iso",
      "vhd",
      "vhdx",
      "zip",
      "rar",
      "7z",
      "exe",
      "dll",
      "pdf",
      "msi",
      "crdownload",
      "txt",
      "log",
    ];
    if (badgeTypes.indexOf(ext) >= 0) {
      return '<span class="file-type-badge ' + ext + '">' + ext + "</span>";
    }
    return "";
  }

  _initContextMenu() {
    this._ctxMenu = document.createElement("div");
    Object.assign(this._ctxMenu.style, {
      display: "none",
      position: "fixed",
      zIndex: 2000,
      background: "#161b22",
      border: "1px solid #30363d",
      borderRadius: "6px",
      padding: "4px 0",
      minWidth: "200px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    });
    const isMac = /mac/i.test(navigator.platform || "");
    const isLinux = /linux/i.test(navigator.platform || "");
    const explorerLabel = isMac ? "Open in Finder" : isLinux ? "Open in File Manager" : "Open in Explorer";
    this._ctxMenu.innerHTML =
      '<div class="tfctx-item" data-action="explorer">\u{1F4C2} ' + explorerLabel + '</div>' +
      '<div class="tfctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
      '<div class="tfctx-sep"></div>' +
      '<div class="tfctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
      '<div class="tfctx-item" data-action="copy">\u{1F4CB} Copy Path</div>' +
      '<div class="tfctx-sep"></div>' +
      '<div class="tfctx-item tfctx-del" data-action="delete">\u{1F5D1}\uFE0F ' + (window.__ ? window.__("action.move_to_trash") : "Move to Trash") + '</div>';
    document.body.appendChild(this._ctxMenu);

    const style = document.createElement("style");
    style.textContent =
      ".tfctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:var(--text-primary);}" +
      ".tfctx-item:hover{background:#30363d;}" +
      ".tfctx-sep{height:1px;background:#30363d;margin:4px 8px;}" +
      ".tfctx-del{color:var(--accent-red);}";
    document.head.appendChild(style);

    document.addEventListener("click", (e) => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) {
        this._ctxMenu.style.display = "none";
      }
    });

    this._ctxMenu.addEventListener("click", (e) => {
      const item = e.target.closest(".tfctx-item");
      if (!item) return;
      const action = item.dataset.action;
      const path = this._ctxMenu._filePath;
      this._ctxMenu.style.display = "none";
      if (!path) return;
      if (action === "explorer") this._exec("open_explorer", { path: path });
      else if (action === "terminal") {
        const dir =
          path.lastIndexOf("\\") >= 0
            ? path.substring(0, path.lastIndexOf("\\"))
            : path;
        this._exec("open_terminal", { path: dir });
      } else if (action === "properties")
        this._exec("open_properties", { path: path });
      else if (action === "copy") {
        navigator.clipboard
          .writeText(path)
          .then(function () {
            const sb = document.querySelector(".status-bar");
            if (sb) sb.textContent = (window.__ || function(s){return s;})("status.copied").replace("{path}", path);
          })
          .catch(function () {});
      } else if (action === "delete") {
        const t = window.__ || function(s){return s;};
        const self = this;
        window.confirmDialog(t("confirm.move_trash_file") + path).then(function (ok) {
          if (!ok) return;
          self._exec("delete_path", { path: path })
            .then(function () {
              const sb = document.querySelector(".status-bar");
              if (sb) sb.textContent = t("status.moved_to_trash").replace("{name}", path);
              const st = window.app && window.app.state && window.app.state.currentStats;
              if (st && Array.isArray(st.top_files)) {
                st.top_files = st.top_files.filter(function (f) {
                  return (typeof f === "string" ? f : (f.path || "")) !== path;
                });
              }
              if (window.__topFiles) window.__topFiles.render(st ? st.top_files : [], true);
            })
            .catch(function (err) {
              window.alertDialog("Failed: " + err);
            });
        });
      }
    });
  }

  _exec(cmd, args) {
    if (window.__TAURI__ && window.__TAURI__.invoke)
      return window.__TAURI__.invoke(cmd, args);
    return Promise.reject(new Error("No invoke"));
  }

  render(topFiles, showDelete) {
    this.tbody.innerHTML = "";

    if (!topFiles || topFiles.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = showDelete ? 4 : 3;
      td.textContent = "📭 No files found — run a scan first";
      td.style.textAlign = "center";
      td.style.color = "var(--text-muted)";
      td.style.padding = "24px";
      tr.appendChild(td);
      this.tbody.appendChild(tr);
      return;
    }

    for (let i = 0; i < Math.min(topFiles.length, 50); i++) {
      const entry = topFiles[i];
      const tr = document.createElement("tr");
      tr.style.cursor = "context-menu";

      // Context menu on right-click or left-click (same menu)
      const self = this;
      const filePath = entry.path;
      tr.addEventListener("contextmenu", function(e) {
        e.preventDefault();
        self._ctxMenu._filePath = filePath;
        self._ctxMenu.style.display = "block";
        self._ctxMenu.style.left = e.clientX + "px";
        self._ctxMenu.style.top = e.clientY + "px";
      });
      tr.addEventListener("click", function(e) {
        self._ctxMenu._filePath = filePath;
        self._ctxMenu.style.display = "block";
        self._ctxMenu.style.left = e.clientX + "px";
        self._ctxMenu.style.top = e.clientY + "px";
      });

      // Rank
      const rankTd = document.createElement("td");
      rankTd.textContent = i + 1;
      tr.appendChild(rankTd);

      // Path with file icon + badge
      const pathTd = document.createElement("td");
      pathTd.style.display = "flex";
      pathTd.style.alignItems = "center";
      pathTd.style.gap = "6px";
      pathTd.style.maxWidth = "200px";
      pathTd.style.overflow = "hidden";
      const iconSpan = document.createElement("span");
      iconSpan.style.cssText =
        "display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;font-size:14px;";
      iconSpan.textContent = this._getFileIcon(entry.path || "");
      pathTd.appendChild(iconSpan);
      // Load real icon
      if (window.__ICON_CACHE__ && entry.path) {
        (function (sp, p) {
          window.__ICON_CACHE__
            .getIcon(p, false)
            .then(function (ir) {
              if (typeof ir === "string" && ir.indexOf("data:") === 0) {
                sp.innerHTML = "";
                const img = document.createElement("img");
                img.src = ir;
                img.style.cssText = "width:16px;height:16px;display:block;";
                sp.appendChild(img);
              } else if (typeof ir === "string" && ir.length < 10) {
                sp.textContent = ir;
              }
            })
            .catch(function () {});
        })(iconSpan, entry.path);
      }
      const nameSpan = document.createElement("span");
      nameSpan.textContent = entry.path || "?";
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.title = entry.path || "";
      pathTd.appendChild(nameSpan);
      // Add badge as innerHTML
      const badgeHtml = this._getFileBadge(entry.path || "");
      if (badgeHtml) {
        const temp = document.createElement("span");
        temp.innerHTML = badgeHtml;
        pathTd.appendChild(temp.firstChild);
      }
      tr.appendChild(pathTd);

      // Size
      const sizeTd = document.createElement("td");
      sizeTd.textContent = entry.size_human || this._formatSize(entry.size);
      tr.appendChild(sizeTd);

      // Delete button
      if (showDelete) {
        const delTd = document.createElement("td");
        delTd.style.width = "30px";
        delTd.style.textAlign = "center";
        const delBtn = document.createElement("button");
        delBtn.textContent = "\uD83D\uDDD1";
        delBtn.style.cssText =
          "padding:1px 6px;font-size:12px;background:transparent;border:1px solid var(--border);border-radius:3px;cursor:pointer";
        delBtn.title = "Move to Trash: " + (entry.path || "");
        delBtn.onclick = function (p, row) {
          const self = this;
          return function () {
            const t = window.__ || function(s){return s;};
            window.confirmDialog(t("confirm.move_trash_file") + p).then(function (ok) {
              if (!ok) return;
              self._exec("delete_path", { path: p })
                .then(function () {
                  const sb = document.querySelector(".status-bar");
                  if (sb) sb.textContent = t("status.moved_to_trash").replace("{name}", p);
                  row.remove();
                  const st = window.app && window.app.state && window.app.state.currentStats;
                  if (st && Array.isArray(st.top_files)) {
                    st.top_files = st.top_files.filter(function (f) {
                      return (typeof f === "string" ? f : (f.path || "")) !== p;
                    });
                  }
                  if (window.__topFiles) window.__topFiles.render(st ? st.top_files : [], true);
                })
                .catch(function (err) {
                  window.alertDialog("Failed: " + err);
                });
            });
          };
        }.bind(this)(entry.path, tr);
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);
      }

      this.tbody.appendChild(tr);
    }
  }

  clear() {
    this.tbody.innerHTML = "";
  }

  _formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const val = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + " B" : val.toFixed(2) + " " + units[i];
  }
}
