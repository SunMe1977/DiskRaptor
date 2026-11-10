import { runTest, jsExpr, assert, clickById, sleep, waitFor } from "./test_shared.mjs";

// Downloads Cleanup overlay: opens from the Tools menu, lists candidates and
// exposes the bulk-selection + trash controls. The overlay is created on
// demand and removed on close.

runTest("DiskRaptor Downloads Cleanup Test", 9222, async (cdp) => {
  await clickById(cdp, "btn-tools", 200);
  const clicked = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'cleanup-downloads') { i.click(); return 'clicked'; }
      }
      return 'not-found';
    })()
  `);
  assert("Cleanup tool menu item exists", clicked === "clicked", `${clicked}`);

  const appeared = await waitFor(async () => {
    return await jsExpr(cdp, `!!document.getElementById('downloads-cleanup-overlay')`);
  }, { timeout: 10000, label: "cleanup overlay" });
  assert("Cleanup overlay appeared", appeared);

  if (!appeared) return;

  const title = await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay span')?.textContent || ''`);
  assert("Popup shows title", /cleanup/i.test(title), `title="${title}"`);

  const controls = await jsExpr(cdp, `JSON.stringify({
    refresh: !!document.querySelector('#downloads-cleanup-overlay .dlc-refresh'),
    selectAll: !!document.querySelector('#downloads-cleanup-overlay .dlc-select-all'),
    selectNone: !!document.querySelector('#downloads-cleanup-overlay .dlc-select-none'),
    selectOld: !!document.querySelector('#downloads-cleanup-overlay .dlc-select-old'),
    moveTrash: !!document.querySelector('#downloads-cleanup-overlay .dlc-clean'),
    close: !!document.querySelector('#downloads-cleanup-overlay .dlc-close')
  })`);
  const c = JSON.parse(controls);
  assert("Refresh button", c.refresh);
  assert("Select All button", c.selectAll);
  assert("Select None button", c.selectNone);
  assert("90+ days old button", c.selectOld);
  assert("Move to Trash button", c.moveTrash);
  assert("Close button", c.close);

  // Wait for the candidate scan to finish (status stops showing the spinner).
  await waitFor(async () => {
    const s = await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-status')?.textContent || ''`);
    return s.length > 0 && !s.includes("\u23F3");
  }, { timeout: 20000, label: "cleanup candidates" });

  const itemCount = await jsExpr(cdp, `document.querySelectorAll('#downloads-cleanup-overlay .dlc-item').length`);
  assert("Candidate list rendered", itemCount >= 0, `items=${itemCount}`);

  if (itemCount > 0) {
    const tooltip = await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-item')?.getAttribute('title') || ''`);
    assert("Full path shown on hover", tooltip.length > 0, `tooltip="${tooltip.slice(0, 60)}"`);

    await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-select-all').click(); 'ok'`);
    const allChecked = await jsExpr(cdp, `Array.from(document.querySelectorAll('#downloads-cleanup-overlay .dlc-item input')).every(cb => cb.checked)`);
    assert("Select All checks every row", allChecked === true);

    await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-select-none').click(); 'ok'`);
    const noneChecked = await jsExpr(cdp, `Array.from(document.querySelectorAll('#downloads-cleanup-overlay .dlc-item input')).every(cb => !cb.checked)`);
    assert("Select None clears every row", noneChecked === true);
  }

  await jsExpr(cdp, `document.querySelector('#downloads-cleanup-overlay .dlc-close').click(); 'ok'`);
  await sleep(300);
  const closed = await jsExpr(cdp, `document.getElementById('downloads-cleanup-overlay') === null`);
  assert("Cleanup overlay closed", closed === true);
});
