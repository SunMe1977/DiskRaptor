import { runTest, jsExpr, assert, clickById, sleep, waitForOverlay, setValue } from "./test_shared.mjs";

runTest("DiskRaptor Scan Button State Transitions Test", 9267, async (cdp, scanPath) => {
  assert("Scan button enabled initially", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`));
  assert("Rescan disabled initially", await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`));
  assert("Cancel disabled initially", await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === true`));
  assert("Export disabled initially", await jsExpr(cdp, `document.getElementById('btn-export')?.disabled === true`));

  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  await waitForOverlay(cdp, 5000);

  assert("Scan disabled during scan", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled === true`));
  assert("Rescan disabled during scan", await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`));
  assert("Cancel enabled during scan", await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled !== true`));
  assert("Export disabled during scan", await jsExpr(cdp, `document.getElementById('btn-export')?.disabled === true`));

  await jsExpr(cdp, `window.__TAURI__.invoke('cancel_scan', {}).catch(() => {}); 'cancelling'`);
  await sleep(1000);

  assert("Scan re-enabled after cancel", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`));
  assert("Rescan still disabled after cancel", await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled === true`));
  assert("Cancel disabled after cancel", await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === true`));
});
