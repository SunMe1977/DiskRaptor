(function () {
  "use strict";
  window.app = window.app || {};

  window.app.initExport = function (refs) {
    const state = window.app.state;
    const { scanPath, btnExport, loader } = refs;

    // Export button handler (CSV / JSON)
    btnExport.addEventListener("click", async function () {
      try {
        let fmt = prompt(
          (window.__ || function (s) { return s; })("status.export_prompt"),
          "CSV",
        );
        if (!fmt) return;
        fmt = fmt.toUpperCase();
        let stats = state.currentStats || {};
        const scanPathVal = scanPath.value || "";
        if (fmt === "CSV") {
          let csv = "Path,Size,File Count,Dir Count,Type\n";
          const nodes = loader.allNodes || [];
          for (let ni = 0; ni < nodes.length; ni++) {
            const n = nodes[ni];
            if (!n) continue;
            let fullPath = scanPathVal;
            if (n.name && n.name !== scanPathVal) {
              const parts = [n.name];
              let p = n.parent;
              let safety = 0;
              while (
                p !== 4294967295 &&
                p !== undefined &&
                safety < 100
              ) {
                const parent = nodes[p];
                if (parent && parent.name)
                  parts.unshift(parent.name);
                p = parent ? parent.parent : 4294967295;
                safety++;
              }
              fullPath = scanPathVal + "/" + parts.join("/");
            }
            const esc = function (v) {
              return '"' + String(v).replace(/"/g, '""') + '"';
            };
            csv +=
              esc(fullPath) +
              "," +
              (n.size || 0) +
              "," +
              (n.file_count || 0) +
              "," +
              (n.dir_count || 0) +
              "," +
              (n.node_type === 1 ? "File" : "Directory") +
              "\n";
          }
          const blob = new Blob([csv], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "diskraptor-export-" + Date.now() + ".csv";
          a.click();
          URL.revokeObjectURL(url);
        } else {
          const json = JSON.stringify(
            {
              export_time: new Date().toISOString(),
              scan_path: scanPathVal,
              stats: stats,
            },
            null,
            2,
          );
          const blob = new Blob([json], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "diskraptor-export-" + Date.now() + ".json";
          a.click();
          URL.revokeObjectURL(url);
        }
        document.querySelector(".status-bar").textContent = (
          window.__ || function (s) { return s; }
        )("status.exported").replace("{fmt}", fmt);
      } catch (err) {
        console.error("Export failed:", err);
        window.showToast("Export failed: " + err, "error");
      }
    });
  };
})();
