import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Top Files Panel Test", 9204, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp, 400);
  assert("Scan completed for topfiles", completed);
  await sleep(3000);

  const topFilesCard = await jsExpr(cdp, `document.getElementById('topfiles-card') ? 'found' : 'not-found'`);
  assert("Top files card exists", topFilesCard === "found");

  const topFilesTable = await jsExpr(cdp, `document.getElementById('topfiles-table') ? 'found' : 'not-found'`);
  assert("Top files table exists", topFilesTable === "found");

  const topFilesRows = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert(`Top files rows (${topFilesRows})`, topFilesRows > 0, `rows=${topFilesRows}`);

  const tableHeaders = await jsExpr(cdp, `document.querySelectorAll('#topfiles-table th').length`);
  assert("Top files headers exist", tableHeaders >= 1, `headers=${tableHeaders}`);

  if (topFilesRows > 0) {
    const firstRowPath = await jsExpr(cdp, `
      (function() {
        const row = document.querySelector('#topfiles-body tr');
        if (!row) return 'no-row';
        const cells = row.querySelectorAll('td');
        return cells.length > 0 ? cells[0].textContent.trim().slice(0, 40) : 'no-cells';
      })()
    `);
    assert("First file path visible", firstRowPath !== "no-row" && firstRowPath !== "no-cells", `path=${firstRowPath}`);
  }

  const hasSizeColumn = await jsExpr(cdp, `
    (function() {
      const ths = document.querySelectorAll('#topfiles-table th');
      for (const th of ths) {
        if (th.textContent.toLowerCase().includes('size')) return 'has-size-col';
      }
      return 'no-size-col';
    })()
  `);
  assert("Size column in top files", hasSizeColumn === "has-size-col");
});
