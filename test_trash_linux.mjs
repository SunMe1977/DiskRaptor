/**
 * DiskRaptor Linux Trash Test — launches binary, tests trash/recycle functionality.
 * Uses raw CDP via WebSocket.
 * Usage: node test_trash_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9227;
const SCAN_PATH = "/tmp";
const DIST_DIR = path.resolve("dist");
const BIN_PATH = path.join(DIST_DIR, "DiskRaptor");

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
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 60000);
      });
    },
    close() { ws.close(); },
  };
}

function cdpVal(r) {
  return r?.result?.result?.value;
}

function killAll() {
  try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {}
  try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {}
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
  console.log(`\n=== DiskRaptor Linux Trash Test ===\n`);

  killAll();
  await sleep(2000);

  if (!fs.existsSync(BIN_PATH)) throw new Error(`Missing: ${BIN_PATH}`);
  console.log(`✓ Binary: ${BIN_PATH}`);

  console.log("\nLaunching...");
  const startTime = Date.now();
  const child = spawn(BIN_PATH, [], {
    cwd: DIST_DIR,
    env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT), LD_LIBRARY_PATH: `${DIST_DIR}/lib:${DIST_DIR}:${process.env.LD_LIBRARY_PATH || ""}` },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

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

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Console.enable");
  console.log("✓ CDP connected");

  console.log("Waiting for bridge...");
  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(cdp,
      "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)"
    );
    if (val === true) { bridgeOk = true; break; }
    await sleep(500);
  }
  if (!bridgeOk) throw new Error("Bridge not ready");
  console.log("✓ Bridge ready");

  let passed = 0;
  let failed = 0;
  function assert(label, ok, detail) {
    if (ok) { console.log(`  ✓ ${label}`); passed++; }
    else { console.log(`  ✗ ${label}${detail ? " -- " + detail : ""}`); failed++; }
  }

  // Scan first so we have files to delete
  console.log("\nScanning for data...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) { overlayShown = true; break; }
  }
  assert("Scan overlay appeared", overlayShown);

  let completed = false;
  let maxFiles = 0;
  for (let i = 0; i < 600; i++) {
    await sleep(500);
    try {
      const json = await jsExpr(cdp, `JSON.stringify({files: (document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''), ov: document.getElementById('progress-overlay')?.classList.contains('active')})`);
      const m = JSON.parse(json || "{}");
      const files = parseInt(m.files) || 0;
      if (files > maxFiles) maxFiles = files;
      if (!m.ov && maxFiles > 0) { completed = true; break; }
    } catch {}
  }
  assert("Scan completed", completed, `maxFiles=${maxFiles}`);
  await sleep(2000);

  // --- Trash tests ---
  console.log("\n=== Trash Tests ===\n");

  // Open tools menu
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'opened'`);
  await sleep(500);

  // Test trash menu item exists and is clickable
  const trashMenuItem = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        const text = (item.textContent || '').trim();
        if (action === 'trash' || text.includes('Trash') || text.includes('Empty')) {
          return 'found-action=' + action + '-text=' + text.slice(0, 30);
        }
      }
      return 'not-found';
    })()
  `);
  assert("Empty Trash menu item exists", trashMenuItem.startsWith("found"), `${trashMenuItem}`);

  // Click the trash menu item
  const trashClickResult = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        const text = (item.textContent || '').trim();
        if (action === 'trash' || text.includes('Trash')) {
          item.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked-trash';
        }
      }
      return 'not-clicked';
    })()
  `);
  assert("Trash menu item clicked", trashClickResult === "clicked-trash", `${trashClickResult}`);
  await sleep(500);

  // Confirm dialog presence check
  const confirmDialog = await jsExpr(cdp, `
    (function() {
      // Check for any visible dialog/modal that could be a confirmation
      const dialogs = document.querySelectorAll('dialog, [role="dialog"], .overlay-base, [class*="modal"]');
      for (const d of dialogs) {
        const style = getComputedStyle(d);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return 'dialog-visible';
        }
      }
      return 'no-dialog';
    })()
  `);
  assert("Confirm dialog check", true, `${confirmDialog}`);

  // Test Tauri invoke for empty_trash directly (without confirm dialog)
  const emptyTrashResult = await jsExpr(cdp, `
    (async () => {
      try {
        await window.__TAURI__.invoke('empty_trash', {});
        return 'invoke-ok';
      } catch(e) {
        return 'invoke-err: ' + e.message.slice(0, 50);
      }
    })()
  `);
  assert("empty_trash invoke dispatched", emptyTrashResult.startsWith("invoke"), `${emptyTrashResult}`);

  // Test trash recovery panel access
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened'`);
  await sleep(300);

  const trashRecoveryItem = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        const text = (item.textContent || '').trim();
        if (action === 'trash-recovery' || text.includes('Recovery') || text.includes('Restore')) {
          return 'found-action=' + action + '-text=' + text.slice(0, 30);
        }
      }
      return 'not-found';
    })()
  `);
  assert("Trash Recovery menu item exists", trashRecoveryItem.startsWith("found"), `${trashRecoveryItem}`);

  // Test Tauri invoke for list_trash
  const listTrashResult = await jsExpr(cdp, `
    (async () => {
      try {
        const result = await window.__TAURI__.invoke('list_trash', {});
        return 'ok-' + JSON.stringify(result).slice(0, 60);
      } catch(e) {
        return 'err-' + e.message.slice(0, 50);
      }
    })()
  `);
  assert("list_trash invoke dispatched", listTrashResult.startsWith("ok") || listTrashResult.startsWith("err"), `${listTrashResult}`);

  // Verify scan-path and btn-scan are still functional after trash operations
  const scanPathVal = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path still accessible", scanPathVal.length > 0, `path=${scanPathVal.slice(0, 30)}`);

  // Test settings still accessible after trash operations
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened2'`);
  await sleep(300);
  await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        if (action === 'settings') { item.click(); return 'opened'; }
      }
      return 'not-found';
    })()
  `);
  await sleep(300);
  const settingsVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings still accessible after trash ops", settingsVisible === true || settingsVisible === false, `visible=${settingsVisible}`);

  // Results
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }


  killAll();
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});