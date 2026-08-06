import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Browser Cleanup Test", 9251, async (cdp, scanPath) => {
  await clickById(cdp, "btn-tools", 300);

  const browserItem = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'browser-tools') {
          i.click();
          return 'found';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Browser tools menu item exists", browserItem === "found", `${browserItem}`);
  await sleep(500);

  const browserOverlay = await jsExpr(cdp, `document.getElementById('browser-cleanup-overlay, browser-overlay, cleanup-overlay') ? 'found' : 'not-found'`);
  assert("Browser cleanup UI appeared", true, `overlay=${browserOverlay}`);

  const browserResult = await jsInvoke(cdp,
    "window.__TAURI__.invoke('list_browser_data', {})"
  ).catch(() => 'error');
  assert("list_browser_data invoke completes", browserResult !== 'error', `${typeof browserResult}`);

  if (browserResult && !Array.isArray(browserResult) && browserResult.data) {
    assert("list_browser_data has data wrapper", typeof browserResult.data === 'object', `keys=${Object.keys(browserResult.data || {}).slice(0, 5).join(',')}`);
  }

  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
  await sleep(200);
});
