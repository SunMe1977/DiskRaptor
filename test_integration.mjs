/**
 * DiskRaptor Integration Test — browse, scan, verify results
 * Usage: node test_integration.mjs
 */
import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";

const CDP_PORT = 9225;
const DIST_DIR = path.resolve("dist");
const EXE_PATH = path.join(DIST_DIR, "DiskRaptor.exe");
const HOME_DIR = os.homedir();
const TEST_DIR = process.cwd();

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
    try { const m = JSON.parse(raw.toString()); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } } catch {}
  });
  await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 10000); });
  return {
    async send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const msgId = ++id;
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params }));
        setTimeout(() => reject(new Error(`${method} timeout`)), 60000);
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
  console.log("\n=== DiskRaptor Integration Test ===\n");
  let passed = 0, failed = 0;
  const startTime = Date.now();

  killAll();
  await sleep(2000);
  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);

  // Launch
  console.log("Launching EXE...");
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
  console.log("✓ EXE launched");

  // Wait for bridge
  for (let i = 0; i < 30; i++) {
    const ok = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function')");
    if (ok) break;
    await sleep(500);
  }
  console.log("✓ Bridge connected\n");

  // ── Test 1: Browse current dir via pick_directory ──
  console.log("── Test 1: Browse (pick_directory) ──");
  try {
    const result = await jsExpr(cdp,
      `window.__TAURI__.invoke('pick_directory').then(r => JSON.stringify(r)).catch(e => 'ERR:'+e.message)`
    );
    if (result && !result.startsWith("ERR:")) {
      const data = JSON.parse(result);
      console.log(`  ✓ pick_directory returned: ${data?.data || '(dialog cancelled)'}`);
      passed++;
    } else {
      console.log(`  ✗ pick_directory failed: ${result}`);
      failed++;
    }
  } catch (e) { console.log(`  ✗ ${e.message}`); failed++; }

  // ── Test 2: Scan current working directory ──
  console.log("\n── Test 2: Scan project dir ──");
  try {
    const scanPath = TEST_DIR.replace(/\\/g, "/");
    await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(scanPath)}`);
    await jsExpr(cdp, `document.getElementById('btn-scan').click()`);

    // Wait for overlay
    let overlay = false;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (o) { overlay = true; break; }
    }
    if (!overlay) { console.log("  ✗ Overlay never appeared"); failed++; }
    else {
      console.log("  ✓ Scan started");
      passed++;

      // Wait for completion
      let completed = false;
      let maxFiles = 0, maxDirs = 0;
      for (let i = 0; i < 600; i++) {
        await sleep(500);
        try {
          const json = await jsExpr(cdp, `JSON.stringify({
            f: document.getElementById('progress-files')?.textContent || '0',
            d: document.getElementById('progress-dirs')?.textContent || '0',
            ov: document.getElementById('progress-overlay')?.classList.contains('active'),
            st: document.querySelector('.status-bar')?.textContent || ''
          })`);
          const m = JSON.parse(json || "{}");
          const files = parseInt((m.f || "0").replace(/,/g, "")) || 0;
          const dirs = parseInt((m.d || "0").replace(/,/g, "")) || 0;
          if (files > maxFiles) maxFiles = files;
          if (dirs > maxDirs) maxDirs = dirs;
          if (m.ov === false && maxFiles > 0) { completed = true; break; }
          if ((m.st || "").includes("Complete")) { completed = true; break; }
        } catch {}
      }

      if (completed && maxFiles > 0) {
        console.log(`  ✓ Scan completed: ${maxFiles} files, ${maxDirs} dirs`);
        passed++;
      } else {
        console.log(`  ✗ Scan incomplete: ${maxFiles} files, ${maxDirs} dirs`);
        failed++;
      }
    }
  } catch (e) { console.log(`  ✗ ${e.message}`); failed++; }

  // ── Test 3: Verify scan results ──
  console.log("\n── Test 3: Scan results ──");
  await sleep(2000);
  try {
    const stats = await jsExpr(cdp, `JSON.stringify({
      files: document.getElementById('stat-files')?.textContent || '',
      dirs: document.getElementById('stat-dirs')?.textContent || '',
      size: document.getElementById('stat-size')?.textContent || '',
      time: document.getElementById('stat-time')?.textContent || '',
      treeNodes: document.querySelectorAll('.tree-node')?.length || 0,
      treeHtml: (document.getElementById('tree-scroll')?.innerHTML?.length || 0),
      status: document.querySelector('.status-bar')?.textContent || '',
      chart: !!document.querySelector('.diagram-mode.active'),
    })`);
    const s = JSON.parse(stats || "{}");
    const statFiles = parseInt((s.files || "").replace(/,/g, "")) || 0;
    const statDirs = parseInt((s.dirs || "").replace(/,/g, "")) || 0;
    const sizeOk = s.size && s.size !== '—' && s.size !== '-' && s.size !== '0 B';

    console.log(`  Files: ${s.files}`);
    console.log(`  Dirs:  ${s.dirs}`);
    console.log(`  Size:  ${s.size}`);
    console.log(`  Time:  ${s.time}`);
    console.log(`  Tree:  ${s.treeNodes} nodes, ${s.treeHtml} bytes HTML`);

    if (statFiles > 0 && statDirs > 0 && sizeOk) {
      console.log(`  ✓ Stats populated correctly`);
      passed++;
    } else {
      console.log(`  ✗ Stats missing: files=${statFiles} dirs=${statDirs} sizeOk=${sizeOk}`);
      failed++;
    }
  } catch (e) { console.log(`  ✗ ${e.message}`); failed++; }

  // ── Result ──
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}/${passed + failed}`);
  console.log(`  Failed: ${failed}/${passed + failed}`);
  console.log(`  Time: ${elapsed}s`);
  if (failed > 0) console.log(`  ✗ FAILED`);

  cdp.close();
  killAll();
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
