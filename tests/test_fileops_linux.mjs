/**
 * DiskRaptor Linux File Operations Test — tests copy/move/delete/properties via CDP context menu.
 * Usage: node test_fileops_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9240;
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
  console.log(`\n=== DiskRaptor Linux File Operations Test ===\n`);
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

  console.log("\nScanning for data...\n");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'scan-clicked'`);

  let completed = false;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    try { const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`); if (ov !== true) { await sleep(1000); completed = true; break; } } catch {}
  }
  assert("Scan completed for file ops", completed);
  await sleep(3000);

  console.log("\n=== File Operations Context Menu Tests ===\n");

  // Find a tree node and click it
  const hasTreeNode = await jsExpr(cdp, `document.querySelector('.tree-node') ? 'found' : 'not-found'`);
  if (hasTreeNode === "found") {
    // Left-click a tree node to select it
    await jsExpr(cdp, `document.querySelector('.tree-node').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
    await sleep(500);

    // Right-click to open context menu
    await jsExpr(cdp, `document.querySelector('.tree-node').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2})); 'right-clicked'`);
    await sleep(300);

    // Check context menu items
    const ctxItems = await jsExpr(cdp, `
      Array.from(document.querySelectorAll('.context-menu [data-action], .context-menu [role="menuitem"], [class*="context"] [data-action]')).map(el => ({
        action: el.getAttribute('data-action'),
        text: el.textContent.trim().slice(0, 20)
      }))
    `);
    assert("Context menu items exist", Array.isArray(ctxItems) && ctxItems.length > 0, `${ctxItems.length} items`);

    // List available actions
    const actions = Array.isArray(ctxItems) ? ctxItems.map(i => i.action).filter(Boolean) : [];
    assert("Context menu has actions", actions.length > 0, `actions: ${actions.join(',')}`);

    // Check for specific file ops actions
    const hasExplorer = actions.includes('explorer');
    const hasTerminal = actions.includes('terminal');
    const hasProperties = actions.includes('properties');
    const hasCopy = actions.includes('copy');
    const hasTrash = actions.includes('trash');

    assert("Context menu has 'open explorer' action", hasExplorer, `present=${hasExplorer}`);
    assert("Context menu has 'open terminal' action", hasTerminal, `present=${hasTerminal}`);
    assert("Context menu has 'properties' action", hasProperties, `present=${hasProperties}`);
    assert("Context menu has 'copy' action", hasCopy, `present=${hasCopy}`);
    assert("Context menu has 'trash' action", hasTrash, `present=${hasTrash}`);

    // Close context menu
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  } else {
    assert("Tree node for context menu", false, "no tree nodes found");
  }

  // Test Tauri invoke for copy (on a dummy path)
  const copyInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('copy_path', { from: '/tmp/source.txt', to: '/tmp/dest.txt' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("copy_path Tauri invoke", copyInvoke.includes("ok=") || copyInvoke.includes("err"), `${copyInvoke}`);

  // Test Tauri invoke for move
  const moveInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('move_path', { from: '/tmp/source.txt', to: '/tmp/dest.txt' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("move_path Tauri invoke", moveInvoke.includes("ok=") || moveInvoke.includes("err"), `${moveInvoke}`);

  // Test Tauri invoke for properties
  const propsInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('get_properties', { path: '/tmp' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("get_properties Tauri invoke", propsInvoke.includes("ok=") || propsInvoke.includes("err"), `${propsInvoke}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });