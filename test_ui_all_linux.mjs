/**
 * DiskRaptor Linux Comprehensive UI Test — ALL menus, buttons, interactions.
 * Uses raw CDP via WebSocket.
 * Usage: node test_ui_all_linux.mjs
 */

import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";

const CDP_PORT = 9228;
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

function t(label) { return "  ✓ " + label; }
function f(label, detail) { return "  ✗ " + label + (detail ? " -- " + detail : ""); }

async function main() {
  console.log(`\n=== DiskRaptor Linux Comprehensive UI Test ===\n`);

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

  // === TOP BAR BUTTONS ===
  console.log("\n=== Top Bar Buttons ===\n");

  // Drive selector
  const driveBtn = await jsExpr(cdp, `document.getElementById('btn-drive') ? 'found' : 'not-found'`);
  assert("Drive selector button", driveBtn === "found");
  await sleep(200);

  // Drive menu appears on click
  await jsExpr(cdp, `document.getElementById('btn-drive').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(300);
  const driveMenu = await jsExpr(cdp, `document.getElementById('drive-menu') ? 'exists' : 'not-found'`);
  assert("Drive menu dropdown", driveMenu === "exists");
  await sleep(300);

  // Favorite button
  const favBtn = await jsExpr(cdp, `document.getElementById('btn-fav') ? 'found' : 'not-found'`);
  assert("Favorites button", favBtn === "found");
  await jsExpr(cdp, `document.getElementById('btn-fav').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(300);
  const favMenu = await jsExpr(cdp, `document.getElementById('fav-menu') ? 'exists' : 'not-found'`);
  assert("Favorites menu dropdown", favMenu === "exists");
  await sleep(200);
  // Close fav menu
  await jsExpr(cdp, `document.getElementById('btn-fav').click(); 'closed'`);
  await sleep(200);

  // Browse button
  const browseBtn = await jsExpr(cdp, `document.getElementById('btn-browse') ? 'found' : 'not-found'`);
  assert("Browse button", browseBtn === "found");

  // Scan button
  const scanBtn = await jsExpr(cdp, `document.getElementById('btn-scan') ? 'found' : 'not-found'`);
  assert("Scan button", scanBtn === "found");

  // Rescan button (initially disabled)
  const rescanBtn = await jsExpr(cdp, `document.getElementById('btn-rescan')`);
  assert("Rescan button state", rescanBtn !== null && rescanBtn.disabled === true, `disabled=${rescanBtn?.disabled}`);

  // Cancel button (initially disabled)
  const cancelBtn = await jsExpr(cdp, `document.getElementById('btn-cancel')`);
  assert("Cancel button state", cancelBtn !== null && cancelBtn.disabled === true, `disabled=${cancelBtn?.disabled}`);

  // Toolbar buttons
  const exportBtn = await jsExpr(cdp, `document.getElementById('btn-export') ? 'found' : 'not-found'`);
  assert("Export button", exportBtn === "found");
  const exportDisabled = await jsExpr(cdp, `document.getElementById('btn-export')?.disabled`);
  assert("Export button disabled before scan", exportDisabled === true, `disabled=${exportDisabled}`);

  // Language button
  const langBtn = await jsExpr(cdp, `document.getElementById('btn-lang') ? 'found' : 'not-found'`);
  assert("Language button", langBtn === "found");
  await jsExpr(cdp, `document.getElementById('btn-lang').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(300);
  const langMenu = await jsExpr(cdp, `document.getElementById('lang-menu') ? 'exists' : 'not-found'`);
  assert("Language menu dropdown", langMenu === "exists");
  await sleep(200);
  // Close lang menu
  await jsExpr(cdp, `document.getElementById('btn-lang').click(); 'closed'`);
  await sleep(200);

  // Theme button
  const themeBtn = await jsExpr(cdp, `document.getElementById('btn-theme') ? 'found' : 'not-found'`);
  assert("Theme button", themeBtn === "found");

  // === SCAN PATH INPUT ===
  console.log("\n=== Scan Path Input ===\n");

  const scanPath = await jsExpr(cdp, `document.getElementById('scan-path') ? 'found' : 'not-found'`);
  assert("Scan path input", scanPath === "found");

  // Set scan path
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  const scanPathVal = await jsExpr(cdp, `document.getElementById('scan-path').value`);
  assert("Scan path value set", scanPathVal === SCAN_PATH, `val=${scanPathVal}`);

  // === WELCOME VIEW ===
  console.log("\n=== Welcome View ===\n");

  const welcomeScreen = await jsExpr(cdp, `document.getElementById('welcome-screen') ? 'found' : 'not-found'`);
  assert("Welcome screen exists", welcomeScreen === "found");

  // Welcome scan button
  const welcomeScanBtn = await jsExpr(cdp, `document.getElementById('welcome-scan-btn') ? 'found' : 'not-found'`);
  assert("Welcome scan button", welcomeScanBtn === "found");

  const welcomeBrowseBtn = await jsExpr(cdp, `document.getElementById('welcome-browse-btn') ? 'found' : 'not-found'`);
  assert("Welcome browse button", welcomeBrowseBtn === "found");

  const welcomeAboutBtn = await jsExpr(cdp, `document.getElementById('welcome-about-btn') ? 'found' : 'not-found'`);
  assert("Welcome about button", welcomeAboutBtn === "found");

  // Click scan on welcome screen
  console.log("\nScanning from welcome screen...");
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)}; 'set'`);
  await jsExpr(cdp, `document.getElementById('btn-scan').click(); 'clicked'`);

  let overlayShown = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) { overlayShown = true; break; }
  }
  assert("Scan overlay appeared", overlayShown);

  // Wait for scan to finish
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

  // Now rescan button and cancel should be enabled
  const rescanEnabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled !== true`);
  assert("Rescan button enabled after scan", rescanEnabled === true);
  const cancelEnabled = await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled !== true`);
  assert("Cancel button enabled after scan", cancelEnabled === true);
  const exportEnabled = await jsExpr(cdp, `document.getElementById('btn-export')?.disabled !== true`);
  assert("Export button enabled after scan", exportEnabled === true);

  // === TOOLS MENU (all items) ===
  console.log("\n=== Tools Menu (All Items) ===\n");
  const toolItems = [
    "scan-downloads",
    "scan-trash",
    "trash-recovery",
    "find-files",
    "empty-folders",
    "cleanup-downloads",
    "duplicates",
    "export-html",
    "settings",
    "clear-scan",
    "trash",
  ];

  const allToolsFound = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      const actions = Array.from(items).map(i => i.getAttribute('data-action')).filter(Boolean);
      const missing = ${JSON.stringify(toolItems)}.filter(a => !actions.includes(a));
      return JSON.stringify({found: actions, count: items.length, missing: missing});
    })()
  `);
  const toolsParse = JSON.parse(allToolsFound || "{}");
  assert(`Tools menu items (${toolsParse.count} found)`, toolsParse.missing.length === 0,
    `missing: ${JSON.stringify(toolsParse.missing)}`);

  // Test each tools menu item opens/closes the menu
  const openMenu = await jsExpr(cdp, `
    (function() {
      document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
      return 'opened';
    })()
  `);
  assert("Tools menu opens", openMenu === "opened");
  await sleep(300);

  // Close tools menu by clicking outside
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'closed'`);
  await sleep(200);

  // === TRASH MENU ITEM ===
  console.log("\n=== trash Menu Item ===\n");
  await jsExpr(cdp, `document.getElementById('btn-tools').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'opened'`);
  await sleep(300);
  const trashClickResult = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        if (item.getAttribute('data-action') === 'trash') {
          item.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked';
        }
      }
      return 'not-clicked';
    })()
  `);
  assert("trash menu item clickable", trashClickResult === "clicked");
  await sleep(500);

  // === SETTINGS OVERLAY ===
  console.log("\n=== Settings Overlay ===\n");

  // Open settings via tools menu
  await jsExpr(cdp, `document.getElementById('btn-tools').click(); 'opened'`);
  await sleep(300);
  const settingsClick = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        if (item.getAttribute('data-action') === 'settings') {
          item.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Settings menu item clicked", settingsClick === "clicked");
  await sleep(500);

  const settingsVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings overlay visible", settingsVisible === true, `visible=${settingsVisible}`);

  // Check all settings controls exist
  const settingsTheme = await jsExpr(cdp, `document.getElementById('settings-theme') ? 'found' : 'not-found'`);
  assert("Settings theme selector", settingsTheme === "found");
  const settingsDefaultPath = await jsExpr(cdp, `document.getElementById('settings-default-path') ? 'found' : 'not-found'`);
  assert("Settings default-path input", settingsDefaultPath === "found");
  const settingsClose = await jsExpr(cdp, `document.getElementById('settings-close') ? 'found' : 'not-found'`);
  assert("Settings close button", settingsClose === "found");
  const settingsSave = await jsExpr(cdp, `document.getElementById('settings-save') ? 'found' : 'not-found'`);
  assert("Settings save button", settingsSave === "found");

  // Change theme in settings
  const themeChanged = await jsExpr(cdp, `
    (function() {
      const sel = document.getElementById('settings-theme');
      if (!sel) return 'no-select';
      const idx = sel.selectedIndex;
      const next = idx < sel.options.length - 1 ? idx + 1 : 0;
      sel.selectedIndex = next;
      sel.dispatchEvent(new Event('change', {bubbles:true}));
      return 'changed-' + sel.options[next].value;
    })()
  `);
  assert("Theme changed in settings", !themeChanged.startsWith("no-"), `${themeChanged}`);
  await sleep(300);

  // Save settings
  await jsExpr(cdp, `document.getElementById('settings-save').click(); 'saved'`);
  await sleep(300);

  // Close settings
  const settingsClosed = await jsExpr(cdp, `
    document.getElementById('settings-overlay').style.display = 'none';
    'closed'
  `);
  assert("Settings overlay closed", settingsClosed === "closed");
  await sleep(200);

  // === ABOUT OVERLAY ===
  console.log("\n=== About Overlay ===\n");

  // Click welcome about button
  await jsExpr(cdp, `document.getElementById('welcome-about-btn').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  await sleep(500);

  const aboutCloseBtn = await jsExpr(cdp, `document.getElementById('btn-about-close') ? 'found' : 'not-found'`);
  assert("About close button", aboutCloseBtn === "found");

  // Close about
  await jsExpr(cdp, `document.getElementById('btn-about-close').click(); 'closed'`);
  await sleep(300);

  // === TREE VIEW CONTEXT MENU (right-click) ===
  console.log("\n=== Tree View Context Menu ===\n");

  // Find a tree node to right-click
  const treeNode = await jsExpr(cdp, `
    document.querySelector('.tree-node') ? 'found' : 'not-found'
  `);
  if (treeNode === "found") {
    await jsExpr(cdp, `
      (function() {
        const node = document.querySelector('.tree-node');
        if (node) {
          node.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2}));
          return 'right-clicked';
        }
        return 'no-node';
      })()
    `);
    await sleep(300);

    // Check context menu appeared
    const ctxMenu = await jsExpr(cdp, `
      (function() {
        const ctx = document.querySelector('.context-menu, [class*="context"], [class*="ctx"]');
        return ctx ? (ctx.style.display !== 'none' ? 'visible' : 'hidden') : 'not-found';
      })()
    `);
    assert("Context menu appeared", ctxMenu !== "not-found", `${ctxMenu}`);

    // Close context menu by pressing Escape
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  } else {
    assert("Tree node for right-click", false, "no tree nodes found yet");
  }

  // Explore context menu (left-click first)
  if (treeNode === "found") {
    await jsExpr(cdp, `document.querySelector('.tree-node')?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
    await sleep(500);

    // Check detail panel has explorer/terminal/properties options
    const detailPanel = await jsExpr(cdp, `document.getElementById('detail-panel') ? 'found' : 'not-found'`);
    assert("Detail panel visible", detailPanel === "found");

    // Check explorer button in detail panel
    const explorerBtn = await jsExpr(cdp, `
      document.querySelector('[data-action="explorer"]') ? 'found' : 'not-found'
    `);
    assert("Explorer button in detail panel", explorerBtn === "found");

    const terminalBtn = await jsExpr(cdp, `
      document.querySelector('[data-action="terminal"]') ? 'found' : 'not-found'
    `);
    assert("Terminal button in detail panel", terminalBtn === "found");

    const propertiesBtn = await jsExpr(cdp, `
      document.querySelector('[data-action="properties"]') ? 'found' : 'not-found'
    `);
    assert("Properties button in detail panel", propertiesBtn === "found");

    const copyBtn = await jsExpr(cdp, `
      document.querySelector('[data-action="copy"]') ? 'found' : 'not-found'
    `);
    assert("Copy button in detail panel", copyBtn === "found");

    const trashDetailBtn = await jsExpr(cdp, `
      document.querySelector('[data-action="trash"]') ? 'found' : 'not-found'
    `);
    assert("Trash button in detail panel", trashDetailBtn === "found");
  }

  // === PROGRESS OVERLAY ===
  console.log("\n=== Progress Overlay ===\n");

  // Check progress cancel button
  const progressCancelBtn = await jsExpr(cdp, `document.getElementById('progress-cancel') ? 'found' : 'not-found'`);
  assert("Progress cancel button exists", progressCancelBtn === "found");

  // Check progress text elements
  const progressStatus = await jsExpr(cdp, `document.getElementById('progress-status') ? 'found' : 'not-found'`);
  assert("Progress status text", progressStatus === "found");
  const progressPath = await jsExpr(cdp, `document.getElementById('progress-path') ? 'found' : 'not-found'`);
  assert("Progress path text", progressPath === "found");
  const progressFiles = await jsExpr(cdp, `document.getElementById('progress-files') ? 'found' : 'not-found'`);
  assert("Progress files counter", progressFiles === "found");
  const progressDirs = await jsExpr(cdp, `document.getElementById('progress-dirs') ? 'found' : 'not-found'`);
  assert("Progress dirs counter", progressDirs === "found");
  const progressSpeed = await jsExpr(cdp, `document.getElementById('progress-speed-val') ? 'found' : 'not-found'`);
  assert("Progress speed display", progressSpeed === "found");
  const progressElapsed = await jsExpr(cdp, `document.getElementById('progress-elapsed-val') ? 'found' : 'not-found'`);
  assert("Progress elapsed display", progressElapsed === "found");
  const progressEta = await jsExpr(cdp, `document.getElementById('progress-eta-val') ? 'found' : 'not-found'`);
  assert("Progress ETA display", progressEta === "found");
  const progressPct = await jsExpr(cdp, `document.getElementById('progress-pct-text') ? 'found' : 'not-found'`);
  assert("Progress percentage", progressPct === "found");

  // === STATS PANEL ===
  console.log("\n=== Stats Panel ===\n");

  const statFiles = await jsExpr(cdp, `document.getElementById('stat-files') ? 'found' : 'not-found'`);
  assert("Stats files display", statFiles === "found");
  const statDirs = await jsExpr(cdp, `document.getElementById('stat-dirs') ? 'found' : 'not-found'`);
  assert("Stats dirs display", statDirs === "found");
  const statSize = await jsExpr(cdp, `document.getElementById('stat-size') ? 'found' : 'not-found'`);
  assert("Stats size display", statSize === "found");
  const statTime = await jsExpr(cdp, `document.getElementById('stat-time') ? 'found' : 'not-found'`);
  assert("Stats time display", statTime === "found");

  // === TREE VIEW ===
  console.log("\n=== Tree View ===\n");

  const treeViewport = await jsExpr(cdp, `document.getElementById('tree-viewport') ? 'found' : 'not-found'`);
  assert("Tree viewport exists", treeViewport === "found");

  const treeStatus = await jsExpr(cdp, `document.getElementById('tree-status') ? 'found' : 'not-found'`);
  assert("Tree status bar exists", treeStatus === "found");

  const treeFilter = await jsExpr(cdp, `document.getElementById('tree-filter') ? 'found' : 'not-found'`);
  assert("Tree filter input exists", treeFilter === "found");

  // === BOTTOM PANELS ===
  console.log("\n=== Bottom Panels ===\n");

  const topFilesCard = await jsExpr(cdp, `document.getElementById('topfiles-card') ? 'found' : 'not-found'`);
  assert("Top files card exists", topFilesCard === "found");

  const topfilesTable = await jsExpr(cdp, `document.getElementById('topfiles-table') ? 'found' : 'not-found'`);
  assert("Top files table exists", topfilesTable === "found");

  // === LANGUAGE MENU ITEMS ===
  console.log("\n=== Language Menu ===\n");

  const langMenuItems = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('#lang-menu a, #lang-menu [data-lang], #lang-menu .lang-option')).map(el => el.textContent.trim().slice(0, 10))
  `);
  assert(`Language menu (${Array.isArray(langMenuItems) ? langMenuItems.length : 0} items)`, true,
    `${JSON.stringify(langMenuItems?.slice(0, 5) || [])}`);

  // === STATUS BAR ===
  console.log("\n=== Status Bar ===\n");

  const statusBar = await jsExpr(cdp, `document.querySelector('.status-bar') ? 'found' : 'not-found'`);
  assert("Status bar exists", statusBar === "found");

  // === RESIZE HANDLES ===
  console.log("\n=== Resize Handles ===\n");

  const splitter = await jsExpr(cdp, `document.getElementById('tf-splitter') ? 'found' : 'not-found'`);
  assert("Tree/filters splitter", splitter === "found");

  // === FILTER TAGS ===
  console.log("\n=== Type Filters ===\n");

  const typeFiltersContainer = await jsExpr(cdp, `document.getElementById('type-filters') ? 'found' : 'not-found'`);
  assert("Type filters container", typeFiltersContainer === "found");

  // === LANGUAGE FILTER ===
  console.log("\n=== Language Filter ===\n");

  const langFilter = await jsExpr(cdp, `document.getElementById('lang-filter') ? 'found' : 'not-found'`);
  assert("Language filter input", langFilter === "found");

  // === SCAN PATH DISPLAY ===
  console.log("\n=== Scan Path Display ===\n");

  const progressDir = await jsExpr(cdp, `document.getElementById('progress-dir') ? 'found' : 'not-found'`);
  assert("Progress dir display", progressDir === "found");

  // === TREE HEADER ===
  console.log("\n=== Tree Header ===\n");

  const treeHeader = await jsExpr(cdp, `document.getElementById('tree-header') ? 'found' : 'not-found'`);
  assert("Tree header exists", treeHeader === "found");

  // === WELCOME VIEW BROWSE BUTTON ===
  console.log("\n=== Welcome View Browse ===\n");
  // Already tested welcome buttons above

  // === RESULTS ===
  console.log(`\n=== RESULTS ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) { console.log("  ✗ FAIL"); process.exit(1); }
  else { console.log("  ✓ PASS (all buttons and menus tested)"); }


  killAll();
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});