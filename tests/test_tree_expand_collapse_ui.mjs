import { runTest, jsExpr, assert, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady } from "./test_shared.mjs";

runTest("DiskRaptor Tree Expand Collapse Stability Test", 9258, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for expand/collapse test", completed);
  await waitForStatsPopulated(cdp);
  await waitForTreeReady(cdp);

  const rowsBefore = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree populated initially", rowsBefore > 0, `rows=${rowsBefore}`);

  const dirNodes = await jsExpr(cdp, `
    (function() {
      const nodes = document.querySelectorAll('.tree-row');
      const dirs = [];
      for (const n of nodes) {
        const toggleText = (n.querySelector('.toggle')?.textContent || '').trim();
        if (toggleText === '\\u25B6') dirs.push(n.dataset.index || n.dataset.idx);
      }
      return dirs.slice(0, 5).join(',');
    })()
  `);
  assert("Tree has collapsible directory nodes", dirNodes.length > 0, `dirs=${dirNodes}`);

  if (dirNodes) {
    const firstDirIdx = dirNodes.split(",")[0];
    await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        for (const n of nodes) {
          const idx = n.dataset.index || n.dataset.idx;
          if (idx === '${firstDirIdx}') {
            const toggle = n.querySelector('.toggle');
            if (toggle) { toggle.click(); return 'toggled'; }
            n.click();
            return 'clicked';
          }
        }
        return 'no-node';
      })()
    `);
    await sleep(500);

    const rowsAfterExpand = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
    assert("Tree rows change after toggling", rowsAfterExpand !== rowsBefore, `before=${rowsBefore} after=${rowsAfterExpand}`);

    await jsExpr(cdp, `
      (function() {
        const nodes = document.querySelectorAll('.tree-row');
        for (const n of nodes) {
          const idx = n.dataset.index || n.dataset.idx;
          if (idx === '${firstDirIdx}') {
            const toggle = n.querySelector('.toggle');
            if (toggle) { toggle.click(); return 'toggled-back'; }
            n.click();
            return 'clicked-back';
          }
        }
        return 'no-node';
      })()
    `);
    await sleep(400);

    const rowsAfterCollapse = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
    assert("Tree rows restored after toggling back", rowsAfterCollapse === rowsBefore, `before=${rowsBefore} afterCollapse=${rowsAfterCollapse}`);
  }

  const treeRowsFinal = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree still has rows after expand/collapse cycle", treeRowsFinal > 0, `rows=${treeRowsFinal}`);
});
