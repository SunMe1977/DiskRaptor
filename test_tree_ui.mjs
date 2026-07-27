import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Tree View Test", 9203, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed", completed);
  await sleep(3000);

  const treeViewport = await jsExpr(cdp, `document.getElementById('tree-viewport') ? 'found' : 'not-found'`);
  assert("Tree viewport exists", treeViewport === "found");

  const treeScroll = await jsExpr(cdp, `document.getElementById('tree-scroll') ? 'found' : 'not-found'`);
  assert("Tree scroll container", treeScroll === "found");

  const treeHtml = await jsExpr(cdp, `document.getElementById('tree-scroll')?.innerHTML?.length || 0`);
  const treeRowCount = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert(`Tree has content`, treeHtml > 100 || treeRowCount > 0, `html=${treeHtml} rows=${treeRowCount}`);

  const treeHeader = await jsExpr(cdp, `document.getElementById('tree-header') ? 'found' : 'not-found'`);
  assert("Tree header exists", treeHeader === "found");

  const treeFilter = await jsExpr(cdp, `document.getElementById('tree-filter') ? 'found' : 'not-found'`);
  assert("Tree filter input exists", treeFilter === "found");

  if (treeRowCount > 0) {
    await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        if (nodes.length > 0) {
          nodes[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
          return 'clicked-first';
        }
        return 'no-nodes';
      })()
    `);
    await sleep(300);

    await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        if (nodes.length > 0) {
          nodes[0].dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2}));
          return 'right-clicked';
        }
        return 'no-nodes';
      })()
    `);
    await sleep(300);
    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  }
});
