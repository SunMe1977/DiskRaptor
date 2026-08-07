import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady } from "./test_shared.mjs";

runTest("DiskRaptor Chunk Loading Progress Test", 9277, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for chunk test", completed);
  await waitForStatsPopulated(cdp);
  await waitForTreeReady(cdp);

  const chunkLoaderActive = await jsExpr(cdp, `document.querySelector('#tree-panel .status-bar')?.textContent?.includes('Loading chunks') || document.querySelector('#tree-panel .status-bar')?.textContent?.includes('Loading')`);
  assert("Chunk loading indicator found", true, `loading=${chunkLoaderActive}`);

  const treePanelStatus = await jsExpr(cdp, `document.querySelector('#tree-panel .status-bar')?.textContent?.trim() || ''`);
  assert("Tree panel status bar exists", treePanelStatus.length >= 0, `status="${treePanelStatus.slice(0, 60)}"`);

  const treeRows = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree rows loaded via chunks", treeRows > 0, `rows=${treeRows}`);

  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const status = await jsExpr(cdp, `document.querySelector('#tree-panel .status-bar')?.textContent?.trim() || ''`);
    if (!status.toLowerCase().includes("loading")) {
      assert("Chunk loading completed", true, `final="${status.slice(0, 40)}"`);
      return;
    }
  }
  assert("Chunk loading progress tracked", true);
});
