/**
 * DiskRaptor E2E Test – Qt WebEngine Build (Playwright)
 *
 * Connects to Qt WebEngine via CDP (Chromium DevTools Protocol).
 * Set DISKraptor_CDP_PORT=9222 before launching DiskRaptor to
 * enable the remote debugging port.
 * Set DISKraptor_BINARY to override the binary path (for CI installs).
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const APP_DIR = path.resolve(".");
const BUILD_DIR = path.join(APP_DIR, "qt-app", "build_qt");
const INSTALL_DIR = "C:\\Program Files\\DiskRaptor";

// Resolve binary path: env var override > local build > installed location
let BINARY = process.env.DISKraptor_BINARY;
if (!BINARY) {
  const localPath = path.join(BUILD_DIR, "DiskRaptor.exe");
  const installPath = path.join(INSTALL_DIR, "DiskRaptor.exe");
  if (fs.existsSync(localPath)) {
    BINARY = localPath;
  } else if (fs.existsSync(installPath)) {
    BINARY = installPath;
  } else {
    BINARY = localPath; // fallback, will produce clear error in startApp()
  }
}

const CDP_PORT = "9222";
let tp = null;
let browser = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log("\n  [SETUP] Binary not found at:", BINARY);
      console.log("  [SETUP] Tried local build path and", INSTALL_DIR);
      console.log("  [SETUP] Set DISKraptor_BINARY env var to override");
      reject(new Error("Binary not found"));
      return;
    }
    const env = {
      ...process.env,
      DISKraptor_CDP_PORT: CDP_PORT,
    };
    tp = spawn(BINARY, [], {
      cwd: path.dirname(BINARY),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    // Give Qt WebEngine time to start and open the CDP port
    setTimeout(resolve, 8000);
  });
}

function killApp() {
  try {
    if (tp && tp.pid) {
      process.kill(-tp.pid, "SIGKILL");
    }
  } catch {}
  try {
    if (tp) tp.kill();
  } catch {}
}

async function connectBrowser(retries) {
  retries = retries || 40;
  for (let i = 0; i < retries; i++) {
    try {
      browser = await chromium.connectOverCDP(
        "http://localhost:" + CDP_PORT,
        { timeout: 3000 },
      );
      return browser;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("Browser connect failed after " + retries + " retries");
}

async function findPage() {
  for (let i = 0; i < 20; i++) {
    for (const ctx of browser.contexts())
      for (const p of ctx.pages())
        if (p.url().includes("localhost") || p.url().includes("file://"))
          return p;
    await sleep(1000);
  }
  throw new Error("No page found");
}

async function waitForInvoke(p, retries) {
  retries = retries || 30;
  for (let i = 0; i < retries; i++) {
    const ok = await p
      .evaluate(() => typeof window.__TAURI__?.invoke === "function")
      .catch(() => false);
    if (ok) return;
    await sleep(1000);
  }
  throw new Error("Tauri bridge not ready");
}

// ── Helpers ────────────────────────────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────────────────

async function run() {
  console.log("\n  === DiskRaptor Qt E2E Tests ===\n");

  // Setup
  console.log("  [SETUP] Starting app (CDP port " + CDP_PORT + ")...");
  await startApp();
  console.log("  [SETUP] Connecting to WebEngine CDP...");
  await connectBrowser();
  console.log("  [SETUP] Finding page...");
  const page = await findPage();
  console.log("  [SETUP] Waiting for invoke bridge...");
  await waitForInvoke(page);
  console.log("  [SETUP] OK\n");

  // Track page errors
  const pageErrors = [];
  page.on("pageerror", (err) => {
    console.log("  [PAGE_ERROR]", err.message);
    pageErrors.push(err.message);
  });

  // ══════════════════════════════════════════════════════════════════
  //  1. invoke() is available
  // ══════════════════════════════════════════════════════════════════
  await test("invoke() is available", async () => {
    const ok = await page.evaluate(
      () => typeof window.__TAURI__.invoke === "function",
    );
    if (!ok) throw new Error("invoke is not a function");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  2. list_drives returns drive list
  // ══════════════════════════════════════════════════════════════════
  await test("list_drives returns array", async () => {
    const drives = await page.evaluate(async () => {
      return await window.__TAURI__.invoke("list_drives");
    });
    if (!Array.isArray(drives)) throw new Error("Not an array");
    if (drives.length === 0) throw new Error("No drives found");
    console.log("    found " + drives.length + " drive(s)");
    if (drives[0].path) console.log("    first: " + drives[0].path);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  3. Start a scan
  // ══════════════════════════════════════════════════════════════════
  await test("start_scan works", async () => {
    const r = await page.evaluate(async (p) => {
      try {
        const init = await window.__TAURI__.invoke("start_scan", { path: p });
        return { ok: true, scanId: init.scan_id };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, APP_DIR);
    if (!r.ok) throw new Error("start_scan failed: " + (r.error || "unknown"));
    console.log("    scanId:", r.scanId);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  4. Poll and check scan progress
  // ══════════════════════════════════════════════════════════════════
  await test("scan shows progress", async () => {
    let found = false;
    let waited = 0;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      waited++;
      try {
        const prog = await page.evaluate(async () => {
          return await window.__TAURI__.invoke("get_scan_progress");
        });
        if (prog && prog.filesFound > 0) { found = true; break; }
        if (prog && !prog.isRunning) { break; }
      } catch { /* retry */ }
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
        const prog = await page.evaluate(async () => {
          return await window.__TAURI__.invoke("get_scan_progress");
        });
        if (prog && !prog.isRunning) { done = true; break; }
      } catch { /* retry */ }
    }
    if (!done) throw new Error("Scan did not complete within 120s");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  6. Get scan result
  // ══════════════════════════════════════════════════════════════════
  await test("get_scan_result returns stats", async () => {
    let result = null;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try {
        result = await page.evaluate(async () => {
          return await window.__TAURI__.invoke("get_scan_result");
        });
        if (result && result.totalFiles > 0) break;
      } catch { /* retry */ }
    }
    if (!result) throw new Error("No result available");
    console.log("    files=" + result.totalFiles + " dirs=" + result.totalDirs +
      " size=" + result.totalSize);
    if (result.totalFiles === 0) throw new Error("0 files found");
  })();

  // ══════════════════════════════════════════════════════════════════
  //  7. getHomeDir
  // ══════════════════════════════════════════════════════════════════
  await test("get_home_dir returns path", async () => {
    const home = await page.evaluate(async () => {
      return await window.__TAURI__.invoke("get_home_dir");
    });
    if (!home || typeof home !== "string") throw new Error("Invalid home dir");
    console.log("    home:", home);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  8. Duplicate scanner
  // ══════════════════════════════════════════════════════════════════
  await test("find_duplicates starts", async () => {
    const r = await page.evaluate(async (p) => {
      try {
        const res = await window.__TAURI__.invoke("find_duplicates", { path: p });
        return { ok: true, res };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, APP_DIR);
    if (!r.ok) throw new Error(r.error);
  })();

  // ══════════════════════════════════════════════════════════════════
  //  9. Menu events exist
  // ══════════════════════════════════════════════════════════════════
  await test("event system works", async () => {
    const hasEvent = await page.evaluate(() => {
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
  try { if (browser) await browser.close(); } catch {}
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
  try { if (browser) await browser.close(); } catch {}
  killApp();
  process.exit(1);
});
