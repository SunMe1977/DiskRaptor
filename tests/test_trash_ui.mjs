import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Trash Test", 9218, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Scan overlay appeared", overlayShown);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 500);

  const trashMenuItem = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        const text = (item.textContent || '').trim();
        if (action === 'trash' || text.includes('Trash') || text.includes('Empty')) {
          return 'found-action=' + action + '-text=' + text.slice(0, 30);
        }
      }
      return 'not-found';
    })()
  `);
  assert("Empty Trash menu item exists", trashMenuItem.startsWith("found"), `${trashMenuItem}`);

  const trashClickResult = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const item of items) {
        const action = item.getAttribute('data-action');
        const text = (item.textContent || '').trim();
        if (action === 'trash' || text.includes('Trash')) {
          item.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked-trash';
        }
      }
      return 'not-clicked';
    })()
  `);
  assert("Trash menu item clicked", trashClickResult === "clicked-trash", `${trashClickResult}`);
  await sleep(500);

  const emptyTrashResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('empty_trash', {})"
  ).catch(() => 'error');
  assert("empty_trash invoke completes", emptyTrashResult !== 'error', `${typeof emptyTrashResult}`);

  const listTrashResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('list_trash', {})"
  ).catch(() => 'error');
  assert("list_trash invoke completes", listTrashResult !== 'error', `${typeof listTrashResult}`);
});
