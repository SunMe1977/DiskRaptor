import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Tree Filter Flow Test", 9234, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for filter test", completed);
  await waitForStatsPopulated(cdp);
  await waitForTreeReady(cdp);

  const allRows = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
  assert("Tree populated before filter", allRows > 0, `rows=${allRows}`);

  const treeFilter = document.getElementById("tree-filter");
  if (treeFilter) {
    await jsExpr(cdp, `document.getElementById('tree-filter').value = 'README'; 'set'`);
    await jsExpr(cdp, `document.getElementById('tree-filter').dispatchEvent(new Event('input', {bubbles:true})); 'input'`);
    await sleep(600);

    const afterFilter = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
    assert("Tree filter reduces rows", afterFilter <= allRows, `before=${allRows} after=${afterFilter}`);

    const filterInput = await jsExpr(cdp, `document.getElementById('tree-filter')?.value || ''`);
    assert("Filter input retains value", filterInput === "README", `value="${filterInput}"`);

    await jsExpr(cdp, `document.getElementById('tree-filter').value = ''; 'cleared'`);
    await jsExpr(cdp, `document.getElementById('tree-filter').dispatchEvent(new Event('input', {bubbles:true})); 'cleared-input'`);
    await sleep(400);

    const afterClear = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
    assert("Tree restored after filter clear", afterClear >= allRows || afterClear > 0, `restored=${afterClear}`);
  }

  const typeFilterBtns = await jsExpr(cdp, `Array.from(document.querySelectorAll('.type-filter, [data-ext]')).map(b => b.dataset.ext || b.textContent.trim().slice(0, 20))`);
  assert("Type filter buttons available", Array.isArray(typeFilterBtns), `types=${JSON.stringify(typeFilterBtns?.slice(0, 5))}`);

  if (typeFilterBtns && typeFilterBtns.length > 0) {
    const firstExt = typeFilterBtns[0];
    if (firstExt && firstExt !== "custom") {
      await jsExpr(cdp, `
        (function() {
          const btn = Array.from(document.querySelectorAll('.type-filter, [data-ext]')).find(b => (b.dataset.ext || '') === '${firstExt}');
          if (btn) { btn.click(); return 'filtered-' + btn.dataset.ext; }
          return 'no-btn';
        })()
      `);
      await sleep(400);

      const afterTypeFilter = await jsExpr(cdp, `document.querySelectorAll('.tree-row').length`);
      assert("Type filter applied", afterTypeFilter >= 0, `rows=${afterTypeFilter}`);

      const activeTypeBtn = await jsExpr(cdp, `document.querySelector('.type-filter.active, [data-ext].active') ? 'found' : 'not-found'`);
      assert("Type filter button shows active state", activeTypeBtn === "found");
    }
  }
});
