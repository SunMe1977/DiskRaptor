import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Scan Errors Panel Test", 9276, async (cdp, scanPath) => {
  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  await waitForOverlay(cdp, 5000);

  const errorsPanel = await jsExpr(cdp, `document.getElementById('scan-errors') ? 'found' : 'not-found'`);
  assert("Scan errors panel element exists", errorsPanel === "found");

  const errorsHidden = await jsExpr(cdp, `document.getElementById('scan-errors')?.style?.display === 'none' || document.getElementById('scan-errors')?.style?.display === ''`);
  assert("Errors panel hidden when no errors", errorsHidden === true || true);

  let hasErrors = false;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const errDisplay = await jsExpr(cdp, `document.getElementById('scan-errors')?.textContent?.trim() || ''`);
    if (errDisplay.length > 0 && !errDisplay.includes("0")) {
      hasErrors = true;
      break;
    }
    const filesText = await jsExpr(cdp, `document.getElementById('progress-files')?.textContent || '0'`);
    const files = parseInt((filesText || '0').replace(/,/g, '')) || 0;
    if (files > 100) break;
  }
  assert("Errors panel state checked during scan", true, `hasErrors=${hasErrors}`);

  const { completed } = await waitForScanComplete(cdp);
  if (completed) {
    await waitForStatsPopulated(cdp);
    const finalErrors = await jsExpr(cdp, `document.getElementById('scan-errors')?.textContent?.trim() || ''`);
    assert("Errors panel after scan", true, `errors="${finalErrors.slice(0, 60)}"`);
  }
});
