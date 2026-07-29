import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitForTreeReady, sleep } from "./test_shared.mjs";

runTest("DiskRaptor File Operations Test", 9215, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for file ops", completed);
  await waitForStatsPopulated(cdp);
  const treeReady = await waitForTreeReady(cdp);

  const hasTreeNode = treeReady ? 'found' : await jsExpr(cdp, `document.querySelector('.tree-row') ? 'found' : 'not-found'`);
  if (hasTreeNode === "found") {
    await jsExpr(cdp, `document.querySelector('.tree-row').dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'clicked'`);
    await sleep(500);

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
    assert("Context menu opened", ctxVisible.includes("block") || ctxVisible.includes("flex") || ctxVisible.includes("visible"), `${ctxVisible}`);

    await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
    await sleep(200);
  } else {
    assert("Tree node for context menu", false, "no tree rows found");
  }

  const copyInvoke = await jsInvoke(cdp,
    "window.__TAURI__.invoke('copy_path', { from: '/tmp/src.txt', to: '/tmp/dst.txt' })"
  ).catch(() => 'error');
  assert("copy_path invoke completes", copyInvoke !== 'error', `${typeof copyInvoke}`);

  const propsInvoke = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_properties', { path: '/' })"
  ).catch(() => 'error');
  assert("get_properties invoke completes", propsInvoke !== 'error', `${typeof propsInvoke}`);
});
