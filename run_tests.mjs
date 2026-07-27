#!/usr/bin/env node
import { execSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

const PLATFORM = process.platform;
const IS_WIN = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";
const IS_LINUX = PLATFORM === "linux";

const DIST_DIR = path.resolve("dist");
const BIN_NAME = IS_WIN ? "DiskRaptor.exe" : "DiskRaptor";
const BIN_PATH = path.join(DIST_DIR, BIN_NAME);
const MAC_PATH = path.join(DIST_DIR, "DiskRaptor.app", "Contents", "MacOS", "DiskRaptor");
const EXE_PATH = IS_MAC ? MAC_PATH : BIN_PATH;

const ALL_TESTS = [
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
];

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
    console.error(`ERROR: Binary not found: ${EXE_PATH}`);
    console.error("Run 'build.bat' or 'build.sh' first");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(DIST_DIR, "frontend"))) {
    console.error(`ERROR: Frontend not found: ${path.join(DIST_DIR, "frontend")}`);
    console.error("Run 'build.bat' or 'build.sh' first");
    process.exit(1);
  }
  console.log(`  Binary:  ${EXE_PATH}`);
  console.log(`  Frontend: ${path.join(DIST_DIR, "frontend")}\\`);
  console.log();
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
  console.log("  node run_tests.mjs test_scan_ui.mjs        # Run specific test");
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
    testList = ALL_TESTS.filter(t =>
      ["Scan", "Welcome", "Menu/Diagram", "Theme", "Tree View", "Galaxy"].includes(t.name)
    );
    console.log("Quick mode: running subset\n");
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
  const perTestTimeout = timeoutArg ? parseInt(timeoutArg.split("=")[1]) * 1000 : 180000;

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let results = [];

  for (const test of testList) {
    const testPath = path.resolve(test.file);
    console.log("-".repeat(50));
    console.log(`  Running: ${test.file} (${test.name})`);
    console.log("-".repeat(50));

    if (!fs.existsSync(testPath)) {
      console.log(`  SKIPPED: ${test.file} not found`);
      skipped++;
      results.push({ name: test.name, file: test.file, status: "SKIP" });
      continue;
    }

    const startTime = Date.now();
    try {
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

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
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

    await new Promise((r) => setTimeout(r, 2000));
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
