#!/usr/bin/env node
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const BIN_NAME = IS_WIN ? "DiskRaptor.exe" : "DiskRaptor";
const BIN_PATH = path.join(DIST_DIR, BIN_NAME);
const MAC_PATH = path.join(DIST_DIR, "DiskRaptor.app", "Contents", "MacOS", "DiskRaptor");
const TAURI_BIN_NAME = IS_WIN ? "diskraptor.exe" : "diskraptor";
const TAURI_RELEASE_PATH = path.resolve(PROJECT_ROOT, "src-tauri", "target", "release", TAURI_BIN_NAME);
const TAURI_DEBUG_PATH = path.resolve(PROJECT_ROOT, "src-tauri", "target", "debug", TAURI_BIN_NAME);
const TAURI_RELEASE_ALT_PATH = path.resolve(PROJECT_ROOT, "src-tauri", "target", "release", "diskraptor");
const TAURI_DEBUG_ALT_PATH = path.resolve(PROJECT_ROOT, "src-tauri", "target", "debug", "diskraptor");
const EXE_PATH = fs.existsSync(TAURI_RELEASE_PATH) ? TAURI_RELEASE_PATH :
                fs.existsSync(TAURI_DEBUG_PATH) ? TAURI_DEBUG_PATH :
                fs.existsSync(TAURI_RELEASE_ALT_PATH) ? TAURI_RELEASE_ALT_PATH :
                fs.existsSync(TAURI_DEBUG_ALT_PATH) ? TAURI_DEBUG_ALT_PATH :
                (IS_MAC ? MAC_PATH : BIN_PATH);

const CORE_TESTS = [
  { name: "Scan",          file: "test_scan_ui.mjs",    port: 9200 },
  { name: "Welcome",       file: "test_welcome_ui.mjs", port: 9201 },
  { name: "Settings",      file: "test_settings_ui.mjs", port: 9202 },
  { name: "Tree View",     file: "test_tree_ui.mjs",    port: 9203 },
  { name: "Top Files",     file: "test_topfiles_ui.mjs", port: 9204 },
  { name: "Theme",         file: "test_theme_ui.mjs",   port: 9205 },
  { name: "Context Menu",  file: "test_context_menu_ui.mjs", port: 9206 },
  { name: "Galaxy",        file: "test_galaxy_ui.mjs",  port: 9207 },
  { name: "Menu/Diagram",  file: "test_menus_ui.mjs",   port: 9208 },
  { name: "Export",        file: "test_export_ui.mjs",  port: 9209 },
  { name: "Favorites",     file: "test_favorites_ui.mjs", port: 9210 },
  { name: "Filters",       file: "test_filters_ui.mjs", port: 9211 },
  { name: "Find Files",    file: "test_find_ui.mjs",    port: 9212 },
  { name: "Duplicates",    file: "test_duplicates_ui.mjs", port: 9213 },
  { name: "i18n",          file: "test_i18n_ui.mjs",    port: 9214 },
  { name: "File Ops",      file: "test_fileops_ui.mjs", port: 9215 },
  { name: "Progress",      file: "test_progress_ui.mjs", port: 9216 },
  { name: "Rescan",        file: "test_rescan_ui.mjs",  port: 9217 },
  { name: "Trash",         file: "test_trash_ui.mjs",   port: 9218 },
  { name: "Trash Recovery",file: "test_trash_recovery_ui.mjs", port: 9219 },
  { name: "Bridge/Tauri",  file: "test_bridge_ui.mjs",  port: 9220 },
  { name: "Integration",   file: "test_integration_ui.mjs", port: 9221 },
  { name: "Cleanup",       file: "test_cleanup_ui.mjs",    port: 9222 },
  { name: "Downloads-Trash",file: "test_downloads_cleanup_trash.mjs", port: 9230 },
];

// Auto-discover every standalone UI test (`test_*_ui.mjs`) so newly added
// tests are picked up automatically without editing this list.
function discoverAdditionalTests() {
  const existing = new Set(CORE_TESTS.map(t => t.file));
  const files = fs
    .readdirSync(__dirname)
    .filter(f => /^test_.*_ui\.mjs$/.test(f))
    .filter(f => !existing.has(f))
    .sort();
  return files.map((file, i) => {
    const base = file.replace(/^test_/, "").replace(/_ui\.mjs$/, "");
    const name = base
      .split("_")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    // Ports start above the curated range; the runner passes DISKraptor_TEST_PORT.
    return { name, file, port: 9231 + i };
  });
}

const ALL_TESTS = [...CORE_TESTS, ...discoverAdditionalTests()];

function printBanner() {
  console.log();
  console.log("=".repeat(60));
  console.log(`  DiskRaptor Cross-Platform Test Suite`);
  console.log(`  Platform: ${PLATFORM}  |  Binary: ${EXE_PATH}`);
  console.log("=".repeat(60));
  console.log();
}

function checkBinary() {
  if (!fs.existsSync(EXE_PATH)) {
    if (!fs.existsSync(TAURI_RELEASE_PATH)) {
      console.error(`ERROR: Binary not found at ${EXE_PATH} or ${TAURI_RELEASE_PATH}`);
      console.error("Run 'npm run build' or 'bash build.sh' first");
      process.exit(1);
    }
  }
  console.log(`  Binary:  ${EXE_PATH}`);
  console.log(`  Frontend: embedded in binary`);
  console.log();
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

function waitForPortFree(port, timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const poll = () => {
      cdpFetch(`http://127.0.0.1:${port}/json/list`)
        .then(() => {
          if (Date.now() - start < timeout) setTimeout(poll, 100);
          else resolve();
        })
        .catch(() => resolve());
    };
    poll();
  });
}

function printUsage() {
  console.log("Usage: node run_tests.mjs [options] [test-name...]");
  console.log();
  console.log("Options:");
  console.log("  --list        List all available tests");
  console.log("  --quick       Run a quick subset (scan, welcome, menus)");
  console.log("  --timeout N   Per-test timeout in seconds (default: 180)");
  console.log("  --parallel    Run tests in parallel (experimental)");
  console.log();
  console.log("Examples:");
  console.log("  node run_tests.mjs                         # Run all tests");
  console.log("  node tests/run_tests.mjs test_scan_ui.mjs        # Run specific test");
  console.log("  node run_tests.mjs --quick                 # Quick smoke test");
  console.log("  node run_tests.mjs --timeout 300           # Longer timeout");
  console.log();
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    process.exit(0);
  }

  if (args.includes("--list")) {
    console.log("Available tests:");
    for (const t of ALL_TESTS) {
      console.log(`  ${t.file.padEnd(30)} ${t.name}`);
    }
    process.exit(0);
  }

  printBanner();
  checkBinary();

  let testList = ALL_TESTS;

  if (args.includes("--quick")) {
    const quickFiles = new Set([
      "test_scan_ui.mjs",
      "test_welcome_ui.mjs",
      "test_menus_ui.mjs",
      "test_theme_ui.mjs",
      "test_tree_ui.mjs",
      "test_galaxy_ui.mjs",
    ]);
    testList = ALL_TESTS.filter(t => quickFiles.has(t.file));
    console.log(`Quick mode: running ${testList.length} smoke tests\n`);
  }

  const namedTests = args.filter(a => !a.startsWith("--"));
  if (namedTests.length > 0) {
    testList = ALL_TESTS.filter(t => namedTests.includes(t.file));
    if (testList.length === 0) {
      console.error("No matching tests found. Use --list to see available tests.");
      process.exit(1);
    }
  }

  const timeoutArg = args.find(a => a.startsWith("--timeout="));
  const perTestTimeout = timeoutArg
    ? parseInt(timeoutArg.split("=")[1]) * 1000
    : (args.includes("--quick") ? 90000 : 180000);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let results = [];

  for (const test of testList) {
    const testPath = path.resolve(__dirname, test.file);
    console.log("-".repeat(50));
    console.log(`  Running: ${test.file} (${test.name})`);
    console.log("-".repeat(50));

    if (!fs.existsSync(testPath)) {
      console.log(`  SKIPPED: ${test.file} not found`);
      skipped++;
      results.push({ name: test.name, file: test.file, status: "SKIP" });
      continue;
    }

    const runOnce = async () => {
      const startTime = Date.now();
      const child = spawn("node", [testPath], {
        stdio: ["ignore", "inherit", "inherit"],
        env: { ...process.env, DISKraptor_TEST_PORT: String(test.port) },
        shell: IS_WIN,
        timeout: perTestTimeout,
      });
      const code = await new Promise((resolve) => {
        child.on("close", resolve);
        child.on("error", (err) => {
          console.error(`  Spawn error: ${err.message}`);
          resolve(-1);
        });
      });
      return { code, elapsed: ((Date.now() - startTime) / 1000).toFixed(1) };
    };

    try {
      let { code, elapsed } = await runOnce();
      // Flaky CDP (WebKitGTK/WKWebView) can stall on a fresh launch — retry
      // once before giving up on a timeout.
      if (code === null) {
        console.log(`  TIMEOUT on first attempt, retrying once...`);
        const retry = await runOnce();
        code = retry.code;
        elapsed = retry.elapsed;
      }

      if (code === 0) {
        console.log(`  \u2713 PASSED: ${test.file} (${elapsed}s)`);
        passed++;
        results.push({ name: test.name, file: test.file, status: "PASS", time: elapsed });
      } else if (code === null) {
        console.log(`  SKIPPED: ${test.file} (timeout)`);
        skipped++;
        results.push({ name: test.name, file: test.file, status: "TIMEOUT" });
      } else {
        console.log(`  \u2717 FAILED: ${test.file} exit=${code} (${elapsed}s)`);
        failed++;
        results.push({ name: test.name, file: test.file, status: "FAIL", time: elapsed });
      }
    } catch (err) {
      console.error(`  \u2717 FAILED: ${test.file} -- ${err.message}`);
      failed++;
      results.push({ name: test.name, file: test.file, status: "FAIL" });
    }

    await waitForPortFree(test.port, 5000);
  }

  console.log();
  console.log("=".repeat(50));
  console.log("  RESULTS");
  console.log("=".repeat(50));
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${testList.length}`);
  console.log();

  if (failed > 0 || results.some(r => r.status === "FAIL")) {
    console.log("  --- Failed Tests ---");
    for (const r of results) {
      if (r.status === "FAIL" || r.status === "TIMEOUT") {
        console.log(`    ${r.status}: ${r.file} (${r.name})${r.time ? ` [${r.time}s]` : ""}`);
      }
    }
    console.log();
    process.exit(1);
  }

  console.log("  All tests passed!");
  console.log();
}

main().catch((err) => {
  console.error(`Runner error: ${err.message}`);
  process.exit(1);
});
