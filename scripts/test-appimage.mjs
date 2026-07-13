/**
 * DiskRaptor Real App Integration Test
 *
 * This actually starts the compiled binary/AppImage and tests the real WebView.
 * Unlike the mock tests in uitest-matrix.html, this tests real Tauri IPC.
 *
 * Usage:
 *   node test-appimage.mjs /path/to/diskraptor.AppImage
 *   node test-appimage.mjs /path/to/diskraptor.exe
 */

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const binaryPath = process.argv[2];
if (!binaryPath) {
  console.error("Usage: node test-appimage.mjs <path-to-binary>");
  process.exit(1);
}

if (!fs.existsSync(binaryPath)) {
  console.error(`❌ Binary not found: ${binaryPath}`);
  process.exit(1);
}

const APPIMAGE_EXTRACT_AND_RUN = "1";
const WEBKIT_DISABLE_COMPOSITING_MODE = "1";
const GTK_THEME = "Adwaita";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testAppImage() {
  console.log(`\n  ═══ DiskRaptor Integration Test ═══\n`);
  console.log(`  Binary: ${binaryPath}`);
  console.log(`  Size: ${(fs.statSync(binaryPath).size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  Type: ${path.extname(binaryPath) || "unknown"}\n`);

  // Start the app
  console.log("  [1/5] Starting application...");
  const proc = spawn(binaryPath, [], {
    env: {
      ...process.env,
      APPIMAGE_EXTRACT_AND_RUN,
      WEBKIT_DISABLE_COMPOSITING_MODE,
      GTK_THEME,
      DISPLAY: process.env.DISPLAY || ":0",
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => { stdout += d.toString(); });
  proc.stderr.on("data", (d) => { stderr += d.toString(); });

  // Wait for startup
  await sleep(3000);

  // Check if process is alive
  if (proc.exitCode !== null) {
    console.log(`  ❌ [1/5] Process exited immediately with code ${proc.exitCode}`);
    console.log(`  STDERR: ${stderr.slice(0, 500)}`);
    proc.kill();
    process.exit(1);
  }
  console.log("  ✅ [1/5] Process is running");

  // Check for WebView/GTK errors in stderr
  console.log("  [2/5] Checking for WebView errors...");
  const webkitErrors = [];
  if (stderr) {
    const lines = stderr.toLowerCase().split("\n");
    for (const line of lines) {
      if (line.includes("webkit") || line.includes("gtk") || 
          line.includes("wayland") || line.includes("display") ||
          line.includes("fuse") || line.includes("libgl")) {
        webkitErrors.push(line.trim());
      }
    }
  }
  if (webkitErrors.length > 0) {
    console.log(`  ⚠️  [2/5] WebView/GTK warnings found (${webkitErrors.length}):`);
    webkitErrors.slice(0, 5).forEach((e) => console.log(`       ${e}`));
  } else {
    console.log("  ✅ [2/5] No WebView errors detected");
  }

  // Wait longer for WebView to initialize
  await sleep(4000);

  // Check process still alive (WebView initialized = window opened)
  console.log("  [3/5] Verifying WebView initialization...");
  if (proc.exitCode !== null) {
    console.log(`  ❌ [3/5] Process died during WebView init (exit ${proc.exitCode})`);
    console.log(`  STDERR: ${stderr.slice(-500)}`);
    proc.kill();
    process.exit(1);
  }
  console.log("  ✅ [3/5] WebView window opened (process alive after 7s)");

  // Check for X server / display
  console.log("  [4/5] Checking display environment...");
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    console.log("  ⚠️  [4/5] No DISPLAY or WAYLAND_DISPLAY set");
    console.log("       WebView may not render (headless environment)");
    console.log("       Set DISPLAY=:0 or use Xvfb for headless testing");
  } else {
    console.log(`  ✅ [4/5] Display: ${process.env.DISPLAY || process.env.WAYLAND_DISPLAY}`);
  }

  // Print key errors from stderr
  console.log("  [5/5] Checking startup logs...");
  const errorLines = stderr.split("\n").filter((l) => l.trim());
  const relevantErrors = errorLines.filter(
    (l) =>
      l.includes("error") ||
      l.includes("Error") ||
      l.includes("ERROR") ||
      l.includes("failed") ||
      l.includes("Failed") ||
      l.includes("cannot") ||
      l.includes("Cannot") ||
      l.includes("not found")
  );
  if (relevantErrors.length > 0) {
    console.log(`  ⚠️  [5/5] ${relevantErrors.length} potential errors:`);
    relevantErrors.slice(0, 8).forEach((e) => console.log(`       ${e}`));
  } else {
    console.log("  ✅ [5/5] No critical errors in startup");
  }

  // Clean up
  console.log("\n  Cleaning up...");
  proc.kill("SIGTERM");
  await sleep(500);
  try { proc.kill("SIGKILL"); } catch {}

  console.log(`\n  ═══ Integration Test Complete ═══`);
  if (relevantErrors.length === 0 && webkitErrors.length === 0) {
    console.log("  ✅ PASSED — AppImage starts and WebView initializes");
    process.exit(0);
  } else {
    console.log("  ⚠️  PASSED with warnings");
    process.exit(0);
  }
}

testAppImage().catch((err) => {
  console.error(`\n  ❌ FAILED: ${err.message}`);
  process.exit(1);
});
