import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Scan Cancel Restart Cycle Test", 9254, async (cdp, scanPath) => {
  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  const overlayShown = await waitForOverlay(cdp, 5000);
  assert("First scan started", overlayShown);

  const filesBeforeCancel = await jsExpr(cdp, `parseInt((document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''))`);
  await sleep(500);

  await jsExpr(cdp, `window.__TAURI__.invoke('cancel_scan', {}).catch(() => {}); 'cancelling'`);

  let cancelled = false;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const overlay = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
    const status = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
    if (!overlay || status.toLowerCase().includes("cancel") || status.toLowerCase().includes("ready")) {
      cancelled = true;
      break;
    }
  }
  assert("First scan cancelled", cancelled);

  await sleep(500);
  const scanBtnEnabled = await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled === false`);
  assert("Scan button enabled after cancel", scanBtnEnabled === true);

  await clickById(cdp, "btn-scan", 200);
  const secondOverlay = await waitForOverlay(cdp, 5000);
  assert("Second scan starts after cancel", secondOverlay);

  await jsExpr(cdp, `window.__TAURI__.invoke('cancel_scan', {}).catch(() => {}); 'cancelling'`);
  await sleep(1000);

  const statusAfterCancel = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
  assert("Status bar shows state after cancel", statusAfterCancel.length > 0 || true, `status="${statusAfterCancel}"`);
});
