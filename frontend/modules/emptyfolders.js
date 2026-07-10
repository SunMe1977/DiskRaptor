/**
 * EmptyFolders Module — Finds all empty directories.
 * Scans the current directory tree and highlights empty folders.
 * Self-contained: can be loaded independently and plugged into app.js.
 */
(function () {
  "use strict";

  class EmptyFoldersModule {
    constructor() {
      this.name = "Empty Folders";
      this.icon = "📂";
      this.results = [];
      this.panel = null;
    }

    /** Return a DOM panel that can be embedded in the UI */
    createPanel() {
      this.panel = document.createElement("div");
      this.panel.className = "module-panel";
      this.panel.style.display = "none";
      this.panel.innerHTML =
        '<div class="module-header">' +
          '<span class="module-icon">📂</span>' +
          '<span class="module-title">Empty Folders</span>' +
          '<button class="module-run-btn">Scan</button>' +
        "</div>" +
        '<div class="module-body">' +
          '<p class="module-status">Click "Scan" to find empty directories.</p>' +
          '<div class="module-results" style="display:none;max-height:200px;overflow-y:auto">' +
            '<table class="module-table" style="width:100%;font-size:12px;border-collapse:collapse">' +
              '<thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)">Path</th></tr></thead>' +
              '<tbody id="empty-folders-body"></tbody>' +
            "</table>" +
          "</div>" +
        "</div>";
      return this.panel;
    }

    /** Run the empty folder scan */
    async run(loader, scanPath) {
      var body = this.panel.querySelector("#empty-folders-body");
      var status = this.panel.querySelector(".module-status");
      var results = this.panel.querySelector(".module-results");
      body.innerHTML = "";
      status.textContent = "Scanning…";
      results.style.display = "none";

      if (!loader || !loader.allNodes) {
        status.textContent = "No scan data. Run a scan first.";
        return;
      }

      // Walk all nodes and find empty directories
      var empty = [];
      var dirIndices = {};
      for (var i = 0; i < loader.allNodes.length; i++) {
        var n = loader.allNodes[i];
        if (n && n.node_type === "Directory") {
          dirIndices[i] = true;
        }
      }
      // Count children per parent
      var childCount = {};
      for (var i = 1; i < loader.allNodes.length; i++) {
        var n = loader.allNodes[i];
        if (n) {
          childCount[n.parent] = (childCount[n.parent] || 0) + 1;
        }
      }
      // Find directories with 0 children
      for (var idx in dirIndices) {
        if (!childCount[idx]) {
          empty.push(loader.allNodes[parseInt(idx)]);
        }
      }

      this.results = empty;
      if (empty.length === 0) {
        status.textContent = "No empty folders found.";
        return;
      }

      status.textContent = "Found " + empty.length + " empty " + (empty.length === 1 ? "folder" : "folders") + ".";
      results.style.display = "block";

      empty.forEach(function (node) {
        var tr = document.createElement("tr");
        var td = document.createElement("td");
        td.style.cssText = "padding:3px 8px;border-bottom:1px solid var(--border-light);font-family:var(--font-mono);font-size:11px;cursor:pointer";
        td.textContent = node.name || "(unnamed)";
        td.title = "Empty directory";
        tr.appendChild(td);
        body.appendChild(tr);
      });
    }
  }

  // Register globally
  if (!window.DiskRaptorModules) window.DiskRaptorModules = {};
  window.DiskRaptorModules.EmptyFolders = EmptyFoldersModule;
  console.log("[Module] EmptyFolders loaded");
})();
