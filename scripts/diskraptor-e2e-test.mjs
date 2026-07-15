/**
 * DiskRaptor E2E Test — screenshot-based verification
 * 
 * 1. Launches DiskRaptor with CDP on port 9222
 * 2. Checks emoji render correctly in the toolbar
 * 3. Simulates scanning C:\dev\DiskRaptor
 * 4. Takes screenshots at each step
 * 5. Saves to C:\Users\hansj\Desktop\diskraptor_test/
 */

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const CDP_PORT = 9222;
const BINARY = "C:\\Program Files\\DiskRaptor\\DiskRaptor.exe";
const SCREENSHOT_DIR = "C:\\Users\\hansj\\Desktop\\diskraptor_test";
const TEST_DIR = "C:\\dev\\DiskRaptor";

// Ensure screenshot dir
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

let appProcess = null;
let browser = null;

async function waitForCDP(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const targets = await resp.json();
      if (targets && targets.length > 0) {
        const wsUrl = targets[0].webSocketDebuggerUrl;
        console.log("  [CDP] Connected, WS URL:", wsUrl);
        return wsUrl;
      }
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error("CDP timeout");
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("\n=== DiskRaptor E2E Test ===\n");

  // 1. Kill any existing instance
  console.log("[1/6] Killing existing processes...");
  try {
    spawn("taskkill", ["/f", "/im", "DiskRaptor.exe"], { stdio: "ignore" });
    await sleep(2000);
  } catch {}

  // 2. Launch app with CDP
  console.log("[2/6] Launching DiskRaptor with CDP...");
  const env = { ...process.env, DISKraptor_CDP_PORT: String(CDP_PORT) };
  appProcess = spawn(BINARY, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  appProcess.stdout.on("data", d => process.stdout.write("  [app] " + d));
  appProcess.stderr.on("data", d => process.stderr.write("  [app-err] " + d));

  // 3. Wait for CDP
  console.log("[3/6] Waiting for WebEngine CDP...");
  const wsUrl = await waitForCDP();

  // 4. Connect Playwright
  console.log("[4/6] Connecting Playwright...");
  browser = await chromium.connectOverCDP(wsUrl);
  const page = browser.contexts()[0]?.pages()[0] || (await browser.newPage());
  await sleep(3000);

  // 5. Screenshot: initial state
  console.log("[5/6] Taking screenshots...");
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "01-initial.png") });
  console.log("  -> 01-initial.png saved");

  // Check toolbar buttons for emoji
  const toolbarHtml = await page.evaluate(() => {
    const toolbar = document.querySelector(".toolbar") || document.body;
    return toolbar.innerHTML;
  });
  
  // Check for garbled characters
  const garbled = toolbarHtml.match(/[\u00e0-\u00ff\u0152-\u0178]/g) || [];
  console.log(`  Garbled chars in toolbar: ${garbled.length}`);

  // Try to interact: type a path
  const pathInput = await page.$('input[type="text"], input:not([type])');
  if (pathInput) {
    await pathInput.click();
    await pathInput.fill(TEST_DIR);
    await sleep(500);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-path-filled.png") });
    console.log("  -> 02-path-filled.png saved");
  }

  // Click Scan button
  const scanBtn = await page.$('button:has-text("Scan"), button:has-text("Scannen"), .scan-btn');
  if (scanBtn) {
    await scanBtn.click();
    console.log("  [Scan] clicked, waiting 10s for results...");
    await sleep(10000);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "03-after-scan.png") });
    console.log("  -> 03-after-scan.png saved");
  } else {
    console.log("  [Scan] button not found, taking state screenshot");
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, "02-no-scan-btn.png") });
  }

  // Final screenshot
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, "04-final.png") });
  console.log("  -> 04-final.png saved");

  console.log("\n=== Test complete ===");
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
}

main().catch(e => {
  console.error("Test failed:", e.message);
  process.exit(1);
}).finally(() => {
  if (browser) browser.close();
  if (appProcess) appProcess.kill();
});
