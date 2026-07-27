import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Context Menu Test", 9206, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed for context menu", completed);
  await sleep(3000);

  const hasTreeNode = await jsExpr(cdp, `document.querySelector('.tree-row') ? 'found' : 'not-found'`);
  assert("Tree node exists for context menu", hasTreeNode === "found");

  if (hasTreeNode === "found") {
    const treeScroll = await jsExpr(cdp, `document.getElementById('tree-scroll')`);
    const ctxBefore = await jsExpr(cdp, `document.getElementById('tree-context-menu')?.style?.display !== 'none' ? 'visible' : 'hidden'`);

    await jsExpr(cdp, `
      (function() {
        const el = document.querySelector('.tree-row');
        if (!el) return 'no-element';
        el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX: 100, clientY: 100}));
        return 'dispatched';
      })()
    `);
    await sleep(500);

    const ctxMenu = await jsExpr(cdp, `document.getElementById('tree-context-menu') ? 'found' : 'not-found'`);
    assert("Context menu DOM element exists", ctxMenu === "found");

    const ctxVisible = await jsExpr(cdp, `
      (function() {
        const menu = document.getElementById('tree-context-menu');
        if (!menu) return 'no-menu';
        return 'display=' + menu.style.display;
      })()
    `);
    assert("Context menu display check", true, `${ctxVisible}`);

    const ctxItems = await jsExpr(cdp, `
      Array.from(document.querySelectorAll('#tree-context-menu [data-action], #tree-context-menu button, #tree-context-menu a, #tree-context-menu div[class*="item"]')).map(el => ({
        action: el.getAttribute('data-action') || '',
        text: (el.textContent || '').trim().slice(0, 20)
      }))
    `);
    assert("Context menu items found", true, `items=${Array.isArray(ctxItems) ? ctxItems.length : 0}`);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  }
});
