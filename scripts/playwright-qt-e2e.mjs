/**
 * DiskRaptor E2E Test — Qt WebEngine Build
 *
 * Connects to Qt WebEngine via CDP (Chromium DevTools Protocol) using
 * raw WebSocket. QtWebEngine CDP does NOT support browser-level context
 * management (Browser.setDownloadBehavior etc.), so Playwright's
 * connectOverCDP() won't work. Instead we talk CDP Runtime.* directly.
 *
 * Set DISKraptor_CDP_PORT=9222 before launching.
 * Set DISKraptor_BINARY to override binary path.
 */

import WebSocket from "ws";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(".");
const BUILD_DIR = path.join(APP_DIR, "qt-app", "build");
const INSTALL_DIR = "C:\\Program Files\\DiskRaptor";

// ── Binary resolution ────────────────────────────────────────────────────
let BINARY = process.env.DISKraptor_BINARY;
if (!BINARY) {
  const candidates = [
    path.join(BUILD_DIR, "DiskRaptor.exe"),
    path.join(INSTALL_DIR, "DiskRaptorLauncher.exe"),
    path.join(INSTALL_DIR, "DiskRaptor.exe"),
  ];
  BINARY = candidates.find((f) => fs.existsSync(f)) || candidates[0];
}

const CDP_PORT = "9222";
let tp = null;
let ws = null;

// ── CDP message ID counter ──────────────────────────────────────────────
let msgId = 1;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let appStderr = "";

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log("\n  [SETUP] Binary not found:", BINARY);
      reject(new Error("Binary not found"));
      return;
    }
    tp = spawn(BINARY, [], {
      cwd: path.dirname(BINARY),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    tp.stderr.on("data", (d) => {
      appStderr += d.toString();
    });
    setTimeout(resolve, 12000);
  });
}

function killApp() {
  try {
    if (tp && tp.pid) process.kill(-tp.pid, "SIGKILL");
  } catch {}
  try { if (tp) tp.kill(); } catch {}
}

// ── CDP helpers ─────────────────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

async function getPageWSURL(retries) {
  for (let i = 0; i < (retries || 40); i++) {
    try {
      const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = targets.find(
        (t) => t.type === "page" && t.url && t.url !== "about:blank",
      ) || targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
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
    setTimeout(() => reject(new Error("WS connect timeout")), 10000);
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
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
  });
}

// ── Page evaluation via CDP Runtime.evaluate ────────────────────────────
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
        "JS exception",
    );
  }
  return result.result?.value;
}

// ── Bridge invoke wrapper ───────────────────────────────────────────────
// The Qt bridge (qt-bridge.js) sometimes returns {success, data}
// and sometimes just the data, depending on QWebChannel version and
// how the C++ QString is marshalled. This wrapper normalises both.
async function bridgeInvoke(sock, cmd, args) {
  const raw = await pageEval(sock, async (opts) => {
    return await window.__TAURI__.invoke(opts.cmd, opts.args || {});
  }, { cmd, args });
  return normalizeBridgeResponse(raw);
}

function normalizeBridgeResponse(raw) {
  // Step 1: if we got a string, it's probably a JSON blob from the C++ bridge
  // Parse it to see if it's the {success, data} wrapper
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return raw; }
  }

  // Step 2: check for {success, data} wrapper
  if (obj && typeof obj === "object" && obj.success !== undefined) {
    if (!obj.success) throw new Error(obj.error || "Bridge invoke failed");
    let data = obj.data;
    // Step 3: if data is a JSON string, parse it further
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch {}
    }
    return data;
  }

  // Already unwrapped
  return obj;
}

// ── Helpers ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errs = [];

function test(name, fn) {
  return async function () {
    try {
      await fn();
      console.log("  \u2714 " + name);
      passed++;
    } catch (e) {
      console.log("  \u2718 " + name + ": " + e.message);
      errs.push(name + ": " + e.message);
      failed++;
    }
  };
}

// ── Wait for Qt bridge ──────────────────────────────────────────────────
async function waitForBridge(sock, retries) {
  retries = retries || 90;
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

// ── Main ────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n  === DiskRaptor Qt E2E Tests ===\n");

  // Setup
  console.log("  [SETUP] Starting app (CDP port " + CDP_PORT + ")...");
  await startApp();

  console.log("  [SETUP] Connecting to WebEngine CDP...");
  const wsUrl = await getPageWSURL();
  ws = await cdpConnect(wsUrl);
  console.log("  [SETUP] WebSocket connected");

  console.log("  [SETUP] Enabling Runtime domain...");
  await cdpSend(ws, "Runtime.enable");
  console.log("  [SETUP] Waiting for Qt bridge...");
  await waitForBridge(ws);
  console.log("  [SETUP] OK\n");

  // Track page errors via CDP exception handling
  // (no page.on('pageerror') with raw CDP)

  // ══════════════════════════════════════════════════════════════════
  //  1. invoke() is available
  // ══════════════════════════════════════════════════════════════════
  await test("invoke() is available", async () => {
    const ok = await pageEval(
      ws,
      () => typeof window.__TAURI__.invoke === "function",
    );
    if (!ok) throw new Error("invoke is not a function");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  2. list_drives
  // ══════════════════════════════════════════════════════════════════
  await test("list_drives returns drives", async () => {
    const drives = await bridgeInvoke(ws, "list_drives");
    if (!Array.isArray(drives)) throw new Error("Not an array: " + typeof drives);
    if (drives.length === 0) throw new Error("No drives found");
    console.log("    found " + drives.length + " drive(s)");
    console.log("    first: " + (drives[0].path || drives[0].name || "?"));
  })();

  // ══════════════════════════════════════════════════════════════════
  //  3. start_scan
  // ══════════════════════════════════════════════════════════════════
  await test("start_scan works", async () => {
    const r = await bridgeInvoke(ws, "start_scan", { path: APP_DIR });
    if (!r || (r.status !== "started" && r.status !== "running"))
      throw new Error("Unexpected: " + JSON.stringify(r));
    console.log("    status:", r.status);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  4. Poll scan progress
  // ══════════════════════════════════════════════════════════════════
  await test("scan shows progress", async () => {
    let found = false;
    let waited = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      waited++;
      try {
        const prog = await bridgeInvoke(ws, "get_scan_progress");
        if (prog && prog.filesFound > 0) { found = true; break; }
        if (prog && !prog.isRunning) { break; }
      } catch {}
    }
    if (!found) throw new Error("No progress after " + waited + "s");
    console.log("    progress detected after ~" + waited + "s");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  5. Scan completes
  // ══════════════════════════════════════════════════════════════════
  await test("scan completes", async () => {
    let done = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      try {
        const prog = await bridgeInvoke(ws, "get_scan_progress");
        if (prog && !prog.isRunning) { done = true; break; }
      } catch {}
    }
    if (!done) throw new Error("Scan did not complete within 120s");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  6. get_scan_result
  // ══════════════════════════════════════════════════════════════════
  await test("get_scan_result returns stats", async () => {
    let result = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        result = await bridgeInvoke(ws, "get_scan_result");
        if (result && result.totalFiles > 0) break;
      } catch {}
    }
    if (!result) throw new Error("No result available");
    console.log(
      "    files=" + result.totalFiles +
      " dirs=" + result.totalDirs +
      " size=" + result.totalSize,
    );
    if (result.totalFiles === 0) throw new Error("0 files found");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  7. get_home_dir
  // ══════════════════════════════════════════════════════════════════
  await test("get_home_dir returns path", async () => {
    const home = await bridgeInvoke(ws, "get_home_dir");
    if (!home || typeof home !== "string") throw new Error("Invalid home: " + typeof home);
    console.log("    home:", home);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  8. find_duplicates (placeholder in Qt backend)
  // ══════════════════════════════════════════════════════════════════
  await test("find_duplicates responds", async () => {
    const r = await bridgeInvoke(ws, "find_duplicates", { path: APP_DIR });
    // Accept either array (placeholder) or "started"/status string
    console.log("    response:", Array.isArray(r) ? r.length + " groups (placeholder)" : JSON.stringify(r));
  })();

  // ══════════════════════════════════════════════════════════════════
  //  9. Event system
  // ══════════════════════════════════════════════════════════════════
  await test("event system works", async () => {
    const hasEvent = await pageEval(ws, () => {
      return typeof window.__TAURI__.event?.listen === "function";
    });
    if (!hasEvent) throw new Error("Event system not available");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  Results
  // ══════════════════════════════════════════════════════════════════
  console.log("\n  " + "\u2500".repeat(44));
  console.log("  Passed: " + passed + "   Failed: " + failed);
  if (errs.length > 0) {
    console.log("  Failures:");
    for (const e of errs) console.log("    \u2718 " + e);
  }
  console.log("  " + "\u2500".repeat(50) + "\n");

  // Cleanup
  try { if (ws) ws.close(); } catch {}
  killApp();

  if (failed > 0) {
    console.log("  Some tests FAILED");
    process.exit(1);
  }
  console.log("  All tests PASSED");
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal:", err.message);
  if (appStderr) console.error("App stderr (last 500):", appStderr.slice(-500));
  try { if (ws) ws.close(); } catch {}
  killApp();
  process.exit(1);
});
