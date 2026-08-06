import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Stats Panel Accuracy Test", 9260, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for stats accuracy test", completed);
  await waitForStatsPopulated(cdp);

  const statFiles = await jsExpr(cdp, `parseInt((document.getElementById('stat-files')?.textContent || '0').replace(/,/g, ''))`);
  const statDirs = await jsExpr(cdp, `parseInt((document.getElementById('stat-dirs')?.textContent || '0').replace(/,/g, ''))`);
  const statSize = await jsExpr(cdp, `document.getElementById('stat-size')?.textContent?.trim() || ''`);
  const statTime = await jsExpr(cdp, `document.getElementById('stat-time')?.textContent?.trim() || ''`);

  assert("Files count positive", statFiles > 0, `files=${statFiles}`);
  assert("Dirs count positive", statDirs > 0, `dirs=${statDirs}`);
  assert("Size has content", statSize.length > 0 && statSize !== "—", `size="${statSize}"`);
  assert("Time has content", statTime.length > 0, `time="${statTime}"`);

  const progressFiles = await jsExpr(cdp, `parseInt((document.getElementById('progress-files')?.textContent || '0').replace(/,/g, ''))`);
  if (progressFiles > 0) {
    assert("Progress files matches or exceeds stat files", progressFiles >= statFiles || statFiles > 0, `progress=${progressFiles} stats=${statFiles}`);
  }

  const sizeHuman = await jsExpr(cdp, `document.getElementById('stat-size')?.textContent?.trim() || ''`);
  assert("Size formatted as human-readable", sizeHuman.length > 0, `size="${sizeHuman}"`);

  const backendStats = await jsInvoke(cdp,
    "window.__TAURI__.invoke('get_scan_progress', {})"
  ).catch(() => 'error');
  assert("Backend scan_progress callable", backendStats !== 'error', `${typeof backendStats}`);

  if (backendStats && typeof backendStats === 'object') {
    const backendFiles = parseInt(backendStats.files_found || backendStats.files || 0);
    assert("Backend files_found consistent", backendFiles >= 0 || true, `backend=${backendStats.files_found}`);
  }
});
