/**
 * DiskRaptor Galaxy View — Pixel-level validation test.
 * Verifies the galaxy actually renders content, not just a black canvas.
 */
import WebSocket from "ws";
import http from "http";
import { execSync, spawn } from "child_process";
import path from "path";
import fs from "fs";

const CDP_PORT = 9228;
const SCAN_PATH = path.resolve("raw");
const DIST = path.resolve("dist");
const EXE = path.join(DIST, "DiskRaptor.exe");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fetch(u) {
  return new Promise((R, J) => {
    http.get(u, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { R(JSON.parse(d)); } catch { J(new Error(d)); } }); }).on("error", J);
  });
}
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl), p = new Map(); let id = 0;
  ws.on("message", r => { try { const m = JSON.parse(r.toString()); if (m.id !== undefined && p.has(m.id)) { p.get(m.id).resolve(m); p.delete(m.id); } } catch {} });
  await new Promise((R, F) => { ws.on("open", R); ws.on("error", F); setTimeout(() => F(new Error("WS timeout")), 10000); });
  return {
    send(m, q = {}) { return new Promise((R, J) => { const n = ++id; p.set(n, { resolve: R, reject: J }); ws.send(JSON.stringify({ id: n, method: m, params: q })); setTimeout(() => J(new Error("CDP timeout")), 30000); }); },
    close() { ws.close(); }
  };
}
async function js(c, expr) { const r = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r?.result?.result?.value; }

// Kill existing
try { execSync("taskkill /F /IM DiskRaptor.exe", { stdio: "ignore", shell: true }); } catch {}
try { execSync("taskkill /F /IM QtWebEngineProcess.exe", { stdio: "ignore", shell: true }); } catch {}
await sleep(2000);

// Launch
spawn(EXE, [], { cwd: DIST, env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) }, detached: true, stdio: "ignore" }).unref();
await sleep(5000);

let wsUrl = null;
for (let i = 0; i < 60; i++) {
  await sleep(500);
  try { const pages = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`); if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) { wsUrl = pages[0].webSocketDebuggerUrl; break; } } catch {}
}
if (!wsUrl) throw new Error("CDP not found");

const c = await connect(wsUrl);
await c.send("Page.enable");
await c.send("Runtime.enable");

// Wait for bridge
for (let i = 0; i < 30; i++) {
  const ok = await js(c, "!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)");
  if (ok) break;
  await sleep(500);
}

// Collect console errors
let consoleErrors = [];
c.send("Console.enable").catch(() => {});
const origOn = c.ws?.on || (() => {});
c.ws?.on("message", (raw) => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.method === "Console.messageAdded") {
      const msg = m.params.message;
      if (msg.level === "error") consoleErrors.push(msg.text);
    }
  } catch {}
});

// Do a scan
console.log("Scanning...");
await js(c, `document.getElementById('scan-path').value = ${JSON.stringify(SCAN_PATH)};`);
await js(c, `document.getElementById('btn-scan').click();`);
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const ov = await js(c, `document.getElementById('progress-overlay')?.classList.contains('active')`);
  if (ov === false) break;
}
console.log("Scan done");

// Switch to galaxy mode via app's button
console.log("Activating galaxy mode...");
await js(c, `document.querySelector('.diagram-mode[data-mode="galaxy"]')?.click();`);
await sleep(4000);

// --- TESTS ---
let passed = 0;
let failed = 0;

function test(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}: ${detail || "FAILED"}`);
    failed++;
  }
}

// 1. Galaxy namespace
const ns = await js(c, `!!(window.GalaxyView && window.GalaxyView.GalaxyView)`);
test("GalaxyView namespace available", ns === true);

// 2. Canvas exists with proper size
const canvasInfo = await js(c, `(function(){
  var cv = document.querySelector('#galaxy-container canvas.galaxy-canvas');
  return cv ? { w: cv.width, h: cv.height } : null;
})()`);
test("Canvas exists", canvasInfo !== null, JSON.stringify(canvasInfo));
test("Canvas has width", canvasInfo && canvasInfo.w > 0, `${canvasInfo?.w}px`);
test("Canvas has height", canvasInfo && canvasInfo.h > 0, `${canvasInfo?.h}px`);

// 3. Toolbar buttons exist
const fpsText = await js(c, `document.getElementById('g-fps-display')?.textContent || ''`);
test("FPS display exists", fpsText.length > 0, fpsText);
test("FPS > 0 (rendering)", parseInt(fpsText) > 0, fpsText);

// 4. Close button exists
const closeBtn = await js(c, `!!document.getElementById('g-close')`);
test("Close button exists", closeBtn === true);

// 5. Pixel content - verify rendering
const px = await js(c, `(function(){
  try {
    var cv = document.querySelector('#galaxy-container canvas.galaxy-canvas');
    if (!cv) return null;
    var ctx = cv.getContext('2d');
    var w = cv.width, h = cv.height;
    // Center pixel
    var c = Array.from(ctx.getImageData(Math.floor(w/2), Math.floor(h/2), 1, 1).data).slice(0,3);
    // Count non-background pixels
    var full = ctx.getImageData(0, 0, w, h);
    var nonBg = 0;
    var data = full.data;
    for (var i = 0; i < data.length; i += 4) {
      if (data[i] !== 17 || data[i+1] !== 34 || data[i+2] !== 51) nonBg++;
    }
    return { w: w, h: h, center: c, nonBg: nonBg, total: w * h };
  } catch(e) { return null; }
})()`);
test("Canvas pixel data accessible", px !== null, JSON.stringify(px ? "got data" : "null"));
test("Center pixel is gold (star visible)", px && px.center[0] > 200 && px.center[1] > 200 && px.center[2] < 100, px?.center?.join(","));
test("Non-background pixels exist", px && px.nonBg > 1000, `${px?.nonBg} pixels`);

// 6. Close galaxy with Escape
await js(c, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(500);
const hidden = await js(c, `document.getElementById('galaxy-container')?.style?.display === 'none'`);
test("Galaxy hides on Escape", hidden === true, `display: ${await js(c, `document.getElementById('galaxy-container')?.style?.display`)}`);

// 7. Re-open galaxy
await js(c, `document.querySelector('.diagram-mode[data-mode="galaxy"]')?.click();`);
await sleep(3000);
const reFps = await js(c, `document.getElementById('g-fps-display')?.textContent || ''`);
test("Galaxy re-opens with FPS", parseInt(reFps) > 0, reFps);

// 8. No console errors
test("No console errors during galaxy lifecycle", consoleErrors.length === 0, consoleErrors.join("; "));

// Summary
console.log(`\n=== RESULTS ===`);
console.log(`  PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);

c.close();
try { execSync("taskkill /F /IM DiskRaptor.exe", { stdio: "ignore", shell: true }); } catch {}
try { execSync("taskkill /F /IM QtWebEngineProcess.exe", { stdio: "ignore", shell: true }); } catch {}
