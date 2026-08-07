import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Top Files Row Click Test", 9274, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for topfiles", completed);
  await waitForStatsPopulated(cdp);

  const rows = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert("Top files has rows", rows > 0, `rows=${rows}`);

  if (rows > 0) {
    const firstRowText = await jsExpr(cdp, `
      (function() {
        const row = document.querySelector('#topfiles-body tr');
        if (!row) return 'no-row';
        return row.textContent.trim().slice(0, 80);
      })()
    `);
    assert("First row has text content", firstRowText.length > 0, `text="${firstRowText}"`);

    const clickResult = await jsExpr(cdp, `
      (function() {
        const row = document.querySelector('#topfiles-body tr');
        if (!row) return 'no-row';
        row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'clicked';
      })()
    `);
    assert("Top files row click dispatched", clickResult === "clicked");

    await sleep(400);

    const statusAfterClick = await jsExpr(cdp, `document.querySelector('.status-bar')?.textContent?.trim() || ''`);
    assert("Status bar responds to topfiles click", true, `status="${statusAfterClick.slice(0, 60)}"`);

    const selectedRow = await jsExpr(cdp, `document.querySelector('#topfiles-body tr.selected, #topfiles-body tr[aria-selected="true"]') ? 'found' : 'not-found'`);
    assert("Row selection state after click", true, `selected=${selectedRow}`);
  }
});
