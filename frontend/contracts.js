/**
 * DiskRaptor IPC contract.
 *
 * Documents the response shape of every Tauri command the frontend consumes
 * and provides lightweight runtime validators, so a change to a backend
 * payload surfaces immediately (as a console warning) instead of silently
 * breaking the UI. Validators are log-only — they never throw and never alter
 * the response.
 *
 * Loading this module is safe in plain JS: it only defines `window.__contract`.
 */
window.__contract = (function () {
  "use strict";

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const isArr = (v) => Array.isArray(v);
  const isStr = (v) => typeof v === "string";
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const isBool = (v) => typeof v === "boolean";
  const isNumOrStr = (v) => isNum(v) || isStr(v);

  // Each entry describes the payload the frontend reads. `fields` = required
  // object keys, `arrayOf` = array of objects with the given keys, `nested` =
  // required sub-objects. Extra keys are allowed (forward compatible).
  const SHAPES = {
    get_app_info: {
      fields: { version: isStr, name: isStr, os: isStr, arch: isStr },
    },
    get_app_version: {
      fields: { version: isStr, name: isStr },
    },
    get_app_data_dir: {
      fields: { path: isStr },
    },
    is_sandboxed: {
      fields: { sandboxed: isBool },
    },
    request_permissions: {
      fields: { permissions: isStr },
    },
    check_for_updates: {
      fields: { version: isStr },
    },
    get_memory_info: {
      fields: { total: isNum, used: isNum, percentUsed: isNum },
    },
    get_scan_progress: {
      fields: {
        files_found: isNum, dirs_found: isNum, bytes_found: isNum,
        is_running: isBool, current_dir: isStr, elapsed_secs: isNum,
      },
    },
    get_scan_result: {
      fields: { stats: isObj, root_info: isObj, scan_id: isNum },
      nested: {
        stats: {
          total_files: isNum, total_dirs: isNum, total_size: isNum,
          scan_time_ms: isNum, size_human: isStr,
        },
        root_info: { root_index: isNum, total_nodes: isNum, total_chunks: isNum },
      },
    },
    get_stats: {
      fields: {
        total_files: isNum, total_dirs: isNum, total_size: isNum,
        scan_time_ms: isNum, size_human: isStr,
      },
    },
    get_chunk: {
      fields: { chunk_id: isNum, total_chunks: isNum, total_nodes: isNum, nodes: isArr },
    },
    get_children: { arrayOf: { name: isStr, node_type: isNum } },
    list_drives: {
      arrayOf: {
        path: isStr, total_bytes: isNum, free_bytes: isNum, used_bytes: isNum,
        usage_pct: isNum, percentFull: isNum,
      },
    },
    get_volume_stats: {
      arrayOf: { path: isStr, total_bytes: isNum, free_bytes: isNum, used_bytes: isNum },
    },
    list_disks: { arrayOf: { id: isNumOrStr, name: isStr } },
    get_dir_stats: {
      fields: { path: isStr, total_bytes: isNum, files: isNum, dirs: isNum },
    },
    get_dup_stats: {
      fields: { phase: isNum, filesScanned: isNum, groups: isNum, wastedBytes: isNum },
    },
    get_dup_result: {
      fields: {
        groups: isArr, wastedBytes: isNum, filesScanned: isNum, cancelled: isBool,
      },
    },
    list_downloads_candidates: {
      fields: { path: isStr, files: isArr },
    },
    get_trash_path: { type: "string" },
    get_home_dir: { type: "string" },
    pick_directory: { type: "string" },
    get_icon: { type: "string" },
  };

  /**
   * Validate a command response. `payload` may be the raw backend value or a
   * `{ success, data?, error? }` envelope (as produced by the Rust JsonResult
   * helper). Returns true when the payload matches the contract.
   */
  function check(name, payload) {
    const spec = SHAPES[name];
    if (!spec) return true; // unknown command → no contract yet
    let data = payload;
    if (isObj(payload) && "success" in payload) {
      if (payload.success === false) return true; // error responses are valid
      data = payload.data;
    }
    const problems = [];
    if (spec.type === "string") {
      if (!isStr(data)) problems.push("expected a string");
    } else if (spec.arrayOf) {
      if (!isArr(data)) {
        problems.push("expected an array");
      } else {
        data.forEach((item, i) => {
          Object.keys(spec.arrayOf).forEach((k) => {
            if (!(k in item)) problems.push("[" + i + "] missing ." + k);
          });
        });
      }
    } else if (spec.fields) {
      if (!isObj(data)) {
        problems.push("expected an object");
      } else {
        Object.keys(spec.fields).forEach((k) => {
          if (!(k in data)) problems.push("missing ." + k);
        });
        if (spec.nested) {
          Object.keys(spec.nested).forEach((k) => {
            const sub = data[k];
            if (!isObj(sub)) {
              problems.push("." + k + " is not an object");
              return;
            }
            Object.keys(spec.nested[k]).forEach((f) => {
              if (!(f in sub)) problems.push("." + k + "." + f + " missing");
            });
          });
        }
      }
    }
    if (problems.length) {
      console.warn("[contract] " + name + " violated: " + problems.join(", "), data);
      return false;
    }
    return true;
  }

  return {
    check: check,
    names: Object.keys(SHAPES).sort(),
  };
})();
