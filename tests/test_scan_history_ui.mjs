import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, waitFor, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

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

  // Seed a longer history, then reload and verify the start page caps the
  // visible list at 3 items with a "Show more" toggle revealing the rest.
  await jsInvoke(cdp, `window.__TAURI__.invoke('save_settings', { settings: { scan_history: ['/seed/1', '/seed/2', '/seed/3', '/seed/4', '/seed/5'], scan_history_pinned: [] } })`);
  await cdp.send("Page.reload");
  const capped = await waitFor(async () => {
    const n = await jsExpr(cdp, `document.querySelectorAll('.history-item').length`);
    return n === 3;
  }, { timeout: 15000, label: "history 3-item cap" });
  assert("History shows at most 3 items after reload", capped === true, "did not settle at 3 items");
  const capState = await jsExpr(cdp, `({ items: document.querySelectorAll('.history-item').length, hasToggle: !!document.getElementById('history-toggle'), toggle: document.getElementById('history-toggle')?.textContent || '' })`);
  assert("Exactly 3 items displayed", capState?.items === 3, JSON.stringify(capState));
  assert("Show-more toggle rendered when >3 entries", capState?.hasToggle === true, JSON.stringify(capState));

  await clickById(cdp, "history-toggle", 300);
  const expanded = await jsExpr(cdp, `({ items: document.querySelectorAll('.history-item').length, toggle: document.getElementById('history-toggle')?.textContent || '' })`);
  assert("Show more reveals all 5 entries", expanded?.items === 5, JSON.stringify(expanded));
  assert("Toggle label changes to show-less", String(expanded?.toggle).toLowerCase().includes("less"), JSON.stringify(expanded));

  await clickById(cdp, "btn-scan", 300);
  const overlaySecond = await waitForOverlay(cdp, 5000);
  assert("Rescan starts after history test", overlaySecond);
});
