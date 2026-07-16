/**
 * DiskRaptor E2E Test — against installed EXE at C:\Program Files\DiskRaptor5
 * 
 * Full test suite: app launch, CDP, page content, UI elements, JS modules,
 * Tauri bridge, scan flow, duplicate scan.
 */

import WebSocket from "ws";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const INSTALL_DIR = "C:\\Program Files\\DiskRaptor5";
const BINARY = path.join(INSTALL_DIR, "DiskRaptor.exe");
const CDP_PORT = "9222";
const APP_DIR = "C:\\dev\\DiskRaptor";
const SCREENSHOT_DIR = "C:\\Users\\hansj\\Desktop\\diskraptor_test";

let appProcess = null;
let ws = null;

let passed = 0;
let failed = 0;
const errs = [];
let msgId = 1;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function test(name, fn) {
  return async function () {
    try { await fn(); console.log("  \u2714 " + name); passed++; }
    catch (e) { console.log("  \u2718 " + name + ": " + e.message); errs.push(name + ": " + e.message); failed++; }
  };
}

// ── App management ───────────────────────────────────────────

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log("  [SETUP] Binary not found: " + BINARY);
      reject(new Error("Binary not found"));
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
    appProcess.stdout.on("data", d => { const t = d.toString().trim(); if (t) console.log("  [stdout] " + t); });
    appProcess.stderr.on("data", d => { const t = d.toString().trim(); if (t) console.log("  [stderr] " + t); });
    appProcess.on("exit", (code) => { console.log("  [EXIT code=" + code + "]"); });
    setTimeout(() => resolve(), 12000);
  });
}

function killApp() {
  try { if (appProcess) { appProcess.kill(); appProcess = null; } } catch {}
  try { spawn("taskkill", ["/f", "/im", "DiskRaptor.exe"], { stdio: "ignore" }); } catch {}
  try { spawn("taskkill", ["/f", "/im", "DiskRaptorLauncher.exe"], { stdio: "ignore" }); } catch {}
}

// ── CDP helpers ──────────────────────────────────────────────

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function getPageWSURL(retries) {
  for (let i = 0; i < (retries || 40); i++) {
    try {
      const targets = await fetchJSON(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = targets.find(t => t.type === "page" && t.url && t.url !== "about:blank")
                || targets.find(t => t.type === "page" && t.webSocketDebuggerUrl)
                || targets[0];
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
    setTimeout(() => { sock.off("message", handler); reject(new Error("CDP timeout: " + method)); }, 15000);
  });
}

async function pageEval(sock, fn, arg) {
  const argStr = arg !== undefined ? JSON.stringify(arg) : "";
  const expression = `(${fn.toString()})(${argStr})`;
  const result = await cdpSend(sock, "Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description || "JS exception");
  }
  return result.result?.value;
}

async function takeScreenshot(sock, filename) {
  const result = await cdpSend(sock, "Page.captureScreenshot", { format: "png" });
  const buffer = Buffer.from(result.data, "base64");
  if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filePath = path.join(SCREENSHOT_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  console.log("  [screenshot] " + filePath);
  return filePath;
}

async function bridgeInvoke(sock, cmd, args) {
  const raw = await pageEval(sock, async (opts) => {
    return await window.__TAURI__.invoke(opts.cmd, opts.args || {});
  }, { cmd, args });
  // Normalize potential {success, data} wrapper from Qt bridge
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch {} }
  if (obj && typeof obj === "object" && obj.success !== undefined) {
    if (!obj.success) throw new Error(obj.error || "Bridge invoke failed");
    let data = obj.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch {} }
    return data;
  }
  return obj;
}

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

// ── Main ─────────────────────────────────────────────────────

async function run() {
  console.log("\n  \u2550\u2550 DiskRaptor Installed E2E Test \u2550\u2550\n");

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
  //  SECTION 1: Page & UI Tests
  // ══════════════════════════════════════════

  await test("Page has visible content", async () => {
    const bodyLen = await pageEval(ws, () => document.body?.innerText?.length || 0);
    const htmlLen = await pageEval(ws, () => document.body?.innerHTML?.length || 0);
    console.log("    body text: " + bodyLen + " chars, HTML: " + htmlLen + " chars");
    if (bodyLen === 0 && htmlLen < 100) throw new Error("Page appears empty");
  })();

  await test("UI toolbar and controls present", async () => {
    const uiInfo = await pageEval(ws, () => {
      const buttons = document.querySelectorAll("button");
      const inputs = document.querySelectorAll("input");
      return {
        buttons: Array.from(buttons).map(b => b.textContent?.trim() || b.id || "?"),
        inputs: inputs.length,
        hasScanPath: !!document.getElementById("scan-path"),
      };
    });
    console.log("    buttons: " + JSON.stringify(uiInfo.buttons));
    console.log("    inputs: " + uiInfo.inputs + " | scan-path: " + uiInfo.hasScanPath);
    if (uiInfo.buttons.length === 0 && uiInfo.inputs === 0) throw new Error("No interactive elements");
  })();

  await test("Core HTML structure intact", async () => {
    const structure = await pageEval(ws, () => ({
      hasToolbar: !!document.querySelector(".toolbar, #toolbar, [class*=toolbar]"),
      hasTreePanel: !!document.getElementById("tree-panel"),
      hasTreeScroll: !!document.getElementById("tree-scroll"),
      hasTreeViewport: !!document.getElementById("tree-viewport"),
      hasTopFiles: !!document.getElementById("topfiles-body"),
      hasStats: !!document.getElementById("stat-files"),
      appTitle: document.title || "",
    }));
    console.log("    toolbar: " + structure.hasToolbar + " | tree: " + structure.hasTreePanel +
                " | topfiles: " + structure.hasTopFiles + " | stats: " + structure.hasStats);
    if (!structure.hasToolbar && !structure.hasTreePanel) throw new Error("Core UI structure missing");
  })();

  await test("JS modules are loaded", async () => {
    const mods = await pageEval(ws, () => ({
      VirtualScroll: typeof VirtualScroll === "function",
      ChunkLoader: typeof ChunkLoader === "function",
      TreeView: typeof TreeView === "function",
      TopFilesPanel: typeof TopFilesPanel === "function",
      StatsPanel: typeof StatsPanel === "function",
      hasTauriBridge: typeof window.__TAURI__?.invoke === "function",
      qtBridgeReady: !!(window.__TAURI__ && window.__TAURI__.__qtBridgeReady),
    }));
    console.log("    VirtualScroll: " + mods.VirtualScroll + " ChunkLoader: " + mods.ChunkLoader +
                " TreeView: " + mods.TreeView + " TopFiles: " + mods.TopFilesPanel +
                " Stats: " + mods.StatsPanel);
    if (!mods.ChunkLoader) throw new Error("ChunkLoader not loaded (core module)");
    if (!mods.hasTauriBridge) throw new Error("Tauri IPC bridge not available");
    console.log("    Tauri invoke: " + mods.hasTauriBridge + " | Qt bridge ready: " + mods.qtBridgeReady);
  })();

  await test("Page title is 'DiskRaptor'", async () => {
    const title = await pageEval(ws, () => document.title);
    console.log('    title: "' + title + '"');
    if (!title || title.trim() === "") throw new Error("Empty page title");
    if (!title.includes("DiskRaptor")) throw new Error("Title doesn't mention DiskRaptor");
  })();

  await test("Screenshot captured", async () => {
    await takeScreenshot(ws, "01-initial.png");
  })();

  // ══════════════════════════════════════════
  //  SECTION 2: Tauri Bridge Tests
  // ══════════════════════════════════════════

  console.log("\n  \u2500\u2500 Bridge Tests \u2500\u2500");

  // We need to wait for the Qt bridge to be ready before IPC calls
  console.log("  [BRIDGE] Waiting for Qt bridge...");
  await waitForBridge(ws);
  console.log("  [BRIDGE] Ready\n");

  await test("list_drives returns drives", async () => {
    const drives = await bridgeInvoke(ws, "list_drives");
    if (!Array.isArray(drives)) throw new Error("Not an array: " + typeof drives);
    if (drives.length === 0) throw new Error("No drives found");
    console.log("    found " + drives.length + " drive(s)");
    if (drives.length > 0) console.log("    first: " + (drives[0].path || drives[0].name || "?"));
  })();

  await test("start_scan works", async () => {
    const r = await bridgeInvoke(ws, "start_scan", { path: APP_DIR });
    if (!r) throw new Error("No response from start_scan");
    console.log("    response: " + JSON.stringify(r).slice(0, 200));
  })();

  await test("scan shows progress", async () => {
    let found = false;
    let lastProg = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      try {
        const prog = await bridgeInvoke(ws, "get_scan_progress");
        if (prog) {
          lastProg = prog;
          // Try both camelCase and snake_case field names
          const filesFound = prog.filesFound || prog.files_found || 0;
          const isRunning = prog.isRunning !== undefined ? prog.isRunning : (prog.is_running !== undefined ? prog.is_running : true);
          if (filesFound > 0) { found = true; break; }
          if (!isRunning) { break; }
        }
      } catch (e) {
        if (i === 0) console.log("    [progress poll start]");
      }
    }
    console.log("    progress data: " + JSON.stringify(lastProg));
    if (!found) throw new Error("No scan progress after 60s");
  })();

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

  await test("get_scan_result returns stats", async () => {
    let result = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        result = await bridgeInvoke(ws, "get_scan_result");
        if (result) {
          // Stats nested in result.stats
          const stats = result.stats || result;
          const files = stats.totalFiles || stats.total_files || 0;
          const dirs = stats.totalDirs || stats.total_dirs || 0;
          if (files > 0 || dirs > 0) break;
        }
      } catch {}
    }
    if (!result) throw new Error("No result available");
    const stats = result.stats || result;
    const files = stats.totalFiles || stats.total_files || 0;
    const dirs = stats.totalDirs || stats.total_dirs || 0;
    const size = stats.totalSize || stats.total_size || 0;
    console.log("    files=" + files + " dirs=" + dirs + " size=" + size +
      " (" + (stats.size_human || "?") + ")");
    if (files === 0 && dirs === 0) throw new Error("0 files found");
  })();

  await test("get_home_dir returns path", async () => {
    const home = await bridgeInvoke(ws, "get_home_dir");
    if (!home || typeof home !== "string") throw new Error("Invalid home: " + typeof home);
    console.log("    home: " + home);
  })();

  await test("find_duplicates responds", async () => {
    const r = await bridgeInvoke(ws, "find_duplicates", { path: APP_DIR });
    console.log("    response: " + JSON.stringify(r).slice(0, 100));
  })();

  await test("Event system available", async () => {
    const hasEvent = await pageEval(ws, () => {
      return typeof window.__TAURI__.event?.listen === "function";
    });
    if (!hasEvent) throw new Error("Event system not available");
  })();

  // ══════════════════════════════════════════
  //  SECTION 3: Final
  // ══════════════════════════════════════════

  await test("Final screenshot after all tests", async () => {
    await takeScreenshot(ws, "02-after-tests.png");
  })();

  await test("App still running after all tests", async () => {
    const alive = appProcess.exitCode === null;
    if (!alive) throw new Error("App exited during tests (code: " + appProcess.exitCode + ")");
  })();

  // ══════════════════════════════════════════
  //  Results
  // ══════════════════════════════════════════
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

  if (failed > 0) { console.log("  Some tests FAILED"); process.exit(1); }
  console.log("  All tests PASSED");
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal: " + err.message);
  try { if (ws) ws.close(); } catch {}
  killApp();
  process.exit(1);
});
