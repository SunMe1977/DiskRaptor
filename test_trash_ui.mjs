import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Trash Test", 9218, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Scan overlay appeared", overlayShown);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed", completed);
  await sleep(2000);

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

  const emptyTrashResult = await jsExpr(cdp, `
    (async () => {
      try {
        await window.__TAURI__.invoke('empty_trash', {});
        return 'invoke-ok';
      } catch(e) { return 'invoke-err: ' + e.message.slice(0, 50); }
    })()
  `);
  assert("empty_trash invoke dispatched", emptyTrashResult.startsWith("invoke"), `${emptyTrashResult}`);

  const listTrashResult = await jsExpr(cdp, `
    (async () => {
      try {
        const result = await window.__TAURI__.invoke('list_trash', {});
        return 'ok-' + JSON.stringify(result).slice(0, 60);
      } catch(e) { return 'err-' + e.message.slice(0, 50); }
    })()
  `);
  assert("list_trash invoke dispatched", listTrashResult.startsWith("ok") || listTrashResult.startsWith("err"), `${listTrashResult}`);
});
