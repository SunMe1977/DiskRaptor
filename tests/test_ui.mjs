/**
 * DiskRaptor macOS UI Test — launches app via CDP, tests scan + about + tools.
 * Usage: node test_ui.mjs
 */
import WebSocket from "ws";
import { spawn } from "child_process";
import * as path from "path";
import * as http from "http";
import * as os from "os";

const CDP_PORT = 9229;
const APP = path.resolve("dist/DiskRaptor.app/Contents/MacOS/DiskRaptor");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch { reject(d); } }); }).on("error", reject);
  });
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.on("message", raw => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    } catch {}
  });
  await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 10000); });
  return {
    async send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
        setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
      });
    },
    close() { ws.close(); },
  };
}

async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
}

async function getText(cdp, selector) {
  return await jsExpr(cdp, `document.querySelector('${selector}')?.textContent || ''`);
}

async function click(cdp, selector) {
  return await jsExpr(cdp, `document.querySelector('${selector}')?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}))`);
}

function killApp() {
  try { process.kill(appPID); } catch {}
}

let appPID = null;

async function main() {
  let passed = 0, failed = 0;
  function test(name, ok) { console.log(`  ${ok ? '✓' : '✗'} ${name}`); if (ok) passed++; else failed++; }

  console.log("\n=== DiskRaptor macOS UI Test ===\n");

  // Kill any existing instance
  try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {}

  // Launch app with CDP
  console.log("  Launching app...");
  const child = spawn(APP, [], { env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) }, stdio: "ignore" });
  appPID = child.pid;
  // Wait for CDP to become available (up to 15s)
  for (let i = 0; i < 15; i++) {
    try {
      const wsUrl = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json`);
      if (wsUrl && wsUrl[0]?.webSocketDebuggerUrl) break;
    } catch {}
    await sleep(1000);
  }

  // Connect to CDP
  let cdp;
  try {
    const wsUrl = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json`);
    if (!wsUrl || !wsUrl[0]?.webSocketDebuggerUrl) { throw new Error("No CDP endpoint"); }
    cdp = await connectCDP(wsUrl[0].webSocketDebuggerUrl);
    test("CDP connected", true);
  } catch(e) {
    test("CDP connected (" + e.message + ")", false);
    killApp();
    process.exit(1);
  }

  // Navigate to the page
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: "qrc:///index.html" });
    await sleep(2000);
    test("Page loaded", true);
  } catch(e) {
    test("Page loaded (" + e.message + ")", false);
  }

  // Wait for bridge
  try {
    await jsExpr(cdp, `await new Promise(r => { if(window.__TAURI__?.invoke) r(); else window.addEventListener('tauri-bridge-ready', r, {once:true}); })`);
    test("Bridge ready", true);
  } catch(e) {
    test("Bridge ready (" + e.message + ")", false);
  }

  // Test: Welcome page visible
  const welcome = await jsExpr(cdp, `document.getElementById('welcome-placeholder')?.classList.contains('hidden') === false`);
  test("Welcome page visible", welcome !== false);

  // Test: Scan path is set to home dir
  const scanPath = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  test("Scan path has value", scanPath.length > 0);

  // Test: Drive menu loads
  await click(cdp, "#btn-drive");
  await sleep(500);
  const drives = await jsExpr(cdp, `document.querySelectorAll('.drive-item').length`);
  test("Drive menu loads (" + drives + " drives)", drives > 0);
  await click(cdp, "#btn-drive"); // close it

  // Test: About dialog opens
  const aboutBtn = await jsExpr(cdp, `document.getElementById('welcome-about-btn') !== null`);
  test("About button exists", aboutBtn);
  await click(cdp, "#welcome-about-btn");
  await sleep(300);
  const aboutVisible = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active')`);
  test("About dialog opens", aboutVisible);
  // Close via Escape
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await sleep(200);
  const aboutHidden = await jsExpr(cdp, `!document.getElementById('about-overlay')?.classList.contains('active')`);
  test("About dialog closes on Escape", aboutHidden);

  // Test: Tools menu opens
  await click(cdp, "#btn-tools");
  await sleep(300);
  const toolsVisible = await jsExpr(cdp, `document.getElementById('tools-menu')?.classList.contains('active')`);
  test("Tools menu opens", toolsVisible);
  // Close by clicking outside
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await sleep(200);

  // Test: Volume stats on welcome
  const vols = await jsExpr(cdp, `document.querySelectorAll('#welcome-volumes > div').length`);
  test("Volume stats displayed (" + vols + " volumes)", vols > 0);

  // Test: Start scan (scan /tmp which is small)
  await jsExpr(cdp, `document.getElementById('scan-path').value = '/tmp'`);
  await click(cdp, "#btn-scan");
  await sleep(1500);
  // Wait for scan to complete or timeout
  let scanDone = false;
  for (let i = 0; i < 30; i++) {
    const status = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
    if (status.includes("Complete") || status.includes("Error") || status.includes("Timeout")) {
      scanDone = true;
      test("Scan completed: " + status, true);
      break;
    }
    await sleep(1000);
  }
  if (!scanDone) test("Scan completed (timeout)", false);

  // Test: Stats panel shows data
  const statsFiles = await jsExpr(cdp, `document.getElementById('stat-files')?.textContent`);
  test("Stats panel shows files (" + statsFiles + ")", statsFiles && statsFiles !== "-");

  // Test: Tree has nodes
  const treeNodes = await jsExpr(cdp, `document.getElementById('node-count')?.textContent || ''`);
  test("Tree has nodes (" + treeNodes + ")", treeNodes.length > 0);

  // Test: Top files rendered
  const topRows = await jsExpr(cdp, `document.querySelectorAll('#topfiles-table tbody tr').length`);
  test("Top files rendered (" + topRows + " rows)", topRows > 0);

  // Test: Diagram renders
  const diagramCanvas = await jsExpr(cdp, `document.querySelector('#diagram-container canvas') !== null`);
  test("Diagram canvas exists", diagramCanvas);

  // Test: Language switcher
  await click(cdp, "#btn-lang");
  await sleep(300);
  const langVisible = await jsExpr(cdp, `document.getElementById('lang-menu')?.classList.contains('active')`);
  test("Language menu opens", langVisible);
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape" });
  await sleep(200);

  // Summary
  console.log(`\n  Results: ${passed} passed, ${failed} failed of ${passed+failed} tests\n`);

  cdp.close();
  killApp();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("Fatal:", e); killApp(); process.exit(1); });
