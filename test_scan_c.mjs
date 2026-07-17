/**
 * DiskRaptor C: Drive Scan Test
 * Scans C:\ root and verifies tree shows real directories via chunk loader.
 * Usage: node test_scan_c.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9222;
const SCAN_PATH = "C:\\";
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
  console.log(`\n=== DiskRaptor C: Drive Scan Test ===`);
  console.log(`Path: ${SCAN_PATH}\n`);

  killAll();
  await sleep(2000);
  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);

  // Launch
  console.log("Launching...");
  const startTime = Date.now();
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
  console.log(`\u2713 App launched (${Date.now() - startTime}ms)`);

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // Wait for bridge
  for (let i = 0; i < 30; i++) {
    const ok = await jsExpr(cdp, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function')");
    if (ok) break;
    await sleep(500);
  }
  console.log("\u2713 Bridge ready");

  // Set scan path to C:\
  console.log(`\nScanning ${SCAN_PATH}...`);
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click()`);

  // Monitor progress
  let overlayShown = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (ov) { overlayShown = true; break; }
  }
  if (!overlayShown) throw new Error("Progress overlay didn't appear");

  // Wait for scan to complete (up to 5 minutes)
  console.log("Scanning...");
  let completed = false;
  let lastFiles = 0;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try {
      const m = await jsExpr(cdp, `JSON.stringify({
        f: document.getElementById('progress-files')?.textContent || '0',
        d: document.getElementById('progress-dirs')?.textContent || '0',
        ov: document.getElementById('progress-overlay')?.classList.contains('active')
      })`);
      const p = JSON.parse(m || "{}");
      const files = parseInt((p.f || "0").replace(/,/g, "")) || 0;
      if (files > 0 && files !== lastFiles) {
        const dirs = parseInt((p.d || "0").replace(/,/g, "")) || 0;
        console.log(`  ${(files / 1000000).toFixed(1)}M files, ${(dirs / 1000).toFixed(0)}K dirs`);
        lastFiles = files;
      }
      if (p.ov === false && lastFiles > 0) {
        completed = true;
        break;
      }
    } catch {}
  }
  if (!completed) throw new Error("Scan did not complete");

  // Wait for tree to build
  await sleep(3000);

  // Check stats panel
  const stats = await jsExpr(cdp, `JSON.stringify({
    files: document.getElementById('stat-files')?.textContent || '',
    dirs: document.getElementById('stat-dirs')?.textContent || '',
    size: document.getElementById('stat-size')?.textContent || '',
    time: document.getElementById('stat-time')?.textContent || ''
  })`);
  console.log(`\nStats:\n${JSON.stringify(JSON.parse(stats || "{}"), null, 2)}`);

  // Check tree via chunk loader data (all nodes, not just visible rows)
  const treeData = await jsExpr(cdp, `JSON.stringify({
    totalNodes: window.__loader?.totalNodes || 0,
    totalChunks: window.__loader?.totalChunks || 0,
    loadedChunks: window.__loader?.loadedChunks?.size || 0,
    allNodesLen: window.__loader?.allNodes?.length || 0,
    firstNodeName: window.__loader?.allNodes?.[0]?.name || 'null',
    visibleNodes: window.__treeView?.visibleNodes?.length || 0
  })`);
  console.log(`\nTree data:\n${JSON.stringify(JSON.parse(treeData || "{}"), null, 2)}`);

  // Get all node names from chunk loader for directory detection
  const dirNames = await jsExpr(cdp, `JSON.stringify({
    allNodeNames: (window.__loader?.allNodes || []).filter(n => n && n.depth < 3).slice(0, 500).map(n => n.name),
    totalDirCount: (window.__loader?.allNodes || []).filter(n => n && n.node_type === 0).length,
    totalFileCount: (window.__loader?.allNodes || []).filter(n => n && n.node_type === 1).length
  })`);
  const dirData = JSON.parse(dirNames || "{}");
  const names = dirData.allNodeNames || [];
  const hasWindows = names.some(n => n && n.toLowerCase().includes("windows"));
  const hasProgramFiles = names.some(n => n && (n.includes("Program Files") || n.includes("Programme")));
  const hasUsers = names.some(n => n && (n === "Users" || n === "Benutzer"));

  console.log(`\nDirectories found (depth < 3, sample):`);
  console.log(`  ${names.slice(0, 40).join(', ')}`);

  console.log(`\nTree contains:`);
  console.log(`  Windows: ${hasWindows ? '\u2713' : '\u2717'}`);
  console.log(`  Program Files: ${hasProgramFiles ? '\u2713' : '\u2717'}`);
  console.log(`  Users: ${hasUsers ? '\u2713' : '\u2717'}`);
  console.log(`  Total dirs: ${dirData.totalDirCount}`);
  console.log(`  Total files: ${dirData.totalFileCount}`);

  // Verify stats have real values
  const statsObj = JSON.parse(stats || "{}");
  const statFiles = parseInt((statsObj.files || "").replace(/,/g, "")) || 0;
  const statDirs = parseInt((statsObj.dirs || "").replace(/,/g, "")) || 0;
  const sizeOk = statsObj.size && statsObj.size !== '-' && statsObj.size !== '\u2014';

  console.log(`\n=== RESULTS ===`);
  // Expected from admin PowerShell: ~3,126,014 files, ~432,081 dirs
  // Non-admin walkdir: ~3,045,419 files, ~408,534 dirs
  const minFiles = 3000000;
  const minDirs = 400000;
  const allOk = statFiles >= minFiles && statDirs >= minDirs && sizeOk && dirData.totalDirCount > 100;
  if (allOk) {
    console.log(`\u2713 PASS`);
    console.log(`  Files: ${statsObj.files}`);
    console.log(`  Dirs:  ${statsObj.dirs}`);
    console.log(`  Size:  ${statsObj.size}`);
    console.log(`  Time:  ${statsObj.time}`);
    console.log(`  Tree:  ${dirData.totalDirCount} directories`);
    console.log(`  Expected: >= 3M files, >= 400K dirs`);
  } else {
    console.log(`\u2717 FAIL`);
    if (statFiles < minFiles) console.log(`  Too few files: ${statFiles} (need >= ${minFiles})`);
    if (statDirs < minDirs) console.log(`  Too few dirs: ${statDirs} (need >= ${minDirs})`);
    if (!sizeOk) console.log(`  Size not populated: ${statsObj.size}`);
    if (dirData.totalDirCount <= 100) console.log(`  Too few dirs in tree: ${dirData.totalDirCount}`);
  }

  cdp.close();
  killAll();
  if (!allOk) process.exit(1);
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
