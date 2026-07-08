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
    var thead = document.querySelector("#topfiles-table thead tr");
    if (thead) {
      thead.innerHTML =
        '<th># <span class="sort-arrow">\u25BC</span></th>' +
        '<th>Path <span class="sort-arrow">\u25B2\u25BC</span></th>' +
        '<th>Size <span class="sort-arrow">\u25BC</span></th>' +
        '<th style="width:40px">Action</th>';
    }
  }

  _getFileIcon(path) {
    var ext = (path.split(".").pop() || "").toLowerCase();
    var icons = {
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
    var ext = (path.split(".").pop() || "").toLowerCase();
    var badgeTypes = [
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
    this._ctxMenu.innerHTML =
      '<div class="tfctx-item" data-action="explorer">\u{1F4C2} Open in Explorer</div>' +
      '<div class="tfctx-item" data-action="terminal">\u{1F4BB} Open Terminal</div>' +
      '<div class="tfctx-sep"></div>' +
      '<div class="tfctx-item" data-action="properties">\u2699\uFE0F Properties</div>' +
      '<div class="tfctx-item" data-action="copy">\u{1F4CB} Copy Path</div>' +
      '<div class="tfctx-sep"></div>' +
      '<div class="tfctx-item tfctx-del" data-action="delete">\u{1F5D1}\uFE0F Delete</div>';
    document.body.appendChild(this._ctxMenu);

    const style = document.createElement("style");
    style.textContent =
      ".tfctx-item{padding:6px 16px;font-size:13px;cursor:pointer;color:#e6edf3;}" +
      ".tfctx-item:hover{background:#30363d;}" +
      ".tfctx-sep{height:1px;background:#30363d;margin:4px 8px;}" +
      ".tfctx-del{color:#f85149;}";
    document.head.appendChild(style);

    document.addEventListener("click", (e) => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) {
        this._ctxMenu.style.display = "none";
      }
    });

    this._ctxMenu.addEventListener("click", (e) => {
      var item = e.target.closest(".tfctx-item");
      if (!item) return;
      var action = item.dataset.action;
      var path = this._ctxMenu._filePath;
      this._ctxMenu.style.display = "none";
      if (!path) return;
      if (action === "explorer") this._exec("open_explorer", { path: path });
      else if (action === "terminal") {
        var dir =
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
            var sb = document.querySelector(".status-bar");
            if (sb) sb.textContent = "Copied: " + path;
          })
          .catch(function () {});
      } else if (action === "delete") {
        if (confirm("Delete file?\n" + path)) {
          this._exec("delete_path", { path: path })
            .then(function () {
              var sb = document.querySelector(".status-bar");
              if (sb) sb.textContent = "Deleted: " + path;
            })
            .catch(function (err) {
              alert("Delete failed: " + err);
            });
        }
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
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = showDelete ? 4 : 3;
      td.textContent = "No files found";
      td.style.textAlign = "center";
      td.style.color = "var(--text-muted)";
      td.style.padding = "24px";
      tr.appendChild(td);
      this.tbody.appendChild(tr);
      return;
    }

    for (var i = 0; i < Math.min(topFiles.length, 50); i++) {
      var entry = topFiles[i];
      var tr = document.createElement("tr");
      tr.style.cursor = "context-menu";

      // Right-click context menu on each row
      tr.addEventListener(
        "contextmenu",
        function (p) {
          return function (e) {
            e.preventDefault();
            this._ctxMenu._filePath = p;
            this._ctxMenu.style.display = "block";
            this._ctxMenu.style.left = e.clientX + "px";
            this._ctxMenu.style.top = e.clientY + "px";
          }.bind(this);
        }.call(this, entry.path),
      );

      // Rank
      var rankTd = document.createElement("td");
      rankTd.textContent = i + 1;
      tr.appendChild(rankTd);

      // Path with file icon + badge
      var pathTd = document.createElement("td");
      pathTd.style.display = "flex";
      pathTd.style.alignItems = "center";
      pathTd.style.gap = "6px";
      pathTd.style.maxWidth = "200px";
      pathTd.style.overflow = "hidden";
      var iconSpan = document.createElement("span");
      iconSpan.textContent = this._getFileIcon(entry.path || "");
      iconSpan.style.flexShrink = "0";
      iconSpan.style.fontSize = "14px";
      pathTd.appendChild(iconSpan);
      var nameSpan = document.createElement("span");
      nameSpan.textContent = entry.path || "?";
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      nameSpan.style.whiteSpace = "nowrap";
      nameSpan.title = entry.path || "";
      pathTd.appendChild(nameSpan);
      // Add badge as innerHTML
      var badgeHtml = this._getFileBadge(entry.path || "");
      if (badgeHtml) {
        var temp = document.createElement("span");
        temp.innerHTML = badgeHtml;
        pathTd.appendChild(temp.firstChild);
      }
      tr.appendChild(pathTd);
      pathTd.appendChild(
        new DOMParser().parseFromString(
          this._getFileBadge(entry.path || ""),
          "text/html",
        ).body.firstChild || document.createTextNode(""),
      );
      tr.appendChild(pathTd);

      // Size
      var sizeTd = document.createElement("td");
      sizeTd.textContent = entry.size_human || this._formatSize(entry.size);
      tr.appendChild(sizeTd);

      // Delete button
      if (showDelete) {
        var delTd = document.createElement("td");
        delTd.style.width = "30px";
        delTd.style.textAlign = "center";
        var delBtn = document.createElement("button");
        delBtn.textContent = "\uD83D\uDDD1";
        delBtn.style.cssText =
          "padding:1px 6px;font-size:12px;background:transparent;border:1px solid var(--border);border-radius:3px;cursor:pointer";
        delBtn.title = "Delete " + (entry.path || "");
        delBtn.onclick = function (p) {
          return function () {
            this._exec("delete_path", { path: p });
          }.bind(this);
        }.bind(this)(entry.path);
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
    var units = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.floor(Math.log(bytes) / Math.log(1024));
    var val = bytes / Math.pow(1024, i);
    return i === 0 ? bytes + " B" : val.toFixed(2) + " " + units[i];
  }
}
