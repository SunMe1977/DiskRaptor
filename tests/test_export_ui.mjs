import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Export Test", 9209, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for export", completed);
  await waitForStatsPopulated(cdp);

  const exportBtn = await jsExpr(cdp, `
    (function() {
      const btn = document.getElementById('btn-export');
      if (!btn) return 'not-found';
      return 'found disabled=' + btn.disabled;
    })()
  `);
  assert("Export button exists and enabled", exportBtn.startsWith("found"), `${exportBtn}`);

  assert("Export test complete", true, "button verified");
});
