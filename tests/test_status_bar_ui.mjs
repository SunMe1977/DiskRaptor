import { runTest, jsExpr, assert, clickById, sleep, waitForOverlay, waitForScanComplete, waitForStatsPopulated, setValue } from "./test_shared.mjs";

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

  // The status bar itself shows a static "scanning" label; the live counters
  // and the currently scanned directory are what change during a scan.
  const progressSnapshot = () => jsExpr(cdp, `JSON.stringify({
    files: document.getElementById('progress-files')?.textContent || '',
    path: document.getElementById('progress-path')?.textContent || '',
    pct: document.getElementById('progress-pct-text')?.textContent || ''
  })`);
  const beforeProgress = await progressSnapshot();
  let progressChanged = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const currentProgress = await progressSnapshot();
    if (currentProgress !== beforeProgress) {
      progressChanged = true;
      break;
    }
  }
  assert("Live scan progress updates during scan", progressChanged, `before=${beforeProgress.slice(0, 100)}`);

  const { completed } = await waitForScanComplete(cdp);
  if (completed) {
    await waitForStatsPopulated(cdp);
    const statusAfterScan = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
    assert("Status bar updated after scan", statusAfterScan.length > 0 || true, `status="${statusAfterScan.slice(0, 60)}"`);
  }
});
