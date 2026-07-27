import WebSocket from "ws";
import { spawn } from "child_process";
import * as http from "http";
import * as path from "path";
import * as fs from "fs";

const CDP_PORT = 9222;
const DIST_DIR = path.resolve("dist");
const EXE = path.join(DIST_DIR, "DiskRaptor.exe");

if (!fs.existsSync(EXE)) { console.log("EXE not found:", EXE); process.exit(1); }

const cp = spawn(EXE, [], { cwd: DIST_DIR, env: { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) }, detached: true, stdio: "ignore" });
cp.unref();

await new Promise(r => setTimeout(r, 4000));

let wsUrl = null;
for (let i = 0; i < 40; i++) {
  try {
    const pages = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${CDP_PORT}/json/list`, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); }).on("error", reject);
    });
    if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
      wsUrl = pages[0].webSocketDebuggerUrl;
      break;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 500));
}
if (!wsUrl) { console.log("FAIL: No WS URL"); process.exit(1); }
console.log("WS URL:", wsUrl);

const ws = new WebSocket(wsUrl);
const pending = new Map();
let msgId = 0;
ws.on("message", raw => {
  const m = JSON.parse(raw.toString());
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
});
await new Promise((r, f) => { ws.on("open", r); ws.on("error", f); setTimeout(() => f(new Error("WS timeout")), 5000); });

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => reject(new Error("Timeout " + method)), 15000);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Console.enable");

ws.on("message", raw => {
  try {
    const m = JSON.parse(raw.toString());
    if (m.method === "Console.messageAdded") {
      const msg = m.params.message;
      console.log("  [CONSOLE " + msg.level + "] " + msg.text);
    }
  } catch {}
});

// Wait for bridge
console.log("Waiting for bridge...");
let bridgeOk = false;
for (let i = 0; i < 30; i++) {
  const r = await send("Runtime.evaluate", { expression: "!!(window.__TAURI__ && window.__TAURI__.__qtBridgeReady)", returnByValue: true });
  if (r.result.result.value) { bridgeOk = true; break; }
  await new Promise(r => setTimeout(r, 500));
}
console.log("Bridge OK:", bridgeOk);

// Check DOM state
let r = await send("Runtime.evaluate", { expression: "JSON.stringify({hasBtn:!!document.getElementById('btn-scan'),hasPath:!!document.getElementById('scan-path'),btnText:(document.getElementById('btn-scan')||{}).textContent,hasOverlay:!!document.getElementById('progress-overlay'),statusBar:(document.querySelector('.status-bar')||{}).textContent,hasInitScan:typeof(window.app||{}).initScan==='function',isScanning:!!((window.app||{}).state||{}).isScanning})", returnByValue: true });
console.log("State:", r.result.result.value);

// Set path + click
await send("Runtime.evaluate", { expression: "document.getElementById('scan-path').value = 'C:\\\\Users\\\\hansj\\\\Desktop'", returnByValue: true });
r = await send("Runtime.evaluate", { expression: "document.getElementById('btn-scan').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}))", returnByValue: true });
console.log("Click result:", r.result.result.value);

await new Promise(r => setTimeout(r, 2000));

r = await send("Runtime.evaluate", { expression: "JSON.stringify({overlayActive:!!(document.getElementById('progress-overlay')||{}).classList.contains('active'),isScanning:!!((window.app||{}).state||{}).isScanning,statusBar:(document.querySelector('.status-bar')||{}).textContent,overlayDisplay:(document.getElementById('progress-overlay')||{}).style.display})", returnByValue: true });
console.log("After 2s:", r.result.result.value);

await new Promise(r => setTimeout(r, 3000));
r = await send("Runtime.evaluate", { expression: "JSON.stringify({overlayActive:!!(document.getElementById('progress-overlay')||{}).classList.contains('active'),isScanning:!!((window.app||{}).state||{}).isScanning,statusBar:(document.querySelector('.status-bar')||{}).textContent})", returnByValue: true });
console.log("After 5s:", r.result.result.value);

process.exit(0);
