/**
 * Quick check: pie chart canvas visible after scan (port 9247)
 */
import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";

const CDP_PORT = 9247;
const DIST_DIR = path.resolve("dist");
const EXE_PATH = path.join(DIST_DIR, "DiskRaptor.exe");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); } });
    }).on("error", reject);
  });
}

async function connectCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let msgId = 0;
  ws.on("message", (raw) => {
    try { const m = JSON.parse(raw.toString()); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } } catch {}
  });
  await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 10000); });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
      });
    },
    close() { ws.close(); },
  };
}

function cdpVal(r) { return r?.result?.result?.value; }
async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return cdpVal(r);
}

async function main() {
  console.log("=== Pie Chart Zoom Check ===\n");

  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore" }); } catch {}
  await sleep(3000);
  if (!fs.existsSync(EXE_PATH)) throw new Error("Missing: " + EXE_PATH);

  spawn(EXE_PATH, [], { cwd: DIST_DIR, env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) }, stdio: "ignore" }).unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) { wsUrl = pages[0].webSocketDebuggerUrl; break; }
    } catch (e) { if (i % 10 === 9) console.log("  Waiting for CDP..."); }
  }
  if (!wsUrl) throw new Error("CDP page not found");

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Wait for bridge
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)");
    if (val === true) break;
    await sleep(500);
    if (i === 29) { cdp.close(); throw new Error("Bridge not ready"); }
  }
  console.log("✓ Bridge ready");

  // Check initial layout
  const initial = await jsExpr(cdp, `JSON.stringify({
    leftCol: document.getElementById('left-column')?.getBoundingClientRect().height || 0,
    treePanel: document.getElementById('tree-panel')?.getBoundingClientRect().height || 0,
    diagramPanel: document.getElementById('diagram-panel')?.getBoundingClientRect().height || 0
  })`);
  console.log("Initial layout:", initial);

  // Check zoom buttons exist
  const zoomBtns = await jsExpr(cdp, `document.querySelectorAll('.zoom-btn').length`);
  console.log("Zoom buttons:", zoomBtns);

  // Scan
  console.log("\nScanning...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = 'C:\\\\dev\\\\DiskRaptor'; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click(); 'clicked'`);
  await sleep(15000);

  // Check after scan
  const after = await jsExpr(cdp, `JSON.stringify({
    canvasExists: !!document.querySelector('#diagram-container canvas'),
    canvasRect: (() => { var c = document.querySelector('#diagram-container canvas'); return c ? JSON.stringify(c.getBoundingClientRect()) : 'null'; })(),
    diagramPanelTop: document.getElementById('diagram-panel')?.getBoundingClientRect().top || 0,
    diagramPanelHeight: document.getElementById('diagram-panel')?.getBoundingClientRect().height || 0,
    windowInnerHeight: window.innerHeight,
    zoomBtns: document.querySelectorAll('.zoom-btn').length,
    zoomLabel: (document.getElementById('zoom-label') || {}).textContent || 'missing',
    activeZoomBtn: (document.querySelector('.zoom-btn.active') || {}).textContent || 'none',
    hasPieContent: (() => {
      var c = document.querySelector('#diagram-container canvas');
      if (!c) return false;
      var ctx = c.getContext('2d');
      var imgData = ctx.getImageData(0, 0, Math.min(100, c.width), Math.min(100, c.height));
      var nonBlack = 0;
      for (var i = 0; i < imgData.data.length; i += 16) {
        if (imgData.data[i] > 10 || imgData.data[i+1] > 10 || imgData.data[i+2] > 10) nonBlack++;
      }
      return nonBlack > 10;
    })()
  })`);
  console.log("After scan:", after);

  // Test zoom preset
  console.log("\nTesting zoom presets...");
  // Click 50% zoom
  await jsExpr(cdp, `document.querySelector('.zoom-btn[data-zoom="0.5"]').click(); 'clicked'`);
  await sleep(500);
  const zoom50 = await jsExpr(cdp, `(document.getElementById('zoom-label') || {}).textContent || ''`);
  console.log("  After 50% click, label:", zoom50);

  // Click Fit
  await jsExpr(cdp, `document.querySelector('.zoom-btn[data-zoom="fit"]').click(); 'clicked'`);
  await sleep(500);
  const zoomFit = await jsExpr(cdp, `(document.getElementById('zoom-label') || {}).textContent || ''`);
  console.log("  After Fit click, label:", zoomFit);

  // Click 100%
  await jsExpr(cdp, `document.querySelector('.zoom-btn[data-zoom="1"]').click(); 'clicked'`);
  await sleep(500);
  const zoom100 = await jsExpr(cdp, `(document.getElementById('zoom-label') || {}).textContent || ''`);
  console.log("  After 100% click, label:", zoom100);

  cdp.close();
  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore" }); } catch {}
  console.log("\n=== DONE ===");
}

main().catch((err) => {
  console.error("\nFAILED:", err.message);
  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore" }); } catch {}
  process.exit(1);
});
