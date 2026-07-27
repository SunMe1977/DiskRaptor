/**
 * DiskRaptor Linux Rescan Flow Test — covers scan/rescan/clear-scan lifecycle.
 * Usage: node test_rescan_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9239;
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
  console.log(`\n=== DiskRaptor Linux Rescan Flow Test ===\n`);
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

  console.log("\n=== Initial State ===\n");
  const scanBtnEnabled = await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`);
  assert("Scan button enabled initially", scanBtnEnabled === true);
  const rescanDisabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`);
  assert("Rescan button disabled initially", rescanDisabled === true);
  const cancelDisabled = await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === true`);
  assert("Cancel button disabled initially", cancelDisabled === true);
  const exportDisabled = await jsExpr(cdp, `document.getElementById('btn-export')?.disabled === true`);
  assert("Export button disabled initially", exportDisabled === true);

  // === First Scan ===
  console.log("\n=== First Scan ===\n");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set-path'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'scan-clicked'`);

  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) { overlayShown = true; break; }
  }
  assert("First scan overlay shown", overlayShown);

  let completed = false;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov !== true) { await sleep(1000); completed = true; break; }
    } catch {}
  }
  assert("First scan completed", completed);
  await sleep(2000);

  // === Post-First-Scan State ===
  console.log("\n=== Post-First-Scan State ===\n");
  const rescanEnabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled !== true`);
  assert("Rescan button enabled after first scan", rescanEnabled === true);
  const cancelEnabled = await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled !== true`);
  assert("Cancel button enabled after first scan", cancelEnabled === true);
  const exportEnabled = await jsExpr(cdp, `document.getElementById('btn-export')?.disabled !== true`);
  assert("Export button enabled after first scan", exportEnabled === true);

  // Stats panel populated
  const statFiles = await jsExpr(cdp, `parseInt((document.getElementById('stat-files')?.textContent || '0').replace(/,/g, ''))`);
  assert("Stats files after first scan", statFiles > 0, `files=${statFiles}`);

  // Cancel scan check (should not be running anymore)
  const isRunning = await jsExpr(cdp, `
    (async () => {
      try {
        const result = await window.__TAURI__.invoke('cancel_scan', {});
        return 'not-running-' + JSON.stringify(result).slice(0, 30);
      } catch(e) { return 'no-invoke'; }
    })()
  `);
  assert("Scan not running", isRunning === "no-invoke-is-running-false" || isRunning === "not-running-" || isRunning === "no-invoke", `${isRunning}`);

  // === Rescan ===
  console.log("\n=== Rescan ===\n");
  await jsExpr(cdp, `document.getElementById('btn-rescan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'rescan-clicked'`);
  await sleep(300);

  let rescanCompleted = false;
  for (let i = 0; i < 300; i++) {
    await sleep(500);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov !== true) { await sleep(1000); rescanCompleted = true; break; }
    } catch {}
  }
  assert("Rescan completed", rescanCompleted);
  await sleep(2000);

  // === Clear Scan ===
  console.log("\n=== Clear Scan ===\n");
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'menu-opened'`);
  await sleep(300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='clear-scan'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(500);

  // After clear-scan, verify state resets
  const clearedRescanDisabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`);
  assert("Rescan disabled after clear-scan", clearedRescanDisabled === true);
  await sleep(1000);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });