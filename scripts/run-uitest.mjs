/**
 * DiskRaptor Cross-Platform UI Test Runner
 *
 * Runs the uitest-matrix.html test suite in headless Chromium.
 * Supports JSON output for CI matrix generation.
 *
 * Usage:
 *   node run-uitest.mjs                    # Run tests, human output
 *   node run-uitest.mjs --json             # JSON output for CI
 *   node run-uitest.mjs --file=tests.html  # Use a specific test file
 */

import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const formatJson = args.includes("--json");
const testFile = args.find((a) => a.startsWith("--file="));
const testFileName = testFile ? testFile.split("=")[1] : "uitest-matrix.html";
const htmlPath = path.join(__dirname, "frontend", testFileName);
const fileUrl = "file://" + htmlPath.replace(/\\/g, "/");

const platform = process.platform; // win32, darwin, linux
const osName =
  platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : "Linux";

let outputLines = [];

function log(msg) {
  if (!formatJson) console.log(msg);
  outputLines.push(msg);
}

async function run() {
  log(`\n  ═══ DiskRaptor UI Test Matrix — ${osName} ═══\n`);
  log(`  Test file: ${testFileName}\n`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(fileUrl, { waitUntil: "networkidle", timeout: 20000 });

  // Wait for test results
  await page.waitForFunction(
    () => {
      const out = document.getElementById("test-output");
      return out && out.textContent.includes("Passed:");
    },
    { timeout: 45000 },
  );

  const text = await page.textContent("#test-output");

  if (formatJson) {
    // Parse test results for JSON output
    const lines = text.split("\n").filter((l) => l.trim());
    const passCount = (text.match(/✔/g) || []).length;
    const failCount = (text.match(/✘/g) || []).length;

    // Extract category breakdown
    const cats = [];
    const catMatch = text.matchAll(/Category\s+([A-Z])\s*:\s*(\d+)\s*passed.*?(\d+)\s*failed/g);
    for (const m of catMatch) {
      cats.push({ category: m[1], passed: parseInt(m[2]), failed: parseInt(m[3]) });
    }

    // Extract individual test results
    const tests = [];
    const testLines = text.match(/([✔✘])\s*(A\d+|B\d+|C\d+|D\d+|E\d+|F\d+|G\d+|H\d+|I\d+|J\d+|K\d+|L\d+|M\d+):\s*(.+)/g);
    if (testLines) {
      for (const tl of testLines) {
        const m = tl.match(/([✔✘])\s*((?:A|B|C|D|E|F|G|H|I|J|K|L|M)\d+):\s*(.+)/);
        if (m) {
          tests.push({
            id: m[2],
            name: m[3].trim(),
            status: m[1] === "✔" ? "passed" : "failed",
          });
        }
      }
    }

    const result = {
      platform: osName,
      timestamp: new Date().toISOString(),
      total: passCount + failCount,
      passed: passCount,
      failed: failCount,
      errors: errors.length > 0 ? errors : undefined,
      categories: cats.length > 0 ? cats : undefined,
      tests: tests.length > 0 ? tests : undefined,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    log(text);
    log(`\n  ═══ Results: ${osName} ═══`);
    const passCount = (text.match(/✔/g) || []).length;
    const failCount = (text.match(/✘/g) || []).length;
    log(`  Passed: ${passCount}  |  Failed: ${failCount}`);
    if (errors.length > 0) {
      log(`  Console errors: ${errors.length}`);
      errors.slice(0, 5).forEach((e) => log(`    ${e}`));
    }
    log("");
  }

  await browser.close();
  const failCount = (text.match(/✘/g) || []).length;
  if (failCount > 0) process.exit(1);
}

run().catch((err) => {
  if (formatJson) {
    console.log(JSON.stringify({ platform: osName, error: err.message, passed: 0, failed: 0, tests: [] }));
  } else {
    console.error("Fatal:", err.message);
  }
  process.exit(1);
});
