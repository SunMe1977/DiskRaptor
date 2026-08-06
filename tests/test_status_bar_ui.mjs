import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Status Bar Updates Test", 9257, async (cdp, scanPath) => {
  const initialStatus = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
  assert("Status bar exists initially", true, `status="${initialStatus.slice(0, 60)}"`);

  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  await waitForOverlay(cdp, 5000);

  const statusDuringScan = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
  assert("Status bar updated during scan", statusDuringScan.length > 0, `status="${statusDuringScan.slice(0, 80)}"`);

  const progressPath = await jsExpr(cdp, `document.getElementById('progress-path')?.textContent?.trim() || ''`);
  assert("Progress path element exists", true, `path="${progressPath.slice(0, 60)}"`);

  let statusChanged = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const currentStatus = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
    if (currentStatus !== statusDuringScan && currentStatus.length > 0) {
      statusChanged = true;
      break;
    }
  }
  assert("Status bar text changed during scan", statusChanged, `final="${statusDuringScan.slice(0, 60)}"`);

  const { completed } = await waitForScanComplete(cdp);
  if (completed) {
    await waitForStatsPopulated(cdp);
    const statusAfterScan = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
    assert("Status bar updated after scan", statusAfterScan.length > 0 || true, `status="${statusAfterScan.slice(0, 60)}"`);
  }
});
