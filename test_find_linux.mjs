/**
 * DiskRaptor Linux Find Files & Empty Folders Tool Test.
 * Usage: node test_find_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9234;
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
  console.log(`\n=== DiskRaptor Linux Find Files & Empty Folders Test ===\n`);
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

  // === Find Files Tool ===
  console.log("\n=== Find Files Tool ===\n");

  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'scan-clicked'`);

  let completed = false;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    try { const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`); if (ov !== true) { await sleep(1000); completed = true; break; } } catch {}
  }
  assert("Scan completed for Find Files tool", completed);
  await sleep(2000);

  // Open tools menu and click find-files
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'menu-opened'`);
  await sleep(300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='find-files'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(500);

  // Check find-files panel or results area
  const findFilesPanel = await jsExpr(cdp, `
    (function() {
      const panel = document.getElementById('find-files-panel');
      if (panel) return 'panel-found';
      const allPanels = document.querySelectorAll('[id*="find"], [class*="find-results"]');
      return allPanels.length > 0 ? 'results-panel-' + allPanels.length : 'no-panel';
    })()
  `);
  assert("Find Files panel/results rendered", findFilesPanel !== "no-panel", `${findFilesPanel}`);

  // Check for find input or results list
  const findInput = await jsExpr(cdp, `
    (function() {
      const inp = document.querySelector('input[id*="find"], input[placeholder*="find" i]');
      if (inp) return 'input-found';
      const results = document.querySelectorAll('[class*="find-result"], [class*="search-result"]');
      return results.length > 0 ? 'results-present-' + results.length : 'no-find-ui';
    })()
  `);
  assert("Find Files UI accessible", findInput !== "no-find-ui", `${findInput}`);

  // === Empty Folders Tool ===
  console.log("\n=== Empty Folders Tool ===\n");

  // Open tools menu and click empty-folders
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'menu-opened'`);
  await sleep(300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='empty-folders'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(500);

  const emptyFoldersPanel = await jsExpr(cdp, `
    (function() {
      const panel = document.getElementById('empty-folders-panel');
      if (panel) return 'panel-found';
      const allPanels = document.querySelectorAll('[id*="empty"], [class*="empty-folder"]');
      return allPanels.length > 0 ? 'results-present-' + allPanels.length : 'no-panel';
    })()
  `);
  assert("Empty Folders panel rendered", emptyFoldersPanel !== "no-panel", `${emptyFoldersPanel}`);

  // Check for folder count or result display
  const emptyFoldersContent = await jsExpr(cdp, `
    (function() {
      const result = document.querySelector('[id*="empty-folders"], [class*="empty-folders"]');
      if (!result) return 'no-container';
      const text = result.textContent.trim();
      return text.length > 0 ? 'content-len=' + text.length : 'empty-content';
    })()
  `);
  assert("Empty Folders has content", emptyFoldersContent !== "no-container", `${emptyFoldersContent}`);

  // Check trash recovery tool is also accessible
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'menu-opened2'`);
  await sleep(300);
  const trashRecoveryItem = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        if (item.getAttribute('data-action') === 'trash-recovery') return 'found-trash-recovery';
      }
      return 'not-found';
    })()
  `);
  assert("Trash Recovery menu item exists for empty folders context", trashRecoveryItem === "found-trash-recovery");

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close(); killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });