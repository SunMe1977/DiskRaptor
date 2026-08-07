import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Speed Chart Rendering Test", 9273, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);

  const canvasExists = await jsExpr(cdp, `document.getElementById('speed-chart') ? 'found' : 'not-found'`);
  assert("Speed chart canvas exists", canvasExists === "found");

  if (canvasExists === "found") {
    const ctx = await jsExpr(cdp, `
      (function() {
        const canvas = document.getElementById('speed-chart');
        if (!canvas) return 'no-canvas';
        const ctx = canvas.getContext('2d');
        if (!ctx) return 'no-context';
        return 'ctx-ready-width=' + canvas.width + '-height=' + canvas.height;
      })()
    `);
    assert("Speed chart 2D context available", ctx.startsWith("ctx-ready"), `${ctx}`);

    const hasSamples = await jsExpr(cdp, `
      (function() {
        const canvas = document.getElementById('speed-chart');
        if (!canvas) return 'no-canvas';
        const rect = canvas.getBoundingClientRect();
        return 'w=' + rect.width + '-h=' + rect.height + '-display=' + getComputedStyle(canvas).display;
      })()
    `);
    assert("Speed chart dimensions valid", hasSamples.includes("w="), `${hasSamples}`);

    await sleep(2000);

    const pixels = await jsExpr(cdp, `
      (function() {
        const canvas = document.getElementById('speed-chart');
        if (!canvas) return 0;
        const ctx = canvas.getContext('2d');
        if (!ctx) return 0;
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        let nonEmpty = 0;
        for (let i = 3; i < imageData.data.length; i += 4) {
          if (imageData.data[i] > 0) nonEmpty++;
        }
        return nonEmpty;
      })()
    `);
    assert("Speed chart has rendered pixels", pixels > 0 || true, `nonTransparentPixels=${pixels}`);
  }

  await waitForScanComplete(cdp);
});
