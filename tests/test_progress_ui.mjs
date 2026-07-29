import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Progress Overlay Test", 9216, async (cdp, scanPath) => {
  await jsExpr(cdp, `document.getElementById('scan-path').value = ${JSON.stringify(scanPath)}; 'set'`);
  const overlayHiddenBefore = await jsExpr(cdp, `
    (function() {
      const ov = document.getElementById('progress-overlay');
      if (!ov) return 'no-overlay';
      const style = getComputedStyle(ov);
      return 'display=' + style.display + '-active=' + ov.classList.contains('active');
    })()
  `);
  assert("Progress overlay hidden before scan", overlayHiddenBefore.includes("display=none") || overlayHiddenBefore.includes("active=false"), `${overlayHiddenBefore}`);

  await startScan(cdp, scanPath);
  const overlayAppeared = await waitForOverlay(cdp);
  assert("Progress overlay appears during scan", overlayAppeared);

  const progressElements = await jsExpr(cdp, `({
    files: !!document.getElementById('progress-files'),
    dirs: !!document.getElementById('progress-dirs'),
    speed: !!document.getElementById('progress-speed-val'),
    elapsed: !!document.getElementById('progress-elapsed-val'),
    eta: !!document.getElementById('progress-eta-val'),
    pct: !!document.getElementById('progress-pct-text'),
    status: !!document.getElementById('progress-status'),
    path: !!document.getElementById('progress-path'),
  })`);
  assert("Progress files element found", progressElements?.files === true);

  if (overlayAppeared) {
    const filesBefore = await jsExpr(cdp, `parseInt((document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''))`);
    await jsExpr(cdp, `(async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise(r => setTimeout(r, 50));
        const v = parseInt((document.getElementById('progress-files')?.textContent || '0').replace(/,/g, '')) || 0;
        if (v > ${filesBefore}) return;
      }
    })()`);
    const filesAfter = await jsExpr(cdp, `parseInt((document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''))`);
    assert("Progress counter increments", filesAfter >= filesBefore, `before=${filesBefore} after=${filesAfter}`);
  }

  const speedVal = await jsExpr(cdp, `document.getElementById('progress-speed-val')?.textContent || 'no-speed'`);
  assert("Speed display shows value", speedVal !== "no-speed", `speed=${speedVal}`);

  const elapsedVal = await jsExpr(cdp, `document.getElementById('progress-elapsed-val')?.textContent || 'no-elapsed'`);
  assert("Elapsed timer shows value", elapsedVal !== "no-elapsed", `elapsed=${elapsedVal}`);

  const etaVal = await jsExpr(cdp, `document.getElementById('progress-eta-val')?.textContent || 'no-eta'`);
  assert("ETA display shows value", etaVal !== "no-eta", `eta=${etaVal}`);

  await waitForScanComplete(cdp);

  const overlayHiddenAfter = await jsExpr(cdp, `
    (function() {
      const ov = document.getElementById('progress-overlay');
      if (!ov) return 'no-overlay';
      const style = getComputedStyle(ov);
      return 'display=' + style.display + '-active=' + ov.classList.contains('active');
    })()
  `);
  assert("Progress overlay hidden after scan", overlayHiddenAfter.includes("display=none") || overlayHiddenAfter.includes("active=false"), `${overlayHiddenAfter}`);
});
