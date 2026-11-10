import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete,
  waitForStatsPopulated, waitForTreeReady, sleep,
} from "./test_shared.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dr-fileops-"));
const pngPath = path.join(tmpDir, "pixel.png");
// 1x1 transparent PNG.
fs.writeFileSync(
  pngPath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

runTest("DiskRaptor File Operations Test", 9215, async (cdp, scanPath) => {
  try {
    await startScan(cdp, scanPath);
    await waitForOverlay(cdp);
    const { completed } = await waitForScanComplete(cdp);
    assert("Scan completed for file ops", completed);
    await waitForStatsPopulated(cdp);
    const treeReady = await waitForTreeReady(cdp);

    const hasTreeNode = treeReady ? 'found' : await jsExpr(cdp, `document.querySelector('.tree-row') ? 'found' : 'not-found'`);
    if (hasTreeNode === "found") {
      await jsExpr(cdp, `document.querySelector('.tree-row').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
      await sleep(500);

      await jsExpr(cdp, `
        (function() {
          const el = document.querySelector('.tree-row');
          if (!el) return 'no-element';
          el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX: 100, clientY: 100}));
          return 'dispatched';
        })()
      `);
      await sleep(500);

      const ctxMenu = await jsExpr(cdp, `document.getElementById('tree-context-menu') ? 'found' : 'not-found'`);
      assert("Context menu DOM element exists", ctxMenu === "found");

      const ctxVisible = await jsExpr(cdp, `
        (function() {
          const menu = document.getElementById('tree-context-menu');
          if (!menu) return 'no-menu';
          return 'display=' + menu.style.display;
        })()
      `);
      assert("Context menu opened", ctxVisible.includes("block") || ctxVisible.includes("flex") || ctxVisible.includes("visible"), `${ctxVisible}`);

      await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
      await sleep(200);
    } else {
      assert("Tree node for context menu", false, "no tree rows found");
    }

    // Real file-operation commands (the old copy_path/get_properties names
    // never existed in the Tauri command registry).
    const icon = await jsInvoke(cdp,
      `window.__TAURI__.invoke('get_icon', { path: 'txt', isDir: false })`
    ).catch((e) => "error:" + e.message);
    assert("get_icon invoke completes", typeof icon !== "string" || !icon.startsWith("error:"), `${typeof icon}`);

    const preview = await jsInvoke(cdp,
      `window.__TAURI__.invoke('get_file_preview', ${JSON.stringify({ path: pngPath })})`
    ).catch((e) => "error:" + e.message);
    assert("get_file_preview returns image data",
      preview && preview.mime === "image/png" && typeof preview.base64 === "string" && preview.base64.length > 0,
      JSON.stringify(preview).slice(0, 120));
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
