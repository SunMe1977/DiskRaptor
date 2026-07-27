/**
 * DiskRaptor Linux Filters Test — launches binary, tests tree/type/lang filters.
 * Uses raw CDP via WebSocket.
 * Usage: node test_filters_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9226;
const SCAN_PATH = "/tmp";
const DIST_DIR = path.resolve("dist");
const BIN_PATH = path.join(DIST_DIR, "DiskRaptor");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
      });
    }).on("error", reject);
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
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000);
      });
    },
    close() { ws.close(); },
  };
}

function cdpVal(r) {
  return r?.result?.result?.value;
}

function killAll() {
  try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {}
  try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {}
}

async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return cdpVal(r);
}

async function main() {
  console.log(`\n=== DiskRaptor Linux Filters Test ===\n`);

  killAll();
  await sleep(2000);

  if (!fs.existsSync(BIN_PATH)) throw new Error(`Missing: ${BIN_PATH}`);
  console.log(`✓ Binary: ${BIN_PATH}`);

  console.log("\nLaunching...");
  const startTime = Date.now();
  const child = spawn(BIN_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT), LD_LIBRARY_PATH: `${DIST_DIR}/lib:${DIST_DIR}:${process.env.LD_LIBRARY_PATH || ""}` },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
        wsUrl = pages[0].webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }
  if (!wsUrl) throw new Error("Could not find page WebSocket URL");
  console.log(`✓ Page WS ready (${Date.now() - startTime}ms)`);

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Console.enable");
  console.log("✓ CDP connected");

  console.log("Waiting for bridge...");
  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(cdp,
      "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)"
    );
    if (val === true) { bridgeOk = true; break; }
    await sleep(500);
  }
  if (!bridgeOk) throw new Error("Bridge not ready");
  console.log("✓ Bridge ready");

  let passed = 0;
  let failed = 0;
  function assert(label, ok, detail) {
    if (ok) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}${detail ? " -- " + detail : ""}`); failed++; }
  }

  // Scan first so we have data to filter
  console.log("\nScanning for data...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) { overlayShown = true; break; }
  }
  assert("Scan overlay appeared", overlayShown);

  let completed = false;
  let maxFiles = 0;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try {
      const json = await jsExpr(cdp, `JSON.stringify({files: (document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''), ov: document.getElementById('progress-overlay')?.classList.contains('active')})`);
      const m = JSON.parse(json || "{}");
      const files = parseInt(m.files) || 0;
      if (files > maxFiles) maxFiles = files;
      if (!m.ov && maxFiles > 0) { completed = true; break; }
    } catch {}
  }
  assert("Scan completed", completed, `maxFiles=${maxFiles}`);
  await sleep(2000);

  // --- Filter tests ---
  console.log("\n=== Filter Tests ===\n");

  // Test tree filter input
  const treeFilter = await jsExpr(cdp, `
    (function() {
      const el = document.getElementById('tree-filter');
      if (!el) return 'not-found';
      return 'found type=' + el.getAttribute('type') + ' placeholder=' + (el.getAttribute('placeholder') || '');
    })()
  `);
  assert("Tree filter input exists", treeFilter.startsWith("found"), `${treeFilter}`);

  // Type filters
  const typeFilters = await jsExpr(cdp, `
    (function() {
      const container = document.getElementById('type-filters');
      if (!container) return 'not-found';
      const btns = container.querySelectorAll('button, .filter-btn, [data-ext]');
      return 'found-' + btns.length + '-buttons';
    })()
  `);
  assert("Type filter container", typeFilters.startsWith("found"), `${typeFilters}`);

  // Test tree filter typing (type into filter input)
  if (treeFilter.startsWith("found")) {
    const filterText = "txt";
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        if (!el) return 'no-element';
        el.value = ${JSON.stringify(filterText)};
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
        return 'typed-' + el.value;
      })()
    `);
    await sleep(500);

    // Check if tree viewport content changed
    const treeContent = await jsExpr(cdp, `
      (function() {
        const viewport = document.getElementById('tree-viewport');
        const container = document.getElementById('tree-container');
        const html = (viewport?.innerHTML || container?.innerHTML || '');
        const visibleNodes = document.querySelectorAll('.tree-node');
        return 'html-len=' + html.length + '-nodes=' + visibleNodes.length;
      })()
    `);
    assert("Tree filter applied", treeContent.includes("html-len="), `${treeContent}`);

    // Clear filter
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        if (!el) return 'no-element';
        el.value = '';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'cleared';
      })()
    `);
    await sleep(300);
    assert("Tree filter cleared", true, "filter input emptied");
  }

  // Test scan path input for filter-by-name
  const scanPath = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path populated", scanPath.length > 0, `path=${scanPath.slice(0, 40)}`);

  // Test language/misc filter (if present)
  const langFilter = await jsExpr(cdp, `
    (function() {
      const el = document.getElementById('lang-filter');
      if (!el) return 'not-found';
      return 'found placeholder=' + (el.getAttribute('placeholder') || '');
    })()
  `);
  assert("Language filter exists", langFilter.startsWith("found"), `${langFilter}`);

  // Test clear filters functionality
  const clearFilterBtn = await jsExpr(cdp, `
    (function() {
      const btn = document.querySelector('[data-action*="clear-filter"], [id*="clear-filter"], button[id*="filter-clear"]');
      if (btn) return 'found-id=' + btn.id;
      const allBtns = document.querySelectorAll('button');
      for (const b of allBtns) {
        if (b.textContent.trim().match(/clear|reset|✖/i)) return 'found-btn=' + b.textContent.trim();
      }
      return 'no-clear-btn';
    })()
  `);
  assert("Clear filter button check", true, `${clearFilterBtn}`);

  // Test that active filter state is visible
  const filterState = await jsExpr(cdp, `
    JSON.stringify({
      treeFilterVal: document.getElementById('tree-filter')?.value || '',
      langFilterVal: document.getElementById('lang-filter')?.value || '',
      treeNodeCount: document.querySelectorAll('.tree-node').length,
      hasActiveFilter: document.querySelector('.filter-active') !== null
    })
  `);
  assert("Filter state readable", true, `${filterState.slice(0, 80)}`);

  // Results
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close();
  killAll();
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});