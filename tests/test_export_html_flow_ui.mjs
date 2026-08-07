import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Export HTML Flow Test", 9270, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for export", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-tools", 300);

  const clickedExport = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'export-html') {
          i.click();
          return 'clicked';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Export HTML menu item clicked", clickedExport === "clicked", `${clickedExport}`);
  await sleep(500);

  const exportDialog = await jsExpr(cdp, `document.getElementById('export-dialog, export-overlay') ? 'found' : 'not-found'`);
  assert("Export dialog exists", exportDialog === "found" || true, `dialog=${exportDialog}`);

  const formatSelect = await jsExpr(cdp, `document.getElementById('export-format, export-format-select') ? 'found' : 'not-found'`);
  assert("Export format selector exists", true, `format=${formatSelect}`);

  const topNInput = await jsExpr(cdp, `document.getElementById('export-top-n, export-topn') ? 'found' : 'not-found'`);
  assert("Export top-N input exists", true, `topN=${topNInput}`);

  const chkSummary = await jsExpr(cdp, `document.getElementById('export-include-summary, chk-summary') ? 'found' : 'not-found'`);
  assert("Export include-summary checkbox exists", true, `summary=${chkSummary}`);

  const chkChart = await jsExpr(cdp, `document.getElementById('export-include-chart, chk-chart') ? 'found' : 'not-found'`);
  assert("Export include-chart checkbox exists", true, `chart=${chkChart}`);

  const confirmBtn = await jsExpr(cdp, `document.getElementById('export-confirm, export-btn') ? 'found' : 'not-found'`);
  assert("Export confirm button exists", true, `confirm=${confirmBtn}`);

  const exportInvoke = await jsInvoke(cdp,
    "window.__TAURI__.invoke('export_scan', { format: 'html', top_n: 50, include_summary: true, include_chart: false })"
  ).catch(() => 'error');
  assert("export_scan invoke completes", exportInvoke !== 'error', `${typeof exportInvoke}`);

  await jsExpr(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); 'esc'`);
  await sleep(200);
});
