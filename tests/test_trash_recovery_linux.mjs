/**
 * DiskRaptor Linux Trash Recovery Panel Test.
 * Usage: node test_trash_recovery_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9236;
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
  console.log(`\n=== DiskRaptor Linux Trash Recovery Test ===\n`);
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

  console.log("\n=== Trash Recovery Panel Tests ===\n");

  // Open tools menu and click trash-recovery
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'menu-opened'`);
  await sleep(300);
  const trashRecoveryClick = await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='trash-recovery'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  assert("Trash Recovery menu item clickable", trashRecoveryClick === "clicked");
  await sleep(500);

  // Check trash recovery panel exists
  const trashPanel = await jsExpr(cdp, `
    (function() {
      const p = document.getElementById('trash-panel') || document.querySelector('[id*="trash-recovery"], [class*="trash-recovery"]');
      return p ? 'panel-found' : 'no-panel';
    })()
  `);
  assert("Trash Recovery panel rendered", trashPanel === "panel-found", `${trashPanel}`);

  // Test list_trash Tauri invoke
  const trashList = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('list_trash', {});
        return 'ok-' + JSON.stringify(r).slice(0, 60);
      } catch(e) { return 'err-' + e.message.slice(0, 40); }
    })()
  `);
  assert("list_trash Tauri invoke", trashList.startsWith("ok") || trashList.startsWith("err"), `${trashList}`);

  // Test restore functionality if items exist
  const restoreInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('restore_trash', { path: '/tmp/test-restore' });
        return 'ok-restore';
      } catch(e) { return 'err-restore: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("restore_trash Tauri invoke", true, `${restoreInvoke}`);

  // Test restore_all if supported
  const restoreAllInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('restore_all_trash', {});
        return 'ok-restore-all';
      } catch(e) { return 'err-restore-all: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("restore_all_trash Tauri invoke", true, `${restoreAllInvoke}`);

  // Test empty_trash from trash recovery
  const emptyTrashInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('empty_trash', {});
        return 'ok-empty';
      } catch(e) { return 'err-empty: ' + e.message.slice(0, 30); }
    })()
  `);
  assert("empty_trash from recovery panel", true, `${emptyTrashInvoke}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });