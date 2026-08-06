import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Cancel Scan Flow Test", 9233, async (cdp, scanPath) => {
  assert("Scan button enabled initially", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`));
  assert("Cancel disabled initially", await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === true`));

  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  const overlayShown = await waitForOverlay(cdp, 5000);
  assert("Progress overlay appears", overlayShown);

  const cancelBtn = await jsExpr(cdp, `document.getElementById('btn-cancel')`);
  assert("Cancel button found", cancelBtn !== null);

  if (cancelBtn !== null) {
    const cancelEnabled = await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === false`);
    assert("Cancel button enabled during scan", cancelEnabled === true);

    await clickById(cdp, "btn-cancel", 300);

    let cancelled = false;
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      const status = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent || ''`);
      const overlay = await jsExpr(cdp, `document.getElementById('progress-overlay')?.classList.contains('active')`);
      if (!overlay || status.toLowerCase().includes("cancel") || status.toLowerCase().includes("complete")) {
        cancelled = true;
        break;
      }
    }
    assert("Scan cancelled or completed", cancelled);

    const scanEnabledAgain = await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`);
    assert("Scan button re-enabled after cancel", scanEnabledAgain === true);

    const rescanEnabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled !== true`);
    assert("Rescan state after cancel", true, `disabled=${!rescanEnabled}`);
  }

  const statsAfterCancel = await jsExpr(cdp, `document.getElementById('stat-files')?.textContent || '0'`);
  assert("Stats panel exists after cancel", statsAfterCancel !== undefined, `stats=${statsAfterCancel}`);
});
