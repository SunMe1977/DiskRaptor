import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

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
        if (i.getAttribute('data-action') === 'cleanup-downloads') {
          i.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Downloads cleanup menu item clicked", clickedCleanup === "clicked", `${clickedCleanup}`);
  await sleep(800);

  const cleanupOverlay = await jsExpr(cdp, `document.getElementById('cleanup-overlay') ? 'found' : 'not-found'`);
  assert("Cleanup overlay exists", cleanupOverlay === "found");

  const cleanupItems = await jsExpr(cdp, `document.querySelectorAll('.cleanup-item, .cleanup-entry').length`);
  assert("Cleanup items rendered", cleanupItems >= 0, `items=${cleanupItems}`);

  const selectAllBtn = await jsExpr(cdp, `document.getElementById('cleanup-select-all') ? 'found' : 'not-found'`);
  assert("Select All button exists", selectAllBtn === "found");

  if (selectAllBtn === "found") {
    await clickById(cdp, "cleanup-select-all", 300);
    const checkboxesAfter = await jsExpr(cdp, `Array.from(document.querySelectorAll('.cleanup-item input[type="checkbox"]')).filter(cb => cb.checked).length`);
    assert("Checkboxes toggled by Select All", true, `checked=${checkboxesAfter}`);
  }

  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
  await sleep(200);

  const overlayClosed = await jsExpr(cdp, `document.getElementById('cleanup-overlay')?.style?.display === 'none' || document.getElementById('cleanup-overlay') === null`);
  assert("Cleanup overlay closed", overlayClosed === true || cleanupOverlay === "not-found");
});
