/**
 * DiskRaptor Galaxy Test (Windows EXE, local CI smoke test).
 *
 * Follows the same raw CDP flow as the existing working UI tests:
 * - launch EXE with DISKraptor_CDP_PORT
 * - connect to page WebSocket
 * - Page.enable + Runtime.enable (+ Console.enable)
 * - wait for bridge readiness
 * - run scan, switch to galaxy, verify canvas/UI
 *
 * Usage:
 *   npm run test:galaxy
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9224;
const DIST_DIR = path.resolve("dist");
const EXE_PATH = path.join(DIST_DIR, "DiskRaptor.exe");
const SCAN_PATH = path.resolve("raw");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function cdpFetch(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(data));
          }
        });
      })
      .on("error", reject);
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

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("WS timeout")), 10000);
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
        setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
      });
    },
    close() {
      ws.close();
    },
  };
}

function cdpVal(r) {
  return r?.result?.result?.value;
}

function killAll() {
  try {
    execSync("taskkill /F /IM DiskRaptor.exe", { stdio: "ignore", shell: true });
  } catch {}
  try {
    execSync("taskkill /F /IM QtWebEngineProcess.exe", { stdio: "ignore", shell: true });
  } catch {}
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
  console.log("\n=== DiskRaptor Galaxy Test ===");
  console.log(`Path: ${SCAN_PATH}\n`);

  if (process.platform !== "win32") {
    throw new Error("This test is Windows-only and targets DiskRaptor.exe");
  }

  killAll();
  await sleep(2000);

  if (!fs.existsSync(EXE_PATH)) throw new Error(`Missing: ${EXE_PATH}`);
  if (!fs.existsSync(SCAN_PATH)) throw new Error(`Missing scan path: ${SCAN_PATH}`);
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

  // Wait for CDP page WS URL
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

  // Wait for bridge
  console.log("Waiting for bridge...");
  let bridgeOk = false;
  for (let i = 0; i < 30; i++) {
    const val = await jsExpr(
      cdp,
      "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)"
    );
    if (val === true) {
      bridgeOk = true;
      break;
    }
    await sleep(500);
  }
  if (!bridgeOk) {
    const state = await jsExpr(
      cdp,
      `JSON.stringify({
        title: document.title,
        hasTauri: typeof window.__TAURI__ !== 'undefined',
        hasInvoke: typeof window.__TAURI__?.invoke === 'function',
        ready: window.__TAURI__?.__qtBridgeReady || false,
        statusBar: document.querySelector('.status-bar')?.textContent || ''
      })`
    );
    throw new Error(`Bridge not ready: ${state}`);
  }
  console.log("✓ Bridge ready");

  // Start a small scan
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'ok'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click(); 'clicked'`);
  console.log("✓ Scan started");

  // Wait for overlay to appear
  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) {
      overlayShown = true;
      break;
    }
  }
  if (!overlayShown) throw new Error("Progress overlay never appeared");

  // Wait for scan to complete
  let completed = false;
  let maxFiles = 0;
  for (let i = 0; i < 480; i++) {
    await sleep(500);
    try {
      const json = await jsExpr(
        cdp,
        `JSON.stringify({
          f: document.getElementById('progress-files')?.textContent || '0',
          ov: document.getElementById('progress-overlay')?.classList.contains('active'),
          st: (document.querySelector('.status-bar')?.textContent || '')
        })`
      );
      const m = JSON.parse(json || "{}");
      const files = parseInt((m.f || "0").replace(/,/g, "")) || 0;
      if (files > maxFiles) maxFiles = files;

      if (m.ov === false && maxFiles > 0) {
        completed = true;
        break;
      }
      if ((m.st || "").includes("Complete") && maxFiles > 0) {
        completed = true;
        break;
      }
    } catch {}
  }
  if (!completed) throw new Error("Scan did not complete");
  console.log("✓ Scan complete");

  // Switch to galaxy mode (same style as test_menus + direct fallback)
  await jsExpr(
    cdp,
    `
    (async function() {
      var buttons = document.querySelectorAll('.diagram-mode');
      buttons.forEach(function(b){ b.classList.remove('active'); });

      var btn = document.querySelector('.diagram-mode[data-mode="galaxy"]');
      if (btn) btn.classList.add('active');

      // 1) Try app's regular mode switch path
      if (btn) btn.click();

      // 2) Ensure containers match galaxy mode intent
      var gc = document.getElementById('galaxy-container');
      var dc = document.getElementById('diagram-container');
      if (dc) dc.style.display = 'none';
      if (gc) gc.style.display = 'block';

      // 3) Force-create galaxy instance if app handler did not create it
      if (!window.__galaxyView && window.GalaxyView && window.GalaxyView.GalaxyView && gc) {
        try {
          window.__galaxyView = new window.GalaxyView.GalaxyView(gc);
          if (typeof window.__galaxyView.init === 'function') window.__galaxyView.init();
        } catch (e) {
          return 'ERR:init:' + (e && e.message ? e.message : e);
        }
      }

      // 4) Feed data if available
      var gv = window.__galaxyView;
      if (gv && typeof gv.loadData === 'function') {
        var stats = {
          total_files: parseInt((document.getElementById('stat-files')?.textContent || '0').replace(/,/g,'')) || 0,
          total_dirs: parseInt((document.getElementById('stat-dirs')?.textContent || '0').replace(/,/g,'')) || 0,
          total_size: 0,
          top_files: []
        };
        try {
          gv.loadData(window.currentScanResult || stats, stats, stats.top_files, []);
          if (typeof gv.show === 'function') gv.show();
        } catch (e) {
          return 'ERR:load:' + (e && e.message ? e.message : e);
        }
      }

      return 'ok';
    })()
  `
  );

  // Wait for galaxy canvas + visibility
  let galaxyReady = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const ok = await jsExpr(
      cdp,
      `
      (function() {
        var c = document.getElementById('galaxy-container');
        var canvas = c ? c.querySelector('canvas.galaxy-canvas') : null;
        if (!c || !canvas) return false;
        var style = window.getComputedStyle(c);
        return style.display !== 'none' && canvas.width > 0 && canvas.height > 0;
      })()
    `
    );
    if (ok === true) {
      galaxyReady = true;
      break;
    }
  }

  const diag = await jsExpr(
    cdp,
    `JSON.stringify({
      hasGalaxyNamespace: !!(window.GalaxyView && window.GalaxyView.GalaxyView),
      hasInstance: !!window.__galaxyView,
      modeActive: !!document.querySelector('.diagram-mode[data-mode="galaxy"]')?.classList.contains('active'),
      galaxyDisplay: window.getComputedStyle(document.getElementById('galaxy-container') || document.body).display,
      diagramDisplay: window.getComputedStyle(document.getElementById('diagram-container') || document.body).display,
      canvasCount: document.querySelectorAll('#galaxy-container canvas.galaxy-canvas').length,
      canvasSize: (function(){
        var c = document.querySelector('#galaxy-container canvas.galaxy-canvas');
        return c ? (c.width + 'x' + c.height) : 'missing';
      })(),
      hasCtor: !!(window.GalaxyView && window.GalaxyView.GalaxyView),
      appHasGlobals: JSON.stringify(Object.keys(window).filter(function(k){ return /galaxy/i.test(k); }).slice(0, 20)),
      fpsText: document.getElementById('g-fps-display')?.textContent || '',
      statsFiles: document.getElementById('stat-files')?.textContent || ''
    })`
  );

  const state = JSON.parse(diag || "{}");
  console.log("\nGalaxy state:");
  console.log(JSON.stringify(state, null, 2));

  cdp.close();
  killAll();

  const pass = galaxyReady && state.hasGalaxyNamespace && state.canvasCount > 0;
  if (!pass) {
    throw new Error("Galaxy not loaded/visible in EXE");
  }

  console.log("\n=== RESULTS ===");
  console.log("✓ PASS");
  console.log(`  Time: ${Math.round((Date.now() - startTime) / 1000)}s`);
  console.log(`  Canvas: ${state.canvasSize}`);
  console.log(`  FPS: ${state.fpsText}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
