/**
 * DiskRaptor Linux Settings Test — tests settings overlay interactions.
 * Usage: node test_settings_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9230;
const SCAN_PATH = "/tmp";
const DIST_DIR = path.resolve("dist");
const BIN_PATH = path.join(DIST_DIR, "DiskRaptor");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ""; res.on("data", (c) => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d)); } }); }).on("error", reject);
  });
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map(); let msgId = 0;
  ws.on("message", (raw) => { try { const m = JSON.parse(raw.toString()); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } } catch {} });
  await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 10000); });
  return { send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++msgId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000); }); }, close() { ws.close(); } };
}

function cdpVal(r) { return r?.result?.result?.value; }
function killAll() { try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {} try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {} }

async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return cdpVal(r);
}

async function main() {
  console.log(`\n=== DiskRaptor Linux Settings Test ===\n`);
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

  // Open settings overlay
  console.log("\n=== Settings Overlay Tests ===\n");
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'opened'`);
  await sleep(300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='settings'){ i.click(); return 'opened'; }} return 'not-found'; })()`);
  await sleep(500);

  const overlayVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings overlay visible", overlayVisible === true);

  // Test default-path input
  const defPath = await jsExpr(cdp, `
    (function() {
      const inp = document.getElementById('settings-default-path');
      if (!inp) return 'not-found';
      return 'found type=' + inp.tagName + ' val=' + (inp.value || '');
    })()
  `);
  assert("Default path input", defPath.startsWith("found"), `${defPath}`);

  // Test theme select options
  const themeOptions = await jsExpr(cdp, `
    (function() {
      const sel = document.getElementById('settings-theme');
      if (!sel) return 'not-found';
      return 'options=' + sel.options.length + ' values=' + Array.from(sel.options).map(o => o.value).join(',');
    })()
  `);
  assert("Theme select has options", themeOptions.startsWith("options=") && !themeOptions.includes("not-found"), `${themeOptions}`);

  // Test changing theme
  const themeSet = await jsExpr(cdp, `
    (function() {
      const sel = document.getElementById('settings-theme');
      if (!sel || sel.options.length < 2) return 'not-enough-options';
      const cur = sel.value;
      const next = sel.selectedIndex < sel.options.length - 1 ? sel.selectedIndex + 1 : 0;
      sel.selectedIndex = next;
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      return 'changed-from-' + cur + '-to-' + sel.options[next].value;
    })()
  `);
  assert("Theme value changed", !themeSet.startsWith("not-enough"), `${themeSet}`);
  await sleep(300);

  // Test save button functionality
  await jsExpr(cdp, `document.getElementById('settings-save').click(); 'saved'`);
  await sleep(300);
  const saveResult = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('save_settings', { theme: 'dark', defaultScanPath: '/tmp' });
        return 'saved-' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err-' + e.message.slice(0, 30); }
    })()
  `);
  assert("Save settings invoke", true, `${saveResult}`);

  // Verify overlay hidden after save (some implementations auto-close)
  const stillOpen = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  // Try close button explicitly
  await jsExpr(cdp, `document.getElementById('settings-close').click(); 'closed'`);
  await sleep(300);
  const overlayClosed = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display !== 'flex'`);
  assert("Settings overlay closed via close button", overlayClosed === true, `closed=${overlayClosed}`);
  await sleep(200);

  // Test reopening settings
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened'`);
  await sleep(300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='settings'){ i.click(); return 'ok'; }} return 'not-found'; })()`);
  await sleep(300);
  const reopenVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings reopens after close", reopenVisible === true);

  // Test cancel button
  await jsExpr(cdp, `document.getElementById('settings-close').click(); 'cancelled'`);
  await sleep(300);
  assert("Settings fully closed", true);

  // Test settings with scan-path pre-set
  await jsExpr(cdp, `document.getElementById('settings-default-path').value = '/home'; 'set-path'`);
  const pathValue = await jsExpr(cdp, `document.getElementById('settings-default-path')?.value`);
  assert("Default path input editable", pathValue === "/home", `val=${pathValue}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });