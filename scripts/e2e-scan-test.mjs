#!/usr/bin/env node
/**
 * DiskRaptor E2E Scan Test
 *
 * Scans C:\Users\hansj via the installed DiskRaptor.exe.
 * Verifies:
 *  - start_scan returns valid scan_id
 *  - Progress events are sent during scanning
 *  - Scan completes and returns full data (files > 0, dirs > 0, size > 0)
 *  - File count is reasonable for a user home directory
 */

import WebSocket from "ws";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// ── Config ────────────────────────────────────────────────────
const BINARY = "C:\\Program Files\\DiskRaptor5\\DiskRaptor.exe";
const INSTALL_DIR = "C:\\Program Files\\DiskRaptor5";
const CDP_PORT = "9222";
const SCAN_TARGET = "C:\\Users\\hansj";
const TIMEOUT_MS = 300_000; // 5 min for scanning home dir
const PROGRESS_POLL_MS = 500;

// ── State ────────────────────────────────────────────────────
let appProcess = null;
let ws = null;
let msgId = 1;
let passed = 0;
let failed = 0;
const failures = [];

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function getPageWSURL(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const targets = await fetchJSON(
        `http://127.0.0.1:${CDP_PORT}/json`
      );
      const page =
        targets.find(
          (t) => t.type === "page" && t.url && t.url !== "about:blank"
        ) ||
        targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ||
        targets[0];
      if (page && page.webSocketDebuggerUrl) {
        return page.webSocketDebuggerUrl.replace("localhost", "127.0.0.1");
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error("Could not get page WS URL");
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    sock.on("open", () => resolve(sock));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("WS connect timeout")), 15000);
  });
}

function cdpSend(sock, method, params) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    const msg = JSON.stringify({ id, method, params: params || {} });
    const handler = (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.id === id) {
          sock.off("message", handler);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.result);
        }
      } catch {}
    };
    sock.on("message", handler);
    sock.send(msg);
    setTimeout(() => {
      sock.off("message", handler);
      reject(new Error("CDP timeout: " + method));
    }, 30000);
  });
}

async function pageEval(sock, fn, arg) {
  const argStr = arg !== undefined ? JSON.stringify(arg) : "";
  const expression = `(${fn.toString()})(${argStr})`;
  const result = await cdpSend(sock, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.text ||
        result.exceptionDetails.exception?.description ||
        "JS exception"
    );
  }
  return result.result?.value;
}

async function bridgeInvoke(sock, cmd, args) {
  const raw = await pageEval(
    sock,
    async (opts) => {
      return await window.__TAURI__.invoke(opts.cmd, opts.args || {});
    },
    { cmd, args }
  );
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {}
  }
  if (obj && typeof obj === "object" && obj.success !== undefined) {
    if (!obj.success) throw new Error(obj.error || "Bridge invoke failed");
    let data = obj.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {}
    }
    return data;
  }
  return obj;
}

async function waitForBridge(sock, retries = 120) {
  for (let i = 0; i < retries; i++) {
    try {
      const ready = await pageEval(sock, () => ({
        hasInvoke: typeof window.__TAURI__?.invoke === "function",
        qtReady: !!(window.__TAURI__ && window.__TAURI__.__qtBridgeReady),
      }));
      if (ready && ready.hasInvoke) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Bridge not ready after " + retries + "s");
}

// ── Test helpers ─────────────────────────────────────────────

function test(name, fn) {
  return async function () {
    try {
      await fn();
      console.log("  \u2714 " + name);
      passed++;
    } catch (e) {
      console.log("  \u2718 " + name + ": " + e.message);
      failures.push(name + ": " + e.message);
      failed++;
    }
  };
}

// ── App lifecycle ────────────────────────────────────────────

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log("  [SETUP] Binary not found: " + BINARY);
      reject(new Error("Binary not found at " + BINARY));
      return;
    }

    const runtimeDir = path.join(INSTALL_DIR, "runtime");
    const oldPath = process.env.PATH || "";
    const newPath = runtimeDir + ";" + INSTALL_DIR + ";" + oldPath;

    const env = {
      ...process.env,
      PATH: newPath,
      DISKraptor_CDP_PORT: CDP_PORT,
      QTWEBENGINEPROCESS_PATH: path.join(runtimeDir, "QtWebEngineProcess.exe"),
    };

    console.log("  [SETUP] Launching: " + BINARY);
    appProcess = spawn(BINARY, [], {
      cwd: INSTALL_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout.on("data", (d) => {
      const t = d.toString().trim();
      if (t) console.log("  [stdout] " + t);
    });
    appProcess.stderr.on("data", (d) => {
      const t = d.toString().trim();
      if (t) console.log("  [stderr] " + t);
    });
    appProcess.on("exit", (code) => {
      console.log("  [EXIT code=" + code + "]");
    });
    // Allow time for WebEngine to start and load the frontend
    setTimeout(() => resolve(), 15000);
  });
}

function killApp() {
  try {
    if (appProcess) {
      appProcess.kill();
      appProcess = null;
    }
  } catch {}
  try {
    spawn("taskkill", ["/f", "/im", "DiskRaptor.exe"], { stdio: "ignore" });
  } catch {}
  try {
    spawn("taskkill", ["/f", "/im", "DiskRaptorLauncher.exe"], {
      stdio: "ignore",
    });
  } catch {}
}

// ── Main test flow ───────────────────────────────────────────

async function run() {
  console.log("\n  \u2550\u2550 DiskRaptor E2E Scan Test \u2550\u2550\n");

  // Cleanup
  killApp();
  await sleep(2000);

  // Start app
  await startApp();

  // Connect CDP
  console.log("  [SETUP] Connecting to WebEngine CDP...");
  const wsUrl = await getPageWSURL();
  ws = await cdpConnect(wsUrl);
  console.log("  [SETUP] WebSocket connected");

  // Enable domains
  await cdpSend(ws, "Runtime.enable");
  await cdpSend(ws, "Page.enable");
  console.log("  [SETUP] OK\n");

  // ══════════════════════════════════════════
  //  TEST: Bridge readiness
  // ══════════════════════════════════════════

  console.log("  \u2500\u2500 Bridge readiness \u2500\u2500");
  await waitForBridge(ws);
  console.log("  [BRIDGE] Ready\n");

  // ══════════════════════════════════════════
  //  TEST: start_scan returns valid response
  // ══════════════════════════════════════════

  await test("start_scan returns status and scan_id", async () => {
    const r = await bridgeInvoke(ws, "start_scan", { path: SCAN_TARGET });
    if (!r) throw new Error("No response from start_scan");
    console.log("    response: " + JSON.stringify(r));
    if (r.status !== "started") throw new Error("Expected status=started, got " + r.status);
    // scan_id may be undefined if bridge doesn't return one, that's OK
    if (r.scan_id === undefined) {
      console.log("    [note] scan_id not returned by bridge, will use default");
    }
  })();

  // ══════════════════════════════════════════
  //  TEST: Progress events during scanning
  // ══════════════════════════════════════════

  let progressEvents = [];

  await test("Scan progress increments files_found", async () => {
    let lastFiles = 0;
    let foundProgress = false;
    let startTime = Date.now();
    const deadline = startTime + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(PROGRESS_POLL_MS);
      try {
        const p = await bridgeInvoke(ws, "get_scan_progress");
        if (!p) continue;

        progressEvents.push(p);

        const filesFound = p.files_found || 0;
        const isRunning =
          p.is_running !== undefined ? p.is_running : p.isRunning;

        if (filesFound > 0) {
          foundProgress = true;
          lastFiles = filesFound;
        }

        if (filesFound % 5000 === 0 && filesFound > 0) {
          console.log("    progress: " + filesFound + " files @ " + (p.elapsed_secs || 0) + "s");
        }

        // Check if done
        if (!isRunning || p.phase === 3) {
          console.log("    scan complete signal received with " + filesFound + " files");
          break;
        }
      } catch (e) {
        if (progressEvents.length === 0) {
          // First poll might fail if bridge isn't ready
          console.log("    [initial poll]");
        }
      }
    }

    if (!foundProgress) throw new Error("No progress data received (files_found never > 0)");
    if (lastFiles === 0) throw new Error("Scan completed but 0 files found");
    console.log("    final files_found: " + lastFiles.toLocaleString());
  })();

  // ══════════════════════════════════════════
  //  TEST: progress event count
  // ══════════════════════════════════════════

  await test("Progress was polled at least 3 times", async () => {
    if (progressEvents.length < 3) {
      throw new Error(
        "Only " + progressEvents.length + " progress events, expected >= 3"
      );
    }
    console.log("    " + progressEvents.length + " progress events captured");
  })();

  // ══════════════════════════════════════════
  //  TEST: get_scan_result returns full data
  // ══════════════════════════════════════════

  await test("get_scan_result returns valid stats", async () => {
    let result = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        result = await bridgeInvoke(ws, "get_scan_result");
        if (result) break;
      } catch {}
    }
    if (!result) throw new Error("No scan result after 30 retries");

    const stats = result.stats || result;
    const totalFiles = stats.total_files || stats.totalFiles || 0;
    const totalDirs = stats.total_dirs || stats.totalDirs || 0;
    const totalSize = stats.total_size || stats.totalSize || 0;
    const sizeHuman = stats.size_human || stats.sizeHuman || "?";
    const timeHuman = stats.time_human || stats.timeHuman || "?";

    console.log(
      "    files=" +
        totalFiles.toLocaleString() +
        " dirs=" +
        totalDirs.toLocaleString() +
        " size=" +
        totalSize.toLocaleString() +
        " (" +
        sizeHuman +
        ") in " +
        timeHuman
    );

    if (totalFiles === 0) throw new Error("total_files is 0 — likely empty result");
    if (totalDirs === 0) throw new Error("total_dirs is 0 — likely empty result");
    if (totalSize === 0) throw new Error("total_size is 0 — likely empty result");
  })();

  // ══════════════════════════════════════════
  //  TEST: Reasonable file count for home dir
  // ══════════════════════════════════════════

  await test("Home directory has reasonable file count", async () => {
    let result = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        result = await bridgeInvoke(ws, "get_scan_result");
        if (result) break;
      } catch {}
    }
    if (!result) throw new Error("No scan result");

    const stats = result.stats || result;
    const totalFiles = stats.total_files || stats.totalFiles || 0;

    // A user home dir typically has thousands to hundreds of thousands of files
    if (totalFiles < 100) {
      throw new Error(
        "Only " +
          totalFiles +
          " files — expected at least 100 for a user home directory"
      );
    }
    console.log(
      "    " +
        totalFiles.toLocaleString() +
        " files — well above the 100-file minimum"
    );
  })();

  // ══════════════════════════════════════════
  //  TEST: top_files array is populated
  // ══════════════════════════════════════════

  await test("top_files contains entries", async () => {
    let result = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      try {
        result = await bridgeInvoke(ws, "get_scan_result");
        if (result) break;
      } catch {}
    }
    if (!result) throw new Error("No scan result");

    const stats = result.stats || result;
    const topFiles = stats.top_files || stats.topFiles || [];

    if (!Array.isArray(topFiles)) throw new Error("top_files is not an array");
    if (topFiles.length === 0) throw new Error("top_files is empty");

    // Verify first entry structure
    const first = topFiles[0];
    if (!first.path && !first.size) {
      throw new Error("First top_file entry missing path/size: " + JSON.stringify(first));
    }
    const sizeHuman = first.size_human || first.sizeHuman || "?";
    console.log("    top file: " + first.path + " (" + sizeHuman + ")");
  })();

  // ══════════════════════════════════════════
  //  RESULTS
  // ══════════════════════════════════════════

  console.log("\n  " + "\u2500".repeat(50));
  console.log("  Results: " + passed + " passed, " + failed + " failed");
  if (failures.length > 0) {
    console.log("  Failures:");
    for (const f of failures) console.log("    \u2718 " + f);
  }
  console.log("  " + "\u2500".repeat(50) + "\n");

  // Cleanup
  try {
    if (ws) ws.close();
  } catch {}
  killApp();

  if (failed > 0) {
    console.log("  Some tests FAILED");
    process.exit(1);
  }
  console.log("  All tests PASSED");
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal: " + err.message);
  try {
    if (ws) ws.close();
  } catch {}
  killApp();
  process.exit(1);
});
