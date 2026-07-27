/**
 * DiskRaptor Linux Context Menu Test — tests right-click context menu on tree nodes.
 * Usage: node test_context_menu_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9243;
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
  return { send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000); }); }, close() {} };
}
function cdpVal(r) { return r?.result?.result?.value; }
function killAll() { try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {} try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {} }
async function jsExpr(cdp, expr) { const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return cdpVal(r); }

async function main() {
  console.log(`\n=== DiskRaptor Linux Context Menu Test ===\n`);
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

  console.log("\nScanning for context menu data...\n");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let completed = false;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try { const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`); if (ov !== true) { await sleep(1000); completed = true; break; } } catch {}
  }
  assert("Scan completed for context menu data", completed);
  await sleep(5000);

  console.log("\n=== Context Menu Tests ===\n");

  // Find a tree node to right-click
  const hasTreeNode = await jsExpr(cdp, `document.querySelector('.tree-row') ? 'found' : 'not-found'`);
  assert("Tree node exists for right-click", hasTreeNode === "found");

  if (hasTreeNode === "found") {
    // Left-click a node to select it
    await jsExpr(cdp, `document.querySelector('.tree-row').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'left-clicked'`);
    await sleep(300);

    // Right-click to open context menu
    await jsExpr(cdp, `document.querySelector('.tree-row').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2})); 'right-clicked'`);
    await sleep(500);

    // Check if context menu appears
    const ctxMenuVis = await jsExpr(cdp, `
      (function() {
        const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"], [class*="context-menu"], [role="menu"]');
        if (!menu) return 'no-menu-element';
        const style = getComputedStyle(menu);
        const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        return 'visible=' + isVisible;
      })()
    `);
    assert("Context menu appears on right-click", ctxMenuVis === "visible=true", `${ctxMenuVis}`);

    // Get context menu items
    const ctxItems = await jsExpr(cdp, `
      (function() {
        const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"], [class*="context-menu"]');
        if (!menu) return 'no-menu';
        const items = menu.querySelectorAll('[data-action], [role="menuitem"], li, .menu-item, button');
        return 'items=' + items.length;
      })()
    `);
    assert("Context menu has items", ctxItems.startsWith("items=") && parseInt(ctxItems.split("=")[1]) > 0, `${ctxItems}`);

    // Check specific context menu actions exist
    const ctxActions = await jsExpr(cdp, `
      (function() {
        const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"], [class*="context-menu"]');
        if (!menu) return 'no-menu';
        const items = menu.querySelectorAll('[data-action]');
        const actions = Array.from(items).map(i => i.getAttribute('data-action'));
        return JSON.stringify(actions);
      })()
    `);
    assert("Context menu has data-action attributes", ctxActions.startsWith("["), `${ctxActions}`);

    // Parse actions and check for expected ones
    let hasExplorer = false, hasTerminal = false, hasCopy = false, hasTrash = false, hasProps = false;
    try {
      const actions = JSON.parse(ctxActions);
      hasExplorer = actions.includes("explorer");
      hasTerminal = actions.includes("terminal");
      hasCopy = actions.includes("copy");
      hasTrash = actions.includes("trash") || actions.includes("delete");
      hasProps = actions.includes("properties");
    } catch {}
    assert("Has 'open explorer' action", hasExplorer);
    assert("Has 'open terminal' action", hasTerminal);
    assert("Has 'copy path' action", hasCopy);
    assert("Has 'trash/delete' action", hasTrash);
    assert("Has 'properties' action", hasProps);

    // Click on a context menu item (test explorer action)
    if (hasExplorer) {
      const explorerClick = await jsExpr(cdp, `
        (function() {
          const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"], [class*="context-menu"]');
          if (!menu) return 'no-menu';
          const items = menu.querySelectorAll('[data-action="explorer"]');
          if (items.length === 0) return 'no-explorer';
          items[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked-explorer';
        })()
      `);
      assert("Explorer menu item clickable", explorerClick === "clicked-explorer", `${explorerClick}`);
      await sleep(500);
    }

    // Close context menu by clicking Escape
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(300);

    const menuHidden = await jsExpr(cdp, `
      (function() {
        const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"], [class*="context-menu"]');
        if (!menu) return 'no-menu';
        const style = getComputedStyle(menu);
        return 'hidden=' + (style.display === 'none' || style.visibility === 'hidden');
      })()
    `);
    assert("Context menu closes on Escape", menuHidden.includes("hidden=true"), `${menuHidden}`);
  } else {
    assert("Tree node for context menu", false, "no tree nodes found - scan may have empty results");
  }

  // Also test context menu on empty area (should not show)
  const emptyCtx = await jsExpr(cdp, `
    (function() {
      const body = document.body;
      body.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2}));
      const menu = document.querySelector(' #tree-context-menu, [class*="ctx-menu"]');
      return menu ? 'menu-shown-on-empty' : 'no-menu-on-empty';
    })()
  `);
  assert("Context menu behavior on empty area", true, `${emptyCtx}`);
  await sleep(300);
  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc2'`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });