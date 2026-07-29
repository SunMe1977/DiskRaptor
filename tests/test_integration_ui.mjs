import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Integration Test", 9221, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Progress overlay appears", overlayShown);

  const { completed, maxFiles } = await waitForScanComplete(cdp);
  assert("Scan completes", completed, `files=${maxFiles}`);

  const statsReady = await waitForStatsPopulated(cdp);
  assert("Stats panel data", statsReady);

  const treeReady = await waitForTreeReady(cdp);
  assert("Tree has nodes", treeReady);

  const topFiles = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert("Top files has rows", topFiles > 0, `rows=${topFiles}`);

  const diagramModes = await jsExpr(cdp, `Array.from(document.querySelectorAll('.diagram-mode')).length`);
  assert("Diagram modes available", diagramModes >= 3, `count=${diagramModes}`);

  await clickById(cdp, "btn-tools", 300);
  const toolsItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('.tools-item')).map(i => i.getAttribute('data-action') || i.textContent.trim())`);
  assert("Tools menu has items", toolsItems.length >= 5, `count=${toolsItems.length}`);

  const homeDir = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_home_dir')"
  ).catch(() => 'error');
  assert("get_home_dir invoke completes", homeDir !== 'error', `${typeof homeDir}`);

  const aboutResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_app_info', {})"
  ).catch(() => 'error');
  assert("App info invoke completes", aboutResult !== 'error', `${typeof aboutResult}`);
});
