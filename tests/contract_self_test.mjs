#!/usr/bin/env node
/**
 * Pure-Node self-test for the IPC contract module (frontend/contracts.js).
 * Runs without CDP/a running app: loads contracts.js with a stubbed `window`
 * and asserts that documented payload shapes are enforced (and valid payloads
 * pass). This guards against contract drift between the Rust commands and the
 * frontend expectations.
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_PATH = path.resolve(__dirname, "..", "frontend", "contracts.js");

const fakeWindow = {};
const source = fs.readFileSync(CONTRACTS_PATH, "utf8");
// Evaluate the browser script in-process with stubbed globals.
// eslint-disable-next-line no-new-func
new Function("window", "console", source)(fakeWindow, console);

const contract = fakeWindow.__contract;
if (!contract || typeof contract.check !== "function") {
  console.error("FAIL: contracts.js did not define window.__contract");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log(`  ok: ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ── Valid payloads must pass ──────────────────────────────────────────────
ok(
  contract.check("get_app_info", {
    success: true,
    data: { version: "1.0.13", name: "DiskRaptor", os: "win32", arch: "x86_64" },
  }),
  "get_app_info valid",
);
ok(
  contract.check("get_app_info", {
    success: true,
    data: { version: "1.0.13", name: "DiskRaptor", os: "win32", arch: "x86_64", extra: 1 },
  }),
  "get_app_info tolerates extra keys",
);
ok(
  contract.check("list_drives", {
    success: true,
    data: [
      { path: "C:\\", name: "C:", total_bytes: 1, free_bytes: 1, used_bytes: 0, usage_pct: 0, percentFull: 0 },
    ],
  }),
  "list_drives valid",
);
ok(
  contract.check("list_disks", { success: true, data: [{ id: 0, name: "Disk" }] }),
  "list_disks numeric id",
);
ok(
  contract.check("list_disks", { success: true, data: [{ id: "0", name: "Disk" }] }),
  "list_disks string id",
);
ok(
  contract.check("get_memory_info", { success: true, data: { total: 8, used: 4, percentUsed: 50 } }),
  "get_memory_info valid",
);
ok(
  contract.check("get_trash_path", { success: true, data: "C:\\$Recycle.Bin" }),
  "get_trash_path string payload",
);
ok(
  contract.check("get_dup_result", {
    success: true,
    data: { groups: [], wastedBytes: 0, filesScanned: 0, cancelled: false },
  }),
  "get_dup_result valid",
);
ok(
  contract.check("get_scan_result", {
    success: true,
    data: {
      stats: { total_files: 1, total_dirs: 1, total_size: 1, scan_time_ms: 5, size_human: "1 B" },
      root_info: { root_index: 0, total_nodes: 1, total_chunks: 1 },
      scan_id: 1,
    },
  }),
  "get_scan_result valid",
);
ok(contract.check("get_scan_result", { success: false, error: "No scan result" }), "error envelope is valid");
ok(contract.check("some_unknown_command", { anything: true }), "unknown command has no contract");

// ── Violations must fail ──────────────────────────────────────────────────
ok(
  !contract.check("get_app_info", { success: true, data: { version: "1.0.13" } }),
  "get_app_info missing name -> violation",
);
ok(
  !contract.check("get_scan_result", {
    success: true,
    data: { stats: { total_files: 1 }, root_info: {} },
  }),
  "get_scan_result missing nested fields -> violation",
);
ok(
  !contract.check("list_drives", { success: true, data: [{ path: "C:\\" }] }),
  "list_drives missing fields -> violation",
);
ok(
  !contract.check("get_dup_stats", { success: true, data: { phase: 1 } }),
  "get_dup_stats missing fields -> violation",
);
ok(
  !contract.check("is_sandboxed", { success: true, data: {} }),
  "is_sandboxed missing field -> violation",
);
ok(
  !contract.check("get_trash_path", { success: true, data: 42 }),
  "get_trash_path wrong type -> violation",
);
ok(
  !contract.check("list_disks", { success: true, data: [{ id: "0" }] }),
  "list_disks missing name -> violation",
);

console.log(`\nContract self-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
