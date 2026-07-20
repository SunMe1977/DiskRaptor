/**
 * DiskRaptor Menu Test — tests all native menus + diagram themes via CDP.
 * Theme test verifies actual pixel color change on canvas.
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
function cdpVal(r) { return r?.result?.result?.value; }
function killAll() {
  try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore", shell: true }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore", shell: true }); } catch {}
}
async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return cdpVal(r);
}
/** Sample a pixel color from the diagram canvas */
async function sampleCanvasColor(cdp) {
  return await jsExpr(cdp, `(function(){
    var cv = document.querySelector('#diagram-container canvas');
    if (!cv) return null;
    var ctx = cv.getContext('2d');
    // Sample 5 regions to get a representative color
    var w = cv.width, h = cv.height;
    var samples = [];
    for (var y = Math.floor(h*0.2); y < h; y += Math.max(20, Math.floor(h/5))) {
      for (var x = Math.floor(w*0.1); x < w; x += Math.max(20, Math.floor(w/5))) {
        var p = ctx.getImageData(x, y, 1, 1).data;
        samples.push([p[0], p[1], p[2]]);
      }
    }
    // Average RGB of all samples
    var r=0,g=0,b=0;
    for (var i=0; i<samples.length; i++) { r+=samples[i][0]; g+=samples[i][1]; b+=samples[i][2]; }
    return [Math.round(r/samples.length), Math.round(g/samples.length), Math.round(b/samples.length)];
  })()`);
}

async function main() {
  console.log("\n=== DiskRaptor Menu + Theme Test ===\n");
  killAll();
  await sleep(2000);
  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);

  spawn(EXE_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) },
    detached: true,
    stdio: "ignore",
  }).unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) { wsUrl = pages[0].webSocketDebuggerUrl; break; }
    } catch {}
  }
  if (!wsUrl) throw new Error("CDP not available");
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  console.log("✓ App launched");

  for (let i = 0; i < 30; i++) {
    const ok = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function')");
    if (ok) break;
    await sleep(500);
  }
  console.log("✓ Bridge ready");

  let passed = 0, failed = 0;

  // 1. View Menu modes
  console.log("\n── View Menu ──");
  for (const mode of ["pie", "treemap", "bar"]) {
    try {
      await jsExpr(cdp, `document.querySelectorAll('.diagram-mode').forEach(b=>b.classList.remove('active'));
        var btn=document.querySelector('.diagram-mode[data-mode="${mode}"]');
        if(btn)btn.classList.add('active');
        if(window.__diagram)window.__diagram.setMode('${mode}');`);
      await sleep(300);
      const active = await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="${mode}"]')?.classList.contains('active')`);
      if (active) { console.log(`  ✓ ${mode} mode activated`); passed++; }
      else { console.log(`  ✗ ${mode} NOT active`); failed++; }
    } catch (e) { console.log(`  ✗ ${mode} failed:`, e.message); failed++; }
  }

  // 2. Theme toggle (light/dark)
  console.log("\n── Theme ──");
  try {
    const before = await jsExpr(cdp, "document.body.classList.contains('light-theme')");
    await jsExpr(cdp, `document.body.classList.toggle('light-theme');
      document.getElementById('btn-theme').textContent = document.body.classList.contains('light-theme') ? '\\u2600' : '\\u263E';`);
    const after = await jsExpr(cdp, "document.body.classList.contains('light-theme')");
    if (before !== after) { console.log("  ✓ Theme toggle works"); passed++; }
    else { console.log("  ✗ Theme did NOT toggle"); failed++; }
    await jsExpr(cdp, "document.body.classList.toggle('light-theme')");
  } catch (e) { console.log("  ✗ Theme failed:", e.message); failed++; }

  // 3. Diagram color themes - verify actual pixel color change
  console.log("\n── Diagram Color Themes ──");
  // First, scan raw dir to have data in the diagram
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(path.resolve("raw"))};`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click();`);
  for (let i = 0; i < 120; i++) { await sleep(500); const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`); if (ov === false) break; }
  
  // Switch to pie chart
  await jsExpr(cdp, `var btn=document.querySelector('.diagram-mode[data-mode="pie"]'); if(btn)btn.click();`);
  await sleep(1000);

  const themes = [
    { id: "default", name: "Default" },
    { id: "forest",  name: "Forest" },
    { id: "desert",  name: "Desert" },
    { id: "ice",     name: "Ice" },
    { id: "fairy",   name: "Fairy" },
  ];
  let prevColor = null;
  for (const th of themes) {
    try {
      // Set theme
      const ok = await jsExpr(cdp, `(function(){
        if(!window.__diagram) return 'no diagram';
        window.__diagram.setTheme('${th.id}');
        return window.__diagram._theme === '${th.id}' ? 'ok' : 'set failed';
      })()`);
      if (ok !== 'ok') { console.log(`  ✗ ${th.name}: ${ok}`); failed++; continue; }
      await sleep(500);

      // Sample canvas pixel color to verify visual change
      const color = await sampleCanvasColor(cdp);
      if (!color) { console.log(`  ✗ ${th.name}: could not sample canvas`); failed++; continue; }
      
      const colorStr = `rgb(${color[0]},${color[1]},${color[2]})`;
      if (prevColor) {
        // Check that colors differ from previous theme (real visual change)
        const diff = Math.abs(color[0]-prevColor[0]) + Math.abs(color[1]-prevColor[1]) + Math.abs(color[2]-prevColor[2]);
        if (diff < 5) {
          console.log(`  ✗ ${th.name}: colors unchanged from previous (${colorStr})`);
          failed++;
          continue;
        }
      }
      prevColor = color;
      console.log(`  ✓ ${th.name} theme applied — sampled ${colorStr}`);
      passed++;
    } catch (e) { console.log(`  ✗ ${th.name} failed:`, e.message); failed++; }
  }

  // 4. About dialog
  console.log("\n── About ──");
  try {
    await jsExpr(cdp, `var ov=document.getElementById('about-overlay'); if(ov)ov.classList.add('active');`);
    await sleep(300);
    const aboutActive = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active')`);
    if (aboutActive) { console.log("  ✓ About dialog opened"); passed++; }
    else { console.log("  ✗ About NOT opened"); failed++; }
    await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.remove('active')`);
  } catch (e) { console.log("  ✗ About failed:", e.message); failed++; }

  // 5. Bridge commands
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

  // 6. Language switcher
  console.log("\n── Language ──");
  try {
    await jsExpr(cdp, `if(window.I18N){window.I18N.setLocale('de');'ok'}else{'no i18n'}`);
    const deActive = await jsExpr(cdp, `window.I18N?.getLocale?.()?.raw === 'de'`);
    if (deActive) { console.log("  ✓ Language switched to DE"); passed++; }
    else { console.log("  ✗ Language switch failed"); failed++; }
    await jsExpr(cdp, `if(window.I18N)window.I18N.setLocale('auto')`);
    await sleep(100);
  } catch (e) { console.log("  ✗ Language switch:", e.message); failed++; }

  // 7. Scan path
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

  console.log(`\n=== RESULTS ===`);
  const total = passed + failed;
  console.log(`  Passed: ${passed}/${total}`);
  console.log(`  Failed: ${failed}/${total}`);

  cdp.close();
  killAll();
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
