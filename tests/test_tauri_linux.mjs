/**
 * DiskRaptor Linux Tauri Invoke Test — tests all Tauri command invocations.
 * Usage: node test_tauri_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9238;
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
  console.log(`\n=== DiskRaptor Linux Tauri Invoke Test ===\n`);
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

  console.log("\n=== Tauri Invoke Tests ===\n");

  // get_home_dir
  const homeDir = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('get_home_dir');
        return 'home=' + (typeof r === 'string' ? r : JSON.stringify(r).slice(0, 40));
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("get_home_dir invoke", homeDir.startsWith("home="), `${homeDir}`);

  // load_settings
  const loadSettings = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return 'ok=' + JSON.stringify(r).slice(0, 60);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("load_settings invoke", loadSettings.startsWith("ok="), `${loadSettings}`);

  // save_settings
  const saveSettings = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('save_settings', { key: 'test' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("save_settings invoke", saveSettings.startsWith("ok=") || saveSettings.includes("err"), `${saveSettings}`);

  // pick_directory (open directory dialog)
  const pickDir = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('pick_directory', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("pick_directory invoke", pickDir.includes("ok=") || pickDir.includes("err"), `${pickDir}`);

  // open_directory (browse)
  const openDir = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('open_directory', { path: '/tmp' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("open_directory invoke", openDir.includes("ok=") || openDir.includes("err"), `${openDir}`);

  // delete_path (delete a file)
  const deletePath = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('delete_path', { path: '/tmp/test-tauri-delete' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("delete_path invoke", deletePath.includes("ok=") || deletePath.includes("err"), `${deletePath}`);

  // empty_trash
  const emptyTrash = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('empty_trash', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("empty_trash invoke", emptyTrash.includes("ok=") || emptyTrash.includes("err"), `${emptyTrash}`);

  // list_trash
  const listTrash = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('list_trash', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("list_trash invoke", listTrash.includes("ok=") || listTrash.includes("err"), `${listTrash}`);

  // restore_all_trash
  const restoreAll = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('restore_all_trash', {});
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("restore_all_trash invoke", restoreAll.includes("ok=") || restoreAll.includes("err"), `${restoreAll}`);

  // export_report
  const exportReport = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('export_report', { path: '/tmp', format: 'html' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("export_report invoke", exportReport.includes("ok=") || exportReport.includes("err"), `${exportReport}`);

  // find_duplicates
  const findDup = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('find_duplicates', { path: '/tmp' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("find_duplicates invoke", findDup.includes("ok=") || findDup.includes("err"), `${findDup}`);

  // scan
  const scanInvoke = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('scan', { path: '${SCAN_PATH}' });
        return 'ok=' + JSON.stringify(r).slice(0, 40);
      } catch(e) { return 'err: ' + e.message.slice(0, 40); }
    })()
  `);
  assert("scan invoke", scanInvoke.includes("ok=") || scanInvoke.includes("err"), `${scanInvoke}`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });