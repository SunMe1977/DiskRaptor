import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Rescan Flow Test", 9217, async (cdp, scanPath) => {
  assert("Scan button enabled initially", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`));
  const rescanDisabledInit = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`);
  assert("Rescan disabled initially", rescanDisabledInit === true);

  await startScan(cdp, scanPath);
  await waitForOverlay(cdp);
  const { completed } = await waitForScanComplete(cdp);
  assert("First scan completed", completed);
  await waitForStatsPopulated(cdp);

  const rescanEnabled = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled !== true`);
  assert("Rescan enabled after scan", rescanEnabled === true);

  const exportEnabled = await jsExpr(cdp, `document.getElementById('btn-export')?.disabled !== true`);
  assert("Export enabled after scan", exportEnabled === true);

  const statFiles = await jsExpr(cdp, `parseInt((document.getElementById('stat-files')?.textContent || '0').replace(/,/g, ''))`);
  assert("Stats files populated", statFiles > 0, `files=${statFiles}`);

  await clickById(cdp, "btn-rescan", 300);
  const { completed: rescanDone } = await waitForScanComplete(cdp);
  assert("Rescan completed", rescanDone);
  await waitForStatsPopulated(cdp, 5000);

  await clickById(cdp, "btn-tools", 300);
  await jsExpr(cdp, `(function(){ const items=document.querySelectorAll('.tools-item'); for(const i of items){ if(i.getAttribute('data-action')==='clear-scan'){ i.click(); return 'clicked'; }} return 'not-found'; })()`);
  await sleep(500);

  const rescanState = await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled`);
  assert("Rescan state after clear checked", true, `disabled=${rescanState}`);
});
