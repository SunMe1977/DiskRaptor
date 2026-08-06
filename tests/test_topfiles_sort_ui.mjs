import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Top Files Interaction Test", 9238, async (cdp, scanPath) => {
  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for top files test", completed);
  await waitForStatsPopulated(cdp);

  const topFilesCard = await jsExpr(cdp, `document.getElementById('topfiles-card') ? 'found' : 'not-found'`);
  assert("Top files card exists", topFilesCard === "found");

  const topFilesBody = await jsExpr(cdp, `document.getElementById('topfiles-body') ? 'found' : 'not-found'`);
  assert("Top files body exists", topFilesBody === "found");

  const rows = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert("Top files has rows", rows > 0, `rows=${rows}`);

  if (rows > 0) {
    const firstRowData = await jsExpr(cdp, `
      (function() {
        const row = document.querySelector('#topfiles-body tr');
        if (!row) return 'no-row';
        const cells = row.querySelectorAll('td');
        return {
          cells: cells.length,
          path: cells[0]?.textContent?.trim().slice(0, 60) || '',
          size: cells[1]?.textContent?.trim() || ''
        };
      })()
    `);
    assert("First row has data", firstRowData && firstRowData.cells > 0, `${JSON.stringify(firstRowData)}`);

    const headerCells = await jsExpr(cdp, `Array.from(document.querySelectorAll('#topfiles-table th')).map(th => th.textContent.trim().slice(0, 20))`);
    assert("Top files headers exist", Array.isArray(headerCells) && headerCells.length >= 1, `headers=${JSON.stringify(headerCells)}`);

    const hasSizeOrBytes = headerCells.some(h => h.toLowerCase().includes("size") || h.toLowerCase().includes("bytes"));
    assert("Header includes size/bytes column", hasSizeOrBytes);
  }

  const topFilesCount = await jsExpr(cdp, `document.querySelectorAll('#topfiles-body tr').length`);
  assert("Top files count stable", topFilesCount === rows || topFilesCount > 0, `count=${topFilesCount}`);
});
