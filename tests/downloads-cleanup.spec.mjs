/**
 * DiskRaptor Downloads Cleanup UI Test
 * Launches the app, scans Downloads, and verifies the cleanup panel appears.
 *
 * Usage: node tests/downloads-cleanup.spec.mjs
 *
 * Requires:
 *   - dist/DiskRaptor binary (build with: bash build.sh)
 *   - dist/frontend/ (deployed with build)
 *   - dist/libdiskraptor_scanner.so
 *   - LD_LIBRARY_PATH pointing to Qt6 libs (set via dist/lib/ or system)
 *   - A display ($DISPLAY)
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9333;
const BIN_PATH = path.resolve(__dirname, "..", "dist", "DiskRaptor");
const DIST_DIR = path.resolve(__dirname, "..", "dist");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(data));
          }
        });
      })
      .on("error", reject);
  });
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  ws.on("message", (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      }
    } catch {}
  });
  await new Promise((r, f) => {
    ws.on("open", r);
    ws.on("error", f);
    setTimeout(() => f(new Error("WS timeout")), 10000);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(
          () => reject(new Error(`CDP timeout: ${method}`)),
          60000,
        );
      });
    },
    close() {
      ws.close();
    },
  };
}

function cdpVal(r) {
  return r?.result?.result?.value;
}

async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return cdpVal(r);
}

function killAll() {
  try {
    execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" });
  } catch {}
  try {
    execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" });
  } catch {}
}

async function main() {
  let passed = 0;
  let failed = 0;
  let cdp = null;

  function assert(label, ok, detail) {
    if (ok) {
      console.log(`  \u2713 ${label}`);
      passed++;
    } else {
      console.log(`  \u2717 ${label}${detail ? " -- " + detail : ""}`);
      failed++;
    }
  }

  console.log("\n=== Downloads Cleanup UI Test ===\n");
  killAll();
  await sleep(2000);

  if (!fs.existsSync(BIN_PATH)) {
    console.error(`Binary not found: ${BIN_PATH}`);
    console.log("Run 'bash build.sh' first");
    process.exit(1);
  }
  console.log(`Binary: ${BIN_PATH}`);

  // Launch app
  console.log("\nLaunching app...");
  const child = spawn(BIN_PATH, [], {
    cwd: DIST_DIR,
    env: {
      ...process.env,
      DISKraptor_CDP_PORT: String(CDP_PORT),
      LD_LIBRARY_PATH: `/usr/lib/diskraptor:${DIST_DIR}/lib:${DIST_DIR}:${process.env.LD_LIBRARY_PATH || ""}`,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for CDP page
  console.log("Waiting for CDP endpoint...");
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(
        `http://127.0.0.1:${CDP_PORT}/json/list`,
      );
      if (
        Array.isArray(pages) &&
        pages.length > 0 &&
        pages[0].webSocketDebuggerUrl
      ) {
        wsUrl = pages[0].webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }
  assert("App launched with CDP", !!wsUrl, wsUrl ? "" : "CDP endpoint never appeared");
  if (!wsUrl) {
    killAll();
    process.exit(1);
  }

  // Connect CDP
  try {
    cdp = await connectCDP(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Console.enable");
    assert("CDP connected", true);
  } catch (e) {
    assert("CDP connected", false, e.message);
    killAll();
    process.exit(1);
  }

  // Wait for bridge
  console.log("\nWaiting for Qt bridge...");
  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(
      cdp,
      "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)",
    );
    if (val === true) {
      bridgeOk = true;
      break;
    }
    await sleep(500);
  }
  assert("Bridge ready", bridgeOk);
  if (!bridgeOk) {
    killAll();
    process.exit(1);
  }

  // Click "Scan Downloads"
  console.log("\nClicking Scan Downloads...");
  await jsExpr(cdp, "document.getElementById('btn-tools').click()");
  await sleep(300);
  await jsExpr(
    cdp,
    `document.querySelector('.tools-item[data-action="scan-downloads"]').click()`,
  );
  console.log("  Scan Downloads clicked");

  // Wait for progress overlay
  console.log("\nWaiting for scan progress...");
  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(
      cdp,
      "document.getElementById('progress-overlay')?.classList.contains('active')",
    );
    if (o === true) {
      overlayShown = true;
      break;
    }
  }
  assert("Scan progress overlay appeared", overlayShown);

  // Monitor scan progress
  console.log("\nMonitoring scan...");
  let maxFiles = 0;
  let completed = false;

  for (let i = 0; i < 1200; i++) {
    await sleep(500);
    try {
      const json = await jsExpr(
        cdp,
        `JSON.stringify({
          ov: document.getElementById('progress-overlay')?.classList.contains('active'),
          st: (document.querySelector('.status-bar')?.textContent || ''),
          files: (document.getElementById('progress-files')?.textContent || '0').replace(/,/g, '')
        })`,
      );
      const m = JSON.parse(json || "{}");
      const f = parseInt(m.files) || 0;
      if (f > maxFiles) maxFiles = f;

      if (!m.ov && maxFiles > 0) {
        completed = true;
        break;
      }
      if (m.st?.includes("Complete")) {
        completed = true;
        break;
      }
      if (m.st?.includes("Error")) {
        console.warn(`  Scan error: ${m.st}`);
        break;
      }
      if (i % 20 === 0 && maxFiles > 0) {
        console.log(`  files: ${maxFiles.toLocaleString()}`);
      }
    } catch {}
  }

  await sleep(3000);
  assert("Scan completed", completed, `maxFiles=${maxFiles}`);

  // Check for cleanup panel
  console.log("\nChecking cleanup panel...");
  let panelFound = false;
  let panelText = "";
  for (let i = 0; i < 30; i++) {
    panelText = await jsExpr(
      cdp,
      `(document.getElementById('cleanup-panel')?.textContent || '').trim()`,
    );
    if (panelText && panelText.length > 0) {
      panelFound = true;
      break;
    }
    // Check status bar for messages
    const statusText = await jsExpr(
      cdp,
      "document.querySelector('.status-bar')?.textContent || ''",
    );
    if (statusText.includes("enough data") || statusText.includes("No cleanable")) {
      console.log(`  Status: "${statusText}"`);
      break;
    }
    await sleep(500);
  }

  if (panelFound) {
    const hasItems = /\d+\s*items/.test(panelText);
    const hasReclaimable = /reclaimable/.test(panelText);
    const itemCount = panelText.match(/(\d+)\s*items/)?.[1] || "?";

    assert("Cleanup panel appeared", true);
    assert("Panel shows item count", hasItems, `text="${panelText.slice(0,80)}"`);
    assert("Panel shows reclaimable total", hasReclaimable);
    console.log(`  Items found: ${itemCount}`);

    // Check checkboxes
    const checkboxCount = await jsExpr(
      cdp,
      `document.querySelectorAll('#cleanup-panel .cleanup-item input[type="checkbox"]').length`,
    );
    assert("Cleanable items have checkboxes", checkboxCount > 0, `count=${checkboxCount}`);

    // Check action buttons
    const hasSelectAll = await jsExpr(
      cdp,
      "!!document.getElementById('cleanup-select-all')",
    );
    const hasMoveTrash = await jsExpr(
      cdp,
      "!!document.getElementById('cleanup-move-trash')",
    );
    const hasClose = await jsExpr(
      cdp,
      "!!document.getElementById('cleanup-close')",
    );
    assert("Select All button exists", hasSelectAll);
    assert("Move to Trash button exists", hasMoveTrash);
    assert("Close button exists", hasClose);

    // Test Select All toggle
    const beforeState = await jsExpr(
      cdp,
      `Array.from(document.querySelectorAll('#cleanup-panel .cleanup-item input[type="checkbox"]')).every(cb => cb.checked)`,
    );
    await jsExpr(cdp, "document.getElementById('cleanup-select-all').click()");
    await sleep(200);
    const afterState = await jsExpr(
      cdp,
      `Array.from(document.querySelectorAll('#cleanup-panel .cleanup-item input[type="checkbox"]')).every(cb => cb.checked)`,
    );
    assert("Select All toggles checkboxes", beforeState !== afterState);

    // Test Close button
    await jsExpr(cdp, "document.getElementById('cleanup-close').click()");
    await sleep(300);
    const panelHidden = await jsExpr(
      cdp,
      `(document.getElementById('cleanup-panel')?.style?.display || '') === 'none'`,
    );
    assert("Close button hides panel", panelHidden);
  } else {
    const statusText = await jsExpr(
      cdp,
      "document.querySelector('.status-bar')?.textContent || ''",
    );
    assert("Cleanup panel appeared", false, `status="${statusText}"`);
    console.log("  Possible reasons:");
    console.log("    - Rust scanner library not found (run via 'diskraptor' wrapper)");
    console.log("    - No cleanable files in Downloads folder");
    console.log("    - Scan path doesn't contain 'download'");
  }

  // Summary
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    console.log("  \u2717 FAIL");
  } else {
    console.log("  \u2713 PASS");
  }

  cdp?.close();
  killAll();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
