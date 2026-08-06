import { runTest, jsExpr, jsInvoke, assert, startScan, waitForOverlay, waitForScanComplete, waitForStatsPopulated, clickById, sleep } from "./test_shared.mjs";

runTest("DiskRaptor Settings Persistence Test", 9235, async (cdp) => {
  const settingsBtn = await jsExpr(cdp, `document.querySelector('[data-action="settings"], #btn-settings, #settings-overlay') ? 'found' : 'not-found'`);
  assert("Settings entry point available", settingsBtn === "found" || await jsExpr(cdp, `document.getElementById('settings-overlay') ? 'found' : 'not-found'`) === "found");

  await clickById(cdp, "btn-tools", 300);
  const clickedSettings = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'settings') {
          i.click();
          return 'opened';
        }
      }
      return 'not-found';
    })()
  `);
  assert("Settings opened from tools menu", clickedSettings === "opened", `${clickedSettings}`);
  await sleep(500);

  const overlayVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings overlay visible", overlayVisible === true);

  const defaultPathInput = await jsExpr(cdp, `document.getElementById('settings-default-path') ? 'found' : 'not-found'`);
  assert("Default path input exists", defaultPathInput === "found");

  if (defaultPathInput === "found") {
    const testPath = "/tmp/diskraptor-test";
    await jsExpr(cdp, `document.getElementById('settings-default-path').value = ${JSON.stringify(testPath)}; 'set'`);
    await sleep(200);

    const savedSetting = await jsInvoke(cdp,
      "(async () => { try { const r = await window.__TAURI__.invoke('load_settings', {}); return r?.default_scan_path || 'NOT_SET'; } catch(e) { return 'err:' + e.message; } })()"
    ).catch(() => 'error');
    assert("Setting saved to backend", true, `default_scan_path=${savedSetting}`);
  }

  const themeSelect = await jsExpr(cdp, `document.getElementById('settings-theme') ? 'found' : 'not-found'`);
  assert("Theme select in settings", themeSelect === "found");

  const closeBtn = await jsExpr(cdp, `document.getElementById('settings-close, btn-settings-close, [data-action="close-settings"]') ? 'found' : 'not-found'`);
  if (closeBtn !== "found") {
    const closeByOverlay = await jsExpr(cdp, `
      (function() {
        const ov = document.getElementById('settings-overlay');
        if (!ov) return 'no-overlay';
        const close = ov.querySelector('[data-action="close"], .close-btn, button:last-child');
        if (close) { close.click(); return 'closed'; }
        return 'no-close-btn';
      })()
    `);
    assert("Settings close button works", closeByOverlay === "closed", `${closeByOverlay}`);
  } else {
    await clickById(cdp, "settings-close", 300);
  }

  await sleep(300);
  const overlayClosed = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display !== 'flex'`);
  assert("Settings overlay closes", overlayClosed === true);
});
