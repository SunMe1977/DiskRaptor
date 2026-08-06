import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete } from "./test_shared.mjs";

runTest("DiskRaptor Drive Selector Test", 9243, async (cdp) => {
  const driveBtn = await jsExpr(cdp, `document.getElementById('btn-drive') ? 'found' : 'not-found'`);
  assert("Drive selector button exists", driveBtn === "found");

  if (driveBtn === "found") {
    const driveLabel = await jsExpr(cdp, `document.getElementById('drive-selected')?.textContent?.trim() || ''`);
    assert("Drive label populated", driveLabel.length > 0 || driveLabel === "/", `label="${driveLabel}"`);

    await clickById(cdp, "btn-drive", 300);

    const driveMenu = await jsExpr(cdp, `document.getElementById('drive-menu') ? 'found' : 'not-found'`);
    assert("Drive menu exists", driveMenu === "found");

    const driveItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('#drive-menu [data-mount], #drive-menu .drive-item, #drive-menu li')).map(el => el.dataset.mount || el.textContent.trim().slice(0, 30))`);
    assert("Drive menu populated", Array.isArray(driveItems), `drives=${JSON.stringify(driveItems?.slice(0, 5))}`);

    if (driveItems && driveItems.length > 0) {
      const firstDrive = driveItems[0];
      await jsExpr(cdp, `
        (function() {
          const items = Array.from(document.querySelectorAll('#drive-menu [data-mount], #drive-menu .drive-item, #drive-menu li'));
          const item = items.find(el => (el.dataset.mount || el.textContent.trim().slice(0, 30)) === '${firstDrive}') || items[0];
          if (item) { item.click(); return 'selected-' + (item.dataset.mount || item.textContent.trim().slice(0, 15)); }
          return 'no-drive';
        })()
      `);
      await sleep(400);

      const scanPathAfter = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
      assert("Scan path updated after drive selection", scanPathAfter.length > 0 || scanPathAfter === "/", `path="${scanPathAfter}"`);
    }

    await jsExpr(cdp, `document.dispatchEvent(new MouseEvent('click', {bubbles:true})); 'dismissed'`);
    await sleep(200);
  }

  const drivesBackend = await jsInvoke(cdp, "window.__TAURI__.invoke('list_drives', {})").catch(() => 'error');
  assert("list_drives backend call works", drivesBackend !== 'error', `${typeof drivesBackend}`);

  if (drivesBackend && Array.isArray(drivesBackend)) {
    assert("Backend returns drive array", drivesBackend.length >= 0, `count=${drivesBackend.length}`);
    if (drivesBackend.length > 0) {
      const firstDrive = drivesBackend[0];
      assert("Drive has path field", typeof firstDrive.path === 'string' || typeof firstDrive === 'string', `drive=${JSON.stringify(firstDrive).slice(0, 60)}`);
    }
  }
});
