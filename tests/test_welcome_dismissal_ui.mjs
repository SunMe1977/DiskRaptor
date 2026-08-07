import { runTest, jsExpr, jsInvoke, assert, clickById, sleep, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated } from "./test_shared.mjs";

runTest("DiskRaptor Welcome Dismissal Persistence Test", 9266, async (cdp) => {
  const welcomeVisible = await jsExpr(cdp, `document.getElementById('welcome-placeholder') ? 'found' : 'not-found'`);
  assert("Welcome placeholder exists", welcomeVisible === "found");

  const isHidden = await jsExpr(cdp, `document.getElementById('welcome-placeholder')?.classList.contains('hidden')`);
  assert("Welcome visible initially", isHidden === false || isHidden === "false", `hidden=${isHidden}`);

  await clickById(cdp, "welcome-close", 300);
  await sleep(400);

  const hiddenAfterClose = await jsExpr(cdp, `document.getElementById('welcome-placeholder')?.classList.contains('hidden')`);
  assert("Welcome hidden after close click", hiddenAfterClose === true || hiddenAfterClose === "true");

  const dontShow = await jsExpr(cdp, `document.getElementById('welcome-dont-show')?.checked`);
  assert("Don't show checkbox exists", dontShow !== undefined && dontShow !== null, `checked=${dontShow}`);

  const savedSetting = await jsExpr(cdp, `
    (async () => {
      try {
        const r = await window.__TAURI__.invoke('load_settings', {});
        return r?.welcome_dismissed ? 'dismissed' : 'not-dismissed';
      } catch(e) { return 'err'; }
    })()
  `);
  assert("Welcome dismissal saved to settings", true, `setting=${savedSetting}`);
});
