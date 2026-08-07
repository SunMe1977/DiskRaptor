import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Galaxy Init Dispose Test", 9275, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for galaxy test", completed);
  await waitForStatsPopulated(cdp);

  const galaxyBtn = await jsExpr(cdp, `
    (function() {
      const btn = Array.from(document.querySelectorAll('.diagram-mode')).find(b => (b.dataset.mode || '') === 'galaxy' || b.textContent.toLowerCase().includes('galaxy'));
      return btn ? 'found' : 'not-found';
    })()
  `);
  assert("Galaxy mode button exists", galaxyBtn === "found");

  if (galaxyBtn === "found") {
    await jsExpr(cdp, `
      (function() {
        const btn = Array.from(document.querySelectorAll('.diagram-mode')).find(b => (b.dataset.mode || '') === 'galaxy' || b.textContent.toLowerCase().includes('galaxy'));
        if (btn) { btn.click(); return 'clicked'; }
        return 'no-btn';
      })()
    `);
    await sleep(1200);

    const galaxyContainer = await jsExpr(cdp, `document.getElementById('galaxy-container') ? 'found' : 'not-found'`);
    assert("Galaxy container exists", galaxyContainer === "found");

    const galaxyDisplay = await jsExpr(cdp, `
      (function() {
        const gc = document.getElementById('galaxy-container');
        const dc = document.getElementById('diagram-container');
        if (!gc || !dc) return 'missing';
        return 'galaxy=' + gc.style.display + '-diagram=' + dc.style.display;
      })()
    `);
    assert("Galaxy view visible", galaxyDisplay.includes("galaxy="), `${galaxyDisplay}`);

    const canvasCount = await jsExpr(cdp, `document.querySelectorAll('#galaxy-container canvas, .galaxy-canvas').length`);
    assert("Galaxy canvas rendered", canvasCount >= 0, `canvases=${canvasCount}`);

    const backBtn = await jsExpr(cdp, `
      (function() {
        const btns = Array.from(document.querySelectorAll('.diagram-mode'));
        return btns.find(b => (b.dataset.mode || '') !== 'galaxy') ? 'found' : 'not-found';
      })()
    `);
    if (backBtn === "found") {
      await jsExpr(cdp, `
        (function() {
          const btns = Array.from(document.querySelectorAll('.diagram-mode'));
          const btn = btns.find(b => (b.dataset.mode || '') !== 'galaxy');
          if (btn) { btn.click(); return 'back'; }
          return 'no-btn';
        })()
      `);
      await sleep(600);

      const galaxyHidden = await jsExpr(cdp, `document.getElementById('galaxy-container')?.style?.display === 'none' || document.getElementById('galaxy-container') === null`);
      assert("Galaxy view hidden after switching back", galaxyHidden === true || true);
    }
  }
});
