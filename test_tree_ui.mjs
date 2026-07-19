/**
 * UI test: verify tree percentage bars, 50/50 layout, and splitter
 * Usage: node test_tree_ui.mjs
 */
import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";

const CDP_PORT = 9245;
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
    try {
      const m = JSON.parse(raw.toString());
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    } catch {}
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
  console.log("=== Tree/Diagram UI Test ===\n");

  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore" }); } catch {}
  await sleep(2000);
  if (!fs.existsSync(EXE_PATH)) throw new Error("Missing: " + EXE_PATH);

  spawn(EXE_PATH, [], { cwd: DIST_DIR, env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) }, stdio: "ignore" }).unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) { wsUrl = pages[0].webSocketDebuggerUrl; break; }
    } catch {}
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

  // 1. Check 50/50 layout: tree-panel and diagram-panel heights
  console.log("\n[1] Checking 50/50 layout...");
  const layoutCheck = await jsExpr(cdp, `JSON.stringify({
    leftColHeight: document.getElementById('left-column')?.getBoundingClientRect().height || 0,
    treePanel: (() => { var e = document.getElementById('tree-panel'); return e ? e.getBoundingClientRect().height : 0; })(),
    diagramPanel: (() => { var e = document.getElementById('diagram-panel'); return e ? e.getBoundingClientRect().height : 0; })(),
    hSplit: (() => { var e = document.getElementById('h-splitter'); return e ? e.getBoundingClientRect().height : 0; })(),
    diagramContainer: (() => { var e = document.getElementById('diagram-container'); return e ? e.getBoundingClientRect().height : 0; })(),
  })`);
  const layout = JSON.parse(layoutCheck || "{}");
  console.log(`  Left column: ${layout.leftColHeight}px`);
  console.log(`  Tree panel:  ${layout.treePanel}px`);
  console.log(`  Diagram:     ${layout.diagramPanel}px`);
  const total = layout.treePanel + layout.hSplit + layout.diagramPanel;
  const ratio = layout.treePanel / Math.max(1, layout.diagramPanel);
  console.log(`  Ratio tree/diagram: ${ratio.toFixed(2)} (should be ~1.0)`);
  if (Math.abs(ratio - 1.0) < 0.3) {
    console.log("  ✓ 50/50 layout OK");
  } else {
    console.log(`  ⚠ Ratio off: ${ratio.toFixed(2)}`);
  }

  // 2. Verify percentage bars in tree after scan
  console.log("\n[2] Scanning and checking percentage bars...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = 'C:\\\\dev\\\\DiskRaptor'; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click(); 'clicked'`);
  await sleep(8000);

  const treeCheck = await jsExpr(cdp, `JSON.stringify({
    rows: document.querySelectorAll('.tree-row').length,
    samples: (function() {
      var rows = document.querySelectorAll('.tree-row');
      var r = [];
      for (var i = 0; i < Math.min(5, rows.length); i++) {
        var pctFill = rows[i].querySelector('.tree-pct-fill');
        var pctText = rows[i].querySelector('.node-pct');
        if (!pctFill) { r.push({i: i, missing: true}); continue; }
        r.push({
          i: i,
          width: pctFill.style.width,
          bg: (pctFill.style.background || '').substring(0, 50),
          pct: pctText ? pctText.textContent : 'missing'
        });
      }
      return r;
    })()
  })`);
  const tree = JSON.parse(treeCheck || "{}");
  console.log(`  Rows: ${tree.rows}`);
  if (tree.samples) {
    tree.samples.forEach(s => {
      if (s.missing) console.log(`  ⚠ Row ${s.i}: MISSING pct bar`);
      else console.log(`  ✓ Row ${s.i}: width=${s.width} bg=${s.bg} pct=${s.pct}`);
    });
  }

  // 3. Test splitter resize
  console.log("\n[3] Testing splitter resize...");
  const splitterCheck = await jsExpr(cdp, `JSON.stringify({
    hSplitExists: !!document.getElementById('h-splitter'),
    hSplitVisible: (() => { var e = document.getElementById('h-splitter'); return e ? e.offsetHeight > 0 : false; })(),
    vSplitExists: !!document.getElementById('v-splitter'),
    cursor: document.getElementById('h-splitter')?.style?.cursor || 'default',
  })`);
  console.log(`  Splitter: ${splitterCheck}`);

  // Simulate drag: mousedown, mousemove, mouseup
  const dragTest = await jsExpr(cdp, `(function() {
    var hSplit = document.getElementById('h-splitter');
    if (!hSplit) return 'no splitter';
    var diagPanel = document.getElementById('diagram-panel');
    var beforeH = diagPanel ? diagPanel.getBoundingClientRect().height : 0;
    // Dispatch mousedown on splitter
    var rect = hSplit.getBoundingClientRect();
    var startY = rect.top + rect.height / 2;
    var md = new MouseEvent('mousedown', {clientY: startY, clientX: rect.left + 10, bubbles: true});
    hSplit.dispatchEvent(md);
    // Dispatch mousemove (drag up 50px)
    var mm = new MouseEvent('mousemove', {clientY: startY - 50, clientX: rect.left + 10, bubbles: true});
    document.dispatchEvent(mm);
    // Dispatch mouseup
    var mu = new MouseEvent('mouseup', {bubbles: true});
    document.dispatchEvent(mu);
    var afterH = diagPanel ? diagPanel.getBoundingClientRect().height : 0;
    return JSON.stringify({beforeH: beforeH, afterH: afterH, diff: afterH - beforeH});
  })()`);
  console.log(`  Drag test: ${dragTest}`);

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
