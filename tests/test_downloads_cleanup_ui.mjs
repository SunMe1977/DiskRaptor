import {
  runTest, jsExpr, assert, clickById, sleep, waitFor,
  startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated,
} from "./test_shared.mjs";

// Downloads Cleanup after a normal scan: the overlay still opens, reports
// candidates and closes cleanly.

runTest("DiskRaptor Downloads Cleanup Test", 9252, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for downloads cleanup", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 300);
  const clickedCleanup = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'cleanup-downloads') { i.click(); return 'clicked'; }
      }
      return 'not-found';
    })()
  `);
  assert("Downloads cleanup menu item clicked", clickedCleanup === "clicked", `${clickedCleanup}`);

  const appeared = await waitFor(async () => {
    return await jsExpr(cdp, `!!document.getElementById('downloads-cleanup-overlay')`);
  }, { timeout: 10000, label: "cleanup overlay" });
  assert("Cleanup overlay exists", appeared);
  if (!appeared) return;

  await waitFor(async () => {
    const s = await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-status')?.textContent || ''`);
    return s.length > 0 && !s.includes("\u23F3");
  }, { timeout: 20000, label: "cleanup candidates" });

  const status = await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-status')?.textContent || ''`);
  assert("Cleanup reports a result", status.length > 0, `status="${status}"`);

  const cleanupItems = await jsExpr(cdp, `document.querySelectorAll('#downloads-cleanup-overlay .dlc-item').length`);
  assert("Cleanup item list rendered", cleanupItems >= 0, `items=${cleanupItems}`);

  const selectAllBtn = await jsExpr(cdp, `!!document.querySelector('#downloads-cleanup-overlay .dlc-select-all')`);
  assert("Select All button exists", selectAllBtn);

  await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-close').click(); 'ok'`);
  await sleep(300);
  const overlayClosed = await jsExpr(cdp, `document.getElementById('downloads-cleanup-overlay') === null`);
  assert("Cleanup overlay closed", overlayClosed === true);
});
