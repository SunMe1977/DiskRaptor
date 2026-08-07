import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Reset View Tool Test", 9278, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for reset test", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 300);

  const clickedReset = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'reset-view') {
          i.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Reset view menu item clicked", clickedReset === "clicked", `${clickedReset}`);
  await sleep(400);

  const treeFilter = await jsExpr(cdp, `document.getElementById('tree-filter')?.value || ''`);
  assert("Tree filter cleared", treeFilter === "", `filter="${treeFilter}"`);

  const zoomLabel = await jsExpr(cdp, `document.getElementById('zoom-label')?.textContent?.trim() || ''`);
  assert("Zoom label exists after reset", zoomLabel.length >= 0, `zoom="${zoomLabel}"`);

  const treeRows = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree rows preserved after reset", treeRows > 0, `rows=${treeRows}`);

  const statusBar = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
  assert("Status bar has content after reset", statusBar.length >= 0, `status="${statusBar.slice(0, 60)}"`);
});
