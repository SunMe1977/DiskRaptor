import { runTest, jsExpr, jsInvoke, assert, clickById, sleep } from "./test_shared.mjs";

// Settings dialog: opens from the Tools menu, exposes the expected controls,
// persists through the backend and closes via the Cancel button.
runTest("DiskRaptor Settings Persistence Test", 9235, async (cdp) => {
  const settingsBtn = await jsExpr(cdp, `document.querySelector('[data-action="settings"], #btn-settings, #settings-overlay') ? 'found' : 'not-found'`);
  assert("Settings entry point available", settingsBtn === "found");

  await clickById(cdp, "btn-tools", 300);
  const clickedSettings = await jsExpr(cdp, `
    (function() {
      const items = document.querySelectorAll('.tools-item');
      for (const i of items) {
        if (i.getAttribute('data-action') === 'settings') { i.click(); return 'opened'; }
      }
      return 'not-found';
    })()
  `);
  assert("Settings opened from tools menu", clickedSettings === "opened", `${clickedSettings}`);
  await sleep(500);

  const overlayVisible = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display === 'flex'`);
  assert("Settings overlay visible", overlayVisible === true);

  const controls = await jsExpr(cdp, `JSON.stringify({
    defaultPath: !!document.getElementById('settings-default-path'),
    theme: !!document.getElementById('settings-theme'),
    language: !!document.getElementById('settings-language'),
    close: !!document.getElementById('settings-close'),
    save: !!document.getElementById('settings-save')
  })`);
  const c = JSON.parse(controls);
  assert("Default path input exists", c.defaultPath, controls);
  assert("Theme select in settings", c.theme, controls);
  assert("Language select in settings", c.language, controls);
  assert("Settings has save + cancel buttons", c.save && c.close, controls);

  // Backend settings round-trip (empty merge: non-destructive).
  const settings = await jsInvoke(cdp, "window.__TAURI__.invoke('load_settings', {})").catch(() => 'error');
  assert("Settings load from backend", settings !== 'error' && typeof settings === 'object', `${typeof settings}`);
  const saved = await jsInvoke(cdp, "window.__TAURI__.invoke('save_settings', { settings: {} })").catch(() => 'error');
  assert("Settings save to backend", saved !== 'error', `${typeof saved}`);

  await clickById(cdp, "settings-close", 300);
  await sleep(300);
  const overlayClosed = await jsExpr(cdp, `document.getElementById('settings-overlay')?.style?.display !== 'flex'`);
  assert("Settings overlay closes", overlayClosed === true);
});
