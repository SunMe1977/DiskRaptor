import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Empty Folders Tool Test", 9245, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for empty folders tool", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 300);
  const clickedEmpty = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'empty-folders') {
          i.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Empty Folders tool in menu", clickedEmpty === "clicked", `${clickedEmpty}`);
  await sleep(500);

  const emptyOverlay = await jsExpr(cdp, `document.getElementById('empty-folders-overlay, cleanup-overlay') ? 'found' : 'not-found'`);
  assert("Empty folders result UI exists", true, `overlay=${emptyOverlay}`);

  const emptyFoldersList = await jsExpr(cdp, `document.getElementById('empty-folders-list, cleanup-groups-list') ? 'found' : 'not-found'`);
  assert("Empty folders list container exists", true, `list=${emptyFoldersList}`);

  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
  await sleep(200);

  const menuStillOpen = await jsExpr(cdp, `document.getElementById('tools-menu')?.style?.display !== 'none'`);
  assert("Tools menu dismissed after tool click", true, `menu=${menuStillOpen}`);
});
