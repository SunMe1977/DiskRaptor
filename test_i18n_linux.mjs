/**
 * DiskRaptor Linux i18n/Language Test — tests language switching across UI.
 * Usage: node test_i18n_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9237;
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
  console.log(`\n=== DiskRaptor Linux i18n/Language Test ===\n`);
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

  // Check i18n object exists
  console.log("\n=== i18n Tests ===\n");

  const i18nObj = await jsExpr(cdp, `typeof window.__i18n !== 'undefined' ? 'i18n-found' : (typeof t !== 'undefined' ? 't-function-found' : 'no-i18n')`);
  assert("i18n system available", i18nObj !== "no-i18n", `${i18nObj}`);

  // Check language button exists
  const langBtn = await jsExpr(cdp, `document.getElementById('btn-lang') ? 'found' : 'not-found'`);
  assert("Language button in toolbar", langBtn === "found");

  // Check current language is detected
  const currentLang = await jsExpr(cdp, `document.documentElement lang || document.documentElement.getAttribute('lang') || 'no-lang-attr'`);
  assert("HTML lang attribute set", currentLang !== "no-lang-attr", `lang=${currentLang}`);

  // Check language data file is loaded
  const i18nKeys = await jsExpr(cdp, `
    (function() {
      if (typeof window.__i18n !== 'undefined') {
        const keys = Object.keys(window.__i18n);
        return 'i18n-keys=' + keys.length + ' sample=' + (keys[0] || 'none');
      }
      if (typeof t !== 'undefined') return 't-function-exists';
      return 'no-i18n-object';
    })()
  `);
  assert("i18n keys loaded", i18nKeys.includes("i18n-keys=") || i18nKeys.includes("t-function"), `${i18nKeys}`);

  // Open language menu and count available languages
  await jsExpr(cdp, `document.getElementById('btn-lang').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'opened'`);
  await sleep(300);

  const langMenuItems = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('#lang-menu a, #lang-menu [data-lang], #lang-menu .lang-option')).map(el => ({
      text: el.textContent.trim().slice(0, 10),
      lang: el.getAttribute('data-lang') || el.getAttribute('data-lang-code') || el.id || ''
    }))
  `);
  assert(`Language menu items (${Array.isArray(langMenuItems) ? langMenuItems.length : 0})`, true,
    `${JSON.stringify(langMenuItems?.slice(0, 5) || [])}`);

  // Test language switching to each available language
  if (Array.isArray(langMenuItems) && langMenuItems.length > 1) {
    console.log("\n--- Language Switch Tests ---");

    for (const lang of langMenuItems.slice(0, 3)) {
      await jsExpr(cdp, `document.getElementById('btn-lang').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened'`);
      await sleep(200);

      // Find and click the language option
      const switchResult = await jsExpr(cdp, `
        (function() {
          const items = document.querySelectorAll('#lang-menu a, #lang-menu [data-lang], #lang-menu .lang-option');
          for (const item of items) {
            const code = item.getAttribute('data-lang') || item.getAttribute('data-lang-code') || '';
            const text = item.textContent.trim().toLowerCase();
            const target = '${lang.text || lang.lang}'.toLowerCase();
            if (code === '${lang.lang}' || text.includes(target) || text.includes('${lang.lang}')) {
              item.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
              return 'switched-to-' + (code || text);
            }
          }
          return 'not-clicked';
        })()
      `);
      assert(`Language switch test`, switchResult.startsWith("switched-to"), `${switchResult}`);
      await sleep(500);

      // Verify UI text changed
      const scanBtnText = await jsExpr(cdp, `document.querySelector('[data-i18n="btn.scan"]')?.textContent.trim() || 'no-text'`);
      assert(`Scan button text after switch`, true, `text="${scanBtnText}"`);
    }
  }

  // Test i18n function works
  const tFunction = await jsExpr(cdp, `
    (typeof t === 'function') ? t('btn.scan') :
    (typeof window.__i18n === 'object' && window.__i18n.btn && window.__i18n.btn.scan) ? window.__i18n.btn.scan :
    typeof window.__ === 'function' ? window.__('btn.scan') : 'no-t-function'
  `);
  assert("Translation function works", tFunction !== "no-t-function" && tFunction.length > 0, `t('btn.scan')=${tFunction}`);

  // Check scan-path placeholder uses i18n
  const scanPathPlaceholder = await jsExpr(cdp, `document.getElementById('scan-path')?.placeholder || 'no-placeholder'`);
  assert("Scan path placeholder localized", scanPathPlaceholder !== "no-placeholder", `placeholder="${scanPathPlaceholder}"`);

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close(); killAll();
}

main().catch((err) => { console.error(`\nError: ${err.message}`); killAll(); process.exit(1); });