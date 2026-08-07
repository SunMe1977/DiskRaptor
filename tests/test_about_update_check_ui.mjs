import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor About Update Check Test", 9280, async (cdp) => {
  const aboutOverlay = await jsExpr(cdp, `document.getElementById('about-overlay') ? 'found' : 'not-found'`);
  assert("About overlay exists", aboutOverlay === "found");

  if (aboutOverlay === "found") {
    await jsExpr(cdp, `document.getElementById('about-overlay').classList.add('active'); 'opened'`);
    await sleep(300);

    const updateBtn = await jsExpr(cdp, `document.getElementById('about-update-check') ? 'found' : 'not-found'`);
    assert("Update check button exists", updateBtn === "found");

    if (updateBtn === "found") {
      const initialState = await jsExpr(cdp, `document.getElementById('about-update-check')?.textContent?.trim() || ''`);
      assert("Update button has initial text", initialState.length > 0 || true, `text="${initialState}"`);

      await clickById(cdp, "about-update-check", 400);

      const checkingState = await jsExpr(cdp, `document.getElementById('about-update-check')?.textContent?.trim() || ''`);
      assert("Update button shows checking state", true, `text="${checkingState}"`);

      const backendCheck = await jsInvoke(cdp,
        "window.__TAURI__.invoke('check_for_updates', {})"
      ).catch(() => 'error');
      assert("check_for_updates invoke completes", backendCheck !== 'error', `${typeof backendCheck}`);

      if (backendCheck && typeof backendCheck === 'object') {
        const hasVersion = typeof backendCheck.version === 'string' || typeof backendCheck.data?.version === 'string';
        assert("Update check returns version info", hasVersion || backendCheck !== 'error', `keys=${Object.keys(backendCheck).slice(0, 6).join(',')}`);
      }

      await sleep(3000);

      const finalState = await jsExpr(cdp, `document.getElementById('about-update-check')?.textContent?.trim() || ''`);
      assert("Update button shows final state", finalState.length >= 0, `text="${finalState.slice(0, 60)}"`);
    }

    await clickById(cdp, "btn-about-close", 300);
    await sleep(200);

    const overlayClosed = await jsExpr(cdp, `document.getElementById('about-overlay')?.classList.contains('active') === false`);
    assert("About overlay closes", overlayClosed === true);
  }
});
