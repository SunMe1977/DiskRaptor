import { runTest, jsExpr, assert, clickById, waitFor, waitForOverlay, setValue } from "./test_shared.mjs";

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

  await clickById(cdp, "btn-cancel", 300);
  const stopped = await waitFor(async () => {
    return await jsExpr(cdp, `window.app?.state?.isScanning !== true`);
  }, { timeout: 20000, label: "scan cancelled" });
  assert("Scan stops after cancel", stopped);

  assert("Scan re-enabled after cancel", await jsExpr(cdp, `document.getElementById('btn-scan')?.disabled !== true`));
  assert("Rescan enabled after cancel", await jsExpr(cdp, `document.getElementById('btn-rescan')?.disabled !== true`));
  assert("Cancel disabled after cancel", await jsExpr(cdp, `document.getElementById('btn-cancel')?.disabled === true`));
});
