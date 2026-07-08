/**
 * DiskRaptor E2E Test — scans the project directory (fast, ~1s).
 *
 * Tests the complete pipeline: start_scan → poll progress → get_result → get_chunk → get_children.
 * Uses WebView2 remote debugging via CDP.
 *
 * Run: cd src-tauri && cargo build --release && cd .. && node e2e-test.mjs
 *
 * NOTE: Tauri v1 auto-converts snake_case Rust params to camelCase.
 * Use camelCase in JS invoke() calls.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(".");
const BINARY = path.join(APP_DIR, "target", "release", "diskraptor.exe");
const TEST_PORT = "9222";
let tp = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log("\n  [SETUP] Binary not found at: " + BINARY);
      console.log("  [SETUP] Run: cd src-tauri && cargo build --release\n");
      reject(new Error("Binary not found"));
      return;
    }
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=" + TEST_PORT,
    };
    tp = spawn(BINARY, [], {
      cwd: APP_DIR,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    tp.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    tp.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.log(
          "  [EXIT code=" + code + "]",
          stderr.trim().split("\n").slice(-2).join("\n"),
        );
      }
    });
    setTimeout(resolve, 4000);
  });
}

function kill() {
  try {
    if (tp) tp.kill();
  } catch {}
}

async function run() {
  console.log("\n  === DiskRaptor E2E Test ===\n");

  console.log("  [SETUP] Starting app...");
  await startApp();

  console.log("  [SETUP] Connecting to WebView2 (port " + TEST_PORT + ")...");
  let browser;
  for (let i = 0; i < 30; i++) {
    try {
      browser = await chromium.connectOverCDP("http://localhost:" + TEST_PORT, {
        timeout: 3000,
      });
      break;
    } catch {
      await sleep(1000);
    }
  }
  if (!browser) {
    console.log("  FAIL: Could not connect to WebView2");
    kill();
    process.exit(1);
  }

  console.log("  [SETUP] Finding Tauri page...");
  let page;
  for (let i = 0; i < 20; i++) {
    for (const ctx of browser.contexts())
      for (const p of ctx.pages())
        if (p.url().includes("tauri") || p.url() === "about:blank") {
          page = p;
          break;
        }
    if (page) break;
    await sleep(1000);
  }
  if (!page) {
    console.log("  FAIL: No Tauri page found");
    kill();
    process.exit(1);
  }

  page.on("pageerror", (err) => console.log("  [PAGE_ERROR]", err.message));

  console.log("  [SETUP] Waiting for Tauri bridge...");
  for (let i = 0; i < 30; i++) {
    const ok = await page
      .evaluate(() => typeof window.__TAURI__?.invoke === "function")
      .catch(() => false);
    if (ok) break;
    await sleep(1000);
  }

  // ── Helper to safely evaluate ────────────────────────────────
  async function safeEval(fn, arg, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    try {
      return await Promise.race([
        page.evaluate(fn, arg),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), timeoutMs),
        ),
      ]);
    } catch (e) {
      return { error: String(e) };
    }
  }

  // ── Test 1: start_scan ──────────────────────────────────────
  console.log("\n  Test: start_scan...");
  const initResult = await safeEval(async (p) => {
    const r = await window.__TAURI__.invoke("start_scan", { path: p });
    return { ok: true, scanId: r.scan_id };
  }, APP_DIR);
  if (!initResult.ok) {
    console.log("  \u2718 " + initResult.error);
    process.exit(1);
  }
  const sid = initResult.scanId;
  console.log("  \u2714 scan_id: " + sid);

  // ── Test 2: Poll for completion ─────────────────────────────
  console.log("\n  Test: poll for completion...");
  let done = false;
  let lastFiles = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const p = await safeEval(async (id) => {
      const prog = await window.__TAURI__.invoke("get_scan_progress", {
        scanId: id,
      });
      return {
        files: prog.files_found,
        running: prog.is_running,
        phase: prog.phase,
      };
    }, sid);
    if (p.error) {
      console.log("  \u2718 progress failed: " + p.error);
      break;
    }
    if (i % 5 === 0 || p.files !== lastFiles) {
      console.log(
        "    " +
          ((i + 1) * 0.5).toFixed(1) +
          "s: files=" +
          p.files +
          " phase=" +
          p.phase,
      );
      lastFiles = p.files;
    }
    if (!p.running) {
      done = true;
      console.log("  \u2714 Scan completed");
      break;
    }
  }
  if (!done) {
    console.log("  \u2718 Scan did not complete in time");
    process.exit(1);
  }

  // ── Test 3: get_scan_result ─────────────────────────────────
  console.log("\n  Test: get_scan_result...");
  await sleep(500);
  const result = await safeEval(async (id) => {
    const r = await window.__TAURI__.invoke("get_scan_result", { scanId: id });
    if (!r) return null;
    return {
      files: r.stats.total_files,
      dirs: r.stats.total_dirs,
      totalSize: r.stats.total_size,
      nodes: r.root_info.total_nodes,
      chunks: r.root_info.total_chunks,
    };
  }, sid);
  if (result && result.files > 0) {
    console.log(
      "  \u2714 files=" +
        result.files +
        " dirs=" +
        result.dirs +
        " size=" +
        result.totalSize +
        " nodes=" +
        result.nodes +
        " chunks=" +
        result.chunks,
    );
  } else {
    console.log("  \u2718 " + JSON.stringify(result));
    process.exit(1);
  }

  // ── Test 4: get_chunk(0) ────────────────────────────────────
  console.log("\n  Test: get_chunk(0)...");
  const chunk = await safeEval(async (id) => {
    return await window.__TAURI__.invoke("get_chunk", {
      scanId: id,
      chunkIndex: 0,
    });
  }, sid);
  if (chunk && chunk.nodes && chunk.nodes.length > 0) {
    const root = chunk.nodes[0];
    console.log("  \u2714 chunk has " + chunk.nodes.length + " nodes");
    console.log(
      "  \u2714 root: " +
        root.name +
        " size=" +
        root.size +
        " files=" +
        root.file_count,
    );
  } else {
    console.log("  \u2718 " + JSON.stringify(chunk));
    process.exit(1);
  }

  // ── Test 5: get_children(0) ─────────────────────────────────
  console.log("\n  Test: get_children(0)...");
  const children = await safeEval(async (id) => {
    return await window.__TAURI__.invoke("get_children", {
      scanId: id,
      nodeIndex: 0,
    });
  }, sid);
  if (Array.isArray(children)) {
    console.log("  \u2714 root has " + children.length + " children");
    if (children.length > 0)
      console.log(
        "    first: " + children[0].name + " [" + children[0].size + "]",
      );
  } else {
    console.log("  \u2718 " + JSON.stringify(children));
    process.exit(1);
  }

  // ── All passed ─────────────────────────────────────────────
  console.log("\n  " + "=".repeat(45));
  console.log("  \u2714 ALL E2E TESTS PASSED");
  console.log("  " + "=".repeat(45) + "\n");

  kill();
  try {
    if (browser) await browser.close();
  } catch {}
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal:", err.message);
  try {
    if (browser) await browser.close();
  } catch {}
  kill();
  process.exit(1);
});
