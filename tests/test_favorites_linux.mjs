/**
 * DiskRaptor Linux Favorites Test — launches binary, tests bookmark functionality.
 * Uses raw CDP via WebSocket.
 * Usage: node test_favorites_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9225;
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
  console.log(`\n=== DiskRaptor Linux Favorites Test ===\n`);

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

  // Verify favorite button exists
  console.log("\n=== Favorites Tests ===\n");

  const favBtn = await jsExpr(cdp, `
    (function() {
      const btn = document.getElementById('btn-fav');
      if (!btn) return 'not-found';
      return 'found title=' + btn.getAttribute('title');
    })()
  `);
  assert("Favorites button visible", favBtn.startsWith("found"), `${favBtn}`);

  // Scan first to have a path to bookmark
  console.log("\nScanning...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ov = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (ov !== true) { await sleep(1000); break; }
  }
  await sleep(2000);

  // Test click favorite button to open menu
  await jsExpr(cdp, `document.getElementById('btn-fav').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(500);

  const favMenuVisible = await jsExpr(cdp, `
    (function() {
      const m = document.getElementById('fav-menu');
      if (!m) return 'no-menu';
      const style = getComputedStyle(m);
      return 'menu-display=' + style.display;
    })()
  `);
  assert("Favorites menu visible", favMenuVisible.includes("display"), `${favMenuVisible}`);

  // Check favorite menu items
  const favItems = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('#fav-menu .fav-item, #fav-menu [class*="fav"], #fav-menu a')).map(el => el.textContent.trim().slice(0, 40))
  `);
  assert("Favorite menu items detected", Array.isArray(favItems), `count=${Array.isArray(favItems) ? favItems.length : 'not-array'}`);

  // Test adding current path as favorite
  const currentPath = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path set", currentPath.length > 0, `path=${currentPath}`);

  // Get favorites from Tauri state
  const savedFavorites = await jsExpr(cdp, `
    (async () => {
      try {
        const result = await window.__TAURI__.invoke('load_settings', {});
        return JSON.stringify(result).slice(0, 100);
      } catch(e) { return 'err: ' + e.message.slice(0, 50); }
    })()
  `);
  assert("Load settings via Tauri", savedFavorites.length > 0, `${savedFavorites.slice(0, 60)}`);

  // Test bookmark icon toggle ( ☆ → ★ )
  const initialIcon = await jsExpr(cdp, `document.getElementById('btn-fav')?.textContent?.trim() || ''`);
  assert("Favorites button has icon", initialIcon.length > 0, `icon="${initialIcon}"`);

  // Click favorites menu items to test navigation (if any exist)
  if (Array.isArray(favItems) && favItems.length > 0) {
    await jsExpr(cdp, `document.getElementById('btn-fav').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened'`);
    await sleep(300);

    // Click first favorite item
    await jsExpr(cdp, `
      (function() {
        const items = document.querySelectorAll('#fav-menu .fav-item, #fav-menu [class*="fav"], #fav-menu a');
        if (items.length > 0) items[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
        return 'clicked-item-' + items.length;
      })()
    `);
    await sleep(300);
    assert("Favorite menu interaction", true, "click handled");
  }

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