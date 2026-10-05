import { runTest, jsExpr, assert, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

const overflowOf = `({
  sw: document.getElementById('diagram-container').scrollWidth,
  cw: document.getElementById('diagram-container').clientWidth,
  sh: document.getElementById('diagram-container').scrollHeight,
  ch: document.getElementById('diagram-container').clientHeight,
  overflow: document.getElementById('diagram-container').style.overflow || '',
  zoom: window.__diagram ? window.__diagram.getZoom() : -1
})`;

runTest("DiskRaptor Diagram Scrollbar Test", 9271, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for scrollbar test", completed);
  await waitForStatsPopulated(cdp);

  for (const mode of ["pie", "treemap", "bar"]) {
    await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="${mode}"]').click(); '${mode}'`);
    await sleep(600);

    // Fit: no scrollbars expected.
    await jsExpr(cdp, `window.__diagram.setZoom('fit'); 'fit'`);
    await sleep(400);
    const fit = await jsExpr(cdp, overflowOf);
    assert(`${mode}: fit has no scrollbar`, fit.sw <= fit.cw + 1 && fit.sh <= fit.ch + 1, JSON.stringify(fit));

    // 200% button (user-reachable): scrollbars must appear.
    await jsExpr(cdp, `document.querySelector('.zoom-btn[data-zoom="2"]').click(); 'zoom200'`);
    await sleep(400);
    const b200 = await jsExpr(cdp, overflowOf);
    assert(`${mode}: 200% button shows scrollbar`, b200.sw > b200.cw + 1 || b200.sh > b200.ch + 1, JSON.stringify(b200));

    // Max zoom: scrollbars must appear.
    await jsExpr(cdp, `window.__diagram.setZoom(10); 'max'`);
    await sleep(400);
    const max = await jsExpr(cdp, overflowOf);
    assert(`${mode}: 10x zoom shows scrollbar`, max.sw > max.cw + 1 || max.sh > max.ch + 1, JSON.stringify(max));

    // Drag-pan moves scrolled content.
    const slBefore = await jsExpr(cdp, `document.getElementById('diagram-container').scrollLeft`);
    await jsExpr(cdp, `
      (function() {
        const c = document.getElementById('diagram-container');
        const r = c.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const cv = c.querySelector('canvas');
        cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
        for (let i = 1; i <= 10; i++) {
          cv.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x - i * 8, clientY: y }));
        }
        window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return 'dragged';
      })()
    `);
    await sleep(300);
    const slAfter = await jsExpr(cdp, `document.getElementById('diagram-container').scrollLeft`);
    assert(`${mode}: drag pans content`, slAfter > slBefore, `before=${slBefore} after=${slAfter}`);

    // Plain click (no drag) still works without errors.
    const clickRes = await jsExpr(cdp, `
      (function() {
        try {
          const c = document.getElementById('diagram-container');
          const r = c.getBoundingClientRect();
          const cv = c.querySelector('canvas');
          cv.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5, button: 0 }));
          window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          cv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
          return 'ok';
        } catch (e) { return 'err:' + e.message; }
      })()
    `);
    assert(`${mode}: click after drag works`, clickRes === "ok", `got=${clickRes}`);
  }

  // Back to fit: scrollbars gone again.
  await jsExpr(cdp, `document.querySelector('.diagram-mode[data-mode="pie"]').click(); 'pie'`);
  await sleep(400);
  await jsExpr(cdp, `window.__diagram.setZoom('fit'); 'fit'`);
  await sleep(400);
  const end = await jsExpr(cdp, overflowOf);
  assert("Fit restores scrollbar-free view", end.sw <= end.cw + 1 && end.sh <= end.ch + 1, JSON.stringify(end));
});
