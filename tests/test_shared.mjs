import WebSocket from "ws";
import { spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";

export const PLATFORM = process.platform;
export const IS_WIN = PLATFORM === "win32";
export const IS_MAC = PLATFORM === "darwin";
export const IS_LINUX = PLATFORM === "linux";

export const PROJECT_ROOT = path.resolve(".");
export const DIST_DIR = path.resolve("dist");
export const BIN_NAME = IS_WIN ? "DiskRaptor.exe" : "DiskRaptor";
export const EXE_PATH = path.join(DIST_DIR, BIN_NAME);
export const MAC_APP_PATH = path.join(DIST_DIR, "DiskRaptor.app", "Contents", "MacOS", "DiskRaptor");
export const TAURI_BIN_NAME = IS_WIN ? "diskraptor.exe" : "diskraptor";
export const TAURI_DEBUG_PATH = path.resolve("src-tauri", "target", "debug", TAURI_BIN_NAME);
export const TAURI_RELEASE_PATH = path.resolve("src-tauri", "target", "release", TAURI_BIN_NAME);
export const TAURI_DEBUG_ALT_PATH = path.resolve("src-tauri", "target", "debug", "diskraptor");
export const TAURI_RELEASE_ALT_PATH = path.resolve("src-tauri", "target", "release", "diskraptor");
export const BIN_PATH = fs.existsSync(TAURI_RELEASE_PATH) ? TAURI_RELEASE_PATH :
                       fs.existsSync(TAURI_DEBUG_PATH) ? TAURI_DEBUG_PATH :
                       fs.existsSync(TAURI_RELEASE_ALT_PATH) ? TAURI_RELEASE_ALT_PATH :
                       fs.existsSync(TAURI_DEBUG_ALT_PATH) ? TAURI_DEBUG_ALT_PATH :
                       (IS_MAC ? MAC_APP_PATH : EXE_PATH);
export const DEFAULT_SCAN_PATH = IS_WIN ? os.homedir() : "/tmp";
export const DEFAULT_CDP_PORT = parseInt(process.env.DISKraptor_CDP_PORT) || 9222;

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitFor(condition, { timeout = 10000, interval = 100, label = "" } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = typeof condition === "function" ? await condition() : condition;
    if (result) {
      if (label) console.log(`  waitFor(${label}): resolved after ${Date.now() - start}ms`);
      return true;
    }
    await sleep(interval);
  }
  if (label) console.log(`  waitFor(${label}): timed out after ${timeout}ms`);
  return false;
}

export function cdpFetch(url) {
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

export async function connectCDP(wsUrl) {
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
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 60000);
        pending.set(id, {
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { ws.close(); },
  };
}

export function cdpVal(r) {
  return r?.result?.result?.value;
}

export function killAll() {
  if (IS_WIN) {
    try { execSync("taskkill /F /IM DiskRaptor.exe 2>nul", { stdio: "ignore" }); } catch {}
    try { execSync("taskkill /F /IM diskraptor.exe 2>nul", { stdio: "ignore" }); } catch {}
    try { execSync("taskkill /F /IM QtWebEngineProcess.exe 2>nul", { stdio: "ignore" }); } catch {}
  } else {
    try { execSync("pkill -9 DiskRaptor 2>/dev/null", { stdio: "ignore" }); } catch {}
    try { execSync("pkill -9 QtWebEngineProcess 2>/dev/null", { stdio: "ignore" }); } catch {}
    try { execSync("pkill -9 diskraptor 2>/dev/null", { stdio: "ignore" }); } catch {}
  }
}

export async function jsExpr(cdp, expr) {
  // Retry once on a transient CDP timeout (WebKitGTK/WKWebView can stall
  // the first evaluate after a fresh launch).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      return cdpVal(r);
    } catch (e) {
      if (attempt === 0 && /CDP timeout/.test(String(e && e.message))) {
        await sleep(300);
        continue;
      }
      throw e;
    }
  }
}

let _invokeId = 0;

export async function jsInvoke(cdp, expr) {
  const id = '__iv_' + (++_invokeId);
  await cdp.send("Runtime.evaluate", {
    expression: `${expr}.then(r => { window['${id}'] = r; }).catch(e => { window['${id}'] = '__err:' + String(e.message || e); })`,
    returnByValue: false,
    awaitPromise: false,
  });
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const r = await cdp.send("Runtime.evaluate", {
      expression: `window['${id}']`,
      returnByValue: true,
      awaitPromise: false,
    });
    const val = cdpVal(r);
    if (val !== undefined && val !== null) {
      if (typeof val === 'string' && val.startsWith('__err:')) throw new Error(val.slice(6));
      return val;
    }
  }
  throw new Error(`Invoke timeout: ${expr.slice(0, 60)}`);
}

export function getExtraEnv(port) {
  const env = { ...process.env, DISKraptor_CDP_PORT: String(port) };
  if (IS_LINUX) {
    env.LD_LIBRARY_PATH = `${DIST_DIR}/lib:${DIST_DIR}:${process.env.LD_LIBRARY_PATH || ""}`;
  }
  return env;
}

export async function launchAndConnect(port = DEFAULT_CDP_PORT, scanPath = DEFAULT_SCAN_PATH) {
  killAll();
  await sleep(2000);

  if (!fs.existsSync(BIN_PATH)) throw new Error(`Missing binary: ${BIN_PATH}`);
  console.log(`  Binary: ${BIN_PATH}`);

  const isTauri = BIN_PATH === TAURI_DEBUG_PATH || BIN_PATH === TAURI_RELEASE_PATH;
  const child = spawn(BIN_PATH, [], {
    cwd: isTauri ? path.resolve("src-tauri") : DIST_DIR,
    env: getExtraEnv(port),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try {
      const pages = await cdpFetch(`http://127.0.0.1:${port}/json/list`);
      if (Array.isArray(pages) && pages.length > 0 && pages[0].webSocketDebuggerUrl) {
        wsUrl = pages[0].webSocketDebuggerUrl;
        break;
      }
    } catch {}
  }
  if (!wsUrl) throw new Error("Could not find page WebSocket URL");
  console.log("  Page WS ready");

  const cdp = await connectCDP(wsUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Console.enable");
  console.log("  CDP connected");

  let bridgeOk = false;
  if (isTauri) {
    // Tauri mode: __TAURI__ is injected by Tauri's preload, ready immediately
    bridgeOk = true;
    console.log("  Tauri mode: bridge ready");
  } else {
    for (let i = 0; i < 60; i++) {
      const val = await jsExpr(cdp, `!!(window.__TAURI__ && typeof window.__TAURI__.invoke === 'function' && window.__TAURI__.__qtBridgeReady)`);
      if (val === true) { bridgeOk = true; break; }
      await sleep(200);
    }
    if (!bridgeOk) {
      const state = await jsExpr(cdp, `JSON.stringify({
        title: document.title,
        url: document.location?.href || '',
        hasTauri: typeof window.__TAURI__ !== 'undefined',
        hasInvoke: typeof window.__TAURI__?.invoke === 'function',
        ready: window.__TAURI__?.__qtBridgeReady || false
      })`);
      console.log(`  Bridge state: ${state}`);
      throw new Error("Bridge not ready");
    }
    console.log("  Bridge ready");
  }

  return { cdp, child };
}

let assertPassed = 0;
let assertFailed = 0;

export function resetAssert() {
  assertPassed = 0;
  assertFailed = 0;
}

export function assert(label, ok, detail) {
  if (ok) {
    console.log(`  \u2713 ${label}`);
    assertPassed++;
  } else {
    console.log(`  \u2717 ${label}${detail ? " -- " + detail : ""}`);
    assertFailed++;
  }
}

export function getAssertCounts() {
  return { passed: assertPassed, failed: assertFailed };
}

export async function clickAndWait(cdp, selector, ms = 500) {
  await jsExpr(cdp, `document.querySelector('${selector}')?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  if (ms > 0) await sleep(ms);
}

export async function clickById(cdp, id, ms = 500) {
  await jsExpr(cdp, `document.getElementById('${id}').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
  if (ms > 0) await sleep(ms);
}

export async function setValue(cdp, id, value) {
  await jsExpr(cdp, `document.getElementById('${id}').value = ${JSON.stringify(value)}; 'set'`);
}

export async function startScan(cdp, scanPath) {
  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan");
}

export async function waitForOverlay(cdp, timeoutMs = 30000) {
  // Fast scans hide the overlay in well under 100 ms, so poll tightly at the
  // start (20 ms) to avoid a flaky "overlay never appeared" on small dirs.
  const limit = Math.ceil(timeoutMs / 20);
  for (let i = 0; i < limit; i++) {
    await sleep(20);
    const o = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    if (o === true) return true;
  }
  return false;
}

export async function waitForStatsPopulated(cdp, timeoutMs = 10000) {
  return waitFor(async () => {
    const m = await jsExpr(cdp, `({
      files: (document.getElementById('stat-files')?.textContent || '0').replace(/,/g, ''),
      dirs: (document.getElementById('stat-dirs')?.textContent || '0').replace(/,/g, ''),
      size: (document.getElementById('stat-size')?.textContent || '')
    })`);
    const files = parseInt(m?.files) || 0;
    const dirs = parseInt(m?.dirs) || 0;
    return files > 0 && dirs > 0 && m?.size !== "" && m?.size !== "—";
  }, { timeout: timeoutMs, label: "stats" });
}

export async function waitForTreeReady(cdp, timeoutMs = 10000) {
  return waitFor(async () => {
    const count = await jsExpr(cdp, `document.querySelectorAll('.tree-row')?.length || 0`);
    return count > 0;
  }, { timeout: timeoutMs, label: "tree" });
}

export async function waitForScanComplete(cdp, timeoutMs = 120000) {
  const now = Date.now();
  let lastFiles = -1;
  while (Date.now() - now < timeoutMs) {
    await sleep(100);
    try {
      const m = await jsExpr(cdp, `({
        files: (document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''),
        ov: document.getElementById('progress-overlay')?.classList.contains('active'),
        ovExists: !!document.getElementById('progress-overlay'),
        st: document.querySelector('.status-bar')?.textContent || '',
        treeRows: document.querySelectorAll('.tree-row')?.length || 0
      })`);
      if (!m) continue;
      const files = parseInt(m.files) || 0;
      if (files > lastFiles) lastFiles = files;
      const ovHidden = !m.ov || !m.ovExists;
      if (ovHidden && (lastFiles > 0 || m.st?.includes("Complete") || m.treeRows > 0))
        return { completed: true, maxFiles: lastFiles };
      if (m.st?.includes("Complete")) return { completed: true, maxFiles: lastFiles };
      if (m.st?.includes("Error")) return { completed: false, maxFiles: lastFiles, error: m.st };
    } catch {}
  }
  return { completed: false, maxFiles: lastFiles > 0 ? lastFiles : 0 };
}

export async function cleanup(cdp, exitCode = 0) {
  try { await cdp.send("Close"); } catch {}
  setTimeout(() => { killAll(); process.exit(exitCode); }, 500);
}

export async function runTest(name, port, fn) {
  console.log(`\n${"=".repeat(40)}`);
  console.log(` ${name}`);
  console.log(`${"=".repeat(40)}\n`);
  resetAssert();
  killAll();

  const cdpPort = port || parseInt(process.env.DISKraptor_TEST_PORT) || DEFAULT_CDP_PORT + Math.floor(Math.random() * 100);
  const scanPath = process.argv[2] || DEFAULT_SCAN_PATH;

  try {
    const { cdp } = await launchAndConnect(cdpPort, scanPath);
    await fn(cdp, scanPath);
    const { passed, failed } = getAssertCounts();
    console.log(`\n  Passed: ${passed}  Failed: ${failed}`);
    if (failed > 0) {
      console.log("  \u2717 FAIL");
      await cleanup(cdp, 1);
    } else {
      console.log("  \u2713 PASS");
      await cleanup(cdp, 0);
    }
  } catch (err) {
    console.error(`\nError: ${err.message}`);
    killAll();
    process.exit(1);
  }
}
