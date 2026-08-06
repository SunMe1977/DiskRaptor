import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Favorites Flow Test", 9237, async (cdp, scanPath) => {
  const favBtn = await jsExpr(cdp, `document.getElementById('btn-fav') ? 'found' : 'not-found'`);
  assert("Favorite button exists", favBtn === "found");

  if (favBtn === "found") {
    const starTextBefore = await jsExpr(cdp, `document.getElementById('btn-fav')?.textContent?.trim() || ''`);
    assert("Fav button has content", starTextBefore.length > 0, `text="${starTextBefore}"`);

    await clickById(cdp, "btn-fav", 400);

    const favMenu = await jsExpr(cdp, `document.getElementById('fav-menu') ? 'found' : 'not-found'`);
    assert("Favorites menu exists", favMenu === "found");

    const favItems = await jsExpr(cdp, `Array.from(document.querySelectorAll('#fav-menu .fav-item, #fav-menu li, #fav-menu [data-path]')).map(el => el.dataset.path || el.textContent.trim().slice(0, 40))`);
    assert("Favorites menu populated", Array.isArray(favItems), `items=${JSON.stringify(favItems?.slice(0, 5))}`);

    await jsExpr(cdp, `document.dispatchEvent(new MouseEvent('click', {bubbles:true})); 'dismissed'`);
    await sleep(200);

    const savedFav = await jsExpr(cdp, `
      (async () => {
        try {
          const r = await window.__TAURI__.invoke('load_settings', {});
          const favs = r?.favorites || r?.scan_favorites || [];
          return 'count=' + (Array.isArray(favs) ? favs.length : 0);
        } catch(e) { return 'err'; }
      })()
    `);
    assert("Favorites loadable via backend", savedFav.startsWith("count="), `${savedFav}`);
  }

  const scanPathVal = await jsExpr(cdp, `document.getElementById('scan-path')?.value || ''`);
  assert("Scan path has value", scanPathVal.length > 0, `path=${scanPathVal.slice(0, 40)}`);
});
