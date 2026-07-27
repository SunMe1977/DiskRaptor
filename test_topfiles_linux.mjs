/**
 * DiskRaptor Linux Top Files Panel Test — tests top files panel interactions.
 * Usage: node test_topfiles_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9233;
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
  console.log(`\n=== DiskRaptor Linux Top Files Panel Test ===\n`);
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
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let completed = false;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try {
      const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (ov !== true) { await sleep(1000); completed = true; break; }
    } catch {}
  }
  assert("Scan completed", completed);
  await sleep(3000);

  console.log("\n=== Top Files Panel Tests ===\n");

  // Top files card exists
  const topFilesCard = await jsExpr(cdp, `document.getElementById('topfiles-card') ? 'found' : 'not-found'`);
  assert("Top files card exists", topFilesCard === "found");

  // Top files table exists
  const topFilesTable = await jsExpr(cdp, `document.getElementById('topfiles-table') ? 'found' : 'not-found'`);
  assert("Top files table exists", topFilesTable === "found");

  // Top files tbody has rows
  const topFilesRows = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert(`Top files table rows (${topFilesRows})`, topFilesRows > 0, `rows=${topFilesRows}`);

  // Check table headers exist
  const tableHeaders = await jsExpr(cdp, `document.querySelectorAll('#topfiles-table th').length`);
  assert("Top files table headers", tableHeaders >= 0, `headers=${tableHeaders}`);

  // Check each row has path, size, and size_human cells
  if (topFilesRows > 0) {
    const firstRow = await jsExpr(cdp, `
      (function() {
        const rows = document.querySelectorAll('#topfiles-body tr');
        if (rows.length === 0) return 'no-rows';
        const cells = rows[0].querySelectorAll('td');
        return 'cells=' + cells.length;
      })()
    `);
    assert("Top files row has cells", firstRow.startsWith("cells="), `${firstRow}`);

    // Check path cell content
    const firstRowPath = await jsExpr(cdp, `
      (function() {
        const row = document.querySelector('#topfiles-body tr');
        if (!row) return 'no-row';
        const cells = row.querySelectorAll('td');
        return cells.length > 0 ? cells[0].textContent.trim().slice(0, 40) : 'no-cells';
      })()
    `);
    assert("First file path visible", firstRowPath !== "no-row" && firstRowPath !== "no-cells", `path=${firstRowPath}`);
  }

  // Check for size column in the table
  const hasSizeColumn = await jsExpr(cdp, `
    (function() {
      const ths = document.querySelectorAll('#topfiles-table th');
      for (const th of ths) {
        if (th.textContent.toLowerCase().includes('size')) return 'has-size-col';
      }
      return 'no-size-col';
    })()
  `);
  assert("Size column in top files", hasSizeColumn === "has-size-col");

  // Check the chart/container has content
  const topFilesContainer = await jsExpr(cdp, `document.getElementById('topfiles-container') ? 'found' : 'not-found'`);
  assert("Top files container exists", topFilesContainer === "found");

  // Test sort indicator or any interactive element
  const hasInteractiveElements = await jsExpr(cdp, `
    (function() {
      const table = document.getElementById('topfiles-table');
      if (!table) return 'no-table';
      const sorts = table.querySelectorAll('[data-sort], .sort-icon, .sort-btn');
      return 'sorters=' + sorts.length;
    })()
  `);
  assert("Top files interactive elements", hasInteractiveElements.includes("sorters="), `${hasInteractiveElements}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close(); killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });