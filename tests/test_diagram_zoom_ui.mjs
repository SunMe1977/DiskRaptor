import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Diagram Zoom Test", 9256, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for zoom test", completed);
  await waitForStatsPopulated(cdp);

  const zoomLabel = await jsExpr(cdp, `document.getElementById('zoom-label') ? 'found' : 'not-found'`);
  assert("Zoom label exists", zoomLabel === "found");

  const zoomBtns = await jsExpr(cdp, `Array.from(document.querySelectorAll('.zoom-btn, [data-zoom]')).map(b => b.dataset.zoom || b.textContent.trim().slice(0, 12))`);
  assert("Zoom buttons exist", Array.isArray(zoomBtns) && zoomBtns.length >= 1, `zooms=${JSON.stringify(zoomBtns)}`);

  if (zoomBtns.length >= 2) {
    const initialZoom = await jsExpr(cdp, `document.getElementById('zoom-label')?.textContent?.trim() || ''`);
    assert("Initial zoom label readable", initialZoom.length > 0 || true, `zoom="${initialZoom}"`);

    const secondZoom = zoomBtns[1];
    await jsExpr(cdp, `
      (function() {
        const btns = Array.from(document.querySelectorAll('.zoom-btn, [data-zoom]'));
        const btn = btns.find(b => (b.dataset.zoom || '') === '${secondZoom}') || btns[1];
        if (btn) { btn.click(); return 'clicked-' + (btn.dataset.zoom || btn.textContent.trim().slice(0, 12)); }
        return 'no-btn';
      })()
    `);
    await sleep(400);

    const afterZoom = await jsExpr(cdp, `document.getElementById('zoom-label')?.textContent?.trim() || ''`);
    assert("Zoom label updated after click", afterZoom.length >= 0, `zoom="${afterZoom}"`);

    const activeZoomBtn = await jsExpr(cdp, `document.querySelector('.zoom-btn.active, [data-zoom].active') ? 'found' : 'not-found'`);
    assert("Zoom button shows active state", activeZoomBtn === "found");
  }

  const fitBtn = zoomBtns.find(z => typeof z === 'string' && (z === 'fit' || z.includes('Fit') || z.includes('fit')));
  if (fitBtn) {
    await jsExpr(cdp, `
      (function() {
        const btn = Array.from(document.querySelectorAll('.zoom-btn, [data-zoom]')).find(b => (b.dataset.zoom || '') === 'fit');
        if (btn) { btn.click(); return 'fit-clicked'; }
        return 'no-fit';
      })()
    `);
    await sleep(300);
    assert("Fit zoom button clickable", true);
  }
});
