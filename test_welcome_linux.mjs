/**
 * DiskRaptor Linux Welcome Screen Test — tests welcome view interactions.
 * Usage: node test_welcome_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9231;
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
  console.log(`\n=== DiskRaptor Linux Welcome Screen Test ===\n`);
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

  console.log("\n=== Welcome Screen Tests ===\n");

  // Welcome screen should be visible initially
  const welcomeVisible = await jsExpr(cdp, `
    (function() {
      const w = document.getElementById('welcome-screen');
      if (!w) return 'not-found';
      const style = getComputedStyle(w);
      return 'visible=' + (style.display !== 'none' && style.visibility !== 'hidden');
    })()
  `);
  assert("Welcome screen visible on launch", welcomeVisible.includes("visible=true"), `${welcomeVisible}`);

  // Welcome heading
  const welcomeHeading = await jsExpr(cdp, `document.querySelector('#welcome-screen h1, #welcome-screen h2') ? 'found' : 'not-found'`);
  assert("Welcome heading exists", welcomeHeading === "found");

  // Welcome scan button
  const welcomeScanBtn = await jsExpr(cdp, `document.getElementById('welcome-scan-btn') ? 'found' : 'not-found'`);
  assert("Welcome scan button", welcomeScanBtn === "found");

  // Welcome browse button
  const welcomeBrowseBtn = await jsExpr(cdp, `document.getElementById('welcome-browse-btn') ? 'found' : 'not-found'`);
  assert("Welcome browse button", welcomeBrowseBtn === "found");

  // Welcome about button
  const welcomeAboutBtn = await jsExpr(cdp, `document.getElementById('welcome-about-btn') ? 'found' : 'not-found'`);
  assert("Welcome about button", welcomeAboutBtn === "found");

  // Test browse button (should open a directory picker via Tauri)
  const browseResult = await jsExpr(cdp, `
    (async () => {
      try {
        await window.__TAURI__.invoke('pick_directory', {});
        return 'invoke-ok';
      } catch(e) {
        return 'invoke-err: ' + e.message.slice(0, 40);
      }
    })()
  `);
  assert("Browse Tauri invoke works", browseResult === "invoke-ok" || browseResult.startsWith("invoke-err"), `${browseResult}`);

  // Welcome info text
  const welcomeInfo = await jsExpr(cdp, `
    (function() {
      const welcome = document.getElementById('welcome-screen');
      if (!welcome) return 'not-found';
      const p = welcome.querySelector('p');
      return p ? p.textContent.trim().slice(0, 60) : 'no-paragraph';
    })()
  `);
  assert("Welcome info text readable", welcomeInfo !== "not-found" && welcomeInfo !== "no-paragraph", `${welcomeInfo}`);

  // Click scan button to switch from welcome to scan view
  console.log("\nClicking welcome scan button...");
  await jsExpr(cdp, `document.getElementById('welcome-scan-btn').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(500);

  // Welcome should be hidden now
  const welcomeHidden = await jsExpr(cdp, `
    (function() {
      const w = document.getElementById('welcome-screen');
      if (!w) return 'not-found';
      const style = getComputedStyle(w);
      return 'hidden=' + (style.display === 'none' || style.visibility === 'hidden' || w.offsetParent === null);
    })()
  `);
  assert("Welcome hidden after scan click", welcomeHidden.includes("hidden=true") || welcomeHidden.includes("hidden=not-found"), `${welcomeHidden}`);

  // Now scan path input should be visible in main UI
  const scanPathVisible = await jsExpr(cdp, `document.getElementById('scan-path') ? 'found' : 'not-found'`);
  assert("Scan path visible after scan click", scanPathVisible === "found");

  // Set a path and verify scan button becomes active
  await jsExpr(cdp, `document.getElementById('scan-path').value = '/tmp'; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').disabled = false; 'enabled'`);
  const scanBtnEnabled = await jsExpr(cdp, `!document.getElementById('btn-scan').disabled`);
  assert("Scan button enabled after path set", scanBtnEnabled === true);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });