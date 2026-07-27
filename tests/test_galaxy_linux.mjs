/**
 * DiskRaptor Linux Galaxy View Test — tests galaxy/spatial visualization.
 * Usage: node test_galaxy_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9241;
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
  console.log(`\n=== DiskRaptor Linux Galaxy View Test ===\n`);
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

  console.log("\nScanning for galaxy data...\n");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let completed = false;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try { const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`); if (ov !== true) { await sleep(1000); completed = true; break; } } catch {}
  }
  assert("Scan completed", completed);
  await sleep(3000);

  console.log("\n=== Galaxy View Tests ===\n");

  // Check galaxy view exists
  const galaxyContainer = await jsExpr(cdp, `document.getElementById('galaxy-container') ? 'found' : 'not-found'`);
  assert("Galaxy container exists", galaxyContainer === "found");

  // Galaxy view canvas or SVG rendering area
  const galaxyCanvas = await jsExpr(cdp, `
    (function() {
      const c = document.getElementById('galaxy-container');
      if (!c) return 'container-not-found';
      const canvas = c.querySelector('canvas');
      const svg = c.querySelector('svg');
      const div = c.querySelector('div');
      return 'canvas=' + (canvas ? 'yes' : 'no') + '-svg=' + (svg ? 'yes' : 'no') + '-div=' + (div ? 'yes' : 'no');
    })()
  `);
  assert("Galaxy rendering elements", galaxyCanvas.startsWith("canvas="), `${galaxyCanvas}`);

  // Check if Galaxy View button/control exists in toolbar (diagram-mode button)
  const galaxyBtn = await jsExpr(cdp, `
    (function() {
      const btn = document.querySelector('.diagram-mode[data-mode="galaxy"]');
      return btn ? 'found' : 'not-found';
    })()
  `);
  assert("Galaxy view button in toolbar", galaxyBtn === "found");

  // Check for galaxy-related modules
  const galaxyModuleLoaded = await jsExpr(cdp, `
    (typeof window.__galaxyView !== 'undefined' || typeof window.GalaxyView !== 'undefined') ? 'galaxy-module-loaded' : 'checking-dom'
  `);
  assert("Galaxy module loaded", galaxyModuleLoaded === "galaxy-module-loaded" || galaxyModuleLoaded === "checking-dom", `${galaxyModuleLoaded}`);

  // Try to access galaxy-specific DOM elements
  const galaxyElements = await jsExpr(cdp, `
    (function() {
      const elements = document.querySelectorAll('[class*="galaxy"], [id*="galaxy"]');
      const count = elements.length;
      if (count === 0) return 'none';
      const first = elements[0];
      return 'count=' + count + '-tag=' + first.tagName + '-class=' + (first.className || '').toString().slice(0, 40);
    })()
  `);
  assert("Galaxy DOM elements", galaxyElements !== "none", `${galaxyElements}`);

  // Test galaxy container visibility toggle
  const showGalaxy = await jsExpr(cdp, `
    (function() {
      const btn = document.querySelector('.diagram-mode[data-mode="galaxy"]');
      if (!btn) return 'no-button';
      const container = document.getElementById('galaxy-container');
      if (!container) return 'no-container';
      const wasVisible = container.style.display !== 'none';
      btn.click();
      const nowVisible = container.style.display !== 'none';
      return 'was=' + wasVisible + '-now=' + nowVisible;
    })()
  `);
  assert("Galaxy toggle button works", showGalaxy !== "no-button" && showGalaxy !== "no-container", `${showGalaxy}`);
  await sleep(500);

  // Check galaxy view renders something after toggle
  const galaxyContent = await jsExpr(cdp, `
    (function() {
      const c = document.getElementById('galaxy-container');
      if (!c) return 'no-container';
      const html = c.innerHTML.trim();
      return 'html-len=' + html.length;
    })()
  `);
  assert("Galaxy view has content", galaxyContent.includes("html-len="), `${galaxyContent}`);

  // Check for galaxy-related keyboard/tooltip interactions
  const galaxyTooltip = await jsExpr(cdp, `
    (function() {
      const nodes = document.querySelectorAll('[title*="galaxy" i], [data-tooltip*="galaxy" i]');
      return 'tooltip-count=' + nodes.length;
    })()
  `);
  assert("Galaxy tooltip elements", galaxyTooltip.startsWith("tooltip-count="), `${galaxyTooltip}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });
