import { runTest, jsExpr, assert, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady } from "./test_shared.mjs";

runTest("DiskRaptor Scan Test", 9200, async (cdp, scanPath) => {
  const homeDir = await jsExpr(cdp, `typeof window.__TAURI__ !== 'undefined' ? 'bridge-ok' : 'bridge-missing'`);
  assert("Bridge present on window", homeDir === 'bridge-ok', `${homeDir}`);

  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Progress overlay appears", overlayShown);

  const { completed, maxFiles } = await waitForScanComplete(cdp);
  assert("Scan completes", completed, `files=${maxFiles}`);

  const statsReady = await waitForStatsPopulated(cdp);
  assert("Stats panel populated", statsReady);

  const treeReady = await waitForTreeReady(cdp);
  const treeRows = await jsExpr(cdp, `document.querySelectorAll('.tree-row')?.length || 0`);
  assert("Tree has content", treeReady, `rows=${treeRows}`);
});
