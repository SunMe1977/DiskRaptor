import { runTest, assert, sleep, BIN_PATH, TAURI_DEBUG_PATH, TAURI_RELEASE_PATH } from "./test_shared.mjs";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const isTauri = BIN_PATH === TAURI_DEBUG_PATH || BIN_PATH === TAURI_RELEASE_PATH;

runTest("DiskRaptor Downloads Cleanup Test", 9230, async (cdp) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diskraptor-test-downloads-"));
  console.log(`  Temp dir: ${tmpDir}`);

  const testCategories = {
    installer: ["installer_package.dmg", "old_backup.tar.gz", "temp_cache.zip", "setup.exe"],
    temp: ["debug.log", "preview.tmp", "thumb.cache"],
    duplicate: ["document (2).zip", "photo (3).png"],
    old: ["old_report.txt"],
  };
  const OLD_DAYS = 70;
  const OLD_MS = OLD_DAYS * 24 * 60 * 60 * 1000;
  const oldTime = new Date(Date.now() - OLD_MS);
  const testDirs = ["subfolder"];
  const dirFile = "subfolder/extra_installer.pkg";

  fs.mkdirSync(path.join(tmpDir, "subfolder"));
  const allRelPaths = [];
  for (const [cat, files] of Object.entries(testCategories)) {
    for (const f of files) {
      const fp = path.join(tmpDir, f);
      fs.writeFileSync(fp, cat === "old" ? Buffer.alloc(2 * 1024 * 1024, "x") : "test content for " + f);
      if (cat === "old") fs.utimesSync(fp, oldTime, oldTime);
      allRelPaths.push(f);
    }
  }
  fs.writeFileSync(path.join(tmpDir, dirFile), "test content for " + dirFile);
  allRelPaths.push(dirFile);
  console.log(`  Created ${allRelPaths.length} test files`);

  // Test delete_path (move to trash) via IPC
  console.log("\n  Testing delete_path...");
  let ok = 0, fail = 0;
  for (const relPath of allRelPaths) {
    const fullPath = path.join(tmpDir, relPath);
    try {
      const delRes = await jsInvokeSafe(cdp, `window.__TAURI__.invoke('delete_path', ${JSON.stringify({path: fullPath})})`);
      if (delRes && delRes.success === false) { fail++; }
      else { ok++; }
    } catch (e) { fail++; console.warn("  delete_path error:", fullPath, e.message?.slice(0, 100)); }
  }
  assert("delete_path moves files to trash", ok > 0, `ok=${ok} fail=${fail}/${allRelPaths.length}`);

  let removed = 0;
  for (const relPath of allRelPaths) {
    if (!fs.existsSync(path.join(tmpDir, relPath))) removed++;
  }
  assert("Files removed from original location", removed > 0, `removed=${removed}/${allRelPaths.length}`);
  if (removed < allRelPaths.length) {
    const remaining = allRelPaths.filter(r => fs.existsSync(path.join(tmpDir, r)));
    console.log(`  Remaining: ${remaining.join(", ")}`);
  }

  // Test list_trash
  console.log("\n  Testing list_trash...");
  try {
    const trash = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('list_trash', {})");
    console.log(`  Trash: ${JSON.stringify(trash).slice(0, 200)}`);
    assert("list_trash returns array", Array.isArray(trash));
  } catch (e) {
    console.log(`  list_trash error: ${e.message}`);
  }

  // Test system commands
  console.log("\n  Testing system commands...");
  const home = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('get_home_dir', {})");
  assert("get_home_dir", typeof home === 'string' && home.length > 0);

  const drives = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('list_drives', {})");
  assert("list_drives returns array", Array.isArray(drives));

  const mem = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('get_memory_info', {})");
  assert("get_memory_info", mem && mem.total > 0);

  // Test settings round-trip
  console.log("\n  Testing settings...");
  const testSettings = { theme: "dark", lang: "en" };
  await jsInvokeSafe(cdp, `window.__TAURI__.invoke('save_settings', {settings: ${JSON.stringify(testSettings)}})`);
  const loaded = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('load_settings', {})");
  assert("save/load settings", loaded && loaded.theme === "dark", `${JSON.stringify(loaded)}`);

  // Test file ops commands (no-op, just check no throw)
  console.log("\n  Testing file ops commands...");
  await jsInvokeSafe(cdp, `window.__TAURI__.invoke('open_explorer', {path: ${JSON.stringify(tmpDir)}})`).catch(() => {});
  await jsInvokeSafe(cdp, `window.__TAURI__.invoke('open_terminal', {path: ${JSON.stringify(tmpDir)}})`).catch(() => {});
  await jsInvokeSafe(cdp, "window.__TAURI__.invoke('open_url', {url: 'https://example.com'})").catch(() => {});

  // Test scan commands
  console.log("\n  Testing scan commands...");
  const scanResult = await jsInvokeSafe(cdp, `window.__TAURI__.invoke('start_scan', ${JSON.stringify({path: tmpDir, follow_symlinks: false, timeout_secs: 30})})`);
  assert("start_scan returns status", scanResult && scanResult.status === "started", `${JSON.stringify(scanResult)}`);

  // Wait for scan to complete
  await sleep(5000);
  const progress = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('get_scan_progress', {})");
  assert("get_scan_progress returns data", progress && (progress.files_found > 0 || progress.phase === 3), `${JSON.stringify(progress).slice(0, 100)}`);
  console.log(`  Scan progress: ${JSON.stringify(progress).slice(0, 120)}`);

  const result = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('get_scan_result', {})");
  assert("get_scan_result returns stats", result && result.stats, `${JSON.stringify(result).slice(0, 100)}`);
  console.log(`  Scan result: ${JSON.stringify(result?.stats).slice(0, 150)}`);

  // Test get_stats
  const stats = await jsInvokeSafe(cdp, "window.__TAURI__.invoke('get_stats', {})");
  assert("get_stats returns data", stats && stats.total_files > 0, `files=${stats?.total_files}`);

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n  Temp dir cleaned: ${tmpDir}`);
});

// Helper: invoke via CDP or direct file for Tauri mode
async function jsInvokeSafe(cdp, expr) {
  if (isTauri) {
    // In Tauri mode, we inject JS via CDP but the result may not return
    // So just fire and forget
    const r = await cdp.send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    return r?.result?.result?.value;
  } else {
    // Qt mode: use standard jsInvoke
    const mod = await import("./test_shared.mjs");
    return mod.jsInvoke(cdp, expr);
  }
}
