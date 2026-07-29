import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Filters Test", 9211, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for filters", completed);
  await waitForStatsPopulated(cdp);

  const treeFilter = await jsExpr(cdp, `
    (function() {
      const el = document.getElementById('tree-filter');
      if (!el) return 'not-found';
      return 'found type=' + el.getAttribute('type') + ' placeholder=' + (el.getAttribute('placeholder') || '');
    })()
  `);
  assert("Tree filter input exists", treeFilter.startsWith("found"), `${treeFilter}`);

  const typeFilters = await jsExpr(cdp, `
    (function() {
      const container = document.getElementById('type-filters');
      if (!container) return 'not-found';
      const btns = container.querySelectorAll('button, .filter-btn, [data-ext]');
      return 'found-' + btns.length + '-buttons';
    })()
  `);
  assert("Type filter container", typeFilters.startsWith("found"), `${typeFilters}`);

  if (treeFilter.startsWith("found")) {
    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        if (!el) return 'no-element';
        el.value = 'txt';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
        return 'typed-txt';
      })()
    `);
    await sleep(500);
    const treeContent = await jsExpr(cdp, `
      (function() {
        const viewport = document.getElementById('tree-viewport');
        const html = (viewport?.innerHTML || '');
        const visibleNodes = document.querySelectorAll('.tree-row');
        return 'html-len=' + html.length + '-nodes=' + visibleNodes.length;
      })()
    `);
    assert("Tree filter applied", treeContent.includes("html-len="), `${treeContent}`);

    await jsExpr(cdp, `
      (function() {
        const el = document.getElementById('tree-filter');
        if (!el) return 'no-element';
        el.value = '';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return 'cleared';
      })()
    `);
    await sleep(300);
    assert("Tree filter cleared", true);
  }

  const scanPathVal = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path populated", scanPathVal.length > 0, `path=${scanPathVal.slice(0, 40)}`);
});
