/**
 * DiskRaptor E2E Test — Playwright
 *
 * Tests that browse and scan work in the real Tauri app.
 * Uses a SINGLE scan for all data access tests.
 *
 * NOTE: Tauri v1 auto-converts snake_case Rust params to camelCase
 * in the JS IPC layer. Use camelCase in invoke() calls.
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const APP_DIR = path.resolve(".");
const BINARY = path.join(
  APP_DIR,
  "src-tauri",
  "target",
  "release",
  "diskraptor.exe",
);
const TEST_PORT = "9222";
let tp = null;
let browser = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function startApp() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BINARY)) {
      console.log(
        "\n  [SETUP] Binary not found. Run: cd src-tauri && cargo build --release\n",
      );
      reject(new Error("Binary not found"));
      return;
    }
    // WebView2 CDP debugging port
    const env = {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=" + TEST_PORT,
    };
    tp = spawn(BINARY, [], {
      cwd: path.join(APP_DIR, "src-tauri", "target", "release"),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    setTimeout(resolve, 5000);
  });
}

function killApp() {
  try {
    if (tp) {
      tp.kill("SIGKILL");
      tp.kill();
    }
  } catch {}
}

async function connectBrowser(r) {
  r = r || 30;
  for (let i = 0; i < r; i++) {
    try {
      browser = await chromium.connectOverCDP("http://localhost:" + TEST_PORT, {
        timeout: 3000,
      });
      return browser;
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("Browser connect failed");
}

async function findPage() {
  for (let i = 0; i < 20; i++) {
    for (const ctx of browser.contexts())
      for (const p of ctx.pages())
        if (p.url().includes("tauri") || p.url().includes("about:blank"))
          return p;
    await sleep(1000);
  }
  throw new Error("No page found");
}

async function waitForTauri(p, r) {
  r = r || 30;
  for (let i = 0; i < r; i++) {
    const ok = await p
      .evaluate(() => typeof window.__TAURI__?.invoke === "function")
      .catch(() => false);
    if (ok) return;
    await sleep(1000);
  }
  throw new Error("Tauri bridge not ready");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let errs = [];

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

// ── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n  === DiskRaptor E2E Tests ===\n");

  // Setup
  console.log("  [SETUP] Starting app...");
  await startApp();
  console.log("  [SETUP] Connecting to WebView2...");
  await connectBrowser();
  console.log("  [SETUP] Finding page...");
  const page = await findPage();
  console.log("  [SETUP] Waiting for Tauri bridge...");
  await waitForTauri(page);
  console.log("  [SETUP] OK\n");

  // Error tracking
  const pageErrors = [];
  page.on("pageerror", (err) => {
    console.log("  [PAGE_ERROR]", err.message);
    pageErrors.push(err.message);
  });

  // ═════════════════════════════════════════════════════════════════════
  //  1. invoke exists
  // ═════════════════════════════════════════════════════════════════════
  await test("invoke() is available", async () => {
    const ok = await page.evaluate(
      () => typeof window.__TAURI__.invoke === "function",
    );
    if (!ok) throw new Error("invoke is not a function");
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  2. pick_directory works
  // ═════════════════════════════════════════════════════════════════════
  await test("pick_directory returns a path", async () => {
    const r = await page.evaluate(async () => {
      try {
        const p = await window.__TAURI__.invoke("pick_directory");
        return { ok: true, path: p };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    });
    if (!r.ok) throw new Error(r.error);
    if (!r.path || r.path.length < 2) throw new Error("No path");
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  3. Start a scan of the project directory
  // ═════════════════════════════════════════════════════════════════════
  let scanId = null;
  await test("start_scan works", async () => {
    const r = await page.evaluate(async (p) => {
      try {
        const init = await window.__TAURI__.invoke("start_scan", { path: p });
        return { ok: true, scanId: init.scan_id };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, APP_DIR);
    if (!r.ok) throw new Error(r.error);
    scanId = r.scanId;
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  4. Poll until scan completes
  // ═════════════════════════════════════════════════════════════════════
  await test("scan completes and returns result", async () => {
    if (!scanId) throw new Error("No scanId from previous test");

    let done = false;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      const p = await page.evaluate(async (id) => {
        try {
          const prog = await window.__TAURI__.invoke("get_scan_progress", {
            scanId: id,
          });
          return { phase: prog.phase, running: prog.is_running };
        } catch {
          return null;
        }
      }, scanId);
      if (p && (!p.running || p.phase === 3)) {
        done = true;
        break;
      }
    }
    if (!done) throw new Error("Scan did not complete within timeout");

    await sleep(1000);
    let result = null;
    for (let i = 0; i < 20; i++) {
      result = await page.evaluate(async (id) => {
        try {
          const r = await window.__TAURI__.invoke("get_scan_result", {
            scanId: id,
          });
          if (!r) return null;
          return {
            files: r.stats.total_files,
            dirs: r.stats.total_dirs,
            totalSize: r.stats.total_size,
            totalNodes: r.root_info.total_nodes,
            totalChunks: r.root_info.total_chunks,
          };
        } catch {
          return null;
        }
      }, scanId);
      if (result) break;
      await sleep(500);
    }
    if (!result) throw new Error("No scan result available");

    console.log(
      "    files=" +
        result.files +
        " dirs=" +
        result.dirs +
        " size=" +
        result.totalSize +
        " nodes=" +
        result.totalNodes +
        " chunks=" +
        result.totalChunks,
    );

    if (result.files === 0 && result.dirs === 0)
      throw new Error("Scan found 0 files");
    if (result.totalNodes === 0) throw new Error("Tree has 0 nodes");
    if (result.totalChunks === 0) throw new Error("No chunks produced");
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  5. Get chunk 0 (root node)
  // ═════════════════════════════════════════════════════════════════════
  await test("chunk 0 has valid root node", async () => {
    if (!scanId) throw new Error("No scanId");
    const chunk = await page.evaluate(async (id) => {
      try {
        return await window.__TAURI__.invoke("get_chunk", {
          scanId: id,
          chunkIndex: 0,
        });
      } catch (e) {
        return { error: String(e) };
      }
    }, scanId);

    if (chunk.error) throw new Error("get_chunk failed: " + chunk.error);
    if (!chunk.nodes || chunk.nodes.length === 0)
      throw new Error("Chunk 0 empty");

    const root = chunk.nodes[0];
    if (!root.name) throw new Error("Root has no name");
    if (root.parent !== 4294967295) throw new Error("Root parent not u32::MAX");
    console.log(
      "    root: " +
        root.name +
        " | size=" +
        root.size +
        " files=" +
        root.file_count +
        " type=" +
        root.node_type,
    );
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  6. get_children for root
  // ═════════════════════════════════════════════════════════════════════
  await test("get_children returns root children", async () => {
    if (!scanId) throw new Error("No scanId");
    const children = await page.evaluate(async (id) => {
      try {
        return await window.__TAURI__.invoke("get_children", {
          scanId: id,
          nodeIndex: 0,
        });
      } catch (e) {
        return { error: String(e) };
      }
    }, scanId);

    if (children && children.error) throw new Error(children.error);
    if (!Array.isArray(children)) throw new Error("Not an array");

    console.log("    root children: " + children.length);
    if (children.length > 0) {
      console.log(
        "    first: " + children[0].name + " [" + children[0].size + "]",
      );
    }
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  7. get_stats
  // ═════════════════════════════════════════════════════════════════════
  await test("get_stats returns correct totals", async () => {
    if (!scanId) throw new Error("No scanId");
    const stats = await page.evaluate(async (id) => {
      try {
        return await window.__TAURI__.invoke("get_stats", { scanId: id });
      } catch (e) {
        return { error: String(e) };
      }
    }, scanId);

    if (stats.error) throw new Error(stats.error);
    if (typeof stats.total_files !== "number")
      throw new Error("total_files missing");
    if (typeof stats.total_dirs !== "number")
      throw new Error("total_dirs missing");
    console.log(
      "    stats: files=" +
        stats.total_files +
        " dirs=" +
        stats.total_dirs +
        " size=" +
        stats.total_size +
        " ms=" +
        stats.scan_time_ms,
    );
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  8. Release scan
  // ═════════════════════════════════════════════════════════════════════
  await test("release_scan works", async () => {
    if (!scanId) throw new Error("No scanId");
    await page.evaluate(async (id) => {
      try {
        await window.__TAURI__.invoke("release_scan", { scanId: id });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }, scanId);
  })();

  // ═════════════════════════════════════════════════════════════════════
  //  Results
  // ═════════════════════════════════════════════════════════════════════
  console.log("\n  \u2500\u2500 Results " + "\u2500".repeat(38));
  console.log("  Passed: " + passed + "   Failed: " + failed);
  if (errs.length > 0) {
    console.log("  Failures:");
    for (const e of errs) console.log("    \u2718 " + e);
  }
  console.log("  " + "\u2500".repeat(50) + "\n");

  // Cleanup
  try {
    if (browser) await browser.close();
  } catch {}
  killApp();

  if (failed > 0) process.exit(1);
  console.log("  All tests PASSED");
  process.exit(0);
}

run().catch(async (err) => {
  console.error("Fatal:", err.message);
  try {
    if (browser) await browser.close();
  } catch {}
  killApp();
  process.exit(1);
});
