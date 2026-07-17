/**
 * DiskRaptor Scan Test — launches EXE, scans home dir, verifies progress.
 * Uses raw CDP via WebSocket.
 * Usage: node test_scan.mjs [path]
 * Default path: user's home directory
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";

const CDP_PORT = 9222;
const HOME_DIR = process.argv[2] || os.homedir();
const DIST_DIR = path.resolve("dist");
const EXE_PATH = path.join(DIST_DIR, "DiskRaptor.exe");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(data)); }
      });
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
      if (m.id !== undefined && pending.has(m.id)) {
        pending.get(m.id).resolve(m);
        pending.delete(m.id);
      }
    } catch {}
  });
  await new Promise((r, f) => {
    ws.on("open", r);
    ws.on("error", f);
    setTimeout(() => f(new Error("WS timeout")), 10000);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 15000);
      });
    },
    close() { ws.close(); },
  };
}

function cdpVal(r) {
  return r?.result?.result?.value;
}

function killAll() {
  try { execSync("taskkill /F /IM DiskRaptor.exe", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM QtWebEngineProcess.exe", { stdio: "ignore" }); } catch {}
}

async function jsExpr(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return cdpVal(r);
}

async function main() {
  console.log(`\n=== DiskRaptor Scan Test ===`);
  console.log(`Path: ${HOME_DIR}\n`);

  killAll();
  await sleep(2000);

  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);
  console.log(`✓ EXE: ${EXE_PATH}`);

  // Launch with CDP
  console.log("\nLaunching...");
  const startTime = Date.now();

  spawn(EXE_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) },
    detached: true,
    stdio: "ignore",
  }).unref();

  // Wait for CDP page
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
  if (!wsUrl) throw new Error("Could not find page WebSocket URL");
  console.log(`✓ Page WS ready (${Date.now() - startTime}ms)`);

  // Connect CDP
  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Console.enable");
  console.log("✓ CDP connected");

  // Wait for bridge to initialize (QWebChannel callback is async)
  console.log("Waiting for bridge...");
  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(cdp,
      "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)"
    );
    if (val === true) { bridgeOk = true; break; }
    await sleep(500);
  }
  if (bridgeOk) {
    console.log("✓ Bridge ready");
  } else {
    console.warn("  ⚠ Bridge not ready — checking page state...");
    const state = await jsExpr(cdp, `JSON.stringify({
      title: document.title,
      hasTauri: typeof window.__TAURI__ !== 'undefined',
      hasInvoke: typeof window.__TAURI__?.invoke === 'function',
      ready: window.__TAURI__?.__qtBridgeReady || false,
      statusBar: document.querySelector('.status-bar')?.textContent || ''
    })`);
    console.log(`  ${state}`);
    throw new Error("Bridge not ready");
  }

  // Test invoke
  const homeDir = await jsExpr(cdp,
    `window.__TAURI__.invoke('get_home_dir').then(r => JSON.stringify(r)).catch(e => 'ERR: ' + e.message)`
  );
  console.log(`✓ get_home_dir: ${homeDir}`);

  // Set scan path
  console.log(`\nPath: ${HOME_DIR}`);
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(HOME_DIR)}; 'ok'`);

  // Click Scan
  console.log("Scan...");
  await jsExpr(cdp, `document.getElementById('btn-scan').click(); 'clicked'`);

  // Wait for overlay
  console.log("\nWaiting for progress...");
  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp,
      `document.getElementById('progress-overlay')?.classList.contains('active')`
    );
    if (o === true) { overlayShown = true; break; }
    if (i % 10 === 9) console.log(`  still waiting... (${(i+1)*0.5}s)`);
  }
  console.log(`✓ Overlay: ${overlayShown}`);

  // Monitor scan progress
  console.log("\nMonitoring scan...\n");
  let maxFiles = 0, maxDirs = 0;
  let lastFiles = -1;
  let completed = false;

  for (let i = 0; i < 1200; i++) {
    await sleep(500);
    try {
      const json = await jsExpr(cdp, `JSON.stringify({
        f: document.getElementById('progress-files')?.textContent || '0',
        d: document.getElementById('progress-dirs')?.textContent || '0',
        s: document.getElementById('progress-speed-val')?.textContent || '',
        e: document.getElementById('progress-elapsed-val')?.textContent || '',
        dir: (document.getElementById('progress-dir')?.textContent || '').replace('📂 ',''),
        ov: document.getElementById('progress-overlay')?.classList.contains('active'),
        st: (document.querySelector('.status-bar')?.textContent || '')
      })`);

      const m = JSON.parse(json || "{}");
      const files = parseInt(m.f?.replace(/,/g, "")) || 0;
      const dirs = parseInt(m.d?.replace(/,/g, "")) || 0;
      if (files > maxFiles) maxFiles = files;
      if (dirs > maxDirs) maxDirs = dirs;

      if (m.ov && files > 0 && files !== lastFiles) {
        if (i % 10 === 0 || files < 100) {
          console.log(`  f:${m.f}  d:${m.d}  @${m.s}/s  ${m.e}${m.dir ? '  📂'+m.dir.slice(0,20) : ''}`);
        }
      }

      if (!m.ov && maxFiles > 0) {
        console.log(`\n✓ Scan complete`);
        completed = true;
        break;
      }
      if (m.st?.includes("Complete")) { completed = true; break; }
      if (m.st?.includes("Error")) { console.warn(`\n✗ ${m.st}`); break; }

      lastFiles = files;
    } catch {}
  }

  // Verify stats panel and result data
  await sleep(2000);
  let statsOk = false;
  if (completed) {
    try {
      const rawJson = await jsExpr(cdp, `JSON.stringify({
        files: document.getElementById('stat-files')?.textContent || '',
        dirs: document.getElementById('stat-dirs')?.textContent || '',
        size: document.getElementById('stat-size')?.textContent || '',
        time: document.getElementById('stat-time')?.textContent || '',
        hasTauri: typeof window.__TAURI__?.invoke === 'function'
      })`);
      const panel = JSON.parse(rawJson || "{}");
      const statFiles = parseInt((panel.files || "").replace(/,/g, "")) || 0;
      const statDirs = parseInt((panel.dirs || "").replace(/,/g, "")) || 0;
      const statSize = (panel.size || '').trim();
      const sizeOk = statSize !== '' && statSize !== '—' && statSize !== '-' && statSize !== '0 B';
      console.log(`\nStats panel:`);
      console.log(`  Files: ${panel.files}`);
      console.log(`  Dirs:  ${panel.dirs}`);
      console.log(`  Size:  '${statSize}'`);
      console.log(`  Time:  ${panel.time}`);
      // Check tree viewport has content
      let treeOk = false;
      try {
        const treeHtml = await jsExpr(cdp,
          `document.getElementById('tree-scroll')?.innerHTML?.length || 0`
        );
        const treeNodes = await jsExpr(cdp,
          `document.querySelectorAll('.tree-node')?.length || 0`
        );
        const chunkLoaderNodes = await jsExpr(cdp,
          `window.__chunkLoader?.allNodes?.length || 0`
        );
        const chunkInfo = await jsExpr(cdp,
          `JSON.stringify({
            totalNodes: window.__loader?.totalNodes || 0,
            totalChunks: window.__loader?.totalChunks || 0,
            loadedChunks: window.__loader?.loadedChunks?.size || 0,
            allNodesLen: window.__loader?.allNodes?.length || 0,
            scanId: window.__loader?.scanId,
            firstNode: window.__loader?.allNodes?.[0] ? window.__loader.allNodes[0].name : 'null',
            treeViewport: document.getElementById('tree-viewport')?.id || 'not found',
            visibleNodes: window.__treeView?.visibleNodes?.length || 0,
            maxSize: window.__treeView?.maxSize || 0,
            totalItems: window.__treeView?.vs?.getTotalItems?.() || 0,
            scrollHeight: document.getElementById('tree-scroll')?.clientHeight || 0,
            viewportHeight: window.__treeView?.vs?.viewportHeight || 0,
            rowCount: document.querySelectorAll('.tree-row')?.length || 0
          })`
        );
        treeOk = (parseInt(treeHtml) > 100) || (parseInt(treeNodes) > 0);
        console.log(`  Tree:   ${parseInt(treeNodes)} nodes, ${parseInt(treeHtml)} bytes HTML`);
        console.log(`  Loader: ${chunkLoaderNodes} nodes, ${chunkInfo}`);
      } catch (e) {
        console.warn(`  ⚠ Tree check: ${e.message}`);
      }
      if (statFiles > 0 && statDirs > 0 && sizeOk && treeOk) {
        statsOk = true;
      } else {
        console.warn(`  ⚠ Validation: files='${panel.files}' dirs='${panel.dirs}' size='${statSize}' tree=${treeOk}`);
      }
    } catch (e) {
      console.warn(`  ⚠ Stats read error: ${e.message}`);
    }
  }

  // Results
  console.log(`\n=== RESULTS ===`);
  if (completed && maxFiles > 0 && maxDirs > 0 && statsOk) {
    console.log(`✓ PASS`);
    console.log(`  Files: ${maxFiles.toLocaleString()}`);
    console.log(`  Dirs:  ${maxDirs.toLocaleString()}`);
    console.log(`  Time:  ${Math.round((Date.now() - startTime) / 1000)}s`);
  } else if (completed && maxFiles > 0) {
    console.log(`⚠ INCOMPLETE`);
    console.log(`  Files: ${maxFiles.toLocaleString()}`);
    console.log(`  Dirs:  ${maxDirs.toLocaleString()}`);
    if (!statsOk) console.log(`  Stats panel has missing data`);
  } else {
    console.log(`✗ FAIL`);
    console.log(`  Files: ${maxFiles}  Dirs: ${maxDirs}`);
    if (!overlayShown) console.log(`  Overlay never appeared`);
  }

  cdp.close();
  killAll();
  if (!completed || maxFiles === 0 || maxDirs === 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
