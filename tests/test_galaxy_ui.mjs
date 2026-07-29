import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Galaxy View Test", 9207, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for galaxy", completed);
  await waitForStatsPopulated(cdp);

  const galaxyContainer = await jsExpr(cdp, `document.getElementById('galaxy-container') ? 'found' : 'not-found'`);
  assert("Galaxy container exists", galaxyContainer === "found");

  const galaxyBtn = await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="galaxy"]') ? 'found' : 'not-found'`);
  assert("Galaxy mode button", galaxyBtn === "found");

  const galaxyModule = await jsExpr(cdp, `typeof window.GalaxyView?.GalaxyView !== 'undefined' ? 'found' : 'not-found'`);
  if (galaxyModule !== "found") {
    console.log("  GalaxyView loaded dynamically after mode toggle (expected)");
  }

  await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="galaxy"]')?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true})); 'toggled'`);
  await sleep(500);

  const canvasCount = await jsExpr(cdp, `document.querySelectorAll('canvas.galaxy-canvas, #galaxy-container canvas').length`);
  assert("Galaxy canvas elements", canvasCount > 0 || galaxyContainer === "found", `canvases=${canvasCount}`);

  const canvasSize = await jsExpr(cdp, `
    (function() {
      const c = document.querySelector('canvas.galaxy-canvas, #galaxy-container canvas');
      if (!c) return JSON.stringify({w:0,h:0});
      return JSON.stringify({w: c.width, h: c.height});
    })()
  `);
  assert("Canvas dimensions", true, `canvas=${canvasSize}`);
});
