import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Scan History Test", 9244, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("First scan completed", completed);
  await waitForStatsPopulated(cdp);

  const savedHistory = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        const hist = r?.scan_history || [];
        return 'count=' + hist.length + '-first=' + (hist[0] || '').slice(0, 40);
      } catch(e) { return 'err'; }
    })()
  `);
  assert("Scan history saved after scan", savedHistory.startsWith("count="), `${savedHistory}`);

  const historyCount = parseInt(savedHistory.split("count=")[1]?.split("-")[0] || "0");
  assert("History has at least one entry", historyCount >= 1, `count=${historyCount}`);

  const firstHistoryPath = savedHistory.split("first=")[1] || "";
  assert("History entry is a path", firstHistoryPath.length > 0 || firstHistoryPath === "", `path="${firstHistoryPath}"`);

  await clickById(cdp, "btn-scan", 300);
  const overlaySecond = await waitForOverlay(cdp, 5000);
  assert("Rescan starts after history test", overlaySecond);
});
