import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, waitFor } from "./test_shared.mjs";

// Export flow: the Tools menu opens a modal dialog (created on demand, no
// static DOM ids) that generates CSV/JSON/HTML client-side via downloadBlob.
// We verify the dialog controls and that confirming actually produces a
// download blob.

runTest("DiskRaptor Export HTML Flow Test", 9270, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for export", completed);
  await waitForStatsPopulated(cdp);

  const openDialog = async () => {
    // The export dialog is opened by the toolbar Export button, not the Tools
    // menu (the Tools "export-html" item exports directly without a dialog).
    await clickById(cdp, "btn-export", 300);
    return waitFor(async () => await jsExpr(cdp, `!!document.getElementById('exp-format')`),
      { timeout: 5000, label: "export dialog" });
  };

  const opened = await openDialog();
  assert("Export dialog appeared", opened);
  if (!opened) return;

  const controls = await jsExpr(cdp, `JSON.stringify({
    format: document.getElementById('exp-format')?.value || '',
    options: Array.from(document.querySelectorAll('#exp-format option')).map(o => o.value),
    rows: !!document.getElementById('exp-rows'),
    summary: !!document.getElementById('exp-summary'),
    chart: !!document.getElementById('exp-chart'),
    ok: !!document.getElementById('exp-ok'),
    cancel: !!document.getElementById('exp-cancel')
  })`);
  const c = JSON.parse(controls);
  assert("Export format selector exists", c.format.length > 0, controls);
  assert("Export offers CSV/JSON/HTML", ["CSV", "JSON", "HTML"].every((f) => c.options.includes(f)), controls);
  assert("Export top-N input exists", c.rows);
  assert("Export include-summary checkbox exists", c.summary);
  assert("Export include-chart checkbox exists", c.chart);
  assert("Export confirm button exists", c.ok);
  assert("Export cancel button exists", c.cancel);

  // Cancel closes the dialog without exporting.
  await jsExpr(cdp, `document.getElementById('exp-cancel').click(); 'ok'`);
  await sleep(200);
  const cancelled = await jsExpr(cdp, `document.getElementById('exp-format') === null`);
  assert("Cancel closes the export dialog", cancelled === true);

  // Re-open, choose HTML and confirm: downloadBlob must create a blob + anchor.
  const reopened = await openDialog();
  assert("Export dialog re-opened", reopened);
  if (!reopened) return;

  await jsExpr(cdp, `
    (function() {
      window.__exportCalls = [];
      const origCreate = URL.createObjectURL;
      URL.createObjectURL = function(blob) {
        window.__exportCalls.push({ kind: 'blob', type: blob && blob.type, size: blob && blob.size });
        return origCreate.call(URL, blob);
      };
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function() {
        if (this.download) window.__exportCalls.push({ kind: 'download', name: this.download });
        return origClick.call(this);
      };
      const sel = document.getElementById('exp-format');
      sel.value = 'HTML';
      return 'armed';
    })()
  `);
  await jsExpr(cdp, `document.getElementById('exp-ok').click(); 'ok'`);

  const exported = await waitFor(async () => {
    const calls = await jsExpr(cdp, `JSON.stringify(window.__exportCalls || [])`);
    return JSON.parse(calls).some((x) => x.kind === "download");
  }, { timeout: 5000, label: "export download" });
  const calls = JSON.parse(await jsExpr(cdp, `JSON.stringify(window.__exportCalls || [])`));
  assert("Confirming export triggers a download", exported, JSON.stringify(calls));
  const blobCall = calls.find((x) => x.kind === "blob");
  assert("Export produces an HTML blob", blobCall && blobCall.type === "text/html", JSON.stringify(blobCall));
  const dl = calls.find((x) => x.kind === "download");
  assert("Download has an .html filename", dl && /\.html$/i.test(dl.name), JSON.stringify(dl));
  const closed = await jsExpr(cdp, `document.getElementById('exp-format') === null`);
  assert("Export dialog closed after confirming", closed === true);
});
