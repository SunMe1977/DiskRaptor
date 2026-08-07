import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady } from "./test_shared.mjs";

runTest("DiskRaptor Context Menu Actions Test", 9268, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for context menu", completed);
  await waitForStatsPopulated(cdp);
  const treeReady = await waitForTreeReady(cdp);

  const hasTreeNode = treeReady ? 'found' : await jsExpr(cdp, `document.querySelector('.tree-row') ? 'found' : 'not-found'`);
  assert("Tree node exists", hasTreeNode === "found");

  if (hasTreeNode === "found") {
    await jsExpr(cdp, `
      (function() {
        const el = document.querySelector('.tree-row');
        if (!el) return 'no-element';
        el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX: 100, clientY: 100}));
        return 'dispatched';
      })()
    `);
    await sleep(500);

    const menuVisible = await jsExpr(cdp, `document.getElementById('tree-context-menu')?.style?.display !== 'none'`);
    assert("Context menu visible", menuVisible === true);

    const actions = await jsExpr(cdp, `Array.from(document.querySelectorAll('#tree-context-menu .tctx-item, #tree-context-menu [data-action]')).map(el => el.dataset.action || el.textContent.trim().slice(0, 25))`);
    assert("Context menu has actions", Array.isArray(actions) && actions.length >= 3, `actions=${JSON.stringify(actions?.slice(0, 8))}`);

    const expectedActions = ["explorer", "terminal", "scan-here", "properties", "copy", "copy-size", "delete"];
    const foundActions = actions.filter(a => expectedActions.includes(a));
    assert("Context menu has expected actions", foundActions.length >= 3, `found=${JSON.stringify(foundActions)}`);

    const copyPathAction = actions.find(a => a === "copy" || typeof a === "string" && a.includes("Copy"));
    assert("Copy path action present", copyPathAction !== undefined || foundActions.includes("copy"));

    const deleteAction = actions.find(a => a === "delete" || typeof a === "string" && a.includes("Trash") || typeof a === "string" && a.includes("Delete"));
    assert("Delete action present", deleteAction !== undefined || foundActions.includes("delete"));

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);

    const menuHidden = await jsExpr(cdp, `document.getElementById('tree-context-menu')?.style?.display === 'none' || document.getElementById('tree-context-menu') === null`);
    assert("Context menu hidden after Escape", menuHidden === true);
  }
});
