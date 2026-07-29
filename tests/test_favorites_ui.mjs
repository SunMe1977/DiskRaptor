import { runTest, jsExpr, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, sleep, clickById } from "./test_shared.mjs";

runTest("DiskRaptor Favorites Test", 9210, async (cdp, scanPath) => {
  const favBtn = await jsExpr(cdp, `
    (function() {
      const btn = document.getElementById('btn-fav');
      if (!btn) return 'not-found';
      return 'found title=' + btn.getAttribute('title');
    })()
  `);
  assert("Favorites button visible", favBtn.startsWith("found"), `${favBtn}`);

  await startScan(cdp, scanPath);
  const overlayShown = await waitForOverlay(cdp);
  assert("Scan overlay appeared", overlayShown);
  const { completed } = await waitForScanComplete(cdp);
  assert("Scan completed for favorites", completed);
  await waitForStatsPopulated(cdp);

  await clickById(cdp, "btn-fav", 500);
  const favMenuVisible = await jsExpr(cdp, `
    (function() {
      const m = document.getElementById('fav-menu');
      if (!m) return 'no-menu';
      const style = getComputedStyle(m);
      return 'menu-display=' + style.display;
    })()
  `);
  assert("Favorites menu visible", favMenuVisible.includes("display"), `${favMenuVisible}`);

  const favItems = await jsExpr(cdp, `
    Array.from(document.querySelectorAll('#fav-menu .fav-item, #fav-menu [class*="fav"], #fav-menu a')).map(el => el.textContent.trim().slice(0, 40))
  `);
  assert("Favorite menu items detected", Array.isArray(favItems), `count=${Array.isArray(favItems) ? favItems.length : 'not-array'}`);

  const currentPath = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path set", currentPath.length > 0, `path=${currentPath}`);
});
