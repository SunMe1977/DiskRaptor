import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Follow Symlinks Toggle Test", 9272, async (cdp, scanPath) => {
  const chkFollow = await jsExpr(cdp, `document.getElementById('chk-follow-symlinks') ? 'found' : 'not-found'`);
  assert("Follow symlinks toggle exists", chkFollow === "found");

  if (chkFollow === "found") {
    const checkbox = await jsExpr(cdp, `document.getElementById('chk-follow-symlinks')?.querySelector('input[type="checkbox"]') ? 'found' : 'not-found'`);
    assert("Follow symlinks checkbox exists", checkbox === "found");

    const initialState = await jsExpr(cdp, `document.getElementById('chk-follow-symlinks')?.querySelector('input[type="checkbox"]')?.checked`);
    assert("Follow symlinks has checkbox state", initialState !== undefined && initialState !== null, `checked=${initialState}`);

    await jsExpr(cdp, `
      (function() {
        const chk = document.getElementById('chk-follow-symlinks');
        if (!chk) return 'no-element';
        const input = chk.querySelector('input[type="checkbox"]') || chk;
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'toggled-to-' + input.checked;
      })()
    `);
    await sleep(300);

    const afterToggle = await jsExpr(cdp, `document.getElementById('chk-follow-symlinks')?.querySelector('input[type="checkbox"]')?.checked`);
    assert("Follow symlinks state changed", afterToggle !== null && afterToggle !== undefined, `checked=${afterToggle}`);

    const savedSetting = await jsExpr(cdp, `
      (async () => {
        try {
          await window.__TAURI__.invoke('save_settings', { settings: { follow_symlinks: true } });
          const r = await window.__TAURI__.invoke('load_settings', {});
          return 'follow=' + (r?.follow_symlinks ?? 'undefined');
        } catch(e) { return 'err'; }
      })()
    `);
    assert("Follow symlinks setting saved", savedSetting.startsWith("follow="), `${savedSetting}`);
  }

  await setValue(cdp, "scan-path", scanPath);
  await clickById(cdp, "btn-scan", 200);
  const overlay = await waitForOverlay(cdp, 5000);
  assert("Scan starts with follow-symlinks setting", overlay);
});
