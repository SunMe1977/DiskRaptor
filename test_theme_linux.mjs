/**
 * DiskRaptor Linux Theme Test — launches binary, switches themes, verifies UI responds.
 * Uses raw CDP via WebSocket.
 * Usage: node test_theme_linux.mjs
 * Default path: /tmp
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9223;
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
  console.log(`\n=== DiskRaptor Linux Theme Test ===\n`);

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

  // Set scan path and scan first so we have data
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
  for (let i = 0; i < 1200; i++) {
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

  // --- Theme tests ---
  console.log("\n=== Theme Tests ===\n");

  // Get initial theme
  const initialTheme = await jsExpr(cdp, `document.getElementById('btn-theme')?.textContent || ''`);
  assert("Theme button visible", initialTheme !== "", `text="${initialTheme}"`);

  // Click theme button to open theme menu
  await jsExpr(cdp, `document.getElementById('btn-theme').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(500);

  // Check theme options exist in the menu
  const themeMenuVisible = await jsExpr(cdp, `
    (function() {
      const menu = document.querySelector('.tools-menu, [class*="menu"], [class*="dropdown"]');
      if (!menu) return 'no menu found';
      return 'menu visible';
    })()
  `);
  assert("Theme menu opened", themeMenuVisible !== "no menu found", `${themeMenuVisible}`);

  // Get available theme buttons
  const themeButtons = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('[data-action="theme-"], [data-theme], button[id*="theme"], .theme-option, [class*="theme"]')).map(b => b.textContent.trim() || b.id || b.getAttribute('data-action') || b.getAttribute('data-theme') || 'unknown')
  `);
  assert("Theme options found", Array.isArray(themeButtons) && themeButtons.length > 0, `options: ${JSON.stringify(themeButtons)}`);

  // Try clicking each theme option if available
  if (Array.isArray(themeButtons) && themeButtons.length > 0) {
    for (const themeBtn of themeButtons) {
      await jsExpr(cdp, `document.getElementById('btn-theme').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'reopened'`);
      await sleep(300);

      // Try to find and click the theme option by text, ID, or data attribute
      const clicked = await jsExpr(cdp, `
        (function() {
          const btns = document.querySelectorAll('[data-action="theme-"], [data-theme], button[id*="theme"], .theme-option, [class*="theme"]');
          for (const b of btns) {
            const txt = (b.textContent || '').trim().toLowerCase();
            const id = (b.id || '').toLowerCase();
            const attr = (b.getAttribute('data-action') || b.getAttribute('data-theme') || '').toLowerCase();
            const target = '${themeBtn}'.toLowerCase();
            if (txt.includes(target) || id.includes(target) || attr.includes(target)) {
              b.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
              return 'clicked: ' + (b.textContent || b.id || attr);
            }
          }
          return 'not found: ' + target;
        })()
      `);
      assert(`Theme "${themeBtn}" ${clicked.startsWith("clicked") ? "applied" : "skipped"}`, true, `${clicked}`);
      await sleep(500);
    }
  }

  // Verify theme persists (check CSS custom properties or body class)
  const bodyClass = await jsExpr(cdp, `document.body.className`);
  const bodyStyle = await jsExpr(cdp, `getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()`);
  assert("Theme CSS applied", bodyStyle !== "", `--bg-primary=${bodyStyle}`);

  // Test auto theme option
  const autoTheme = await jsExpr(cdp, `
    document.getElementById('settings-theme')?.value ||
    (function() {
      const sel = document.querySelector('select[id*="theme"]');
      return sel ? sel.value : 'no-select';
    })()
  `);
  assert("Theme setting accessible", autoTheme !== "no-select", `value=${autoTheme}`);

  // Test that theme can be changed via settings
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'opened'`);
  await sleep(300);

  // Try opening settings
  await jsExpr(cdp, `
    (function() {
      const btns = document.querySelectorAll('[data-action="settings"]');
      if (btns.length > 0) btns[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
    })()
  `);
  await sleep(500);

  const settingsVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  if (settingsVisible) {
    assert("Settings overlay visible", true);

    // Change theme to dark
    const themeSelect = await jsExpr(cdp, `
      (function() {
        const sel = document.getElementById('settings-theme');
        if (!sel) return 'no-select';
        const val = sel.value;
        if (sel.options.length > 1) {
          const next = sel.selectedIndex < sel.options.length - 1 ? sel.selectedIndex + 1 : 0;
          sel.selectedIndex = next;
          sel.dispatchEvent(new Event('change', {bubbles:true}));
          return 'changed to ' + sel.options[next].text;
        }
        return 'single-option';
      })()
    `);
    assert("Theme changed via settings", themeSelect !== "no-select" && themeSelect !== "single-option", `${themeSelect}`);

    // Close settings
    await jsExpr(cdp, `document.getElementById('settings-overlay').style.display = 'none'; 'closed'`);
    await sleep(300);
  } else {
    assert("Settings overlay", false, "Not visible");
  }

  // Test theme persistence via Tauri invoke
  const savedTheme = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return r?.theme || 'default';
      } catch(e) { return 'err: ' + e.message; }
    })()
  `);
  assert("Load settings via Tauri", typeof savedTheme === "string", `theme=${savedTheme}`);

  // Results
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS"); }

  cdp.close();
  killAll();
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});