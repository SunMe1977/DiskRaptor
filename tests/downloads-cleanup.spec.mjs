import { chromium } from "playwright";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9333;
const BIN_PATH = path.resolve(__dirname, "..", "dist", "DiskRaptor");
const DIST_DIR = path.resolve(__dirname, "..", "dist");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function killAll() {
  try {
    spawn("pkill", ["-9", "DiskRaptor"], { stdio: "ignore" });
    spawn("pkill", ["-9", "QtWebEngineProcess"], { stdio: "ignore" });
  } catch {}
}

async function waitForApp(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const ready = await page.evaluate(() =>
        !!(
          window.__TAURI__ &&
          typeof window.__TAURI__.invoke === "function" &&
          window.__TAURI__.__qtBridgeReady
        )
      );
      if (ready) return true;
    } catch {}
    await sleep(500);
  }
  throw new Error("App bridge not ready within timeout");
}

async function waitForOverlay(page, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const active = await page
      .$eval("#progress-overlay", (el) => el.classList.contains("active"))
      .catch(() => false);
    if (active) return true;
    await sleep(500);
  }
  throw new Error("Progress overlay never appeared");
}

async function waitForScanComplete(page, timeout = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const overlay = await page
      .$eval("#progress-overlay", (el) => el.classList.contains("active"))
      .catch(() => false);
    const status = await page
      .$eval(".status-bar", (el) => el.textContent)
      .catch(() => "");
    if (!overlay || status.includes("Complete") || status.includes("complete"))
      return true;
    await sleep(1000);
  }
  throw new Error("Scan did not complete within timeout");
}

async function waitForCleanupPanel(page, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const panel = await page.$("#cleanup-panel").catch(() => null);
    if (panel) return panel;
    await sleep(500);
  }
  return null;
}

async function main() {
  console.log("\n=== Downloads Cleanup UI Test ===");
  killAll();
  await sleep(2000);

  if (!fs.existsSync(BIN_PATH)) {
    console.error(`Binary not found: ${BIN_PATH}`);
    console.log("Run 'bash build.sh' first or set the correct path");
    process.exit(1);
  }
  console.log(`Binary: ${BIN_PATH}`);

  // Launch app
  const child = spawn(BIN_PATH, [], {
    cwd: DIST_DIR,
    env: {
      ...process.env,
      DISKraptor_CDP_PORT: String(CDP_PORT),
      LD_LIBRARY_PATH: `/usr/lib/diskraptor:${process.env.LD_LIBRARY_PATH || ""}`,
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Connect Playwright via CDP
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${CDP_PORT}`,
  );
  const context = browser.contexts()[0] || browser;
  const [page] = context.pages();

  if (!page) {
    // Wait for page to appear
    let p = null;
    for (let i = 0; i < 30; i++) {
      const pages = context.pages();
      if (pages.length > 0) {
        p = pages[0];
        break;
      }
      await sleep(500);
    }
    if (!p) throw new Error("No page found");
  }

  console.log("Connected to app via CDP");

  // Wait for bridge
  await waitForApp(page);
  console.log("Bridge ready");

  // Click "Scan Downloads" from tools menu
  await page.click("#btn-tools");
  await sleep(300);
  await page.click('.tools-item[data-action="scan-downloads"]');
  console.log("Clicked Scan Downloads");

  // Wait for progress overlay
  await waitForOverlay(page);
  console.log("Scan started");

  // Wait for scan to complete
  await waitForScanComplete(page);
  console.log("Scan complete");

  // Wait for cleanup panel to appear
  await sleep(2000);
  const panel = await waitForCleanupPanel(page);

  // Verify cleanup panel
  if (panel) {
    const header = await panel.$eval("h4", (el) => el.textContent);
    const text = await panel.textContent();
    const hasItems = text.includes("items");
    const hasReclaimable = text.includes("reclaimable");

    console.log(`Panel header: ${header}`);
    console.log(`Has items: ${hasItems}`);
    console.log(`Has reclaimable: ${hasReclaimable}`);

    if (!hasItems || !hasReclaimable) {
      console.warn("Cleanup panel missing expected content");
    }

    // Verify checkboxes exist
    const checkboxes = await panel.$$(
      '.cleanup-item input[type="checkbox"]',
    );
    console.log(`Cleanable items: ${checkboxes.length}`);

    // Verify action buttons exist
    const selectAll = await panel.$("#cleanup-select-all");
    const moveTrash = await panel.$("#cleanup-move-trash");
    const close = await panel.$("#cleanup-close");

    console.log(`Select All btn: ${!!selectAll}`);
    console.log(`Move to Trash btn: ${!!moveTrash}`);
    console.log(`Close btn: ${!!close}`);

    // Test Select All toggle
    if (selectAll) {
      await selectAll.click();
      const allUnchecked = await panel.evaluate(() => {
        const cbs = document.querySelectorAll(
          '#cleanup-panel .cleanup-item input[type="checkbox"]',
        );
        return Array.from(cbs).every((cb) => !cb.checked);
      });
      console.log(`Select All unchecked all: ${allUnchecked}`);
    }

    if (checkboxes.length > 0 && hasItems && hasReclaimable) {
      console.log("\n\u2713 PASS: Downloads Cleanup panel works correctly");
    } else {
      console.log("\n\u26A0 PARTIAL: Panel appeared but content may be incomplete");
    }
  } else {
    // Check status bar for message
    const status = await page
      .$eval(".status-bar", (el) => el.textContent)
      .catch(() => "");
    console.log(`Status bar: ${status}`);

    // Check if path was "download" (case-insensitive)
    const pathVal = await page
      .$eval("#scan-path", (el) => el.value)
      .catch(() => "");
    console.log(`Scan path: ${pathVal}`);

    console.log("\n\u2717 FAIL: Cleanup panel did not appear");
    console.log("Possible causes:");
    console.log("  - Rust scanner not loaded (run via 'diskraptor' wrapper)");
    console.log("  - No cleanable files found in Downloads");
    console.log("  - Scan path does not contain 'download'");
    process.exit(1);
  }

  await browser.close();
  killAll();
  console.log("Done");
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  killAll();
  process.exit(1);
});
