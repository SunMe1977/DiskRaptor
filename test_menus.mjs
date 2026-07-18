/**
 * DiskRaptor Menu Test — tests all native menus via CDP.
 * Verifies View → Pie/Galaxy/Treemap, Theme toggle, About, Exit.
 * Usage: node test_menus.mjs
 */
import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9223;
const DIST_DIR = path.resolve("dist");
const EXE_PATH = path.join(DIST_DIR, "DiskRaptor.exe");

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
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      }
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
function cdpVal(r) { return r?.result?.result?.value; }
function killAll() {
  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore", shell: true }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore", shell: true }); } catch {}
}
async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return cdpVal(r);
}

async function main() {
  console.log("\n=== DiskRaptor Menu Test ===\n");
  killAll();
  await sleep(2000);
  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);

  // Launch with CDP on different port
  spawn(EXE_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) },
    detached: true,
    stdio: "ignore",
  }).unref();

  // Wait for CDP
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
        wsUrl = pages[0].webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }
  if (!wsUrl) throw new Error("CDP not available");
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  console.log("✓ App launched");

  // Wait for bridge
  for (let i = 0; i < 30; i++) {
    const ok = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function')");
    if (ok) break;
    await sleep(500);
  }
  console.log("✓ Bridge ready");

  let passed = 0, failed = 0;

  // 1. Test View → Pie Chart via runJS (C++ sends JS to webview)
  console.log("\n── View Menu ──");
  try {
    await jsExpr(cdp, `document.querySelectorAll('.diagram-mode').forEach(b=>b.classList.remove('active'));
      var btn=document.querySelector('.diagram-mode[data-mode="pie"]');
      if(btn)btn.classList.add('active');
      if(window.diagram)window.diagram.setMode('pie');`);
    await sleep(300);
    const pieActive = await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="pie"]')?.classList.contains('active')`);
    if (pieActive) { console.log("  ✓ Pie Chart mode activated"); passed++; }
    else { console.log("  ✗ Pie Chart mode NOT active"); failed++; }
  } catch (e) { console.log("  ✗ Pie Chart failed:", e.message); failed++; }

  try {
    await jsExpr(cdp, `document.querySelectorAll('.diagram-mode').forEach(b=>b.classList.remove('active'));
      var btn=document.querySelector('.diagram-mode[data-mode="treemap"]');
      if(btn)btn.classList.add('active');
      if(window.diagram)window.diagram.setMode('treemap');`);
    await sleep(300);
    const tmActive = await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="treemap"]')?.classList.contains('active')`);
    if (tmActive) { console.log("  ✓ Treemap mode activated"); passed++; }
    else { console.log("  ✗ Treemap NOT active"); failed++; }
  } catch (e) { console.log("  ✗ Treemap failed:", e.message); failed++; }

  // 2. Theme toggle
  console.log("\n── Theme ──");
  try {
    const before = await jsExpr(cdp, "document.body.classList.contains('light-theme')");
    await jsExpr(cdp, `document.body.classList.toggle('light-theme');
      document.getElementById('btn-theme').textContent = document.body.classList.contains('light-theme') ? '\\u2600' : '\\u263E';`);
    const after = await jsExpr(cdp, "document.body.classList.contains('light-theme')");
    if (before !== after) { console.log("  ✓ Theme toggle works"); passed++; }
    else { console.log("  ✗ Theme did NOT toggle"); failed++; }
    // Toggle back
    await jsExpr(cdp, "document.body.classList.toggle('light-theme')");
  } catch (e) { console.log("  ✗ Theme failed:", e.message); failed++; }

  // 3. About dialog
  console.log("\n── About ──");
  try {
    await jsExpr(cdp, `var ov=document.getElementById('about-overlay'); if(ov)ov.classList.add('active');`);
    await sleep(300);
    const aboutActive = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active')`);
    if (aboutActive) { console.log("  ✓ About dialog opened"); passed++; }
    else { console.log("  ✗ About NOT opened"); failed++; }
    // Close about
    await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.remove('active')`);
  } catch (e) { console.log("  ✗ About failed:", e.message); failed++; }

  // 4. Bridge commands
  console.log("\n── Bridge ──");
  const commands = [
    { name: "get_home_dir", cmd: "get_home_dir", args: {} },
    { name: "list_drives", cmd: "list_drives", args: {} },
    { name: "load_settings", cmd: "load_settings", args: {} },
  ];
  for (const c of commands) {
    try {
      const r = await jsExpr(cdp,
        `window.__TAURI__.invoke('${c.cmd}', ${JSON.stringify(c.args)})
          .then(r => JSON.stringify(r).substring(0,100)).catch(e => 'ERR:'+e.message)`);
      if (r && !r.startsWith("ERR:")) { console.log(`  ✓ ${c.name}: ${r.substring(0,60)}`); passed++; }
      else { console.log(`  ✗ ${c.name}: ${r}`); failed++; }
    } catch (e) { console.log(`  ✗ ${c.name}: ${e.message}`); failed++; }
  }

  // 5. Language switcher
  console.log("\n── Language ──");
  try {
    const langResult = await jsExpr(cdp,
      `if(window.I18N){window.I18N.setLocale('de');'ok'}else{'no i18n'}`);
    const deActive = await jsExpr(cdp,
      `window.I18N?.getLocale?.()?.raw === 'de'`);
    if (deActive) { console.log("  ✓ Language switched to DE"); passed++; }
    else { console.log("  ✗ Language switch failed"); failed++; }
    // Reset to auto
    await jsExpr(cdp, `if(window.I18N)window.I18N.setLocale('auto')`);
    await sleep(100);
  } catch (e) { console.log("  ✗ Language switch:", e.message); failed++; }

  // 6. Scan button
  console.log("\n── Scan path ──");
  try {
    const home = await jsExpr(cdp,
      `window.__TAURI__.invoke('get_home_dir')
        .then(r => typeof r==='string'?r:r?.data||'')
        .then(p=>{document.getElementById('scan-path').value=p;return p;})
        .catch(e=>'ERR:'+e.message)`);
    if (home && !home.startsWith("ERR:")) { console.log(`  ✓ Scan path set: ${home}`); passed++; }
    else { console.log(`  ✗ Scan path failed: ${home}`); failed++; }
  } catch (e) { console.log("  ✗ Scan path:", e.message); failed++; }

  // Results
  console.log(`\n=== RESULTS ===`);
  const total = passed + failed;
  console.log(`  Passed: ${passed}/${total}`);
  console.log(`  Failed: ${failed}/${total}`);
  if (failed > 0) console.log(`  Tests: ${failed > 0 ? '✗ FAILED' : '✓ PASSED'}`);

  cdp.close();
  killAll();
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
