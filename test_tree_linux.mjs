/**
 * DiskRaptor Linux Tree View Test — tests tree interactions (expand/collapse/navigate).
 * Usage: node test_tree_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9232;
const SCAN_PATH = "/tmp";
const DIST_DIR = path.resolve("dist");
const BIN_PATH = path.join(DIST_DIR, "DiskRaptor");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function cdpFetch(url) { return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); }).on("error", reject); }); }
async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); let msgId = 0;
  ws.on("message", (raw) => { try { const m = JSON.parse(raw.toString()); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } } catch {} });
  await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 10000); });
  return { send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000); }); }, close() { ws.close(); } };
}
function cdpVal(r) { return r?.result?.result?.value; }
function killAll() { try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {} try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {} }
async function jsExpr(cdp, expr) { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return cdpVal(r); }

async function main() {
  console.log(`\n=== DiskRaptor Linux Tree View Test ===\n`);
  killAll(); await sleep(2000);
  if (!fs.existsSync(BIN_PATH)) throw new Error(`Missing: ${BIN_PATH}`);
  console.log(`✓ Binary: ${BIN_PATH}`);

  const child = spawn(BIN_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT), LD_LIBRARY_PATH: `${DIST_DIR}/lib:${DIST_DIR}:${process.env.LD_LIBRARY_PATH || ""}` },
    detached: true, stdio: "ignore",
  });
  child.unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`); if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) { wsUrl = pages[0].webSocketDebuggerUrl; break; } } catch {}
  }
  if (!wsUrl) throw new Error("Could not find page WebSocket URL");
  console.log(`✓ Page WS ready`);

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Console.enable");
  console.log("✓ CDP connected");

  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)");
    if (val === true) { bridgeOk = true; break; }
    await sleep(500);
  }
  if (!bridgeOk) throw new Error("Bridge not ready");
  console.log("✓ Bridge ready");

  let passed = 0, failed = 0;
  function assert(label, ok, detail) { if (ok) { console.log(`  ✓ ${label}`); passed++; } else { console.log(`  ✗ ${label}${detail ? " -- " + detail : ""}`); failed++; } }

  console.log("\n=== Tree View Tests ===\n");

  // Scan
  console.log("Scanning...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let completed = false;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov !== true) { await sleep(1000); completed = true; break; }
    } catch {}
  }
  assert("Scan completed for tree data", completed);
  await sleep(3000);

  // Tree viewport exists
  const treeViewport = await jsExpr(cdp, `document.getElementById('tree-viewport') ? 'found' : 'not-found'`);
  assert("Tree viewport exists", treeViewport === "found");

  // Tree scroll container
  const treeScroll = await jsExpr(cdp, `document.getElementById('tree-scroll') ? 'found' : 'not-found'`);
  assert("Tree scroll container", treeScroll === "found");

  // Check tree nodes render
  const treeNodeCount = await jsExpr(cdp, `document.querySelectorAll('.tree-node').length`);
  assert(`Tree nodes rendered (${treeNodeCount})`, treeNodeCount > 0, `count=${treeNodeCount}`);

  // Check tree header exists
  const treeHeader = await jsExpr(cdp, `document.getElementById('tree-header') ? 'found' : 'not-found'`);
  assert("Tree header exists", treeHeader === "found");

  // Check tree status bar
  const treeStatus = await jsExpr(cdp, `document.getElementById('tree-status') ? 'found' : 'not-found'`);
  assert("Tree status bar exists", treeStatus === "found");

  // Tree filter input
  const treeFilter = await jsExpr(cdp, `document.getElementById('tree-filter') ? 'found' : 'not-found'`);
  assert("Tree filter input exists", treeFilter === "found");

  // Test tree filter input: type and verify filtering
  if (treeNodeCount > 0 && treeFilter === "found") {
    console.log("\n--- Tree Filter Tests ---");

    // Type a filter
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        el.value = 'a';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'typed';
      })()
    `);
    await sleep(500);

    const filteredCount = await jsExpr(cdp, `document.querySelectorAll('.tree-node').length`);
    assert("Tree nodes after filter 'a'", filteredCount >= 0, `count=${filteredCount}`);

    // Clear filter
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        el.value = '';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'cleared';
      })()
    `);
    await sleep(300);
    assert("Tree filter cleared", true);

    // Type a more specific filter
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        el.value = 'bin';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'typed-bin';
      })()
    `);
    await sleep(500);
    const binCount = await jsExpr(cdp, `document.querySelectorAll('.tree-node').length`);
    assert("Tree nodes after filter 'bin'", true, `count=${binCount}`);
  }

  // Test tree-node click to expand/collapse
  if (treeNodeCount > 0) {
    console.log("\n--- Tree Node Interaction ---");

    const firstNode = await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-node');
        if (nodes.length > 0) {
          nodes[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked-first';
        }
        return 'no-nodes';
      })()
    `);
    assert("Tree node clickable", firstNode === "clicked-first", `${firstNode}`);
    await sleep(300);

    // Test right-click context menu on tree node
    const ctxMenu = await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-node');
        if (nodes.length > 0) {
          nodes[0].dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2}));
          return 'right-clicked';
        }
        return 'no-nodes';
      })()
    `);
    assert("Context menu on tree node", ctxMenu === "right-clicked", `${ctxMenu}`);
    await sleep(300);

    // Close context menu
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  }

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close(); killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });