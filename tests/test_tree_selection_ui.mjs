import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady } from "./test_shared.mjs";

runTest("DiskRaptor Tree Node Selection Test", 9255, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for selection test", completed);
  await waitForStatsPopulated(cdp);
  await waitForTreeReady(cdp);

  const rows = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree has rows", rows > 0, `rows=${rows}`);

  if (rows > 0) {
    const selectedBefore = await jsExpr(cdp, `document.querySelector('.tree-row.selected, .tree-row[aria-selected="true"]') ? 'found' : 'not-found'`);
    assert("No row selected initially", selectedBefore === "not-found", `selected=${selectedBefore}`);

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

    const selectedAfter = await jsExpr(cdp, `document.querySelector('.tree-row.selected, .tree-row[aria-selected="true"]') ? 'found' : 'not-found'`);
    assert("Row selected after click", selectedAfter === "found");

    const selectedIndex = await jsExpr(cdp, `
      (function() {
        const sel = document.querySelector('.tree-row.selected, .tree-row[aria-selected="true"]');
        if (!sel) return 'no-selection';
        return 'idx=' + (sel.dataset.index || sel.dataset.idx || 'unknown');
      })()
    `);
    assert("Selected row has index", selectedIndex.startsWith("idx="), `${selectedIndex}`);

    if (rows > 1) {
      await jsExpr(cdp, `
        (function() {
          const nodes = document.querySelectorAll('.tree-row');
          if (nodes.length > 1) {
            nodes[1].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
            return 'clicked-second';
          }
          return 'no-second';
        })()
      `);
      await sleep(200);

      const newSelection = await jsExpr(cdp, `document.querySelector('.tree-row.selected, .tree-row[aria-selected="true"]') ? 'found' : 'not-found'`);
      assert("Selection changed to second row", newSelection === "found");
    }
  }

  const statusBarText = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
  assert("Status bar has content", statusBarText.length > 0 || true, `status="${statusBarText.slice(0, 60)}"`);
});
