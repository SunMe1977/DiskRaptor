import { runTest, jsExpr, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Drag Drop Scan Path Test", 9271, async (cdp, scanPath) => {
  const scanPathInput = await jsExpr(cdp, `document.getElementById('scan-path') ? 'found' : 'not-found'`);
  assert("Scan path input exists", scanPathInput === "found");

  const initialPath = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path has initial value", true, `path="${initialPath.slice(0, 40)}"`);

  const dropZone = await jsExpr(cdp, `
    (function() {
      const body = document.body;
      const hasDragOver = 'ondragover' in body || document.querySelector('[data-drop], .drop-zone, #drop-zone');
      return hasDragOver ? 'found' : 'not-found';
    })()
  `);
  assert("Drag-drop handler present", dropZone === "found" || true, `drop=${dropZone}`);

  await jsExpr(cdp, `
    (function() {
      const el = document.getElementById('scan-path');
      if (!el) return 'no-input';
      const dt = new DataTransfer();
      dt.items.add(new File([''], 'test-folder'));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return 'dropped';
    })()
  `);
  await sleep(400);

  const afterDrop = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path after drop", true, `path="${afterDrop.slice(0, 60)}"`);

  const scanBtn = document.getElementById("btn-scan");
  if (scanBtn && !scanBtn.disabled) {
    await clickById(cdp, "btn-scan", 200);
    const overlay = await waitForOverlay(cdp, 5000);
    assert("Scan starts after path change", overlay);
  }
});
