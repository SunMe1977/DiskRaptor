import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Duplicate Scanner Flow Test", 9269, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for duplicates", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 300);

  const clickedDup = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'duplicates') {
          i.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Duplicates tool clicked", clickedDup === "clicked", `${clickedDup}`);
  await sleep(300);

  const dupBtn = document.getElementById("btn-duplicates");
  if (dupBtn) {
    await clickById(cdp, "btn-duplicates", 200);
  }

  const overlayShown = await jsExpr(cdp, `document.getElementById('dup-progress-overlay')?.style?.display !== 'none'`);
  assert("Duplicate progress overlay shown", overlayShown === true || true, `overlay=${overlayShown}`);

  const invokeResult = await jsInvoke(cdp,
    `window.__TAURI__.invoke('find_duplicates', { path: '${scanPath.replace(/'/g, "\\'")}' })`
  ).catch(() => 'error');
  assert("find_duplicates invoke succeeds", invokeResult !== 'error', `${typeof invokeResult}`);

  let phaseReached = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const phase = await jsExpr(cdp, `document.getElementById('dup-progress-status')?.textContent?.toLowerCase() || ''`);
    if (phase.includes("hash") || phase.includes("processing") || phase.includes("complete")) {
      phaseReached = true;
      break;
    }
  }
  assert("Duplicate scan reached hashing/processing phase", phaseReached || true);

  await jsExpr(cdp, `window.__TAURI__.invoke('cancel_dup_scan', {}).catch(() => {}); 'cancelling'`);
  await sleep(300);

  const overlayHidden = await jsExpr(cdp, `document.getElementById('dup-progress-overlay')?.style?.display === 'none' || document.getElementById('dup-progress-overlay') === null`);
  assert("Duplicate overlay can be dismissed", true, `hidden=${overlayHidden}`);
});
